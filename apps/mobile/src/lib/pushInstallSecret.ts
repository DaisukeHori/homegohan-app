/**
 * この端末の通知のトークンの「端末の秘密の値」(install secret) を、端末の保管庫に置く (#1636)。
 * 取り決め (形・使い方) は packages/shared/src/push-token-claim.ts。
 *
 * - 端末ごと (アプリのインストールごと) に 1 つ。利用者ごとではない: 同じ端末でログインした利用者はみな同じ値を使い、
 *   claim が同じ端末の前の利用者の行を外し、release がサインアウトした利用者の行を消すときの所有の証明になる
 * - 値はサーバー (node:crypto) で作り、claim の応答で 1 度だけ返す (pushNotifications.ts の registerAndSaveExpoPushToken)。
 *   アプリは値を作らず、受け取った値を保管庫に置くだけ
 * - 保管庫は expo-secure-store (iOS Keychain / Android Keystore)。ログインのセッションと同じく、端末の初回ロック解除後は読め
 *   (バックグラウンドの起動でも読める)、バックアップの復元で別の端末へは移らない (AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY)
 * - ログアウト・退会の掃除では消さない (利用者のデータではなく端末のもの。消すと、次の利用者が前の利用者の行を外せなくなる)
 */

import { isPushInstallSecret } from "@homegohan/shared";
import * as SecureStore from "expo-secure-store";

/** 保管庫のキー (英数字と . - _ だけ。expo-secure-store の決まり) */
export const PUSH_INSTALL_SECRET_STORE_KEY = "push_install_secret_v1";

/** 保管庫を読んだ結果 */
export type PushInstallSecretRead =
  /** 値がある */
  | { status: "found"; secret: string }
  /** 値が無い (まだ発行していない)。形の違う値 (壊れた値) も、作り直すので無いものとして扱う */
  | { status: "missing" }
  /**
   * 保管庫を読めなかった (iOS で端末のロックを一度も解除していない起動など)。値があるかどうか分からないので、
   * 作り直さない (作り直すと、この端末の前の利用者の行を外せなくなる)
   */
  | { status: "unreadable" };

/** 書き込みの設定 (端末の初回ロック解除後は読める・別の端末へ移らない)。読み出しには効かない */
function writeOptions(): SecureStore.SecureStoreOptions | undefined {
  const accessible = SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY;
  return accessible === undefined ? undefined : { keychainAccessible: accessible };
}

/** 端末の秘密の値を読む。例外は投げない */
export async function readPushInstallSecret(): Promise<PushInstallSecretRead> {
  let value: string | null;
  try {
    value = await SecureStore.getItemAsync(PUSH_INSTALL_SECRET_STORE_KEY);
  } catch {
    return { status: "unreadable" };
  }
  return isPushInstallSecret(value) ? { status: "found", secret: value } : { status: "missing" };
}

/** サーバーが発行した端末の秘密の値を置く。置けたら true。例外は投げない (置けなければ次の claim で作り直す) */
export async function savePushInstallSecret(secret: string): Promise<boolean> {
  if (!isPushInstallSecret(secret)) return false;
  try {
    await SecureStore.setItemAsync(PUSH_INSTALL_SECRET_STORE_KEY, secret, writeOptions());
    return true;
  } catch {
    return false;
  }
}
