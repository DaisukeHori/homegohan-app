/**
 * GET    /api/super-admin/experiments/[id]  — 実験詳細
 * PATCH  /api/super-admin/experiments/[id]  — 実験更新 (start/stop/cancel)
 * DELETE /api/super-admin/experiments/[id]  — 実験削除
 * operator/02-api-spec.md §15 準拠
 *
 * 読み込み・更新の DB の失敗 (#1917): DB の失敗は 500 にし、行が無いときだけ 404 にする (一時的な失敗で実験が消えたように見せない)。
 * UUID の形でない id は DB に渡さず 404。
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { authFailureNested } from '@/lib/api/error-responses';
import { UpdateExperimentSchema } from '@/lib/super-admin/experiments-schemas';
import { internalError } from '@/lib/api/errors';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { readJsonBody, SUPER_ADMIN_INVALID_JSON_BODY_MESSAGE } from '@/lib/super-admin/validation-errors';
import { isUuid } from '@/lib/http-params';

type Params = { params: Promise<{ id: string }> };

/** 実験が無い (UUID の形でない id を含む) */
const EXPERIMENT_NOT_FOUND_RESPONSE = { error: { code: 'NOT_FOUND', message: '実験が見つかりません' } } as const;

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
  const nullCharacterRejection = await rejectNullCharacterBody(request);
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

    const { data, error } = await supabase
      .from('experiments')
      .update(parsed.data)
      .eq('id', params.id)
      .select()
      .maybeSingle();

    // 書けなかったときは 404 にしない (更新した行が無いときだけ 404。#1917)
    if (error) {
      return internalError('PATCH /api/super-admin/experiments/[id]', error, { userId: user.id, table: 'experiments' }, { shape: 'nested' });
    }
    if (!data) {
      return NextResponse.json(EXPERIMENT_NOT_FOUND_RESPONSE, { status: 404 });
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
    await supabase.from('experiment_assignments').delete().eq('experiment_id', params.id);

    const { error } = await supabase.from('experiments').delete().eq('id', params.id);
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
