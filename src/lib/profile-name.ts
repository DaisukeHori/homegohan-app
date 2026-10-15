// src/lib/profile-name.ts
// プロフィールの名前 (user_profiles.nickname) が「名前が無い」かどうかの判定 (#1611)。
//
// 以前は判定が 2 系統あった: 家族の画面 (src/lib/membership/family-member-names.ts) は 'Guest' の厳密一致だけ、
// ホームの呼びかけ (src/lib/user-display.ts) は 'guest' (大小無視)・'ゲスト'・'guest user'・'ゲストユーザー' も仮置き扱い。
// ここに 1 つにまとめ、両方がこれを使う。
//
// 揃える先は 'Guest' の厳密一致 (前後の空白を除いたうえで):
//   - アプリと RPC が「名前が無い」ときに入れる値は 'Guest' だけ (/api/profile・/api/onboarding/progress・
//     /api/onboarding/complete・モバイルの初期設定、招待の承諾・法的文書の同意の RPC が行を作るとき)。
//     'ゲスト'・'guest' などを入れる経路は無いので、それらは本人が自分で付けた名前である
//   - src/app/api/onboarding/status/route.ts も `nickname !== 'Guest'` だけを「名前が付いていない」と読む。
//     本人が 'ゲスト' と付けた人は初期設定を終えた扱いなので、家族の画面でも「名前未設定」にせずその名前を出す
//
// このファイルはブラウザからも読むので、何も import しない。

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
