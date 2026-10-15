import { useEffect, useRef, useState } from 'react';
import type {
  MetricPeriods,
  MetricValue,
  MonitoringSnapshot,
  MonitoringUser,
} from '../../../shared/monitoring.js';

type LoadState =
  { status: 'loading' } | { status: 'error' } | { status: 'success'; snapshot: MonitoringSnapshot };

type SortKey = 'email' | 'registeredAt' | 'lastActiveAt' | 'hours24' | 'days3' | 'days7';
type SortState = { key: SortKey; direction: 'ascending' | 'descending' } | null;

const windows = [
  { key: 'hours24', label: '24 horas' },
  { key: 'days3', label: '3 días' },
  { key: 'days7', label: '7 días' },
] as const;

const countFormat = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const usdFormat = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'USD',
  currencyDisplay: 'code',
  maximumFractionDigits: 2,
});
const argentinaDateFormat = new Intl.DateTimeFormat('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires',
  dateStyle: 'short',
  timeStyle: 'short',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMetricValue(value: unknown): value is MetricValue {
  return value === 'N/A' || (typeof value === 'number' && Number.isFinite(value));
}

function isPeriods(value: unknown): value is MetricPeriods {
  return (
    isRecord(value) &&
    isMetricValue(value.hours24) &&
    isMetricValue(value.days3) &&
    isMetricValue(value.days7)
  );
}

function isDateOrUnavailable(value: unknown): value is string {
  return (
    value === 'N/A' ||
    (typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value)))
  );
}

function isMonitoringUser(value: unknown): value is MonitoringUser {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.email === 'string' &&
    value.email.length > 0 &&
    isDateOrUnavailable(value.registeredAt) &&
    isDateOrUnavailable(value.lastActiveAt) &&
    isPeriods(value.bedrockCostUsd)
  );
}

function isMonitoringSnapshot(value: unknown): value is MonitoringSnapshot {
  return (
    isRecord(value) &&
    isDateOrUnavailable(value.asOf) &&
    value.asOf !== 'N/A' &&
    isDateOrUnavailable(value.generatedAt) &&
    value.generatedAt !== 'N/A' &&
    isMetricValue(value.registeredUsers) &&
    isPeriods(value.newUsers) &&
    isPeriods(value.activeUsers) &&
    isPeriods(value.bedrockCostUsd) &&
    Array.isArray(value.users) &&
    value.users.every(isMonitoringUser)
  );
}

async function fetchMonitoringSnapshot(): Promise<MonitoringSnapshot> {
  const response = await fetch('/api/metrics', {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error('metrics request failed');
  }

  const body: unknown = await response.json();
  if (!isMonitoringSnapshot(body)) {
    throw new Error('metrics response was invalid');
  }
  return body;
}

function formatMetric(value: MetricValue, money = false): string {
  if (value === 'N/A') {
    return value;
  }
  return money ? usdFormat.format(value) : countFormat.format(value);
}

function formatDate(value: string): string {
  if (value === 'N/A') {
    return value;
  }
  return argentinaDateFormat.format(new Date(value));
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'es-AR', { sensitivity: 'base' });
}

function compareMetric(
  left: MetricValue | string,
  right: MetricValue | string,
  key: SortKey,
): number {
  const leftUnavailable = left === 'N/A';
  const rightUnavailable = right === 'N/A';

  if (leftUnavailable || rightUnavailable) {
    if (leftUnavailable && rightUnavailable) {
      return 0;
    }
    return leftUnavailable ? 1 : -1;
  }

  if (key === 'registeredAt' || key === 'lastActiveAt') {
    return Date.parse(left as string) - Date.parse(right as string);
  }
  if (key === 'email') {
    return compareText(String(left), String(right));
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }
  return compareText(String(left), String(right));
}

function sortUsers(users: MonitoringUser[], sort: SortState): MonitoringUser[] {
  if (!sort) {
    return users;
  }

  const direction = sort.direction === 'ascending' ? 1 : -1;
  return [...users].sort((left, right) => {
    const leftValue =
      sort.key === 'email'
        ? left.email
        : sort.key === 'registeredAt' || sort.key === 'lastActiveAt'
          ? left[sort.key]
          : left.bedrockCostUsd[sort.key];
    const rightValue =
      sort.key === 'email'
        ? right.email
        : sort.key === 'registeredAt' || sort.key === 'lastActiveAt'
          ? right[sort.key]
          : right.bedrockCostUsd[sort.key];
    const compared = compareMetric(leftValue, rightValue, sort.key);

    if (compared !== 0) {
      const unavailable = leftValue === 'N/A' || rightValue === 'N/A';
      return unavailable ? compared : compared * direction;
    }

    const emailTie = compareText(left.email, right.email);
    return emailTie === 0 ? left.id.localeCompare(right.id, 'en') : emailTie;
  });
}

