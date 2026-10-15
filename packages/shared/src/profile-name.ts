// packages/shared/src/profile-name.ts
// プロフィールの名前 (user_profiles.nickname) が「名前が無い」かどうかの判定 (#1611・#1635)。
//
// Web (src/lib/profile-name.ts はここを読み直すだけ)・モバイル (apps/mobile のプロフィール画面ほか)・
// GET /api/onboarding/status が、この 1 つの判定を使う。以前はモバイルが仮置きの 'Guest' をそのまま名前として出し、
// onboarding/status は前後の空白を除かずに `!== 'Guest'` で比べていた (#1635)。
//
// 仮置きとみなすのは 'Guest' の厳密一致 (前後の空白を除いたうえで) だけ:
//   - アプリと RPC が「名前が無い」ときに入れる値は 'Guest' だけ (/api/profile・/api/onboarding/progress・
//     /api/onboarding/complete・モバイルの初期設定、招待の承諾・法的文書の同意の RPC が行を作るとき)。
//     'ゲスト'・'guest' などを入れる経路は無いので、それらは本人が自分で付けた名前である
//
// Web のブラウザ・モバイル・サーバーのどれからも読むので、何も import しない。
//
// Edge Functions (Deno) はこのパッケージを import しないので、supabase/functions/_shared/profile-name.ts に同じ規則の写しがある (#1649)。
// ここを変えたら写しも変える (一致は tests/edge-profile-name-sync.test.ts が確かめる)。
// SQL の RPC (招待・昇格の詳細、家族の作成) も同じ規則を public.normalize_profile_name として持つ
// (supabase/migrations/20261015190000_rpc_profile_name_placeholder.sql。#1678)。ここを変えたら、新しい migration でその関数も変える
// (一致は tests/rpc-profile-name-placeholder-migration-contract.test.ts と、実 DB では tests/integration/security/rpc-profile-name-placeholder.test.ts が確かめる)。

/**
 * プロフィールの名前が無いことを表す仮置き。名前が無いまま user_profiles を作る・更新するとき、アプリと RPC はこの値を入れる。
 * 画面にこの英語の仮置きを名前として出さない。
 */
export const PROFILE_NAME_PLACEHOLDER = 'Guest';

/** 前後の空白を除き、空なら null にする (空白だけの名前は「無い」とみなす) */
export function normalizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * プロフィールの名前を整える。無い・空白だけ・仮置き (PROFILE_NAME_PLACEHOLDER。前後の空白を除いて厳密一致) は
 * 「名前が無い」として null にする。それ以外 ('guest'・'ゲスト' なども) は本人が付けた名前として、前後の空白を除いて返す。
 */
export function normalizeProfileName(value: unknown): string | null {
  const name = normalizeName(value);
  return name === PROFILE_NAME_PLACEHOLDER ? null : name;
}
