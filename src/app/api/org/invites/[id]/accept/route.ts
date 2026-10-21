// src/app/api/org/invites/[id]/accept/route.ts
// (設計書 02-flow-spec.md §1.2 Happy path — POST /api/org/invites/{token}/accept)
// Note: [id] slug is used for route deduplication; the value is the invite token.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { internalError } from '@/lib/api/errors';

/**
 * RPC (accept_org_invite) のエラーコードごとの、利用者に見せる文。RPC の生のエラー文は本文に出さない (#1172)。
 * ここに無い 4xx のコードは ORG_INVITE_ACCEPT_FAILED_MESSAGE にする (画面 src/app/invite/[token]/page.tsx はコードで出し分け、
 * 出し分けの無いコードはこの文をそのまま出す)
 */
const ORG_INVITE_ACCEPT_MESSAGES: Partial<Record<string, string>> = {
  // Q-4 (docs/design/family/11-self-dissolve.md): 招待の組織が解散している (20261022100000_org_invite_dissolved.sql)。
  // 招待は pending のまま残るが承諾はできない。解散した組織では招待の再発行もできないので、再発行の依頼は案内しない
  [MembershipErrorCode.ORG_ALREADY_DISSOLVED]: 'この組織は解散しているため、招待を承諾できません。',
};
/** 承諾できなかったときの、コードに合う文が無いときの文 */
const ORG_INVITE_ACCEPT_FAILED_MESSAGE = '招待の承諾に失敗しました';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: token } = await params;

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } },
      { status: 401 },
    );
  }

  const { data, error } = await supabase.rpc('accept_org_invite', { p_token: token });

  if (error) {
    // RPC の生のエラー文は本文に出さない (#1172)。分かるコードは固定の文で返し、分からないものは汎用の 500 にして構造化ログに残す
    const { code, status } = mapPgErrorToHttp(error.message);
    if (status >= 500) {
      return internalError('POST /api/org/invites/[id]/accept', error, { userId: user.id }, { shape: 'nested' });
    }
    const message = ORG_INVITE_ACCEPT_MESSAGES[code] ?? ORG_INVITE_ACCEPT_FAILED_MESSAGE;
    return NextResponse.json({ error: { code, message } }, { status });
  }

  // accept_org_invite returns updated user_profiles row
  const profile = data as { organization_id: string | null; org_role?: string | null } | null;

  return NextResponse.json({
    ok: true,
    organization_id: profile?.organization_id ?? null,
    role: (profile as Record<string, unknown>)?.org_role ?? null,
  });
}
