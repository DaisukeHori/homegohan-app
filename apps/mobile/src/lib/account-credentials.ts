/**
 * ログイン中のパスワード変更・メールアドレス変更 (#1187)。モバイルの設定画面 (app/settings/account.tsx) が使う。
 *
 * Web (src/app/(main)/settings/account/page.tsx・PR #1371) と同じ流れにしている。
 *
 * - パスワード変更: 現在のパスワードで再認証 (signInWithPassword) → updateUser({ password }) →
 *   signOut({ scope: 'others' }) で、この端末以外のログインを解除する。
 *   - 再認証で、この端末のセッションは新しいものに入れ替わる (onAuthStateChange の SIGNED_IN で AuthProvider も差し替わる)。
 *     このあとの 'others' は今のセッションだけを残すので、この端末はログインしたまま。
 *     操作中の端末を使い続けるので、ユーザー別のデータの削除やログアウトの後始末 (signOut.ts) は行わない。
 *   - WebView の Web 側は、ネイティブが張った借り物のセッションで動いている。入れ替わる前のセッションは 'others' で失効するので、
 *     Web 側から session-expired が届き、ネイティブが新しいセッションで読み込み直す (webViewAuthMessages.ts の F7-05 の流れ)。
 *   - パスワードはもう変わっているので、'others' の失敗はエラーにせず、注意書きを添えて成功を伝える。
 *   - Supabase の CAPTCHA を有効にした場合の本人確認のトークン (Web の #1474) は、モバイルではまだ付けていない
 *     (別の課題)。断られたときは、ボットの確認の文言を出す (describePasswordChangeError)。
 * - メールアドレス変更: updateUser({ email }, { emailRedirectTo }) で確認メールを送る。
 *   確認メールのリンクの戻り先は、新規登録のメール確認と同じアプリのリンク (homegohan://auth/verify)。
 *   verify 画面がリンクのトークンでセッションを作る (authLink.ts)。現在のアドレスにも確認メールが届く設定
 *   (Supabase の Secure email change) では、1 通目のリンクで「もう一方の確認待ち」を表示する。
 *
 * 入力の検証とエラーの文言は Web と共通 (packages/shared の account-change-input.ts / account-change-errors.ts)。
 */

import {
  describeEmailChangeError,
  describePasswordChangeError,
  normalizeEmailChangeInput,
  validatePasswordChangeInput,
  type PasswordChangeInput,
} from "@homegohan/shared";
import * as Linking from "expo-linking";

import { supabase } from "./supabase";

/** メール変更の確認メールのリンクを開いたときに戻る、アプリの画面 (新規登録のメール確認と同じ) */
export const EMAIL_CHANGE_REDIRECT_PATH = "/auth/verify";

export type PasswordChangeResult =
  /** 変更できた。othersSignedOut: 他の端末のログアウトまで確認できたか */
  | { ok: true; othersSignedOut: boolean }
  | { ok: false; message: string };

export type EmailChangeResult =
  /** 確認メールを送った。sentTo: 送り先の (小文字にそろえた) 新しいメールアドレス */
  | { ok: true; sentTo: string }
  | { ok: false; message: string };

/**
 * パスワードを変更する。入力の検証で弾けるものは、どの API も呼ばずに止める。
 * @param email 再認証に使う、いまログインしているメールアドレス
 */
export async function changePassword(email: string, input: PasswordChangeInput): Promise<PasswordChangeResult> {
  const inputError = validatePasswordChangeInput(input);
  if (inputError) return { ok: false, message: inputError };

  let step: "reauth" | "update" = "reauth";
  try {
    // 1) 現在のパスワードで本人確認 (ログイン済みの端末を他人が使っていても、パスワードを知っている人だけが変えられる)
    const { error: reauthError } = await supabase.auth.signInWithPassword({ email, password: input.currentPassword });
    if (reauthError) {
      console.error("[settings/account] re-authentication failed:", reauthError.code ?? reauthError.status);
      return { ok: false, message: describePasswordChangeError(reauthError, "reauth") };
    }

    // 2) 新しいパスワードへ更新
    step = "update";
    const { error: updateError } = await supabase.auth.updateUser({ password: input.newPassword });
    if (updateError) {
      console.error("[settings/account] password update failed:", updateError.code ?? updateError.status);
      return { ok: false, message: describePasswordChangeError(updateError, "update") };
    }
  } catch (err) {
    console.error("[settings/account] password change failed unexpectedly:", err);
    return { ok: false, message: describePasswordChangeError(err, step) };
  }

  // 3) この端末以外のログインを解除する (今のセッションは残す)
  let othersSignedOut = true;
  try {
    const { error: signOutError } = await supabase.auth.signOut({ scope: "others" });
    if (signOutError) throw signOutError;
  } catch (signOutErr) {
    console.error("[settings/account] sign out of other sessions failed:", signOutErr);
    othersSignedOut = false;
  }
  return { ok: true, othersSignedOut };
}

/**
 * メールアドレスの変更を申し込み、確認メールを送る。入力の検証で弾けるものは、API を呼ばずに止める。
 * @param currentEmail いまログインしているメールアドレス (同じアドレスへの変更を止めるため)
 */
export async function requestEmailChange(newEmail: string, currentEmail: string): Promise<EmailChangeResult> {
  const input = normalizeEmailChangeInput(newEmail, currentEmail);
  if (!input.ok) return { ok: false, message: input.message };

  try {
    const { error: updateError } = await supabase.auth.updateUser(
      { email: input.email },
      { emailRedirectTo: Linking.createURL(EMAIL_CHANGE_REDIRECT_PATH) },
    );
    if (updateError) {
      console.error("[settings/account] email change failed:", updateError.code ?? updateError.status);
      return { ok: false, message: describeEmailChangeError(updateError) };
    }
    return { ok: true, sentTo: input.email };
  } catch (err) {
    console.error("[settings/account] email change failed unexpectedly:", err);
    return { ok: false, message: describeEmailChangeError(err) };
  }
}
