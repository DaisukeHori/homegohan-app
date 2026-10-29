/**
 * POST /api/super-admin/plans/[id]/price-change — 価格変更実行
 *
 * operator/02-api-spec.md §17 / operator/04-plan-management.md §3.3 /
 * operator/05-stripe-integration.md 準拠
 *
 * 権限: super_admin のみ
 *
 * Stripe Secret Key 未設定時はモック動作 (graceful degradation)
 *
 * #1102 (オーナー判断 2026-10-08): 価格変更は新規契約だけに適用し、年額用の Stripe 価格 ID の欄を追加する。
 *   - applies_to は new_only だけ (省略時も new_only)。on_renewal / immediately は 400 (OP_INVALID_INPUT)。
 *     既存サブスクリプションの Stripe 価格の切り替えは作らない (既存の契約者の請求額は変わらない)。
 *   - subscription_plans.stripe_price_id は月額の Stripe Price ID、stripe_yearly_price_id は年額の Stripe Price ID。
 *     月額・年額を 1 回のリクエストで同時に変えられる (従来の 422 OP_STRIPE_SYNC_BOTH_INTERVALS_UNSUPPORTED は廃止)。
 *     Edge Function stripe-price-sync が interval ごとに新しい Price を作り、同じ interval の旧 Price だけを無効化して
 *     { month, year } を返す。この route は、変えた interval の列だけを新しい Price の ID に更新する。
 *   - plan_price_history の old/new_stripe_price_id は月額の Price ID を記録する (列の意味を subscription_plans に合わせた)。
 *     年額の Price ID は監査ログ (admin_audit_logs.details) に残す。
 *
 * #1041 round-2 (C) 修正: `supabase/functions/stripe-price-sync` を新規実装した
 * (旧: 関数が存在せず常に 404→502)。Edge Function が未デプロイの間 (404) は
 * 一時的な Stripe API 障害 (`OP_STRIPE_SYNC_FAILED`) と区別できるよう
 * `OP_STRIPE_SYNC_UNAVAILABLE` を返し、運用者が `supabase functions deploy
 * stripe-price-sync` の未実施に気づけるようにする。偽成功 (DB のみ更新して
 * 200 を返す) には戻さない。
 *
 * #1041 round-3 (C1) / round-4 (W3) の経緯: `plan_price_history` は SELECT ポリシーのみで INSERT ポリシーが無い (default deny) ため、
 * 履歴は service-role で書く。以前は履歴の INSERT と価格の UPDATE を別々の文で流し (履歴を先に書いて、失敗したら価格を変えない)、
 * UPDATE だけが失敗すると「履歴はあるが価格は変わっていない」状態が残りえた。#1917 から、履歴と価格は DB の関数
 * apply_plan_price_change が 1 つのトランザクションで書くので、どちらか片方だけが残ることは無い。
 * Stripe の同期のあとで DB に書けなかったときは、Stripe に新しい Price が作られている旨を文に添える (STRIPE_PRICE_MAY_EXIST_NOTE)。
 *
 * #1041 round-4 (W1) 修正: OP_INVALID_INPUT のメッセージに
 * `parseResult.error.message` (issues 配列の生 JSON 文字列) をそのまま
 * 返していたため、UI にエラーメッセージとして生 JSON がダンプされていた。
 * 最初の issue の message のみを抽出して返す (details には引き続き全 issues
 * を含める)。
 *
 * #1917 同時の変更: 以前はプランをロックも条件も無く読み、その値を履歴と監査の old_* に書き、価格を .eq(id) だけで UPDATE していた。
 * 2 人の運営がほぼ同時に同じプランの価格を変えると、後の記録の old_* が実際の直前の値と食い違った。
 * いまはプランごとの予約の行で 1 本ずつにする (src/lib/super-admin/plan-price-change-reservation.ts):
 *   1. beginPlanPriceChange: プランの行をロックして予約を取り、ロックの下で読んだプランの値を返す。
 *      無ければ 404、draft なら 422、別の運営の価格の変更が進行中なら 409 CONFLICT_STALE_DATA (Stripe も DB も触らない)
 *   2. Stripe の同期 (予約を取った 1 本だけが Edge Function を呼ぶ。Edge Function はその時点の DB の旧 Price を無効化する)
 *   3. applyPlanPriceChange: 予約が自分のもののままなら、ロックの下で読んだ値を old_* にして履歴を INSERT し、変えた列だけを UPDATE し、
 *      予約を消す (1 つのトランザクション)。予約を失っていたら (期限の後に別の運営が取り直した) 409 CONFLICT_STALE_DATA で何も書かない
 *   4. 監査の old_* は 3 が返した変える前の値 (previous) で書く
 *   1 の後、3 まで行かずに返るとき (Stripe の同期の失敗・例外) は、予約を消してから返す (releasePlanPriceChange)。
 *
 * (#1041 round-3 (C2) / round-4 (C) の「stripe_price_id は 1 本しか保持できない」制約は、
 * #1102 で年額用の列 stripe_yearly_price_id を足して解消した。)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { operatorForbiddenMessageOf } from '@/lib/api/error-responses';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { getSupabaseServiceConfig } from '@/lib/env-required';
import { PriceChangeSchema, type PriceChangeInput } from '@/lib/super-admin/plans-schemas';
import { internalError } from '@/lib/api/errors';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { invalidInputResponse, invalidJsonBodyResponse, readJsonBody } from '@/lib/super-admin/validation-errors';
import { isUuid } from '@/lib/http-params';
import {
  PRICE_CHANGE_IN_PROGRESS_MESSAGE,
  PRICE_CHANGE_RESERVATION_LOST_MESSAGE,
  PRICE_CHANGE_SAVE_FAILED_MESSAGE,
  STRIPE_PRICE_MAY_EXIST_NOTE,
  applyPlanPriceChange,
  beginPlanPriceChange,
  releasePlanPriceChange,
  type PlanPriceChangeRpcClient,
  type ReservedPlan,
} from '@/lib/super-admin/plan-price-change-reservation';

type RouteContext = { params: Promise<{ id: string }> };

const ROUTE_NAME = 'POST /api/super-admin/plans/[id]/price-change';

/** プランが無い (UUID の形でない id を含む) */
const PLAN_NOT_FOUND_RESPONSE = { error: { code: 'OP_PLAN_NOT_FOUND', message: 'プランが見つかりません' } } as const;

