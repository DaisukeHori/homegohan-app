/**
 * プランの契約者を数える (#1127)
 *
 * 契約者がいるプランを廃止 (status = 'deprecated') すると、契約者への移行案内・自動更新の停止・
 * 廃止前の通知 (90 / 30 / 7 日前) がまだ無いため、廃止したプランで課金だけが続くおそれがある。
 * 課金が始まるまでは「契約者が 0 になってから廃止する」運用にし、PATCH /api/super-admin/plans/[id] が
 * 廃止の前にここで契約者を数えて、1 件でもあれば止める。
 * 数えてから書くまでの間に入った契約は、書く文の中の DB のトリガー guard_plan_deprecate_subscribers が同じ数え方で数え直して止める (#1917。
 * プランの行を FOR UPDATE でロックし直し、commit 前の契約の作成を待つ。PLAN_HAS_SUBSCRIBERS_DB_ERROR)。数え方を変えるときは、
 * トリガー (supabase/migrations/20261024110000_plan_deprecate_lock_and_price_change_reservation.sql) も同じに直す
 * (tests/plan-deprecate-lock-price-change-reservation-migration-contract.test.ts が突き合わせる)。
 *
 * 数える対象は「契約が終わっていないもの」だけ。
 *   - personal_subscriptions : plan_key が一致し、status が trialing / active / paused / past_due / grace
 *                              (cancelled / expired は終了済み)
 *   - family_groups          : plan_key が一致し、status = 'active' (dissolved は解散済み)
 *   - organizations          : plan が plan_key と一致し、status = 'active' (dissolved は解散済み。
 *                              解散しても plan は残るので、status で絞らないと解散済みの組織が廃止を止め続ける)
 *                              ただし組織のプランの行 (plan_type = 'org' の org_*。isOrgSubscriptionPlanRow) では数えない (#1912)。
 *                              organizations.plan に入るのは組織の段階 (standard / premium / enterprise。ORG_PLAN_VALUES) だけで、
 *                              org_* と一致することは無い。数えると件数は常に 0 になり、「組織の契約者は 0 件だから廃止してよい」と
 *                              読めてしまう。組織の利用者の判定 (get_effective_plan) は organizations.plan を使い、org_* の行を使わないので、
 *                              この行に「組織の契約者」はいない。件数の欄 (organizations) を出さず、注記 (ORG_SUBSCRIPTION_PLAN_ROW_NOTE) を出す。
 *                              個人・家族のプランの数え方は変えない
 *
 * 呼び出し側は、必ず requireRole 等の認可を通したあとに service_role のクライアントを渡すこと。
 * RLS に左右されずに全員分を数えるためで、件数だけを取り (head: true)、他人の行の中身は読まない。
 *
 * 数えられなかったとき (DB エラー、件数が返らない、plan_key が空) は 0 件として扱わず、例外を投げる。
 * 「確認できなかった」を「契約者なし」と取り違えると、安全装置が黙って外れるため。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ORG_PLAN_VALUES } from '@/lib/org-plans';
import { isOrgSubscriptionPlanRow } from '@/lib/super-admin/ai-daily-limits';

/** 個人契約のうち、契約が終わっていない status (cancelled / expired は終了済みなので数えない) */
export const ACTIVE_PERSONAL_SUBSCRIPTION_STATUSES = ['trialing', 'active', 'paused', 'past_due', 'grace'] as const;

/**
 * 契約者数の内訳。キーは数えたテーブル名。
 * organizations は、組織のプランの行 (org_*) では数えないので、キーそのものが無い (0 ではない。#1912)。
 * 呼び出し側は organizations が無いことを「0 件」と読まず、isOrganizationsCounted で分ける
 */
export interface PlanSubscriberCounts {
  personal_subscriptions: number;
  family_groups: number;
  organizations?: number;
}

/** 数える対象のプラン (subscription_plans の行の plan_key と plan_type) */
export interface PlanSubscriberCountTarget {
  plan_key: string;
  plan_type: string | null;
}

/**
 * 組織のプランの行 (org_*) の廃止・価格変更で、組織の件数の代わりに出す注記 (#1912)。
 * オーナーの選択 (2026-10-22・選択式)「org_* は数えないと明記 (推奨)」
 */
