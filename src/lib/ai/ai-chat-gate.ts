/**
 * AI 相談 (/api/ai/consultation/**) の緊急停止スイッチ (#1148)
 *
 * feature_flags の ai_chat_enabled が OFF のとき、AI 相談の API は 503 とやさしい文面を返す。
 * これは「緊急に止めたいとき」だけの非常ボタンで、通常は ON のまま。利用者の同意の有無で AI への送信を止めるのは
 * このスイッチではなく、同意の判定 requireAiConsent / checkUserAiConsent (src/lib/ai/consent-guard.ts、#1154) が担う
 * (このスイッチが ON でも、未同意の利用者のデータは AI へ送らない)。そのため:
 *   - 既定値は ON。フラグの行が無い・読み出しに失敗した・待ちきれなかったときも ON として動く
 *     (src/lib/feature-flags.ts の FEATURE_FLAG_DEFAULTS。読み出しの失敗は構造化ログに残る)
 *   - OFF にできるのは、運営 (super_admin) が運営画面 /super-admin/flags で明示的に切り替えたときだけ
 *
 * 止めるのは、AI に送る・AI が提案した操作を実行する API だけ:
 *   POST /api/ai/consultation/sessions                         新しい相談の開始
 *   POST /api/ai/consultation/sessions/[sessionId]/messages    メッセージ送信 (AI の応答)
 *   POST /api/ai/consultation/sessions/[sessionId]/summarize   要約の生成
 *   POST /api/ai/consultation/sessions/[sessionId]/close       相談の終了 (要約の生成を含む)
 *   POST /api/ai/consultation/actions/[actionId]/execute       AI が提案した操作の実行
 * 過去の相談の閲覧 (GET)・重要マークの付け外し・提案の却下 (DELETE) は、AI を呼ばないので止めない。
 *
 * 使い方 (認証のあと、レート制限の前に呼ぶ。止まっている間は、利用者の回数の枠を使わせない):
 *   const unavailable = await aiChatDisabledResponse(user.id);
 *   if (unavailable) return unavailable;
 */
import { NextResponse } from 'next/server';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { AI_CHAT_DISABLED_CODE, AI_CHAT_DISABLED_MESSAGE } from '@/lib/ai/ai-chat-unavailable';

export { AI_CHAT_DISABLED_CODE, AI_CHAT_DISABLED_MESSAGE };

export const AI_CHAT_FLAG_KEY = 'ai_chat_enabled';
/** クライアントに「このくらいあとで試して」と伝える目安 (秒)。フラグのキャッシュ (30 秒) より少し長い */
export const AI_CHAT_RETRY_AFTER_SECONDS = 60;

/**
 * ai_chat_enabled が OFF なら 503 のレスポンスを返す。ON (読み出しに失敗したときを含む) なら null。
 * 本文は { error, code: 'AI_CHAT_DISABLED', retryAfter } (429 の { error, code, retryAfter } と同じ形)。
 *
 * @param userId 認証で確定したユーザー ID
 */
export async function aiChatDisabledResponse(userId: string): Promise<NextResponse | null> {
  if (await isFeatureEnabled(AI_CHAT_FLAG_KEY, userId)) return null;

  return NextResponse.json(
    {
      error: AI_CHAT_DISABLED_MESSAGE,
      code: AI_CHAT_DISABLED_CODE,
      retryAfter: AI_CHAT_RETRY_AFTER_SECONDS,
    },
    {
      status: 503,
      headers: {
        'Retry-After': String(AI_CHAT_RETRY_AFTER_SECONDS),
        'Cache-Control': 'private, no-store',
      },
    },
  );
}
