/**
 * 組織の管理画面のサイドバー (src/app/(org)/layout.tsx) の見出しに出す、組織の名前とプランの表示名 (#1912)
 *
 * 以前はプランの欄に固定の英語「Enterprise」を出していて、standard / premium の組織の管理者にも「Enterprise」と出ていた
 * (組織の設定の画面 /org/settings のプランの表示と食い違う)。サイドバーは user_profiles から organizations(name, plan) を
 * 結合で読むので、organizations.plan を src/lib/org-plans.ts の orgPlanLabel (日本語の名前・表に無い値は「-」) で出す。
 */
import { orgPlanLabel } from '@/lib/org-plans';

/** 組織の名前が読めないときにサイドバーに出す文字 (以前からの値をそのまま使う) */
export const ORG_SIDEBAR_NAME_FALLBACK = 'Organization';

export interface OrgSidebarInfo {
  /** 組織の名前 (空・読めないときは ORG_SIDEBAR_NAME_FALLBACK) */
  name: string;
  /** organizations.plan の日本語の表示名 (null・表に無い値は「-」) */
  planLabel: string;
}

/** 文字列ならそのまま、それ以外は null */
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * user_profiles の select('…, organizations(name, plan)') の結果から、サイドバーの見出しに出す名前とプランの表示名を作る。
 * 結合の結果は 1 行のオブジェクト (多対一の結合) だが、配列で返る形・null・欠けた列も受ける (型は結合の推論に頼らない)。
 */
export function readOrgSidebarInfo(profile: unknown): OrgSidebarInfo {
  const joined =
    profile !== null && typeof profile === 'object' && 'organizations' in profile
      ? (profile as { organizations: unknown }).organizations
      : null;
  const org: unknown = Array.isArray(joined) ? (joined[0] ?? null) : joined;
  const record: Record<string, unknown> =
    org !== null && typeof org === 'object' ? (org as Record<string, unknown>) : {};
  const name = stringOrNull(record.name);
  return {
    name: name ? name : ORG_SIDEBAR_NAME_FALLBACK,
    planLabel: orgPlanLabel(stringOrNull(record.plan)),
  };
}
