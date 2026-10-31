/**
 * GET /api/super-admin/admins — 管理者一覧
 * super_admin ロール必須
 */
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { authFailureNested } from '@/lib/api/error-responses';
import { createClient } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';
import { LIST_ORDERS, orderListBy } from '@/lib/api/list-order';

export async function GET() {
  try {
    await requireRole(['super_admin']);
    const supabase = await createClient();

    // 登録した日時の新しい順。同じ日時は id の順 (#2139 T1)
    const { data, error } = await orderListBy(
      supabase.from('user_profiles').select('id, nickname, roles, created_at').contains('roles', ['admin']),
      LIST_ORDERS.superAdminAdmins,
    );

    if (error) {
      return internalError('GET /api/super-admin/admins', error, {}, { shape: 'nested' });
    }

    return NextResponse.json({ admins: data ?? [] });
  } catch (err) {
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    return internalError('GET /api/super-admin/admins', err, {}, { shape: 'nested' });
  }
}
