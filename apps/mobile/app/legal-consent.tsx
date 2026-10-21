import { router, usePreventRemove } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { Button } from "../src/components/ui";
import { WebViewScreen } from "../src/components/web/WebViewScreen";
import {
  ENTRY_SCREEN_PATH,
  LEGAL_CONSENT_SCREEN_PATH,
  legalConsentScreenModeOf,
  legalConsentScreenPreventsRemoval,
  legalConsentScreenSawRequired,
} from "../src/lib/legal-consent";
import { supabase } from "../src/lib/supabase";
import { useAccountFrozen } from "../src/providers/AccountFrozenProvider";
import { useAuth } from "../src/providers/AuthProvider";
import { useLegalConsent } from "../src/providers/LegalConsentProvider";
import { colors, spacing } from "../src/theme";

/** ログアウトの後 (Web の案内を出している間) に、WebView の上に出すボタンの文 */
const LEGAL_CONSENT_CLOSE_LABEL = "閉じる";

/**
 * 利用規約・プライバシーポリシーへの同意画面 (#1442)。Web の /legal-consent を WebView で開く
 * (文面・チェック・生年月日 (cross/14)・未成年の案内・「登録をやめる」・409 の読み込み直し・「同意しない」の後の案内は Web の画面のまま。
 * 2 か所に持たない)。AI 同意の画面 (settings/ai-consent.tsx) と同じ形。同意が要る間は、LegalConsentGate がルートの Stack を
 * この画面 1 つに畳み、同意の後に入口へ移す。
 * Web の画面は、同意を記録できたら { type: 'legal-consent-accepted' } を、「同意しない」「登録をやめる」と同意の前の退会 (/legal-consent/account。#1901) では { type: 'sign-out' } を
 * ネイティブへ送る (WebViewScreen の onMessage が受ける)。
 * 扱い (LegalConsentScreenMode。src/lib/legal-consent.ts) ごとの振る舞い:
 *   awaiting-consent   取り除く操作 (ログインの直後の routeAfterSignIn の replace など) を全部止める (同意のゲートの畳み直しは同意画面の route を
 *                      key ごと再利用するので、取り除かれない)。ただし凍結中 (#1861) は止めない (凍結が先。凍結のゲートの畳み直しは
 *                      同意画面の route を取り除くので、止めると expo-router 58 が RESET ごと捨て、凍結の画面へ畳めない)。
 *                      iOS のスワイプは app/_layout.tsx の gestureEnabled: false。Android の戻るボタンは、この画面が Stack の
 *                      唯一の route なので OS に渡る (アプリが背面へ。usePreventRemove の止めには当たらない)
 *   signed-out-notice  Web からの sign-out でネイティブもログアウトした後。ウェルカムへ移らず (WebViewScreen の afterSignOut)、
 *                      Web の案内 (退会と書き出しの画面へのログイン・請求の画面・「登録をやめました」・「退会しました」) を残し、WebView の上に「閉じる」を出す。
 *                      取り除く操作は全部止め、「閉じる」でだけ入口へ移る
 *   free               何も止めない。サインイン中ならゲートが閉じる。未ログインのまま開かれた (deep link) なら、
 *                      auth の読み込みが済んだところで自分で閉じる
 * 自分で閉じるとき (close) は、下に画面があれば (deep link で上に開かれた) その画面へ戻り、無ければ (ゲートが畳んだ同意画面は
 * Stack の唯一の route) 入口へ移る。入口はウェルカムを出す (未ログイン)。
 */
export default function LegalConsentScreen() {
  const { session, isLoading: authLoading } = useAuth();
  const { state } = useLegalConsent();
  const { state: frozenState } = useAccountFrozen();
  const signedIn = session !== null;
  /** この同意画面がサインイン中に required を見たか */
  const sawRequiredRef = useRef(false);
  sawRequiredRef.current = legalConsentScreenSawRequired(sawRequiredRef.current, signedIn, state);
  const mode = legalConsentScreenModeOf(signedIn, state, sawRequiredRef.current);
  /** この画面が自分で閉じる途中 (「閉じる」・ログアウトに失敗したとき・未ログインで開かれたとき)。ref は effect の同期の判定に、state は hook の引数に使う。以後の取り除く操作は止めない */
  const closingRef = useRef(false);
  const [closing, setClosing] = useState(false);

  // 取り除く操作 (GO_BACK・POP・POP_TO_TOP・REPLACE・NAVIGATE・同意画面を含まない RESET) を止める。止めた操作は捨てる (repeat は呼ばない)。
  // awaiting-consent で止めた置き換えの行き先は、同意の後に入口が profile から決め直す (cross/13b S1 の (B))。
  // 凍結中は止めない (凍結のゲートが Stack を凍結の画面 1 つに畳む RESET を通す。#1861)
  const disablePrevention = usePreventRemove(
    legalConsentScreenPreventsRemoval(mode, closing, frozenState === "frozen"),
    () => {},
  );

  const close = useCallback(() => {
    closingRef.current = true;
    // 次の描画で usePreventRemove の第 1 引数を false にそろえる (hook は、解いたのに引数が true のままだと警告する)
    setClosing(true);
    // いま積む遷移を止めない
    disablePrevention();
    // 下に画面があれば (deep link で上に開かれた同意画面) その画面へ戻る。無ければ (ゲートが畳んだ同意画面) 入口へ
    if (router.canGoBack()) router.back();
    else router.replace(ENTRY_SCREEN_PATH);
  }, [disablePrevention]);

  // 未ログインのまま開かれた同意画面 (deep link。扱いは free): auth の読み込みが済んだら閉じる (下の画面へ戻るか、入口 (ウェルカム) へ)
  useEffect(() => {
    if (authLoading || signedIn || mode !== "free" || closingRef.current) return;
    close();
  }, [authLoading, signedIn, mode, close]);

  // Web からの sign-out (「同意しない」「登録をやめる」) と、失効の session-expired で、ネイティブのログアウトが済んだ後に呼ばれる
  // (webViewAuthMessages.ts の goToWelcome が、ウェルカムへ移る代わりに options.afterSignOut として呼ぶ)。ウェルカムへ移らず、Web の案内を残す。
  // 端末にセッションが残り getSession() がそれを返したとき (サインアウトの途中の例外など) は、今までどおり入口へ移す
  // (入口は required でスピナー → LegalConsentGate が同意画面 1 つに畳み直す)。
  // サインアウトが通信の失敗で終わったときは 2 つの枝がある。access token が有効なうちなら、supabase-js が端末のセッションを消して
  // SIGNED_OUT を出すので、成功のときと同じく移らない。失効していて更新もできないときは端末のセッションが残るが、
  // getSession() も null を返すので移らない (同意を待つ扱いのまま。Web の signOut() も失敗して form に戻る。docs/design/mobile/05-auth-session.md §9.3 の S-29)
  const afterSignOut = useCallback(() => {
    void supabase.auth.getSession().then(
      ({ data }) => {
        if (data.session) close();
      },
      () => close(),
    );
  }, [close]);

  return (
    <WebViewScreen
      path={LEGAL_CONSENT_SCREEN_PATH}
      testID="webview-legal-consent"
      afterSignOut={afterSignOut}
      header={
        mode === "signed-out-notice" ? (
          <View
            style={{
              flexDirection: "row",
              justifyContent: "flex-end",
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.sm,
              backgroundColor: colors.card,
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
            }}
          >
            <Button variant="ghost" size="sm" onPress={close} testID="legal-consent-close">
              {LEGAL_CONSENT_CLOSE_LABEL}
            </Button>
          </View>
        ) : undefined
      }
    />
  );
}
