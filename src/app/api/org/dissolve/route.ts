// POST /api/org/dissolve — オーナーが自分の組織を解散する (#1917。docs/design/family/11-self-dissolve.md §14.2)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { internalError } from '@/lib/api/errors';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { normalizeUuid } from '@/lib/http-params';
import { DissolveOrgBodySchema, SelfDissolveRpcResultSchema } from '@/schemas/membership/self-dissolve';
import { notifySelfDissolve } from '@/lib/membership/self-dissolve-notification';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/org/dissolve';

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const logger = createLogger(ROUTE_NAME, generateRequestId());
  const supabase = await createClient();

  // 凍結中も呼べる (FROZEN_ALLOWED_API_PATHS) ので、凍結を見る requireUser は使わない (退会・書き出しと同じ)
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } }, { status: 401 });
  }
  const log = logger.withUser(user.id);

  const body: unknown = await request.json().catch(() => null);
  const parsed = DissolveOrgBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: MembershipErrorCode.VALIDATION_ERROR, message: '入力の内容が正しくありません' } }, { status: 400 });
  }
  const organizationId = normalizeUuid(parsed.data.organization_id);

  // オーナーかの判定・後始末・監査は RPC の中 (組織の行のロック下。呼び出した本人の行は先に取らない。
  // supabase/migrations/20261022140000_org_transfer_toctou.sql)。route は役割 (org_role) を読まない
  const { data, error } = await supabase.rpc('dissolve_org_by_owner', { p_organization_id: organizationId });
  if (error) {
    const { code, status } = mapPgErrorToHttp(error.message ?? '', error.code);
    if (status >= 500) return internalError(ROUTE_NAME, error, { userId: user.id }, { shape: 'nested' });
    return NextResponse.json({ error: { code, message: '組織の解散に失敗しました' } }, { status });
  }
  const result = SelfDissolveRpcResultSchema.safeParse(data);
  if (!result.success) {
    return internalError(ROUTE_NAME, new Error('dissolve_org_by_owner returned an unexpected shape'), { userId: user.id }, { shape: 'nested' });
  }

  // 解散はすでに完了している。通知は best-effort (失敗しても 200。宛先のアドレスはログに残さない)
  await notifySelfDissolve({
    scope: 'organization',
    scopeId: result.data.scope_id,
    scopeName: result.data.scope_name,
    memberUserIds: result.data.member_user_ids,
    log,
  });

  return NextResponse.json({ data: { organization_id: result.data.scope_id, dissolved_at: result.data.dissolved_at } });
}
