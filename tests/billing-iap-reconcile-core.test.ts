/**
 * ストアの購読の定期の取り直しの核 (src/lib/billing/iap-reconcile-core.ts) の単体テスト (billing/04 §12.1 のテスト 1〜10)。
 * DB も RevenueCat も使わない。期待値は設計書の表をリテラルで書く (一部は定数どうしの関係を見る)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IAP_LAZY_RESYNC_SOURCE,
  IAP_SUPERSEDED_SOURCE_SUFFIX,
  IAP_SYNC_SOURCE,
  REVENUECAT_REQUEST_TIMEOUT_MS,
} from '@/lib/billing/iap-core';
import {
  IAP_RECONCILE_BATCH_SIZE,
  IAP_RECONCILE_BATCH_SIZE_MAX,
  IAP_RECONCILE_BATCH_SIZE_MIN,
  IAP_RECONCILE_FAILURE_KINDS,
  IAP_RECONCILE_MAX_DURATION_SECONDS,
  IAP_RECONCILE_RECHECK_HOURS,
  IAP_RECONCILE_RECHECK_HOURS_MAX,
  IAP_RECONCILE_RECHECK_HOURS_MIN,
  IAP_RECONCILE_REJECTED_CODES,
  IAP_RECONCILE_REQUEST_INTERVAL_MS,
  IAP_RECONCILE_RUN_BUDGET_MS,
  IAP_RECONCILE_SOURCE,
  IapReconcileCandidatesSchema,
  IapReconcileFailedError,
  classifyReconcileFailure,
  countReconcileFailures,
  emptyIapReconcileSummary,
  isIapReconcileRejectedCode,
  isReconcileBudgetExhausted,
  reconcileFetchDelayMs,
  resolveIapReconcileSettings,
  type IapReconcileCandidate,
  type IapReconcileSummary,
} from '@/lib/billing/iap-reconcile-core';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const THIRD_USER = '33333333-3333-4333-8333-333333333333';

/** 設計書 §8.1 の値 (定数から組み立てず、リテラルで持つ) */
const EXPECTED_BATCH_SIZE_MAX = 40;
const EXPECTED_DEFAULT_RECHECK_HOURS = 6;
const EXPECTED_RECHECK_HOURS_MAX = 168;

describe('billing/04 §8.1 iap-reconcile-core: I/O を持たない', () => {
  it('iap-reconcile-core imports only zod (no I/O, no @/lib)', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/billing/iap-reconcile-core.ts'), 'utf8');
    const specifiers = [...source.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]);
    expect(specifiers).toEqual(['zod']);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/process\.env/);
  });
});

describe('billing/04 §8.1 定数', () => {
  it('IAP_RECONCILE_BATCH_SIZE_MAX and IAP_RECONCILE_BATCH_SIZE both equal Math.floor(IAP_RECONCILE_RUN_BUDGET_MS / IAP_RECONCILE_REQUEST_INTERVAL_MS) (= 40) with MIN 1, IAP_RECONCILE_RECHECK_HOURS (6) is within [MIN 1, MAX 168], and IAP_RECONCILE_RUN_BUDGET_MS + REVENUECAT_REQUEST_TIMEOUT_MS is below IAP_RECONCILE_MAX_DURATION_SECONDS * 1000', () => {
    expect(IAP_RECONCILE_BATCH_SIZE_MAX).toBe(Math.floor(IAP_RECONCILE_RUN_BUDGET_MS / IAP_RECONCILE_REQUEST_INTERVAL_MS));
    expect(IAP_RECONCILE_BATCH_SIZE_MAX).toBe(EXPECTED_BATCH_SIZE_MAX);
    expect(IAP_RECONCILE_BATCH_SIZE).toBe(EXPECTED_BATCH_SIZE_MAX);
    expect(IAP_RECONCILE_BATCH_SIZE_MIN).toBe(1);
    expect(IAP_RECONCILE_RECHECK_HOURS).toBe(EXPECTED_DEFAULT_RECHECK_HOURS);
    expect(IAP_RECONCILE_RECHECK_HOURS_MIN).toBe(1);
    expect(IAP_RECONCILE_RECHECK_HOURS_MAX).toBe(EXPECTED_RECHECK_HOURS_MAX);
    expect(IAP_RECONCILE_RECHECK_HOURS).toBeGreaterThanOrEqual(IAP_RECONCILE_RECHECK_HOURS_MIN);
    expect(IAP_RECONCILE_RECHECK_HOURS).toBeLessThanOrEqual(IAP_RECONCILE_RECHECK_HOURS_MAX);
    // 予算の後に最後の 1 人の取り直しの時間切れが付いても maxDuration の中に収まる
    expect(IAP_RECONCILE_RUN_BUDGET_MS + REVENUECAT_REQUEST_TIMEOUT_MS).toBeLessThan(IAP_RECONCILE_MAX_DURATION_SECONDS * 1000);
  });

  it('IAP_RECONCILE_SOURCE is iap_reconcile, differs from IAP_SYNC_SOURCE and IAP_LAZY_RESYNC_SOURCE, and does not end with IAP_SUPERSEDED_SOURCE_SUFFIX', () => {
    expect(IAP_RECONCILE_SOURCE).toBe('iap_reconcile');
    expect(IAP_RECONCILE_SOURCE).not.toBe(IAP_SYNC_SOURCE);
    expect(IAP_RECONCILE_SOURCE).not.toBe(IAP_LAZY_RESYNC_SOURCE);
    expect(IAP_RECONCILE_SOURCE.endsWith(IAP_SUPERSEDED_SOURCE_SUFFIX)).toBe(false);
  });
});

