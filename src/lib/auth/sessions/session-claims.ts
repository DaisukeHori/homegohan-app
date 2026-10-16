/**
 * JWT の claims の読み取りと、利用者の API の認証 (requireSessionUser)。
 * 設計の正典 docs/design/cross/16-auth-history-sessions.md §12.4・§13.8。
 */
import { z } from 'zod';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { isAccountFrozen } from '@/lib/auth/frozen';
export const SessionClaimsSchema = z.object({
  sub: z.uuid(),
  session_id: z.uuid(),
  amr: z.array(z.object({ method: z.string(), timestamp: z.number() })).optional(),
});
export type SessionClaims = z.infer<typeof SessionClaimsSchema>;
/**
 * 再設定 (現在のパスワード無しの変更) を受け付ける amr の method。どちらも「メールのリンク / コードで、メールボックスを持つことを示して作ったセッション」(§3):
 * - 'recovery': PKCE の code の経路 (Web の resetPasswordForEmail → /auth/reset-password?code=… を browser の client が交換)。GoTrue は flow state の方法を amr に書く
 * - 'otp': token_hash の経路 (POST /verify。Web の /auth/callback・モバイルの authLink.ts の verifyOtp) と implicit の経路 (GET /verify → フラグメント → モバイルの再設定の画面 reset-password.tsx の setSession)。GoTrue は models.OTP を amr に書く
 * 'password' / 'oauth' (盗んだ普通のセッション) は含めない (S-15)
 */
export const RECOVERY_AMR_METHODS: ReadonlySet<string> = new Set(['recovery', 'otp']);
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
export function bearerTokenOf(authorization: string | null | undefined): string | null {
  const m = authorization?.match(/^Bearer\s+(\S+)$/i);
  return m?.[1] ?? null;
}
/** auth-js の GoTrueClient['auth'] のうち使うもの (テストでは偽物を渡す) */
export interface SessionClaimsReader {
  getSession(): Promise<{ data: { session: { access_token: string } | null } }>;
  getClaims(jwt?: string): Promise<{ data: { claims: unknown } | null; error: { message: string } | null }>;
}
/** 検証済みの claims と、その元の access token。token は GoTrue を本人として呼ぶ (updatePasswordWithAccessToken §13.7・signOutOtherSessions §13.1) のに使う。ログ・応答に出さない */
export interface SessionAuth {
  readonly claims: SessionClaims;
  readonly accessToken: string;
}
/** Bearer (モバイル) があればその JWT、無ければ Cookie のセッションの access_token を getClaims で検証して読む。読めなければ null */
export async function readSessionAuth(auth: SessionClaimsReader, authorization: string | null | undefined): Promise<SessionAuth | null> {
  const token = bearerTokenOf(authorization) ?? (await auth.getSession()).data.session?.access_token ?? null;
  if (!token) return null;
  const { data, error } = await auth.getClaims(token);
  if (error || !data) return null;
  const parsed = SessionClaimsSchema.safeParse(data.claims);
  return parsed.success ? { claims: parsed.data, accessToken: token } : null;
}
/** amr に、now から maxAgeMinutes 以内の recovery / otp (RECOVERY_AMR_METHODS) があるか (再設定の API の認可) */
export function hasRecentRecoveryMethod(claims: SessionClaims, now: Date, maxAgeMinutes: number): boolean {
  return (claims.amr ?? []).some(
    (entry) => RECOVERY_AMR_METHODS.has(entry.method) && now.getTime() - entry.timestamp * MS_PER_SECOND <= maxAgeMinutes * MS_PER_MINUTE,
  );
}
/** requireSessionUser の戻り。route はこれで本人・本人の access token・世代数の入力 (roles) を受ける */
export interface SessionUserContext {
  readonly user: User;
  readonly session: SessionAuth;
  /** user_profiles.roles。プロフィールの行が無ければ [] (passwordHistoryGenerationsFor の入力。認可には使わない) */
  readonly roles: ReadonlyArray<string>;
}
/** 凍結の判定と世代数に要る列だけ (行は無くてもよい) */
const SessionUserProfileSchema = z.object({
  roles: z.array(z.string()).nullable(),
  frozen_at: z.string().nullable(),
  unban_at: z.string().nullable(),
});
/** user_profiles を読めなかった (DB の失敗)。route は internalError (500) にする。値・DB の英文は持たない */
export class SessionUserProfileReadError extends Error {
  constructor() {
    super('user_profiles を読めませんでした');
    this.name = 'SessionUserProfileReadError';
  }
}
/**
 * 本書の利用者の API 7 本 (§14.1〜14.7) の認証。requireUser (src/lib/auth/helpers.ts) と違い、user_profiles の行を要さない
 * (行は同意・初期設定・招待の承諾で作られ、新規登録の直後と同意の前の利用者には無い §3・R-15)。
 * 1. supabase.auth.getUser() (Cookie / Bearer) で本人を確かめる。error・user 無しは AuthError('AUTH_UNAUTHENTICATED')
 * 2. readSessionAuth で claims と access token を読む。読めない・sub が 1 の本人と違うなら AuthError('AUTH_UNAUTHENTICATED')
 * 3. user_profiles の roles / frozen_at / unban_at を maybeSingle で読む。error は SessionUserProfileReadError。
 *    行が無ければ roles = [] で通す (凍結は行の frozen_at なので、行が無ければ凍結は無い)。行があって凍結中なら ForbiddenError('AUTH_ACCOUNT_FROZEN')
 */
export async function requireSessionUser(
  supabase: SupabaseClient,
  authorization: string | null | undefined,
): Promise<SessionUserContext> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData.user;
  if (userError || !user) throw new AuthError('AUTH_UNAUTHENTICATED');
  const session = await readSessionAuth(supabase.auth, authorization);
  if (!session || session.claims.sub !== user.id) throw new AuthError('AUTH_UNAUTHENTICATED');
  const { data, error } = await supabase
    .from('user_profiles')
    .select('roles, frozen_at, unban_at')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw new SessionUserProfileReadError();
  if (data === null) return { user, session, roles: [] };
  const profile = SessionUserProfileSchema.parse(data);
  if (isAccountFrozen({ frozenAt: profile.frozen_at, unbanAt: profile.unban_at })) {
    throw new ForbiddenError('AUTH_ACCOUNT_FROZEN', 'アカウントが凍結されています');
  }
  return { user, session, roles: profile.roles ?? [] };
}
