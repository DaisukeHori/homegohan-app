/**
 * GET    /api/super-admin/experiments/[id]  — 実験詳細
 * PATCH  /api/super-admin/experiments/[id]  — 実験更新 (start/stop/cancel)
 * DELETE /api/super-admin/experiments/[id]  — 実験削除
 * operator/02-api-spec.md §15 準拠
 *
 * 読み込み・更新の DB の失敗 (#1917): DB の失敗は 500 にし、行が無いときだけ 404 にする (一時的な失敗で実験が消えたように見せない)。
 * UUID の形でない id は DB に渡さず 404。
 *
 * 状態の遷移 (#2059): PATCH で status を送ったときは今の status を読み、遷移表 (EXPERIMENT_STATUS_TRANSITIONS。
 * 画面のボタンと同じ draft → running・running → completed・running → cancelled) に無い変更 (同じ状態への変更を含む) を
 * 409 OP_EXPERIMENT_INVALID_TRANSITION で断る (書かず、監査ログも残さない)。DB には遷移を止めるトリガーが無い。
 * 更新は読んだ status のままのときだけ書く条件つきで、読んでから書くまでに別の操作 (2 つのタブ・2 人) が状態を変えていたら
 * 0 行 → 読み直して、無ければ 404、あれば 409 CONFLICT_STALE_DATA (書かず、監査ログも残さない)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { authFailureNested } from '@/lib/api/error-responses';
import {
  EXPERIMENT_INVALID_TRANSITION_ERROR_CODE,
  UpdateExperimentSchema,
  experimentStatusTransitionMessage,
  isAllowedExperimentStatusTransition,
} from '@/lib/super-admin/experiments-schemas';
import { STALE_DATA_ERROR_CODE, STALE_DATA_HTTP_STATUS } from '@/lib/admin/api-error-message';
import { internalError } from '@/lib/api/errors';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { readJsonBody, SUPER_ADMIN_INVALID_JSON_BODY_MESSAGE } from '@/lib/super-admin/validation-errors';
import { isUuid } from '@/lib/http-params';

type Params = { params: Promise<{ id: string }> };

/** 実験が無い (UUID の形でない id を含む) */
const EXPERIMENT_NOT_FOUND_RESPONSE = { error: { code: 'NOT_FOUND', message: '実験が見つかりません' } } as const;

/** 遷移表に無い状態の変更を断るときの HTTP ステータス (409 Conflict。今の状態と衝突する) */
const EXPERIMENT_INVALID_TRANSITION_HTTP_STATUS = 409;

/** 読んでから書くまでに別の操作が実験の状態を変えていた (条件つきの更新が 0 行) */
const EXPERIMENT_STALE_STATUS_RESPONSE = {
  error: { code: STALE_DATA_ERROR_CODE, message: '別の操作で実験の状態が先に変わりました。読み込み直してください' },
} as const;

export async function GET(_request: NextRequest, props: Params) {
  const params = await props.params;
  try {
    await requireRole(['super_admin']);
    // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、「DB の失敗は 500」に入る)
    if (!isUuid(params.id)) {
      return NextResponse.json(EXPERIMENT_NOT_FOUND_RESPONSE, { status: 404 });
    }
    const supabase = await createClient();

    const { data, error } = await supabase
      .from('experiments')
      .select('*')
      .eq('id', params.id)
      .maybeSingle();

    // 読めなかったときは 404 にしない (行が無いときだけ 404。一時的な失敗で実験が消えたように見せない。#1917)
    if (error) {
      return internalError('GET /api/super-admin/experiments/[id]', error, { table: 'experiments' }, { shape: 'nested' });
    }
    if (!data) {
      return NextResponse.json(EXPERIMENT_NOT_FOUND_RESPONSE, { status: 404 });
    }

    return NextResponse.json({ data });
  } catch (err) {
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    return internalError('GET /api/super-admin/experiments/[id]', err, {}, { shape: 'nested' });
  }
}

