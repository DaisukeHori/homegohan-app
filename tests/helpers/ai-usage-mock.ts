/**
 * テスト用: AI の利用回数の上限の判定 (consumeAiUsage / consumeEdgeAiUsage。#1149) を差し替えるときの結果
 *
 * route や Edge Function の単体テストは、DB を呼ぶ境目 (consumeAiUsage) だけを差し替え、許可 (AI_USAGE_ALLOWED) か
 * 止め (AI_USAGE_DENIED) を返す。止めたときの応答 (aiDailyLimitResponse) などは本物を使う。
 * 判定そのものの挙動は src/__tests__/lib/plan/entitlements.test.ts と tests/integration/rls/ai-daily-limit-rpc.test.ts。
 */
import type { AiUsageAllowed, AiUsageDenied } from '../../supabase/functions/_shared/ai-daily-limit';

/** テストの上限の回数 (既定の free = 1 日 10 回と同じ) */
export const TEST_AI_DAILY_LIMIT = 10;
/** テストの数えた日 (JST) */
export const TEST_AI_USAGE_DATE = '2026-10-11';

/** 許可 (上限に数えて 1 回目) */
export const AI_USAGE_ALLOWED: AiUsageAllowed = Object.freeze({
  allowed: true,
  metered: true,
  usageDate: TEST_AI_USAGE_DATE,
  limit: TEST_AI_DAILY_LIMIT,
  used: 1,
});

/** 止め (上限に達している。記録していない) */
export const AI_USAGE_DENIED: AiUsageDenied = Object.freeze({
  allowed: false,
  limit: TEST_AI_DAILY_LIMIT,
  used: TEST_AI_DAILY_LIMIT,
  usageDate: TEST_AI_USAGE_DATE,
});
