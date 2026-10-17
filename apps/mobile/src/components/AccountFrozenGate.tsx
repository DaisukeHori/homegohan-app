import { router, useNavigationContainerRef, usePathname, useRootNavigationState } from "expo-router";
import { useEffect, useRef } from "react";

import { FROZEN_SCREEN_ROUTE_NAME, isMobileFrozenExemptPath } from "../lib/account-frozen";
import { ENTRY_SCREEN_PATH, collapseStackAction, findNavigatorOwningRoute, routeNameOf } from "../lib/legal-consent";
import { useAccountFrozen } from "../providers/AccountFrozenProvider";
import { useAuth } from "../providers/AuthProvider";
import { useProfile } from "../providers/ProfileProvider";

/**
 * アカウントの凍結 (BAN) のゲート (#1861)。ルートの layout (app/_layout.tsx) が Provider の内側・Stack の後ろに 1 つだけ置く。描くものは無い。
 * 規約の同意のゲート (src/components/legal/LegalConsentGate.tsx) と同じ形で、凍結が先 (凍結中は同意のゲートが畳まない)。
 *   - サインイン中で frozen、いまの画面が対象 (対象外のパスでも凍結の画面でもない) → ルートの Stack を凍結の画面 1 つに畳む
 *     (navigationRef.dispatch。完全な state の RESET。規約の同意のゲートと同じ部品 (findNavigatorOwningRoute・collapseStackAction) を使う。
 *     凍結の画面の下に画面を残さない。開いていた画面は一緒に外れる。凍結の画面の route が既にあれば key ごと再利用し、取り除かない)。
 *     同意待ちの同意画面 (app/legal-consent.tsx) も一緒に外れる (同意画面は凍結中は usePreventRemove で止めない。止めていると
 *     expo-router 58 がこの RESET ごと捨てる。legalConsentScreenPreventsRemoval の accountFrozen)。
 *     前面が、このゲートが畳んだ凍結の画面 (openedRef) なら何もしない。前面が凍結の画面でも、このゲートが畳んでいない
 *     (deep link で開いた) なら畳み直す。凍結の画面の上に別の画面が積まれた・置き換えられた (通知のタップなど) ときも、
 *     前面が凍結の画面でなくなるので畳み直す
 *   - サインイン中で、前面が凍結の画面で frozen でない (clear / unknown。凍結が解けた) →
 *     プロフィールを読み直し、入口へ (router.replace('/'))。入口が profile から初期設定かホームへ振り分け直す。
 *     凍結の画面の下に画面がある (deep link で上に開かれた) なら、その画面へ戻る (router.back)
 *   - session が無い: 何もしない。凍結の画面の WebView からログアウト・退会したときは、WebViewScreen の既定どおり入口 (ウェルカム) へ移る
 *     (app/frozen.tsx は afterSignOut を渡さない)
 * 前面は pathname でなく、effect の時点の今のナビゲーションの state (navigationRef.getCurrentRoute()) で見る (LegalConsentGate と同じ理由)。
 * ナビゲーターの準備 (useRootNavigationState の key) が済むまでは何もしない。
 * router.replace / router.back は expo-router の routingQueue に積まれ、次の描画の後に流れる。積んだ操作が流れて前面が凍結の画面で
 * なくなるまで、closingRef で重ねて積まない。
 */
export function AccountFrozenGate() {
  const { session } = useAuth();
  const { state } = useAccountFrozen();
  const { refresh: refreshProfile } = useProfile();
  const pathname = usePathname();
  const navigationReady = Boolean(useRootNavigationState()?.key);
  /** ナビゲーションのコンテナ (expo-router の store.navigationRef。同じ object を返し続ける) */
  const navigationRef = useNavigationContainerRef();
  /** このゲートが reset で畳んだ凍結の画面が、いまの Stack にある (凍結が解けて閉じる・ログアウトの後に前面でなくなったら外す) */
  const openedRef = useRef(false);
  /** 凍結の画面を閉じる操作 (入口への replace か、下の画面への back) を積んだ (流れて前面が凍結の画面でなくなるまで、もう一度積まない) */
  const closingRef = useRef(false);

  useEffect(() => {
    if (!navigationReady) return;
    try {
      const onFrozenScreen = routeNameOf(navigationRef.getCurrentRoute()) === FROZEN_SCREEN_ROUTE_NAME;
      if (!onFrozenScreen) closingRef.current = false;

      if (!session) {
        // ログアウトの後・未ログイン: 畳まない
        if (!onFrozenScreen) openedRef.current = false;
        return;
      }

      if (state === "frozen") {
        // このゲートが畳んだ凍結の画面が開いている
        if (onFrozenScreen && openedRef.current) return;
        // 対象外のパス (認証の途中・公開ページ) はそのまま使わせる
        if (!onFrozenScreen && isMobileFrozenExemptPath(pathname)) return;
        // ルートの Stack を凍結の画面 1 つに畳む (畳み直す)
        const owner = findNavigatorOwningRoute(navigationRef.getRootState(), FROZEN_SCREEN_ROUTE_NAME);
        if (owner === null) {
          // ルートの Stack の state がまだそろっていない。openedRef を立てず、次の描画 (pathname か state が変わる) で試す
          console.warn("[AccountFrozenGate] root stack is not ready; retry on next render");
          return;
        }
        // expo-router 58 の RESET は完全な state (key・index・routeNames・routeKeySeq・stale: false) だけを受け付ける (部分の state は捨てられ、
        // スピナーのまま止まる)。持ち主の navigator に宛てる。凍結の画面の route が既にあれば key ごと再利用し、取り除かない
        navigationRef.dispatch(collapseStackAction(owner, FROZEN_SCREEN_ROUTE_NAME));
        openedRef.current = true;
        closingRef.current = false;
        return;
      }

      // 状態が分かるまでは待つ
      if (state === "loading") return;

      // clear / unknown: 凍結の画面はもう要らない (凍結が解けた)
      openedRef.current = false;
      if (!onFrozenScreen || closingRef.current) return;
      closingRef.current = true;
      // 入口が profile から振り分け直すので、先に読み直す (読み込み中は入口がスピナーで待つ)
      void refreshProfile().catch((error: unknown) => {
        console.warn("[AccountFrozenGate] profile refresh failed", error);
      });
      if (router.canGoBack()) router.back();
      else router.replace(ENTRY_SCREEN_PATH);
    } catch (error) {
      // 遷移の失敗でアプリを落とさない (LegalConsentGate と同じ)。pathname か state か session が変わればもう一度試みる
      console.warn("[AccountFrozenGate] navigation failed", error);
    }
  }, [navigationReady, navigationRef, session, state, pathname, refreshProfile]);

  return null;
}
