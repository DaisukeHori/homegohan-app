/**
 * GET /api/operator/membership/families/inactive
 * inactive representative を持つ家族グループ一覧を返す
 * 05-operator-emergency-ui.md §7 準拠
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireSuperAdmin } from '@/lib/auth/operator-permissions';
import { authFailureNested } from '@/lib/api/error-responses';
import { internalError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireSuperAdmin();
    const supabase = await createClient();

    const { data, error } = await supabase.rpc('list_families_with_inactive_representative');
    if (error) {
      return internalError('GET /api/operator/membership/families/inactive', error, {}, { shape: 'nested' });
    }

    return NextResponse.json({ data: data ?? [] });
  } catch (err) {
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    return internalError('GET /api/operator/membership/families/inactive', err, {}, { shape: 'nested' });
  }
}
