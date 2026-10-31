// src/lib/auth/signed-in-user.ts
// 画面を開いたときに、ログインしている自分を読む (#2086 V3)。
//
// supabase.auth.getUser() は通信の失敗を投げずに { data: { user: null }, error } で返す (オフラインのときの普通の結果)。
// 以前の画面は error を見ずに `if (!user) router.push('/login')` としていたので、通信が切れているだけなのに
// ログインの画面へ移していた (承諾・譲渡の画面では、承諾の通信が切れたあとの読み直しでもここを通り、
// 「読み直して今の状態を見せる」がちょうど通信の悪いときに働かなかった)。
//
// ただし getUser は、ログインしていない (セッションが無い) ときも error (AuthSessionMissingError) を返す。
// そのため「error があれば読み込みの失敗」とはせず、ログインが切れていることを示す error (isSessionExpiredAuthError:
// セッションが無い・失効した・JWT が不正・401) はログインしていないとして扱い、それ以外の error (通信の失敗・サーバーの障害) だけを
// 読み込みの失敗にする (設定のアカウントの画面 (#1187) と同じ見分け方)。
//
// このファイルはブラウザからも読むので、サーバー専用のもの (service_role のクライアント・next/headers) を import しない。
import type { User } from '@supabase/supabase-js';
import { isSessionExpiredAuthError } from '@/lib/auth/account-errors';

/** 自分を読むのに使う Supabase のクライアントの部分 (ブラウザの createClient の戻り値はこれを満たす) */
export interface AuthUserReader {
  auth: {
    getUser: () => Promise<{ data: { user: User | null }; error: unknown }>;
  };
}

/**
 * 自分を読んだ結果。
 *   - signed-in: ログインしている (user が読めた)
 *   - signed-out: ログインしていない (セッションが無い・切れている)。ログインの画面へ移してよい
 *   - load-failed: 確かめられなかった (通信の失敗・サーバーの障害・例外)。ログインの画面へ移さず、読み込みの失敗と「再試行」を出す
 */
export type SignedInUserRead =
  | { kind: 'signed-in'; user: User }
  | { kind: 'signed-out' }
  | { kind: 'load-failed' };

/** getUser の結果 ({ data: { user }, error }) を 3 つに分ける。テストと画面で同じ分け方を使うために切り出している */
export function classifyGetUserResult(user: User | null, error: unknown): SignedInUserRead {
  if (error !== null && error !== undefined && !isSessionExpiredAuthError(error)) {
    return { kind: 'load-failed' };
  }
  if (!user) return { kind: 'signed-out' };
  return { kind: 'signed-in', user };
}

/** ログインしている自分を読む。例外は投げない (getUser が投げたときは load-failed) */
export async function readSignedInUser(supabase: AuthUserReader): Promise<SignedInUserRead> {
  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();
    return classifyGetUserResult(user, error);
  } catch (readFailure) {
    console.error('[auth] failed to read the signed-in user:', readFailure);
    return { kind: 'load-failed' };
  }
}

/** ログインの画面のパス */
const LOGIN_PATH = '/login';

/**
 * ログインしていない (signed-out) ときに移すログインの画面の URL。ログインのあとに元の画面へ戻れるよう next を付ける (#2093 W4。
 * 以前は next を付けずに /login へ移していたので、ログインし直しても元の画面へ戻らなかった)。
 * next はログインの画面が getSafeRedirectPath で確かめる (同じオリジンの相対パスだけを通す)
 */
export function loginPathWithNext(nextPath: string): string {
  return `${LOGIN_PATH}?next=${encodeURIComponent(nextPath)}`;
}
