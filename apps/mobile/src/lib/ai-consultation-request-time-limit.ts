/**
 * モバイルの AI 相談 (src/components/ai/AIAdvisorSheet.tsx) のアーカイブ (POST /api/ai/consultation/sessions/:id/close) を待つ
 * 時間の上限 (#2265 Q1)。
 *
 * アーカイブは応答を待つ間、送信・新しい相談・相談の切り替え・取り直しを止める (#2227 H1・#2235 I7)。止めが下りるのは応答が
 * 返ったときなので、応答が返らない (通信が途中で止まった) と、アプリを開き直すまで止まったままになった。Web の『相談を終了』は
 * #2259 P1 で上限を付けた (src/lib/ai/consultation-request-time-limit.ts)。モバイルはルートの src/ を import できない
 * (リポジトリ直下の .easignore が /src/ を除外し、EAS のビルドのアーカイブに入らない。tests/mobile-easignore-bundle-inputs.test.ts)
 * ので、同じ値・同じ判定をここに置く。値と判定が Web と一致することは tests/mobile-ai-archive-time-limit-2265.test.ts が
 * Web の部品と突き合わせて確かめる。
 *
 * 上限を過ぎたら通信を打ち切り (AbortController)、時間切れの例外で終える。呼び出し側はそこで止めを下ろす。fetch が打ち切りに
 * 応じない (応答の本文の読み取りが止まったままなど) ときも、上限で必ず終える。
 */

/** 1 秒のミリ秒 */
const MS_PER_SECOND = 1000;

/**
 * AI の route の maxDuration の最大 (秒)。Web の AI_ROUTE_MAX_DURATION_SECONDS と同じ値 (src/app/api/ai/ の route の 300)。
 * サーバーはこの時間を過ぎると処理を打ち切って応答を返すので、これを過ぎても返らない応答は待っても返らない
 */
export const AI_ROUTE_MAX_DURATION_SECONDS = 300;

/** サーバーが打ち切って返した応答が、通信を通って届くまでの余裕 (ミリ秒。Web と同じ値) */
export const AI_CHAT_RESPONSE_MARGIN_MS = 15_000;

/**
 * 結果を待つ間に画面の操作を止める通信 (アーカイブ) を待つ上限の既定 (ミリ秒)。Web の AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS と
 * 同じ値。サーバーが打ち切る時間に通信の余裕を足した値で、サーバーがまだ処理を続けうる間は打ち切らない
 * (打ち切ったあとにサーバーでアーカイブが済むことを減らす)
 */
export const AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS = AI_ROUTE_MAX_DURATION_SECONDS * MS_PER_SECOND + AI_CHAT_RESPONSE_MARGIN_MS;

/** 環境変数で上書きするときの下限 (ミリ秒。Web と同じ値)。これより短い値は、応答の通常の待ちまで打ち切るので受け付けない (既定に戻す) */
export const AI_CHAT_REQUEST_TIME_LIMIT_MIN_MS = MS_PER_SECOND;

/**
 * 環境変数の値から上限 (ミリ秒) を決める (Web の resolveAiChatRequestTimeLimitMs と同じ判定)。空・整数でない・下限より短い値は既定
 * (AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS)
 */
export function resolveAiChatRequestTimeLimitMs(raw: string | undefined): number {
  const trimmed = raw?.trim() ?? "";
  if (!/^\d+$/.test(trimmed)) return AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= AI_CHAT_REQUEST_TIME_LIMIT_MIN_MS ? value : AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS;
}

/**
 * アーカイブを待つ上限 (ミリ秒)。運用で変えるときは EXPO_PUBLIC_AI_CHAT_REQUEST_TIME_LIMIT_MS (ビルド時に埋め込まれるので、
 * 変えたらアプリをビルドし直す。Web の NEXT_PUBLIC_AI_CHAT_REQUEST_TIME_LIMIT_MS とは別の変数なので、Web を変えたらこちらもそろえる)。
 * 名前は直接書く (Metro が値へ置き換えるのはこの書き方だけ。src/lib/env.ts の説明)
 */
export const AI_CHAT_REQUEST_TIME_LIMIT_MS = resolveAiChatRequestTimeLimitMs(process.env.EXPO_PUBLIC_AI_CHAT_REQUEST_TIME_LIMIT_MS);

/** 上限を過ぎて打ち切ったときの例外の文 (Web の CONSULTATION_REQUEST_TIMEOUT_ERROR_MESSAGE と同じ) */
export const CONSULTATION_REQUEST_TIMEOUT_ERROR_MESSAGE = "応答が時間内に返りませんでした";

/** 上限を過ぎて打ち切ったことを表す例外 (name は AbortSignal.timeout と同じ TimeoutError。Web と同じ) */
export class ConsultationRequestTimeoutError extends Error {
  constructor() {
    super(CONSULTATION_REQUEST_TIMEOUT_ERROR_MESSAGE);
    this.name = "TimeoutError";
  }
}

/** 時間切れ (この部品の上限・AbortSignal.timeout) か、打ち切り (AbortError) で終わったか (Web の isConsultationRequestTimeout と同じ判定) */
export function isConsultationRequestTimeout(error: unknown): boolean {
  if (error instanceof ConsultationRequestTimeoutError) return true;
  const name = error !== null && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * run を timeLimitMs を上限に走らせる (Web の withinConsultationRequestTimeLimit と同じ)。run には打ち切りの signal を渡す
 * (fetch に渡す。応答の本文を読むところまで run の中で行う)。上限を過ぎたら signal を打ち切り、ConsultationRequestTimeoutError で
 * 終える。上限の予約は、終わったら (成功・失敗・時間切れ) 取り消す
 */
export async function withinConsultationRequestTimeLimit<T>(
  timeLimitMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // 時間切れの例外を先に決めてから打ち切る (打ち切りで run がすぐ失敗しても、待ちの結果は時間切れの例外にする)
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

/**
 * アーカイブの応答が上限 (AI_CHAT_REQUEST_TIME_LIMIT_MS) までに返らなかったときに出す文 (Web の CLOSE_SESSION_TIMEOUT_MESSAGE と
 * 同じ扱い。モバイルは『相談を終了』をアーカイブと呼ぶので語だけ合わせる)。サーバーでアーカイブが済んでいることがあるので、
 * 『アーカイブに失敗しました』とは言い切らず、相談の一覧で確かめてもらう
 */
export const ARCHIVE_SESSION_TIMEOUT_TITLE = "タイムアウト";
export const ARCHIVE_SESSION_TIMEOUT_MESSAGE =
  "アーカイブできたかを確かめられませんでした。相談の一覧で確かめてから、もう一度お試しください。";