describe('billing/04 §8.1 resolveIapReconcileSettings', () => {
  it('resolveIapReconcileSettings returns the defaults for undefined / blank, keeps in-range integers, and falls back with the variable name in ignored for out-of-range (0, 41 / 0, 169), non-integer (1.5) and non-numeric values', () => {
    const defaults = { batchSize: 40, recheckHours: 6, ignored: [] };
    expect(resolveIapReconcileSettings({ batchSize: undefined, recheckHours: undefined })).toEqual(defaults);
    expect(resolveIapReconcileSettings({ batchSize: '', recheckHours: '   ' })).toEqual(defaults);
    // 範囲の中の整数 (両端を含む)
    expect(resolveIapReconcileSettings({ batchSize: '1', recheckHours: '1' })).toEqual({ batchSize: 1, recheckHours: 1, ignored: [] });
    expect(resolveIapReconcileSettings({ batchSize: '40', recheckHours: '168' })).toEqual({ batchSize: 40, recheckHours: 168, ignored: [] });
    expect(resolveIapReconcileSettings({ batchSize: ' 20 ', recheckHours: '12' })).toEqual({ batchSize: 20, recheckHours: 12, ignored: [] });
    // 範囲外
    expect(resolveIapReconcileSettings({ batchSize: '0', recheckHours: '0' })).toEqual({
      batchSize: 40,
      recheckHours: 6,
      ignored: ['IAP_RECONCILE_BATCH_SIZE', 'IAP_RECONCILE_RECHECK_HOURS'],
    });
    expect(resolveIapReconcileSettings({ batchSize: '41', recheckHours: '169' })).toEqual({
      batchSize: 40,
      recheckHours: 6,
      ignored: ['IAP_RECONCILE_BATCH_SIZE', 'IAP_RECONCILE_RECHECK_HOURS'],
    });
    // 整数でない・数字でない (片方だけ不正なら、その名前だけが ignored に入り、もう片方の値は生きる)
    expect(resolveIapReconcileSettings({ batchSize: '1.5', recheckHours: '12' })).toEqual({
      batchSize: 40,
      recheckHours: 12,
      ignored: ['IAP_RECONCILE_BATCH_SIZE'],
    });
    expect(resolveIapReconcileSettings({ batchSize: '10', recheckHours: 'abc' })).toEqual({
      batchSize: 10,
      recheckHours: 6,
      ignored: ['IAP_RECONCILE_RECHECK_HOURS'],
    });
  });
});

describe('billing/04 §8.1 候補の行の Zod', () => {
  it('IapReconcileCandidatesSchema accepts RPC rows (uuid user_id, period_end, nullable synced_at) and rejects a non-uuid user_id, a missing period_end and a non-array', () => {
    const ok = [
      { user_id: USER, period_end: '2026-10-21T00:00:00+00:00', synced_at: null },
      { user_id: OTHER_USER, period_end: '2026-10-20T00:00:00+00:00', synced_at: '2026-10-19T00:00:00+00:00' },
    ];
    expect(IapReconcileCandidatesSchema.safeParse(ok).success).toBe(true);
    expect(IapReconcileCandidatesSchema.safeParse([]).success).toBe(true);
    expect(IapReconcileCandidatesSchema.safeParse([{ user_id: 'not-a-uuid', period_end: '2026-10-21T00:00:00+00:00', synced_at: null }]).success).toBe(false);
    expect(IapReconcileCandidatesSchema.safeParse([{ user_id: USER, synced_at: null }]).success).toBe(false);
    expect(IapReconcileCandidatesSchema.safeParse({ user_id: USER, period_end: '2026-10-21T00:00:00+00:00', synced_at: null }).success).toBe(false);
    expect(IapReconcileCandidatesSchema.safeParse(null).success).toBe(false);
  });
});

