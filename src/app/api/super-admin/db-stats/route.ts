/**
 * GET /api/super-admin/db-stats — DB 統計情報
 * super_admin ロール必須
 */
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  try {
    await requireRole(['super_admin']);
    const supabase = await createClient();

    // 各テーブルの大まかな行数を返す
    const [usersRes] = await Promise.all([
      supabase.from('user_profiles').select('id', { count: 'exact', head: true }),
    ]);

    return NextResponse.json({
      data: {
        user_count: usersRes.count ?? 0,
        collected_at: new Date().toISOString(),
      },
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
