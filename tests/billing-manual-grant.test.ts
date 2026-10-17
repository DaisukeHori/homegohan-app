/**
 * 手動のプラン付与 (billing/02 §8.1) の定数・Zod・純関数のテスト (#1797 段 B)。
 * 設計書 §13.1 のテスト 1〜8。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GRANTABLE_PLAN_STATUSES,
  GRANTABLE_PLAN_TYPES,
  MANUAL_GRANT_AUDIT_ACTIONS,
  MANUAL_GRANT_AUDIT_ACTION_VALUES,
  MANUAL_GRANT_AUDIT_SEVERITY,
  MANUAL_GRANT_CLIENT_FALLBACK_MESSAGE,
  MANUAL_GRANT_CLIENT_INVALID_INPUT_MESSAGE,
  MANUAL_GRANT_ERROR_HTTP_STATUS,
  MANUAL_GRANT_ERROR_MESSAGES,
  MANUAL_GRANT_EXPIRES_ON_MESSAGE,
  MANUAL_GRANT_REASON_MAX_LENGTH,
  MANUAL_GRANT_RPC_TO_API_CODE,
  ManualPlanRevokeBodySchema,
  PLAN_KEY_MAX_LENGTH,
  isGrantablePlan,
  isManualGrantRpcCode,
  manualGrantErrorMessage,
  manualPlanGrantBodySchema,
  manualPlanPath,
} from '@/lib/billing/manual-grant';

/** テストの「今日」(JST の暦日)。スキーマは時計を読まず、呼び出し側から渡される */
const TODAY = '2026-10-17';
const TOMORROW = '2026-10-18';
const YESTERDAY = '2026-10-16';
const NON_EXISTENT_DATE = '2026-02-30';
const VALID_REASON = '検証用の付与';

describe('manual-grant.ts: I/O を持たない', () => {
  it('manual-grant.ts imports nothing but zod, @/lib/billing/core and @/lib/calendar-date-schema', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/billing/manual-grant.ts'), 'utf8');
    const specifiers = [...source.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]);
    expect([...specifiers].sort()).toEqual(['@/lib/billing/core', '@/lib/calendar-date-schema', 'zod']);
    // 動的な import・require・fetch・process.env も無い
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/process\.env/);
  });
});

describe('isGrantablePlan', () => {
  it('isGrantablePlan accepts personal/family plans that are public and rejects free, org, private (family_addon), draft, deprecated', () => {
    // DB 関数 billing_grant_manual_subscription の 2. と同じ表 (tests/integration/rls/billing-manual-grant-rpc.test.ts のテスト 40 も同じ行を持つ)
    const table: ReadonlyArray<{ plan: { plan_key: string; plan_type: string; status: string }; grantable: boolean }> = [
      { plan: { plan_key: 'pro', plan_type: 'personal', status: 'public' }, grantable: true },
      { plan: { plan_key: 'family_basic', plan_type: 'family', status: 'public' }, grantable: true },
      { plan: { plan_key: 'family_pro', plan_type: 'family', status: 'public' }, grantable: true },
      { plan: { plan_key: 'free', plan_type: 'personal', status: 'public' }, grantable: false },
      { plan: { plan_key: 'org_standard', plan_type: 'org', status: 'public' }, grantable: false },
      { plan: { plan_key: 'family_addon', plan_type: 'family', status: 'private' }, grantable: false },
      { plan: { plan_key: 'pro', plan_type: 'personal', status: 'draft' }, grantable: false },
      { plan: { plan_key: 'pro', plan_type: 'personal', status: 'deprecated' }, grantable: false },
      { plan: { plan_key: 'family_basic', plan_type: 'family', status: 'deprecated' }, grantable: false },
      { plan: { plan_key: 'pro', plan_type: 'personal', status: 'private' }, grantable: false },
    ];
    for (const { plan, grantable } of table) {
      expect(isGrantablePlan(plan), `${plan.plan_key} / ${plan.plan_type} / ${plan.status}`).toBe(grantable);
    }
    // 条件の集合そのものも固定する (広げると private や org が通る)
    expect([...GRANTABLE_PLAN_TYPES]).toEqual(['personal', 'family']);
    expect([...GRANTABLE_PLAN_STATUSES]).toEqual(['public']);
  });
});

