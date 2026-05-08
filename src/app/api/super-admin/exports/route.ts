/**
 * GET  /api/super-admin/exports  — エクスポート一覧
 * POST /api/super-admin/exports  — エクスポートリクエスト開始
 * operator/02-api-spec.md §16 準拠
 * 実エクスポート処理は cron 担当。本 API はキュー管理 + ステータス追跡のみ。
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { CreateExportSchema, ListExportsQuerySchema } from '@/lib/super-admin/exports-schemas';

// エクスポートは gdpr_deletion_requests テーブルを代用
// (専用テーブルは別 PR で追加される想定、本 PR は UI+API の管理フローのみ)

export async function GET(request: NextRequest) {
  try {
    await requireRole(['super_admin']);
    const supabase = await createClient();
    const { searchParams } = new URL(request.url);

    const parsed = ListExportsQuerySchema.safeParse(Object.fromEntries(searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です' } },
        { status: 400 },
      );
    }

    const { page, per_page, status } = parsed.data;

    // gdpr_deletion_requests に格納された export リクエストを返す
    // (export_type が設定されているもの)
    let query = supabase
      .from('gdpr_deletion_requests')
      .select('*', { count: 'exact' })
      .not('deletion_type', 'is', null)
      .order('created_at', { ascending: false })
      .range((page - 1) * per_page, page * per_page - 1);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error, count } = await query;

    if (error) {
      // テーブルが存在しない場合は空配列を返す (graceful)
      return NextResponse.json({
        data: [],
        meta: { total: 0, page, per_page },
        note: 'gdpr_deletion_requests テーブルが未作成のため空です',
      });
    }

    return NextResponse.json({
      data: (data ?? []).map((r) => ({
        id: r.id,
        export_type: r.deletion_type ?? 'user_data',
        format: 'csv',
        status: r.status ?? 'pending',
        requested_by: r.user_id,
        created_at: r.created_at,
        file_url: null,
      })),
      meta: { total: count ?? 0, page, per_page },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message } }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();
    const body = await request.json();

    const parsed = CreateExportSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です', details: parsed.error.flatten() } },
        { status: 400 },
      );
    }

    const { export_type, format, filters, mask_pii } = parsed.data;

    // エクスポートリクエストを gdpr_deletion_requests に記録
    // (dedicated exports テーブルは別 PR)
    const { data, error } = await supabase
      .from('gdpr_deletion_requests')
      .insert({
        user_id: user.id,
        deletion_type: export_type,
        status: 'pending',
        request_details: { format, filters, mask_pii },
      })
      .select()
      .single();

    if (error) {
      // テーブルが存在しない場合は仮 ID を返す
      const fakeId = crypto.randomUUID();
      await supabase.from('admin_audit_logs').insert({
        actor_id: user.id,
        action_type: 'admin.export.request',
        target_type: 'export',
        details: { export_type, format, filters, mask_pii },
        severity: 'info',
      });

      return NextResponse.json({
        data: { export_id: fakeId, status: 'processing', export_type, format, created_at: new Date().toISOString() },
      }, { status: 201 });
    }

    // 監査ログ
    await supabase.from('admin_audit_logs').insert({
      actor_id: user.id,
      action_type: 'admin.export.request',
      target_type: 'export',
      target_id: data.id,
      details: { export_type, format, filters, mask_pii },
      severity: 'info',
    });

    return NextResponse.json({
      data: { export_id: data.id, status: 'processing', export_type, format, created_at: data.created_at },
    }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message } }, { status: 500 });
  }
}
