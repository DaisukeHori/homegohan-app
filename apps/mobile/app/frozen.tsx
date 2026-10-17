import { WebViewScreen } from "../src/components/web/WebViewScreen";
import { FROZEN_SCREEN_PATH } from "../src/lib/account-frozen";

/**
 * アカウントの凍結中の画面 (#1861)。Web の凍結の画面 (/frozen) を WebView で開く
 * (文面・「サポートに問い合わせる」(/contact)・「退会・データの書き出し」(/frozen/account)・「有料プランの解約・お支払い」(/frozen/billing)・
 * ログアウトは Web の画面のまま。2 か所に持たない)。請求の画面 (app/settings/data-requests.tsx) と同じ形。
 * 凍結中でも退会・データの書き出しを許すのは、#1445 のオーナーの選択 (2026-10-12)。
 * 凍結中は、AccountFrozenGate (src/components/AccountFrozenGate.tsx) がルートの Stack をこの画面 1 つに畳み、凍結が解けたら入口へ移す。
 * WebView を本人のセッションにする認証ブリッジのコードは、凍結中でも発行される (src/lib/auth/frozen.ts の isNativeBridgeCodeApiPath)。
 * WebView の中の遷移は自分の Web のオリジンの中だけ (WebViewScreen の decideNavigation)。/frozen/account・/frozen/billing・/contact はそのまま WebView で開く。
 * Web の画面でログアウト・退会したとき (Web が { type: 'sign-out' } を送る) は、ネイティブもログアウトした後、
 * WebViewScreen の既定どおり入口 (ウェルカム) へ移る (未ログインなので、ゲートは畳まない)。
 */
export default function FrozenScreen() {
  return <WebViewScreen path={FROZEN_SCREEN_PATH} testID="webview-frozen" />;
}
