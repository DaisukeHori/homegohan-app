/**
 * #1177 (T26) AI 利用回数の記録の共通部分 (supabase/functions/_shared/ai-quota-core.ts) の単体テスト
 *
 * Next.js (src/lib/plan/entitlements.ts) と Edge Functions (supabase/functions/_shared/quota.ts) の両方が読む、
 * 純粋な関数。DB の consume_ai_quota の戻り値の読み取り、429 の本文、Next.js が付ける「数え済みの印」の署名と検証。
 */
import { describe, expect, it } from 'vitest';

import {
  AI_FEATURES,
  AI_QUOTA_COUNTED_HEADER,
  AI_QUOTA_ERROR_CODES,
  AI_QUOTA_MARKER_MAX_AGE_SEC,
  AI_QUOTA_MARKER_MAX_FUTURE_SEC,
  aiQuotaErrorBody,
  parseAiQuotaResult,
  signAiQuotaCounted,
  verifyAiQuotaCounted,
} from '../supabase/functions/_shared/ai-quota-core';

const USER_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_USER_ID = '99999999-2222-3333-4444-555555555555';
const SECRET = 'service-role-key-for-test';
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

describe('parseAiQuotaResult: consume_ai_quota の戻り値 (jsonb) の読み取り', () => {
  it('無制限: allowed=true・remaining=null', () => {
    expect(parseAiQuotaResult({ allowed: true, remaining: null, plan_key: 'free' })).toEqual({
      allowed: true,
      remaining: null,
      planKey: 'free',
    });
  });

  it('上限あり: 残り回数を数で返す', () => {
    expect(parseAiQuotaResult({ allowed: true, remaining: 2, plan_key: 'pro' })).toEqual({
      allowed: true,
      remaining: 2,
      planKey: 'pro',
    });
  });

  it('拒否: 上限の種類・値・戻る時刻を読む (snake_case を camelCase にする)', () => {
    expect(
      parseAiQuotaResult({
        allowed: false,
        remaining: 0,
        plan_key: 'free',
        limit_kind: 'monthly',
        limit: 30,
        reset_at: '2026-10-31T15:00:00Z',
      }),
    ).toEqual({
      allowed: false,
      remaining: 0,
      planKey: 'free',
      limitKind: 'monthly',
      limit: 30,
      resetAt: '2026-10-31T15:00:00Z',
    });
  });

  it('remaining が無い (undefined) ときは null として扱う。未知の limit_kind は無視する', () => {
    expect(parseAiQuotaResult({ allowed: true })).toEqual({ allowed: true, remaining: null });
    expect(parseAiQuotaResult({ allowed: false, remaining: 0, limit_kind: 'weekly' })).toEqual({ allowed: false, remaining: 0 });
  });

  it('想定外の形は例外 (呼び出し側が記録して許可にする)', () => {
    expect(() => parseAiQuotaResult(null)).toThrow();
    expect(() => parseAiQuotaResult(undefined)).toThrow();
    expect(() => parseAiQuotaResult('ok')).toThrow();
    expect(() => parseAiQuotaResult({})).toThrow();
    expect(() => parseAiQuotaResult({ allowed: 'yes', remaining: null })).toThrow();
    expect(() => parseAiQuotaResult({ allowed: true, remaining: '3' })).toThrow();
  });
});

describe('aiQuotaErrorBody: 上限を超えたときの 429 の本文', () => {
  it('日次: code は AI_DAILY_LIMIT。回数が戻る時刻が分かれば Retry-After の秒数も返す', () => {
    const { body, retryAfterSec } = aiQuotaErrorBody(
      { allowed: false, remaining: 0, limitKind: 'daily', limit: 10, resetAt: '2026-10-08T15:00:00Z' },
      NOW,
    );
    expect(body.code).toBe('AI_DAILY_LIMIT');
    expect(body.error).toContain('本日');
    expect(body).toMatchObject({ limit: 10, resetAt: '2026-10-08T15:00:00Z', retryAfter: 3 * 60 * 60 });
    expect(retryAfterSec).toBe(3 * 60 * 60);
  });

  it('月次: code は AI_MONTHLY_LIMIT', () => {
    const { body } = aiQuotaErrorBody({ allowed: false, remaining: 0, limitKind: 'monthly', limit: 100 }, NOW);
    expect(body.code).toBe('AI_MONTHLY_LIMIT');
    expect(body.error).toContain('今月');
  });

  it('上限の種類が分からないときは日次として扱う。時刻が無ければ Retry-After は付けない', () => {
    const { body, retryAfterSec } = aiQuotaErrorBody({ allowed: false, remaining: 0 }, NOW);
    expect(body.code).toBe('AI_DAILY_LIMIT');
    expect(retryAfterSec).toBeUndefined();
    expect(body).not.toHaveProperty('retryAfter');
    expect(body).not.toHaveProperty('resetAt');
  });

  it('戻る時刻がすでに過ぎていても、Retry-After は 1 秒以上', () => {
    const { retryAfterSec } = aiQuotaErrorBody(
      { allowed: false, remaining: 0, limitKind: 'daily', resetAt: '2026-10-08T11:00:00Z' },
      NOW,
    );
    expect(retryAfterSec).toBe(1);
  });

  it('レート制限の 429 (RATE_LIMITED) とは code が違う', () => {
    expect(Object.values(AI_QUOTA_ERROR_CODES)).toEqual(['AI_DAILY_LIMIT', 'AI_MONTHLY_LIMIT']);
  });
});

