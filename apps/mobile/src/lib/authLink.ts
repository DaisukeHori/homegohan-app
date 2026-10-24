/**
 * Supabase の認証リンク (メール確認・OAuth のコールバックなど) を処理して、セッションにする (#1038 F7-08)。
 *
 * リンクの形式は 3 種類:
 *   1. PKCE / OAuth : code パラメータ                       → exchangeCodeForSession
 *   2. OTP          : token_hash + type パラメータ (#438)    → verifyOtp
 *   3. 旧形式       : access_token + refresh_token (フラグメント) → setSession
 *
 * 使う場所は 2 つある。
 *   - login.tsx の Google ログイン: openAuthSessionAsync が返す result.url を処理する。
 *     iOS の ASWebAuthenticationSession はコールバック URL を result.url にだけ返し、Linking のイベント
 *     (Linking.useURL()) には流さないため、画面遷移 (verify) に任せると URL が取れず何も起きなかった
 *   - verify.tsx: メールのリンクなど、ディープリンクで開かれたときの URL を処理する
 *
 * Android では、同じコールバック URL が result.url とディープリンクの両方で届き、両方の画面が処理しうる。
 * code は 1 回しか交換できないので、同じリンクの処理は 1 回だけ行い、結果を共有する。
 */

import { AUTH_LINK_ERROR_MESSAGE, AUTH_LINK_FAILED_MESSAGE, isEmailChangeAwaitingOtherMessage } from "@homegohan/shared";
import { getJapaneseApiErrorMessage } from "./api-error";
import type { SupabaseLinkParams } from "./deeplink";
import { supabase } from "./supabase";

export type AuthLinkOutcome =
  /** セッションを作れた */
  | { status: "signed_in" }
  /** リンク自体がエラーを運んできた (access_denied など)。message は固定の文 AUTH_LINK_ERROR_MESSAGE (GoTrue・provider の英文は出さない) */
  | { status: "link_error"; message: string }
  /** code の交換・OTP の確認・setSession のどれかが失敗した */
  | { status: "failed"; message: string }
  /**
   * メールアドレス変更の確認の 1 通目を受け付けた。もう一方のアドレスに届いたリンクも開くと変更が終わる (#1187)。
   * Supabase の Secure email change が有効だと、現在と新しいアドレスの両方に確認メールが届き、1 通目のリンクは
   * セッションではなく知らせ (message) だけを運んでくる
   */
  | { status: "awaiting_other_confirmation" }
  /** 処理できる情報が無い (リンクが無い・壊れている・別の画面向けのリンク) */
  | { status: "empty" };

/** email_change: メールアドレス変更の確認リンク (#1187)。メールの雛形が token_hash の形のときに届く */
type OtpType = "signup" | "email" | "recovery" | "invite" | "email_change";

/** 同じリンクの結果を共有しておく時間 (ミリ秒)。Android で届く 2 回分の通知が、これより離れることはない */
const RESULT_SHARE_MS = 60_000;
const inFlight = new Map<string, { at: number; promise: Promise<AuthLinkOutcome> }>();

/** リンクが運んできた情報の識別子 (結果の共有用)。トークンの値そのものはキャッシュのキーにするだけで外へ出さない */
function linkKey(params: SupabaseLinkParams): string | null {
  if (params.code) return `code:${params.code}`;
  if (params.token_hash && params.type) return `otp:${params.type}:${params.token_hash}`;
  if (params.access_token && params.refresh_token) return `token:${params.refresh_token}`;
  return null;
}

async function processLink(params: SupabaseLinkParams): Promise<AuthLinkOutcome> {
  try {
    if (params.code) {
      const { error } = await supabase.auth.exchangeCodeForSession(params.code);
      if (error) throw error;
    } else if (params.token_hash && params.type) {
      const { error } = await supabase.auth.verifyOtp({
        token_hash: params.token_hash,
        type: params.type as OtpType,
      });
      if (error) throw error;
    } else if (params.access_token && params.refresh_token) {
      const { error } = await supabase.auth.setSession({
        access_token: params.access_token,
        refresh_token: params.refresh_token,
      });
      if (error) throw error;
    }
    return { status: "signed_in" };
  } catch (e) {
    // Supabase Auth (GoTrue) の英語の文 ('invalid flow state' など) は出さず、固定の文にする (#1917 の続き)
    return { status: "failed", message: getJapaneseApiErrorMessage(e, AUTH_LINK_FAILED_MESSAGE) };
  }
}

/**
 * リンクのパラメータを処理する。
 * 同じリンク (同じ code など) が続けて渡されたら、2 回目以降は 1 回目の結果をそのまま返す。
 */
export function completeAuthLink(params: SupabaseLinkParams | null | undefined): Promise<AuthLinkOutcome> {
  if (!params) return Promise.resolve({ status: "empty" });

  if (params.error) {
    // GoTrue・provider の英文 (error_description・error の値) は端末のログにだけ残し、画面には固定の文を出す (#1917 の続き。Web の /auth/callback と同じ)
    console.warn("[authLink] link error:", params.error, params.error_description ?? "");
    return Promise.resolve({ status: "link_error", message: AUTH_LINK_ERROR_MESSAGE });
  }

  const key = linkKey(params);
  if (!key) {
    // 1 通目の確認を受け付けたときの知らせの判定は Web と共通 (packages/shared の email-change-link.ts。#1574)。
    // これ以外の知らせは、何が起きたか分からないので「処理できる情報が無い」扱いのままにする
    if (isEmailChangeAwaitingOtherMessage(params.message)) {
      return Promise.resolve({ status: "awaiting_other_confirmation" });
    }
    return Promise.resolve({ status: "empty" });
  }

  const now = Date.now();
  for (const [k, entry] of inFlight) {
    if (now - entry.at > RESULT_SHARE_MS) inFlight.delete(k);
  }
  const existing = inFlight.get(key);
  if (existing) return existing.promise;

  const promise = processLink(params);
  inFlight.set(key, { at: now, promise });
  return promise;
}

/** テスト用: 共有している結果を捨てる */
export function resetAuthLinkResultsForTests(): void {
  inFlight.clear();
}
