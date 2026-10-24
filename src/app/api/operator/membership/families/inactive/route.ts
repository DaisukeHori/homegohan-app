/**
 * GET /api/operator/membership/families/inactive
 * inactive representative を持つ家族グループ一覧を返す
 * 05-operator-emergency-ui.md §7 準拠
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireSuperAdmin } from '@/lib/auth/operator-permissions';
import { authFailureNested, operatorMfaRequiredNested } from '@/lib/api/error-responses';
import { internalError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireSuperAdmin();
    const supabase = await createClient();

    const { data, error } = await supabase.rpc('list_families_with_inactive_representative');
    if (error) {
      // DB の二段階認証の判定 (OPERATOR_MFA_REQUIRED。cross/12 §11.4) で止まったら、ゲート (requireSuperAdmin) が二段階認証で止めたときと
      // 同じ 403 と日本語の固定の文にする (汎用の 500 にしない。#1917)
      const mfaRequired = operatorMfaRequiredNested(error);
      if (mfaRequired) return mfaRequired;
      return internalError('GET /api/operator/membership/families/inactive', error, {}, { shape: 'nested' });
    }

    return NextResponse.json({ data: data ?? [] });
  } catch (err) {
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    return internalError('GET /api/operator/membership/families/inactive', err, {}, { shape: 'nested' });
  }
}
