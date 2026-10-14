/**
 * AI 相談の送信 (POST /api/ai/consultation/sessions/:id/messages?stream=true) を待つ上限 (ミリ秒) (#1049 F7-18)。
 *
 * サーバーは AI への問い合わせを 25 秒で打ち切る (AbortSignal.timeout(25000)。
 * src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts) ので、それに通信の余裕 1 秒を足した値。
 * React Native の fetch は応答を最後まで受け取ってから返す (ストリームを少しずつ読めない) ので、
 * この時間は「返答が全部届くまで」の上限になる。超えて打ち切っても、サーバーでは返答の保存が続いていることがあるため、
 * 画面は打ち切ったあとに会話を取り直せるようにする (AIAdvisorSheet の「最新の会話を読み込む」)。
 */
export const AI_CHAT_STREAM_TIMEOUT_MS = 26_000;
