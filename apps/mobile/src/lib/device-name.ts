/**
 * この端末のログインに端末名を登録する (#1189)。設計の正典 docs/design/cross/16-auth-history-sessions.md §16。
 *
 * 端末名は機種名と OS の版 (例 "iPhone 15 Pro (iOS 18.0)")。利用者が付けた端末の名前 (Device.deviceName。人の名前を含みうる・
 * 日本語や ’ はサーバーで 400 になる) は使わない (§7.1)。サーバーの DEVICE_NAME_PATTERN (src/lib/auth/sessions/schemas.ts) に無い文字は除く。
 * 2 つの文字の決まりがずれても、サーバーが 400 を返して端末名が入らないだけ (登録は warn で終わり、一覧は device_label で出る)。
 *
 * 重ねよけは access token で行う (auth-js の Session は session_id を持たないので、セッションごとに変わる access token で見分ける)。
 * 同じ利用者のログアウト → ログインは新しいセッション = 新しい token で、その行に端末名を書く。refresh で token が変わった後は
 * 送り直すが、書く値は同じ (冪等)。
 */
import { Platform } from "react-native";
import * as Device from "expo-device";

import { patchCurrentDeviceName } from "./sessions-api";

/** サーバーの DEVICE_NAME_PATTERN (/^[A-Za-z0-9 ()._,+-]+$/) の補集合 */
export const DEVICE_NAME_DISALLOWED_CHARS = /[^A-Za-z0-9 ()._,+-]/g;
/** user_sessions_metadata.device_name varchar(200) (サーバーの DEVICE_NAME_MAX_LENGTH と同じ値) */
const DEVICE_NAME_MAX_LENGTH = 200;
const REPEATED_SPACES = / {2,}/g;

/** 機種名 + (OS の名前 版) から、サーバーが受け付ける形の端末名を作る。空になれば Platform.OS */
export function deviceNameOf(): string {
  const model = Device.modelName ?? Platform.OS;
  const os = [Device.osName, Device.osVersion].filter((part): part is string => typeof part === "string" && part !== "").join(" ");
  const raw = os ? `${model} (${os})` : model;
  const cleaned = raw.replace(DEVICE_NAME_DISALLOWED_CHARS, "").replace(REPEATED_SPACES, " ").trim().slice(0, DEVICE_NAME_MAX_LENGTH).trim();
  return cleaned === "" ? Platform.OS : cleaned;
}

/** 最後に登録を送った access token (プロセスの中だけ。保存しない) */
let lastRegisteredAccessToken: string | null = null;

/**
 * SIGNED_IN / INITIAL_SESSION で呼ぶ。同じ access token なら何もしない。違えば先にその token を覚えてから送る
 * (同時に来た同じ token の 2 回目は送らない)。失敗したら、覚えた値がまだその token なら null に戻し (次に送り直す)、
 * 例外は投げず warn だけ (token・端末名・応答は出さない)
 */
export async function registerDeviceName(accessToken: string): Promise<void> {
  if (lastRegisteredAccessToken === accessToken) return;
  lastRegisteredAccessToken = accessToken;
  try {
    await patchCurrentDeviceName(deviceNameOf());
  } catch {
    if (lastRegisteredAccessToken === accessToken) lastRegisteredAccessToken = null;
    console.warn("[device-name] 端末名を登録できませんでした");
  }
}
