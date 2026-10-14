/**
 * プランの契約者を数える (#1127)
 *
 * 契約者がいるプランを廃止 (status = 'deprecated') すると、契約者への移行案内・自動更新の停止・
 * 廃止前の通知 (90 / 30 / 7 日前) がまだ無いため、廃止したプランで課金だけが続くおそれがある。
 * 課金が始まるまでは「契約者が 0 になってから廃止する」運用にし、PATCH /api/super-admin/plans/[id] が
 * 廃止の前にここで契約者を数えて、1 件でもあれば止める。
 *
 * 数える対象は「契約が終わっていないもの」だけ。
 *   - personal_subscriptions : plan_key が一致し、status が trialing / active / paused / past_due / grace
 *                              (cancelled / expired は終了済み)
 *   - family_groups          : plan_key が一致し、status = 'active' (dissolved は解散済み)
 *   - organizations          : plan が plan_key と一致し、status = 'active' (dissolved は解散済み。
 *                              解散しても plan は残るので、status で絞らないと解散済みの組織が廃止を止め続ける)
 *
 * 呼び出し側は、必ず requireRole 等の認可を通したあとに service_role のクライアントを渡すこと。
 * RLS に左右されずに全員分を数えるためで、件数だけを取り (head: true)、他人の行の中身は読まない。
 *
 * 数えられなかったとき (DB エラー、件数が返らない、plan_key が空) は 0 件として扱わず、例外を投げる。
 * 「確認できなかった」を「契約者なし」と取り違えると、安全装置が黙って外れるため。
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** 個人契約のうち、契約が終わっていない status (cancelled / expired は終了済みなので数えない) */
export const ACTIVE_PERSONAL_SUBSCRIPTION_STATUSES = ['trialing', 'active', 'paused', 'past_due', 'grace'] as const;

/** 契約者数の内訳。キーは数えたテーブル名 */
export interface PlanSubscriberCounts {
  personal_subscriptions: number;
  family_groups: number;
  organizations: number;
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
 * plan_key のプランに、契約が終わっていない契約者が何件いるかをテーブルごとに数える。
 *
 * @param admin service_role のクライアント (呼び出し側で認可 (requireRole 等) を通したあとに渡す)
 * @param planKey 数えるプランの plan_key。空だと「どれにも一致しない = 0 件」になってしまうので、空は例外にする
 */
export async function countPlanSubscribers(admin: SubscriberCountClient, planKey: string): Promise<PlanSubscriberCounts> {
  if (typeof planKey !== 'string' || planKey.length === 0) {
    throw new PlanSubscriberCountError('plan_key', 'plan_key が空です');
  }

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
    admin
      .from('organizations')
      .select('id', { count: 'exact', head: true })
      .eq('plan', planKey)
      .eq('status', 'active'),
  ]);

  return {
    personal_subscriptions: unwrapCount('personal_subscriptions', personal),
    family_groups: unwrapCount('family_groups', family),
    organizations: unwrapCount('organizations', organizations),
  };
}

/** 契約者の合計 (1 以上なら廃止できない) */
export function totalPlanSubscribers(counts: PlanSubscriberCounts): number {
  return counts.personal_subscriptions + counts.family_groups + counts.organizations;
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
  const breakdown = COUNT_LABELS.filter(([key]) => counts[key] > 0)
    .map(([key, label]) => `${label} ${counts[key]} 件`)
    .join('・');
  const unpublishHint = options.canUnpublish ? '新しい申込だけを止めたいときは、「非公開にする」を使ってください。' : '';
  return `契約者がいるため、このプランは廃止できません (${breakdown})。${unpublishHint}契約がすべて終了してから、もう一度廃止してください。`;
}
