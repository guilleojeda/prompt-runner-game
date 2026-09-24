import { createHash, randomUUID } from 'node:crypto';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
  createDefaultDraft,
  draftsEqual,
  ROBOT_CATALOG,
  ROBOT_SCHEMA_VERSION,
  validateDraft,
  type DraftSnapshot,
  type RobotDraft,
} from '../../../shared/robot.js';
import {
  readModelProfile,
  resolveModelProfile,
  type ModelProfile,
} from '../../../shared/models.js';
import { createInitialState, LEVEL, scoreAttempt } from '../../../shared/game.js';
import { usageFromBedrockResponseBytes } from '../../runner/src/usage.js';
import {
  ATTEMPT_RECORD_VERSION,
  type AnimationPreference,
  type ReplayRecordView,
} from '../../../shared/attempt.js';
import {
  AnimationPreferenceConflictError,
  AttemptNotTerminalError,
  DEFAULT_ATTEMPT_CONFIG,
  ReplayRecordError,
  readCurrentLevel,
  replayRecordViewOf,
  summaryOf,
  type ActionPublication,
  type AdmitInput,
  type AdmitResult,
  type AttemptConfig,
  type PersistedAttempt,
  type AttemptSkill,
  type AttemptStore,
  type BodyStore,
  type CallRecord,
  type Usage,
} from '../../../shared/server/attempt.js';
export type { AttemptStore, BodyStore } from '../../../shared/server/attempt.js';
export {
  AnimationPreferenceConflictError,
  AttemptNotTerminalError,
  ReplayRecordError,
} from '../../../shared/server/attempt.js';

export class AttemptStoreError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AttemptStoreError';
  }
}

export class IdempotencyConflictError extends Error {
  public constructor() {
    super('La clave de solicitud ya se usó con otro contenido.');
    this.name = 'IdempotencyConflictError';
  }
}

export class AdmissionConflictError extends Error {
  public constructor(message = 'La configuración cambió en otra pestaña.') {
    super(message);
    this.name = 'AdmissionConflictError';
  }
}

export class ModelUnavailableError extends Error {
  public constructor() {
    super('El modelo seleccionado no está disponible para nuevos intentos.');
    this.name = 'ModelUnavailableError';
  }
}

export class QuotaExceededError extends Error {
  public readonly day: string;
  public readonly limit: number;
  public readonly used: number;

  public constructor(day: string, used: number, limit: number) {
    super('Se alcanzó el límite diario de intentos.');
    this.name = 'QuotaExceededError';
    this.day = day;
    this.used = used;
    this.limit = limit;
  }
}

const DAY_TIME_ZONE = 'America/Argentina/Buenos_Aires';
const DEFAULT_QUOTA = 100;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const utf8 = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

/** Stable current-draft encoding used by the request fingerprint. */
export const canonicalDraft = (draft: RobotDraft): string =>
  JSON.stringify({
    schemaVersion: ROBOT_SCHEMA_VERSION,
    catalogVersion: draft.catalogVersion,
    modelKey: draft.modelKey,
    instructions: draft.instructions,
    skills: draft.skills.map((skill) => ({
      id: skill.id,
      enabled: skill.enabled,
      ...(skill.description === undefined ? {} : { description: skill.description }),
    })),
  });

export const fingerprintOf = (draft: RobotDraft, animationEnabled = false): string =>
  sha256(utf8(JSON.stringify({ draft: canonicalDraft(draft), animationEnabled })));

export const calendarDay = (date: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: DAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);

export const nextReset = (date: Date): string => {
  const day = calendarDay(date);
  const probe = new Date(`${day}T00:00:00.000Z`);
  // Argentina has no DST and is UTC-03. Keeping the construction explicit avoids
  // accepting the client's date while still giving the UI a precise server reset.
  probe.setUTCHours(3, 0, 0, 0);
  if (probe.getTime() <= date.getTime()) probe.setUTCDate(probe.getUTCDate() + 1);
  return probe.toISOString();
};

const initialSnapshot = (level: AttemptConfig['levelDefinition']) => createInitialState(level);

const skillsFor = (draft: RobotDraft): AttemptSkill[] =>
  draft.skills
    .filter((skill) => skill.enabled)
    .map((skill) => {
      const catalog = ROBOT_CATALOG.find((entry) => entry.id === skill.id);
      if (!catalog) throw new AttemptStoreError('La habilidad no pertenece al catálogo publicado.');
      return {
        id: skill.id,
        opaqueId: catalog.opaqueId,
        ...(skill.description === undefined ? {} : { description: skill.description }),
        inputSchema: catalog.inputSchema,
      };
    });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const freezeDeep = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
};

const storedConfig = (value: unknown): AttemptConfig => {
  if (!isRecord(value) || !isRecord(value.model) || !isRecord(value.protocol))
    throw new AttemptStoreError('El intento guardado tiene una configuración incompatible.');
  let model: ReturnType<typeof readModelProfile>;
  let levelDefinition: AttemptConfig['levelDefinition'];
  try {
    model = readModelProfile(value.model);
    levelDefinition = readCurrentLevel(value.levelDefinition);
  } catch (error) {
    throw new AttemptStoreError('El intento guardado no coincide con el contrato actual.', {
      cause: error,
    });
  }
  if (
    value.protocol.api !== 'converse' ||
    value.protocol.stream !== false ||
    value.levelId !== levelDefinition.id ||
    value.levelVersion !== String(levelDefinition.version) ||
    value.engineVersion !== 'periodic-engine-v2' ||
    value.protocolVersion !== 'tool-protocol-v2' ||
    value.inferenceVersion !== model.profileVersion ||
    value.maxTurns !== levelDefinition.maxTurns
  ) {
    throw new AttemptStoreError('El intento guardado tiene una configuración incompatible.');
  }
  return freezeDeep({
    ...(value as unknown as Omit<AttemptConfig, 'model' | 'levelDefinition'>),
    levelDefinition,
    model,
  });
};

const configForAdmission = (
  draft: RobotDraft,
  overrides: Partial<AttemptConfig> | undefined,
): AttemptConfig => {
  let model: Readonly<ModelProfile>;
  try {
    model = resolveModelProfile(draft.modelKey);
  } catch {
    throw new ModelUnavailableError();
  }
  const config: AttemptConfig = {
    ...DEFAULT_ATTEMPT_CONFIG,
    ...(overrides ?? {}),
    levelId: LEVEL.id,
    levelVersion: String(LEVEL.version),
    levelDefinition: LEVEL,
    engineVersion: 'periodic-engine-v2',
    protocolVersion: 'tool-protocol-v2',
    maxTurns: LEVEL.maxTurns,
    protocol: { api: 'converse', stream: false },
    inferenceVersion: model.profileVersion,
    model,
    scoreParameters: {
      ...DEFAULT_ATTEMPT_CONFIG.scoreParameters,
      ...(overrides?.scoreParameters ?? {}),
    },
  };
  return freezeDeep(config);
};

