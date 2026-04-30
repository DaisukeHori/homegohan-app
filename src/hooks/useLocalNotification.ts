/**
 * #99 useLocalNotification — 通知許可リクエスト & 表示 hook
 *
 * - notifications_enabled 設定が ON のときだけ通知を表示する
 * - 初回 ON 操作時にブラウザのパーミッションダイアログを開く
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  requestNotificationPermission,
  getNotificationPermission,
  showLocalNotification,
  type LocalNotificationOptions,
} from '@/lib/local-notification';

export function useLocalNotification(notificationsEnabled: boolean) {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default');

  useEffect(() => {
    setPermission(getNotificationPermission());
  }, []);

  /** 通知を有効化する（パーミッションリクエスト含む） */
  const enable = useCallback(async () => {
    const result = await requestNotificationPermission();
    setPermission(result);
    return result;
  }, []);

  /** 通知を表示する（enabled && granted のときのみ） */
  const notify = useCallback(
    (options: LocalNotificationOptions) => {
      if (!notificationsEnabled) return null;
      if (permission !== 'granted') return null;
      return showLocalNotification(options);
    },
    [notificationsEnabled, permission],
  );

  return { permission, enable, notify };
}
