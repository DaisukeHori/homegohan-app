// src/lib/profile-name.ts
// プロフィールの名前 (user_profiles.nickname) が「名前が無い」かどうかの判定 (#1611)。
//
// 判定の本体は @homegohan/shared (packages/shared/src/profile-name.ts) に置き、Web・モバイル・
// GET /api/onboarding/status が同じ関数を使う (#1635)。このファイルは既存の Web の呼び出し元
// (家族の画面 src/lib/membership/family-member-names.ts・ホームの呼びかけ src/lib/user-display.ts) のために
// 同じものを読み直すだけで、判定を持たない。
export { PROFILE_NAME_PLACEHOLDER, normalizeName, normalizeProfileName } from '@homegohan/shared';
