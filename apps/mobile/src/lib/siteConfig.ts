/**
 * 問い合わせ先・利用規約・プライバシーポリシーの URL を決める、モバイル側の唯一の場所 (#1194)
 *
 * Web の src/lib/site-config.ts のモバイル版。以前は設定画面とプロフィール画面に、利用規約・プライバシーポリシーの URL
 * (存在しないドメインで、開いても何も表示されなかった) と問い合わせ先 (mailto:) が直接書かれていて、
 * メールの文面や Web の画面とも食い違っていた。
 *
 * 環境変数 (ビルド時に埋め込まれる。どちらも未設定・空・不正な値なら既定値):
 *   EXPO_PUBLIC_WEB_URL        Web のオリジン。webBaseUrl.ts と共通 (WebView が開く Web と同じ。既定は DEFAULT_WEB_URL)
 *   EXPO_PUBLIC_SUPPORT_EMAIL  問い合わせ先のメールアドレス (既定は DEFAULT_SUPPORT_EMAIL)
 *
 * 既定値は、いま実際に動いている値 (Web 側の既定値と同じ)。homegohan.com へ切り替えるときは、
 * この 2 つを EAS のビルド環境に設定してビルドし直すだけでよい (コードの変更は要らない)。
 * 手順は docs/operations/email-domain.md。
 * 埋め込みは `process.env.EXPO_PUBLIC_XXX` と直接書いたときだけ効くので、動的な読み方 (`process.env[name]`) にしないこと。
 * このファイルの既定値以外に、ドメインを直接書かない。tests/site-config-guard.test.ts が検査する。
 */
import { buildWebPageUrl } from './webBaseUrl';

/** 問い合わせ先 (サポート窓口) のメールアドレスの既定値。Web 側の DEFAULT_SUPPORT_EMAIL と同じ値 */
export const DEFAULT_SUPPORT_EMAIL = 'support@homegohan.app';

/** 空白・< > @ を含まない、ごく簡易なメールアドレスの形 */
const EMAIL_ADDRESS_PATTERN = /^[^\s<>@"]+@[^\s<>@"]+\.[^\s<>@"]+$/;

/** 問い合わせ先のメールアドレス。EXPO_PUBLIC_SUPPORT_EMAIL、無ければ DEFAULT_SUPPORT_EMAIL。呼ぶたびに環境変数を読む */
export function getSupportEmail(): string {
  const raw = process.env.EXPO_PUBLIC_SUPPORT_EMAIL?.trim();
  if (!raw) return DEFAULT_SUPPORT_EMAIL;
  // 形が正しくない値で mailto: を開くと、メールアプリが宛先なしで開くだけになる。既定値に戻す
  return EMAIL_ADDRESS_PATTERN.test(raw) ? raw : DEFAULT_SUPPORT_EMAIL;
}

/** 「お問い合わせ」で開く mailto: リンク */
export function getSupportMailtoUrl(): string {
  return `mailto:${getSupportEmail()}`;
}

/** 利用規約のページ。Web の公開ページ (未ログインでも読める) の URL は、webBaseUrl.ts の buildWebPageUrl で作る */
export function getTermsUrl(): string {
  return buildWebPageUrl('/terms');
}

/** プライバシーポリシーのページ */
export function getPrivacyUrl(): string {
  return buildWebPageUrl('/privacy');
}
