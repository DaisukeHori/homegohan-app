/**
 * 運営の画面で、状態の変更 (プランの公開・クーポンの一時停止・機能パッケージの廃止・A/B テストの開始・機能フラグの切り替え など) の
 * 通信そのものが失敗した (fetch が reject した: オフライン・接続が切れたなど) ときに出す文 (#2073)。
 *
 * 応答を受け取れないので、変更がサーバーで済んだかどうかは応答からは分からない。サーバーが変更を済ませてから応答が切れたことも
 * あるので、画面は今の状態を読み直して見せる。文は「できませんでした」とも「別の運営が先に変えた」とも言わない
 * (自分の操作が済んでいたときにも事実と合う文にする)。読み直しが失敗したときは「再試行」で読み直すよう促す。
 */

/** 文の頭。operation は操作の名前 (「一時停止」「廃止」「状態の変更」など) */
export function statusChangeNoResponseSummary(operation: string): string {
  return `${operation}の応答を受け取れませんでした（通信エラー）`;
}

/** 詳細の画面: 今の状態を読み直せたときに続ける文 */
export const NO_RESPONSE_STATE_RELOADED_GUIDE =
  '今の状態を読み込み直したので、状態を確かめてから、必要ならもう一度操作してください';

/** 詳細の画面: 今の状態の読み直しにも失敗したときに続ける文 (「再試行」を出す) */
export const NO_RESPONSE_STATE_RELOAD_FAILED_GUIDE =
  '今の状態を読み込めませんでした。「再試行」で読み込み直してから、もう一度操作してください';

/** 一覧の画面: 一覧を読み直せたときに続ける文 */
export const NO_RESPONSE_LIST_RELOADED_GUIDE =
  '一覧を読み込み直したので、今の状態を確かめてから、必要ならもう一度操作してください';

/** 一覧の画面: 一覧の読み直しにも失敗したときに続ける文 (「再試行」を出す) */
export const NO_RESPONSE_LIST_RELOAD_FAILED_GUIDE =
  '一覧を読み込めませんでした。「再試行」で読み込み直してから、もう一度操作してください';

/** 文の頭と、読み直しの結果に合わせた続きの文をつなぐ */
export function statusChangeNoResponseMessage(operation: string, guide: string): string {
  return `${statusChangeNoResponseSummary(operation)}。${guide}`;
}
