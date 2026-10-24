/**
 * ログイン中のパスワード変更・メールアドレス変更 (#1187)。モバイルの設定画面 (app/settings/account.tsx) が使う。
 *
 * Web (src/app/(main)/settings/account/page.tsx) と同じ流れにしている。
 *
 * - パスワード変更: POST /api/auth/password/change (cross/16 §14.6)。送るのは Bearer (getApi() が付ける access token) だけ。
 *   サーバーが DB で現在のパスワードの確認と履歴の照合 (直近 N 世代と同じパスワードは 422) をして、GoTrue の PUT /user を本人の access token で呼ぶ。
 *   GoTrue が更新と同じトランザクションで、この端末以外のセッションを消す (この端末のセッションは入れ替えない)。
 *   再認証のサインイン (signInWithPassword)・updateUser・signOut({ scope: 'others' }) はもう使わない。
 *   Supabase の CAPTCHA の本人確認のトークン (Web の #1474) も、再認証が無くなったので要らない。
 * - メールアドレス変更: updateUser({ email }, { emailRedirectTo }) で確認メールを送る。
 *   確認メールのリンクの戻り先は、新規登録のメール確認と同じアプリのリンク (homegohan://auth/verify)。
 *   verify 画面がリンクのトークンでセッションを作る (authLink.ts)。現在のアドレスにも確認メールが届く設定
 *   (Supabase の Secure email change) では、1 通目のリンクで「もう一方の確認待ち」を表示する。
 *
 * 入力の検証とエラーの文言は Web と共通 (packages/shared の account-change-input.ts / account-change-errors.ts)。
 */

import {
  describeEmailChangeError,
  describePasswordChangeApiError,
  normalizeEmailChangeInput,
  validatePasswordChangeInput,
  type PasswordChangeInput,
} from "@homegohan/shared";
import * as Linking from "expo-linking";

import { getApi } from "./api";
import { getJapaneseApiErrorMessage } from "./api-error";
import { supabase } from "./supabase";

/** メール変更の確認メールのリンクを開いたときに戻る、アプリの画面 (新規登録のメール確認と同じ) */
export const EMAIL_CHANGE_REDIRECT_PATH = "/auth/verify";

export type PasswordChangeResult =
  /** 変更できた (他の端末のログアウトは GoTrue が更新と同じトランザクションで済ませている) */
  | { ok: true }
  | { ok: false; message: string };

export type EmailChangeResult =
  /** 確認メールを送った。sentTo: 送り先の (小文字にそろえた) 新しいメールアドレス */
  | { ok: true; sentTo: string }
  | { ok: false; message: string };

/**
 * パスワードを変更する。入力の検証で弾けるものは、API を呼ばずに止める。
 * @param _email 以前は再認証に使っていた、いまログインしているメールアドレス。再認証が無くなったので使わない (呼び出し側の形を変えない)
 */
export async function changePassword(_email: string, input: PasswordChangeInput): Promise<PasswordChangeResult> {
  const inputError = validatePasswordChangeInput(input);
  if (inputError) return { ok: false, message: inputError };

  try {
    await getApi().post("/api/auth/password/change", {
      current_password: input.currentPassword,
      new_password: input.newPassword,
    });
    return { ok: true };
  } catch (err) {
    // パスワード・本文は出さない。エラーの種類だけを残す
    console.error("[settings/account] password change failed:", err instanceof Error ? err.name : "unknown");
    // 本文の error = cross/16 §19 の文。圏外・待ち時間切れは通信の文言。取り出せない・日本語でない文 (HTTP のエラーでない例外の英文) は
    // 共通の失敗の文言 (#1917 の続き)
    return { ok: false, message: getJapaneseApiErrorMessage(err, describePasswordChangeApiError(null, null)) };
  }
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
