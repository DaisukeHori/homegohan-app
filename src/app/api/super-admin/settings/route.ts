/**
 * GET  /api/super-admin/settings — システム設定一覧
 * PUT  /api/super-admin/settings — システム設定更新
 * super_admin ロール必須
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';

function handleError(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
  }
  const message = err instanceof Error ? err.message : 'Unknown error';
  return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message } }, { status: 500 });
}

export async function GET() {
  try {
    await requireRole(['super_admin']);
    const supabase = await createClient();

    const { data, error } = await supabase
      .from('system_settings')
      .select('key, value, updated_at')
      .order('key', { ascending: true });

    if (error) {
      // テーブルが存在しない場合は空配列を返す
      return NextResponse.json({ settings: [] });
    }

    return NextResponse.json({ settings: data ?? [] });
  } catch (err) {
    return handleError(err);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const actor = await requireRole(['super_admin']);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'リクエストボディが不正です' } }, { status: 400 });
    }

    const { key, value } = (body as Record<string, unknown>) ?? {};
    if (!key || typeof key !== 'string' || key.trim() === '') {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'key は必須です' } }, { status: 400 });
    }
    if (value === undefined) {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'value は必須です' } }, { status: 400 });
    }

    const supabase = await createClient();
    const { error } = await supabase
      .from('system_settings')
      .upsert({ key: key.trim(), value, updated_by: actor.id, updated_at: new Date().toISOString() });

    if (error) {
      return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: error.message } }, { status: 500 });
    }

    return NextResponse.json({ success: true, key: key.trim() });
  } catch (err) {
    return handleError(err);
  }
}