const clone = <T>(value: T): T => structuredClone(value);
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, child]) => `${JSON.stringify(name)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const key = (pk: string, sk: string): Record<string, AttributeValue> =>
  marshall({ PK: pk, SK: sk });
const itemOf = (value: Record<string, unknown>): Record<string, AttributeValue> =>
  marshall(value, { removeUndefinedValues: true });
const isConditional = (error: unknown): boolean =>
  error instanceof ConditionalCheckFailedException ||
  (error instanceof Error && error.name === 'ConditionalCheckFailedException');
const isTransactionCancellation = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === 'TransactionCanceledException' ||
    error.name === 'TransactionInProgressException');
const isTransactionConflict = (error: unknown): boolean => {
  if (error instanceof Error && error.name === 'TransactionConflictException') return true;
  if (!isTransactionCancellation(error)) return false;
  const reasons = (error as { CancellationReasons?: unknown }).CancellationReasons;
  return (
    (Array.isArray(reasons) &&
      reasons.some(
        (reason) =>
          typeof reason === 'object' &&
          reason !== null &&
          (reason as { Code?: unknown }).Code === 'TransactionConflict',
      )) ||
    (error instanceof Error && error.message.includes('TransactionConflict'))
  );
};
const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const MAX_CLOSE_CONFLICT_RETRIES = 3;

const toRecord = (item: Record<string, unknown>): PersistedAttempt => {
  if (
    item.recordVersion !== ATTEMPT_RECORD_VERSION ||
    typeof item.animationEnabled !== 'boolean' ||
    typeof item.presentationComplete !== 'boolean'
  ) {
    throw new AttemptStoreError('El intento guardado usa una versión incompatible.');
  }
  const config = storedConfig(item.config);
  const record = item as unknown as PersistedAttempt;
  const draft = validateDraft(item.draft);
  if (draft.modelKey !== config.model.key) {
    throw new AttemptStoreError('El intento guardado tiene un modelo inconsistente.');
  }
  return {
    ...record,
    config,
    draft,
    skills: item.skills as AttemptSkill[],
    initialSnapshot: item.initialSnapshot,
    currentSnapshot: item.currentSnapshot,
    inputTokens: typeof item.inputTokens === 'number' ? item.inputTokens : null,
    outputTokens: typeof item.outputTokens === 'number' ? item.outputTokens : null,
    reasoningTokens: typeof item.reasoningTokens === 'number' ? item.reasoningTokens : null,
    gameTokens: typeof item.gameTokens === 'number' ? item.gameTokens : null,
    cacheReadTokens: typeof item.cacheReadTokens === 'number' ? item.cacheReadTokens : null,
    cacheWriteTokens: typeof item.cacheWriteTokens === 'number' ? item.cacheWriteTokens : null,
    score: typeof item.score === 'number' ? item.score : null,
    reason: typeof item.reason === 'string' ? item.reason : undefined,
  };
};

const withoutSnapshots = (record: PersistedAttempt): Record<string, unknown> => {
  const fields: Record<string, unknown> = { ...record };
  delete fields.initialSnapshot;
  delete fields.currentSnapshot;
  return {
    ...fields,
    initialStateId: 'state-0',
    currentStateId:
      typeof record.currentSnapshot === 'object' &&
      record.currentSnapshot !== null &&
      'id' in record.currentSnapshot
        ? (record.currentSnapshot as { id: string }).id
        : 'state-0',
  };
};

const animationPreferenceOf = (item: Record<string, unknown>): AnimationPreference => {
  if (
    typeof item.animationEnabled !== 'boolean' ||
    typeof item.version !== 'number' ||
    !Number.isSafeInteger(item.version) ||
    item.version < 1
  ) {
    throw new AttemptStoreError('La preferencia de animación guardada no es válida.');
  }
  return { animationEnabled: item.animationEnabled, version: item.version };
};

const terminalAttempt = (attempt: PersistedAttempt): boolean =>
  attempt.status !== 'pending' && attempt.status !== 'running';

export type DynamoAttemptStoreOptions = {
  readonly client?: DynamoDBClient;
  readonly tableName?: string;
  readonly bodyStore?: BodyStore;
  readonly now?: () => Date;
  readonly quotaLimit?: number;
};

/** DynamoDB implementation. It deliberately uses the existing table and no indexes. */
export class DynamoAttemptStore implements AttemptStore {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;
  private readonly bodyStore?: BodyStore;
  private readonly now: () => Date;
  private readonly quotaLimit: number;

  public constructor(options: DynamoAttemptStoreOptions = {}) {
    this.client = options.client ?? new DynamoDBClient({});
    this.tableName = options.tableName ?? process.env.DRAFT_TABLE_NAME ?? '';
    if (!this.tableName) throw new AttemptStoreError('Falta DRAFT_TABLE_NAME.');
    this.bodyStore = options.bodyStore;
    this.now = options.now ?? (() => new Date());
    this.quotaLimit =
      options.quotaLimit ?? Number(process.env.ATTEMPT_DAILY_LIMIT ?? DEFAULT_QUOTA);
  }

  public async admit(input: AdmitInput): Promise<AdmitResult> {
    if (!input.requestKey || input.requestKey.length > 256)
      throw new AttemptStoreError('La clave de solicitud no es válida.');
    const animationEnabled = input.animationEnabled === true;
    const fingerprint = fingerprintOf(input.draft, animationEnabled);
    const existing = await this.getByRequest(input.owner, input.requestKey);
    if (existing) {
      if (fingerprintOf(existing.draft, existing.animationEnabled) !== fingerprint)
        throw new IdempotencyConflictError();
      return { attempt: summaryOf(existing), admitted: false };
    }
    const draftResponse = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: key(`USER#${input.owner}`, 'DRAFT'),
        ConsistentRead: true,
      }),
    );
    if (!draftResponse.Item)
      throw new AdmissionConflictError('Guardá la configuración antes de probar.');
    const current = unmarshall(draftResponse.Item) as {
      version?: unknown;
      draft?: unknown;
    };
    let currentDraft: RobotDraft;
    try {
      currentDraft = validateDraft(current.draft);
    } catch {
      throw new AdmissionConflictError('La configuración guardada no es compatible.');
    }
    if (current.version !== input.expectedVersion || !draftsEqual(input.draft, currentDraft))
      throw new AdmissionConflictError();
    if (input.draft.skills.every((skill) => !skill.enabled))
      throw new AdmissionConflictError('Seleccioná al menos una habilidad.');

    const config = configForAdmission(input.draft, input.config);
    const nowDate = input.now ? new Date(input.now) : this.now();
    const now = nowDate.toISOString();
    const day = calendarDay(nowDate);
    const id = `${now.replace(/[-:.TZ]/gu, '').slice(0, 14)}-${randomUUID()}`;
    const initial = initialSnapshot(config.levelDefinition);
    const record: PersistedAttempt = {
      recordVersion: ATTEMPT_RECORD_VERSION,
      id,
      createdAt: now,
      updatedAt: now,
      status: 'pending',
      cancelRequested: false,
      levelId: config.levelId,
      modelKey: config.model.key,
      modelLabel: config.model.label,
      modelId: config.model.modelId,
      turnsUsed: 0,
      maxTurns: config.maxTurns,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      gameTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      score: null,
      progress: 0,
      finalSupport: 0,
      animationEnabled,
      presentationComplete: !animationEnabled,
      recordComplete: true,
      owner: input.owner,
      requestKey: input.requestKey,
      draft: clone(input.draft),
      instructions: input.draft.instructions,
      skills: skillsFor(input.draft),
      config,
      initialSnapshot: initial,
      currentSnapshot: initial,
      sequence: 0,
      nextCall: 1,
      startDeadline: new Date(nowDate.getTime() + config.startTimeoutMs).toISOString(),
      sessionId: `attempt-${id}`,
    };
    const requestItem = itemOf({
      PK: `USER#${input.owner}`,
      SK: `REQUEST#${input.requestKey}`,
      entity: 'attempt-request',
      owner: input.owner,
      requestKey: input.requestKey,
      fingerprint,
      attemptId: id,
      day,
      createdAt: now,
    });
    const persisted = withoutSnapshots(record);
    const headerItem = itemOf({
      PK: `USER#${input.owner}`,
      SK: `ATTEMPT#${id}`,
      entity: 'attempt',
      ...persisted,
    });
    const stateItem = itemOf({
      PK: `ATTEMPT#${id}`,
      SK: 'STATE#state-0',
      entity: 'snapshot',
      stateId: 'state-0',
      snapshot: initial,
      createdAt: now,
    });
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: key(`USER#${input.owner}`, 'DRAFT'),
                ConditionExpression: '#version = :version AND #draft = :draft',
                ExpressionAttributeNames: { '#version': 'version', '#draft': 'draft' },
                ExpressionAttributeValues: marshall({
                  ':version': input.expectedVersion,
                  // Compare the exact current draft value read from DynamoDB.
                  ':draft': current.draft,
                }),
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: requestItem,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: headerItem,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: stateItem,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: key(`USER#${input.owner}`, `QUOTA#${day}`),
                UpdateExpression:
                  'SET #entity = :entity, #owner = :owner, #day = :day, #used = if_not_exists(#used, :zero) + :one, #limit = :limit, #updatedAt = :now',
                ConditionExpression: 'attribute_not_exists(#used) OR #used < :limit',
                ExpressionAttributeNames: {
                  '#entity': 'entity',
                  '#owner': 'owner',
                  '#day': 'day',
                  '#used': 'used',
                  '#limit': 'limit',
                  '#updatedAt': 'updatedAt',
                },
                ExpressionAttributeValues: marshall({
                  ':entity': 'quota',
                  ':owner': input.owner,
                  ':day': day,
                  ':zero': 0,
                  ':one': 1,
                  ':limit': this.quotaLimit,
                  ':now': now,
                }),
              },
            },
          ],
        }),
      );
    } catch (error) {
      let winner = await this.getByRequest(input.owner, input.requestKey);
      // DynamoDB can cancel two transactions that contend on the same
      // idempotency key before either caller observes the committed request
      // item. Poll the authoritative mapping after a transaction conflict;
      // this only rereads and never retries the write.
      if (!winner && isTransactionConflict(error)) {
        for (const milliseconds of [10, 25, 50, 100]) {
          await delay(milliseconds);
          winner = await this.getByRequest(input.owner, input.requestKey);
          if (winner) break;
        }
      }
      if (winner) {
        if (fingerprintOf(winner.draft, winner.animationEnabled) !== fingerprint)
          throw new IdempotencyConflictError();
        return { attempt: summaryOf(winner), admitted: false };
      }
      if (isConditional(error)) throw new AdmissionConflictError();
      if (isTransactionCancellation(error)) {
        const draftAfter = await this.client.send(
          new GetItemCommand({
            TableName: this.tableName,
            Key: key(`USER#${input.owner}`, 'DRAFT'),
            ConsistentRead: true,
          }),
        );
        const currentAfter = draftAfter.Item ? unmarshall(draftAfter.Item) : undefined;
        let currentAfterDraft: RobotDraft | undefined;
        try {
          currentAfterDraft = currentAfter ? validateDraft(currentAfter.draft) : undefined;
        } catch {
          currentAfterDraft = undefined;
        }
        if (
          !currentAfter ||
          !currentAfterDraft ||
          currentAfter.version !== input.expectedVersion ||
          !draftsEqual(input.draft, currentAfterDraft)
        )
          throw new AdmissionConflictError();
        const quotaAfter = await this.quota(input.owner);
        if (quotaAfter.used >= quotaAfter.limit)
          throw new QuotaExceededError(quotaAfter.day, quotaAfter.used, quotaAfter.limit);
        throw new AttemptStoreError(
          'No se pudo confirmar la admisión; consultá la clave para reintentar.',
          { cause: error },
        );
      }
      throw new AttemptStoreError('No se pudo admitir el intento.', { cause: error });
    }
    return { attempt: summaryOf(record), admitted: true };
  }

  public async get(owner: string, attemptId: string): Promise<PersistedAttempt | undefined> {
    const response = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: key(`USER#${owner}`, `ATTEMPT#${attemptId}`),
        ConsistentRead: true,
      }),
    );
    if (!response.Item) return undefined;
    const item = unmarshall(response.Item);
    const stateId = typeof item.currentStateId === 'string' ? item.currentStateId : 'state-0';
    const [state, initial] = await Promise.all([
      this.client.send(
        new GetItemCommand({
          TableName: this.tableName,
          Key: key(`ATTEMPT#${attemptId}`, `STATE#${stateId}`),
          ConsistentRead: true,
        }),
      ),
      stateId === 'state-0'
        ? Promise.resolve(undefined)
        : this.client.send(
            new GetItemCommand({
              TableName: this.tableName,
              Key: key(`ATTEMPT#${attemptId}`, 'STATE#state-0'),
              ConsistentRead: true,
            }),
          ),
    ]);
    const currentSnapshot = state.Item ? unmarshall(state.Item).snapshot : undefined;
    const initialSnapshot =
      stateId === 'state-0'
        ? currentSnapshot
        : initial?.Item
          ? unmarshall(initial.Item).snapshot
          : undefined;
    return toRecord({ ...item, initialSnapshot, currentSnapshot });
  }

  public async getAnimationPreference(owner: string): Promise<AnimationPreference> {
    const response = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: key(`USER#${owner}`, 'PREFERENCE#ANIMATION'),
        ConsistentRead: true,
      }),
    );
    return response.Item
      ? animationPreferenceOf(unmarshall(response.Item))
      : { animationEnabled: true, version: 0 };
  }

  public async putAnimationPreference(
    owner: string,
    animationEnabled: boolean,
    expectedVersion: number,
  ): Promise<AnimationPreference> {
    const nextVersion = expectedVersion + 1;
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: key(`USER#${owner}`, 'PREFERENCE#ANIMATION'),
          UpdateExpression:
            'SET #entity = :entity, #owner = :owner, #animationEnabled = :animationEnabled, #version = :version, #updatedAt = :updatedAt',
          ConditionExpression:
            expectedVersion === 0 ? 'attribute_not_exists(PK)' : '#version = :expectedVersion',
          ExpressionAttributeNames: {
            '#entity': 'entity',
            '#owner': 'owner',
            '#animationEnabled': 'animationEnabled',
            '#version': 'version',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: marshall({
            ':entity': 'animation-preference',
            ':owner': owner,
            ':animationEnabled': animationEnabled,
            ':version': nextVersion,
            ...(expectedVersion === 0 ? {} : { ':expectedVersion': expectedVersion }),
            ':updatedAt': this.now().toISOString(),
          }),
        }),
      );
      return { animationEnabled, version: nextVersion };
    } catch (error) {
      if (isConditional(error))
        throw new AnimationPreferenceConflictError(await this.getAnimationPreference(owner));
      throw new AttemptStoreError('No se pudo guardar la preferencia de animación.', {
        cause: error,
      });
    }
  }

  public async getReplayRecord(
    owner: string,
    attemptId: string,
  ): Promise<ReplayRecordView | undefined> {
    const attempt = await this.get(owner, attemptId);
    if (!attempt) return undefined;
    if (!terminalAttempt(attempt) || !attempt.recordComplete) throw new ReplayRecordError();
    const [actionItems, snapshotItems] = await Promise.all([
      this.queryAttemptItems(attemptId, 'ACTION#'),
      this.queryAttemptItems(attemptId, 'STATE#'),
    ]);
    return replayRecordViewOf(
      attempt,
      actionItems.map((item) => unmarshall(item)),
      snapshotItems.map((item) => unmarshall(item)),
    );
  }

  public async markPresentationComplete(
    owner: string,
    attemptId: string,
  ): Promise<PersistedAttempt | undefined> {
    const current = await this.get(owner, attemptId);
    if (!current) return undefined;
    if (!terminalAttempt(current)) throw new AttemptNotTerminalError();
    if (current.presentationComplete) return current;
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: key(`USER#${owner}`, `ATTEMPT#${attemptId}`),
          UpdateExpression: 'SET #presentationComplete = :true, #updatedAt = :updatedAt',
          ConditionExpression:
            '#presentationComplete = :false AND #status IN (:victory, :defeat, :incomplete, :cancelled, :error)',
          ExpressionAttributeNames: {
            '#presentationComplete': 'presentationComplete',
            '#updatedAt': 'updatedAt',
            '#status': 'status',
          },
          ExpressionAttributeValues: marshall({
            ':true': true,
            ':false': false,
            ':updatedAt': this.now().toISOString(),
            ':victory': 'victory',
            ':defeat': 'defeat',
            ':incomplete': 'incomplete',
            ':cancelled': 'cancelled',
            ':error': 'error',
          }),
        }),
      );
    } catch (error) {
      if (!isConditional(error))
        throw new AttemptStoreError('No se pudo completar la presentación.', { cause: error });
      const latest = await this.get(owner, attemptId);
      if (!latest) return undefined;
      if (!terminalAttempt(latest)) throw new AttemptNotTerminalError();
      if (latest.presentationComplete) return latest;
      throw new AttemptStoreError('No se pudo completar la presentación.', { cause: error });
    }
    return this.get(owner, attemptId);
  }

  public async getByRequest(
    owner: string,
    requestKey: string,
  ): Promise<PersistedAttempt | undefined> {
    const response = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: key(`USER#${owner}`, `REQUEST#${requestKey}`),
        ConsistentRead: true,
      }),
    );
    if (!response.Item) return undefined;
    const item = unmarshall(response.Item);
    return typeof item.attemptId === 'string' ? this.get(owner, item.attemptId) : undefined;
  }

  public async list(
    owner: string,
    cursor?: string,
    limit = 20,
  ): Promise<{
    attempts: import('../../../shared/server/attempt.js').AttemptSummary[];
    nextCursor?: string;
  }> {
    const exclusiveStartKey = cursor ? this.decodeCursor(cursor, owner) : undefined;
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: marshall({ ':pk': `USER#${owner}`, ':prefix': 'ATTEMPT#' }),
        ExclusiveStartKey: exclusiveStartKey,
        Limit: Math.min(limit, 20),
        ScanIndexForward: false,
        ConsistentRead: true,
      }),
    );
    const attempts = (response.Items ?? []).map((item) => summaryOf(toRecord(unmarshall(item))));
    return {
      attempts,
      ...(response.LastEvaluatedKey
        ? { nextCursor: this.encodeCursor(owner, response.LastEvaluatedKey) }
        : {}),
    };
  }

  public async quota(
    owner: string,
  ): Promise<{ day: string; used: number; limit: number; remaining: number; resetsAt: string }> {
    const now = this.now();
    const day = calendarDay(now);
    const response = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: key(`USER#${owner}`, `QUOTA#${day}`),
        ConsistentRead: true,
      }),
    );
    const used = response.Item ? Number(unmarshall(response.Item).used ?? 0) : 0;
    return {
      day,
      used,
      limit: this.quotaLimit,
      remaining: Math.max(0, this.quotaLimit - used),
      resetsAt: nextReset(now),
    };
  }

  public async claim(
    owner: string,
    attemptId: string,
    executorId: string,
    now = this.now().toISOString(),
  ): Promise<PersistedAttempt | undefined> {
    const current = await this.get(owner, attemptId);
    if (!current) return undefined;
    if (current.status === 'running' && current.executorId === executorId) return current;
    if (current.status !== 'pending' || current.cancelRequested) return undefined;
    const executionDeadline = new Date(
      new Date(now).getTime() + current.config.runtimeLifetimeMs,
    ).toISOString();
    const runtimeDeadline = new Date(
      new Date(executionDeadline).getTime() + current.config.terminationMarginMs,
    ).toISOString();
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: key(`USER#${owner}`, `ATTEMPT#${attemptId}`),
          UpdateExpression:
            'SET #status = :running, #executorId = :executor, #claimedAt = :claimed, #executionDeadline = :executionDeadline, #runtimeDeadline = :deadline, #updatedAt = :now',
          ConditionExpression:
            '#status = :pending AND #cancelRequested = :false AND #startDeadline >= :now',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#executorId': 'executorId',
            '#claimedAt': 'claimedAt',
            '#runtimeDeadline': 'runtimeDeadline',
            '#executionDeadline': 'executionDeadline',
            '#updatedAt': 'updatedAt',
            '#cancelRequested': 'cancelRequested',
            '#startDeadline': 'startDeadline',
          },
          ExpressionAttributeValues: marshall({
            ':running': 'running',
            ':pending': 'pending',
            ':false': false,
            ':executor': executorId,
            ':claimed': now,
            ':deadline': runtimeDeadline,
            ':executionDeadline': executionDeadline,
            ':now': now,
          }),
          ReturnValues: 'ALL_NEW',
        }),
      );
      return this.get(owner, attemptId);
    } catch (error) {
      const after = await this.get(owner, attemptId);
      if (after?.status === 'running' && after.executorId === executorId) return after;
      if (isConditional(error)) return undefined;
      throw new AttemptStoreError('No se pudo reclamar el intento.', { cause: error });
    }
  }

  public async requestCancel(
    owner: string,
    attemptId: string,
    now = this.now().toISOString(),
  ): Promise<PersistedAttempt | undefined> {
    const current = await this.get(owner, attemptId);
    if (!current) return undefined;
    if (current.status === 'pending') {
      try {
        await this.client.send(
          new UpdateItemCommand({
            TableName: this.tableName,
            Key: key(`USER#${owner}`, `ATTEMPT#${attemptId}`),
            UpdateExpression:
              'SET #status = :cancelled, #cancelRequested = :true, #reason = :reason, #presentationComplete = :presented, #updatedAt = :now',
            ConditionExpression: '#status = :pending AND #cancelRequested = :false',
            ExpressionAttributeNames: {
              '#status': 'status',
              '#cancelRequested': 'cancelRequested',
              '#reason': 'reason',
              '#presentationComplete': 'presentationComplete',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: marshall({
              ':pending': 'pending',
              ':false': false,
              ':cancelled': 'cancelled',
              ':true': true,
              ':reason': 'cancelled_before_start',
              ':presented': true,
              ':now': now,
            }),
          }),
        );
      } catch (error) {
        if (isConditional(error)) {
          const latest = await this.get(owner, attemptId);
          if (latest?.status === 'running') return this.requestCancel(owner, attemptId, now);
          return latest;
        }
        if (!isConditional(error))
          throw new AttemptStoreError('No se pudo cancelar el intento.', { cause: error });
      }
      return this.get(owner, attemptId);
    }
    if (current.status !== 'running') return current;
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: key(`USER#${owner}`, `ATTEMPT#${attemptId}`),
          UpdateExpression: 'SET #cancelRequested = :true, #updatedAt = :now',
          ConditionExpression: '#status = :running AND #cancelRequested = :false',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#cancelRequested': 'cancelRequested',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: marshall({
            ':running': 'running',
            ':false': false,
            ':true': true,
            ':now': now,
          }),
        }),
      );
    } catch (error) {
      if (!isConditional(error))
        throw new AttemptStoreError('No se pudo solicitar la cancelación.', { cause: error });
    }
    return this.get(owner, attemptId);
  }

  public async beginCall(
    owner: string,
    attemptId: string,
    executorId: string,
    call: CallRecord,
  ): Promise<CallRecord | undefined> {
    const current = await this.get(owner, attemptId);
    if (
      !current ||
      current.status !== 'running' ||
      current.executorId !== executorId ||
      current.cancelRequested ||
      call.seq !== current.nextCall
    )
      return undefined;
    const auditedCall: CallRecord = {
      ...call,
      modelKey: current.config.model.key,
      modelId: current.config.model.modelId,
      region: current.config.model.region,
      profileVersion: current.config.model.profileVersion,
    };
    const callItem = itemOf({
      PK: `ATTEMPT#${attemptId}`,
      SK: `CALL#${String(call.seq).padStart(8, '0')}`,
      entity: 'call',
      ...auditedCall,
    });
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: key(`USER#${owner}`, `ATTEMPT#${attemptId}`),
                UpdateExpression: 'SET #nextCall = :next, #updatedAt = :now',
                ConditionExpression:
                  '#executorId = :executor AND #status = :running AND #cancelRequested = :false AND #nextCall = :seq',
                ExpressionAttributeNames: {
                  '#nextCall': 'nextCall',
                  '#updatedAt': 'updatedAt',
                  '#executorId': 'executorId',
                  '#status': 'status',
                  '#cancelRequested': 'cancelRequested',
                },
                ExpressionAttributeValues: marshall({
                  ':next': auditedCall.seq + 1,
                  ':now': auditedCall.createdAt,
                  ':executor': executorId,
                  ':running': 'running',
                  ':false': false,
                  ':seq': auditedCall.seq,
                }),
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: callItem,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
      );
      return clone(auditedCall);
    } catch (error) {
      const calls = await this.getCalls(owner, attemptId);
      const found = calls.find((item) => item.seq === auditedCall.seq);
      if (found) return found;
      if (isConditional(error) || isTransactionCancellation(error)) return undefined;
      throw new AttemptStoreError('No se pudo registrar la llamada.', { cause: error });
    }
  }

  public async finishCall(
    owner: string,
    attemptId: string,
    executorId: string,
    call: CallRecord,
  ): Promise<CallRecord | undefined> {
    const current = await this.get(owner, attemptId);
    if (!current || current.executorId !== executorId) return undefined;
    const values: Record<string, unknown> = {
      ':status': call.status,
      ':updatedAt': call.updatedAt,
      ':usage': call.usage,
      ':responseKey': call.responseKey,
      ':responseSha256': call.responseSha256,
      ':responseBytes': call.responseBytes,
      ':requestId': call.requestId,
      ':responseStatus': call.responseStatus,
      ':errorCode': call.errorCode,
    };
    const names: Record<string, string> = {
      '#attemptId': 'attemptId',
      '#seq': 'seq',
      '#requestKey': 'requestKey',
      '#responseKey': 'responseKey',
      '#status': 'status',
      '#updatedAt': 'updatedAt',
      '#usage': 'usage',
      '#responseSha256': 'responseSha256',
      '#responseBytes': 'responseBytes',
    };
    const sets = [
      '#status = :status',
      '#updatedAt = :updatedAt',
      '#usage = :usage',
      '#responseKey = :responseKey',
    ];
    const callCondition = call.responseSha256
      ? '#attemptId = :attemptId AND #seq = :seq AND #requestKey = :requestKey AND #responseKey = :responseKey AND (attribute_not_exists(#responseSha256) OR #responseSha256 = :responseSha256)'
      : '#attemptId = :attemptId AND #seq = :seq AND #requestKey = :requestKey AND #responseKey = :responseKey AND attribute_not_exists(#responseSha256)';
    for (const [name, value] of [
      ['responseSha256', call.responseSha256],
      ['responseBytes', call.responseBytes],
      ['requestId', call.requestId],
      ['responseStatus', call.responseStatus],
      ['errorCode', call.errorCode],
    ] as const)
      if (value !== undefined) {
        sets.push(`#${name} = :${name}`);
        names[`#${name}`] = name;
      }
    const allCalls = (await this.getCalls(owner, attemptId)).map((item) =>
      item.seq === call.seq ? call : item,
    );
    const completedCalls = allCalls.filter((item) => item.status !== 'started');
    const allCallsComplete = completedCalls.length === allCalls.length;
    const total = (field: keyof Usage): number | null =>
      allCallsComplete &&
      completedCalls.length > 0 &&
      completedCalls.every((item) => typeof item.usage[field] === 'number')
        ? completedCalls.reduce((sum, item) => sum + (item.usage[field] as number), 0)
        : null;
    const completeCalls = allCalls.length;
    const inputTokens = total('inputTokens');
    const outputTokens = total('outputTokens');
    const reasoningTokens = total('reasoningTokens');
    const gameTokens = total('gameTokens');
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: key(`ATTEMPT#${attemptId}`, `CALL#${String(call.seq).padStart(8, '0')}`),
                UpdateExpression: `SET ${sets.join(', ')}`,
                ConditionExpression: `${callCondition} AND (#status = :started OR #status = :incoming OR (#status = :received AND (:incoming = :invalid OR :incoming = :error)))`,
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: marshall(
                  {
                    ...values,
                    ':attemptId': attemptId,
                    ':seq': call.seq,
                    ':requestKey': call.requestKey,
                    ':started': 'started',
                    ':incoming': call.status,
                    ':received': 'received',
                    ':invalid': 'invalid',
                    ':error': 'error',
                    ...(call.responseSha256 ? { ':responseSha256': call.responseSha256 } : {}),
                  },
                  { removeUndefinedValues: true },
                ),
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: key(`USER#${owner}`, `ATTEMPT#${attemptId}`),
                UpdateExpression:
                  'SET #calls = :calls, #inputTokens = :input, #outputTokens = :output, #reasoningTokens = :reasoning, #gameTokens = :game, #cacheReadTokens = :cacheRead, #cacheWriteTokens = :cacheWrite, #recordComplete = :complete',
                ExpressionAttributeNames: {
                  '#calls': 'calls',
                  '#inputTokens': 'inputTokens',
                  '#outputTokens': 'outputTokens',
                  '#reasoningTokens': 'reasoningTokens',
                  '#gameTokens': 'gameTokens',
                  '#cacheReadTokens': 'cacheReadTokens',
                  '#cacheWriteTokens': 'cacheWriteTokens',
                  '#recordComplete': 'recordComplete',
                  '#executorId': 'executorId',
                  '#nextCall': 'nextCall',
                  '#sequence': 'sequence',
                  '#currentStateId': 'currentStateId',
                },
                ExpressionAttributeValues: marshall({
                  ':calls': completeCalls,
                  ':input': inputTokens,
                  ':output': outputTokens,
                  ':reasoning': reasoningTokens,
                  ':game': gameTokens,
                  ':cacheRead': completedCalls.every((item) => item.usage.cacheReadTokens !== null)
                    ? total('cacheReadTokens')
                    : null,
                  ':cacheWrite': completedCalls.every(
                    (item) => item.usage.cacheWriteTokens !== null,
                  )
                    ? total('cacheWriteTokens')
                    : null,
                  ':complete':
                    allCallsComplete &&
                    completedCalls.every(
                      (item) => item.status !== 'unknown' && item.responseSha256 !== undefined,
                    ),
                  ':executor': executorId,
                  ':previousCalls': current.calls,
                  ':previousInput': current.inputTokens,
                  ':previousOutput': current.outputTokens,
                  ':previousReasoning': current.reasoningTokens,
                  ':previousGame': current.gameTokens,
                  ':previousCacheRead': current.cacheReadTokens,
                  ':previousCacheWrite': current.cacheWriteTokens,
                  ':previousComplete': current.recordComplete,
                  ':previousNextCall': current.nextCall,
                  ':previousSequence': current.sequence,
                  ':previousState':
                    typeof current.currentSnapshot === 'object' &&
                    current.currentSnapshot !== null &&
                    'id' in current.currentSnapshot
                      ? (current.currentSnapshot as { id: string }).id
                      : 'state-0',
                }),
                ConditionExpression:
                  '#executorId = :executor AND #calls = :previousCalls AND #inputTokens = :previousInput AND #outputTokens = :previousOutput AND (attribute_not_exists(#reasoningTokens) OR #reasoningTokens = :previousReasoning) AND #gameTokens = :previousGame AND #cacheReadTokens = :previousCacheRead AND #cacheWriteTokens = :previousCacheWrite AND #recordComplete = :previousComplete AND #nextCall = :previousNextCall AND #sequence = :previousSequence AND #currentStateId = :previousState',
              },
            },
          ],
        }),
      );
      return clone(call);
    } catch (error) {
      if (isTransactionCancellation(error) || isConditional(error))
        return this.findCall(owner, attemptId, call.seq);
      throw new AttemptStoreError('No se pudo guardar el resultado de la llamada.', {
        cause: error,
      });
    }
  }

  public async publishAction(
    owner: string,
    attemptId: string,
    executorId: string,
    publication: ActionPublication,
  ): Promise<PersistedAttempt | undefined> {
    const current = await this.get(owner, attemptId);
    if (
      !current ||
      current.status !== 'running' ||
      current.executorId !== executorId ||
      current.cancelRequested ||
      publication.seq !== current.sequence + 1 ||
      (current.currentSnapshot as { id?: unknown })?.id !== publication.beforeStateId
    )
      return current?.sequence === publication.seq &&
        (current.currentSnapshot as { id?: unknown })?.id === publication.afterStateId
        ? this.committedPublication(owner, attemptId, publication, current)
        : undefined;
    const state = itemOf({
      PK: `ATTEMPT#${attemptId}`,
      SK: `STATE#${publication.afterStateId}`,
      entity: 'snapshot',
      stateId: publication.afterStateId,
      snapshot: publication.afterSnapshot,
      createdAt: this.now().toISOString(),
    });
    const actionFields = {
      seq: publication.seq,
      decisionId: publication.decisionId,
      action: publication.action,
      resolution: publication.resolution,
      beforeStateId: publication.beforeStateId,
      afterStateId: publication.afterStateId,
      terminalStatus: publication.terminalStatus,
      reason: publication.reason,
      progress: publication.progress,
      finalSupport: publication.finalSupport,
      turnsUsed: publication.turnsUsed,
    };
    const action = itemOf({
      PK: `ATTEMPT#${attemptId}`,
      SK: `ACTION#${String(publication.seq).padStart(8, '0')}`,
      entity: 'action',
      ...actionFields,
    });
    const status = publication.terminalStatus ?? 'running';
    const params = current.config.scoreParameters;
    const score = scoreAttempt(
      {
        status: publication.terminalStatus ?? 'incomplete',
        turnsUsed: publication.turnsUsed,
        collectedObjectIds: [],
        gameTokens: current.gameTokens,
      },
      {
        base: params.base ?? 1000,
        turnWeight: params.turnWeight ?? 10,
        tokenWeight: params.tokenWeight ?? 1,
        tokenUnit: params.tokenUnit ?? 1000,
        decimalPlaces: params.decimals ?? 2,
        allowNegative: params.allowNegative !== 0,
        objectValues: {},
      },
    );
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: state,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: action,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: key(`USER#${owner}`, `ATTEMPT#${attemptId}`),
                UpdateExpression:
                  'SET #sequence = :sequence, #currentStateId = :state, #turnsUsed = :turns, #progress = :progress, #finalSupport = :support, #status = :status, #score = :score, #reason = :reason, #presentationComplete = :presented, #updatedAt = :now',
                ConditionExpression:
                  '#executorId = :executor AND #status = :running AND #cancelRequested = :false AND #sequence = :previous AND #currentStateId = :beforeState',
                ExpressionAttributeNames: {
                  '#sequence': 'sequence',
                  '#currentStateId': 'currentStateId',
                  '#turnsUsed': 'turnsUsed',
                  '#progress': 'progress',
                  '#finalSupport': 'finalSupport',
                  '#status': 'status',
                  '#score': 'score',
                  '#reason': 'reason',
                  '#presentationComplete': 'presentationComplete',
                  '#updatedAt': 'updatedAt',
                  '#executorId': 'executorId',
                  '#cancelRequested': 'cancelRequested',
                },
                ExpressionAttributeValues: marshall({
                  ':sequence': publication.seq,
                  ':state': publication.afterStateId,
                  ':turns': publication.turnsUsed,
                  ':progress': publication.progress,
                  ':support': publication.finalSupport,
                  ':status': status,
                  ':score': score,
                  ':reason': publication.reason ?? null,
                  ':presented': !current.animationEnabled,
                  ':now': this.now().toISOString(),
                  ':executor': executorId,
                  ':running': 'running',
                  ':false': false,
                  ':previous': current.sequence,
                  ':beforeState': publication.beforeStateId,
                }),
              },
            },
          ],
        }),
      );
      return this.get(owner, attemptId);
    } catch (error) {
      if (isTransactionCancellation(error) || isConditional(error)) {
        const after = await this.get(owner, attemptId);
        return after ? this.committedPublication(owner, attemptId, publication, after) : undefined;
      }
      const after = await this.get(owner, attemptId);
      if (after) {
        const committed = await this.committedPublication(owner, attemptId, publication, after);
        if (committed) return committed;
      }
      throw new AttemptStoreError('No se pudo publicar la acción.', { cause: error });
    }
  }

  public async close(
    owner: string,
    attemptId: string,
    terminalStatus: 'cancelled' | 'error',
    reason: string,
    executorId?: string,
    now = this.now().toISOString(),
  ): Promise<PersistedAttempt | undefined> {
    for (let retry = 0; retry < MAX_CLOSE_CONFLICT_RETRIES; retry += 1) {
      const current = await this.get(owner, attemptId);
      if (!current) return undefined;
      if (current.status !== 'pending' && current.status !== 'running') return current;
      const durableCalls = await this.getCalls(owner, attemptId);
      const durableComplete =
        current.recordComplete &&
        durableCalls.every((call) => call.status !== 'started' && call.status !== 'unknown');
      try {
        await this.client.send(
          new UpdateItemCommand({
            TableName: this.tableName,
            Key: key(`USER#${owner}`, `ATTEMPT#${attemptId}`),
            UpdateExpression:
              'SET #status = :status, #reason = :reason, #calls = :calls, #inputTokens = :input, #outputTokens = :output, #reasoningTokens = :reasoning, #gameTokens = :game, #cacheReadTokens = :cacheRead, #cacheWriteTokens = :cacheWrite, #presentationComplete = :presented, #recordComplete = :complete, #updatedAt = :now',
            ConditionExpression: executorId
              ? '#status = :running AND #executorId = :executor AND #sequence = :sequence'
              : '(#status = :pending OR #status = :running) AND #sequence = :sequence',
            ExpressionAttributeNames: {
              '#status': 'status',
              '#reason': 'reason',
              '#calls': 'calls',
              '#inputTokens': 'inputTokens',
              '#outputTokens': 'outputTokens',
              '#reasoningTokens': 'reasoningTokens',
              '#gameTokens': 'gameTokens',
              '#cacheReadTokens': 'cacheReadTokens',
              '#cacheWriteTokens': 'cacheWriteTokens',
              '#presentationComplete': 'presentationComplete',
              '#recordComplete': 'recordComplete',
              '#updatedAt': 'updatedAt',
              '#sequence': 'sequence',
              ...(executorId ? { '#executorId': 'executorId' } : {}),
            },
            ExpressionAttributeValues: marshall({
              ':status': terminalStatus,
              ':reason': reason,
              ':calls': Math.max(current.calls, durableCalls.length),
              ':input': durableComplete ? current.inputTokens : null,
              ':output': durableComplete ? current.outputTokens : null,
              ':reasoning': durableComplete ? current.reasoningTokens : null,
              ':game': durableComplete ? current.gameTokens : null,
              ':cacheRead': durableComplete ? current.cacheReadTokens : null,
              ':cacheWrite': durableComplete ? current.cacheWriteTokens : null,
              ':presented': !current.animationEnabled || current.sequence === 0,
              ':complete': durableComplete,
              ':now': now,
              ':sequence': current.sequence,
              ...(executorId
                ? { ':running': 'running', ':executor': executorId }
                : { ':pending': 'pending', ':running': 'running' }),
            }),
          }),
        );
        return this.get(owner, attemptId);
      } catch (error) {
        if (!isConditional(error))
          throw new AttemptStoreError('No se pudo cerrar el intento.', { cause: error });
        const latest = await this.get(owner, attemptId);
        if (!latest || (latest.status !== 'pending' && latest.status !== 'running')) return latest;
        if (
          (executorId && latest.executorId !== executorId) ||
          latest.sequence === current.sequence
        )
          return latest;
        if (retry === MAX_CLOSE_CONFLICT_RETRIES - 1)
          throw new AttemptStoreError('El intento cambió mientras se cerraba.', { cause: error });
      }
    }
    return undefined;
  }

  public async closeExpired(
    owner: string,
    attemptId: string,
    now = this.now().toISOString(),
  ): Promise<PersistedAttempt | undefined> {
    await this.recoverBodies(owner, attemptId);
    const current = await this.get(owner, attemptId);
    if (!current) return undefined;
    const at = new Date(now).getTime();
    if (current.status === 'pending' && at > new Date(current.startDeadline).getTime()) {
      await this.close(owner, attemptId, 'error', 'start_deadline_expired', undefined, now);
      await this.recoverBodies(owner, attemptId);
      return this.get(owner, attemptId);
    }
    if (
      current.status === 'running' &&
      current.runtimeDeadline &&
      at > new Date(current.runtimeDeadline).getTime()
    ) {
      await this.close(
        owner,
        attemptId,
        'error',
        'runtime_deadline_expired',
        current.executorId,
        now,
      );
      await this.recoverBodies(owner, attemptId);
      return this.get(owner, attemptId);
    }
    return current;
  }

  public async getSnapshot(
    owner: string,
    attemptId: string,
    stateId = 'state-0',
  ): Promise<unknown | undefined> {
    if (!(await this.get(owner, attemptId))) return undefined;
    const response = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: key(`ATTEMPT#${attemptId}`, `STATE#${stateId}`),
        ConsistentRead: true,
      }),
    );
    return response.Item ? unmarshall(response.Item).snapshot : undefined;
  }

  public async getCalls(owner: string, attemptId: string): Promise<CallRecord[]> {
    if (!(await this.get(owner, attemptId))) return [];
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: marshall({ ':pk': `ATTEMPT#${attemptId}`, ':prefix': 'CALL#' }),
        ScanIndexForward: true,
        ConsistentRead: true,
      }),
    );
    return (response.Items ?? []).map((item) => {
      const call = unmarshall(item) as unknown as CallRecord;
      return {
        ...call,
        usage: {
          ...call.usage,
          reasoningTokens:
            typeof call.usage.reasoningTokens === 'number' ? call.usage.reasoningTokens : null,
        },
      };
    });
  }

  public async recoverBodies(owner: string, attemptId: string): Promise<void> {
    const bodyStore = this.bodyStore;
    if (!bodyStore) return;
    const initial = await this.get(owner, attemptId);
    if (!initial || initial.status === 'pending' || initial.status === 'running') return;
    const calls = await this.getCalls(owner, attemptId);
    for (const call of calls) {
      if (
        call.responseSha256 &&
        call.usage.inputTokens !== null &&
        call.usage.outputTokens !== null &&
        call.usage.gameTokens !== null
      )
        continue;
      if (!call.responseKey) continue;
      const body = await bodyStore.get(call.responseKey);
      if (!body) continue;
      const digest = sha256(body);
      let status = call.status;
      let usage = call.usage;
      try {
        JSON.parse(new TextDecoder().decode(body));
        const normalized = usageFromBedrockResponseBytes(body).normalized;
        usage = {
          inputTokens: normalized.inputTokens,
          outputTokens: normalized.outputTokens,
          reasoningTokens: normalized.reasoningTokens,
          gameTokens: normalized.gameTokens,
          cacheReadTokens: normalized.cacheReadTokens,
          cacheWriteTokens: normalized.cacheWriteTokens,
        };
        status = call.status === 'started' ? 'received' : call.status;
      } catch {
        status = 'unknown';
      }
      await this.client
        .send(
          new UpdateItemCommand({
            TableName: this.tableName,
            Key: key(`ATTEMPT#${attemptId}`, `CALL#${String(call.seq).padStart(8, '0')}`),
            UpdateExpression:
              'SET #status = :status, #responseSha256 = :sha, #responseBytes = :bytes, #usage = :usage, #updatedAt = :updatedAt',
            ConditionExpression:
              '#status = :statusBefore AND (attribute_not_exists(#responseSha256) OR #responseSha256 = :sha)',
            ExpressionAttributeNames: {
              '#status': 'status',
              '#responseSha256': 'responseSha256',
              '#responseBytes': 'responseBytes',
              '#usage': 'usage',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: marshall({
              ':status': status,
              ':statusBefore': call.status,
              ':sha': digest,
              ':bytes': body.byteLength,
              ':usage': usage,
              ':updatedAt': this.now().toISOString(),
            }),
          }),
        )
        .catch((error: unknown) => {
          if (!isConditional(error) && !isTransactionConflict(error)) throw error;
        });
    }
    const current = await this.get(owner, attemptId);
    const recoveredCalls = await this.getCalls(owner, attemptId);
    if (!current || recoveredCalls.length === 0) return;
    // A normal poll can observe the durable CALL between beginCall and the
    // response audit. Keep the header's prior integrity while that call is
    // still active; terminal closure will classify an unresolved call as
    // incomplete after its deadline.
    if (current.status === 'running' && recoveredCalls.some((item) => item.status === 'started'))
      return;
    const finished = recoveredCalls.filter((item) => item.status !== 'started');
    const known =
      finished.length === recoveredCalls.length &&
      finished.every((item) => item.status !== 'unknown' && item.responseSha256 !== undefined);
    const sum = (field: keyof Usage): number | null =>
      known &&
      finished.length > 0 &&
      finished.every((item) => typeof item.usage[field] === 'number')
        ? finished.reduce((total, item) => total + (item.usage[field] as number), 0)
        : null;
    const currentStateId =
      typeof current.currentSnapshot === 'object' &&
      current.currentSnapshot !== null &&
      'id' in current.currentSnapshot
        ? (current.currentSnapshot as { id: string }).id
        : 'state-0';
    await this.client
      .send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: key(`USER#${owner}`, `ATTEMPT#${attemptId}`),
          UpdateExpression:
            'SET #calls = :calls, #input = :input, #output = :output, #reasoning = :reasoning, #game = :game, #cacheRead = :cacheRead, #cacheWrite = :cacheWrite, #complete = :complete, #updatedAt = :updatedAt',
          ExpressionAttributeNames: {
            '#calls': 'calls',
            '#input': 'inputTokens',
            '#output': 'outputTokens',
            '#reasoning': 'reasoningTokens',
            '#game': 'gameTokens',
            '#cacheRead': 'cacheReadTokens',
            '#cacheWrite': 'cacheWriteTokens',
            '#complete': 'recordComplete',
            '#updatedAt': 'updatedAt',
            '#nextCall': 'nextCall',
            '#sequence': 'sequence',
            '#currentStateId': 'currentStateId',
          },
          ConditionExpression:
            '#nextCall = :nextCall AND #sequence = :sequence AND #currentStateId = :currentStateId AND #calls = :callsBefore AND #input = :inputBefore AND #output = :outputBefore AND (attribute_not_exists(#reasoning) OR #reasoning = :reasoningBefore) AND #game = :gameBefore AND #cacheRead = :cacheReadBefore AND #cacheWrite = :cacheWriteBefore AND #complete = :completeBefore',
          ExpressionAttributeValues: marshall({
            ':calls': recoveredCalls.length,
            ':input': sum('inputTokens'),
            ':output': sum('outputTokens'),
            ':reasoning': sum('reasoningTokens'),
            ':game': sum('gameTokens'),
            ':cacheRead': sum('cacheReadTokens'),
            ':cacheWrite': sum('cacheWriteTokens'),
            ':complete': known,
            ':updatedAt': this.now().toISOString(),
            ':nextCall': current.nextCall,
            ':sequence': current.sequence,
            ':currentStateId': currentStateId,
            ':callsBefore': current.calls,
            ':inputBefore': current.inputTokens,
            ':outputBefore': current.outputTokens,
            ':reasoningBefore': current.reasoningTokens,
            ':gameBefore': current.gameTokens,
            ':cacheReadBefore': current.cacheReadTokens,
            ':cacheWriteBefore': current.cacheWriteTokens,
            ':completeBefore': current.recordComplete,
          }),
        }),
      )
      .catch((error: unknown) => {
        if (!isConditional(error) && !isTransactionConflict(error)) throw error;
      });
  }

  private async findCall(
    owner: string,
    attemptId: string,
    seq: number,
  ): Promise<CallRecord | undefined> {
    return (await this.getCalls(owner, attemptId)).find((item) => item.seq === seq);
  }

  private async committedPublication(
    owner: string,
    attemptId: string,
    publication: ActionPublication,
    current: PersistedAttempt,
  ): Promise<PersistedAttempt | undefined> {
    if (
      current.sequence !== publication.seq ||
      (current.currentSnapshot as { id?: unknown })?.id !== publication.afterStateId
    )
      return undefined;
    const [actionResult, stateResult] = await Promise.all([
      this.client.send(
        new GetItemCommand({
          TableName: this.tableName,
          Key: key(`ATTEMPT#${attemptId}`, `ACTION#${String(publication.seq).padStart(8, '0')}`),
          ConsistentRead: true,
        }),
      ),
      this.client.send(
        new GetItemCommand({
          TableName: this.tableName,
          Key: key(`ATTEMPT#${attemptId}`, `STATE#${publication.afterStateId}`),
          ConsistentRead: true,
        }),
      ),
    ]);
    if (!actionResult.Item || !stateResult.Item) return undefined;
    const action = unmarshall(actionResult.Item);
    const state = unmarshall(stateResult.Item);
    const sameAction =
      action.seq === publication.seq &&
      action.decisionId === publication.decisionId &&
      action.beforeStateId === publication.beforeStateId &&
      action.afterStateId === publication.afterStateId &&
      stableJson(action.action) === stableJson(publication.action) &&
      stableJson(action.resolution) === stableJson(publication.resolution) &&
      action.terminalStatus === publication.terminalStatus &&
      action.reason === publication.reason &&
      action.progress === publication.progress &&
      action.finalSupport === publication.finalSupport &&
      action.turnsUsed === publication.turnsUsed;
    const sameState =
      state.stateId === publication.afterStateId &&
      stableJson(state.snapshot) === stableJson(publication.afterSnapshot);
    return sameAction && sameState ? current : undefined;
  }

  private async queryAttemptItems(
    attemptId: string,
    prefix: 'ACTION#' | 'STATE#',
  ): Promise<Record<string, AttributeValue>[]> {
    const rows: Record<string, AttributeValue>[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const response = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: marshall({ ':pk': `ATTEMPT#${attemptId}`, ':prefix': prefix }),
          ExclusiveStartKey: exclusiveStartKey,
          ScanIndexForward: true,
          ConsistentRead: true,
        }),
      );
      rows.push(...(response.Items ?? []));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return rows;
  }

  private encodeCursor(owner: string, keyValue: Record<string, AttributeValue>): string {
    return Buffer.from(JSON.stringify({ owner, key: keyValue }), 'utf8').toString('base64url');
  }
  private decodeCursor(cursor: string, owner: string): Record<string, AttributeValue> {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
        owner?: unknown;
        key?: Record<string, AttributeValue>;
      };
      if (parsed.owner !== owner || !parsed.key?.PK || !parsed.key.SK)
        throw new Error('invalid cursor');
      return parsed.key;
    } catch (error) {
      throw new AttemptStoreError('El cursor no es válido.', { cause: error });
    }
  }
}

