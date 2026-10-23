/**
 * GET   /api/super-admin/plans/[id] — プラン詳細
 * PATCH /api/super-admin/plans/[id] — プラン編集
 * DELETE /api/super-admin/plans/[id] — プラン削除 (draft のみ)
 *
 * operator/02-api-spec.md §17 / operator/04-plan-management.md §3.1 準拠
 * 権限: super_admin のみ
 *
 * 同時の変更 (PATCH): 遷移の可否・status ごとに変えてよい項目・廃止の ends_at の要否は、直前に読んだ status (と ends_at) で決める。
 * 更新はその status のままのときだけ書く条件つきにする (廃止で ends_at を既存の値に頼るときは ends_at が残っていることも条件にする)。
 * 読んでから書くまでに別の運営が変えていたら 0 行で、読み直した行に送った変更がもう入っていれば 200 (書かず記録もしない)、
 * 入っていなければ 409 CONFLICT_STALE_DATA (cross/04 §4.2)。これで遷移表に無い遷移 (例: private を読んで public に戻す間に別の運営が deprecated にすると、書けば deprecated → public になる) は書かれず、
 * 監査の status_from は書いた時点の実際の直前の値と必ず一致する。
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { PlanUpdateSchema, isAllowedPlanStatusTransition } from '@/lib/super-admin/plans-schemas';
import {
  ORG_SUBSCRIPTION_PLAN_ROW_NOTE,
  PlanSubscriberCountError,
  countPlanSubscribers,
  isOrganizationsCounted,
  planHasSubscribersMessage,
  totalPlanSubscribers,
  type PlanSubscriberCounts,
} from '@/lib/super-admin/plan-subscribers';
import { internalError } from '@/lib/api/errors';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { invalidInputResponse, invalidJsonBodyResponse, readJsonBody } from '@/lib/super-admin/validation-errors';

type RouteContext = { params: Promise<{ id: string }> };

/** 読んでから書くまでに別の運営がプランを変えていた (条件つきの更新が 0 行で、読み直した行に送った変更が入っていない) */
const STALE_PLAN_RESPONSE = {
  error: { code: 'CONFLICT_STALE_DATA', message: '別の運営が先にこのプランを変えました。画面を読み込み直して、もう一度確認してください' },
} as const;

/** 列の値が送った値と同じか (配列は要素ごと、ends_at は時刻として比べる。DB は timestamptz を別の書式で返すため) */
function sameColumnValue(column: string, current: unknown, requested: unknown): boolean {
  if (Array.isArray(requested)) {
    return Array.isArray(current) && current.length === requested.length && requested.every((value, i) => value === current[i]);
  }
  if (column === 'ends_at' && typeof requested === 'string' && typeof current === 'string') {
    return Date.parse(requested) === Date.parse(current);
  }
  return current === requested;
}

/** 読み直した行に、送った変更 (updated_at を除く) がもう全部入っているか */
function planAlreadyHasValues(current: Record<string, unknown>, updateData: Record<string, unknown>): boolean {
  return Object.entries(updateData).every(
    ([column, value]) => column === 'updated_at' || sameColumnValue(column, current[column], value),
  );
}