/** Edge Function stripe-price-sync が interval ごとに返す結果 (変えなかった interval は null / 省略) */
type StripeSyncIntervalResult = {
  new_stripe_price_id?: string;
  deactivated?: boolean;
  deactivation_skipped_reason?: string;
};

/** 1 つの interval (月額 / 年額) の同期結果。Stripe 同期をしなかった / 変えなかったときは null の ID と未無効化 */
type IntervalSync = {
  newPriceId: string | null;
  /** 旧 Price を無効化したか (Edge Function の interval ガードの結果。監査ログに記録する) */
  oldPriceDeactivated: boolean;
  oldPriceDeactivationSkippedReason: string | null;
};

const NO_SYNC: IntervalSync = { newPriceId: null, oldPriceDeactivated: false, oldPriceDeactivationSkippedReason: null };

/** Stripe の同期の結果: 続けてよい (interval ごとの結果) か、そのまま返す失敗の応答か */
type StripeSyncOutcome = { ok: true; monthly: IntervalSync; yearly: IntervalSync } | { ok: false; response: NextResponse };

/**
 * Edge Function stripe-price-sync を呼ぶ (operator/04-plan-management.md §3.3 準拠)。月額・年額を変えるときは、1 回の呼び出しで両方を渡す (#1102)。
 * 失敗は偽成功にせず、DB を更新しない応答を返す (fail-closed。#1041 F4-06)
 */
