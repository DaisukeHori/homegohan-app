/**
 * 単体テストの Supabase のモックに足す getSession / getClaims (#1176。docs/design/cross/12-operator-mfa.md §22.4.2)
 *
 * requireRole を本物で通す単体テストのモックは getUser しか持たない。段 B の requireRole は必須ロールのとき
 * readSessionAssurance を通り、最初に supabase.auth.getSession() を呼び、その access_token を supabase.auth.getClaims(token) に渡す。
 * だからモックには getSession と getClaims の両方が要る。aal2 の claims を返すので、既存の運営のテストは it と assert を変えずに通る。
 * vitest を import しない (素の関数)。呼び出しを数えたい it は vi.fn(aal2AuthMock(getUser).getClaims) のように包む。
 */

/** モックの access_token (3 セグメント。中身は検証されない。getClaims のモックが claims を返す) */
export const TEST_AAL2_ACCESS_TOKEN = 'test-header.test-payload.test-signature';

/** モックの claims の session_id */
export const TEST_AAL2_SESSION_ID = 'test-session-aal2';

export interface TestSessionClaims {
  readonly sub: string;
  readonly aal: 'aal1' | 'aal2';
  readonly session_id: string;
}

/** getUser のモックが利用者を返さないとき、getClaims のモックが返す error の文 (requireRole は getUser の段で先に止まるので、ふつうは届かない) */
export const TEST_CLAIMS_NO_USER_MESSAGE = 'aal2AuthMock: getUser のモックが利用者を返していません';

/** getUser のモックが返す user.id と同じ sub の aal2 の claims (sub が違うと AUTH_UNAUTHENTICATED §13.2) */
export function aal2Claims(userId: string): TestSessionClaims {
  return { sub: userId, aal: 'aal2', session_id: TEST_AAL2_SESSION_ID };
}

/**
 * 同じモックの getUser (vi.fn でも素の関数でもよい)。getClaims は、呼ばれた時点で getUser が返す user.id を sub にする
 * (テストごとに getUser の戻りを差し替えるモックでも、どの id を渡すかを実装者が決めずに済む)
 */
export type TestGetUser = () => Promise<{ data: { user: { id: string } | null } }>;

export type TestGetClaimsResult =
  | { data: { claims: TestSessionClaims }; error: null }
  | { data: null; error: Error };

export interface Aal2AuthMock {
  getSession: () => Promise<{ data: { session: { access_token: string } }; error: null }>;
  getClaims: (jwt?: string) => Promise<TestGetClaimsResult>;
}

/**
 * モックの client の auth に広げる 2 つ: `auth: { getUser, ...aal2AuthMock(getUser) }` (getUser は同じ auth の getUser そのもの)。
 * getSession はいつも TEST_AAL2_ACCESS_TOKEN の session を返し (next/headers に落ちない)、
 * getClaims は getUser をもう 1 回呼んで、その user.id の aal2 の claims を返す。
 */
export function aal2AuthMock(getUser: TestGetUser): Aal2AuthMock {
  return {
    getSession: async () => ({ data: { session: { access_token: TEST_AAL2_ACCESS_TOKEN } }, error: null }),
    getClaims: async () => {
      const { data } = await getUser();
      if (!data.user) return { data: null, error: new Error(TEST_CLAIMS_NO_USER_MESSAGE) };
      return { data: { claims: aal2Claims(data.user.id) }, error: null };
    },
  };
}
