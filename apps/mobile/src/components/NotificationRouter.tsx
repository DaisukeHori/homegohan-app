/**
 * プッシュ通知をタップしたときに、通知の行き先の画面へ遷移する (#1049 F7-11)。
 *
 * 以前はタップを受け取る処理が無く、通知をタップしてもアプリが開くだけで、該当画面には遷移しなかった。
 * 受け取る経路は 2 つある (どちらも同じ処理に流す)。
 *   - アプリが起動中 (フォアグラウンド / バックグラウンド) のタップ: addNotificationResponseReceivedListener
 *   - アプリが終了していて、通知のタップで起動した場合: getLastNotificationResponseAsync
 *
 * 行き先は通知の data.deep_link から src/lib/notificationRoute.ts が決める。
 * 遷移はログイン状態・初期設定の完了が分かってから行う (起動直後に遷移すると、ナビゲーションの準備前だったり、
 * 未ログイン・初期設定前の画面を開いてしまったりするため)。条件を満たさないときは遷移せず、
 * アプリを開いたところ (ホームや初期設定) に任せる。
 *
 * 「分かってから」は、今ログインしているユーザーのプロフィールが読めたこと。ログインの確認が済んだだけでは足りない。
 * ProfileProvider は、ログイン前の最初の読み込みで isLoading=false・profile=null にするので、
 * INITIAL_SESSION が届いた直後に、authLoading=false・session あり・profileLoading=false・profile=null の状態が
 * 一瞬だけある (新しいユーザーの読み込みは、その描画の effect で始まり、子であるこの部品の effect より後に走る)。
 * この状態を「初期設定が終わっていない」と取り違えて行き先を捨てると、通知のタップで起動したときの遷移が黙って消える。
 * 行き先を捨てるのは、今のユーザーのプロフィールが読めていて、初期設定が終わっていないときだけにする。
 */

import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";

import { resolveNotificationTarget, type NotificationTarget } from "../lib/notificationRoute";
import { useAuth } from "../providers/AuthProvider";
import { useProfile } from "../providers/ProfileProvider";

export function NotificationRouter() {
  const router = useRouter();
  const { session, isLoading: authLoading } = useAuth();
  const { profile, isLoading: profileLoading } = useProfile();
  const [pending, setPending] = useState<NotificationTarget | null>(null);
  // 同じ通知のタップを 2 回処理しない (起動時の取得とリスナーの両方に届き得る)
  const handled = useRef<Set<string>>(new Set());

  useEffect(() => {
    let active = true;

    const onResponse = (response: Notifications.NotificationResponse) => {
      // 通知本体のタップだけ見る (通知のアクションボタンや、通知を消した操作は対象外)
      if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;

      const id = response.notification.request.identifier;
      if (handled.current.has(id)) return;
      handled.current.add(id);

      const target = resolveNotificationTarget(response.notification.request.content.data);
      if (target) setPending(target);

      // 次回の起動で同じタップを見つけて、もう一度遷移しないよう消しておく
      void Notifications.clearLastNotificationResponseAsync().catch(() => {});
    };

    // 通知のタップでアプリが起動した場合
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (active && response) onResponse(response);
      })
      .catch(() => {});

    // 起動中のタップ
    const subscription = Notifications.addNotificationResponseReceivedListener(onResponse);

    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!pending) return;
    if (authLoading) return; // ログイン状態の確認待ち
    if (!session) {
      setPending(null); // 未ログインなら遷移しない
      return;
    }
    if (profileLoading) return; // 初期設定の完了状況の確認待ち
    // 今のユーザーのプロフィールがまだ読めていない (ログイン直後の一瞬の profile=null や、前のユーザーの残り) 間は待つ。
    // これを初期設定の判定に使うと、まだ読めていないだけなのに「初期設定が終わっていない」として行き先を捨ててしまう
    if (!profile || profile.id !== session.user.id) return;
    if (!profile.onboardingCompletedAt) {
      setPending(null); // 初期設定が終わっていないユーザーは、初期設定の流れに任せる
      return;
    }

    setPending(null);
    try {
      if (pending.kind === "tab") {
        router.push(
          pending.initialPath
            ? { pathname: pending.route as never, params: { initialPath: pending.initialPath } }
            : (pending.route as never),
        );
      } else {
        router.push(pending.href as never);
      }
    } catch (error) {
      // 遷移の失敗でアプリを落とさない
      console.warn("[NotificationRouter] navigation failed", error);
    }
  }, [pending, authLoading, session, profileLoading, profile?.id, profile?.onboardingCompletedAt, router]);

  return null;
}