function SummaryCard({
  title,
  periods,
  money = false,
}: {
  title: string;
  periods: MetricPeriods;
  money?: boolean;
}) {
  return (
    <section className="summary-card" aria-label={title}>
      <h2>{title}</h2>
      <dl className="summary-periods">
        {windows.map(({ key, label }) => (
          <div className="summary-period" key={key}>
            <dt>{label}</dt>
            <dd>{formatMetric(periods[key], money)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
}) {
  const active = sort?.key === sortKey;
  return (
    <th scope="col" aria-sort={active ? sort.direction : 'none'}>
      <button className="sort-button" type="button" onClick={() => onSort(sortKey)}>
        <span>{label}</span>
        <span className="sort-indicator" aria-hidden="true">
          {active ? (sort.direction === 'ascending' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    </th>
  );
}

function UserTable({
  users,
  sort,
  onSort,
}: {
  users: MonitoringUser[];
  sort: SortState;
  onSort: (key: SortKey) => void;
}) {
  const sortedUsers = sortUsers(users, sort);

  return (
    <div className="table-scroll" role="region" aria-label="Usuarios confirmados" tabIndex={0}>
      <table>
        <caption>Usuarios con email confirmado</caption>
        <thead>
          <tr>
            <SortHeader label="Usuario" sortKey="email" sort={sort} onSort={onSort} />
            <SortHeader label="Registro" sortKey="registeredAt" sort={sort} onSort={onSort} />
            <SortHeader label="Última sesión" sortKey="lastActiveAt" sort={sort} onSort={onSort} />
            <SortHeader
              label="Bedrock · 24 horas (USD)"
              sortKey="hours24"
              sort={sort}
              onSort={onSort}
            />
            <SortHeader
              label="Bedrock · 3 días (USD)"
              sortKey="days3"
              sort={sort}
              onSort={onSort}
            />
            <SortHeader
              label="Bedrock · 7 días (USD)"
              sortKey="days7"
              sort={sort}
              onSort={onSort}
            />
          </tr>
        </thead>
        <tbody>
          {sortedUsers.map((user) => (
            <tr key={user.id}>
              <th scope="row" className="user-cell">
                <span>{user.email}</span>{' '}
              </th>
              <td>{formatDate(user.registeredAt)}</td>
              <td>{formatDate(user.lastActiveAt)}</td>
              <td>{formatMetric(user.bedrockCostUsd.hours24, true)}</td>
              <td>{formatMetric(user.bedrockCostUsd.days3, true)}</td>
              <td>{formatMetric(user.bedrockCostUsd.days7, true)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {users.length === 0 && (
        <p className="empty-state">No hay usuarios confirmados para mostrar.</p>
      )}
    </div>
  );
}

export function App() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [sort, setSort] = useState<SortState>(null);
  const requestSequence = useRef(0);

  const changeSort = (key: SortKey) => {
    setSort((current) => ({
      key,
      direction:
        current?.key === key && current.direction === 'ascending' ? 'descending' : 'ascending',
    }));
  };

  const refreshMetrics = () => {
    const requestId = ++requestSequence.current;
    setState({ status: 'loading' });
    void fetchMonitoringSnapshot().then(
      (snapshot) => {
        if (requestId === requestSequence.current) {
          setState({ status: 'success', snapshot });
        }
      },
      () => {
        if (requestId === requestSequence.current) {
          setState({ status: 'error' });
        }
      },
    );
  };

  useEffect(() => {
    const requestId = ++requestSequence.current;
    void fetchMonitoringSnapshot().then(
      (snapshot) => {
        if (requestId === requestSequence.current) {
          setState({ status: 'success', snapshot });
        }
      },
      () => {
        if (requestId === requestSequence.current) {
          setState({ status: 'error' });
        }
      },
    );
    return () => {
      requestSequence.current += 1;
    };
  }, []);

  const loading = state.status === 'loading';
  const snapshot = state.status === 'success' ? state.snapshot : null;

  return (
    <main id="contenido" className="dashboard-shell" tabIndex={-1}>
      <a className="skip-link" href="#contenido">
        Saltar al contenido
      </a>
      <header className="dashboard-header">
        <a className="brand" href="/" aria-label="Robot Runner, monitoreo">
          <img src="/favicon.svg" alt="" width="44" height="44" />
          <span className="brand-copy">
            <span className="brand-name">Robot Runner</span>
            <span className="brand-tagline">Monitoreo privado</span>
          </span>
        </a>
        <button
          className="refresh-button"
          type="button"
          onClick={refreshMetrics}
          disabled={loading}
        >
          {loading ? 'Actualizando…' : 'Actualizar'}
        </button>
      </header>

      <section className="dashboard-content" aria-labelledby="page-title" aria-busy={loading}>
        <div className="page-heading">
          <div>
            <p className="eyebrow">Panel de operación</p>
            <h1 id="page-title">Usuarios y actividad</h1>
            <p className="intro">Cuentas registradas con email confirmado y métricas actuales.</p>
          </div>
        </div>

        {loading && (
          <p className="status-message" role="status" aria-live="polite">
            Cargando datos
          </p>
        )}

        {state.status === 'error' && (
          <p className="error-message" role="alert" aria-live="assertive">
            No se pudieron traer los datos. Volvé a intentar
          </p>
        )}

        {snapshot && (
          <>
            <p className="updated-at">
              Consulta al {formatDate(snapshot.asOf)} · Hora de Argentina (UTC−3)
            </p>
            <div className="summary-grid">
              <section className="summary-card registered-card" aria-label="Registrados">
                <h2>Registrados</h2>
                <p className="registered-value">{formatMetric(snapshot.registeredUsers)}</p>
                <p className="card-note">Email confirmado</p>
              </section>
              <SummaryCard title="Nuevos" periods={snapshot.newUsers} />
              <SummaryCard title="Activos" periods={snapshot.activeUsers} />
              <SummaryCard title="Gasto Bedrock" periods={snapshot.bedrockCostUsd} money />
            </div>
            <section className="users-section" aria-labelledby="users-title">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Inventario actual</p>
                  <h2 id="users-title">Usuarios</h2>
                </div>
                <p className="section-note">Ordená por cualquier columna para revisar los datos.</p>
              </div>
              <UserTable users={snapshot.users} sort={sort} onSort={changeSort} />
            </section>
          </>
        )}
      </section>

      <footer className="dashboard-footer">
        <span>Robot Runner</span>
        <span>Los valores no disponibles se muestran como N/A.</span>
      </footer>
    </main>
  );
}
