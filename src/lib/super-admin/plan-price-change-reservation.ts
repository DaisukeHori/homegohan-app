/**
 * 価格の変更 (POST /api/super-admin/plans/{id}/price-change) の予約と書き込み (#1917)
 *
 * 価格の変更は、DB の鍵をまたげない Stripe の呼び出し (Edge Function stripe-price-sync が新しい Price を作り、
 * その時点の DB の旧 Price を無効化する) をはさむ。route が読んだ値をそのまま履歴 (plan_price_history) と監査の old_* に書き、
 * 価格を .eq(id) だけで UPDATE していたので、2 人の運営がほぼ同時に同じプランの価格を変えると、後の記録の old_* が
 * 実際の直前の値と食い違った。読んだ値を条件にした UPDATE と 409 だけでは、後の呼び出しの Edge Function が先の変更で入った Price を
 * 無効化したあとで 409 になり、DB が無効な Price を指したまま残る。
 *
 * そこで、プランごとの予約の行 (plan_price_change_reservations) で 1 本ずつにする
 * (supabase/migrations/20261024130000_plan_deprecate_lock_and_price_change_reservation.sql):
 *   1. beginPlanPriceChange   : プランの行をロックして予約を取り、ロックの下で読んだプランの値を返す。予約中なら in_progress
 *   2. (route が Stripe を呼ぶ。予約を取った 1 本だけが呼ぶ)
 *   3. applyPlanPriceChange   : 予約が自分のもののままなら、ロックの下で読んだ値を old_* にして履歴を INSERT し、価格を UPDATE し、
 *                               予約を消す (1 つのトランザクション)。変える前の値 (previous) を返すので、監査の old_* はこの値で書く
 *   4. releasePlanPriceChange : 3 まで行かなかったときに予約を消す
 *
 * 関数はどれも service_role だけが呼べる。呼び出し側は requireRole(['super_admin']) を通したあとに getSupabaseAdmin() を渡す。
 * DB の戻り値は Zod で確かめ、形が違えば例外にする (route の 500)。
 */
import { z } from 'zod';

/**
 * 予約の期限 (秒)。これより古い予約は、次の begin が取り直す (route の途中で落ちて消えなかった予約で、価格の変更が止まり続けないため)。
 * 生きている route の予約を横取りしないよう、Vercel の関数が 1 回の要求で動ける時間の上限 (Pro の fluid compute で最大 800 秒) より長くする。
 * route の途中で落ちたときは、この時間だけそのプランの価格の変更が 409 になる
 */
export const PRICE_CHANGE_RESERVATION_STALE_SECONDS = 900;

/**
 * 409 CONFLICT_STALE_DATA: 同じプランの価格の変更が進行中 (予約が取れなかった)。Stripe も DB も触っていない。
 * 進行中なのは別の運営の操作とは限らない: 応答が切れた (504 など) あとの押し直しでは、まだ走っている自分の 1 回目のことがある。
 * 関数が打ち切られて予約が残ったときは、期限 (PRICE_CHANGE_RESERVATION_STALE_SECONDS) まで同じ 409 が続く。
 * 以前は「別の運営がこのプランの価格を変更しています」と出し、運営自身の 1 回目を別の運営の操作と見せていた (#2107 Y6)
 */
export const PRICE_CHANGE_IN_PROGRESS_MESSAGE =
  'このプランの価格の変更が進行中です (直前のあなたの操作かもしれません)。しばらくしてから読み込み直して履歴で確かめてください';

/** 409 CONFLICT_STALE_DATA: 予約を失った (期限の後に別の運営が取り直した)。DB は書いていない */
export const PRICE_CHANGE_RESERVATION_LOST_MESSAGE =
  '別の運営が先にこのプランの価格を変更しました。価格(DB)は変更していません。画面を読み込み直して、もう一度確認してください';

/** 500 OP_DB_ERROR: 履歴と価格の保存 (apply) に失敗した。1 つのトランザクションなので、どちらも書いていない */
export const PRICE_CHANGE_SAVE_FAILED_MESSAGE = 'プランの価格を保存できませんでした。価格(DB)と変更履歴は変更していません。';

/** Stripe の同期のあとで DB に書けなかったときに添える文 (新しい Price は Stripe に作られている) */
export const STRIPE_PRICE_MAY_EXIST_NOTE =
  '※Stripe 側では新価格(Price)が作成済みの可能性があります(metadata の plan_key/changed_by で識別可)。';

/** 予約と書き込みの DB の関数の名前 */
export const PLAN_PRICE_CHANGE_RPC = {
  begin: 'begin_plan_price_change',
  apply: 'apply_plan_price_change',
  release: 'release_plan_price_change',
} as const;

/** 予約のときにロックの下で読んだプランの値 (route が Stripe の呼び出しと draft の判定に使う) */
export const ReservedPlanSchema = z.object({
  id: z.string(),
  plan_key: z.string(),
  status: z.string(),
  stripe_product_id: z.string().nullable(),
  stripe_price_id: z.string().nullable(),
  stripe_yearly_price_id: z.string().nullable(),
  monthly_price_jpy: z.number().int().nullable(),
  yearly_price_jpy: z.number().int().nullable(),
});
export type ReservedPlan = z.infer<typeof ReservedPlanSchema>;

