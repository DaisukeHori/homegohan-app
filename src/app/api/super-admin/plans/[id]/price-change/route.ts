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
 * #1041 round-3 (C1) 修正: `plan_price_history` は SELECT ポリシーのみで
 * INSERT ポリシーが存在しない (default deny)。従来は user-scoped client で
 * INSERT し、RLS 拒否を「非致命的: 続行」として握り潰していたため、本番では
 * 毎回拒否され監査証跡 (価格変更履歴) が永久に空のまま 200 を返す偽成功に
 * なっていた。service-role (`getSupabaseAdmin()`) に切替え、かつ
 * subscription_plans の価格 UPDATE より「前」に実行することで、履歴 INSERT が
 * 失敗した場合に価格 UPDATE 自体を行わせない (価格は変更したが監査証跡が無い
 * 状態を構造的に発生させない)。
 *
 * #1041 round-4 (W1) 修正: OP_INVALID_INPUT のメッセージに
 * `parseResult.error.message` (issues 配列の生 JSON 文字列) をそのまま
 * 返していたため、UI にエラーメッセージとして生 JSON がダンプされていた。
 * 最初の issue の message のみを抽出して返す (details には引き続き全 issues
 * を含める)。
 *
 * #1041 round-4 (W3) 修正: `plan_price_history` INSERT 失敗時のメッセージに
 * 「価格は変更していません」と記載していたが、これは DB 上の
 * subscription_plans.monthly_price_jpy/yearly_price_jpy を指しており、Stripe 側の
 * Price 作成 (履歴 INSERT より前に実行済み) には触れていなかった。Stripe 同期が
 * 必須な状況では、この時点で新 Price が Stripe 上に作成済みの可能性がある旨を
 * 追記する (metadata の plan_key/changed_by で当該 Price を識別できる)。
 *
 * (#1041 round-3 (C2) / round-4 (C) の「stripe_price_id は 1 本しか保持できない」制約は、
 * #1102 で年額用の列 stripe_yearly_price_id を足して解消した。)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { getSupabaseServiceConfig } from '@/lib/env-required';
import { PriceChangeSchema } from '@/lib/super-admin/plans-schemas';
import { internalError } from '@/lib/api/errors';

type RouteContext = { params: { id: string } };

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

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();
    // requireRole 通過後のみ到達する。plan_price_history には INSERT ポリシーが
    // 存在しないため service-role が必須 (#1041 round-3 C1)。
    const supabaseAdmin = getSupabaseAdmin();

    const body = await request.json();
    const parseResult = PriceChangeSchema.safeParse(body);

    if (!parseResult.success) {
      // #1041 round-4 (W1): parseResult.error.message は issues 配列の生 JSON 文字列
      // であり、そのまま UI に表示すると意味不明なダンプになる。最初の issue の
      // message のみを抽出して返す (details には引き続き全 issues を含める)。
      // #1102: applies_to が on_renewal / immediately のときも、ここで 400 になる
      // (DB・Stripe のどちらにも触れる前に拒否する)。
      const firstIssueMessage = parseResult.error.issues[0]?.message ?? '入力値が不正です';
      return NextResponse.json(
        { error: { code: 'OP_INVALID_INPUT', message: firstIssueMessage, details: parseResult.error.issues } },
        { status: 400 }
      );
    }

    const input = parseResult.data;

    // プランを取得
    const { data: plan, error: planErr } = await supabase
      .from('subscription_plans')
      .select('*')
      .eq('id', params.id)
      .single();

    if (planErr || !plan) {
      return NextResponse.json(
        { error: { code: 'OP_PLAN_NOT_FOUND', message: 'プランが見つかりません' } },
        { status: 404 }
      );
    }

    // draft は価格変更 API を使う必要なし (PATCH で対応)
    if (plan.status === 'draft') {
      return NextResponse.json(
        { error: { code: 'OP_PLAN_DRAFT_USE_PATCH', message: 'draft プランは PATCH API で価格変更してください' } },
        { status: 422 }
      );
    }

    const monthlyChange = input.new_monthly_price_jpy != null;
    const yearlyChange = input.new_yearly_price_jpy != null;

    // 月額・年額それぞれの Stripe 同期結果 (Edge Function の interval ガードによる deactivate 結果を含む。
    // 監査ログ details に記録するため、DB 更新前に受け取っておく)。
    let monthly: IntervalSync = NO_SYNC;
    let yearly: IntervalSync = NO_SYNC;

    // #1041 (F4-06) 修正: STRIPE_SECRET_KEY が設定されている場合は「本番で Stripe 同期が
    // 必須」という明示的な状態であり、Edge Function 呼び出しに失敗した場合はそれを
    // 偽成功 (DB のみ更新して 200 を返す) にせず 502 で失敗させる (fail-closed)。
    // STRIPE_SECRET_KEY が未設定の場合のみ、意図された dev/mock モードとして続行する。
    const stripeSyncExpected = Boolean(process.env.STRIPE_SECRET_KEY && plan.stripe_product_id);

    if (stripeSyncExpected) {
      // #1434: 必須の接続情報は env-required の getter で取り出す (以前は `${process.env.X}` を直接埋め込み、
      // 欠けていると `undefined/functions/v1/...` へ通信していた)。欠けていれば MissingEnvError → 下の catch で 500
      const service = getSupabaseServiceConfig();
      const edgeFnUrl = `${service.url}/functions/v1/stripe-price-sync`;
      let edgeRes: Response;
      try {
        // Edge Function stripe-price-sync を呼ぶ (operator/04-plan-management.md §3.3 準拠)。
        // 月額・年額を変えるときは、1 回の呼び出しで両方を渡す (#1102)。
        edgeRes = await fetch(edgeFnUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${service.serviceRoleKey}`,
          },
          body: JSON.stringify({
            plan_id: params.id,
            plan_key: plan.plan_key,
            stripe_product_id: plan.stripe_product_id,
            new_monthly_price_jpy: input.new_monthly_price_jpy,
            new_yearly_price_jpy: input.new_yearly_price_jpy,
            applies_to: input.applies_to,
            actor_id: user.id,
            reason: input.reason,
          }),
        });
      } catch (stripeErr) {
        console.error('[super-admin/price-change] Stripe Edge Function fetch failed:', stripeErr);
        return NextResponse.json(
          {
            error: {
              code: 'OP_STRIPE_SYNC_FAILED',
              message: 'Stripe との価格同期に失敗しました。DB は更新していません。',
            },
          },
          { status: 502 },
        );
      }

      if (!edgeRes.ok) {
        const errBody = await edgeRes.text().catch(() => '');
        console.error('[super-admin/price-change] Edge Function stripe-price-sync failed:', edgeRes.status, errBody);

        // #1041 round-2 (C): 404 は Edge Function 未デプロイの可能性が高く、
        // 一時的な Stripe API 障害 (OP_STRIPE_SYNC_FAILED) とは原因が異なる。
        // 運用者が supabase functions deploy stripe-price-sync の未実施に
        // 気づけるよう区別する。
        if (edgeRes.status === 404) {
          return NextResponse.json(
            {
              error: {
                code: 'OP_STRIPE_SYNC_UNAVAILABLE',
                message:
                  'Stripe価格同期機能が利用できません (Edge Function stripe-price-sync が未デプロイの可能性があります)。DB は更新していません。',
              },
            },
            { status: 503 },
          );
        }

        return NextResponse.json(
          {
            error: {
              code: 'OP_STRIPE_SYNC_FAILED',
              message: `Stripe との価格同期に失敗しました (HTTP ${edgeRes.status})。DB は更新していません。`,
            },
          },
          { status: 502 },
        );
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
      monthly = toIntervalSync(monthlyChange, edgeData.month);
      yearly = toIntervalSync(yearlyChange, edgeData.year);

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
        return NextResponse.json(
          {
            error: {
              code: 'OP_STRIPE_SYNC_FAILED',
              message: `Stripe Price の作成結果を確認できませんでした (${missing.join('・')})。DB は更新していません。`,
            },
          },
          { status: 502 },
        );
      }
    } else {
      console.warn('[super-admin/price-change] STRIPE_SECRET_KEY not set or stripe_product_id missing — mock mode (dev/test)');
    }

    // plan_price_history に INSERT (operator/01-data-model.md §3.4 準拠)。
    // #1041 round-3 (C1): service-role (`supabaseAdmin`) を使用し、かつ
    // subscription_plans の価格 UPDATE より前に実行する。ここで失敗した場合は
    // DB の価格をまだ一切更新していないため、そのまま 500 を返せば「価格は
    // 変更されたのに監査証跡が無い」という中途半端な状態を残さずに済む
    // (UPDATE を先に行い失敗時にロールバックする方式は、ロールバック自体が
    // 失敗し得る二重障害点を増やすため採用しない)。
    // old/new_stripe_price_id は月額の Price ID (subscription_plans.stripe_price_id と同じ意味。#1102)。
    // new_stripe_price_id は、この変更で新しい月額の Price を作ったときだけ入る (年額だけ変えたときは null)。
    const { error: historyErr } = await supabaseAdmin.from('plan_price_history').insert({
      plan_id: params.id,
      old_monthly_price_jpy: plan.monthly_price_jpy,
      new_monthly_price_jpy: input.new_monthly_price_jpy ?? plan.monthly_price_jpy,
      old_yearly_price_jpy: plan.yearly_price_jpy,
      new_yearly_price_jpy: input.new_yearly_price_jpy ?? plan.yearly_price_jpy,
      old_stripe_price_id: plan.stripe_price_id,
      new_stripe_price_id: monthly.newPriceId,
      changed_by: user.id,
      reason: input.reason,
      effective_at: input.effective_at,
      applies_to: input.applies_to,
    });

    if (historyErr) {
      console.error('[super-admin/price-change POST] price_history INSERT failed:', historyErr);
      return NextResponse.json(
        {
          error: {
            code: 'OP_PRICE_HISTORY_INSERT_FAILED',
            // #1041 round-4 (W3): Stripe 同期が必須な状況では、この時点で新
            // Price が Stripe 上に作成済みの可能性がある (履歴 INSERT は Stripe
            // Price 作成より後に実行される)。DB (subscription_plans) の価格は
            // 未更新だが Stripe 側の状態と食い違い得るため、その旨を明示する。
            message:
              '価格変更履歴の記録に失敗しました。価格(DB)は変更していません。' +
              '※Stripe 側では新価格(Price)が作成済みの可能性があります' +
              '(metadata の plan_key/changed_by で識別可)。',
          },
        },
        { status: 500 },
      );
    }

    // DB 更新: subscription_plans
    // Note (#1041 round-4 W3 Sonnet Suggestion): plan_price_history への INSERT は
    // 既に成功しているため、この後の UPDATE が失敗すると「価格変更履歴には記録
    // されたが実際の価格 (DB) は変更されていない」非対称な状態が残り得る。
    // UPDATE 失敗時は OP_DB_ERROR で明示的にエラーを返すため運用者は気づけるが、
    // 履歴行の事後的な取消/訂正は行わない (履歴は「変更を試みた記録」として残す
    // 設計。ロールバック処理自体が失敗し得る二重障害点を増やさないため採用しない
    // — round-3 (C1) の historyErr 側の設計判断と対称)。
    // #1102: 変えた interval の Price ID の列だけを更新する (月額 = stripe_price_id / 年額 = stripe_yearly_price_id)。
    // 変えなかった interval の列は一切書かない (もう片方の Price への参照を消さない)。
    const planUpdate: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.new_monthly_price_jpy != null) planUpdate.monthly_price_jpy = input.new_monthly_price_jpy;
    if (input.new_yearly_price_jpy != null) planUpdate.yearly_price_jpy = input.new_yearly_price_jpy;
    if (monthly.newPriceId) planUpdate.stripe_price_id = monthly.newPriceId;
    if (yearly.newPriceId) planUpdate.stripe_yearly_price_id = yearly.newPriceId;

    const { error: updateErr } = await supabase
      .from('subscription_plans')
      .update(planUpdate)
      .eq('id', params.id);

    if (updateErr) {
      console.error('[super-admin/price-change POST]', updateErr);
      return NextResponse.json(
        // DB の生のエラー文は本文に出さない (#1172)。原因は上の console.error に残る
        { error: { code: 'OP_DB_ERROR', message: 'プランの更新に失敗しました' } },
        { status: 500 }
      );
    }

    // 監査ログ記録 (severity='warn' — 課金影響操作)
    try {
      await supabase.from('admin_audit_logs').insert({
        actor_id: user.id,
        target_id: params.id,
        target_type: 'subscription_plan',
        action_type: 'change_price',
        details: {
          plan_key: plan.plan_key,
          old_monthly_price_jpy: plan.monthly_price_jpy,
          new_monthly_price_jpy: input.new_monthly_price_jpy,
          old_yearly_price_jpy: plan.yearly_price_jpy,
          new_yearly_price_jpy: input.new_yearly_price_jpy,
          applies_to: input.applies_to,
          reason: input.reason,
          stripe_mock: !stripeSyncExpected,
          // #1102: 月額 (stripe_price_id) と年額 (stripe_yearly_price_id) の Price ID。
          // 変えなかった interval の new_* は null。
          old_stripe_price_id: plan.stripe_price_id ?? null,
          new_stripe_price_id: monthly.newPriceId,
          old_stripe_yearly_price_id: plan.stripe_yearly_price_id ?? null,
          new_stripe_yearly_price_id: yearly.newPriceId,
          // #1041 round-4 (C): 旧 Price の deactivate 結果 (interval 不一致等で
          // スキップされた場合、運用者が気づけるよう監査ログに残す)。月額 / 年額それぞれ。
          old_stripe_price_deactivated: monthly.oldPriceDeactivated,
          old_stripe_price_deactivation_skipped_reason: monthly.oldPriceDeactivationSkippedReason,
          old_stripe_yearly_price_deactivated: yearly.oldPriceDeactivated,
          old_stripe_yearly_price_deactivation_skipped_reason: yearly.oldPriceDeactivationSkippedReason,
        },
        severity: 'warn',
        ip_address: request.headers.get('x-forwarded-for'),
      });
    } catch (auditErr) {
      console.warn('[super-admin/price-change POST] audit log failed (graceful):', auditErr);
    }

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
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/price-change POST]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}