export const createDynamoAttemptStore = (
  options: DynamoAttemptStoreOptions = {},
): DynamoAttemptStore => new DynamoAttemptStore(options);

export class S3BodyStore implements BodyStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  public constructor(options: { client?: S3Client; bucket?: string } = {}) {
    this.client = options.client ?? new S3Client({});
    this.bucket = options.bucket ?? process.env.ATTEMPT_BODIES_BUCKET ?? '';
    if (!this.bucket) throw new AttemptStoreError('Falta ATTEMPT_BODIES_BUCKET.');
  }

  public async put(keyValue: string, body: Uint8Array): Promise<{ sha256: string; bytes: number }> {
    const digest = sha256(body);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: keyValue,
          Body: body,
          ContentType: 'application/json',
          ChecksumSHA256: Buffer.from(digest, 'hex').toString('base64'),
          IfNoneMatch: '*',
        }),
      );
    } catch (error) {
      if (error instanceof Error && (error.name === 'PreconditionFailed' || error.name === '412')) {
        const existing = await this.get(keyValue);
        if (!existing || sha256(existing) !== digest)
          throw new AttemptStoreError('El cuerpo inmutable no coincide con el objeto existente.', {
            cause: error,
          });
      } else throw new AttemptStoreError('No se pudo guardar el cuerpo privado.', { cause: error });
    }
    return { sha256: digest, bytes: body.byteLength };
  }

  public async get(keyValue: string): Promise<Uint8Array | undefined> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: keyValue }),
      );
      if (!result.Body) return undefined;
      return new Uint8Array(await result.Body.transformToByteArray());
    } catch (error) {
      if (error instanceof Error && (error.name === 'NoSuchKey' || error.name === 'NotFound'))
        return undefined;
      throw new AttemptStoreError('No se pudo leer el cuerpo privado.', { cause: error });
    }
  }
}

