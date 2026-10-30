// src/lib/admin/admin-create-no-response.ts
// 運営の画面の作成 (お知らせ・営業のリードの活動・DR 訓練の記録) の応答を受け取れなかったときに、
// 一覧を読み直して、送った内容の行ができていたかを決める (#2101 X2)。
//
// これらの作成の route は素の insert で (announcements・sales_lead_activities には主キーのほかに一意の制約が無く、
// DR 訓練の記録は毎回 admin_audit_logs に 1 行書く)、サーバーが済ませてから応答が切れたあとに押し直すと同じ行が 2 つできる。
// 画面は、応答を受け取れなかったら (fetch の reject・本文に API の文の無い 502 / 503 / 504。adminActionErrorOfResponse の AdminActionNoResponseError)
// 失敗とは言わずに一覧を読み直し、ここで行ができていたかを決める:
//   - created   : 送る前に無かった行で、送った内容と同じものがある → 済んだとして入力を空にし、送信の止めを外す
//   - not-found : 送った内容と同じ行が、送る前に無かった行の中にまだ無い → 送信を止めたままにし、「確かめ直す」で読み直せるようにする。
//                 行がまだ無いことは、作られていないことの確かめにならない (サーバーがまだ書き込みの途中なら、押し直すと 2 行になる)。
//                 押し直しは、一覧で確かめてから画面を開き直したときだけ (#2093 W1 の support/new・sales/new と同じ)
//   - ambiguous : 送る前に一覧を読めていなかった (比べる元が無い) のに、送った内容と同じ行がある → 前からあった行か決められないので送信を止める
//                 (読み直しを繰り返しても比べる元は無いので決まらない。「確かめ直す」は出さない)
// 読み直しそのものに失敗したときも、画面が送信を止め、adminCreateStoppedMessage の文で一覧で確かめさせる。
// 「送った時刻より後の行」を、ブラウザの時計ではなく送る前に無かった行で決める (ブラウザとサーバーの時計がずれていても、できた行を見落とさない。
// #2093 W1 の返信の isReplyDelivered と同じ考え方)。
//
// このファイルはブラウザからも読むので、サーバー専用のものを import しない。
import { adminCreateUnconfirmedMessage } from '@/lib/admin/admin-screen-messages';

/** 読み直した一覧に、送った内容の行ができていたか */
export type CreatedRowConfirmation = 'created' | 'not-found' | 'ambiguous';

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
  if (knownIds === null) return sameContent.length === 0 ? 'not-found' : 'ambiguous';
  return sameContent.some((row) => !knownIds.has(row.id)) ? 'created' : 'not-found';
}

/** 読み直したら送った内容の行ができていたときに続ける文 (「読み込み直したところ、お知らせは保存されていました」) */
export function adminCreateFoundGuide(subject: string): string {
  return `読み込み直したところ、${subject}は保存されていました`;
}

/**
 * 読み直しても送った内容の行がまだ無かったとき (not-found) に続ける文。
 * 行が無いことは作られていないことの確かめにならないので、押し直しを促さない。画面は送信を止めたまま「確かめ直す」を出す
 */
export function adminCreateNotFoundGuide(subject: string): string {
  return `読み込み直したところ、${subject}はまだ見つかりません。保存の途中のこともあるので、少し待ってから確かめ直してください`;
}

/** 送信を止めたときに、押し直す道を言う文 (画面を開き直すと、一覧を読み直したうえで送れる) */
export const ADMIN_CREATE_REOPEN_TO_RETRY_GUIDE = 'もう一度送るときは、画面を開き直してください';

/** 応答を受け取れなかったときの文の頭 (summary。adminActionNoResponseSummary の文) と、続きの文をつなぐ */
export function adminCreateNoResponseMessage(summary: string, ...guides: readonly string[]): string {
  return [summary, ...guides].join('。');
}

/**
 * 作成の応答を受け取れず、済んだと確かめられないので送信を止めたときの文 (読み直しの失敗・not-found・ambiguous)。
 * 「<summary>。済んだか分かりません。一覧で確かめてから作り直してください。<guides>。もう一度送るときは、画面を開き直してください」
 */
export function adminCreateStoppedMessage(summary: string, ...guides: readonly string[]): string {
  return adminCreateNoResponseMessage(adminCreateUnconfirmedMessage(summary), ...guides, ADMIN_CREATE_REOPEN_TO_RETRY_GUIDE);
}
