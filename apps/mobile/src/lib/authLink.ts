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

import type { SupabaseLinkParams } from "./deeplink";
import { supabase } from "./supabase";

export type AuthLinkOutcome =
  /** セッションを作れた */
  | { status: "signed_in" }
  /** リンク自体がエラーを運んできた (access_denied など)。message は利用者に見せてよい説明 */
  | { status: "link_error"; message: string }
  /** code の交換・OTP の確認・setSession のどれかが失敗した */
  | { status: "failed"; message: string }
  /** 処理できる情報が無い (リンクが無い・壊れている・別の画面向けのリンク) */
  | { status: "empty" };

type OtpType = "signup" | "email" | "recovery" | "invite";

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
    const message = (e as { message?: unknown } | null)?.message;
    return { status: "failed", message: typeof message === "string" && message ? message : "確認に失敗しました。" };
  }
}

/**
 * リンクのパラメータを処理する。
 * 同じリンク (同じ code など) が続けて渡されたら、2 回目以降は 1 回目の結果をそのまま返す。
 */
export function completeAuthLink(params: SupabaseLinkParams | null | undefined): Promise<AuthLinkOutcome> {
  if (!params) return Promise.resolve({ status: "empty" });

  if (params.error) {
    return Promise.resolve({ status: "link_error", message: params.error_description ?? params.error });
  }

  const key = linkKey(params);
  if (!key) return Promise.resolve({ status: "empty" });

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