export type MemoryAttemptStoreOptions = {
  readonly now?: () => Date;
  readonly quotaLimit?: number;
  readonly draft?: DraftSnapshot;
};

/** A deterministic store used by the API and Runtime tests. It mirrors the service conditions. */
export class MemoryAttemptStore implements AttemptStore {
  private readonly records = new Map<string, PersistedAttempt>();
  private readonly requests = new Map<string, { fingerprint: string; attemptId: string }>();
  private readonly calls = new Map<string, CallRecord[]>();
  private readonly actions = new Map<string, unknown[]>();
  private readonly snapshots = new Map<string, Map<string, unknown>>();
  private readonly quotaUsed = new Map<string, number>();
  private readonly animationPreferences = new Map<string, AnimationPreference>();
  private readonly now: () => Date;
  private readonly quotaLimit: number;
  private draftSnapshot: DraftSnapshot;

  public constructor(options: MemoryAttemptStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.quotaLimit = options.quotaLimit ?? DEFAULT_QUOTA;
    this.draftSnapshot = options.draft ?? { version: 0, draft: createDefaultDraft() };
  }

  public setDraft(snapshot: DraftSnapshot): void {
    this.draftSnapshot = clone(snapshot);
  }

  public async admit(input: AdmitInput): Promise<AdmitResult> {
    const requestMapKey = `${input.owner}\u0000${input.requestKey}`;
    const animationEnabled = input.animationEnabled === true;
    const fingerprint = fingerprintOf(input.draft, animationEnabled);
    const existing = this.requests.get(requestMapKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new IdempotencyConflictError();
      const record = this.records.get(existing.attemptId);
      if (!record) throw new AttemptStoreError('La admisión existe sin su cabecera.');
      return { attempt: summaryOf(clone(record)), admitted: false };
    }
    if (
      input.expectedVersion !== this.draftSnapshot.version ||
      !draftsEqual(input.draft, this.draftSnapshot.draft)
    ) {
      throw new AdmissionConflictError();
    }
    const enabled = input.draft.skills.filter((skill) => skill.enabled);
    if (enabled.length === 0)
      throw new AdmissionConflictError('Seleccioná al menos una habilidad.');

    const config = configForAdmission(input.draft, input.config);
    const nowDate = input.now ? new Date(input.now) : this.now();
    const now = nowDate.toISOString();
    const day = calendarDay(nowDate);
    const used = this.quotaUsed.get(`${input.owner}\u0000${day}`) ?? 0;
    if (used >= this.quotaLimit) throw new QuotaExceededError(day, used, this.quotaLimit);

    const id = `${now.replace(/[-:.TZ]/gu, '').slice(0, 14)}-${randomUUID()}`;
    const initial = initialSnapshot(config.levelDefinition);
    const record: PersistedAttempt = {
      recordVersion: ATTEMPT_RECORD_VERSION,
      ...summaryOf({
        recordVersion: ATTEMPT_RECORD_VERSION,
        id,
        createdAt: now,
        updatedAt: now,
        status: 'pending',
        cancelRequested: false,
        levelId: config.levelId,
        modelKey: config.model.key,
        modelLabel: config.model.label,
        modelId: config.model.modelId,
        turnsUsed: 0,
        maxTurns: config.maxTurns,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        gameTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        score: null,
        progress: 0,
        finalSupport: 0,
        animationEnabled,
        presentationComplete: !animationEnabled,
        recordComplete: true,
        requestKey: input.requestKey,
        owner: input.owner,
        draft: input.draft,
        instructions: input.draft.instructions,
        skills: skillsFor(input.draft),
        config,
        initialSnapshot: initial,
        currentSnapshot: initial,
        sequence: 0,
        nextCall: 1,
        startDeadline: new Date(nowDate.getTime() + config.startTimeoutMs).toISOString(),
        sessionId: `attempt-${id}`,
      } as PersistedAttempt),
      owner: input.owner,
      requestKey: input.requestKey,
      draft: clone(input.draft),
      instructions: input.draft.instructions,
      skills: skillsFor(input.draft),
      config,
      initialSnapshot: clone(initial),
      currentSnapshot: clone(initial),
      sequence: 0,
      nextCall: 1,
      startDeadline: new Date(nowDate.getTime() + config.startTimeoutMs).toISOString(),
      sessionId: `attempt-${id}`,
    };
    this.records.set(id, record);
    this.requests.set(requestMapKey, { fingerprint, attemptId: id });
    this.quotaUsed.set(`${input.owner}\u0000${day}`, used + 1);
    this.snapshots.set(id, new Map([['state-0', clone(initial)]]));
    this.actions.set(id, []);
    return { attempt: summaryOf(clone(record)), admitted: true };
  }