describe('manualPlanGrantBodySchema', () => {
  const schema = manualPlanGrantBodySchema(TODAY);

  it('manualPlanGrantBodySchema rejects expires_on on or before today, non-calendar dates (2026-02-30) and accepts null/omitted and a future date; trims reason and enforces 1..500', () => {
    // 期限なし (null / 省略) と未来の日付は通る
    expect(schema.safeParse({ plan_key: 'pro', expires_on: null, reason: VALID_REASON }).success).toBe(true);
    expect(schema.safeParse({ plan_key: 'pro', reason: VALID_REASON }).success).toBe(true);
    const future = schema.safeParse({ plan_key: 'pro', expires_on: TOMORROW, reason: VALID_REASON });
    expect(future.success).toBe(true);
    if (future.success) expect(future.data.expires_on).toBe(TOMORROW);

    // 今日・過去は固定の文の issue (path = expires_on) で拒む
    for (const expiresOn of [TODAY, YESTERDAY]) {
      const result = schema.safeParse({ plan_key: 'pro', expires_on: expiresOn, reason: VALID_REASON });
      expect(result.success, expiresOn).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path[0] === 'expires_on');
        expect(issue?.message).toBe(MANUAL_GRANT_EXPIRES_ON_MESSAGE);
      }
    }
    // 存在しない日 (CalendarDateSchema が拒む) と暦日の形でない文字列
    expect(schema.safeParse({ plan_key: 'pro', expires_on: NON_EXISTENT_DATE, reason: VALID_REASON }).success).toBe(false);
    expect(schema.safeParse({ plan_key: 'pro', expires_on: '2026/12/31', reason: VALID_REASON }).success).toBe(false);

    // reason: 前後の空白を除き、空・空白だけは拒み、500 文字ちょうどまで
    const trimmed = schema.safeParse({ plan_key: 'pro', reason: `  ${VALID_REASON}  ` });
    expect(trimmed.success).toBe(true);
    if (trimmed.success) expect(trimmed.data.reason).toBe(VALID_REASON);
    expect(schema.safeParse({ plan_key: 'pro', reason: '' }).success).toBe(false);
    expect(schema.safeParse({ plan_key: 'pro', reason: '   ' }).success).toBe(false);
    expect(schema.safeParse({ plan_key: 'pro' }).success).toBe(false);
    expect(schema.safeParse({ plan_key: 'pro', reason: 'a'.repeat(MANUAL_GRANT_REASON_MAX_LENGTH) }).success).toBe(true);
    expect(schema.safeParse({ plan_key: 'pro', reason: 'a'.repeat(MANUAL_GRANT_REASON_MAX_LENGTH + 1) }).success).toBe(false);

    // plan_key: 空・空白だけ・上限超過は拒む
    expect(schema.safeParse({ plan_key: '', reason: VALID_REASON }).success).toBe(false);
    expect(schema.safeParse({ plan_key: '   ', reason: VALID_REASON }).success).toBe(false);
    expect(schema.safeParse({ plan_key: 'p'.repeat(PLAN_KEY_MAX_LENGTH), reason: VALID_REASON }).success).toBe(true);
    expect(schema.safeParse({ plan_key: 'p'.repeat(PLAN_KEY_MAX_LENGTH + 1), reason: VALID_REASON }).success).toBe(false);
  });

  it('uses the injected today (the schema does not read the clock)', () => {
    const lateSchema = manualPlanGrantBodySchema('2027-01-01');
    expect(lateSchema.safeParse({ plan_key: 'pro', expires_on: TOMORROW, reason: VALID_REASON }).success).toBe(false);
    expect(lateSchema.safeParse({ plan_key: 'pro', expires_on: '2027-01-02', reason: VALID_REASON }).success).toBe(true);
  });
});

describe('ManualPlanRevokeBodySchema', () => {
  it('ManualPlanRevokeBodySchema requires a non-blank reason within 500 chars', () => {
    expect(ManualPlanRevokeBodySchema.safeParse({ reason: VALID_REASON }).success).toBe(true);
    expect(ManualPlanRevokeBodySchema.safeParse({ reason: 'a'.repeat(MANUAL_GRANT_REASON_MAX_LENGTH) }).success).toBe(true);
    expect(ManualPlanRevokeBodySchema.safeParse({ reason: 'a'.repeat(MANUAL_GRANT_REASON_MAX_LENGTH + 1) }).success).toBe(false);
    expect(ManualPlanRevokeBodySchema.safeParse({ reason: '' }).success).toBe(false);
    expect(ManualPlanRevokeBodySchema.safeParse({ reason: '   ' }).success).toBe(false);
    expect(ManualPlanRevokeBodySchema.safeParse({}).success).toBe(false);
    const trimmed = ManualPlanRevokeBodySchema.safeParse({ reason: `\t${VALID_REASON}\n` });
    expect(trimmed.success).toBe(true);
    if (trimmed.success) expect(trimmed.data.reason).toBe(VALID_REASON);
  });
});

