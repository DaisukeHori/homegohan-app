// packages/core は Web / Mobile で共有するコードの置き場です。
// まずは雛形として追加し、必要なものから段階的に移行します。

export const CORE_VERSION = "0.1.0";

export * from "./types/userProfile";
export * from "./converters/userProfile";
export * from "./api/httpClient";