  public async get(owner: string, attemptId: string): Promise<PersistedAttempt | undefined> {
    const record = this.records.get(attemptId);
    return record?.owner === owner ? clone(record) : undefined;
  }

  public async getAnimationPreference(owner: string): Promise<AnimationPreference> {
    return clone(this.animationPreferences.get(owner) ?? { animationEnabled: true, version: 0 });
  }

  public async putAnimationPreference(
    owner: string,
    animationEnabled: boolean,
    expectedVersion: number,
  ): Promise<AnimationPreference> {
    const current = this.animationPreferences.get(owner) ?? { animationEnabled: true, version: 0 };
    if (current.version !== expectedVersion) throw new AnimationPreferenceConflictError(current);
    const next = { animationEnabled, version: expectedVersion + 1 };
    this.animationPreferences.set(owner, next);
    return clone(next);
  }

  public async getReplayRecord(
    owner: string,
    attemptId: string,
  ): Promise<ReplayRecordView | undefined> {
    const attempt = await this.get(owner, attemptId);
    if (!attempt) return undefined;
    if (!terminalAttempt(attempt) || !attempt.recordComplete) throw new ReplayRecordError();
    const snapshots = this.snapshots.get(attemptId);
    return replayRecordViewOf(
      attempt,
      clone(this.actions.get(attemptId) ?? []),
      [...(snapshots ?? new Map())].map(([stateId, snapshot]) => ({
        stateId,
        snapshot: clone(snapshot),
      })),
    );
  }

