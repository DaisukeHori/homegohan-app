/**
 * Web の AI 相談 (src/components/AIChatBubble.tsx) の通信に時間の上限を付ける部品 (#2259 P1)。
 *
 * AI 相談は、通信の応答を待つ間に画面の操作を止める (『相談を終了』・新しい相談・相談の切り替え・送信。#2235 I8・#2245 K1・#2254 M1)。
 * 止めが下りるのは応答が返ったときなので、応答が返らない (通信が途中で止まった) と、ページを読み込み直すまで止まったままになった。
 * ここの上限を過ぎたら通信を打ち切り (AbortController)、時間切れの例外で終える。呼び出し側はそこで止めを下ろす。
 *
 * fetch が打ち切りに応じない (応答の本文の読み取りが止まったままなど) ときも、上限で必ず終える (打ち切りと同時に、時間切れの例外で
 * 待ちを終える)。このファイルはブラウザでだけ使う (サーバーの依存を import しない)。
 */

/** 1 秒のミリ秒 */
const MS_PER_SECOND = 1000;

/**
 * AI の route の maxDuration の最大 (秒)。src/app/api/ai/menu/v4/generate/route.ts・weekly/request・meal/generate などの 300。
 * サーバーはこの時間を過ぎると処理を打ち切って応答を返すので、これを過ぎても返らない応答は待っても返らない
 * (src/app/api/ai/ の route の maxDuration の最大と一致することを tests/ai-chat-request-time-limit-2259.test.ts が確かめる)
 */
export const AI_ROUTE_MAX_DURATION_SECONDS = 300;

/** サーバーが打ち切って返した応答が、通信を通って届くまでの余裕 (ミリ秒) */
const AI_CHAT_RESPONSE_MARGIN_MS = 15_000;

/**
 * 結果を待つ間に画面の操作を止める通信 (1日献立の作成の依頼の POST・提案の実行・『相談を終了』) を待つ上限の既定 (ミリ秒。#2259 P1)。
 * サーバーが打ち切る時間 (AI_ROUTE_MAX_DURATION_SECONDS) に通信の余裕を足した値。サーバーがまだ処理を続けうる間は打ち切らない
 * (打ち切ったあとにサーバーで実行・作成が済むことを減らす)
 */
export const AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS = AI_ROUTE_MAX_DURATION_SECONDS * MS_PER_SECOND + AI_CHAT_RESPONSE_MARGIN_MS;

/** 環境変数で上書きするときの下限 (ミリ秒)。これより短い値は、応答の通常の待ちまで打ち切るので受け付けない (既定に戻す) */
export const AI_CHAT_REQUEST_TIME_LIMIT_MIN_MS = MS_PER_SECOND;

/**
 * 環境変数 NEXT_PUBLIC_AI_CHAT_REQUEST_TIME_LIMIT_MS の値から上限 (ミリ秒) を決める。空・整数でない・下限より短い値は既定
 * (AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS)
 */
export function resolveAiChatRequestTimeLimitMs(raw: string | undefined): number {
  const trimmed = raw?.trim() ?? '';
  if (!/^\d+$/.test(trimmed)) return AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= AI_CHAT_REQUEST_TIME_LIMIT_MIN_MS ? value : AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS;
}

/**
 * 結果を待つ間に画面の操作を止める通信を待つ上限 (ミリ秒。#2259 P1)。運用で変えるときは NEXT_PUBLIC_AI_CHAT_REQUEST_TIME_LIMIT_MS
 * (ビルド時に埋め込まれるので、変えたら再デプロイする)
 */
export const AI_CHAT_REQUEST_TIME_LIMIT_MS = resolveAiChatRequestTimeLimitMs(process.env.NEXT_PUBLIC_AI_CHAT_REQUEST_TIME_LIMIT_MS);

/** 上限を過ぎて打ち切ったときの例外の文 (useV4MenuGeneration の onError に渡る。AI 相談はこの文で時間切れを見分ける) */
export const CONSULTATION_REQUEST_TIMEOUT_ERROR_MESSAGE = '応答が時間内に返りませんでした';

/** 上限を過ぎて打ち切ったことを表す例外 (name はブラウザの AbortSignal.timeout と同じ TimeoutError) */
export class ConsultationRequestTimeoutError extends Error {
  constructor() {
    super(CONSULTATION_REQUEST_TIMEOUT_ERROR_MESSAGE);
    this.name = 'TimeoutError';
  }
}

/** 時間切れ (この部品の上限・AbortSignal.timeout) か、打ち切り (AbortError) で終わったか */
export function isConsultationRequestTimeout(error: unknown): boolean {
  if (error instanceof ConsultationRequestTimeoutError) return true;
  const name = error !== null && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * run を timeLimitMs を上限に走らせる。run には打ち切りの signal を渡す (fetch に渡す。応答の本文を読むところまで run の中で行う)。
 * 上限を過ぎたら signal を打ち切り、ConsultationRequestTimeoutError で終える。上限の予約は、終わったら (成功・失敗・時間切れ) 取り消す
 */
export async function withinConsultationRequestTimeLimit<T>(
  timeLimitMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // 時間切れの例外を先に決めてから打ち切る (打ち切りで run がすぐ失敗しても、待ちの結果は時間切れの例外にする。
      // 逆の順だと、fetch の AbortError が先に届き、呼び出し側が時間切れの文で見分けられない)
      reject(new ConsultationRequestTimeoutError());
      controller.abort();
    }, timeLimitMs);
  });
  const running = run(controller.signal);
  // 時間切れで先に終えたあとに、打ち切られた run が失敗で終わっても、未処理の失敗にしない
  running.catch(() => {});
  try {
    return await Promise.race([running, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
