/**
 * 機能フラグの 1 行を、ユーザーの属性に対して判定する純粋な関数 (#1148 / #1486) - Next.js と Supabase Edge Functions 共用
 *
 * feature_flags の 1 行 (enabled / rollout_strategy / constraints) とユーザーの属性から、そのユーザーにとって ON かを決める。
 * Next.js は src/lib/super-admin/evaluate-flag.ts の evaluateFlag (src/lib/feature-flags.ts の isFeatureEnabled が使う) から、
 * Edge Function は _shared/ai-chat-flag.ts (AI 相談の緊急停止スイッチ) から呼ぶ。判定を 2 か所に持たないため、ここに置く。
 *
 * このファイルが守る制約 (崩すと Edge Functions か Next.js のどちらかが動かなくなる):
 *  - 純粋な TypeScript。import なし、Deno / Node 固有の API なし (DB を読まない)。
 *
 * 行の形は operator/02-api-spec.md §7 (src/lib/super-admin/flags-schemas.ts の Zod の定義が正本)。
 */

/** 段階公開の決め方 (feature_flags.rollout_strategy) */
export interface FlagRolloutRule {
  type: 'all' | 'percentage' | 'plan' | 'role' | 'org';
  value?: number;
  plans?: string[];
  roles?: string[];
  org_ids?: string[];
}

/** 公開する相手の条件 (feature_flags.constraints) */
export interface FlagConstraintRule {
  min_user_age_days?: number;
  exclude_plans?: string[];
  include_plans?: string[];
  include_roles?: string[];
  include_org_ids?: string[];
}

/** feature_flags の 1 行のうち、判定に使う列 */
export interface FlagRuleRecord {
  key: string;
  enabled: boolean;
  rollout_strategy: FlagRolloutRule | null;
  constraints: FlagConstraintRule | null | undefined;
}

/** 判定するユーザーの属性 */
export interface FlagUserContext {
  userId: string;
  planKey?: string | null;
  roles?: string[];
  organizationId?: string | null;
  /** アカウント作成日時 (ISO 文字列)。constraints.min_user_age_days の判定に使う */
  accountCreatedAt?: string | null;
}

/** 判定に要るユーザーの属性の名前 (userId 以外) */
export type FlagContextField = 'planKey' | 'roles' | 'organizationId' | 'accountCreatedAt';

/** 1 日のミリ秒 (min_user_age_days の「日」) */
const DAY_MS = 24 * 60 * 60 * 1000;
/** percentage の段階公開の目盛りの数 (rollout_strategy.value は 0〜100 の百分率) */
const PERCENT_BUCKETS = 100;
/** stableBucket の文字列のハッシュの掛け数 (Java の String.hashCode と同じ 31。値を変えると、段階公開の対象のユーザーが入れ替わる) */
const BUCKET_HASH_MULTIPLIER = 31;

/**
 * 文字列を安定的に 0-99 のバケット値へ変換する (percentage rollout 用の決定的ハッシュ)。
 * 同じ (flagKey, userId) の組は常に同じバケット値を返すため、同一ユーザーへの判定結果は
 * enabled/value の変更が無い限り不変になる (rollout% を上げても既に対象だったユーザーは
 * 外れない = モノトニックに増える)。
 */
function stableBucket(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (Math.imul(hash, BUCKET_HASH_MULTIPLIER) + seed.charCodeAt(i)) >>> 0;
  }
  return hash % PERCENT_BUCKETS;
}

/**
 * feature_flags 1 行 + ユーザーの属性から有効/無効を判定する純粋関数。
 * @param flag - feature_flags テーブルの 1 行相当。存在しない (null) 場合は無効扱い (fail-closed)。
 *               行が無い・読めないときの既定値は、呼び出し側 (isFeatureEnabled・_shared/ai-chat-flag.ts) が決める
 * @param ctx - 判定対象ユーザーの属性
 */
export function evaluateFlagRule(flag: FlagRuleRecord | null, ctx: FlagUserContext): boolean {
  if (!flag) return false;
  if (!flag.enabled) return false;

  const constraints = flag.constraints;
  if (constraints) {
    if (typeof constraints.min_user_age_days === 'number' && ctx.accountCreatedAt) {
      const ageDays = (Date.now() - new Date(ctx.accountCreatedAt).getTime()) / DAY_MS;
      if (ageDays < constraints.min_user_age_days) return false;
    }
    if (constraints.exclude_plans && ctx.planKey && constraints.exclude_plans.includes(ctx.planKey)) {
      return false;
    }
    if (constraints.include_plans && constraints.include_plans.length > 0) {
      if (!ctx.planKey || !constraints.include_plans.includes(ctx.planKey)) return false;
    }
    const includeRoles = constraints.include_roles;
    if (includeRoles && includeRoles.length > 0) {
      if (!(ctx.roles ?? []).some((r) => includeRoles.includes(r))) return false;
    }
    if (constraints.include_org_ids && constraints.include_org_ids.length > 0) {
      if (!ctx.organizationId || !constraints.include_org_ids.includes(ctx.organizationId)) return false;
    }
  }

  const rollout = flag.rollout_strategy;
  if (!rollout || rollout.type === 'all') return true;

  switch (rollout.type) {
    case 'percentage': {
      const value = rollout.value ?? 0;
      if (value <= 0) return false;
      if (value >= PERCENT_BUCKETS) return true;
      return stableBucket(`${flag.key}:${ctx.userId}`) < value;
    }
    case 'plan':
      return !!ctx.planKey && !!rollout.plans?.includes(ctx.planKey);
    case 'role':
      return (ctx.roles ?? []).some((r) => rollout.roles?.includes(r));
    case 'org':
      return !!ctx.organizationId && !!rollout.org_ids?.includes(ctx.organizationId);
    default:
      return false;
  }
}

/** この行の判定に、ユーザーのどの属性が要るか (evaluateFlagRule が見る項目)。空なら userId だけで判定できる */
export function requiredFlagContextFields(record: FlagRuleRecord): FlagContextField[] {
  const fields = new Set<FlagContextField>();

  const constraints = record.constraints;
  if (constraints) {
    if (typeof constraints.min_user_age_days === 'number') fields.add('accountCreatedAt');
    if ((constraints.exclude_plans?.length ?? 0) > 0 || (constraints.include_plans?.length ?? 0) > 0) fields.add('planKey');
    if ((constraints.include_roles?.length ?? 0) > 0) fields.add('roles');
    if ((constraints.include_org_ids?.length ?? 0) > 0) fields.add('organizationId');
  }

  switch (record.rollout_strategy?.type) {
    case 'plan':
      fields.add('planKey');
      break;
    case 'role':
      fields.add('roles');
      break;
    case 'org':
      fields.add('organizationId');
      break;
    default:
      break;
  }

  return [...fields];
}