  public async markPresentationComplete(
    owner: string,
    attemptId: string,
  ): Promise<PersistedAttempt | undefined> {
    const record = this.owned(attemptId, owner);
    if (!record) return undefined;
    if (!terminalAttempt(record)) throw new AttemptNotTerminalError();
    if (record.presentationComplete) return clone(record);
    this.replace(record, { presentationComplete: true, updatedAt: this.now().toISOString() });
    return clone(this.records.get(attemptId)!);
  }

  public async getByRequest(
    owner: string,
    requestKey: string,
  ): Promise<PersistedAttempt | undefined> {
    const ref = this.requests.get(`${owner}\u0000${requestKey}`);
    return ref ? this.get(owner, ref.attemptId) : undefined;
  }

  public async list(
    owner: string,
    cursor?: string,
    limit = 20,
  ): Promise<{
    attempts: import('../../../shared/server/attempt.js').AttemptSummary[];
    nextCursor?: string;
  }> {
    const offset = cursor ? this.decodeCursor(cursor, owner) : 0;
    const values = [...this.records.values()]
      .filter((record) => record.owner === owner)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const page = values.slice(offset, offset + Math.min(limit, 20));
    return {
      attempts: page.map((record) => summaryOf(clone(record))),
      ...(offset + page.length < values.length
        ? { nextCursor: this.encodeCursor(owner, offset + page.length) }
        : {}),
    };
  }