describe('billing/04 §8.1 回の中の純関数', () => {
  it('reconcileFetchDelayMs is 0 before the first fetch, IAP_RECONCILE_REQUEST_INTERVAL_MS minus the elapsed time after a fetch started, and 0 once the interval has passed; isReconcileBudgetExhausted is false at exactly the budget and true 1 ms after', () => {
    const interval = IAP_RECONCILE_REQUEST_INTERVAL_MS;
    const start = 1_000_000;
    expect(reconcileFetchDelayMs(null, start)).toBe(0);
    expect(reconcileFetchDelayMs(start, start)).toBe(interval);
    expect(reconcileFetchDelayMs(start, start + 300)).toBe(interval - 300);
    expect(reconcileFetchDelayMs(start, start + interval)).toBe(0);
    expect(reconcileFetchDelayMs(start, start + interval + 500)).toBe(0);

    expect(isReconcileBudgetExhausted(start, start)).toBe(false);
    expect(isReconcileBudgetExhausted(start, start + IAP_RECONCILE_RUN_BUDGET_MS)).toBe(false);
    expect(isReconcileBudgetExhausted(start, start + IAP_RECONCILE_RUN_BUDGET_MS + 1)).toBe(true);
  });

  it('emptyIapReconcileSummary sets candidates to the length, every count to 0, rejected and failed to {}, stopped_early to null, oldest_period_end to the earliest period_end among the candidates even when it is not the first (null for none) and elapsed_ms to 0; countReconcileFailures sums failed over every kind', () => {
    const candidates: IapReconcileCandidate[] = [
      { user_id: USER, period_end: '2026-10-21T00:00:00+00:00', synced_at: null },
      { user_id: OTHER_USER, period_end: '2026-10-19T12:00:00+00:00', synced_at: null },
      { user_id: THIRD_USER, period_end: '2026-10-20T00:00:00+00:00', synced_at: '2026-10-19T00:00:00+00:00' },
    ];
    expect(emptyIapReconcileSummary(candidates)).toEqual({
      candidates: 3,
      synced: 0,
      applied: 0,
      stale: 0,
      ended: 0,
      no_subscription: 0,
      skipped_unknown: 0,
      rejected: {},
      failed: {},
      stopped_early: null,
      // 先頭 (2026-10-21) ではなく 2 番目が最も古い
      oldest_period_end: '2026-10-19T12:00:00+00:00',
      elapsed_ms: 0,
    });
    expect(emptyIapReconcileSummary([])).toMatchObject({ candidates: 0, oldest_period_end: null, failed: {}, rejected: {} });

    expect(countReconcileFailures({ failed: {} })).toBe(0);
    // 6 つの種類を 1, 2, 3, 4, 5, 6 件にして合計 21 になる (種類の取りこぼしがあれば合計が合わない)
    const failed: IapReconcileSummary['failed'] = {};
    IAP_RECONCILE_FAILURE_KINDS.forEach((kind, index) => {
      failed[kind] = index + 1;
    });
    const expectedTotal = IAP_RECONCILE_FAILURE_KINDS.reduce((total, _kind, index) => total + index + 1, 0);
    expect(IAP_RECONCILE_FAILURE_KINDS).toHaveLength(6);
    expect(countReconcileFailures({ failed })).toBe(expectedTotal);
    expect(expectedTotal).toBe(21);
  });
});

