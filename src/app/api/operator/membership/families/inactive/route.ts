/**
 * GET /api/operator/membership/families/inactive
 * inactive representative を持つ家族グループ一覧を返す
 * 05-operator-emergency-ui.md §7 準拠
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireSuperAdmin } from '@/lib/auth/operator-permissions';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { internalError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireSuperAdmin();
    const supabase = createClient();

    const { data, error } = await supabase.rpc('list_families_with_inactive_representative');
    if (error) {
      return internalError('GET /api/operator/membership/families/inactive', error, {}, { shape: 'nested' });
    }

    return NextResponse.json({ data: data ?? [] });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
    }
    return internalError('GET /api/operator/membership/families/inactive', err, {}, { shape: 'nested' });
  }
}