export const ORG_SUBSCRIPTION_PLAN_ROW_NOTE = `組織のプラン (org_*) の行は、組織の段階 (${ORG_PLAN_VALUES.join(' / ')}) とは無関係で、組織の利用者の判定に使われません。そのため、組織の件数は数えません。`;

/**
 * そのプランで組織の件数を数えるか。組織のプランの行 (plan_type = 'org' の org_*) では数えない (#1912)。
 * 個人・家族のプラン (と、plan_type = 'org' でも組織の段階と同じ key の行) は、これまでどおり数える
 */
export function countsOrganizationsFor(plan: PlanSubscriberCountTarget): boolean {
  return !isOrgSubscriptionPlanRow(plan);
}

/** 内訳に組織の件数があるか (無いときは「数えていない」で、0 件ではない) */
export function isOrganizationsCounted(counts: PlanSubscriberCounts): counts is PlanSubscriberCounts & { organizations: number } {
  return typeof counts.organizations === 'number';
}

/** count を取るだけなので、from だけあればよい (service_role のクライアントを渡す) */
export type SubscriberCountClient = Pick<SupabaseClient<any, any, any>, 'from'>;

/** 契約者数を確認できなかったとき。どのテーブルで・どの DB エラーコードだったかを呼び出し側のログに残せるようにする */
export class PlanSubscriberCountError extends Error {
  readonly table: string;
  readonly pgCode: string | undefined;

  constructor(table: string, detail: string, pgCode?: string) {
    super(`${table} の契約者数を確認できませんでした: ${detail}`);
    this.name = 'PlanSubscriberCountError';
    this.table = table;
    this.pgCode = pgCode;
  }
}

interface CountOutcome {
  count: number | null;
  error: { message: string; code?: string } | null;
}

/** 1 テーブル分の結果から件数を取り出す。エラー・件数なしは「確認できなかった」として投げる */
function unwrapCount(table: string, outcome: CountOutcome): number {
  if (outcome.error) {
    throw new PlanSubscriberCountError(table, outcome.error.message, outcome.error.code);
  }
  if (typeof outcome.count !== 'number') {
    throw new PlanSubscriberCountError(table, '件数が返りませんでした');
  }
  return outcome.count;
}

/**
 * プランに、契約が終わっていない契約者が何件いるかをテーブルごとに数える。
 *
 * @param admin service_role のクライアント (呼び出し側で認可 (requireRole 等) を通したあとに渡す)
 * @param plan 数えるプランの plan_key と plan_type。plan_key が空だと「どれにも一致しない = 0 件」になってしまうので、空は例外にする。
 *             plan_type は組織の件数を数えるかの判定 (countsOrganizationsFor) に使う。組織のプランの行 (org_*) では
 *             organizations を読まず、内訳にもキーを入れない (#1912)
 */
