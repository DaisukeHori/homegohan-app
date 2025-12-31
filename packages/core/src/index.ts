// packages/core は Web / Mobile で共有するコードの置き場です。
// まずは雛形として追加し、必要なものから段階的に移行します。

export const CORE_VERSION = "0.2.0"; // v2スキーマ追加

// 型定義
export * from "./types/userProfile";

// コンバーター
export * from "./converters/userProfile";

// APIクライアント
export * from "./api/httpClient";

// 献立生成v2スキーマ
export * from "./schemas";


