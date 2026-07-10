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
 * #1041 round-3 (C2) 修正: subscription_plans.stripe_price_id は 1 プランにつき
 * 1 本しか保持できないため、月額・年額を同時に変更するリクエストは Stripe
 * 同期が必須な状況では拒否する (route/Edge Function/UI の 3 点セット)。
 *
 * #1041 round-4 (C・Critical) 修正: 上記の「1 本しか保持できない」制約により、
 * subscription_plans.stripe_price_id は「直近に触った interval の Price」を
 * 指す意味論になる (月額のみ変更した直後は月額 Price を指すが、その後年額のみ
 * 変更すると DB 上は年額 Price を指すように置換され、月額 Price への参照は
 * DB から失われる)。Edge Function (stripe-price-sync) 側で interval を確認して
 * からでないと deactivate しない防御を入れているが (同ファイル参照)、この
 * 「連続片方変更で参照が interval を跨いで置換される」こと自体は本 route の
 * 責務では解消できないデータモデル上の制約であり、恒久対応には
 * new_yearly_stripe_price_id 相当の列追加 (月額・年額を同時に保持できる
 * migration) が必要 (round-3 C2 のコメントにある「別途 migration」と同一)。
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
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { PriceChangeSchema } from '@/lib/super-admin/plans-schemas';

type RouteContext = { params: { id: string } };

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

    let newStripePriceId: string | null = null;
    // #1041 round-4 (C): Edge Function 側の interval ガードによる deactivate 結果
    // (監査ログ details に記録するため、DB 更新前に受け取っておく)。
    let oldPriceDeactivated = false;
    let oldPriceDeactivationSkippedReason: string | null = null;

    // #1041 (F4-06) 修正: STRIPE_SECRET_KEY が設定されている場合は「本番で Stripe 同期が
    // 必須」という明示的な状態であり、Edge Function 呼び出しに失敗した場合はそれを
    // 偽成功 (DB のみ更新して 200 を返す) にせず 502 で失敗させる (fail-closed)。
    // STRIPE_SECRET_KEY が未設定の場合のみ、意図された dev/mock モードとして続行する。
    const stripeSyncExpected = Boolean(process.env.STRIPE_SECRET_KEY && plan.stripe_product_id);

    // #1041 round-3 (C2): subscription_plans.stripe_price_id は 1 本しか保持できない
    // (月額用・年額用の Price ID を同時に保存する列が無い)。UI は月額・年額を常に
    // prefill するため、両方変更するリクエストが来ると Edge Function は片方
    // (月額優先) しか Stripe に反映せず、年額の変更が黙って無視されたまま 200 を
    // 返す偽成功になっていた。Stripe 同期が必須な状況では明示的に拒否し、DB 更新・
    // Stripe 呼び出しのどちらも実行しない (年額用 Price ID 列の追加は別途 migration)。
    if (stripeSyncExpected && input.new_monthly_price_jpy != null && input.new_yearly_price_jpy != null) {
      return NextResponse.json(
        {
          error: {
            code: 'OP_STRIPE_SYNC_BOTH_INTERVALS_UNSUPPORTED',
            message: '現データモデルでは月額と年額を同時に Stripe 同期できません。片方ずつ変更してください。',
          },
        },
        { status: 422 },
      );
    }

    if (stripeSyncExpected) {
      const edgeFnUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/stripe-price-sync`;
      let edgeRes: Response;
      try {
        // Edge Function stripe-price-sync を呼ぶ (operator/04-plan-management.md §3.3 準拠)
        edgeRes = await fetch(edgeFnUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
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

      const edgeData = (await edgeRes.json()) as {
        new_stripe_price_id?: string;
        deactivated?: boolean;
        deactivation_skipped_reason?: string;
      };
      newStripePriceId = edgeData.new_stripe_price_id ?? null;
      // #1041 round-4 (C): Edge Function が interval 不一致等で旧 Price の
      // deactivate をスキップした場合、監査ログに残して運用者が把握できるようにする。
      oldPriceDeactivated = edgeData.deactivated ?? false;
      oldPriceDeactivationSkippedReason = edgeData.deactivation_skipped_reason ?? null;

      if (!newStripePriceId) {
        // Edge Function が 200 を返したのに Price ID が取得できない場合も
        // 同期未完了とみなし、偽成功にしない。
        console.error('[super-admin/price-change] Edge Function returned ok but no new_stripe_price_id');
        return NextResponse.json(
          {
            error: {
              code: 'OP_STRIPE_SYNC_FAILED',
              message: 'Stripe Price の作成結果を確認できませんでした。DB は更新していません。',
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
    const { error: historyErr } = await supabaseAdmin.from('plan_price_history').insert({
      plan_id: params.id,
      old_monthly_price_jpy: plan.monthly_price_jpy,
      new_monthly_price_jpy: input.new_monthly_price_jpy ?? plan.monthly_price_jpy,
      old_yearly_price_jpy: plan.yearly_price_jpy,
      new_yearly_price_jpy: input.new_yearly_price_jpy ?? plan.yearly_price_jpy,
      old_stripe_price_id: plan.stripe_price_id,
      new_stripe_price_id: newStripePriceId,
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
    const planUpdate: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.new_monthly_price_jpy != null) planUpdate.monthly_price_jpy = input.new_monthly_price_jpy;
    if (input.new_yearly_price_jpy != null) planUpdate.yearly_price_jpy = input.new_yearly_price_jpy;
    if (newStripePriceId) planUpdate.stripe_price_id = newStripePriceId;

    const { error: updateErr } = await supabase
      .from('subscription_plans')
      .update(planUpdate)
      .eq('id', params.id);

    if (updateErr) {
      console.error('[super-admin/price-change POST]', updateErr);
      return NextResponse.json(
        { error: { code: 'OP_DB_ERROR', message: updateErr.message } },
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
          stripe_mock: !newStripePriceId,
          // #1041 round-4 (C): 旧 Price の deactivate 結果 (interval 不一致等で
          // スキップされた場合、運用者が気づけるよう監査ログに残す)。
          old_stripe_price_deactivated: oldPriceDeactivated,
          old_stripe_price_deactivation_skipped_reason: oldPriceDeactivationSkippedReason,
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
        new_stripe_price_id: newStripePriceId,
        applies_to: input.applies_to,
        stripe_mock: !newStripePriceId,
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
