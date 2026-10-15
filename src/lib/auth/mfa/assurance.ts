/**
 * セッションの AAL (Authenticator Assurance Level) の読み取り (#1176。docs/design/cross/12-operator-mfa.md §13.2)
 *
 * 段 A は読み取り (SessionClaimsSchema・bearerJwtOf・readSessionAssurance) だけを置く。status の route が使う。
 * 運営の入口の判定 (assertOperatorAssurance) は段 B で同じファイルに足す。
 * このファイルを import してよいのは src/lib/auth/helpers.ts・src/app/api/auth/mfa/**・テストだけ (段 B の走査 ⑥。手製のゲートを作らせない)。
 */
import { headers } from 'next/headers';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { z } from 'zod';
import { AuthError } from '@/lib/auth/errors';

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
