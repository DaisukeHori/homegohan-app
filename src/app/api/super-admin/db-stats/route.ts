/**
 * GET /api/super-admin/db-stats — DB 統計情報
 * super_admin ロール必須
 */
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { authFailureNested } from '@/lib/api/error-responses';
import { createClient } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';

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
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    return internalError('GET /api/super-admin/db-stats', err, {}, { shape: 'nested' });
  }
}
