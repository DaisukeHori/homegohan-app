// ErrorBoundary が捕まえた例外の記録 (#1207)
//
// 画面の描画中に起きた例外は、コンソール・PostHog・サーバーログ (app_logs) に残す。
//  - コンソール: console.error (端末の中だけ)
//  - PostHog: 既存の captureEvent。PostHog が未設定 (EXPO_PUBLIC_POSTHOG_KEY なし) なら何もしない。
//    PostHog は外部の計測サービスで、PostHogProvider の identify によりイベントがユーザー ID に紐づく。
//    captureEvent の PII フィルタ (sanitizeProps) はキー名で除くだけで、値の中身は見ない。
//    そのため、例外の文面・スタックは渡さない (operator/07 §15.7: error_message は PII を含まない実装にする)。
//    送るのは、境界・OS・例外の種類 (識別子の形のときだけ)・文面の指紋 (元に戻せないハッシュ) だけ。
//  - サーバーログ: Web の logToServer と同じ POST /api/log (ログイン前の画面では 401 で残らない)。
//    サーバー側 (sanitizeLogEntry) が秘密情報をマスクしてから app_logs に保存する。
//    例外の文面 (切り詰め済み) とスタックは、外部に出さずここにだけ残す。
//
// 守ること:
//  - この関数は例外を投げない。エラー画面の中で例外が出ると、その上の境界かアプリ全体に飛んでしまうため、
//    記録の失敗はすべて握りつぶす。
//  - ErrorBoundary は Provider の外 (ルートの境界) でも描画される。そのため Provider や hooks に頼らず、
//    モジュールの単一インスタンス (captureEvent / getApi) だけを使う。
//  - 画面遷移のパス (ルート名) は記録しない。どの境界かは boundary (例: 'tabs') で分かる。
//  - 例外の文面は長さを切り詰める。秘密情報のマスクと最終的な切り詰めはサーバー側 (sanitizeLogEntry) が行う。
//  - PostHog に渡すプロパティを足すときは、値が PII を含まないことを確かめてから足す (許可リスト方式)。
//    __tests__/lib/error-report.test.ts が、送るキーを固定している。

import { Platform } from "react-native";

import { getApi } from "./api";
import { captureEvent } from "./posthog";

const MAX_NAME_CHARS = 100;
const MAX_MESSAGE_CHARS = 300;
const MAX_STACK_CHARS = 1500;

/**
 * PostHog に送ってよい例外の種類 (Error.name)。TypeError / AxiosError / PostgrestError のような識別子の形だけ。
 * name は誰でも書き換えられる文字列 (error.name = ...) なので、形で絞らないと、文面が紛れ込んでも外に出てしまう。
 */
const SAFE_ERROR_NAME = /^[A-Za-z0-9_$.]{1,64}$/;

function clamp(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * 文字列の指紋を返す (32 bit の FNV-1a を、16 進 8 桁で)。
 *
 * 同じ例外を PostHog 上で数えるために使う。元の文字列には戻せない (長さも内容も落ちる) ので、
 * 文面そのものを外に出さずに「同じ文面かどうか」だけが分かる。暗号学的なハッシュではない
 * (候補の文字列が手元にあれば、一致するかは確かめられる) が、候補が無ければ元の文面は分からない。
 * 外部のライブラリも非同期処理も使わないので、Provider の外の ErrorBoundary の中でも同期的に呼べる。
 */
export function fingerprintOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * 境界が捕まえた例外を記録する。
 * @param boundary どの境界か (例: 'root' / 'tabs' / 'org')
 */
export function reportBoundaryError(boundary: string, error: unknown): void {
  const err = (typeof error === "object" && error !== null ? error : null) as {
    name?: unknown;
    message?: unknown;
    stack?: unknown;
  } | null;
  const rawName = err?.name;
  const name = clamp(rawName, MAX_NAME_CHARS);
  const message = clamp(err ? err.message : String(error), MAX_MESSAGE_CHARS);

  // 外部 (PostHog) に出してよい形に絞った値。
  //  - 種類: 識別子の形をしているときだけ。それ以外 (文面が入っている・長すぎる・文字列でない) は送らない
  //  - 指紋: 種類と文面から作る。文面が無い例外 (空の message など) には付けない
  const safeName = typeof rawName === "string" && SAFE_ERROR_NAME.test(rawName) ? rawName : undefined;
  const fingerprint = message === undefined ? undefined : fingerprintOf(`${name ?? ""}\n${message}`);

  try {
    console.error(`[ErrorBoundary:${boundary}]`, error);
  } catch {
    // ignore
  }

  try {
    // 外部の計測サービスなので、自由な文字列 (文面・スタック) は渡さない。送るのはこの項目だけ
    captureEvent("app_error_boundary", {
      boundary,
      platform: Platform.OS,
      ...(safeName ? { error_name: safeName } : {}),
      ...(fingerprint ? { error_fingerprint: fingerprint } : {}),
    });
  } catch {
    // ignore
  }

  try {
    // fire-and-forget。失敗 (オフライン・未ログイン・環境変数なし) は無視する
    void Promise.resolve(
      getApi().post("/api/log", {
        level: "error",
        message: `error boundary caught: ${boundary}`,
        metadata: {
          app: "mobile",
          platform: Platform.OS,
          boundary,
          name,
          message,
          // PostHog の error_fingerprint と同じ値。PostHog で件数を見つけたら、これで app_logs の文面を引ける
          fingerprint,
          stack: clamp(err?.stack, MAX_STACK_CHARS),
        },
      }),
    ).catch(() => {});
  } catch {
    // ignore
  }
}
