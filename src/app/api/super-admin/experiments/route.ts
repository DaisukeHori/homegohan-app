/**
 * GET  /api/super-admin/experiments  — A/B テスト一覧
 * POST /api/super-admin/experiments  — A/B テスト作成
 * operator/02-api-spec.md §15 準拠
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { CreateExperimentSchema } from '@/lib/super-admin/experiments-schemas';
import { internalError } from '@/lib/api/errors';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

export async function GET(request: NextRequest) {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1'));
    const perPage = Math.min(100, Math.max(1, parseInt(searchParams.get('per_page') ?? '50')));

    let query = supabase
      .from('experiments')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((page - 1) * perPage, page * perPage - 1);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error, count } = await query;

    if (error) {
      return internalError('GET /api/super-admin/experiments', error, { userId: user.id }, { shape: 'nested' });
    }

    return NextResponse.json({
      data: data ?? [],
      meta: { total: count ?? 0, page, per_page: perPage },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
    }
    return internalError('GET /api/super-admin/experiments', err, {}, { shape: 'nested' });
  }
}

export async function POST(request: NextRequest) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) が拒んで 500 になる。認証・DB に触れる前に 400 で断る (#1657)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();
    const body = await request.json();

    const parsed = CreateExperimentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です', details: parsed.error.flatten() } },
        { status: 400 },
      );
    }

    const { data, error } = await supabase
      .from('experiments')
      .insert({
        ...parsed.data,
        status: 'draft',
        created_by: user.id,
      })
      .select()
      .single();

    if (error) {
      return internalError('POST /api/super-admin/experiments', error, { userId: user.id }, { shape: 'nested' });
    }

    // 監査ログ
    await recordAdminAudit({
      supabase,
      actorId: user.id,
      actionType: 'super_admin.plan.create',
      targetType: 'experiment',
      targetId: data.id,
      details: { key: parsed.data.key, name: parsed.data.name },
      severity: 'info',
      request,
      routeName: 'api/super-admin/experiments POST',
    });

    return NextResponse.json({ data }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
    }
    return internalError('POST /api/super-admin/experiments', err, {}, { shape: 'nested' });
  }
}