async function syncStripePrices(
  planId: string,
  plan: ReservedPlan,
  input: PriceChangeInput,
  actorId: string,
): Promise<StripeSyncOutcome> {
  const monthlyChange = input.new_monthly_price_jpy != null;
  const yearlyChange = input.new_yearly_price_jpy != null;
  // #1434: 必須の接続情報は env-required の getter で取り出す (以前は `${process.env.X}` を直接埋め込み、
  // 欠けていると `undefined/functions/v1/...` へ通信していた)。欠けていれば MissingEnvError → route の catch で 500
  const service = getSupabaseServiceConfig();
  const edgeFnUrl = `${service.url}/functions/v1/stripe-price-sync`;
  let edgeRes: Response;
  try {
    edgeRes = await fetch(edgeFnUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${service.serviceRoleKey}`,
      },
      body: JSON.stringify({
        plan_id: planId,
        plan_key: plan.plan_key,
        stripe_product_id: plan.stripe_product_id,
        new_monthly_price_jpy: input.new_monthly_price_jpy,
        new_yearly_price_jpy: input.new_yearly_price_jpy,
        applies_to: input.applies_to,
        actor_id: actorId,
        reason: input.reason,
      }),
    });
  } catch (stripeErr) {
    console.error('[super-admin/price-change] Stripe Edge Function fetch failed:', stripeErr);
    return {
      ok: false,
      response: NextResponse.json(
        { error: { code: 'OP_STRIPE_SYNC_FAILED', message: 'Stripe との価格同期に失敗しました。DB は更新していません。' } },
        { status: 502 },
      ),
    };
  }

  if (!edgeRes.ok) {
    const errBody = await edgeRes.text().catch(() => '');
    console.error('[super-admin/price-change] Edge Function stripe-price-sync failed:', edgeRes.status, errBody);

    // #1041 round-2 (C): 404 は Edge Function 未デプロイの可能性が高く、
    // 一時的な Stripe API 障害 (OP_STRIPE_SYNC_FAILED) とは原因が異なる。
    // 運用者が supabase functions deploy stripe-price-sync の未実施に
    // 気づけるよう区別する。
    if (edgeRes.status === 404) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: {
              code: 'OP_STRIPE_SYNC_UNAVAILABLE',
              message:
                'Stripe価格同期機能が利用できません (Edge Function stripe-price-sync が未デプロイの可能性があります)。DB は更新していません。',
            },
          },
          { status: 503 },
        ),
      };
    }

    return {
      ok: false,
      response: NextResponse.json(
        {
          error: {
            code: 'OP_STRIPE_SYNC_FAILED',
            message: `Stripe との価格同期に失敗しました (HTTP ${edgeRes.status})。DB は更新していません。`,
          },
        },
        { status: 502 },
      ),
    };
  }

  const edgeData = (await edgeRes.json().catch(() => ({}))) as {
    month?: StripeSyncIntervalResult | null;
    year?: StripeSyncIntervalResult | null;
  };

  // 変えると指定した interval ごとに、新しい Price の ID を受け取る。
  // #1041 round-4 (C): Edge Function が interval 不一致等で旧 Price の deactivate をスキップした場合、
  // 監査ログに残して運用者が把握できるようにする。
  const toIntervalSync = (changed: boolean, result: StripeSyncIntervalResult | null | undefined): IntervalSync =>
    changed
      ? {
          newPriceId: result?.new_stripe_price_id ?? null,
          oldPriceDeactivated: result?.deactivated ?? false,
          oldPriceDeactivationSkippedReason: result?.deactivation_skipped_reason ?? null,
        }
      : NO_SYNC;
  const monthly = toIntervalSync(monthlyChange, edgeData.month);
  const yearly = toIntervalSync(yearlyChange, edgeData.year);

  // Edge Function が 200 を返したのに、変えると指定した interval の Price ID が取得できない場合も
  // 同期未完了とみなし、偽成功にしない (一方だけ取れた場合も、DB を片方だけ更新する中途半端な状態にしない)。
  const missing = [
    ...(monthlyChange && !monthly.newPriceId ? ['月額'] : []),
    ...(yearlyChange && !yearly.newPriceId ? ['年額'] : []),
  ];
  if (missing.length > 0) {
    console.error(
      `[super-admin/price-change] Edge Function returned ok but no new_stripe_price_id for: ${missing.join(', ')}`,
    );
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: {
            code: 'OP_STRIPE_SYNC_FAILED',
            message: `Stripe Price の作成結果を確認できませんでした (${missing.join('・')})。DB は更新していません。`,
          },
        },
        { status: 502 },
      ),
    };
  }
  return { ok: true, monthly, yearly };
}

/**
 * apply まで行かなかった予約を消す。消せなくても応答は変えない (予約は期限の後に次の begin が取り直す)。失敗はログに残す
 */
async function releaseReservation(client: PlanPriceChangeRpcClient, planId: string, token: string, actorId: string): Promise<void> {
  try {
    await releasePlanPriceChange(client, planId, token);
  } catch (releaseErr) {
    createLogger(ROUTE_NAME, generateRequestId())
      .withUser(actorId)
      .error('価格の変更の予約を消せませんでした (期限の後に取り直されます)', releaseErr, { plan_id: planId });
  }
}

export async function POST(request: NextRequest, props: RouteContext) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();
    // requireRole 通過後のみ到達する。予約・履歴・価格の書き込みは service_role だけが呼べる DB の関数で行う
    // (plan_price_history には INSERT ポリシーが無い #1041 round-3 C1)。
    const supabaseAdmin = getSupabaseAdmin();
    const rpcClient: PlanPriceChangeRpcClient = { rpc: (fn, args) => supabaseAdmin.rpc(fn, args) };

    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      // #1654: 本文が JSON として読めないときは 400 OP_INVALID_INPUT (外側の catch の 500 に落とさない)
      return invalidJsonBodyResponse();
    }
    const body = bodyResult.body;
    const parseResult = PriceChangeSchema.safeParse(body);

    if (!parseResult.success) {
      // #1041 round-4 (W1): parseResult.error.message は issues 配列の生 JSON 文字列
      // であり、そのまま UI に表示すると意味不明なダンプになる。最初の issue の
      // message のみを抽出して返す (details には引き続き全 issues を含める)。
      // #1102: applies_to が on_renewal / immediately のときも、ここで 400 になる
      // (DB・Stripe のどちらにも触れる前に拒否する)。
      // #1917: 文は src/lib/super-admin/validation-errors.ts の invalidInputResponse で作る
      // (schema に書いた日本語の文はそのまま、Zod の既定の英語の文は日本語の固定の文にする。details は従来どおり issues の全件)
      return invalidInputResponse(parseResult.error.issues);
    }

    const input = parseResult.data;

    // UUID の形でない id は DB に渡さず 404 (uuid 型の引数に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る)。
    // 入力の検査 (400) のあとに置き、行が無い UUID と同じ順にそろえる
    if (!isUuid(params.id)) {
      return NextResponse.json(PLAN_NOT_FOUND_RESPONSE, { status: 404 });
    }

    // 1. 予約を取り、ロックの下で読んだプランの値を受け取る (#1917)。
    //    読めなかったとき (DB の失敗) は 404 にしない (行が無いときだけ 404。一時的な失敗で消えたように見せない。#1917)
    let begin;
    try {
      begin = await beginPlanPriceChange(rpcClient, params.id);
    } catch (beginErr) {
      return internalError(ROUTE_NAME, beginErr, { userId: user.id }, { shape: 'nested' });
    }
    if (begin.result === 'not_found') {
      return NextResponse.json(PLAN_NOT_FOUND_RESPONSE, { status: 404 });
    }
    // draft は価格変更 API を使う必要なし (PATCH で対応)
    if (begin.result === 'draft') {
      return NextResponse.json(
        { error: { code: 'OP_PLAN_DRAFT_USE_PATCH', message: '下書き (draft) のプランは PATCH API で価格を変更してください' } },
        { status: 422 }
      );
    }
    if (begin.result === 'in_progress') {
      return NextResponse.json(
        { error: { code: 'CONFLICT_STALE_DATA', message: PRICE_CHANGE_IN_PROGRESS_MESSAGE } },
        { status: 409 }
      );
    }
    const { plan, token } = begin;

    // apply が返るまでは予約を持っている。apply まで行かずに返るとき (Stripe の同期の失敗・例外) は、finally で予約を消す
    let reservationHeld = true;
    try {
      // #1041 (F4-06) 修正: STRIPE_SECRET_KEY が設定されている場合は「本番で Stripe 同期が
      // 必須」という明示的な状態であり、Edge Function 呼び出しに失敗した場合はそれを
      // 偽成功 (DB のみ更新して 200 を返す) にせず 502 で失敗させる (fail-closed)。
      // STRIPE_SECRET_KEY が未設定の場合のみ、意図された dev/mock モードとして続行する。
      const stripeSyncExpected = Boolean(process.env.STRIPE_SECRET_KEY && plan.stripe_product_id);

      // 月額・年額それぞれの Stripe 同期結果 (Edge Function の interval ガードによる deactivate 結果を含む。
      // 監査ログ details に記録するため、DB 更新前に受け取っておく)。
      let monthly: IntervalSync = NO_SYNC;
      let yearly: IntervalSync = NO_SYNC;
      if (stripeSyncExpected) {
        // 2. Stripe の同期。予約を持っているのはこの要求だけなので、Edge Function が DB から読んで無効化する旧 Price は、
        //    apply がロックの下で読む値 (監査の old_stripe_price_id / old_stripe_yearly_price_id) と同じ
        const sync = await syncStripePrices(params.id, plan, input, user.id);
        if (!sync.ok) return sync.response;
        monthly = sync.monthly;
        yearly = sync.yearly;
      } else {
        console.warn('[super-admin/price-change] STRIPE_SECRET_KEY not set or stripe_product_id missing — mock mode (dev/test)');
      }

      // 3. 履歴と価格を 1 つのトランザクションで書く (変えた interval の列だけ: 月額 = stripe_price_id / 年額 = stripe_yearly_price_id。#1102)。
      // 履歴の old/new_stripe_price_id は月額の Price ID (subscription_plans.stripe_price_id と同じ意味。#1102)。
      // new_stripe_price_id は、この変更で新しい月額の Price を作ったときだけ入る (年額だけ変えたときは null)。
      let applied;
      try {
        applied = await applyPlanPriceChange(rpcClient, {
          planId: params.id,
          token,
          newMonthlyPriceJpy: input.new_monthly_price_jpy ?? null,
          newYearlyPriceJpy: input.new_yearly_price_jpy ?? null,
          newStripePriceId: monthly.newPriceId,
          newStripeYearlyPriceId: yearly.newPriceId,
          changedBy: user.id,
          reason: input.reason,
          effectiveAt: input.effective_at,
          appliesTo: input.applies_to,
        });
      } catch (applyErr) {
        // DB の生のエラー文は本文に出さない (#1172)。原因は構造化ログに残す
        createLogger(ROUTE_NAME, generateRequestId())
          .withUser(user.id)
          .error('価格の変更の保存 (apply_plan_price_change) に失敗しました', applyErr, { plan_id: params.id });
        return NextResponse.json(
          {
            error: {
              code: 'OP_DB_ERROR',
              message: PRICE_CHANGE_SAVE_FAILED_MESSAGE + (stripeSyncExpected ? STRIPE_PRICE_MAY_EXIST_NOTE : ''),
            },
          },
          { status: 500 }
        );
      }
      // apply が返ったら、予約は消えている (applied) か、もう自分のものではない (lost) か、プランごと無い (not_found)
      reservationHeld = false;

      if (applied.result === 'not_found') {
        return NextResponse.json(PLAN_NOT_FOUND_RESPONSE, { status: 404 });
      }
      if (applied.result === 'lost') {
        return NextResponse.json(
          {
            error: {
              code: 'CONFLICT_STALE_DATA',
              message: PRICE_CHANGE_RESERVATION_LOST_MESSAGE + (stripeSyncExpected ? STRIPE_PRICE_MAY_EXIST_NOTE : ''),
            },
          },
          { status: 409 }
        );
      }
      const previous = applied.previous;

      // 4. 監査ログ記録 (severity='warn' — 課金影響操作)。old_* は apply がロックの下で読んだ、この更新の実際の直前の値 (#1917)
      await recordAdminAudit({
        supabase,
        actorId: user.id,
        targetId: params.id,
        targetType: 'subscription_plan',
        actionType: 'change_price',
        details: {
          plan_key: plan.plan_key,
          old_monthly_price_jpy: previous.monthly_price_jpy,
          new_monthly_price_jpy: input.new_monthly_price_jpy,
          old_yearly_price_jpy: previous.yearly_price_jpy,
          new_yearly_price_jpy: input.new_yearly_price_jpy,
          applies_to: input.applies_to,
          reason: input.reason,
          stripe_mock: !stripeSyncExpected,
          // #1102: 月額 (stripe_price_id) と年額 (stripe_yearly_price_id) の Price ID。
          // 変えなかった interval の new_* は null。
          old_stripe_price_id: previous.stripe_price_id,
          new_stripe_price_id: monthly.newPriceId,
          old_stripe_yearly_price_id: previous.stripe_yearly_price_id,
          new_stripe_yearly_price_id: yearly.newPriceId,
          // #1041 round-4 (C): 旧 Price の deactivate 結果 (interval 不一致等で
          // スキップされた場合、運用者が気づけるよう監査ログに残す)。月額 / 年額それぞれ。
          old_stripe_price_deactivated: monthly.oldPriceDeactivated,
          old_stripe_price_deactivation_skipped_reason: monthly.oldPriceDeactivationSkippedReason,
          old_stripe_yearly_price_deactivated: yearly.oldPriceDeactivated,
          old_stripe_yearly_price_deactivation_skipped_reason: yearly.oldPriceDeactivationSkippedReason,
        },
        severity: 'warn',
        request,
        routeName: 'api/super-admin/plans/[id]/price-change POST',
      });

      return NextResponse.json({
        data: {
          plan_id: params.id,
          plan_key: plan.plan_key,
          new_monthly_price_jpy: input.new_monthly_price_jpy,
          new_yearly_price_jpy: input.new_yearly_price_jpy,
          // 月額 (stripe_price_id) / 年額 (stripe_yearly_price_id) の新しい Stripe Price ID。変えなかった方は null
          new_stripe_price_id: monthly.newPriceId,
          new_stripe_yearly_price_id: yearly.newPriceId,
          applies_to: input.applies_to,
          stripe_mock: !stripeSyncExpected,
        },
      });
    } finally {
      if (reservationHeld) await releaseReservation(rpcClient, params.id, token, user.id);
    }
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: operatorForbiddenMessageOf(err) } }, { status: 403 });
    }
    console.error('[super-admin/price-change POST]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}
