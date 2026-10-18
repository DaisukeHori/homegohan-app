import { router, useNavigationContainerRef, usePathname, useRootNavigationState } from "expo-router";
import { useEffect, useRef } from "react";

import {
  ENTRY_SCREEN_PATH,
  LEGAL_CONSENT_SCREEN_ROUTE_NAME,
  collapseStackAction,
  findNavigatorOwningRoute,
  isMobileLegalConsentExemptPath,
  routeNameOf,
} from "../../lib/legal-consent";
import { useAccountFrozen } from "../../providers/AccountFrozenProvider";
import { useAuth } from "../../providers/AuthProvider";
import { useLegalConsent } from "../../providers/LegalConsentProvider";
import { useProfile } from "../../providers/ProfileProvider";

/**
 * 規約の同意のゲート (#1442)。ルートの layout (app/_layout.tsx) が Provider の内側・Stack の後ろに 1 つだけ置く。描くものは無い。
 *   - サインイン中で required、いまの画面が対象 (対象外のパスでも同意画面でもない) → ルートの Stack を同意画面 1 つに畳む
 *     (navigationRef.dispatch。完全な state の RESET。同意画面の下に画面を残さない。開いていた画面とその入力・Modal・端末の戻るの受け手は一緒に外れる)。
 *     前面が、このゲートが畳んだ同意画面 (openedRef) なら何もしない。前面が同意画面でも、このゲートが畳んでいない
 *     (deep link で開いた・ログアウトの前から下に残っていた) なら畳み直す
 *   - サインイン中で、前面が同意画面で required でない (clear / unknown。同意が済んだ・取り直しで required でなくなった) →
 *     プロフィールを読み直し (初期設定の質問の画面は途中でプロフィールを読み直さないので、入口が古い進みで振り分けないように)、
 *     入口へ (router.replace('/'))。入口が profile から初期設定 (途中なら再開の画面) かホームへ振り分け直す。
 *     ただし同意画面の下に画面がある (このゲートが畳んでいない同意画面。deep link で上に開かれた) なら、その画面へ戻る
 *     (router.back)。入口へ置き換えると、下の画面と入口の振り分けの行き先が重なる (タブの route が 2 つ並ぶ) ため。
 *     このゲートが畳んだ同意画面は Stack の唯一の route なので、戻れず (canGoBack が false)、入口へ移る
 *   - session が無い: 何もしない。同意を待っていた同意画面は Web の案内と「閉じる」を出し、未ログインのまま開いた同意画面は
 *     自分で入口へ移る (app/legal-consent.tsx)
 * 前面は pathname でなく、effect の時点の今のナビゲーションの state (navigationRef.getCurrentRoute()) で見る
 * (pathname は 1 描画遅れることがあり、タブの区画が外れると別のタブのパスに変わる。dispatch の後の前面は、次の描画の後の
 * この effect から見える)。
 * アカウントが凍結中 (#1861。useAccountFrozen の state が frozen) の間は何もしない。凍結のゲート (src/components/AccountFrozenGate.tsx) が
 * Stack を凍結の画面 1 つに畳む (凍結が先。Web の middleware も 凍結 → 同意 の順に判定する)。凍結が解けたら、同意の判定に戻る。
 * ナビゲーターの準備 (useRootNavigationState の key) が済むまでは何もしない。
 * router.replace / router.back は expo-router の routingQueue に積まれ、次の描画の後に流れる。積んだ操作が流れて前面が同意画面で
 * なくなるまで、closingRef で重ねて積まない。
 */
export function LegalConsentGate() {
  const { session } = useAuth();
  const { state } = useLegalConsent();
  const { state: frozenState } = useAccountFrozen();
  const { refresh: refreshProfile } = useProfile();
  const pathname = usePathname();
  const navigationReady = Boolean(useRootNavigationState()?.key);
  /** ナビゲーションのコンテナ (expo-router の store.navigationRef。同じ object を返し続ける) */
  const navigationRef = useNavigationContainerRef();
  /** このゲートが RESET で畳んだ同意画面が、いまの Stack にある (同意で閉じる・ログアウトの後に前面でなくなったら外す) */
  const openedRef = useRef(false);
  /** 同意画面を閉じる操作 (入口への replace か、下の画面への back) を積んだ (流れて前面が同意画面でなくなるまで、もう一度積まない) */
  const closingRef = useRef(false);

  useEffect(() => {
    if (!navigationReady) return;
    // #1861: 凍結中は凍結のゲートに任せる (同意画面へ畳むと、凍結の画面と畳み合う)
    if (frozenState === "frozen") return;
    try {
      const onConsentScreen = routeNameOf(navigationRef.getCurrentRoute()) === LEGAL_CONSENT_SCREEN_ROUTE_NAME;
      if (!onConsentScreen) closingRef.current = false;

      if (!session) {
        // ログアウトの後・未ログイン: 畳まない。同意画面が前面なら、同意画面が案内を出すか自分で入口へ移る
        if (!onConsentScreen) openedRef.current = false;
        return;
      }

      if (state === "required") {
        // このゲートが畳んだ同意画面が開いている
        if (onConsentScreen && openedRef.current) return;
        // 対象外のパス (認証の途中・公開ページ) はそのまま使わせる
        if (!onConsentScreen && isMobileLegalConsentExemptPath(pathname)) return;
        // ルートの Stack を同意画面 1 つに畳む (畳み直す)
        const owner = findNavigatorOwningRoute(navigationRef.getRootState(), LEGAL_CONSENT_SCREEN_ROUTE_NAME);
        if (owner === null) {
          // ルートの Stack の state がまだそろっていない。openedRef を立てず、次の描画 (pathname か state が変わる) で試す
          console.warn("[LegalConsentGate] root stack is not ready; retry on next render");
          return;
        }
        // expo-router 58 の RESET は完全な state (key・index・routeNames・routeKeySeq・stale: false) だけを受け付ける。
        // 持ち主の navigator に宛てる。58 では dispatch は commit の後に流れる。同意画面の route が既にあれば key ごと再利用し、取り除かない
        navigationRef.dispatch(collapseStackAction(owner, LEGAL_CONSENT_SCREEN_ROUTE_NAME));
        openedRef.current = true;
        closingRef.current = false;
        return;
      }

      // 状態が分かるまでは待つ
      if (state === "loading") return;

      // clear / unknown: 同意画面はもう要らない (同意が済んだ・取り直しで required でなくなった)
      openedRef.current = false;
      if (!onConsentScreen || closingRef.current) return;
      closingRef.current = true;
      // 入口が profile から振り分け直すので、先に読み直す (読み込み中は入口がスピナーで待つ)
      void refreshProfile().catch((error: unknown) => {
        console.warn("[LegalConsentGate] profile refresh failed", error);
      });
      // このゲートが畳んだ同意画面は Stack の唯一の route で戻れないので、入口へ移る。
      // 下に画面がある (deep link で上に開かれた同意画面) なら、その画面へ戻る (入口へ置き換えると行き先が重なる)
      if (router.canGoBack()) router.back();
      else router.replace(ENTRY_SCREEN_PATH);
    } catch (error) {
      // 遷移の失敗でアプリを落とさない (NotificationRouter と同じ)。pathname か state か session が変わればもう一度試みる
      console.warn("[LegalConsentGate] navigation failed", error);
    }
  }, [navigationReady, navigationRef, session, state, frozenState, pathname, refreshProfile]);

  return null;
}
