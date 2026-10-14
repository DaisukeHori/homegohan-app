// src/lib/auth/logout-guidance.ts
// アカウント画面 (src/app/(main)/settings/account/page.tsx) の「ログアウトして…」という案内の文言。
//
// アプリ (モバイルアプリの WebView) の中で開いた Web の設定画面には「ログアウト」が出ない (#1037。
// ログアウトと退会はネイティブの設定画面 = マイページの右上の歯車に一本化。判定は hooks/useAccountActionsPlacement.ts)。
// そのため「設定の『ログアウト』で…」と案内すると、アプリの中では指し先が無い (#1552)。
// ここでは、ログアウトと退会をどこで出すか (AccountActionsPlacement) に合わせて、案内の文を出し分ける。
//   'web'       : ブラウザ。Web の設定の「ログアウト」と、Web のログイン画面の「忘れた場合」を指す
//   'native'    : アプリの中。ネイティブの設定 (マイページの右上の歯車) の「ログアウト」と、
//                 ネイティブのログイン画面の「パスワードを忘れた？」を指す
//   'undecided' : まだ判定できない (サーバーの描画・ブラウザの最初の描画)。場所を言わない文にする
//                 (どちらかを先に出して、一瞬だけ違う場所を案内しないように)

import type { AccountActionsPlacement } from "@/hooks/useAccountActionsPlacement";

/** アプリの中で、ログアウトがある場所 (Web の設定画面の案内 src/app/(main)/settings/page.tsx と同じ言い方) */
export const NATIVE_SETTINGS_ENTRY_LABEL = "マイページの右上の歯車 (設定)";

/** ログイン画面の「パスワードを忘れた」リンクの名前 (src/__tests__/app/faq/account-answers.test.ts が実物と突き合わせる) */
export const WEB_FORGOT_PASSWORD_LINK_LABEL = "忘れた場合";
export const NATIVE_FORGOT_PASSWORD_LINK_LABEL = "パスワードを忘れた？";

/**
 * パスワードは変わったが、他の端末のログアウト (signOut({ scope: 'others' })) を確認できなかったときの注意書き。
 */
export function describeOthersNotSignedOutNote(placement: AccountActionsPlacement): string {
  const lead = "ただし、他の端末のログアウトを確認できませんでした。";
  const tail = "新しいパスワードでログインし直してください。";
  switch (placement) {
    case "web":
      return `${lead}心配な場合は、設定の「ログアウト」でこの端末もログアウトして、${tail}`;
    case "native":
      return `${lead}心配な場合は、${NATIVE_SETTINGS_ENTRY_LABEL} の「ログアウト」でこの端末もログアウトして、${tail}`;
    case "undecided":
      return `${lead}心配な場合は、この端末もいったんログアウトして、${tail}`;
  }
}

/**
 * 現在のパスワードを思い出せない人への案内 (パスワード変更の欄の下に常に出す)。
 */
export function describeForgotCurrentPasswordNote(placement: AccountActionsPlacement): string {
  const lead = "現在のパスワードを思い出せないときは、";
  const tail = "パスワードを再設定してください。";
  switch (placement) {
    case "web":
      return `${lead}いったんログアウトして、ログイン画面の「${WEB_FORGOT_PASSWORD_LINK_LABEL}」から${tail}`;
    case "native":
      return `${lead}${NATIVE_SETTINGS_ENTRY_LABEL} からいったんログアウトして、ログイン画面の「${NATIVE_FORGOT_PASSWORD_LINK_LABEL}」から${tail}`;
    case "undecided":
      return `${lead}いったんログアウトして、ログイン画面から${tail}`;
  }
}
