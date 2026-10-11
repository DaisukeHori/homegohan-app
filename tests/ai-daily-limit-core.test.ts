/**
 * #1149 (T40) AI の 1 日の利用回数の上限の共通部分 (supabase/functions/_shared/ai-daily-limit.ts) の単体テスト
 *
 *  - 次の JST の 0 時までの秒数 (retryAfter)。JST の日の境目 (UTC 15:00) で 1 日分に戻る
 *  - 画面に出す文 (固定の文。本文の文ではなく limit から作る)
 *  - DB の consume_ai_usage の戻り値の読み取り (形が違えば null = 呼び出し側は判定の失敗として許可する)
 *  - 429 の応答の形 (本文と Retry-After)
 *  - AI の部分を省いた応答の aiSkipped と、画面の出し分けの理由 (daily_limit)
 *  - import を持たないファイルに写した値 (JST のずれ・aiSkipped の値) が、元の定義と一致すること
 *  - 上限に数えない機能の一覧
 */
import { describe, expect, it } from 'vitest';
import {
  AI_DAILY_LIMIT_CODE,
  AI_DAILY_LIMIT_FALLBACK_MESSAGE,
  AI_DAILY_LIMIT_STATUS,
  AI_USAGE_JST_OFFSET_MS,
  AI_USAGE_NOT_COUNTED,
  aiDailyLimitMessage,
  aiDailyLimitMessageOfBody,
  aiDailyLimitPayload,
  aiDailyLimitSkippedField,
  parseConsumeAiUsageResult,
  secondsUntilNextJstMidnight,
} from '../supabase/functions/_shared/ai-daily-limit';
import { AI_FEATURES, AI_UNMETERED_FEATURES, isMeteredAiFeature } from '../supabase/functions/_shared/ai-usage-core';
import {
  AI_DAILY_LIMIT_SUMMARY_SKIPPED_NOTE,
  AI_SKIPPED_DAILY_LIMIT_CODE,
  aiSkippedReasonOf,
  aiSummarySkippedNote,
} from '../supabase/functions/_shared/ai-consent';
import { JST_OFFSET_MS } from '../supabase/functions/_shared/jst-date';

const SECONDS_PER_DAY = 24 * 60 * 60;

describe('secondsUntilNextJstMidnight: 次の JST の 0 時までの秒数', () => {
  it.each([
    // [説明, UTC の時刻, 秒数]
    ['JST 0:00:00 ちょうど (UTC 15:00) は、まる 1 日', Date.UTC(2026, 9, 10, 15, 0, 0), SECONDS_PER_DAY],
    ['JST 23:59:59.999 (UTC 14:59:59.999) は、切り上げて 1 秒', Date.UTC(2026, 9, 11, 14, 59, 59, 999), 1],
    ['JST 23:59:30 は 30 秒', Date.UTC(2026, 9, 11, 14, 59, 30), 30],
    ['JST 9:00 (UTC 0:00) は 15 時間', Date.UTC(2026, 9, 11, 0, 0, 0), 15 * 60 * 60],
    ['年をまたぐ: JST 12/31 23:00 は 1 時間', Date.UTC(2026, 11, 31, 14, 0, 0), 60 * 60],
  ])('%s', (_label, now, expected) => {
    expect(secondsUntilNextJstMidnight(now)).toBe(expected);
  });

  it('JST のずれは _shared/jst-date.ts の JST_OFFSET_MS と同じ (import を持たないので写した値)', () => {
    expect(AI_USAGE_JST_OFFSET_MS).toBe(JST_OFFSET_MS);
  });
});

describe('画面に出す文', () => {
  it('上限の回数を入れた固定の文 (Issue の例の文)', () => {
    expect(aiDailyLimitMessage(10)).toBe('今日の AI の利用回数の上限 (10 回) に達しました。明日 0 時から使えます。');
  });

  it('応答の本文から文を作る: code が AI_DAILY_LIMIT なら limit から作る (本文の error の文は使わない)', () => {
    expect(aiDailyLimitMessageOfBody({ code: AI_DAILY_LIMIT_CODE, limit: 5, error: '<script>' })).toBe(aiDailyLimitMessage(5));
    // 入れ子の形 ({ error: { code, limit } })
    expect(aiDailyLimitMessageOfBody({ error: { code: AI_DAILY_LIMIT_CODE, limit: 3 } })).toBe(aiDailyLimitMessage(3));
    // limit が読めなければ回数なしの文
    expect(aiDailyLimitMessageOfBody({ code: AI_DAILY_LIMIT_CODE })).toBe(AI_DAILY_LIMIT_FALLBACK_MESSAGE);
    expect(aiDailyLimitMessageOfBody({ code: AI_DAILY_LIMIT_CODE, limit: '10' })).toBe(AI_DAILY_LIMIT_FALLBACK_MESSAGE);
  });

  it('上限で止めた応答でないもの (レート制限の 429・ほかのコード・空) は null', () => {
    expect(aiDailyLimitMessageOfBody({ code: 'RATE_LIMITED', error: 'Too many requests' })).toBeNull();
    expect(aiDailyLimitMessageOfBody({ error: 'Unauthorized' })).toBeNull();
    expect(aiDailyLimitMessageOfBody(null)).toBeNull();
    expect(aiDailyLimitMessageOfBody('AI_DAILY_LIMIT')).toBeNull();
  });
});

