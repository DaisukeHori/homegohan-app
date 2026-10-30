// src/lib/admin/admin-create-no-response.ts
// 運営の画面の作成 (お知らせ・営業のリードの活動・DR 訓練の記録) の応答を受け取れなかったときに、
// 一覧を読み直して、送った内容の行ができていたかを決める (#2101 X2)。
//
// これらの作成の route は素の insert で (announcements・sales_lead_activities には主キーのほかに一意の制約が無く、
// DR 訓練の記録は毎回 admin_audit_logs に 1 行書く)、サーバーが済ませてから応答が切れたあとに押し直すと同じ行が 2 つできる。
// 画面は、応答を受け取れなかったら (fetch の reject・本文に API の文の無い 502 / 503 / 504。adminActionErrorOfResponse の AdminActionNoResponseError)
// 失敗とは言わずに一覧を読み直し、ここで行ができていたかを決める:
//   - created     : 送る前に無かった行で、送った内容と同じものがある → 済んだとして入力を空にする
//   - not-created : 送った内容と同じ行が、送る前に無かった行の中に無い → 入力を残し、押し直せるようにする
//   - ambiguous   : 送る前に一覧を読めていなかった (比べる元が無い) のに、送った内容と同じ行がある → 前からあった行か決められないので送信を止める
// 読み直しそのものに失敗したときは、画面が送信を止め、adminCreateUnconfirmedMessage の文で一覧で確かめさせる。
// 「送った時刻より後の行」を、ブラウザの時計ではなく送る前に無かった行で決める (ブラウザとサーバーの時計がずれていても、できた行を見落とさない。
// #2093 W1 の返信の isReplyDelivered と同じ考え方)。
//
// このファイルはブラウザからも読むので、サーバー専用のものを import しない。

/** 読み直した一覧に、送った内容の行ができていたか */
export type CreatedRowConfirmation = 'created' | 'not-created' | 'ambiguous';

/**
 * 読み直した一覧 (rows) に、送った内容 (isSameContent) の行ができていたかを決める。
 * knownIds は送る前に画面が持っていた一覧の行の id。送る前に一覧を読めていなかったときは null
 */
export function confirmCreatedRow<T extends { readonly id: string }>(
  rows: readonly T[],
  knownIds: ReadonlySet<string> | null,
  isSameContent: (row: T) => boolean,
): CreatedRowConfirmation {
  const sameContent = rows.filter(isSameContent);
  if (knownIds === null) return sameContent.length === 0 ? 'not-created' : 'ambiguous';
  return sameContent.some((row) => !knownIds.has(row.id)) ? 'created' : 'not-created';
}

/** 読み直したら送った内容の行ができていたときに続ける文 (「読み込み直したところ、お知らせは保存されていました」) */
export function adminCreateFoundGuide(subject: string): string {
  return `読み込み直したところ、${subject}は保存されていました`;
}

/** 読み直したら送った内容の行が無かったときに続ける文。画面は入力を残し、押し直せるようにする */
export function adminCreateNotFoundGuide(subject: string): string {
  return `読み込み直したところ、${subject}はまだ保存されていません。必要ならもう一度送ってください`;
}

/**
 * 送る前に一覧を読めていなかったのに、送った内容と同じ行があったときに続ける文 (ambiguous)。
 * 画面は送信を止めたままにする (読み直しを繰り返しても比べる元は無いので決まらない)
 */
export const ADMIN_CREATE_REOPEN_TO_RETRY_GUIDE = 'もう一度送るときは、画面を開き直してください';

/** 応答を受け取れなかったときの文の頭 (summary。adminActionNoResponseSummary の文) と、続きの文をつなぐ */
export function adminCreateNoResponseMessage(summary: string, ...guides: readonly string[]): string {
  return [summary, ...guides].join('。');
}
