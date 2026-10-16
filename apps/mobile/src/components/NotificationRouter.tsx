/**
 * プッシュ通知の受け取り口 (#1049 F7-11)。app/_layout.tsx が、Provider の内側に 1 つだけ置く。
 *
 * 以前は setNotificationHandler も addNotificationResponseReceivedListener も無く、
 *   - アプリを開いている間 (フォアグラウンド) に届いた通知は、バナーも出ずに気づけなかった
 *   - 通知をタップしてもアプリが開くだけで、通知の画面へ移らなかった
 *
 * ここでは次の 2 つを、置かれている間だけ有効にする (外されたら解除する)。
 *   1. フォアグラウンドの通知の表示: バナー・通知センター・音・バッジ (docs/design/mobile/03-push-notification.md §3.5 / §3.8)
 *   2. 通知のタップ: 通知の data の行き先 (src/lib/notificationRoute.ts の resolveNotificationHref) へ遷移する。
 *      受け取る経路は 2 つ (どちらも同じ処理に流す)
 *        - アプリが動いている間 (フォアグラウンド・バックグラウンド) のタップ: addNotificationResponseReceivedListener
 *        - アプリが終了していて、通知のタップで起動したとき: getLastNotificationResponseAsync
 *
 * 遷移は、ログインの状態と、今のユーザーのプロフィール (初期設定が済んだか) が分かってから行う。
 * 起動の直後に遷移すると、未ログイン・初期設定の前の利用者を通知の画面へ通してしまうため。
 *   - 未ログインなら、行き先を捨てる (ログイン画面からの流れに任せる)
 *   - 初期設定が済んでいなければ、行き先を捨てる (初期設定の流れに任せる)
 *   - ProfileProvider は、ログインの直後の一瞬 profile=null・isLoading=false になる (新しいユーザーの読み込みは
 *     その描画の後に始まる)。この間を「初期設定が済んでいない」と取り違えて捨てないよう、今のユーザーの
 *     プロフィールが読めるまで待つ
 *   - 規約の同意の状態が決まり (#1442)、前面が同意画面でも入口でもなくなってから移る
 *     (同意が要る間は LegalConsentGate が同意画面 1 つに畳み、同意の後に入口へ移す。そこへ push を重ねない)
 */

import * as Notifications from "expo-notifications";
import { router, usePathname } from "expo-router";
import { useEffect, useRef, useState } from "react";

import { ENTRY_SCREEN_PATH, isNavigationHeldForLegalConsent } from "../lib/legal-consent";
import { resolveNotificationHref } from "../lib/notificationRoute";
import { useAuth } from "../providers/AuthProvider";
import { useLegalConsent } from "../providers/LegalConsentProvider";
import { useProfile } from "../providers/ProfileProvider";

/** フォアグラウンドで届いた通知の扱い。バナーと通知センターに出し、音を鳴らし、バッジ (サーバーが数えた値) を付ける */
const FOREGROUND_NOTIFICATION_BEHAVIOR: Notifications.NotificationBehavior = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: true,
};

export function NotificationRouter() {
  const { session, isLoading: authLoading } = useAuth();
  const { profile, isLoading: profileLoading } = useProfile();
  const { state: legalConsentState } = useLegalConsent();
  const pathname = usePathname();
  // タップされた通知の行き先 (まだ遷移していないもの)
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  // 同じ通知のタップを 2 回扱わない (起動時の取得とリスナーの両方に届くことがある)
  const handledIds = useRef<Set<string>>(new Set());

  // 1. フォアグラウンドの通知の表示 (外されたら既定 = 表示しない に戻す)
  useEffect(() => {
    Notifications.setNotificationHandler({
      handleNotification: async () => FOREGROUND_NOTIFICATION_BEHAVIOR,
    });
    return () => {
      Notifications.setNotificationHandler(null);
    };
  }, []);

  // 2. 通知のタップの受け取り (外されたらリスナーを外す)
  useEffect(() => {
    let active = true;

    const onResponse = (response: Notifications.NotificationResponse) => {
      // 通知そのもののタップだけを扱う (通知のボタンの操作・通知を消した操作は対象外)
      if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      const id = response.notification.request.identifier;
      if (handledIds.current.has(id)) return;
      handledIds.current.add(id);

      const href = resolveNotificationHref(response.notification.request.content.data);
      if (href) setPendingHref(href);
      // 次の起動で同じタップをもう一度扱わないよう、OS に残っている「最後のタップ」を消す
      Notifications.clearLastNotificationResponseAsync().catch(() => {});
    };

    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (active && response) onResponse(response);
      })
      .catch(() => {
        // 取れなくても、アプリはそのまま開く
      });
    const subscription = Notifications.addNotificationResponseReceivedListener(onResponse);

    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  // 3. 遷移してよい状態になったら、行き先へ移る
  useEffect(() => {
    if (!pendingHref || authLoading) return;
    if (!session) {
      setPendingHref(null);
      return;
    }
    // 今のユーザーのプロフィールが読めるまで待つ (読み込み中・ログイン直後の一瞬の null・前のユーザーの残り)
    if (profileLoading || !profile || profile.id !== session.user.id) return;
    // #1442: 同意の状態が決まるまで・同意が要る間・前面が同意画面の間 (同意の直後で、ゲートの router.replace('/') がまだ流れていない) と、
    // 前面が入口の間 (入口の Redirect の router.replace がまだ流れていない) は行き先を保留する。
    // 同じ描画で push すると、expo-router の routingQueue で push と replace が並び、移った先の画面が置き換わる
    if (isNavigationHeldForLegalConsent(legalConsentState, pathname) || pathname === ENTRY_SCREEN_PATH) return;
    setPendingHref(null);
    if (!profile.onboardingCompletedAt) return;
    try {
      router.push(pendingHref);
    } catch (error) {
      // 遷移の失敗でアプリを落とさない
      console.warn("[NotificationRouter] navigation failed", error);
    }
  }, [pendingHref, authLoading, session, profileLoading, profile, legalConsentState, pathname]);

  return null;
}
