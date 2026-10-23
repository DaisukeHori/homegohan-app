/**
 * 認証リンクの戻り先で、サーバーの /auth/callback が読めない URL のハッシュ (#...) を、ブラウザで読むための取り決め (#1574)
 *
 * /auth/callback (src/app/(auth)/auth/callback/route.ts) はサーバーで動くので、URL のハッシュ (#message=... など) は
 * 届かない。Supabase Auth (GoTrue) は、メールアドレス変更の確認の 1 通目 (Secure email change が有効なとき) で、
 * セッションの代わりに知らせ (message) だけをハッシュに付けて戻すため、以前は何も知らせずに /home へ移っていた。
 *
 * そこで /auth/callback は、
 *   - 認証の情報 (code・token_hash・token) が何も無いとき: 本来の遷移先を next に入れて、/auth/link-notice へ移す。
 *     リダイレクトの Location にハッシュを付けなければ、ブラウザは元の URL のハッシュを引き継ぐ
 *     (RFC 9110 §10.2.2) ので、/auth/link-notice (src/app/(auth)/auth/link-notice/page.tsx) がハッシュを読める
 *   - サーバーで 1 通目だと分かったとき (クエリにも message が付いた (GoTrue のソースでは PKCE のリンクのとき)・
 *     token_hash / token の形の email_change で確認は通ったがセッションが返らなかった): notice を付けて、同じく /auth/link-notice へ移す
 * /auth/link-notice は resolveLinkNotice で行き先を決める。知らせが無ければ、そのまま本来の遷移先へ移る。
 */

import { AUTH_LINK_ERROR_MESSAGE, isEmailChangeAwaitingOtherMessage } from '@homegohan/shared';
import { getSafeRedirectPath } from './safe-redirect';

/** ハッシュを読む画面のパス (/auth/* は未ログインでも開ける。lib/supabase/middleware.ts の publicPaths) */
export const LINK_NOTICE_PATH = '/auth/link-notice';
/** 本来の遷移先を渡すクエリの名前 */
export const LINK_NOTICE_NEXT_PARAM = 'next';
/** サーバーが分かった知らせの種類を渡すクエリの名前 */
export const LINK_NOTICE_KIND_PARAM = 'notice';
/** 知らせの種類: メールアドレス変更の確認の 1 通目を受け付けた (もう一方のリンクを待っている) */
export const LINK_NOTICE_EMAIL_CHANGE_AWAITING_OTHER = 'email_change_awaiting_other';
/** next が無い・安全でないときの遷移先 (未ログインなら middleware がログイン画面へ回す) */
export const LINK_NOTICE_DEFAULT_NEXT = '/home';
/** リンク自体がエラーを運んできたときの移り先 (/auth/callback がクエリのエラーで移る先と同じ) */
const LINK_ERROR_PATH = '/login';

export type LinkNoticeKind = typeof LINK_NOTICE_EMAIL_CHANGE_AWAITING_OTHER;

/** /auth/callback から /auth/link-notice へ移すときのパス (クエリつき・ハッシュなし) */
export function buildLinkNoticePath(next: string, notice?: LinkNoticeKind): string {
  const params = new URLSearchParams();
  params.set(LINK_NOTICE_NEXT_PARAM, next);
  if (notice) params.set(LINK_NOTICE_KIND_PARAM, notice);
  return `${LINK_NOTICE_PATH}?${params.toString()}`;
}

export type LinkNoticeResolution =
  /** メールアドレス変更の 1 通目を受け付けた。知らせを出し、利用者が押したら next へ移る */
  | { kind: 'email_change_awaiting_other'; next: string }
  /** リンク自体がエラーを運んできた (期限切れなど)。ログイン画面へ固定の文 (AUTH_LINK_ERROR_MESSAGE) つきで移る */
  | { kind: 'link_error'; redirectTo: string }
  /** 知らせは無い。そのまま next へ移る */
  | { kind: 'continue'; next: string };

function paramsOf(part: string, prefix: '?' | '#'): URLSearchParams {
  return new URLSearchParams(part.startsWith(prefix) ? part.slice(prefix.length) : part);
}

/**
 * /auth/link-notice の行き先を決める。search はクエリ (`?next=...`)、hash はハッシュ (`#message=...`)。
 * 判定の順は /auth/callback と同じく、エラーを先に見る。
 */
export function resolveLinkNotice({ search, hash }: { search: string; hash: string }): LinkNoticeResolution {
  const query = paramsOf(search, '?');
  const fragment = paramsOf(hash, '#');
  const next = getSafeRedirectPath(query.get(LINK_NOTICE_NEXT_PARAM)) ?? LINK_NOTICE_DEFAULT_NEXT;

  const error = fragment.get('error');
  const errorDescription = fragment.get('error_description');
  if (error || errorDescription) {
    // GoTrue の英文 (error_description・error の値) は画面に出さず、日本語の固定の文にする (#1917 の続き。/auth/callback と同じ)
    const params = new URLSearchParams();
    params.set('error', AUTH_LINK_ERROR_MESSAGE);
    return { kind: 'link_error', redirectTo: `${LINK_ERROR_PATH}?${params.toString()}` };
  }

  if (
    query.get(LINK_NOTICE_KIND_PARAM) === LINK_NOTICE_EMAIL_CHANGE_AWAITING_OTHER ||
    isEmailChangeAwaitingOtherMessage(fragment.get('message'))
  ) {
    return { kind: 'email_change_awaiting_other', next };
  }

  return { kind: 'continue', next };
}