  public async quota(
    owner: string,
  ): Promise<{ day: string; used: number; limit: number; remaining: number; resetsAt: string }> {
    const now = this.now();
    const day = calendarDay(now);
    const used = this.quotaUsed.get(`${owner}\u0000${day}`) ?? 0;
    return {
      day,
      used,
      limit: this.quotaLimit,
      remaining: Math.max(0, this.quotaLimit - used),
      resetsAt: nextReset(now),
    };
  }

  public async claim(
    owner: string,
    attemptId: string,
    executorId: string,
    now = this.now().toISOString(),
  ): Promise<PersistedAttempt | undefined> {
    const record = this.owned(attemptId, owner);
    if (!record) return undefined;
    if (record.status !== 'pending')
      return record.status === 'running' && record.executorId === executorId
        ? clone(record)
        : undefined;
    if (
      record.cancelRequested ||
      new Date(now).getTime() > new Date(record.startDeadline).getTime()
    )
      return undefined;
    const executionDeadline = new Date(
      new Date(now).getTime() + record.config.runtimeLifetimeMs,
    ).toISOString();
    const runtimeDeadline = new Date(
      new Date(executionDeadline).getTime() + record.config.terminationMarginMs,
    ).toISOString();
    this.replace(record, {
      status: 'running',
      executorId,
      claimedAt: now,
      executionDeadline,
      runtimeDeadline,
      updatedAt: now,
    });
    return clone(this.records.get(attemptId)!);
  }

  public async requestCancel(
    owner: string,
    attemptId: string,
    now = this.now().toISOString(),
  ): Promise<PersistedAttempt | undefined> {
    const record = this.owned(attemptId, owner);
    if (!record) return undefined;
    if (record.status === 'pending') {
      this.replace(record, {
        status: 'cancelled',
        reason: 'cancelled_before_start',
        updatedAt: now,
        cancelRequested: true,
        presentationComplete: true,
      });
      return clone(this.records.get(attemptId)!);
    }
    if (record.status === 'running') {
      this.replace(record, { cancelRequested: true, updatedAt: now });
      return clone(this.records.get(attemptId)!);
    }
    return clone(record);
  }

  public async beginCall(
    owner: string,
    attemptId: string,
    executorId: string,
    call: CallRecord,
  ): Promise<CallRecord | undefined> {
    const record = this.owned(attemptId, owner);
    if (
      !record ||
      record.status !== 'running' ||
      record.executorId !== executorId ||
      record.cancelRequested ||
      call.seq !== record.nextCall
    )
      return undefined;
    const existing = this.calls.get(attemptId)?.find((item) => item.seq === call.seq);
    if (existing) return clone(existing);
    const auditedCall: CallRecord = {
      ...call,
      modelKey: record.config.model.key,
      modelId: record.config.model.modelId,
      region: record.config.model.region,
      profileVersion: record.config.model.profileVersion,
    };
    this.calls.set(attemptId, [...(this.calls.get(attemptId) ?? []), clone(auditedCall)]);
    this.replace(record, { nextCall: record.nextCall + 1, updatedAt: auditedCall.createdAt });
    return clone(auditedCall);
  }

