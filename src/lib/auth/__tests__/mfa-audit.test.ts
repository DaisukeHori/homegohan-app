/**
 * #1176 運営ロールの MFA の監査の facade のテスト。docs/design/cross/12-operator-mfa.md §17.1・§21.1 (mfa-audit.test.ts)
 * @/lib/admin/audit の recordAdminAudit を差し替え、渡す値と戻り値の扱いを確かめる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ recordAdminAudit: vi.fn() }));

vi.mock('@/lib/admin/audit', () => ({ recordAdminAudit: mocks.recordAdminAudit }));

import {
  MFA_AUDIT_ACTIONS,
  MFA_AUDIT_FAILED_STEPS,
  MFA_AUDIT_SEVERITY,
  MFA_AUDIT_TARGET_TYPE,
  recordMfaAudit,
} from '@/lib/auth/mfa/audit';

const ADMIN = { from: vi.fn() };
const REQUEST = { headers: new Headers({ 'user-agent': 'vitest' }) };
const ACTOR = 'actor-1';
const TARGET = 'target-1';

beforeEach(() => {
  mocks.recordAdminAudit.mockReset();
  mocks.recordAdminAudit.mockResolvedValue({ ok: true });
});

describe('MFA の監査', () => {
  it('MFA_AUDIT_ACTIONS は §17 の 5 つの action_type (admin.mfa.enroll / admin.mfa.backup_codes_regenerate / admin.mfa.unenroll / admin.mfa.recover / super_admin.mfa.reset)', () => {
    expect(Object.values(MFA_AUDIT_ACTIONS).sort()).toEqual([
      'admin.mfa.backup_codes_regenerate',
      'admin.mfa.enroll',
      'admin.mfa.recover',
      'admin.mfa.unenroll',
      'super_admin.mfa.reset',
    ]);
    expect(MFA_AUDIT_TARGET_TYPE).toBe('user');
  });

  it('MFA_AUDIT_SEVERITY は enroll と backup_codes_regenerate が info・unenroll と recover が warn・reset が critical', () => {
    expect(MFA_AUDIT_SEVERITY).toEqual({
      'admin.mfa.enroll': 'info',
      'admin.mfa.backup_codes_regenerate': 'info',
      'admin.mfa.unenroll': 'warn',
      'admin.mfa.recover': 'warn',
      'super_admin.mfa.reset': 'critical',
    });
  });

  it("recordMfaAudit は recordAdminAudit に supabase = admin・actorId・actionType = action・targetId = targetUserId・targetType = 'user'・severity = MFA_AUDIT_SEVERITY[action]・details・request・routeName をそのまま渡す", async () => {
    const details = { reason: '端末の紛失', identity_check: 'video_call', factors_before: 1, backup_codes_before: 8 };
    await recordMfaAudit({
      admin: ADMIN,
      actorId: ACTOR,
      targetUserId: TARGET,
      action: MFA_AUDIT_ACTIONS.reset,
      details,
      request: REQUEST,
      routeName: 'POST /api/test',
    });
    expect(mocks.recordAdminAudit).toHaveBeenCalledTimes(1);
    expect(mocks.recordAdminAudit).toHaveBeenCalledWith({
      supabase: ADMIN,
      actorId: ACTOR,
      actionType: 'super_admin.mfa.reset',
      targetId: TARGET,
      targetType: 'user',
      details,
      severity: 'critical',
      request: REQUEST,
      routeName: 'POST /api/test',
    });

    await recordMfaAudit({
      admin: ADMIN,
      actorId: ACTOR,
      targetUserId: ACTOR,
      action: MFA_AUDIT_ACTIONS.recover,
      details: { factors_deleted: 1, backup_codes_deleted: 9, failed_step: null },
      request: REQUEST,
      routeName: 'POST /api/test',
    });
    expect(mocks.recordAdminAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ actionType: 'admin.mfa.recover', severity: 'warn', targetId: ACTOR }),
    );
  });

  it('recordMfaAudit は recordAdminAudit の戻り ({ ok: true } と { ok: false, error } のどちらも) をそのまま返す', async () => {
    const input = {
      admin: ADMIN,
      actorId: ACTOR,
      targetUserId: ACTOR,
      action: MFA_AUDIT_ACTIONS.enroll,
      details: { factor_id: 'f-1', backup_codes_issued: 10, failed_step: null },
      request: REQUEST,
      routeName: 'POST /api/test',
    };
    const okResult = { ok: true as const };
    mocks.recordAdminAudit.mockResolvedValueOnce(okResult);
    await expect(recordMfaAudit(input)).resolves.toBe(okResult);
    const failure = { ok: false as const, error: 'insert failed' };
    mocks.recordAdminAudit.mockResolvedValueOnce(failure);
    await expect(recordMfaAudit(input)).resolves.toBe(failure);
  });

  it('MFA_AUDIT_FAILED_STEPS は §17.2 の 5 つの手順の名前 (issue_backup_codes / sign_out_sessions / delete_factor / delete_backup_codes / refresh_session) で、recordMfaAudit は details の failed_step と null の数 (backup_codes_issued: null など) もそのまま渡す', async () => {
    expect(MFA_AUDIT_FAILED_STEPS).toEqual({
      issueBackupCodes: 'issue_backup_codes',
      signOutSessions: 'sign_out_sessions',
      deleteFactor: 'delete_factor',
      deleteBackupCodes: 'delete_backup_codes',
      refreshSession: 'refresh_session',
    });
    await recordMfaAudit({
      admin: ADMIN,
      actorId: ACTOR,
      targetUserId: ACTOR,
      action: MFA_AUDIT_ACTIONS.enroll,
      details: { factor_id: 'f-1', backup_codes_issued: null, failed_step: MFA_AUDIT_FAILED_STEPS.issueBackupCodes },
      request: REQUEST,
      routeName: 'POST /api/test',
    });
    expect(mocks.recordAdminAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actionType: 'admin.mfa.enroll',
        severity: 'info',
        details: { factor_id: 'f-1', backup_codes_issued: null, failed_step: 'issue_backup_codes' },
      }),
    );
  });
});
