// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ROBOT_CATALOG,
  createDefaultDraft,
  type RobotDraft,
  type RobotSkillId,
} from '../../../shared/robot.js';
import type { AuthSession } from './auth.js';
import type { DraftApi } from './draft-api.js';
import { RobotEditor } from './RobotEditor.js';

function session(): AuthSession {
  return {
    identity: { sub: 'preparation-owner', email: 'preparation@example.test' },
    user: new User({
      access_token: 'preparation-token',
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: 'https://issuer.example.test',
        aud: 'client',
        sub: 'preparation-owner',
        iat: 1,
        exp: 9_999_999_999,
      },
      expires_at: Math.floor(Date.now() / 1000) + 600,
    }),
  };
}

function api(draft = createDefaultDraft()): DraftApi {
  return {
    getDraft: vi.fn().mockResolvedValue({ version: 0, draft }),
    putDraft: vi.fn().mockImplementation(async (version: number, value: RobotDraft) => ({
      version: version + 1,
      draft: value,
    })),
  };
}

function description(id: RobotSkillId): HTMLTextAreaElement {
  const entry = ROBOT_CATALOG.find((skill) => skill.id === id)!;
  return screen.getByLabelText(`Descripción de ${entry.name} para el agente`);
}

function disclosure(id: RobotSkillId): HTMLDetailsElement {
  const details = description(id).closest('details');
  expect(details, `La descripción de ${id} necesita su desplegable independiente`).not.toBeNull();
  return details!;
}

function setOpen(id: RobotSkillId, open: boolean): void {
  const details = disclosure(id);
  details.open = open;
  fireEvent(details, new Event('toggle'));
}

async function ready(): Promise<void> {
  await screen.findByLabelText('Qué debe tener en cuenta el robot');
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Preparar: habilidades y controles próximos', () => {
  it('opens every initially enabled description and folds disabled ones without losing their text', async () => {
    const draft = createDefaultDraft();
    const stored: RobotDraft = {
      ...draft,
      skills: draft.skills.map((skill) => ({
        ...skill,
        enabled: skill.id === 'advance' || skill.id === 'jump' || skill.id === 'collect',
        description: `Literal privado de ${skill.id}\n🦾`,
      })),
    };
    const client = api(stored);
    render(<RobotEditor api={client} session={session()} />);
    await ready();

    for (const skill of stored.skills) {
      expect(disclosure(skill.id).open).toBe(skill.enabled);
      expect(description(skill.id).value).toBe(skill.description);
      expect(description(skill.id).readOnly).toBe(false);
    }
    expect(client.putDraft).not.toHaveBeenCalled();
  });

  it('opens on OFF to ON, keeps focus on the toggle and does not close on ON to OFF', async () => {
    render(<RobotEditor api={api()} session={session()} />);
    await ready();
    const toggle = screen.getByRole('checkbox', { name: 'Saltar' }) as HTMLInputElement;
    expect(disclosure('jump').open).toBe(false);
    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    expect(disclosure('jump').open).toBe(true);
    expect(document.activeElement).toBe(toggle);

    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    expect(disclosure('jump').open).toBe(true);
    expect(document.activeElement).toBe(toggle);

    setOpen('jump', false);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    expect(disclosure('jump').open).toBe(true);
    setOpen('jump', false);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    expect(disclosure('jump').open).toBe(false);
  });

  it('keeps a manual fold across editing, confirmed saves, ordinary renders and resize', async () => {
    const client = api();
    const identity = session();
    const view = render(<RobotEditor api={client} session={identity} />);
    await ready();
    vi.useFakeTimers();
    const field = description('advance');
    setOpen('advance', false);
    fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
      target: { value: 'Nuevo literal\n👩‍💻' },
    });
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(client.putDraft).toHaveBeenCalledOnce();
    expect(screen.getByText('Guardado')).toBeTruthy();
    view.rerender(<RobotEditor api={client} session={identity} />);
    fireEvent(window, new Event('resize'));

    expect(disclosure('advance').open).toBe(false);
    expect(description('advance')).toBe(field);
    expect(screen.getByLabelText('Qué debe tener en cuenta el robot')).toHaveProperty(
      'value',
      'Nuevo literal\n👩‍💻',
    );
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(client.putDraft).toHaveBeenCalledOnce();
  });

  it('lets a disabled description open and save literally without enabling the skill', async () => {
    const client = api();
    render(<RobotEditor api={client} session={session()} />);
    await ready();
    vi.useFakeTimers();
    setOpen('wait', true);
    const literal = '  e\u0301👩‍💻\n🦾  ';
    fireEvent.change(description('wait'), { target: { value: literal } });
    await act(async () => vi.advanceTimersByTimeAsync(600));

    expect(client.putDraft).toHaveBeenCalledOnce();
    const saved = vi.mocked(client.putDraft).mock.calls[0]![1];
    expect(saved.skills.find((skill) => skill.id === 'wait')).toEqual({
      id: 'wait',
      enabled: false,
      description: literal,
    });
    expect(disclosure('wait').open).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Esperar' }) as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it('reinitializes active disclosures on a fresh page load after a manual fold', async () => {
    const client = api();
    const first = render(<RobotEditor api={client} session={session()} />);
    await ready();
    setOpen('advance', false);
    first.unmount();
    render(<RobotEditor api={client} session={session()} />);
    await ready();

    expect(disclosure('advance').open).toBe(true);
    expect(disclosure('wait').open).toBe(false);
    expect(client.putDraft).not.toHaveBeenCalled();
  });

  it('identifies a folded invalid inactive field and opens and focuses it from its error', async () => {
    const client = api();
    render(<RobotEditor api={client} session={session()} onTry={vi.fn()} />);
    await ready();
    vi.useFakeTimers();
    setOpen('retreat', true);
    const field = description('retreat');
    const invalid = '🦾'.repeat(501);
    fireEvent.change(field, { target: { value: invalid } });
    setOpen('retreat', false);

    expect(field.value).toBe(invalid);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect((screen.getByRole('button', { name: 'Probar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(client.putDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Revisar descripción de Retroceder/i }));
    expect(disclosure('retreat').open).toBe(true);
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe(invalid);

    fireEvent.change(field, { target: { value: '🦾'.repeat(500) } });
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(client.putDraft).toHaveBeenCalledOnce();
    expect(field.getAttribute('aria-invalid')).toBe('false');
    expect((screen.getByRole('checkbox', { name: 'Retroceder' }) as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it('keeps disclosures and their literal text consultable while session writes are paused', async () => {
    const client = api();
    const identity = session();
    const view = render(<RobotEditor api={client} session={identity} />);
    await ready();
    view.rerender(<RobotEditor api={client} session={identity} paused accessState="required" />);
    setOpen('wait', true);

    expect(disclosure('wait').open).toBe(true);
    expect(description('wait').readOnly).toBe(true);
    expect(description('wait').disabled).toBe(false);
    expect(client.putDraft).not.toHaveBeenCalled();
  });

  it('places the single test controls group after instructions and before all skills', async () => {
    render(<RobotEditor api={api()} session={session()} onTry={vi.fn()} />);
    await ready();
    const instructions = screen.getByLabelText('Qué debe tener en cuenta el robot');
    const controls = screen.getByRole('group', { name: 'Controles de prueba y animación' });
    expect(screen.getAllByRole('button', { name: 'Probar' })).toHaveLength(1);
    expect(instructions.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    for (const entry of ROBOT_CATALOG) {
      const toggle = screen.getByRole('checkbox', { name: entry.name });
      expect(controls.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }
  });
});