  public async finishCall(
    owner: string,
    attemptId: string,
    executorId: string,
    call: CallRecord,
  ): Promise<CallRecord | undefined> {
    const record = this.owned(attemptId, owner);
    if (!record || record.executorId !== executorId) return undefined;
    const items = this.calls.get(attemptId) ?? [];
    const index = items.findIndex((item) => item.seq === call.seq);
    if (index < 0) return undefined;
    const existing = items[index];
    if (
      existing.requestKey !== call.requestKey ||
      existing.responseKey !== call.responseKey ||
      (existing.responseSha256 !== undefined && existing.responseSha256 !== call.responseSha256)
    )
      return undefined;
    const effectiveCall: CallRecord = {
      ...call,
      modelKey: record.config.model.key,
      modelId: record.config.model.modelId,
      region: record.config.model.region,
      profileVersion: record.config.model.profileVersion,
    };
    const legalStatus =
      existing.status === 'started' ||
      existing.status === effectiveCall.status ||
      (existing.status === 'received' &&
        (effectiveCall.status === 'invalid' || effectiveCall.status === 'error'));
    if (!legalStatus) return clone(existing);
    items[index] = clone(effectiveCall);
    this.calls.set(attemptId, items);
    const completed = items.filter((item) => item.status !== 'started');
    const allCallsComplete = completed.length === items.length;
    const sum = (field: keyof Usage): number | null =>
      allCallsComplete &&
      completed.length > 0 &&
      completed.every((item) => typeof item.usage[field] === 'number')
        ? completed.reduce((total, item) => total + (item.usage[field] as number), 0)
        : null;
    const previous = this.records.get(attemptId)!;
    this.replace(previous, {
      calls: Math.max(previous.calls, items.length),
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      reasoningTokens: sum('reasoningTokens'),
      gameTokens: sum('gameTokens'),
      cacheReadTokens: completed.every((item) => typeof item.usage.cacheReadTokens === 'number')
        ? sum('cacheReadTokens')
        : null,
      cacheWriteTokens: completed.every((item) => typeof item.usage.cacheWriteTokens === 'number')
        ? sum('cacheWriteTokens')
        : null,
      recordComplete:
        allCallsComplete &&
        completed.every((item) => item.status !== 'unknown' && item.responseSha256 !== undefined),
      updatedAt: effectiveCall.updatedAt,
    });
    return clone(effectiveCall);
  }

  public async publishAction(
    owner: string,
    attemptId: string,
    executorId: string,
    publication: ActionPublication,
  ): Promise<PersistedAttempt | undefined> {
    const record = this.owned(attemptId, owner);
    if (
      !record ||
      record.status !== 'running' ||
      record.executorId !== executorId ||
      record.cancelRequested ||
      publication.seq !== record.sequence + 1 ||
      (record.currentSnapshot as { id?: unknown })?.id !== publication.beforeStateId
    )
      return undefined;
    const snapshots = this.snapshots.get(attemptId) ?? new Map<string, unknown>();
    if (snapshots.has(publication.afterStateId)) return clone(record);
    snapshots.set(publication.afterStateId, clone(publication.afterSnapshot));
    this.snapshots.set(attemptId, snapshots);
    const actionItems = this.actions.get(attemptId) ?? [];
    actionItems.push({
      seq: publication.seq,
      decisionId: publication.decisionId,
      beforeStateId: publication.beforeStateId,
      afterStateId: publication.afterStateId,
      action: clone(publication.action),
      resolution: clone(publication.resolution),
    });
    this.actions.set(attemptId, actionItems);
    const changes: Record<string, unknown> = {
      sequence: publication.seq,
      currentSnapshot: clone(publication.afterSnapshot),
      turnsUsed: publication.turnsUsed,
      progress: publication.progress,
      finalSupport: publication.finalSupport,
      updatedAt: this.now().toISOString(),
    };
    if (publication.terminalStatus) {
      changes.status = publication.terminalStatus;
      changes.reason = publication.reason;
      changes.presentationComplete = !record.animationEnabled;
      const current = this.records.get(attemptId)!;
      const params = current.config.scoreParameters;
      changes.score = scoreAttempt(
        {
          status: publication.terminalStatus,
          turnsUsed: publication.turnsUsed,
          collectedObjectIds: [],
          gameTokens: current.gameTokens,
        },
        {
          base: params.base ?? 1000,
          turnWeight: params.turnWeight ?? 10,
          tokenWeight: params.tokenWeight ?? 1,
          tokenUnit: params.tokenUnit ?? 1000,
          decimalPlaces: params.decimals ?? 2,
          allowNegative: params.allowNegative !== 0,
          objectValues: {},
        },
      );
    }
    this.replace(record, changes as Partial<PersistedAttempt>);
    return clone(this.records.get(attemptId)!);
  }

  public async close(
    owner: string,
    attemptId: string,
    terminalStatus: 'cancelled' | 'error',
    reason: string,
    executorId?: string,
    now = this.now().toISOString(),
  ): Promise<PersistedAttempt | undefined> {
    const record = this.owned(attemptId, owner);
    if (!record) return undefined;
    if (record.status !== 'pending' && record.status !== 'running') return clone(record);
    if (executorId !== undefined && record.executorId !== executorId) return undefined;
    const durableCalls = this.calls.get(attemptId) ?? [];
    const durableComplete =
      record.recordComplete &&
      durableCalls.every((call) => call.status !== 'started' && call.status !== 'unknown');
    this.replace(record, {
      status: terminalStatus,
      reason,
      presentationComplete: !record.animationEnabled || record.sequence === 0,
      updatedAt: now,
      calls: Math.max(record.calls, durableCalls.length),
      inputTokens: durableComplete ? record.inputTokens : null,
      outputTokens: durableComplete ? record.outputTokens : null,
      reasoningTokens: durableComplete ? record.reasoningTokens : null,
      gameTokens: durableComplete ? record.gameTokens : null,
      cacheReadTokens: durableComplete ? record.cacheReadTokens : null,
      cacheWriteTokens: durableComplete ? record.cacheWriteTokens : null,
      recordComplete:
        record.recordComplete &&
        durableCalls.every((call) => call.status !== 'started' && call.status !== 'unknown'),
    });
    return clone(this.records.get(attemptId)!);
  }

  public async closeExpired(
    owner: string,
    attemptId: string,
    now = this.now().toISOString(),
  ): Promise<PersistedAttempt | undefined> {
    const record = this.owned(attemptId, owner);
    if (!record) return undefined;
    const current = new Date(now).getTime();
    if (record.status === 'pending' && current > new Date(record.startDeadline).getTime()) {
      return this.close(owner, attemptId, 'error', 'start_deadline_expired', undefined, now);
    }
    if (
      record.status === 'running' &&
      record.runtimeDeadline &&
      current > new Date(record.runtimeDeadline).getTime()
    ) {
      return this.close(
        owner,
        attemptId,
        'error',
        'runtime_deadline_expired',
        record.executorId,
        now,
      );
    }
    return clone(record);
  }

  public async getSnapshot(
    owner: string,
    attemptId: string,
    stateId?: string,
  ): Promise<unknown | undefined> {
    const record = this.owned(attemptId, owner);
    if (!record) return undefined;
    const snapshots = this.snapshots.get(attemptId);
    return clone(snapshots?.get(stateId ?? 'state-0'));
  }

  public async getCalls(owner: string, attemptId: string): Promise<CallRecord[]> {
    return this.owned(attemptId, owner) ? clone(this.calls.get(attemptId) ?? []) : [];
  }

  public async recoverBodies(): Promise<void> {
    // MemoryBodyStore metadata is committed with the test call record; production
    // Dynamo metadata recovery is implemented below.
  }

  private owned(attemptId: string, owner: string): PersistedAttempt | undefined {
    const record = this.records.get(attemptId);
    return record?.owner === owner ? record : undefined;
  }

  private replace(record: PersistedAttempt, changes: Partial<PersistedAttempt>): void {
    this.records.set(record.id, { ...record, ...changes } as PersistedAttempt);
  }

  private encodeCursor(owner: string, offset: number): string {
    return Buffer.from(JSON.stringify({ owner, offset }), 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string, owner: string): number {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
        owner?: unknown;
        offset?: unknown;
      };
      if (
        parsed.owner !== owner ||
        typeof parsed.offset !== 'number' ||
        !Number.isSafeInteger(parsed.offset) ||
        parsed.offset < 0
      )
        throw new Error('invalid cursor');
      return parsed.offset;
    } catch (error) {
      throw new AttemptStoreError('El cursor no es válido.', { cause: error });
    }
  }
}

export const createMemoryAttemptStore = (
  options: MemoryAttemptStoreOptions = {},
): MemoryAttemptStore => new MemoryAttemptStore(options);

/** Immutable S3 body adapter; retries are allowed only when the bytes match. */
export class MemoryBodyStore implements BodyStore {
  private readonly bodies = new Map<string, { body: Uint8Array; sha256: string }>();

  public async put(key: string, body: Uint8Array): Promise<{ sha256: string; bytes: number }> {
    const bytes = new Uint8Array(body);
    const digest = sha256(bytes);
    const existing = this.bodies.get(key);
    if (
      existing &&
      (existing.sha256 !== digest ||
        existing.body.length !== bytes.length ||
        !existing.body.every((value, index) => value === bytes[index]))
    ) {
      throw new AttemptStoreError('El cuerpo inmutable no coincide con el objeto existente.');
    }
    this.bodies.set(key, { body: bytes, sha256: digest });
    return { sha256: digest, bytes: bytes.byteLength };
  }

  public async get(key: string): Promise<Uint8Array | undefined> {
    const body = this.bodies.get(key);
    return body ? new Uint8Array(body.body) : undefined;
  }
}
