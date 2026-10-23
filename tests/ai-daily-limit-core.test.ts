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
  AI_AUTO_SAFETY_CAP_MESSAGE,
  AI_DAILY_CAPPED_FEATURES,
  AI_FEATURE_NOT_IN_PLAN_CODE,
  AI_FEATURE_NOT_IN_PLAN_FALLBACK_MESSAGE,
  AI_FEATURE_NOT_IN_PLAN_STATUS,
  AI_PLAN_CAPPED_FEATURES,
  AI_PLAN_CAPPED_FEATURE_LABELS,
  aiDailyLimitMessageOfStatusAndBody,
  aiFeatureDailyLimitMessage,
  aiFeatureNotInPlanMessage,
  isAiDailyLimitMessage,
  AI_DAILY_LIMIT_CODE,
  AI_DAILY_LIMIT_FALLBACK_MESSAGE,
  AI_DAILY_LIMIT_STATUS,
  AI_USAGE_JST_OFFSET_MS,
  AI_USAGE_NOT_COUNTED,
  aiDailyLimitMessage,
  aiDailyLimitMessageOfBody,
  aiDailyLimitMessageOfDenied,
  aiDailyLimitPayload,
  aiDailyLimitSkippedField,
  aiUltimateModeDailyLimitMessage,
  parseConsumeAiUsageResult,
  secondsUntilNextJstMidnight,
} from '../supabase/functions/_shared/ai-daily-limit';
import {
  AI_CAPPED_FEATURES,
  AI_FEATURES,
  AI_ULTIMATE_MODE_DAILY_LIMIT_DEFAULT,
  resolveAiUltimateModeDailyLimit,
  AI_UNMETERED_DAILY_CAP_DEFAULTS,
  AI_UNMETERED_DAILY_CAP_FALLBACK,
  AI_UNMETERED_FEATURES,
  isMeteredAiFeature,
} from '../supabase/functions/_shared/ai-usage-core';
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

