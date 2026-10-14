// モバイルアプリの必須の環境変数 (#1182 / #1434)
//
// アプリが動くのに欠かせないのは、Supabase の接続先 (URL と anon キー) の 2 つと、Next.js の API (BFF) の基点
// (EXPO_PUBLIC_API_BASE_URL。lib/api.ts の getApiBaseUrl() は、無いと例外を投げる) の 3 つ。
// ビルドのときに EAS の環境変数 (eas.json の env か、EAS に登録した環境変数) から埋め込まれる。
// 入れ忘れたビルドは、以前は https://placeholder.supabase.co という存在しない接続先でクライアントを作り、
// ログインなどが接続エラーで失敗し続けていた (原因が環境変数の入れ忘れだと分からない)。
// いまは存在しない接続先ではクライアントを作らず、足りない変数名を示す (lib/supabase.ts・app/_layout.tsx)。
//
// 守ること:
//  - EXPO_PUBLIC_* は、Metro がビルド時に値へ置き換える。置き換わるのは `process.env.EXPO_PUBLIC_X` と
//    名前を直接書いた箇所だけ。`process.env[name]` のように名前を変数にすると置き換わらず、実機では常に
//    undefined になる (開発中は動くのに、リリースビルドだけ動かなくなる)。そのため名前は 1 つずつ直接書く。
//    __tests__/lib/env.test.ts が、直接書いていることを検査する。
//  - 値は加工せずに返す (trim しない)。設定されているときの挙動は変えない。
//  - 何も import しない。ルートの layout (Provider の外) からも呼ばれるため、hooks や Provider に頼らない。

/** アプリが動くのに欠かせない環境変数の名前 (この順で、足りないものを返す) */
export const REQUIRED_MOBILE_ENV_NAMES = [
  "EXPO_PUBLIC_SUPABASE_URL",
  "EXPO_PUBLIC_SUPABASE_ANON_KEY",
  "EXPO_PUBLIC_API_BASE_URL",
] as const;

export type RequiredMobileEnvName = (typeof REQUIRED_MOBILE_ENV_NAMES)[number];

/** 必須の環境変数が無いときのエラー。missing に足りない変数名が入る (環境変数の値は含めない) */
export class MobileConfigError extends Error {
  readonly missing: readonly RequiredMobileEnvName[];

  constructor(missing: readonly RequiredMobileEnvName[]) {
    // lib/api.ts の getApiBaseUrl() も、このエラーで「[mobile] Missing env: EXPO_PUBLIC_API_BASE_URL」を投げる
    super(`[mobile] Missing env: ${missing.join(", ")}`);
    this.name = "MobileConfigError";
    this.missing = missing;
  }
}

export type SupabaseEnvResult =
  | { ok: true; url: string; anonKey: string }
  | { ok: false; missing: RequiredMobileEnvName[] };

export type RequiredMobileEnvResult = { ok: true } | { ok: false; missing: RequiredMobileEnvName[] };

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/**
 * Supabase の接続先を環境変数から取り出す。足りなければ、足りない変数名を返す (例外は投げない)。
 * 空文字・空白だけの値も、未設定として扱う。
 */
export function resolveSupabaseEnv(): SupabaseEnvResult {
  // 名前を直接書く (上の「守ること」を参照)
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  if (!isPresent(url) || !isPresent(anonKey)) {
    const missing: RequiredMobileEnvName[] = [];
    if (!isPresent(url)) missing.push("EXPO_PUBLIC_SUPABASE_URL");
    if (!isPresent(anonKey)) missing.push("EXPO_PUBLIC_SUPABASE_ANON_KEY");
    return { ok: false, missing };
  }
  return { ok: true, url, anonKey };
}

/**
 * Next.js の API (BFF) の基点 (EXPO_PUBLIC_API_BASE_URL)。未設定・空・空白だけなら undefined (例外は投げない)。
 * 値は加工せずに返す。lib/api.ts の getApiBaseUrl() が使う。
 */
export function resolveApiBaseUrl(): string | undefined {
  // 名前を直接書く (上の「守ること」を参照)
  const value = process.env.EXPO_PUBLIC_API_BASE_URL;
  return isPresent(value) ? value : undefined;
}

/**
 * 必須の環境変数 (REQUIRED_MOBILE_ENV_NAMES) がすべてあるか。足りなければ、足りない変数名を
 * REQUIRED_MOBILE_ENV_NAMES の順で返す (例外は投げない。値は含めない)。app/_layout.tsx のゲートが使う。
 */
export function resolveRequiredMobileEnv(): RequiredMobileEnvResult {
  const missing: RequiredMobileEnvName[] = [];
  const supabaseEnv = resolveSupabaseEnv();
  if (!supabaseEnv.ok) missing.push(...supabaseEnv.missing);
  if (resolveApiBaseUrl() === undefined) missing.push("EXPO_PUBLIC_API_BASE_URL");
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}
