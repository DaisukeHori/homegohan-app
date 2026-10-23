// src/app/api/family/members/child/route.ts
// (設計書 02-flow-spec.md §8)
// #1173 (設計書 cross/14 §6.5.6 の 1・§6.8): 子供の追加に生年月日を必須にし、18 歳未満なら保護者の同意 (電子署名) を
// 同じ RPC (add_family_child) のトランザクションで記録する。検査の順は
//   NULL 文字 → 認証 (401) → JSON (400 INVALID_REQUEST) → Zod (400 VALIDATION_ERROR) → 生年月日の暦・未来・120 年超 (400) →
//   18 歳未満のときだけ: 同意が無い (403) → 同意書の版 (409) → RPC
// 同意を記録したら、署名した本人 (ログイン中の利用者) のメールアドレスへ控えを送る (best-effort。失敗しても 201)。
import { NextResponse } from 'next/server';
import {
  PARENTAL_CONSENT_DOCUMENT,
  PARENTAL_CONSENT_DOCUMENT_PATH,
  requiresParentalConsent,
  todayLocal,
  validateBirthDate,
} from '@homegohan/shared';
import { createClient } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { extractClientIp } from '@/lib/admin/audit';
import { ErrorStatusMap, mapPgErrorToHttp, MEMBERSHIP_ERROR_MESSAGES, MembershipErrorCode } from '@/lib/errors/membership-errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { sendEmail } from '@/lib/emails/send';
import { isEmailFailure, logEmailFailures } from '@/lib/emails/send-result';
import { renderFamilyParentalConsentRecordedEmail } from '@/lib/emails/membership/family-parental-consent-recorded';
import { buildFamilyMembersUrl } from '@/lib/membership/urls';
import { getSiteUrl } from '@/lib/site-config';
import { AddFamilyChildBodySchema } from '@/schemas/membership/family-member';

/** user_agent の最大文字数。DB 関数 add_family_child も 512 文字で切る (ここでも先に切って、巨大なヘッダーを持ち回らない) */
const MAX_USER_AGENT_LENGTH = 512;

/** promote route の `req.family_name ?? '家族グループ'` と同じ既定の呼称 */
const FAMILY_NAME_FALLBACK = '家族グループ';

function membershipError(code: MembershipErrorCode, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: { code, message: MEMBERSHIP_ERROR_MESSAGES[code] }, ...extra }, { status });
}

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const logger = createLogger('POST /api/family/members/child', generateRequestId());

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_REQUEST', message: 'リクエストボディが不正です' } },
      { status: 400 },
    );
  }

  const parsed = AddFamilyChildBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: { code: 'VALIDATION_ERROR', message: '入力内容が正しくありません' },
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // 形 (YYYY-MM-DD) は Zod で確かめ済み。暦に無い日・未来・120 年超はここで断る (RPC を呼ばない)
  const today = todayLocal();
  if (validateBirthDate(body.birth_date, today) !== null) {
    return membershipError(MembershipErrorCode.CHILD_BIRTH_DATE_INVALID, 400);
  }

  // 18 歳未満のときだけ同意を見る (18 歳以上では、形の合う consent は無視する)
  if (requiresParentalConsent(body.birth_date, today)) {
    if (!body.consent) {
      return membershipError(MembershipErrorCode.PARENTAL_CONSENT_REQUIRED, 403);
    }
    if (body.consent.version !== PARENTAL_CONSENT_DOCUMENT.version) {
      return membershipError(MembershipErrorCode.PARENTAL_CONSENT_VERSION_MISMATCH, 409, {
        current: { version: PARENTAL_CONSENT_DOCUMENT.version, effective_date: PARENTAL_CONSENT_DOCUMENT.effectiveDate },
      });
    }
  }

  const consentInput = body.consent;
  const { data: member, error } = await supabase.rpc('add_family_child', {
    p_family_id: body.family_id,
    p_display_name: body.display_name,
    p_child_profile: body.child_profile,
    p_birth_date: body.birth_date,
    p_consent_version: consentInput?.version ?? null,
    p_signed_name: consentInput?.signed_name ?? null,
    p_guardian_attested: consentInput?.guardian_attested ?? false,
    p_ip: extractClientIp(request.headers),
    p_user_agent: request.headers.get('user-agent')?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
  });

  if (error) {
    // billing/03 §9.5: 家族プランの契約が無い代表者のグループにはメンバーを足せない (DB の門が FAMILY_PLAN_REQUIRED を RAISE する)。DB の生の文は出さない
    if ((error.message ?? '').includes(MembershipErrorCode.FAMILY_PLAN_REQUIRED)) {
      return NextResponse.json(
        {
          error: {
            code: MembershipErrorCode.FAMILY_PLAN_REQUIRED,
            message: MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.FAMILY_PLAN_REQUIRED],
          },
        },
        { status: ErrorStatusMap[MembershipErrorCode.FAMILY_PLAN_REQUIRED] },
      );
    }
    if (error.message?.includes('MEMBER_LIMIT_EXCEEDED')) {
      return NextResponse.json(
        { error: { code: MembershipErrorCode.MEMBER_LIMIT_EXCEEDED, message: 'メンバー数の上限に達しています' } },
        { status: 409 },
      );
    }
    const { code, status } = mapPgErrorToHttp(error.message ?? '', error.code);
    return NextResponse.json(
      { error: { code, message: '子供メンバーの追加に失敗しました' } },
      { status },
    );
  }

  // 控えのメールの材料 (同意の行と家族名) を読む。どちらも呼び出し者 (家族の active な大人) は RLS で読める
  const [consentResult, familyResult] = await Promise.all([
    supabase
      .from('parental_consents')
      .select('id, consent_version, signed_at')
      .eq('family_member_id', member.id)
      .is('revoked_at', null)
      .maybeSingle(),
    supabase.from('family_groups').select('name').eq('id', body.family_id).maybeSingle(),
  ]);
  if (consentResult.error || familyResult.error) {
    // 通常は起きない (どちらも RLS で読める)。控えの材料が読めなかったことだけを残す
    logger.withUser(user.id).warn('parental consent email inputs read failed', {
      member_id: member.id,
      consent_pg_code: consentResult.error?.code ?? null,
      family_pg_code: familyResult.error?.code ?? null,
    });
  }
  const consent = consentResult.data;
  if (consent && user.email) {
    try {
      const envelope = renderFamilyParentalConsentRecordedEmail({
        email_address: user.email,
        // 読めなかったとき (通常は起きない) は promote route と同じ既定の呼称にする
        family_name: familyResult.data?.name ?? FAMILY_NAME_FALLBACK,
        child_display_name: body.display_name,
        consent_version: consent.consent_version,
        signed_at: consent.signed_at,
        document_url: `${getSiteUrl()}${PARENTAL_CONSENT_DOCUMENT_PATH}`,
        members_url: buildFamilyMembersUrl(),
      });
      const sent = await sendEmail(envelope);
      if (isEmailFailure(sent)) throw sent.error;
    } catch (emailErr) {
      // 控えのメールの失敗は追加を失敗にしない (同意の記録は DB で完了している)。
      // 宛先停止リストで止めた (suppressed) ときは意図した動きなので warn、ほかの失敗は error (#1577 の 7)
      logEmailFailures(logger.withUser(user.id), 'parental consent email send failed', [emailErr], {
        member_id: member.id,
        consent_id: consent.id,
      });
    }
  } else if (consent) {
    logger.withUser(user.id).warn('parental consent email skipped: no email address', { member_id: member.id });
  }
  return NextResponse.json({ data: { member, consent_recorded: Boolean(consent) } }, { status: 201 });
}
