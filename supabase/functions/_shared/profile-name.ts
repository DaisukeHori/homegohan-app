// supabase/functions/_shared/profile-name.ts
// プロフィールの名前 (user_profiles.nickname) が「名前が無い」かどうかの判定を、Edge Functions で使うための写し (#1649)。
//
// 正本は packages/shared/src/profile-name.ts の normalizeProfileName (Web・モバイル・Next.js の API が使う)。
// Edge Functions (Deno) は packages/shared を import しないので、同じ規則をここにも置く。
// 正本との一致 (仮置きの値と、代表的な入力に対する答え) は tests/edge-profile-name-sync.test.ts が確かめる。

/**
 * プロフィールの名前が無いことを表す仮置き (packages/shared の PROFILE_NAME_PLACEHOLDER と同じ)。
 * 名前が無いまま user_profiles を作る・更新するとき、アプリと RPC はこの値を入れる。AI への入力や宛名に名前として渡さない。
 */
export const PROFILE_NAME_PLACEHOLDER = "Guest";

/**
 * プロフィールの名前を整える (packages/shared の normalizeProfileName と同じ)。
 * 無い・空白だけ・仮置き (前後の空白を除いて厳密一致) は「名前が無い」として null にする。
 * それ以外 ('guest'・'ゲスト' なども) は本人が付けた名前として、前後の空白を除いて返す。
 */
export function normalizeProfileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed === PROFILE_NAME_PLACEHOLDER ? null : trimmed;
}
