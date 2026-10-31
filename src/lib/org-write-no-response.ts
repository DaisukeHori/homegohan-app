/**
 * 組織の管理画面 (src/app/(org)) で、書き込み (チャレンジの作成・状態の変更、招待の送信・取り消し、部署の追加・更新・削除、
 * メンバーの除名) の通信そのものが失敗した (fetch が reject した: オフライン・接続が切れたなど) ときに出す文 (#2080 U4)。
 *
 * 応答を受け取れないので、操作がサーバーで済んだかどうかは応答からは分からない。サーバーが操作を済ませてから応答が切れたことも
 * あるので、画面は一覧を読み直して今の状態を見せる。そのため文は「できませんでした」「失敗しました」と言わない
 * (読み直した一覧で操作が済んでいたときにも事実と合う文にする)。運営の画面 (#2076) の
 * src/lib/super-admin/status-change-no-response.ts と同じ文の形にそろえる。
 * 読み直しが失敗したときは、一覧の「読み込めませんでした」と「再試行」が出るので、「再試行」で読み直すよう促す。
 */
import {
  NO_RESPONSE_LIST_RELOAD_FAILED_GUIDE,
  NO_RESPONSE_LIST_RELOADED_GUIDE,
  statusChangeNoResponseMessage,
} from '@/lib/super-admin/status-change-no-response';

/** 書き込みの通信が reject したあとの、一覧の読み直しの結果 */
export type OrgListReloadResult = 'reloaded' | 'reload_failed';

/** 操作の名前 (文の頭の「<操作>の応答を受け取れませんでした」に入る) */
export const ORG_WRITE_OPERATION = {
  challengeCreate: 'チャレンジの作成',
  challengeStatusChange: 'チャレンジの状態の変更',
  inviteCreate: '招待の送信',
  inviteRevoke: '招待の取り消し',
  departmentCreate: '部署の追加',
  departmentUpdate: '部署の更新',
  departmentDelete: '部署の削除',
  memberRemove: '除名',
} as const;

export type OrgWriteOperation = (typeof ORG_WRITE_OPERATION)[keyof typeof ORG_WRITE_OPERATION];

/**
 * 書き込みの通信が reject したときの文。読み直しの結果で後半の案内を出し分ける
 *   - 読み直せた: 「一覧を読み込み直したので、今の状態を確かめてから、必要ならもう一度操作してください」
 *   - 読み直せなかった: 「一覧を読み込めませんでした。「再試行」で読み込み直してから、もう一度操作してください」
 */
export function orgWriteNoResponseMessage(operation: OrgWriteOperation, reload: OrgListReloadResult): string {
  return statusChangeNoResponseMessage(
    operation,
    reload === 'reloaded' ? NO_RESPONSE_LIST_RELOADED_GUIDE : NO_RESPONSE_LIST_RELOAD_FAILED_GUIDE,
  );
}

/**
 * 書き込みの通信が reject し、一覧の読み直しにも失敗したときの文 (orgWriteNoResponseMessage(…, 'reload_failed')) か (#2086 V9)。
 * この文は「「再試行」で読み込み直してから…」と促すので、「再試行」で一覧を読み直せたら画面から消す。そのために見分ける。
 * ほかの文 (読み直せたときの文・応答が届いたうえでの失敗の理由など) は消さない (false)。
 */
export function isOrgWriteReloadFailedMessage(message: string | null): boolean {
  if (message === null) return false;
  return Object.values(ORG_WRITE_OPERATION).some(
    (operation) => orgWriteNoResponseMessage(operation, 'reload_failed') === message,
  );
}
