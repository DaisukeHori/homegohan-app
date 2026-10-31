// src/lib/admin/plan-key-labels.ts
// 運営の画面で、利用者のプラン (plan_key) を日本語の表示名で出すための表 (#2112 Z3)。
//
// 以前、運営の利用者の一覧 (src/app/admin/users/page.tsx)・利用者の詳細 (src/app/admin/users/[id]/page.tsx)・NPS の画面
// (src/app/admin/finance/nps/page.tsx) は、プランを英字の内部の値 (free・family_basic など。空は free) のまま出していた。
// 値の一覧は公式の 9 種の plan_key (src/lib/super-admin/plans-schemas.ts の OFFICIAL_PLAN_KEYS。型だけを読む)。
// キーの型を OfficialPlanKey にして、値を足すと表示名の漏れが型の誤りになる形にする (USER_LIST_STATUS_LABELS と同じ形)。
// 有料の 3 つの名前と free の名前は、利用者の画面と同じ (packages/shared/src/billing-plans.ts の PLAN_CATALOG・FREE_PLAN_DISPLAY_NAME) にする。
// 運営が新しく作ったプランなど、表に無い plan_key は内部の値をそのまま出す (運営はプランの管理の画面の plan_key と突き合わせられる)。
// 利用者の画面の planDisplayName (表に無い値を「有料プラン」にまとめる) は、運営にはどのプランか分からなくなるので使わない。

import { FREE_PLAN_DISPLAY_NAME, PLAN_CATALOG, type PaidPlanKey } from '@homegohan/shared';
import type { OFFICIAL_PLAN_KEYS } from '@/lib/super-admin/plans-schemas';
import { labelOrRaw } from '@/lib/admin/value-labels';

export type OfficialPlanKey = (typeof OFFICIAL_PLAN_KEYS)[number];

/** plan_key が無い (null・空) 利用者のプラン (契約が無い = 無料。一覧・詳細の API の plan_key の既定と同じ) */
export const ADMIN_DEFAULT_PLAN_KEY: OfficialPlanKey = 'free';

/** 有料の 3 つのプランの、利用者の画面と同じ表示名 */
function catalogDisplayName(planKey: PaidPlanKey): string {
  return PLAN_CATALOG.find((plan) => plan.plan_key === planKey)?.display_name ?? planKey;
}

/** 公式の plan_key の、運営の画面の表示名 */
export const ADMIN_PLAN_KEY_LABELS: Readonly<Record<OfficialPlanKey, string>> = {
  free: FREE_PLAN_DISPLAY_NAME,
  pro: catalogDisplayName('pro'),
  family_basic: catalogDisplayName('family_basic'),
  family_pro: catalogDisplayName('family_pro'),
  family_addon: '家族の追加枠',
  org_starter: '組織 Starter',
  org_standard: '組織 Standard',
  org_pro: '組織 Pro',
  org_enterprise: '組織 Enterprise',
};

/** plan_key の運営の画面の表示名。null・空は ADMIN_DEFAULT_PLAN_KEY (free)、表に無い値はそのまま */
export function adminPlanKeyLabel(planKey: string | null | undefined): string {
  return labelOrRaw(ADMIN_PLAN_KEY_LABELS, planKey || ADMIN_DEFAULT_PLAN_KEY);
}