describe('MANUAL_GRANT_RPC_TO_API_CODE', () => {
  it('MANUAL_GRANT_RPC_TO_API_CODE maps the 5 DB codes to API codes whose HTTP status is in MANUAL_GRANT_ERROR_HTTP_STATUS; isManualGrantRpcCode rejects unknown strings', () => {
    expect(MANUAL_GRANT_RPC_TO_API_CODE).toEqual({
      BILL_UNKNOWN_USER: 'NOT_FOUND',
      BILL_PLAN_NOT_GRANTABLE: 'OP_PLAN_NOT_GRANTABLE',
      BILL_MANUAL_EXPIRES_AT_PAST: 'OP_INVALID_INPUT',
      BILL_LIVE_ROW_CONFLICT: 'OP_SUBSCRIPTION_ALREADY_ACTIVE',
      BILL_MANUAL_ROW_NOT_FOUND: 'OP_NO_MANUAL_SUBSCRIPTION',
    });
    for (const [rpcCode, apiCode] of Object.entries(MANUAL_GRANT_RPC_TO_API_CODE)) {
      expect(isManualGrantRpcCode(rpcCode), rpcCode).toBe(true);
      expect(MANUAL_GRANT_ERROR_HTTP_STATUS[apiCode as keyof typeof MANUAL_GRANT_ERROR_HTTP_STATUS], rpcCode).toBeTypeOf('number');
    }
    // §12.1 の HTTP ステータス
    expect(MANUAL_GRANT_ERROR_HTTP_STATUS).toEqual({
      NOT_FOUND: 404,
      OP_INVALID_INPUT: 400,
      OP_SELF_MODIFY: 403,
      OP_PLAN_NOT_GRANTABLE: 422,
      OP_SUBSCRIPTION_ALREADY_ACTIVE: 409,
      OP_NO_MANUAL_SUBSCRIPTION: 409,
    });
    // 知らない文字列・Object.prototype の鍵・文字列でない値は拒む
    for (const unknown of ['', 'BILL_UNKNOWN', 'bill_unknown_user', 'toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(isManualGrantRpcCode(unknown), unknown).toBe(false);
    }
    for (const notString of [null, undefined, 0, {}, []]) {
      expect(isManualGrantRpcCode(notString)).toBe(false);
    }
  });
});

describe('manualPlanPath', () => {
  it('manualPlanPath encodes the user id and ends with /manual-plan', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    expect(manualPlanPath(id)).toBe(`/api/super-admin/users/${id}/manual-plan`);
    expect(manualPlanPath('a/b?c')).toBe('/api/super-admin/users/a%2Fb%3Fc/manual-plan');
    expect(manualPlanPath(id).endsWith('/manual-plan')).toBe(true);
  });
});

describe('manualGrantErrorMessage', () => {
  it('manualGrantErrorMessage returns the fixed message per code, MANUAL_GRANT_CLIENT_INVALID_INPUT_MESSAGE for OP_INVALID_INPUT, and the fallback for unknown codes', () => {
    expect(manualGrantErrorMessage('OP_INVALID_INPUT')).toBe(MANUAL_GRANT_CLIENT_INVALID_INPUT_MESSAGE);
    expect(MANUAL_GRANT_CLIENT_INVALID_INPUT_MESSAGE).toContain(String(MANUAL_GRANT_REASON_MAX_LENGTH));
    // API のコードのうち OP_INVALID_INPUT 以外は固定の文のまま
    for (const [code, message] of Object.entries(MANUAL_GRANT_ERROR_MESSAGES)) {
      if (code === 'OP_INVALID_INPUT') continue;
      expect(manualGrantErrorMessage(code), code).toBe(message);
    }
    expect(manualGrantErrorMessage('AUTH_UNAUTHENTICATED')).toBe('ログインし直してください');
    expect(manualGrantErrorMessage('OP_PERMISSION_DENIED')).toBe('権限がありません');
    expect(manualGrantErrorMessage('INTERNAL_ERROR')).toBe('処理中にエラーが発生しました。しばらくしてからお試しください');
    // 知らない code は既定の文
    for (const unknown of ['UNKNOWN', '', 'NOT_A_CODE']) {
      expect(manualGrantErrorMessage(unknown), unknown).toBe(MANUAL_GRANT_CLIENT_FALLBACK_MESSAGE);
    }
  });
});

describe('MANUAL_GRANT_AUDIT_ACTIONS', () => {
  it('MANUAL_GRANT_AUDIT_ACTIONS are admin.billing.* for grant/revoke (warn) and system.billing.* for expired (info)', () => {
    expect(MANUAL_GRANT_AUDIT_ACTIONS).toEqual({
      grant: 'admin.billing.manual_grant',
      revoke: 'admin.billing.manual_revoke',
      expired: 'system.billing.manual_grant_expired',
    });
    expect([...MANUAL_GRANT_AUDIT_ACTION_VALUES].sort()).toEqual(Object.values(MANUAL_GRANT_AUDIT_ACTIONS).sort());
    expect(MANUAL_GRANT_AUDIT_SEVERITY).toEqual({
      'admin.billing.manual_grant': 'warn',
      'admin.billing.manual_revoke': 'warn',
      'system.billing.manual_grant_expired': 'info',
    });
  });
});