describe('parseConsumeAiUsageResult: DB の consume_ai_usage の戻り値', () => {
  it('許可・止めの形を読む', () => {
    expect(parseConsumeAiUsageResult({ allowed: true, metered: true, plan: 'free', limit: 10, used: 10, usage_date: '2026-10-11' })).toEqual({
      allowed: true,
      metered: true,
      usageDate: '2026-10-11',
      limit: 10,
      used: 10,
    });
    expect(parseConsumeAiUsageResult({ allowed: false, metered: true, plan: 'free', limit: 10, used: 10, usage_date: '2026-10-11' })).toEqual({
      allowed: false,
      limit: 10,
      used: 10,
      usageDate: '2026-10-11',
    });
    expect(
      parseConsumeAiUsageResult({ allowed: true, metered: false, plan: null, limit: null, used: null, usage_date: '2026-10-11' }),
    ).toEqual({ allowed: true, metered: false, usageDate: '2026-10-11', limit: null, used: null });
  });

  it.each([
    ['null', null],
    ['文字列', 'allowed'],
    ['配列', [{ allowed: true, usage_date: '2026-10-11' }]],
    ['allowed が文字列', { allowed: 'false', limit: 10, used: 10, usage_date: '2026-10-11' }],
    ['日付の形が違う', { allowed: true, usage_date: '2026/10/11' }],
    ['止めなのに limit が無い', { allowed: false, used: 10, usage_date: '2026-10-11' }],
    ['止めなのに used が小数', { allowed: false, limit: 10, used: 9.5, usage_date: '2026-10-11' }],
  ])('形が違う (%s) なら null', (_label, data) => {
    expect(parseConsumeAiUsageResult(data)).toBeNull();
  });

  it('数えていない結果 (判定に失敗した・印があった) は、許可で、数え戻しの対象にならない (metered: false・日付なし)', () => {
    expect(AI_USAGE_NOT_COUNTED).toEqual({ allowed: true, metered: false, usageDate: null, limit: null, used: null });
    expect(Object.isFrozen(AI_USAGE_NOT_COUNTED)).toBe(true);
  });
});

describe('aiDailyLimitPayload: 429 の応答の形', () => {
  it('状態・Retry-After・本文 (error・code・limit・retryAfter) がそろう', () => {
    const now = Date.UTC(2026, 9, 11, 14, 0, 0); // JST 23:00
    expect(aiDailyLimitPayload({ limit: 10 }, now)).toEqual({
      status: AI_DAILY_LIMIT_STATUS,
      headers: { 'Retry-After': '3600' },
      body: { error: aiDailyLimitMessage(10), code: AI_DAILY_LIMIT_CODE, limit: 10, retryAfter: 3600 },
    });
    expect(AI_DAILY_LIMIT_STATUS).toBe(429);
  });
});

describe('AI の部分を省いた応答 (aiSkipped: AI_DAILY_LIMIT)', () => {
  it('止めたときだけ aiSkipped を足す。許可・判定していない (null) ときは何も足さない', () => {
    expect(aiDailyLimitSkippedField({ allowed: false, limit: 10, used: 10, usageDate: '2026-10-11' })).toEqual({ aiSkipped: AI_DAILY_LIMIT_CODE });
    expect(aiDailyLimitSkippedField(AI_USAGE_NOT_COUNTED)).toEqual({});
    expect(aiDailyLimitSkippedField(null)).toEqual({});
  });

  it('画面の出し分けの理由は daily_limit。相談を閉じたときの一文も選べる', () => {
    expect(aiSkippedReasonOf({ aiSkipped: AI_DAILY_LIMIT_CODE })).toBe('daily_limit');
    expect(aiSummarySkippedNote({ aiSkipped: AI_DAILY_LIMIT_CODE })).toBe(AI_DAILY_LIMIT_SUMMARY_SKIPPED_NOTE);
  });

  it('_shared/ai-consent.ts に写した aiSkipped の値は、AI_DAILY_LIMIT_CODE と同じ (import を持たないので写した値)', () => {
    expect(AI_SKIPPED_DAILY_LIMIT_CODE).toBe(AI_DAILY_LIMIT_CODE);
  });
});

describe('上限に数えない機能', () => {
  it('上限に数えない機能は、機能の一覧にある名前で、画面を開くと自動で呼ばれる AI の nutrition_advice_auto だけ', () => {
    expect(AI_UNMETERED_FEATURES).toEqual(['nutrition_advice_auto']);
    for (const feature of AI_UNMETERED_FEATURES) expect(AI_FEATURES).toContain(feature);
    expect(isMeteredAiFeature('nutrition_advice_auto')).toBe(false);
    // 利用者が押す操作の機能は、どれも上限に数える
    for (const feature of AI_FEATURES.filter((f) => f !== 'nutrition_advice_auto')) expect(isMeteredAiFeature(feature), feature).toBe(true);
  });
});