export async function PATCH(request: NextRequest, props: Params) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();
    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      // #1654: 本文が JSON として読めないときは 400 (外側の catch の 500 に落とさない)。コードはこの route の他の 400 と同じ VALIDATION_ERROR
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: SUPER_ADMIN_INVALID_JSON_BODY_MESSAGE } },
        { status: 400 },
      );
    }
    const body = bodyResult.body;

    const parsed = UpdateExperimentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です', details: parsed.error.flatten() } },
        { status: 400 },
      );
    }

    // UUID の形でない id は DB に渡さず 404 (入力の検査 (400) のあと。行が無い UUID と同じ順にそろえる)
    if (!isUuid(params.id)) {
      return NextResponse.json(EXPERIMENT_NOT_FOUND_RESPONSE, { status: 404 });
    }

    const nextStatus = parsed.data.status;
    // 状態を変えるときは、今の status を読んで遷移表で検査する (#2059)。読んだ status は更新の条件にも使う
    let currentStatus: string | null = null;
    if (nextStatus !== undefined) {
      const { data: current, error: currentError } = await supabase
        .from('experiments')
        .select('status')
        .eq('id', params.id)
        .maybeSingle();
      // 読めなかったときは 404 にしない (行が無いときだけ 404。#1917)
      if (currentError) {
        return internalError('PATCH /api/super-admin/experiments/[id]', currentError, { userId: user.id, table: 'experiments' }, { shape: 'nested' });
      }
      if (!current) {
        return NextResponse.json(EXPERIMENT_NOT_FOUND_RESPONSE, { status: 404 });
      }
      currentStatus = current.status;
      if (!isAllowedExperimentStatusTransition(current.status, nextStatus)) {
        return NextResponse.json(
          {
            error: {
              code: EXPERIMENT_INVALID_TRANSITION_ERROR_CODE,
              message: experimentStatusTransitionMessage(current.status, nextStatus),
            },
          },
          { status: EXPERIMENT_INVALID_TRANSITION_HTTP_STATUS },
        );
      }
    }

    // 書き込みは service_role だけ (requireRole を通したあと。運営の直接の書き込みを塞いだ。#1917 の続き)
    let updateQuery = getSupabaseAdmin().from('experiments').update(parsed.data).eq('id', params.id);
    // 状態の変更は、読んだ status のままのときだけ書く (二度押し・2 つのタブで、2 本目が古い状態の検査のまま書かないように。#2059)
    if (currentStatus !== null) {
      updateQuery = updateQuery.eq('status', currentStatus);
    }
    const { data, error } = await updateQuery.select().maybeSingle();

    // 書けなかったときは 404 にしない (更新した行が無いときだけ 404。#1917)
    if (error) {
      return internalError('PATCH /api/super-admin/experiments/[id]', error, { userId: user.id, table: 'experiments' }, { shape: 'nested' });
    }
    if (!data) {
      if (currentStatus === null) {
        return NextResponse.json(EXPERIMENT_NOT_FOUND_RESPONSE, { status: 404 });
      }
      // 状態の条件で 0 行: 読み直して、行が消えていれば 404、あれば別の操作が先に状態を変えたので 409 (書かず、監査も残さない)
      const { data: reread, error: rereadError } = await supabase
        .from('experiments')
        .select('id')
        .eq('id', params.id)
        .maybeSingle();
      if (rereadError) {
        return internalError('PATCH /api/super-admin/experiments/[id]', rereadError, { userId: user.id, table: 'experiments' }, { shape: 'nested' });
      }
      if (!reread) {
        return NextResponse.json(EXPERIMENT_NOT_FOUND_RESPONSE, { status: 404 });
      }
      return NextResponse.json(EXPERIMENT_STALE_STATUS_RESPONSE, { status: STALE_DATA_HTTP_STATUS });
    }

    // 監査ログ
    await recordAdminAudit({
      supabase,
      actorId: user.id,
      actionType: 'super_admin.plan.update',
      targetType: 'experiment',
      targetId: params.id,
      details: { changes: parsed.data },
      severity: parsed.data.status === 'cancelled' ? 'warn' : 'info',
      request,
      routeName: 'api/super-admin/experiments/[id] PATCH',
    });

    return NextResponse.json({ data });
  } catch (err) {
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    return internalError('PATCH /api/super-admin/experiments/[id]', err, {}, { shape: 'nested' });
  }
}

export async function DELETE(request: NextRequest, props: Params) {
  const params = await props.params;
  try {
    const user = await requireRole(['super_admin']);
    // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、「DB の失敗は 500」に入る)
    if (!isUuid(params.id)) {
      return NextResponse.json(EXPERIMENT_NOT_FOUND_RESPONSE, { status: 404 });
    }
    const supabase = await createClient();

    // running 状態の実験は削除不可
    const { data: existing, error: fetchError } = await supabase
      .from('experiments')
      .select('status, key, name')
      .eq('id', params.id)
      .maybeSingle();

    // 読めなかったときは 404 にしない (行が無いときだけ 404。#1917)
    if (fetchError) {
      return internalError('DELETE /api/super-admin/experiments/[id]', fetchError, { userId: user.id, table: 'experiments' }, { shape: 'nested' });
    }
    if (!existing) {
      return NextResponse.json(EXPERIMENT_NOT_FOUND_RESPONSE, { status: 404 });
    }

    if (existing.status === 'running') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '実行中の実験は削除できません。先にキャンセルしてください。' } },
        { status: 422 },
      );
    }

    // experiment_assignments を先に削除
    // 書き込みは service_role だけ (requireRole を通したあと。運営の直接の書き込みを塞いだ。#1917 の続き)
    await getSupabaseAdmin().from('experiment_assignments').delete().eq('experiment_id', params.id);

    // 書き込みは service_role だけ (requireRole を通したあと。運営の直接の書き込みを塞いだ。#1917 の続き)
    const { error } = await getSupabaseAdmin().from('experiments').delete().eq('id', params.id);
    if (error) {
      return internalError('DELETE /api/super-admin/experiments/[id]', error, { userId: user.id }, { shape: 'nested' });
    }

    // 監査ログ
    await recordAdminAudit({
      supabase,
      actorId: user.id,
      actionType: 'super_admin.plan.update',
      targetType: 'experiment',
      targetId: params.id,
      details: { key: existing.key, name: existing.name, action: 'delete' },
      severity: 'warn',
      request,
      routeName: 'api/super-admin/experiments/[id] DELETE',
    });

    return NextResponse.json({ data: { id: params.id, deleted: true } });
  } catch (err) {
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    return internalError('DELETE /api/super-admin/experiments/[id]', err, {}, { shape: 'nested' });
  }
}
