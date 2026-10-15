/**
 * セッションの AAL (Authenticator Assurance Level) の読み取り (#1176。docs/design/cross/12-operator-mfa.md §13.2)
 *
 * 読み取り (SessionClaimsSchema・bearerJwtOf・readSessionAssurance。段 A。status の route が使う) と、
 * 運営の入口の判定 (assertOperatorAssurance。段 B。requireRole が呼ぶ) を置く。
 * このファイルを import してよいのは src/lib/auth/helpers.ts・src/app/api/auth/mfa/**・テストだけ (段 B の走査 ⑥。手製のゲートを作らせない)。
 */
import { headers } from 'next/headers';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { z } from 'zod';
import { AuthError, MfaRequiredError } from '@/lib/auth/errors';
import { findVerifiedTotpFactor } from '@/lib/auth/mfa/factors';
import {
  decideOperatorAssurance,
  isMfaRequiredRoleSet,
  readMfaEnforceFromEnv,
  type OperatorAssuranceSummary,
} from '@/lib/auth/mfa/policy';
import type { RoleName } from '@/lib/auth/types';
import { createClient } from '@/lib/supabase/server';

export type AuthenticatorAssuranceLevel = 'aal1' | 'aal2';

/** JWT の claim のうち使うもの。aal が無い (想定外の発行者) ときは aal1 として扱う */
export const SessionClaimsSchema = z.object({
  sub: z.string().min(1),
  aal: z.enum(['aal1', 'aal2']).catch('aal1'),
  session_id: z.string().optional(),
});

export interface SessionAssurance {
  readonly aal: AuthenticatorAssuranceLevel;
  readonly sessionId: string | null;
}

/** Authorization: Bearer <JWT> (3 セグメント) なら token を返す。それ以外 (CRON_SECRET 等) は null (lib/supabase/middleware.ts の isJwtBearerHeader と同じ規則) */
export function bearerJwtOf(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const token = /^Bearer\s+(.+)$/i.exec(authorizationHeader)?.[1];
  if (!token) return null;
  return token.split('.').length === 3 ? token : null;
}

/**
 * いまの要求のセッションの AAL を、署名を確かめた claim から読む。token の探し方は getUser() と同じ優先順:
 *   1. Cookie のセッション (getSession の access_token)
 *   2. 無ければ Authorization: Bearer <JWT> (モバイル。getSession は Cookie を見るので null になる)。
 *      ヘッダは next/headers から、この経路でだけ読む (要求の外で動く単体テストが Cookie の経路で落ちないように)
 * 読めない (token が無い・署名が無効・sub が getUser の利用者と違う) ときは AuthError('AUTH_UNAUTHENTICATED') (fail-closed)。
 * getClaims は、対称鍵 (HS256) のプロジェクトでは Auth サーバーへ 1 回問い合わせる (getUser と同程度)。非対称鍵なら手元で検証する。
 */
export async function readSessionAssurance(supabase: SupabaseClient, user: Pick<User, 'id'>): Promise<SessionAssurance> {
  const { data: sessionData } = await supabase.auth.getSession();
  let token: string | null = sessionData.session?.access_token ?? null;
  if (!token) token = bearerJwtOf((await headers()).get('authorization'));
  if (!token) throw new AuthError('AUTH_UNAUTHENTICATED');

  const { data, error } = await supabase.auth.getClaims(token);
  if (error || !data) throw new AuthError('AUTH_UNAUTHENTICATED');
  const parsed = SessionClaimsSchema.safeParse(data.claims);
  if (!parsed.success || parsed.data.sub !== user.id) throw new AuthError('AUTH_UNAUTHENTICATED');
  return { aal: parsed.data.aal, sessionId: parsed.data.session_id ?? null };
}

export interface AssertOperatorAssuranceInput {
  /** getAuthUser() の戻り (factors を含む) */
  user: User;
  roles: ReadonlyArray<RoleName>;
  /** テストで固定する */
  now?: Date;
}

/**
 * 必須ロールの利用者に AAL2 を求める (§13.2)。通るときは要約を返し、通らないときは MfaRequiredError を投げる。
 * 必須ロールでなければ claims を読まずに { decision: 'not_required' } を返す (support などの要求を遅くしない)。
 */
export async function assertOperatorAssurance(input: AssertOperatorAssuranceInput): Promise<OperatorAssuranceSummary> {
  const required = isMfaRequiredRoleSet(input.roles);
  const enrolled = findVerifiedTotpFactor(input.user) !== null;
  const { enforceFrom } = readMfaEnforceFromEnv();
  const enforceFromIso = enforceFrom ? enforceFrom.toISOString() : null;
  if (!required) return { required, aal: null, enrolled, decision: 'not_required', enforce_from: enforceFromIso };

  const supabase = await createClient();
  const session = await readSessionAssurance(supabase, input.user);
  const result = decideOperatorAssurance({
    roles: input.roles,
    aal: session.aal,
    hasVerifiedTotp: enrolled,
    enforceFrom,
    now: input.now ?? new Date(),
  });
  switch (result.decision) {
    case 'challenge_required':
      throw new MfaRequiredError('AUTH_2FA_REQUIRED', '二段階認証の確認が必要です');
    case 'enrollment_required':
      throw new MfaRequiredError('AUTH_2FA_ENROLLMENT_REQUIRED', '二段階認証の登録が必要です');
    default:
      return { required, aal: session.aal, enrolled, decision: result.decision, enforce_from: enforceFromIso };
  }
}