/** begin_plan_price_change の戻り値 */
export const BeginPlanPriceChangeResultSchema = z.discriminatedUnion('result', [
  z.object({ result: z.literal('reserved'), token: z.string().min(1), plan: ReservedPlanSchema }),
  z.object({ result: z.literal('not_found') }),
  z.object({ result: z.literal('draft') }),
  z.object({ result: z.literal('in_progress') }),
]);
export type BeginPlanPriceChangeResult = z.infer<typeof BeginPlanPriceChangeResultSchema>;

/** 変える前の値 (apply がロックの下で読んだ、この更新の実際の直前の値) */
export const PlanPriceChangePreviousSchema = z.object({
  monthly_price_jpy: z.number().int().nullable(),
  yearly_price_jpy: z.number().int().nullable(),
  stripe_price_id: z.string().nullable(),
  stripe_yearly_price_id: z.string().nullable(),
});
export type PlanPriceChangePrevious = z.infer<typeof PlanPriceChangePreviousSchema>;

/** apply_plan_price_change の戻り値 */
export const ApplyPlanPriceChangeResultSchema = z.discriminatedUnion('result', [
  z.object({ result: z.literal('applied'), previous: PlanPriceChangePreviousSchema }),
  z.object({ result: z.literal('not_found') }),
  z.object({ result: z.literal('lost') }),
]);
export type ApplyPlanPriceChangeResult = z.infer<typeof ApplyPlanPriceChangeResultSchema>;

/** apply に渡す変更 (変えなかった方の金額・Price ID は null) */
export interface PlanPriceChangeInput {
  planId: string;
  token: string;
  newMonthlyPriceJpy: number | null;
  newYearlyPriceJpy: number | null;
  newStripePriceId: string | null;
  newStripeYearlyPriceId: string | null;
  changedBy: string;
  reason: string;
  effectiveAt: string;
  appliesTo: string;
}

/** DB の関数の呼び出しの失敗 (PostgREST の error) か、戻り値の形が違う */
export class PlanPriceChangeRpcError extends Error {
  readonly rpc: string;
  readonly pgCode: string | undefined;

  constructor(rpc: string, detail: string, pgCode?: string) {
    super(`${rpc} に失敗しました: ${detail}`);
    this.name = 'PlanPriceChangeRpcError';
    this.rpc = rpc;
    this.pgCode = pgCode;
  }
}

interface RpcOutcome {
  data: unknown;
  error: { message: string; code?: string } | null;
}

/** rpc を呼べればよい (service_role のクライアントを渡す) */
export interface PlanPriceChangeRpcClient {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcOutcome>;
}

async function callRpc<T>(client: PlanPriceChangeRpcClient, fn: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new PlanPriceChangeRpcError(fn, error.message, error.code);
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new PlanPriceChangeRpcError(fn, '戻り値の形が違います');
  return parsed.data;
}

/** 予約を取る (プランの行をロックし、予約が無いか期限より古いときだけ取る) */
export function beginPlanPriceChange(
  client: PlanPriceChangeRpcClient,
  planId: string,
  staleAfterSeconds: number = PRICE_CHANGE_RESERVATION_STALE_SECONDS,
): Promise<BeginPlanPriceChangeResult> {
  return callRpc(
    client,
    PLAN_PRICE_CHANGE_RPC.begin,
    { p_plan_id: planId, p_stale_after_seconds: staleAfterSeconds },
    BeginPlanPriceChangeResultSchema,
  );
}

/** 予約が自分のもののままなら、履歴と価格を 1 つのトランザクションで書き、変える前の値を返す */
export function applyPlanPriceChange(client: PlanPriceChangeRpcClient, input: PlanPriceChangeInput): Promise<ApplyPlanPriceChangeResult> {
  return callRpc(
    client,
    PLAN_PRICE_CHANGE_RPC.apply,
    {
      p_plan_id: input.planId,
      p_token: input.token,
      p_new_monthly_price_jpy: input.newMonthlyPriceJpy,
      p_new_yearly_price_jpy: input.newYearlyPriceJpy,
      p_new_stripe_price_id: input.newStripePriceId,
      p_new_stripe_yearly_price_id: input.newStripeYearlyPriceId,
      p_changed_by: input.changedBy,
      p_reason: input.reason,
      p_effective_at: input.effectiveAt,
      p_applies_to: input.appliesTo,
    },
    ApplyPlanPriceChangeResultSchema,
  );
}

/** 自分の予約を消す。消せたら true、もう無ければ false */
export function releasePlanPriceChange(client: PlanPriceChangeRpcClient, planId: string, token: string): Promise<boolean> {
  return callRpc(client, PLAN_PRICE_CHANGE_RPC.release, { p_plan_id: planId, p_token: token }, z.boolean());
}
