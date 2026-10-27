// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, expect, it, vi } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot.js';
import type { AuthSession } from './auth.js';
import type { DraftApi } from './draft-api.js';
import { RobotEditor } from './RobotEditor.js';

afterEach(cleanup);

it('blocks presentation controls during activity and restores them for paused-session consultation', async () => {
  const session: AuthSession = {
    identity: { sub: 'owner', email: 'owner@example.test' },
    user: new User({
      access_token: 'token',
      token_type: 'Bearer',
      profile: {
        sub: 'owner',
        iss: 'https://issuer.example.test',
        aud: 'client',
        iat: 1,
        exp: 9999999999,
      },
    }),
  };
  const api: DraftApi = {
    getDraft: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
    putDraft: vi.fn(),
  };
  const view = render(<RobotEditor api={api} session={session} />);
  const field = await screen.findByLabelText('Descripción de Retroceder para el agente');
  const description = field.closest('details')!;
  const summary = description.querySelector('summary')!;
  const helpSummary = screen.getByText('Ayuda para empezar');
  const help = helpSummary.closest('details')!;

  view.rerender(<RobotEditor api={api} session={session} locked />);
  fireEvent.click(summary);
  fireEvent.click(helpSummary);
  expect(description.open).toBe(false);
  expect(help.open).toBe(false);
  expect(summary.tabIndex).toBe(-1);
  expect(summary.getAttribute('aria-disabled')).toBe('true');

  view.rerender(<RobotEditor api={api} session={session} paused accessState="required" />);
  fireEvent.click(summary);
  fireEvent.click(helpSummary);
  expect(description.open).toBe(true);
  expect(help.open).toBe(true);
  expect(summary.tabIndex).toBe(0);
  expect(field).toHaveProperty('readOnly', true);
  expect(api.putDraft).not.toHaveBeenCalled();
});