export async function countPlanSubscribers(
  admin: SubscriberCountClient,
  plan: PlanSubscriberCountTarget,
): Promise<PlanSubscriberCounts> {
  const planKey = plan?.plan_key;
  if (typeof planKey !== 'string' || planKey.length === 0) {
    throw new PlanSubscriberCountError('plan_key', 'plan_key が空です');
  }
  const countOrganizations = countsOrganizationsFor(plan);

  const [personal, family, organizations] = await Promise.all([
    admin
      .from('personal_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('plan_key', planKey)
      .in('status', [...ACTIVE_PERSONAL_SUBSCRIPTION_STATUSES]),
    admin
      .from('family_groups')
      .select('id', { count: 'exact', head: true })
      .eq('plan_key', planKey)
      .eq('status', 'active'),
    countOrganizations
      ? admin
          .from('organizations')
          .select('id', { count: 'exact', head: true })
          .eq('plan', planKey)
          .eq('status', 'active')
      : null,
  ]);

  const counts: PlanSubscriberCounts = {
    personal_subscriptions: unwrapCount('personal_subscriptions', personal),
    family_groups: unwrapCount('family_groups', family),
  };
  if (organizations !== null) {
    counts.organizations = unwrapCount('organizations', organizations);
  }
  return counts;
}

/**
 * 契約者の合計 (1 以上なら廃止できない)。
 * 数えていない欄 (組織のプランの行の organizations) は足さない。0 件として足すのではなく、判定の対象に入らない (#1912)
 */
export function totalPlanSubscribers(counts: PlanSubscriberCounts): number {
  const personalAndFamily = counts.personal_subscriptions + counts.family_groups;
  return isOrganizationsCounted(counts) ? personalAndFamily + counts.organizations : personalAndFamily;
}

/**
 * DB のトリガー guard_plan_deprecate_subscribers が、廃止 (status → deprecated) の UPDATE の中で契約者を見つけたときに RAISE する文 (#1917。
 * supabase/migrations/20261024110000_plan_deprecate_lock_and_price_change_reservation.sql)。
 * route が数えてから書くまでの間に契約が入ったときや、route を通らない UPDATE を止める。SQLSTATE は P0001、DETAIL は内訳の JSON
 */
export const PLAN_HAS_SUBSCRIBERS_DB_ERROR = 'OP_PLAN_HAS_SUBSCRIBERS';

/** トリガーの DETAIL (内訳の JSON) の形。キーは countPlanSubscribers と同じ (組織のプランの行では organizations が無い) */
const PlanSubscriberCountsDetailSchema = z
  .object({
    personal_subscriptions: z.number().int().min(0),
    family_groups: z.number().int().min(0),
    organizations: z.number().int().min(0).optional(),
  })
  .strict();

/** DB の失敗が、廃止のトリガーの「契約者がいる」か */
export function isPlanHasSubscribersDbError(error: { message?: string } | null | undefined): boolean {
  return error?.message === PLAN_HAS_SUBSCRIBERS_DB_ERROR;
}

/**
 * トリガーの DETAIL (JSON の文字列) を内訳にする。形が違えば null (呼び出し側は数えられなかったときと同じく扱う)
 */
export function parsePlanSubscriberCountsDetail(detail: unknown): PlanSubscriberCounts | null {
  if (typeof detail !== 'string') return null;
  let json: unknown;
  try {
    json = JSON.parse(detail);
  } catch {
    return null;
  }
  const parsed = PlanSubscriberCountsDetailSchema.safeParse(json);
  if (!parsed.success) return null;
  const { personal_subscriptions, family_groups, organizations } = parsed.data;
  return organizations === undefined
    ? { personal_subscriptions, family_groups }
    : { personal_subscriptions, family_groups, organizations };
}

const COUNT_LABELS: ReadonlyArray<readonly [keyof PlanSubscriberCounts, string]> = [
  ['personal_subscriptions', '個人契約'],
  ['family_groups', '家族グループ'],
  ['organizations', '組織'],
];

/**
 * 契約者がいて廃止できないときに、運営画面にそのまま出す文面。
 * 件数は 1 件以上あるものだけを並べる。
 *
 * @param options.canUnpublish 今は公開中のプランか。公開中なら「新しい申込だけを止めたいときは非公開にする」と案内する
 *                             (非公開にすると新規申込が止まり、既存の契約は続く。すでに非公開のプランには案内しない)
 */
export function planHasSubscribersMessage(counts: PlanSubscriberCounts, options: { canUnpublish: boolean }): string {
  const breakdown = COUNT_LABELS.flatMap(([key, label]) => {
    const count = counts[key];
    return typeof count === 'number' && count > 0 ? [`${label} ${count} 件`] : [];
  }).join('・');
  const unpublishHint = options.canUnpublish ? '新しい申込だけを止めたいときは、「非公開にする」を使ってください。' : '';
  // 組織の件数を数えていない (組織のプランの行) ときは、件数の代わりに注記を添える (#1912)
  const organizationsNote = isOrganizationsCounted(counts) ? '' : ORG_SUBSCRIPTION_PLAN_ROW_NOTE;
  return `契約者がいるため、このプランは廃止できません (${breakdown})。${organizationsNote}${unpublishHint}契約がすべて終了してから、もう一度廃止してください。`;
}
