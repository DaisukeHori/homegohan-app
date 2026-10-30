// src/lib/admin/org-plan-labels.ts
// 運営の組織の画面 (src/app/admin/organizations/OrganizationsManager.tsx) で、組織のプラン (organizations.plan) を日本語の表示名で出すための関数 (#2112 Z3)。
//
// 以前、運営の組織の一覧は、行のプランの札・プランの変更の選択肢・作成と検索のプランの選択肢・プランの変更の通知を、
// 英字の内部の値 (standard / premium / enterprise) のまま出していた。
// 表示名の表は、値の一覧 (ORG_PLAN_VALUES) と同じファイルの ORG_PLAN_LABELS (src/lib/org-plans.ts。組織の設定の画面・サイドバーと同じ名前) を使う。
// 運営の画面では、表に無い値 (CHECK の無い列に service_role で書かれた値など) を「-」に隠さず内部の値のまま出す (labelOrRaw。運営は内部の値から原因を追える)。
// 利用者の画面の orgPlanLabel (表に無い値を「-」にする) は、運営には何の値が入っているか分からなくなるので使わない。

import { ORG_PLAN_LABELS, ORG_UNKNOWN_VALUE_LABEL } from '@/lib/org-plans';
import { labelOrRaw } from '@/lib/admin/value-labels';

/** organizations.plan の運営の画面の表示名。null は ORG_UNKNOWN_VALUE_LABEL (「-」)、表に無い値はそのまま */
export function adminOrgPlanLabel(value: string | null | undefined): string {
  if (value == null) return ORG_UNKNOWN_VALUE_LABEL;
  return labelOrRaw(ORG_PLAN_LABELS, value);
}
