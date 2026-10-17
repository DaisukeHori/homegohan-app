/**
 * #99 ローカル通知ヘルパー (フォアグラウンド専用)
 *
 * ブラウザ Notification API を使ってフォアグラウンド通知を表示する。
 * バックグラウンド Push (Service Worker) は別 issue へ。
 *
 * 使い方:
 *   import { showLocalNotification, requestNotificationPermission } from '@/lib/local-notification';
 *   await requestNotificationPermission();
 *   showLocalNotification({ title: '献立生成完了', body: '今日の献立が揃いました！' });
 */

import { APP_ICON_192_PATH } from '@/lib/brand-asset-paths';

/**
 * 通知のアイコンの既定値。src/app/icon-192.png/route.ts が返す PNG (#1845。以前は存在しない /icon-192x192.png を指していた)。
 * パスは src/lib/brand-asset-paths.ts の APP_ICON_192_PATH (#1853。ハンズオンツアーの画面と同じ定数)。
 * 指す先が実在することは tests/metadata-public-paths-1845.test.ts が検査する。
 */
export const DEFAULT_NOTIFICATION_ICON = APP_ICON_192_PATH;

/** 献立の生成が終わった通知を、自動で閉じるまでの時間 (ミリ秒) */
const MENU_GENERATED_AUTO_CLOSE_MS = 8_000;
/** 記録のリマインダーの通知を、自動で閉じるまでの時間 (ミリ秒) */
const CHECKIN_REMINDER_AUTO_CLOSE_MS = 10_000;

export type LocalNotificationOptions = {
  title: string;
  body?: string;
  icon?: string;
  tag?: string;
  /** ms 後に自動クローズ。undefined の場合は自動クローズしない */
  autoCloseMs?: number;
};

/** 通知パーミッションをリクエストし、結果を返す */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'denied';
  }
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.requestPermission();
}

/** 現在のパーミッション状態を返す */
export function getNotificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

/**
 * フォアグラウンド通知を表示する。
 * パーミッションが granted でない場合は何もしない（エラーにしない）。
 */
export function showLocalNotification(options: LocalNotificationOptions): Notification | null {
  if (typeof window === 'undefined' || !('Notification' in window)) return null;
  if (Notification.permission !== 'granted') return null;

  const { title, body, icon = DEFAULT_NOTIFICATION_ICON, tag, autoCloseMs } = options;
  const notification = new Notification(title, { body, icon, tag });

  if (autoCloseMs !== undefined) {
    setTimeout(() => notification.close(), autoCloseMs);
  }

  return notification;
}

/** 献立生成完了通知 */
export function notifyMenuGenerated(date?: string): Notification | null {
  const body = date ? `${date} の献立が揃いました！` : '今日の献立が揃いました！';
  return showLocalNotification({
    title: 'ほめゴハン',
    body,
    tag: 'menu-generated',
    autoCloseMs: MENU_GENERATED_AUTO_CLOSE_MS,
  });
}

/** チェックインリマインダー通知 */
export function notifyCheckinReminder(): Notification | null {
  return showLocalNotification({
    title: 'ほめゴハン — 記録を忘れずに',
    body: '今日の食事を記録しましょう！',
    tag: 'checkin-reminder',
    autoCloseMs: CHECKIN_REMINDER_AUTO_CLOSE_MS,
  });
}
