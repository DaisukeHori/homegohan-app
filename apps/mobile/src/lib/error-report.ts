// ErrorBoundary が捕まえた例外の記録 (#1207)
//
// 画面の描画中に起きた例外は、コンソール・PostHog・サーバーログ (app_logs) に残す。
//  - コンソール: console.error
//  - PostHog: 既存の captureEvent (PII キーの除去つき。PostHog が未設定なら何もしない)
//  - サーバーログ: Web の logToServer と同じ POST /api/log (ログイン前の画面では 401 で残らない)
//
// 守ること:
//  - この関数は例外を投げない。エラー画面の中で例外が出ると、その上の境界かアプリ全体に飛んでしまうため、
//    記録の失敗はすべて握りつぶす。
//  - ErrorBoundary は Provider の外 (ルートの境界) でも描画される。そのため Provider や hooks に頼らず、
//    モジュールの単一インスタンス (captureEvent / getApi) だけを使う。
//  - 画面遷移のパス (ルート名) は記録しない。どの境界かは boundary (例: 'tabs') で分かる。
//  - 例外の文面は長さを切り詰める。秘密情報のマスクと最終的な切り詰めはサーバー側 (sanitizeLogEntry) が行う。

import { Platform } from "react-native";

import { getApi } from "./api";
import { captureEvent } from "./posthog";

const MAX_NAME_CHARS = 100;
const MAX_MESSAGE_CHARS = 300;
const MAX_STACK_CHARS = 1500;

function clamp(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
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
  const name = clamp(err?.name, MAX_NAME_CHARS);
  const message = clamp(err ? err.message : String(error), MAX_MESSAGE_CHARS);

  try {
    console.error(`[ErrorBoundary:${boundary}]`, error);
  } catch {
    // ignore
  }

  try {
    captureEvent("app_error_boundary", {
      boundary,
      platform: Platform.OS,
      error_name: name,
      error_message: message,
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
          stack: clamp(err?.stack, MAX_STACK_CHARS),
        },
      }),
    ).catch(() => {});
  } catch {
    // ignore
  }
}