describe('(#1142) 究極モードの 1 日の上限 (機能ごとの上限) で止めたとき', () => {
  const CAPPED_ROW = { allowed: false, metered: true, plan: null, limit: 1, used: 1, usage_date: '2026-10-11', capped_feature: 'menu_generation_ultimate' };

  it('DB の戻り値の capped_feature を読む。知らない機能名は付けない (1 日の上限の止めとして扱う)', () => {
    expect(parseConsumeAiUsageResult(CAPPED_ROW)).toEqual({
      allowed: false,
      limit: 1,
      used: 1,
      usageDate: '2026-10-11',
      cappedFeature: 'menu_generation_ultimate',
    });
    expect(parseConsumeAiUsageResult({ ...CAPPED_ROW, capped_feature: 'photo_analysis' })).toEqual({
      allowed: false,
      limit: 1,
      used: 1,
      usageDate: '2026-10-11',
    });
  });

  it('文は 1 日の上限と同じ形で、究極モードの上限と分かる文。429・コード・Retry-After は 1 日の上限と同じ', () => {
    expect(aiUltimateModeDailyLimitMessage(1)).toBe('今日の究極モードの利用回数の上限 (1 回) に達しました。明日 0 時から使えます。');
    const now = Date.UTC(2026, 9, 11, 14, 0, 0); // JST 23:00
    expect(aiDailyLimitPayload({ limit: 1, cappedFeature: 'menu_generation_ultimate' }, now)).toEqual({
      status: AI_DAILY_LIMIT_STATUS,
      headers: { 'Retry-After': '3600' },
      body: {
        error: aiUltimateModeDailyLimitMessage(1),
        code: AI_DAILY_LIMIT_CODE,
        limit: 1,
        cappedFeature: 'menu_generation_ultimate',
        retryAfter: 3600,
      },
    });
  });

  it('JST の日付が変わると戻る: retryAfter は次の JST の 0 時 (UTC 15:00) まで。0 時ちょうどは丸 1 日', () => {
    expect(aiDailyLimitPayload({ limit: 1, cappedFeature: 'menu_generation_ultimate' }, Date.UTC(2026, 9, 11, 14, 59, 59)).body.retryAfter).toBe(1);
    expect(aiDailyLimitPayload({ limit: 1, cappedFeature: 'menu_generation_ultimate' }, Date.UTC(2026, 9, 11, 15, 0, 0)).body.retryAfter).toBe(SECONDS_PER_DAY);
  });

  it('画面 (Web・モバイル) が本文から作る文も究極モードの文 (本文の error の文は使わない。入れ子の形も)', () => {
    expect(aiDailyLimitMessageOfBody({ code: AI_DAILY_LIMIT_CODE, limit: 1, cappedFeature: 'menu_generation_ultimate', error: '<x>' })).toBe(
      aiUltimateModeDailyLimitMessage(1),
    );
    expect(aiDailyLimitMessageOfBody({ error: { code: AI_DAILY_LIMIT_CODE, limit: 2, cappedFeature: 'menu_generation_ultimate' } })).toBe(
      aiUltimateModeDailyLimitMessage(2),
    );
    // 知らない機能名・limit が無いときは、今までどおりの文
    expect(aiDailyLimitMessageOfBody({ code: AI_DAILY_LIMIT_CODE, limit: 10, cappedFeature: 'x' })).toBe(aiDailyLimitMessage(10));
    expect(aiDailyLimitMessageOfBody({ code: AI_DAILY_LIMIT_CODE, cappedFeature: 'menu_generation_ultimate' })).toBe(AI_DAILY_LIMIT_FALLBACK_MESSAGE);
  });

  it('aiDailyLimitMessageOfDenied: 止めた理由で文を選ぶ (安全弁 > 機能ごとの上限 > 1 日の上限)', () => {
    expect(aiDailyLimitMessageOfDenied({ limit: 10 })).toBe(aiDailyLimitMessage(10));
    expect(aiDailyLimitMessageOfDenied({ limit: 1, cappedFeature: 'menu_generation_ultimate' })).toBe(aiUltimateModeDailyLimitMessage(1));
    expect(aiDailyLimitMessageOfDenied({ limit: 30, safetyCap: true })).toBe(AI_AUTO_SAFETY_CAP_MESSAGE);
  });

  it('_shared/ai-daily-limit.ts に写した機能の一覧は、_shared/ai-usage-core.ts の AI_CAPPED_FEATURES と同じ', () => {
    expect([...AI_DAILY_CAPPED_FEATURES].sort()).toEqual([...AI_CAPPED_FEATURES].sort());
  });

  it('上限の回数は既定 1 回。環境変数の値は 0 以上の整数だけ受け付け、それ以外は既定の値', () => {
    expect(AI_ULTIMATE_MODE_DAILY_LIMIT_DEFAULT).toBe(1);
    expect(resolveAiUltimateModeDailyLimit(undefined)).toBe(1);
    expect(resolveAiUltimateModeDailyLimit('4')).toBe(4);
    expect(resolveAiUltimateModeDailyLimit('0')).toBe(0);
    for (const raw of ['', ' ', '-1', '1.5', 'one', '9999999999']) expect(resolveAiUltimateModeDailyLimit(raw), raw).toBe(1);
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
  it('上限に数えない機能は、機能の一覧にある名前で、画面を開く・保存するだけで呼ばれる AI の nutrition_advice_auto と meal_image_auto だけ', () => {
    expect(AI_UNMETERED_FEATURES).toEqual(['nutrition_advice_auto', 'meal_image_auto']);
    for (const feature of AI_UNMETERED_FEATURES) expect(AI_FEATURES).toContain(feature);
    expect(isMeteredAiFeature('nutrition_advice_auto')).toBe(false);
    expect(isMeteredAiFeature('meal_image_auto')).toBe(false);
    // 利用者が押す操作の機能は、どれも上限に数える (画像を作る操作 image_generation も。料理画像の副作用だけを meal_image_auto に分けた)
    for (const feature of AI_FEATURES.filter((f) => !AI_UNMETERED_FEATURES.includes(f))) expect(isMeteredAiFeature(feature), feature).toBe(true);
    expect(isMeteredAiFeature('image_generation')).toBe(true);
  });

  it('(#1149) 上限に数えない機能には、どれにも安全弁の既定の回数がある (0 より大きい整数)。行が無いときの値は既定の値のうち小さいほう', () => {
    expect(Object.keys(AI_UNMETERED_DAILY_CAP_DEFAULTS).sort()).toEqual([...AI_UNMETERED_FEATURES].sort());
    for (const [feature, cap] of Object.entries(AI_UNMETERED_DAILY_CAP_DEFAULTS)) {
      expect(Number.isInteger(cap) && cap > 0, feature).toBe(true);
    }
    expect(AI_UNMETERED_DAILY_CAP_DEFAULTS).toEqual({ nutrition_advice_auto: 30, meal_image_auto: 20 });
    expect(AI_UNMETERED_DAILY_CAP_FALLBACK).toBe(Math.min(...Object.values(AI_UNMETERED_DAILY_CAP_DEFAULTS)));
  });
});

describe('billing/03 §8.8 プランごとの機能の上限 (ai_plan_feature_caps) と使えない機能 (plan_locked)', () => {
  const DENIED_ROW = { allowed: false, metered: true, plan: 'free', limit: 0, used: 0, usage_date: '2026-10-21' };

  it('parseConsumeAiUsageResult reads capped_feature for the 4 plan-capped features, sets planLocked only with plan_locked true and a known feature, and ignores unknown feature names', () => {
    expect([...AI_PLAN_CAPPED_FEATURES]).toEqual(['menu_generation_ultimate', 'menu_generation', 'image_generation', 'meal_image_auto']);
    for (const feature of AI_PLAN_CAPPED_FEATURES) {
      expect(parseConsumeAiUsageResult({ ...DENIED_ROW, capped_feature: feature, plan_locked: true }), feature).toEqual({
        allowed: false, limit: 0, used: 0, usageDate: '2026-10-21', cappedFeature: feature, planLocked: true,
      });
      expect(parseConsumeAiUsageResult({ ...DENIED_ROW, limit: 3, used: 3, capped_feature: feature, plan_locked: false }), feature).toEqual({
        allowed: false, limit: 3, used: 3, usageDate: '2026-10-21', cappedFeature: feature,
      });
    }
    // plan_locked が true でも、知らない機能名なら付けない (文に機能名が要るため)
    expect(parseConsumeAiUsageResult({ ...DENIED_ROW, capped_feature: 'consultation', plan_locked: true })).toEqual({
      allowed: false, limit: 0, used: 0, usageDate: '2026-10-21',
    });
    // capped_feature が無い plan_locked は無視する
    expect(parseConsumeAiUsageResult({ ...DENIED_ROW, plan_locked: true })).toEqual({ allowed: false, limit: 0, used: 0, usageDate: '2026-10-21' });
    // 'true' の文字列は真として読まない
    expect(parseConsumeAiUsageResult({ ...DENIED_ROW, capped_feature: 'meal_image_auto', plan_locked: 'true' })).toEqual({
      allowed: false, limit: 0, used: 0, usageDate: '2026-10-21', cappedFeature: 'meal_image_auto',
    });
  });

  it('aiDailyLimitPayload returns 403 AI_FEATURE_NOT_IN_PLAN { error, code, feature } without Retry-After when planLocked, 429 with aiFeatureDailyLimitMessage when a cap > 0 is reached, and the unchanged ultimate-mode text', () => {
    const now = Date.UTC(2026, 9, 21, 14, 0, 0); // JST 23:00
    expect(AI_FEATURE_NOT_IN_PLAN_STATUS).toBe(403);
    expect(AI_FEATURE_NOT_IN_PLAN_CODE).toBe('AI_FEATURE_NOT_IN_PLAN');
    for (const feature of AI_PLAN_CAPPED_FEATURES) {
      expect(aiDailyLimitPayload({ limit: 0, cappedFeature: feature, planLocked: true }, now), feature).toEqual({
        status: 403,
        headers: {},
        body: { error: aiFeatureNotInPlanMessage(feature), code: 'AI_FEATURE_NOT_IN_PLAN', feature },
      });
    }
    expect(aiFeatureNotInPlanMessage('menu_generation_ultimate')).toBe('究極モードは、有料プランでお使いいただけます。');
    expect(aiFeatureNotInPlanMessage('image_generation')).toBe('料理画像の作成は、有料プランでお使いいただけます。');
    expect(aiDailyLimitPayload({ limit: 3, cappedFeature: 'menu_generation' }, now)).toEqual({
      status: 429,
      headers: { 'Retry-After': '3600' },
      body: {
        error: '今日の献立の作成の利用回数の上限 (3 回) に達しました。明日 0 時から使えます。',
        code: 'AI_DAILY_LIMIT',
        limit: 3,
        cappedFeature: 'menu_generation',
        retryAfter: 3600,
      },
    });
    expect(aiFeatureDailyLimitMessage('menu_generation', 3)).toBe('今日の献立の作成の利用回数の上限 (3 回) に達しました。明日 0 時から使えます。');
    // 究極モードの文は変えない
    expect(aiFeatureDailyLimitMessage('menu_generation_ultimate', 2)).toBe('今日の究極モードの利用回数の上限 (2 回) に達しました。明日 0 時から使えます。');
    expect(aiUltimateModeDailyLimitMessage(2)).toBe(aiFeatureDailyLimitMessage('menu_generation_ultimate', 2));
    // 安全弁は使えない機能より先 (回数を出さない固定の文の 429)
    expect(aiDailyLimitPayload({ limit: 20, safetyCap: true, cappedFeature: 'meal_image_auto', planLocked: true }, now).status).toBe(429);
    expect(AI_PLAN_CAPPED_FEATURE_LABELS).toEqual({
      menu_generation_ultimate: '究極モード',
      menu_generation: '献立の作成',
      image_generation: '料理画像の作成',
      meal_image_auto: '料理画像の作成',
    });
  });

  it('isAiDailyLimitMessage accepts the feature-not-in-plan messages (all 4 features and the fallback) and the feature-limit messages, and aiDailyLimitMessageOfBody reads both 403 and 429 bodies (flat and nested)', () => {
    for (const feature of AI_PLAN_CAPPED_FEATURES) {
      expect(isAiDailyLimitMessage(aiFeatureNotInPlanMessage(feature)), feature).toBe(true);
      expect(isAiDailyLimitMessage(aiFeatureDailyLimitMessage(feature, 15)), feature).toBe(true);
      // 403 の本文 (平らと入れ子)
      expect(aiDailyLimitMessageOfBody({ error: '<x>', code: 'AI_FEATURE_NOT_IN_PLAN', feature })).toBe(aiFeatureNotInPlanMessage(feature));
      expect(aiDailyLimitMessageOfBody({ error: { code: 'AI_FEATURE_NOT_IN_PLAN', feature } })).toBe(aiFeatureNotInPlanMessage(feature));
      // 429 の機能ごとの上限の本文 (平らと入れ子)
      expect(aiDailyLimitMessageOfBody({ code: 'AI_DAILY_LIMIT', limit: 15, cappedFeature: feature })).toBe(aiFeatureDailyLimitMessage(feature, 15));
      expect(aiDailyLimitMessageOfBody({ error: { code: 'AI_DAILY_LIMIT', limit: 15, cappedFeature: feature } })).toBe(aiFeatureDailyLimitMessage(feature, 15));
    }
    expect(isAiDailyLimitMessage(AI_FEATURE_NOT_IN_PLAN_FALLBACK_MESSAGE)).toBe(true);
    // 機能名が分からない 403 の本文はフォールバックの文
    expect(aiDailyLimitMessageOfBody({ code: 'AI_FEATURE_NOT_IN_PLAN', feature: 'consultation' })).toBe(AI_FEATURE_NOT_IN_PLAN_FALLBACK_MESSAGE);
    // 形だけ合う文・数を書き換えた文・ほかの機能名の文は通さない
    expect(isAiDailyLimitMessage('今日の写真の解析の利用回数の上限 (3 回) に達しました。明日 0 時から使えます。')).toBe(false);
    expect(isAiDailyLimitMessage('今日の献立の作成の利用回数の上限 (3 回) に達しました。')).toBe(false);
    expect(isAiDailyLimitMessage('写真の解析は、有料プランでお使いいただけます。')).toBe(false);
    expect(isAiDailyLimitMessage(null)).toBe(false);
  });

  it('aiDailyLimitMessageOfStatusAndBody returns a message only for 429 with an AI_DAILY_LIMIT body and 403 with an AI_FEATURE_NOT_IN_PLAN body (flat and nested), and null for 403 with an AI_DAILY_LIMIT body, 429 with an AI_FEATURE_NOT_IN_PLAN body, 429 RATE_LIMITED, 403 AI_CONSENT_REQUIRED, 200 and non-object bodies', () => {
    const daily = { code: 'AI_DAILY_LIMIT', limit: 3 };
    const locked = { code: 'AI_FEATURE_NOT_IN_PLAN', feature: 'image_generation' };
    expect(aiDailyLimitMessageOfStatusAndBody(429, daily)).toBe(aiDailyLimitMessage(3));
    expect(aiDailyLimitMessageOfStatusAndBody(429, { error: daily })).toBe(aiDailyLimitMessage(3));
    expect(aiDailyLimitMessageOfStatusAndBody(403, locked)).toBe(aiFeatureNotInPlanMessage('image_generation'));
    expect(aiDailyLimitMessageOfStatusAndBody(403, { error: locked })).toBe(aiFeatureNotInPlanMessage('image_generation'));
    expect(aiDailyLimitMessageOfStatusAndBody(403, daily)).toBeNull();
    expect(aiDailyLimitMessageOfStatusAndBody(429, locked)).toBeNull();
    expect(aiDailyLimitMessageOfStatusAndBody(429, { code: 'RATE_LIMITED', error: 'x' })).toBeNull();
    expect(aiDailyLimitMessageOfStatusAndBody(403, { code: 'AI_CONSENT_REQUIRED', error: 'x' })).toBeNull();
    expect(aiDailyLimitMessageOfStatusAndBody(403, { error: { code: 'LEGAL_CONSENT_REQUIRED' } })).toBeNull();
    expect(aiDailyLimitMessageOfStatusAndBody(200, daily)).toBeNull();
    expect(aiDailyLimitMessageOfStatusAndBody(200, locked)).toBeNull();
    for (const body of [null, undefined, 'AI_DAILY_LIMIT', 429, []]) expect(aiDailyLimitMessageOfStatusAndBody(429, body), String(body)).toBeNull();
  });

  it('aiDailyLimitMessageOfDenied returns the not-in-plan message for planLocked denials, so the Edge row error_message and the consultation action result carry it, and aiDailyLimitSkippedField returns {} for planLocked', () => {
    for (const feature of AI_PLAN_CAPPED_FEATURES) {
      const denied = { allowed: false as const, limit: 0, used: 0, usageDate: '2026-10-21', cappedFeature: feature, planLocked: true as const };
      expect(aiDailyLimitMessageOfDenied(denied), feature).toBe(aiFeatureNotInPlanMessage(feature));
      // 行の失敗の欄に書かれた文を、画面がそのまま出せる
      expect(isAiDailyLimitMessage(aiDailyLimitMessageOfDenied(denied)), feature).toBe(true);
      expect(aiDailyLimitSkippedField(denied), feature).toEqual({});
    }
    // 回数の上限 (planLocked なし) は今までどおり aiSkipped を付ける
    expect(aiDailyLimitSkippedField({ allowed: false, limit: 20, used: 20, usageDate: '2026-10-21', safetyCap: true, cappedFeature: 'meal_image_auto' })).toEqual({
      aiSkipped: AI_DAILY_LIMIT_CODE,
    });
    expect(aiDailyLimitMessageOfDenied({ limit: 3, cappedFeature: 'menu_generation' })).toBe(aiFeatureDailyLimitMessage('menu_generation', 3));
  });
});