export async function GET(_request: NextRequest, props: RouteContext) {
  const params = await props.params;
  try {
    await requireRole(['super_admin']);
    const supabase = await createClient();

    const { data: plan, error } = await supabase
      .from('subscription_plans')
      .select('*')
      .eq('id', params.id)
      .single();

    if (error || !plan) {
      return NextResponse.json(
        { error: { code: 'OP_PLAN_NOT_FOUND', message: 'プランが見つかりません' } },
        { status: 404 }
      );
    }

    // 価格変更履歴を追加取得
    const { data: priceHistory } = await supabase
      .from('plan_price_history')
      .select('*')
      .eq('plan_id', params.id)
      .order('created_at', { ascending: false })
      .limit(20);

    return NextResponse.json({ data: { ...plan, price_history: priceHistory ?? [] } });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/plans/[id] GET]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, props: RouteContext) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  const logger = createLogger('PATCH /api/super-admin/plans/[id]', generateRequestId());
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();

    // 既存プランを取得
    const { data: existing, error: fetchErr } = await supabase
      .from('subscription_plans')
      .select('*')
      .eq('id', params.id)
      .single();

    if (fetchErr || !existing) {
      return NextResponse.json(
        { error: { code: 'OP_PLAN_NOT_FOUND', message: 'プランが見つかりません' } },
        { status: 404 }
      );
    }

    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      // #1654: 本文が JSON として読めないときは 400 OP_INVALID_INPUT (外側の catch の 500 に落とさない)
      return invalidJsonBodyResponse();
    }
    const body = bodyResult.body;
    const parseResult = PlanUpdateSchema.safeParse(body);

    if (!parseResult.success) {
      return invalidInputResponse(parseResult.error.issues);
    }

    const input = parseResult.data;

    // status 遷移が指定されている場合は許可された遷移か検証する
    // (#1041 修正: public/private 到達後に status 変更が恒久ロックされていたバグ)
    if (input.status !== undefined && input.status !== existing.status) {
      if (!isAllowedPlanStatusTransition(existing.status, input.status)) {
        return NextResponse.json(
          {
            error: {
              code: 'OP_PLAN_INVALID_TRANSITION',
              message: `${existing.status} から ${input.status} への遷移は許可されていません`,
            },
          },
          { status: 422 }
        );
      }

      // deprecated への遷移は ends_at (廃止予定日) が既存または今回のリクエストで
      // 必要 (subscription_plans.ends_at 列。migration_message は未実装の列のため要 migration)。
      // 判定は書いた後の値で行う (本文で ends_at: null を送ると既存の値も消えるので、既存の値があっても断る)
      const endsAtAfterUpdate = input.ends_at !== undefined ? input.ends_at : existing.ends_at;
      if (input.status === 'deprecated' && endsAtAfterUpdate == null) {
        return NextResponse.json(
          {
            error: {
              code: 'OP_PLAN_DEPRECATE_ENDS_AT_REQUIRED',
              message: '廃止移行には ends_at (廃止予定日) の指定が必要です',
            },
          },
          { status: 400 }
        );
      }

      // #1127: 契約者がいるプランは廃止できない。
      // 契約者への移行案内・自動更新の停止・廃止前の通知 (90 / 30 / 7 日前) はまだ作っていないため、
      // 契約者がいるまま廃止すると、案内が届かないまま廃止したプランで課金だけが続くおそれがある。
      // 課金が始まるまでは「契約者が 0 になってから廃止する」運用にして、ここで止める。
      // (新しい申込だけを止めたいときは、public --> private に変える。既存の契約は続く)
      if (input.status === 'deprecated') {
        let counts: PlanSubscriberCounts;
        try {
          // requireRole を通ったあとだけ service_role を使う。RLS に左右されず全員分を数えるため。
          // plan_key で絞った件数 (head) だけを取り、他人の行の中身は読まない。
          // 組織のプランの行 (plan_type = 'org' の org_*) では組織の件数を数えない (#1912。plan-subscribers.ts の冒頭)
          counts = await countPlanSubscribers(getSupabaseAdmin(), { plan_key: existing.plan_key, plan_type: existing.plan_type });
        } catch (countErr) {
          // 数えられなかったときは、契約者なしとは見なさず廃止も止める (安全装置を黙って外さない)。
          // 本文は汎用メッセージだけにし、DB の生のエラー文は返さずログに残す (#1172)。
          logger.withUser(user.id).error('契約者数を確認できなかったため、プランの廃止を中止しました', countErr, {
            plan_id: params.id,
            plan_key: existing.plan_key,
            ...(countErr instanceof PlanSubscriberCountError ? { table: countErr.table, pg_code: countErr.pgCode } : {}),
          });
          return NextResponse.json(
            {
              error: {
                code: 'OP_PLAN_SUBSCRIBER_CHECK_FAILED',
                message: '契約者数を確認できなかったため、廃止を中止しました。時間をおいて、もう一度お試しください。',
              },
            },
            { status: 500 }
          );
        }

        // 組織のプランの行では、組織の件数を「0 件」として判定に入れない (数えていないので counts に organizations が無い)。
        // 個人・家族の契約者がいれば、これまでどおり止める (#1912)
        if (totalPlanSubscribers(counts) > 0) {
          return NextResponse.json(
            {
              error: {
                code: 'OP_PLAN_HAS_SUBSCRIBERS',
                message: planHasSubscribersMessage(counts, { canUnpublish: existing.status === 'public' }),
                counts,
                // 組織の件数を数えていないときは、件数の欄 (counts.organizations) の代わりに注記を返す (#1912)
                ...(isOrganizationsCounted(counts) ? {} : { organizations_note: ORG_SUBSCRIPTION_PLAN_ROW_NOTE }),
              },
            },
            { status: 409 }
          );
        }
      }
    }

    // status 別の更新可能フィールド制限 (operator/04-plan-management.md §3.1)
    // status 自体は上記の遷移許可チェックを通過済みであれば許可する。
    if (existing.status === 'public' || existing.status === 'private') {
      // public/private では display_name / description / banner_url / feature_packages / status(遷移) / ends_at(廃止時) のみ
      const allowedKeys = [
        'display_name',
        'description',
        'banner_url',
        'feature_package_ids',
        'display_order',
        'status',
        'ends_at',
      ];
      const inputKeys = Object.keys(input).filter((k) => input[k as keyof typeof input] !== undefined);
      const disallowedKeys = inputKeys.filter((k) => !allowedKeys.includes(k));
      if (disallowedKeys.length > 0) {
        return NextResponse.json(
          {
            error: {
              code: 'OP_PLAN_STATUS_LOCKED',
              message: `公開中プランでは ${disallowedKeys.join(', ')} は変更できません。価格変更は price-change API を使用してください。`,
            },
          },
          { status: 422 }
        );
      }
    }

    if (existing.status === 'deprecated') {
      // deprecated では private への遷移 (un-deprecate) のみ許可 (それ以外は変更不可)
      const allowedKeys: string[] = ['status'];
      const inputKeys = Object.keys(input).filter((k) => input[k as keyof typeof input] !== undefined);
      const disallowedKeys = inputKeys.filter((k) => !allowedKeys.includes(k));
      if (disallowedKeys.length > 0) {
        return NextResponse.json(
          { error: { code: 'OP_PLAN_DEPRECATED_LOCKED', message: '廃止済みプランは変更できません' } },
          { status: 422 }
        );
      }
    }

    const updateData: Record<string, unknown> = {};
    if (input.display_name !== undefined) updateData.display_name = input.display_name;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.banner_url !== undefined) updateData.banner_url = input.banner_url;
    if (input.feature_package_ids !== undefined) updateData.feature_packages = input.feature_package_ids;
    if (input.display_order !== undefined) updateData.display_order = input.display_order;
    if (input.max_members !== undefined) updateData.max_members = input.max_members;
    if (input.max_family_seats !== undefined) updateData.max_family_seats = input.max_family_seats;
    if (input.trial_days !== undefined) updateData.trial_days = input.trial_days;
    if (input.min_contract_months !== undefined) updateData.min_contract_months = input.min_contract_months;
    if (input.auto_renew_default !== undefined) updateData.auto_renew_default = input.auto_renew_default;
    if (input.stripe_product_id !== undefined) updateData.stripe_product_id = input.stripe_product_id;
    if (input.status !== undefined) updateData.status = input.status;
    if (input.ends_at !== undefined) updateData.ends_at = input.ends_at;
    updateData.updated_at = new Date().toISOString();

    const statusChanged = input.status !== undefined && input.status !== existing.status;

    // 判定に使った値のままのときだけ書く (冒頭のコメント)。status は遷移の可否と変えてよい項目の判定に使ったので常に条件にする
    let updateQuery = supabase
      .from('subscription_plans')
      .update(updateData)
      .eq('id', params.id)
      .eq('status', existing.status);
    if (statusChanged && input.status === 'deprecated' && input.ends_at === undefined) {
      // 廃止の ends_at を既存の値に頼った (本文に ends_at が無い): 読んでから書くまでに消されていたら書かない
      updateQuery = updateQuery.not('ends_at', 'is', null);
    }
    const { data: updated, error: updateErr } = await updateQuery.select().maybeSingle();

    if (updateErr) {
      return internalError('PATCH /api/super-admin/plans/[id]', updateErr, { userId: user.id }, { shape: 'nested' });
    }

    if (!updated) {
      // 0 行: 読んでから書くまでに、別の運営がプランを変えた (または消した)。読み直して決める
      const { data: current, error: rereadErr } = await supabase
        .from('subscription_plans')
        .select('*')
        .eq('id', params.id)
        .maybeSingle();
      if (rereadErr) {
        return internalError('PATCH /api/super-admin/plans/[id]', rereadErr, { userId: user.id }, { shape: 'nested' });
      }
      if (!current) {
        return NextResponse.json(
          { error: { code: 'OP_PLAN_NOT_FOUND', message: 'プランが見つかりません' } },
          { status: 404 }
        );
      }
      // 別の運営が同じ変更を先に入れていた: 書かず、記録もしない (その変更は先の運営の監査に残っている)
      if (planAlreadyHasValues(current, updateData)) {
        return NextResponse.json({ data: current });
      }
      return NextResponse.json(STALE_PLAN_RESPONSE, { status: 409 });
    }

    // 監査ログ記録 (status_from は条件つきの更新で確かめた、書いた時点の実際の直前の status)
    await recordAdminAudit({
      supabase,
      actorId: user.id,
      targetId: params.id,
      targetType: 'subscription_plan',
      actionType: 'update_plan',
      details: {
        changes: updateData,
        plan_key: existing.plan_key,
        ...(statusChanged ? { status_from: existing.status, status_to: input.status } : {}),
      },
      severity: 'info',
      request,
      routeName: 'api/super-admin/plans/[id] PATCH',
    });

    return NextResponse.json({ data: updated });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/plans/[id] PATCH]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, props: RouteContext) {
  const params = await props.params;
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();

    const { data: existing, error: fetchErr } = await supabase
      .from('subscription_plans')
      .select('id, status, plan_key')
      .eq('id', params.id)
      .single();

    if (fetchErr || !existing) {
      return NextResponse.json(
        { error: { code: 'OP_PLAN_NOT_FOUND', message: 'プランが見つかりません' } },
        { status: 404 }
      );
    }

    // draft のみ削除可能
    if (existing.status !== 'draft') {
      return NextResponse.json(
        { error: { code: 'OP_PLAN_NOT_DRAFT', message: 'draft 状態のプランのみ削除できます' } },
        { status: 422 }
      );
    }

    const { error: deleteErr } = await supabase
      .from('subscription_plans')
      .delete()
      .eq('id', params.id);

    if (deleteErr) {
      return internalError('DELETE /api/super-admin/plans/[id]', deleteErr, { userId: user.id }, { shape: 'nested' });
    }

    // 監査ログ記録
    await recordAdminAudit({
      supabase,
      actorId: user.id,
      targetId: params.id,
      targetType: 'subscription_plan',
      actionType: 'delete_plan',
      details: { plan_key: existing.plan_key },
      severity: 'warn',
      request,
      routeName: 'api/super-admin/plans/[id] DELETE',
    });

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/plans/[id] DELETE]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}
