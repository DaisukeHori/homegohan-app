// src/lib/membership/role-labels.ts
// 組織の役割 (user_profiles.org_role) と家族の役割 (family_members.role) を、画面に出す日本語の名前にする (#2073)。
//
// 以前、設定のメンバーシップの画面は組織の役割を「役割: owner」と内部の英字の値のまま出し、運営の家族の代表者の付け替えの画面は
// 候補の役割を「adult」のまま出していた。組織のメンバー・オーナーの譲渡の画面と家族の画面は、それぞれの画面の中で日本語に訳していたので、
// その対応表をここに 1 つにまとめ、どの画面も同じ語を出す。
// org_role_enum は owner / admin / member、family_role_enum は representative / adult / child の 3 つずつ
// (supabase/migrations/20251126124224_create_meal_planner_tables.sql の CREATE TYPE)。
// 表に無い値 (将来の値・壊れた応答) は、内部の値を画面に出さず ROLE_UNKNOWN_LABEL を出す。
//
// このファイルはブラウザからも読むので、サーバー専用のものを import しない。

/** 組織の役割の表示名 */
export const ORG_ROLE_LABELS = {
  owner: 'オーナー',
  admin: '管理者',
  member: 'メンバー',
} as const;

/** 家族の役割の表示名 */
export const FAMILY_ROLE_LABELS = {
  representative: '代表',
  adult: '大人',
  child: '子供',
} as const;

/** 表に無い役割に出す固定の文 (内部の英字の値は出さない) */
export const ROLE_UNKNOWN_LABEL = 'メンバー';

function lookup<T extends Record<string, string>>(table: T, role: string | null | undefined): string {
  if (role != null && Object.prototype.hasOwnProperty.call(table, role)) return table[role as keyof T];
  return ROLE_UNKNOWN_LABEL;
}

/** 組織の役割 (owner / admin / member) の表示名。表に無い値・null は ROLE_UNKNOWN_LABEL */
export function orgRoleLabel(role: string | null | undefined): string {
  return lookup(ORG_ROLE_LABELS, role);
}

/** 家族の役割 (representative / adult / child) の表示名。表に無い値・null は ROLE_UNKNOWN_LABEL */
export function familyRoleLabel(role: string | null | undefined): string {
  return lookup(FAMILY_ROLE_LABELS, role);
}
