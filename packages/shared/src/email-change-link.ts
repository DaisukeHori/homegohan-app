/**
 * メールアドレス変更の確認リンクの 1 通目 (#1187・#1574) の判定と、利用者に見せる文 (Web とモバイルで同じもの)
 *
 * Supabase の「Secure email change」が有効だと、現在と新しいメールアドレスの両方に確認メールが届く。
 * 1 通目のリンクを開くと、Supabase Auth (GoTrue) はセッションの代わりに、知らせ (message) だけを戻り先に付ける:
 *   "Confirmation link accepted. Please proceed to confirm link sent to the other email"
 * 付く場所は戻り先 URL のハッシュ (#message=...)。PKCE のリンクでは、クエリ (?message=...) にも同じものが付く。
 *   - Web: /auth/callback (src/app/(auth)/auth/callback/route.ts) はハッシュを読めないので、
 *     /auth/link-notice (src/app/(auth)/auth/link-notice/page.tsx) がブラウザで読んで知らせを出す
 *   - モバイル: homegohan://auth/verify#message=... を apps/mobile/src/lib/authLink.ts が読み、
 *     apps/mobile/app/(auth)/auth/verify.tsx が知らせを出す
 * これ以外の知らせは、何が起きたか分からないので、この判定には当てない。
 */

/** 1 通目の確認を受け付けたときの知らせの文に含まれる部分 (大文字と小文字は区別しない) */
const EMAIL_CHANGE_AWAITING_OTHER_PATTERN = /confirm link sent to the other email/i;

/** 知らせ (message) が「1 通目の確認を受け付けた (もう一方のリンクを待っている)」ものか */
export function isEmailChangeAwaitingOtherMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  return EMAIL_CHANGE_AWAITING_OTHER_PATTERN.test(message);
}

/** 1 通目の確認を受け付けたときに利用者へ出す文 */
export const EMAIL_CHANGE_AWAITING_OTHER_NOTICE =
  '確認を受け付けました。メールアドレスの変更を終えるには、もう一方のメールアドレスに届いた確認メールのリンクも開いてください。';
