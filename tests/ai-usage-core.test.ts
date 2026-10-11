/**
 * #1177 (T26) AI 利用回数の記録の共通部分 (supabase/functions/_shared/ai-usage-core.ts) の単体テスト
 *
 * Next.js (src/lib/plan/entitlements.ts) と Edge Functions (supabase/functions/_shared/ai-usage.ts) の両方が読む、
 * 純粋な関数。Next.js が付ける「記録済みの印」の署名と検証、記録する機能の一覧。
 */
import { describe, expect, it } from 'vitest';

import * as core from '../supabase/functions/_shared/ai-usage-core';
import {
  AI_FEATURES,
  AI_USAGE_RECORDED_HEADER,
  AI_USAGE_MARKER_MAX_AGE_SEC,
  AI_USAGE_MARKER_MAX_FUTURE_SEC,
  signAiUsageRecorded,
  verifyAiUsageRecorded,
} from '../supabase/functions/_shared/ai-usage-core';

const USER_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_USER_ID = '99999999-2222-3333-4444-555555555555';
const SECRET = 'service-role-key-for-test';
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

describe('記録済みの印: 署名と検証', () => {
  it('署名した印は、同じ鍵・同じユーザーなら検証を通る。形式は v1.<UNIX 秒>.<64 桁の hex>', async () => {
    const marker = await signAiUsageRecorded(SECRET, USER_ID, NOW);
    expect(marker).toMatch(/^v1\.\d+\.[0-9a-f]{64}$/);
    expect(marker.split('.')[1]).toBe(String(Math.floor(NOW / 1000)));
    expect(await verifyAiUsageRecorded(marker, USER_ID, [SECRET], NOW)).toBe(true);
    expect(AI_USAGE_RECORDED_HEADER).toBe('x-hg-ai-usage-recorded');
  });

  it('別のユーザーの印・別の鍵の印は通らない', async () => {
    const marker = await signAiUsageRecorded(SECRET, USER_ID, NOW);
    expect(await verifyAiUsageRecorded(marker, OTHER_USER_ID, [SECRET], NOW)).toBe(false);
    expect(await verifyAiUsageRecorded(marker, USER_ID, ['another-key'], NOW)).toBe(false);
  });

  it('候補の鍵のどれかで合えば通る (SERVICE_ROLE_JWT と SUPABASE_SERVICE_ROLE_KEY の両方を許容する)。空の鍵は無視する', async () => {
    const marker = await signAiUsageRecorded(SECRET, USER_ID, NOW);
    expect(await verifyAiUsageRecorded(marker, USER_ID, [undefined, '', 'other', SECRET], NOW)).toBe(true);
    expect(await verifyAiUsageRecorded(marker, USER_ID, [undefined, '', null], NOW)).toBe(false);
    expect(await verifyAiUsageRecorded(marker, USER_ID, [], NOW)).toBe(false);
  });

  it('署名の対象はユーザーと発行時刻: 時刻や署名を書き換えると通らない', async () => {
    const marker = await signAiUsageRecorded(SECRET, USER_ID, NOW);
    const [version, issuedAt, signature] = marker.split('.');

    expect(await verifyAiUsageRecorded(`${version}.${Number(issuedAt) + 1}.${signature}`, USER_ID, [SECRET], NOW)).toBe(false);
    const flipped = signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0');
    expect(await verifyAiUsageRecorded(`${version}.${issuedAt}.${flipped}`, USER_ID, [SECRET], NOW)).toBe(false);
  });

  it('有効期間: 発行から 5 分までは通り、それより古い印は通らない。未来すぎる印も通らない', async () => {
    const issuedAt = NOW;
    const marker = await signAiUsageRecorded(SECRET, USER_ID, issuedAt);

    expect(await verifyAiUsageRecorded(marker, USER_ID, [SECRET], issuedAt + AI_USAGE_MARKER_MAX_AGE_SEC * 1000)).toBe(true);
    expect(await verifyAiUsageRecorded(marker, USER_ID, [SECRET], issuedAt + (AI_USAGE_MARKER_MAX_AGE_SEC + 1) * 1000)).toBe(false);

    // 時計のずれは少し許す (Next.js と Edge Function は別のサーバー)
    expect(await verifyAiUsageRecorded(marker, USER_ID, [SECRET], issuedAt - AI_USAGE_MARKER_MAX_FUTURE_SEC * 1000)).toBe(true);
    expect(await verifyAiUsageRecorded(marker, USER_ID, [SECRET], issuedAt - (AI_USAGE_MARKER_MAX_FUTURE_SEC + 1) * 1000)).toBe(false);
  });

  it('形式が違う値は、例外を投げずに false (空・null・バージョン違い・桁違い・16 進でない・余計な区切り)', async () => {
    const marker = await signAiUsageRecorded(SECRET, USER_ID, NOW);
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
      expect(await verifyAiUsageRecorded(bad as string | null | undefined, USER_ID, [SECRET], NOW), String(bad)).toBe(false);
    }
    expect(await verifyAiUsageRecorded(marker, '', [SECRET], NOW)).toBe(false);
  });
});

describe('AI_FEATURES: 記録する機能の一覧', () => {
  it('重複が無く、DB の形式 (小文字の英字で始まり、小文字・数字・アンダースコアだけ、64 文字まで) に合う', () => {
    expect(new Set(AI_FEATURES).size).toBe(AI_FEATURES.length);
    for (const feature of AI_FEATURES) expect(feature).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
  });
});

describe('公開するもの (上限の判定の結果・429 の本文は _shared/ai-daily-limit.ts に分けた。#1149)', () => {
  it('公開するのは、機能の一覧・上限に数えない機能・待つ上限・記録済みの印だけ (署名の部品を持たないモバイルが読むものは別のファイル)', () => {
    expect(Object.keys(core).sort()).toEqual(
      [
        'AI_FEATURES',
        'AI_UNMETERED_FEATURES',
        'AI_USAGE_MARKER_MAX_AGE_SEC',
        'AI_USAGE_MARKER_MAX_FUTURE_SEC',
        'AI_USAGE_MARKER_VERSION',
        'AI_USAGE_RECORDED_HEADER',
        'AI_USAGE_TIMEOUT_MS',
        'isMeteredAiFeature',
        'signAiUsageRecorded',
        'verifyAiUsageRecorded',
      ].sort(),
    );
  });
});
