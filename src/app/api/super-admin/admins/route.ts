/**
 * GET /api/super-admin/admins — 管理者一覧
 * super_admin ロール必須
 */
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';

export async function GET() {
  try {
    await requireRole(['super_admin']);
    const supabase = await createClient();

    const { data, error } = await supabase
      .from('user_profiles')
      .select('id, nickname, roles, created_at')
      .contains('roles', ['admin'])
      .order('created_at', { ascending: false });

    if (error) {
      return internalError('GET /api/super-admin/admins', error, {}, { shape: 'nested' });
    }

    return NextResponse.json({ admins: data ?? [] });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
    }
    return internalError('GET /api/super-admin/admins', err, {}, { shape: 'nested' });
  }
}
