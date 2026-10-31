// src/lib/admin/operator-role-labels.ts
// 運営の画面で、利用者のロール (user_profiles.roles の値) を日本語の表示名で出すための表 (#2120 W3-1)。
//
// 以前、運営の利用者の一覧 (src/app/admin/users/page.tsx) と利用者の詳細 (src/app/admin/users/[id]/page.tsx) は、
// ロールを英字の内部の値 (super_admin など) のまま font-mono の札で出していた (同じ画面のプラン・ステータスは日本語の表示名。#2112 Z3)。
// 値の一覧は公式の 12 種のロール (src/lib/auth/types.ts の RoleName。型だけを読む)。キーの型を RoleName にして、
// ロールを足すと表示名の漏れが型の誤りになる形にする (ADMIN_PLAN_KEY_LABELS と同じ形)。
// 表示名は要件の公式ロール一覧 (docs/requirements/03-operator-admin.md §7.1.1 の「用途」の列) の語にそろえる。
// user_profiles.roles の列には CHECK が無い (アプリの層で確かめる) ので、表に無い値は内部の値をそのまま出す
// (labelOrRaw。運営は内部の値から原因を追える)。
// 組織の役割 (user_profiles.org_role) と家族の役割の表 (src/lib/membership/role-labels.ts) は、表に無い値を固定の文にする
// 利用者の画面の規則なので、ここでは使わない。
//
// このファイルはブラウザからも読むので、RoleName の型と labelOrRaw (何も import しない) のほかは import しない。

import type { RoleName } from '@/lib/auth/types';
import { labelOrRaw } from '@/lib/admin/value-labels';

/** 公式のロールの、運営の画面の表示名 */
export const OPERATOR_ROLE_LABELS: Readonly<Record<RoleName, string>> = {
  user: '一般ユーザー',
  support: 'サポート',
  sales: '営業',
  finance: '経理',
  content_moderator: 'モデレーター',
  org_member: '組織メンバー',
  org_viewer: '組織閲覧専用',
  org_manager: '組織マネージャー',
  org_admin: '組織管理者',
  org_industrial_doctor: '産業医',
  admin: '運営管理者',
  super_admin: '運営最上位',
};

/**
 * super_admin だけが開ける画面 (/super-admin) の呼び名 (#2128 V1-2)。
 * ロールの表示名 (OPERATOR_ROLE_LABELS.super_admin) と同じ語を使い、新しい語を作らない。
 * /admin のサイドバーのリンク・入口のカード・/super-admin のサイドバーの見出しで使う
 */
export const SUPER_ADMIN_SCREEN_LABEL = `${OPERATOR_ROLE_LABELS.super_admin}の画面`;

/** super_admin だけが使える操作・画面に添える注記 (例「運営最上位のみ」。#2128 V1-2) */
export const SUPER_ADMIN_ONLY_NOTE = `${OPERATOR_ROLE_LABELS.super_admin}のみ`;

/** ロールの運営の画面の表示名。表に無い値はそのまま */
export function operatorRoleLabel(role: string): string {
  return labelOrRaw(OPERATOR_ROLE_LABELS, role);
}
