/**
 * src/lib/auth/password/change.ts の単体テスト (#1198。設計 docs/design/cross/16-auth-history-sessions.md §13.2・§20.1)
 */
import { describe, expect, it, vi } from 'vitest';
import {
  performPasswordChange,
  type PasswordChangeDeps,
  type PasswordChangeInput,
  type PasswordCheckOutcome,
  type UpdatePasswordOutcome,
} from '../password/change';

const CHANGE: PasswordChangeInput = { userId: 'user-1', currentPassword: 'Current-1', newPassword: 'New-1', generations: 3 };
const RESET: PasswordChangeInput = { userId: 'user-1', currentPassword: null, newPassword: 'New-1', generations: 3 };

function deps(check: PasswordCheckOutcome, update: UpdatePasswordOutcome = { error: null }) {
  const checkPassword = vi.fn<PasswordChangeDeps['checkPassword']>(async () => check);
  const updatePassword = vi.fn<PasswordChangeDeps['updatePassword']>(async () => update);
  return { checkPassword, updatePassword };
}

describe('performPasswordChange', () => {
  it.each(['current_mismatch', 'reused', 'no_password', 'unsupported_hash'] as const)(
    'checkPassword が ok 以外なら updatePassword を呼ばず同じ kind を返す (%s)',
    async (outcome) => {
      const d = deps(outcome);
      await expect(performPasswordChange(CHANGE, d)).resolves.toEqual({ kind: outcome });
      expect(d.checkPassword).toHaveBeenCalledWith(CHANGE);
      expect(d.updatePassword).not.toHaveBeenCalled();
    },
  );

  it('updatePassword に newPassword と currentPassword を渡す (再設定は currentPassword が null)', async () => {
    const change = deps('ok');
    await performPasswordChange(CHANGE, change);
    expect(change.updatePassword).toHaveBeenCalledWith({ newPassword: 'New-1', currentPassword: 'Current-1' });
    const reset = deps('ok');
    await performPasswordChange(RESET, reset);
    expect(reset.updatePassword).toHaveBeenCalledWith({ newPassword: 'New-1', currentPassword: null });
  });

  it('current_password_invalid → current_mismatch', async () => {
    await expect(performPasswordChange(CHANGE, deps('ok', { error: { code: 'current_password_invalid', status: 400 } }))).resolves.toEqual({
      kind: 'current_mismatch',
    });
  });

  it('updatePassword の weak_password → weak', async () => {
    await expect(performPasswordChange(CHANGE, deps('ok', { error: { code: 'weak_password', status: 422 } }))).resolves.toEqual({ kind: 'weak' });
  });

  it('same_password → reused', async () => {
    await expect(performPasswordChange(CHANGE, deps('ok', { error: { code: 'same_password', status: 422 } }))).resolves.toEqual({ kind: 'reused' });
  });

  it('reauthentication_needed → reauthentication_required', async () => {
    await expect(performPasswordChange(CHANGE, deps('ok', { error: { code: 'reauthentication_needed', status: 400 } }))).resolves.toEqual({
      kind: 'reauthentication_required',
    });
  });

  it('その他のエラー → upstream-error に code と status', async () => {
    await expect(performPasswordChange(CHANGE, deps('ok', { error: { code: 'current_password_required', status: 400 } }))).resolves.toEqual({
      kind: 'upstream-error',
      code: 'current_password_required',
      status: 400,
    });
    await expect(performPasswordChange(CHANGE, deps('ok', { error: { code: null, status: 502 } }))).resolves.toEqual({
      kind: 'upstream-error',
      code: null,
      status: 502,
    });
  });

  it('成功 → changed', async () => {
    await expect(performPasswordChange(RESET, deps('ok'))).resolves.toEqual({ kind: 'changed' });
  });
});
