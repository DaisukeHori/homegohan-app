/**
 * サーバーから送る Push 通知の種類 (kind) と、種類ごとの方針 (#1136)。
 * サーバー (src/lib/push)・モバイル (将来の種類ごとの受け取り設定)・テストで同じ値を使うための、純粋な定数だけのファイル。
 * 文面 (title / body) はサーバーの src/lib/push/render.ts にあり、ここには置かない。
 * 種類を足すときは、ここに 1 行、render.ts に文面、発火元 (RPC enqueue_push_notification を呼ぶトリガーかコード) を足す
 * (docs/design/mobile/06-push-send.md §3.2)。行き先 path は apps/mobile/src/lib/notificationRoute.ts の NOTIFICATION_ROUTES にある画面だけ
 * (tests/push-kinds-routes-contract.test.ts が突き合わせる)。
 */

/** 最初に出す種類 (第 1 段)。後回しの種類は設計書 §3.2 */
export const PUSH_NOTIFICATION_KINDS = ['weekly_menu_completed', 'weekly_menu_failed'] as const;
export type PushNotificationKind = (typeof PUSH_NOTIFICATION_KINDS)[number];

/** Quiet Hours (夜間) の扱い。send = 夜でも送る / defer = 夜の終わりまで待つ */
export type PushQuietHoursPolicy = 'send' | 'defer';

export interface PushNotificationKindSpec {
  readonly kind: PushNotificationKind;
  /** 設定画面などに出す日本語の名前 */
  readonly label: string;
  /** 通知をタップしたときに開くアプリ内のパス (NOTIFICATION_ROUTES にある画面だけ) */
  readonly path: string;
  readonly quietHours: PushQuietHoursPolicy;
  /** Expo に渡す ttl (秒)。届かないまま過ぎたら捨てられる */
  readonly ttlSeconds: number;
  readonly priority: 'default' | 'high';
}

/** 献立の結果の通知の ttl。利用者が自分で頼んだ献立の結果は、翌日まで届けば十分 */
const MENU_RESULT_TTL_SECONDS = 24 * 60 * 60;
/** 献立のタブ (apps/mobile/app/(tabs)/menus.tsx。タブの WebView が Web の /menus/weekly を出す) */
const MENUS_TAB_PATH = '/menus';

export const PUSH_NOTIFICATION_KIND_SPECS: Readonly<Record<PushNotificationKind, PushNotificationKindSpec>> = {
  weekly_menu_completed: {
    kind: 'weekly_menu_completed',
    label: '献立ができたとき',
    path: MENUS_TAB_PATH,
    // 利用者が自分で頼んだ結果で、待っている間に届くことに意味がある (夜に頼んだ人は夜に受け取る)
    quietHours: 'send',
    ttlSeconds: MENU_RESULT_TTL_SECONDS,
    priority: 'default',
  },
  weekly_menu_failed: {
    kind: 'weekly_menu_failed',
    label: '献立を作れなかったとき',
    path: MENUS_TAB_PATH,
    quietHours: 'send',
    ttlSeconds: MENU_RESULT_TTL_SECONDS,
    priority: 'default',
  },
};

export function isPushNotificationKind(value: unknown): value is PushNotificationKind {
  return typeof value === 'string' && (PUSH_NOTIFICATION_KINDS as readonly string[]).includes(value);
}
