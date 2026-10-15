// src/lib/data-subject-requests/client-messages.ts
// #1178 個人情報の請求 (DSR) の画面で出す文 (画面側の helper。サーバーの core.ts には置かない。設計 cross/15 §9.1)。
// src/lib/account-self-service.ts の accountExportRateLimitedMessage と同じ式。

/** 秒を分に直すときの 1 分の秒数 */
const SECONDS_PER_MINUTE = 60;

/** 連打の上限 (429) に掛かったときに出す文。いつ再開できるかをサーバーの Retry-After (秒) から伝える */
export function dsrRateLimitedMessage(retryAfterSec: number | null): string {
  const wait =
    retryAfterSec !== null && retryAfterSec > 0 ? `${Math.ceil(retryAfterSec / SECONDS_PER_MINUTE)}分ほど` : 'しばらく';
  return `短い時間に請求の送信を繰り返したため、一時的に実行できません。${wait}待ってからもう一度お試しください。`;
}
