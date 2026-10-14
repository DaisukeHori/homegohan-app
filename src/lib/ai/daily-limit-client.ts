/**
 * AI の 1 日の利用回数の上限 (#1149 / T40): サーバーに「今日の上限に達しました」で止められたことを画面に伝える部品 (ブラウザ用)
 *
 * AI へ送る API は、上限に達していれば送らずに 429 { error, code: 'AI_DAILY_LIMIT', limit, retryAfter } を返す
 * (src/lib/plan/entitlements.ts の aiDailyLimitResponse / supabase/functions/_shared/ai-usage.ts の aiDailyLimitEdgeResponse)。
 *   - 利用者が始めた AI の操作の fetch (aiFetch。src/lib/ai/consent-required.ts) は、この応答を見つけたら window に
 *     AI_DAILY_LIMIT_EVENT を出す。全画面共通の AiDailyLimitHost (src/components/consent/AiDailyLimitHost.tsx) が固定の文を出す
 *   - 画面を開くと自動で AI に送る処理 (栄養士のコメントの「再分析」など) は、aiDailyLimitMessageOfResponse で文を受け取り、
 *     AI の部分の代わりに出す
 * 文は本文の error をそのまま出さず、limit から作る (supabase/functions/_shared/ai-daily-limit.ts の aiDailyLimitMessageOfBody)。
 */
import { AI_DAILY_LIMIT_STATUS, aiDailyLimitMessageOfBody } from '../../../supabase/functions/_shared/ai-daily-limit';

/** 「今日の上限に達しました」で止められたことを知らせる window のイベント (detail は画面に出す文) */
export const AI_DAILY_LIMIT_EVENT = 'homegohan:ai-daily-limit';

/** 応答が「上限に達して止めた」(429 + AI_DAILY_LIMIT) なら、画面に出す文を返す。本文は clone して読むので、呼び出し側はあとで本文を読める */
export async function aiDailyLimitMessageOfResponse(res: Response): Promise<string | null> {
  if (res.status !== AI_DAILY_LIMIT_STATUS) return null;
  try {
    return aiDailyLimitMessageOfBody(await res.clone().json());
  } catch {
    return null;
  }
}

/** 上限の案内を出すよう、全画面共通の AiDailyLimitHost に知らせる */
export function notifyAiDailyLimit(message: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<string>(AI_DAILY_LIMIT_EVENT, { detail: message }));
}
