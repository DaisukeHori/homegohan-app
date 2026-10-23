/**
 * Sign in with Apple (iOS のネイティブのシート) → Supabase のセッション (docs/design/mobile/08-sign-in-with-apple.md §9.1・§11.5)。
 *  - スイッチ EXPO_PUBLIC_APPLE_SIGN_IN が on で iOS のときだけ有効 (Android・スイッチ無しのビルドではボタンを出さない)
 *  - nonce: raw を作り、Apple へは SHA-256 (hex)、Supabase へは raw を渡す (GoTrue が raw を hash して id_token の nonce と比べる)
 *  - 名前は初回だけ届く。user_metadata.full_name が空のときだけ updateUser で保存する
 *  - 認可コードはサーバ (POST /api/auth/apple/authorization) が refresh token に替えて保管する (退会のときの失効に使う)。失敗してもログインは止めない
 *  - 本物の Apple・Supabase には繋がない (テストは expo-apple-authentication・supabase.auth・getApi を差し替える)
 */
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import { Platform } from "react-native";
import { APPLE_SIGN_IN_MESSAGES, isAppleSignInFlagOn } from "@homegohan/shared";

import { getApi } from "./api";
import { supabase } from "./supabase";

export type AppleSignInOutcome =
  /** Supabase のセッションを作れた (名前の保存・認可コードの登録も試した) */
  | { status: "signed_in" }
  /** 利用者がシートを閉じた。画面は何も出さない */
  | { status: "cancelled" }
  /** 失敗。message は利用者に見せてよい固定の文 */
  | { status: "failed"; message: string };

/** expo-apple-authentication が投げるエラーの形 (code を持つ) */
type CodedError = { code?: unknown };

/** 利用者がシートを閉じたときの code (expo-apple-authentication) */
const ERR_REQUEST_CANCELED = "ERR_REQUEST_CANCELED";
/** 認可コードの登録の API */
export const APPLE_AUTHORIZATION_API_PATH = "/api/auth/apple/authorization";

/** このビルド・この端末で Apple のボタンを出すか (iOS かつスイッチが on)。isAvailableAsync はこの後に別で見る */
export function isAppleSignInEnabled(): boolean {
  // 名前を直接書く (Metro の置き換えは process.env.EXPO_PUBLIC_X の形だけ。src/lib/env.ts の規則)
  return Platform.OS === "ios" && isAppleSignInFlagOn(process.env.EXPO_PUBLIC_APPLE_SIGN_IN);
}

/** 有効で、かつ端末が対応している (iOS 13 以降。シミュレータは対応と答えるが実機でしか動かない) */
export async function isAppleSignInAvailable(): Promise<boolean> {
  if (!isAppleSignInEnabled()) return false;
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

function fullNameOf(
  name: AppleAuthentication.AppleAuthenticationFullName | null,
): { full_name: string; given_name: string | null; family_name: string | null } | null {
  const given = name?.givenName?.trim() || null;
  const family = name?.familyName?.trim() || null;
  if (!given && !family) return null;
  return { full_name: [given, family].filter(Boolean).join(" "), given_name: given, family_name: family };
}

/** 初回だけ届く名前を保存する (既に full_name があれば上書きしない)。失敗はログだけ */
async function saveAppleFullName(
  name: AppleAuthentication.AppleAuthenticationFullName | null,
  currentFullName: unknown,
): Promise<void> {
  const parts = fullNameOf(name);
  if (!parts) return;
  if (typeof currentFullName === "string" && currentFullName.trim() !== "") return;
  const { error } = await supabase.auth.updateUser({ data: parts });
  if (error) console.warn("[appleSignIn] could not save the name from Apple", error.name);
}

/** 認可コードをサーバへ渡す (refresh token の保管)。失敗はログだけ (ログインの結果を変えない) */
async function registerAppleAuthorization(authorizationCode: string | null): Promise<void> {
  if (!authorizationCode) return;
  try {
    await getApi().post(APPLE_AUTHORIZATION_API_PATH, { authorization_code: authorizationCode });
  } catch (error) {
    console.warn("[appleSignIn] could not register the authorization code", error instanceof Error ? error.name : "unknown");
  }
}

export async function signInWithApple(): Promise<AppleSignInOutcome> {
  const rawNonce = Crypto.randomUUID();
  const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);

  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });
  } catch (error) {
    if ((error as CodedError | null)?.code === ERR_REQUEST_CANCELED) return { status: "cancelled" };
    return { status: "failed", message: APPLE_SIGN_IN_MESSAGES.failed };
  }
  if (!credential.identityToken) return { status: "failed", message: APPLE_SIGN_IN_MESSAGES.noIdentityToken };

  const { data, error } = await supabase.auth.signInWithIdToken({
    provider: "apple",
    token: credential.identityToken,
    nonce: rawNonce,
  });
  if (error) return { status: "failed", message: APPLE_SIGN_IN_MESSAGES.failed };

  await saveAppleFullName(credential.fullName, data.user?.user_metadata?.full_name);
  await registerAppleAuthorization(credential.authorizationCode);
  return { status: "signed_in" };
}