describe('billing/04 §8.1 失敗の分け方', () => {
  it('classifyReconcileFailure maps RevenueCat status null / 401 / 403 / 500 / 503 to run with revenuecat_unreachable / revenuecat_unauthorized / revenuecat_server_error, 429 to rate_limited, 400 / 404 to user with revenuecat_client_error, 200 to user with revenuecat_unexpected_response, and source other to user with internal; every kind is in IAP_RECONCILE_FAILURE_KINDS; IAP_RECONCILE_REJECTED_CODES is exactly [BILL_LIVE_ROW_CONFLICT, BILL_IAP_UNKNOWN_PRODUCT] and isIapReconcileRejectedCode is true for those two and false for BILL_UNKNOWN_PLAN / BILL_UNKNOWN_IAP_STATUS / BILL_IAP_SYNC_CONFLICT', () => {
    const rc = (status: number | null) => classifyReconcileFailure({ source: 'revenuecat', status });
    expect(rc(null)).toEqual({ scope: 'run', kind: 'revenuecat_unreachable' });
    expect(rc(401)).toEqual({ scope: 'run', kind: 'revenuecat_unauthorized' });
    expect(rc(403)).toEqual({ scope: 'run', kind: 'revenuecat_unauthorized' });
    expect(rc(500)).toEqual({ scope: 'run', kind: 'revenuecat_server_error' });
    expect(rc(503)).toEqual({ scope: 'run', kind: 'revenuecat_server_error' });
    expect(rc(429)).toEqual({ scope: 'rate_limited' });
    expect(rc(400)).toEqual({ scope: 'user', kind: 'revenuecat_client_error' });
    expect(rc(404)).toEqual({ scope: 'user', kind: 'revenuecat_client_error' });
    // 2xx で応答の形が合わない
    expect(rc(200)).toEqual({ scope: 'user', kind: 'revenuecat_unexpected_response' });
    expect(classifyReconcileFailure({ source: 'other' })).toEqual({ scope: 'user', kind: 'internal' });

    // 返す種類はすべて一覧の中にある
    const inputs = [null, 200, 400, 401, 403, 404, 429, 500, 503] as const;
    for (const status of inputs) {
      const result = rc(status);
      if (result.scope !== 'rate_limited') expect(IAP_RECONCILE_FAILURE_KINDS, String(status)).toContain(result.kind);
    }
    const other = classifyReconcileFailure({ source: 'other' });
    if (other.scope !== 'rate_limited') expect(IAP_RECONCILE_FAILURE_KINDS).toContain(other.kind);

    expect([...IAP_RECONCILE_REJECTED_CODES]).toEqual(['BILL_LIVE_ROW_CONFLICT', 'BILL_IAP_UNKNOWN_PRODUCT']);
    expect(isIapReconcileRejectedCode('BILL_LIVE_ROW_CONFLICT')).toBe(true);
    expect(isIapReconcileRejectedCode('BILL_IAP_UNKNOWN_PRODUCT')).toBe(true);
    expect(isIapReconcileRejectedCode('BILL_UNKNOWN_PLAN')).toBe(false);
    expect(isIapReconcileRejectedCode('BILL_UNKNOWN_IAP_STATUS')).toBe(false);
    expect(isIapReconcileRejectedCode('BILL_IAP_SYNC_CONFLICT')).toBe(false);
  });

  it('IapReconcileFailedError keeps the summary, has the name IapReconcileFailedError and a fixed message that contains no user id', () => {
    const summary = emptyIapReconcileSummary([{ user_id: USER, period_end: '2026-10-21T00:00:00+00:00', synced_at: null }]);
    summary.failed.internal = 1;
    const error = new IapReconcileFailedError(summary);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('IapReconcileFailedError');
    expect(error.summary).toBe(summary);
    expect(error.message).toBe('ストアの購読を取り直せなかった利用者がいます');
    expect(error.message).not.toContain(USER);
    // 要約を変えてもメッセージは変わらない (利用者 ID を載せる口が無い)
    expect(new IapReconcileFailedError(emptyIapReconcileSummary([])).message).toBe(error.message);
  });
});

describe('billing/04 §8.1 ⇄ §6.2 DB 関数の上限', () => {
  it('IAP_RECONCILE_BATCH_SIZE_MAX is at most the c_max_users constant, declared with the same value in both billing_iap_reconcile_candidates and billing_iap_reconcile_mark_attempted, in the one migration ending with _billing_iap_reconcile.sql', () => {
    const dir = path.join(process.cwd(), 'supabase/migrations');
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('_billing_iap_reconcile.sql'));
    expect(files).toHaveLength(1);
    const sql = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    const declared = [...sql.matchAll(/c_max_users\s+CONSTANT\s+integer\s*:=\s*(\d+)\s*;/g)].map((match) => Number(match[1]));
    // 候補を読む関数と印を書く関数の 2 本。同じ値
    expect(declared).toHaveLength(2);
    expect(declared[0]).toBe(declared[1]);
    expect(IAP_RECONCILE_BATCH_SIZE_MAX).toBeLessThanOrEqual(declared[0]);
    // 関数ごとの宣言であること (関数の本体に 1 つずつ)
    const candidatesBody = sql.slice(sql.indexOf('FUNCTION public.billing_iap_reconcile_candidates('), sql.indexOf('FUNCTION public.billing_iap_reconcile_mark_attempted('));
    const markBody = sql.slice(sql.indexOf('FUNCTION public.billing_iap_reconcile_mark_attempted('));
    expect(candidatesBody).toMatch(/c_max_users\s+CONSTANT\s+integer\s*:=\s*\d+/);
    expect(markBody).toMatch(/c_max_users\s+CONSTANT\s+integer\s*:=\s*\d+/);
  });
});
