// packages/core は Web / Mobile で共有するコードの置き場です。
// まずは雛形として追加し、必要なものから段階的に移行します。

export const CORE_VERSION = "0.4.0"; // 栄養目標計算モジュール追加

// 型定義
export * from "./types/userProfile";

// コンバーター
export * from "./converters/userProfile";

// APIクライアント
export * from "./api/httpClient";

// 献立生成v2スキーマ
export * from "./schemas";

// 週計算ユーティリティ
export * from "./utils/week-utils";

// 栄養目標計算モジュール（DRI2020準拠）
export * from "./nutrition";


