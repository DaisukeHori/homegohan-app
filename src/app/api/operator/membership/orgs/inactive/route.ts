/**
 * GET /api/operator/membership/orgs/inactive
 * inactive owner を持つ組織一覧を返す
 * 05-operator-emergency-ui.md §7 準拠
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireSuperAdmin } from '@/lib/auth/operator-permissions';
import { authFailureNested, operatorMfaRequiredNested } from '@/lib/api/error-responses';
import { internalError } from '@/lib/api/errors';
import { operatorMembershipRpcErrorNested } from '@/lib/membership/operator-rpc-errors';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireSuperAdmin();
    const supabase = await createClient();

    const { data, error } = await supabase.rpc('list_orgs_with_inactive_owner');
    if (error) {
      // DB の二段階認証の判定 (OPERATOR_MFA_REQUIRED。cross/12 §11.4) で止まったら、ゲート (requireSuperAdmin) が二段階認証で止めたときと
      // 同じ 403 と日本語の固定の文にする (汎用の 500 にしない。#1917)
      const mfaRequired = operatorMfaRequiredNested(error);
      if (mfaRequired) return mfaRequired;
      // 権限の判定 (INSUFFICIENT_PERMISSION) で止めたら、ゲートが権限で止めたときと同じ 403 と日本語の固定の文にする
      // (汎用の 500 にしない。#1917 の続き。コードの一覧は src/lib/membership/operator-rpc-errors.ts)
      const knownRpcError = operatorMembershipRpcErrorNested('list_orgs_with_inactive_owner', error);
      if (knownRpcError) return knownRpcError;
      return internalError('GET /api/operator/membership/orgs/inactive', error, {}, { shape: 'nested' });
    }

    return NextResponse.json({ data: data ?? [] });
  } catch (err) {
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    return internalError('GET /api/operator/membership/orgs/inactive', err, {}, { shape: 'nested' });
  }
}