describe('数え済みの印: 署名と検証', () => {
  it('署名した印は、同じ鍵・同じユーザーなら検証を通る。形式は v1.<UNIX 秒>.<64 桁の hex>', async () => {
    const marker = await signAiQuotaCounted(SECRET, USER_ID, NOW);
    expect(marker).toMatch(/^v1\.\d+\.[0-9a-f]{64}$/);
    expect(marker.split('.')[1]).toBe(String(Math.floor(NOW / 1000)));
    expect(await verifyAiQuotaCounted(marker, USER_ID, [SECRET], NOW)).toBe(true);
    expect(AI_QUOTA_COUNTED_HEADER).toBe('x-hg-ai-quota-counted');
  });

  it('別のユーザーの印・別の鍵の印は通らない', async () => {
    const marker = await signAiQuotaCounted(SECRET, USER_ID, NOW);
    expect(await verifyAiQuotaCounted(marker, OTHER_USER_ID, [SECRET], NOW)).toBe(false);
    expect(await verifyAiQuotaCounted(marker, USER_ID, ['another-key'], NOW)).toBe(false);
  });

  it('候補の鍵のどれかで合えば通る (SERVICE_ROLE_JWT と SUPABASE_SERVICE_ROLE_KEY の両方を許容する)。空の鍵は無視する', async () => {
    const marker = await signAiQuotaCounted(SECRET, USER_ID, NOW);
    expect(await verifyAiQuotaCounted(marker, USER_ID, [undefined, '', 'other', SECRET], NOW)).toBe(true);
    expect(await verifyAiQuotaCounted(marker, USER_ID, [undefined, '', null], NOW)).toBe(false);
    expect(await verifyAiQuotaCounted(marker, USER_ID, [], NOW)).toBe(false);
  });

  it('署名の対象はユーザーと発行時刻: 時刻や署名を書き換えると通らない', async () => {
    const marker = await signAiQuotaCounted(SECRET, USER_ID, NOW);
    const [version, issuedAt, signature] = marker.split('.');

    expect(await verifyAiQuotaCounted(`${version}.${Number(issuedAt) + 1}.${signature}`, USER_ID, [SECRET], NOW)).toBe(false);
    const flipped = signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0');
    expect(await verifyAiQuotaCounted(`${version}.${issuedAt}.${flipped}`, USER_ID, [SECRET], NOW)).toBe(false);
  });

  it('有効期間: 発行から 5 分までは通り、それより古い印は通らない。未来すぎる印も通らない', async () => {
    const issuedAt = NOW;
    const marker = await signAiQuotaCounted(SECRET, USER_ID, issuedAt);

    expect(await verifyAiQuotaCounted(marker, USER_ID, [SECRET], issuedAt + AI_QUOTA_MARKER_MAX_AGE_SEC * 1000)).toBe(true);
    expect(await verifyAiQuotaCounted(marker, USER_ID, [SECRET], issuedAt + (AI_QUOTA_MARKER_MAX_AGE_SEC + 1) * 1000)).toBe(false);

    // 時計のずれは少し許す (Next.js と Edge Function は別のサーバー)
    expect(await verifyAiQuotaCounted(marker, USER_ID, [SECRET], issuedAt - AI_QUOTA_MARKER_MAX_FUTURE_SEC * 1000)).toBe(true);
    expect(await verifyAiQuotaCounted(marker, USER_ID, [SECRET], issuedAt - (AI_QUOTA_MARKER_MAX_FUTURE_SEC + 1) * 1000)).toBe(false);
  });

  it('形式が違う値は、例外を投げずに false (空・null・バージョン違い・桁違い・16 進でない・余計な区切り)', async () => {
    const marker = await signAiQuotaCounted(SECRET, USER_ID, NOW);
    const [, issuedAt, signature] = marker.split('.');

    for (const bad of [
      '',
      null,
      undefined,
      'garbage',
      `v2.${issuedAt}.${signature}`,
      `v1.${issuedAt}`,
      `v1.${issuedAt}.${signature}.extra`,
      `v1.${issuedAt}.${signature.slice(0, 62)}`,
      `v1.${issuedAt}.${signature.toUpperCase()}`,
      `v1.${issuedAt}.${'z'.repeat(64)}`,
      `v1.-1.${signature}`,
      `v1.1e9.${signature}`,
      `v1..${signature}`,
    ]) {
      expect(await verifyAiQuotaCounted(bad as string | null | undefined, USER_ID, [SECRET], NOW), String(bad)).toBe(false);
    }
    expect(await verifyAiQuotaCounted(marker, '', [SECRET], NOW)).toBe(false);
  });
});

describe('AI_FEATURES: 回数を数える機能の一覧', () => {
  it('重複が無く、DB の形式 (小文字の英字で始まり、小文字・数字・アンダースコアだけ、64 文字まで) に合う', () => {
    expect(new Set(AI_FEATURES).size).toBe(AI_FEATURES.length);
    for (const feature of AI_FEATURES) expect(feature).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
  });
});
