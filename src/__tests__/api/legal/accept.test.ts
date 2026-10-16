/**
 * POST /api/legal/accept (#1174) のユニットテスト
 *
 * 確認すること:
 *   - 未ログインは 401。DB 関数 (accept_legal_documents) を呼ばない
 *   - body が壊れている・版が無い・長すぎる・巨大 のときは 400
 *   - 版が、いま有効な版 (LEGAL_DOCUMENTS) と違うときは 409 で、いま有効な版を返す (古い画面で読んでいない版に同意させない)
 *   - 成功すると、本人のセッションで DB 関数を呼ぶ。引数は版 2 つ + サーバーが受け取ったリクエストの IP / user_agent だけで、
 *     利用者の ID を渡す引数は無い (他人の行は書けない)
 *   - IP が読めないときは null (DB の inet 型に不正な文字列を渡さない)
 *   - DB のエラーは 500 の汎用メッセージにし、DB の生のエラー文は応答に出さない (元のエラーは構造化ログに残す。#1172)
 *   - #1173 (設計書 cross/14 T-A1〜T-A5): body の birth_date (形は YYYY-MM-DD) を p_birth_date で渡す。暦に無い日・未来・120 年超は
 *     400 LEGAL_BIRTH_DATE_INVALID (版の 409 の後・RPC の前)。関数の LEGAL_MINOR_SELF_SIGNUP_REFUSED は 403、
 *     LEGAL_BIRTH_DATE_REQUIRED / INVALID は 400 (DB の生の文は出さない)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LEGAL_CONSENT_BIRTH_DATE_COPY, LEGAL_DOCUMENTS } from '@homegohan/shared';

const mockGetUser = vi.fn();
const mockRpc = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser },
    rpc: mockRpc,
  }),
}));

const mockUserInfo = vi.fn();
const mockUserError = vi.fn();
const mockRootError = vi.fn();
vi.mock('@/lib/db-logger', () => ({
  generateRequestId: () => 'req_test',
  createLogger: () => ({
    error: mockRootError,
    withUser: () => ({ info: mockUserInfo, error: mockUserError }),
  }),
}));

const { POST } = await import('@/app/api/legal/accept/route');

const CURRENT = {
  terms_version: LEGAL_DOCUMENTS.terms_of_service.version,
  privacy_version: LEGAL_DOCUMENTS.privacy_policy.version,
};
const USER = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' };

function makeRequest(body: unknown, headers: Record<string, string> = {}, rawBody?: string) {
  return new Request('http://localhost/api/legal/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: rawBody ?? JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: USER }, error: null });
  mockRpc.mockResolvedValue({
    data: {
      terms_version_accepted: CURRENT.terms_version,
      privacy_version_accepted: CURRENT.privacy_version,
      legal_accepted_at: '2026-10-08T06:00:00.000Z',
    },
    error: null,
  });
});

describe('POST /api/legal/accept: 認証', () => {
  it('未ログインは 401。DB 関数を呼ばない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await POST(makeRequest(CURRENT));

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('AUTH_UNAUTHENTICATED');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('認証基盤がエラーを返したときも 401。DB 関数を呼ばない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid JWT' } });

    const res = await POST(makeRequest(CURRENT));

    expect(res.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('POST /api/legal/accept: 入力の検証', () => {
  it.each([
    ['JSON でない body', undefined, 'not json'],
    ['空の body', undefined, ''],
    ['配列', [CURRENT.terms_version, CURRENT.privacy_version], undefined],
    ['版が無い (利用規約)', { privacy_version: CURRENT.privacy_version }, undefined],
    ['版が無い (プライバシーポリシー)', { terms_version: CURRENT.terms_version }, undefined],
    ['版が空文字', { terms_version: '', privacy_version: CURRENT.privacy_version }, undefined],
    ['版が文字列でない', { terms_version: 20251, privacy_version: CURRENT.privacy_version }, undefined],
    ['版が null', { terms_version: null, privacy_version: CURRENT.privacy_version }, undefined],
    ['版が 21 文字', { terms_version: 'x'.repeat(21), privacy_version: CURRENT.privacy_version }, undefined],
    ['巨大な body', { terms_version: CURRENT.terms_version, privacy_version: CURRENT.privacy_version, pad: 'x'.repeat(2000) }, undefined],
  ])('%s は 400。DB 関数を呼ばない', async (_name, body, rawBody) => {
    const res = await POST(makeRequest(body, {}, rawBody));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('LEGAL_BAD_REQUEST');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['text/plain (他のサイトのフォームがプリフライトなしで送れる形)', 'text/plain'],
    ['application/x-www-form-urlencoded', 'application/x-www-form-urlencoded'],
    ['Content-Type が空', ''],
  ])('★Content-Type が %s のときは 415。DB 関数を呼ばない (他のサイトから証跡を作らせない)', async (_name, contentType) => {
    const res = await POST(makeRequest(CURRENT, { 'Content-Type': contentType }));

    expect(res.status).toBe(415);
    expect((await res.json()).error.code).toBe('LEGAL_UNSUPPORTED_MEDIA_TYPE');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('Content-Type に charset が付いていても (application/json; charset=utf-8) 受け付ける', async () => {
    const res = await POST(makeRequest(CURRENT, { 'Content-Type': 'application/json; charset=utf-8' }));

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('未ログインなら、body が壊れていても先に 401 (入力の検証結果を未ログインに見せない)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await POST(makeRequest(undefined, {}, 'not json'));

    expect(res.status).toBe(401);
  });

  it('余計なキー (利用者の ID など) は無視され、DB 関数には渡らない', async () => {
    const res = await POST(makeRequest({ ...CURRENT, user_id: 'someone-else', p_user_id: 'someone-else' }));

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(Object.keys(mockRpc.mock.calls[0][1]).sort()).toEqual([
      'p_birth_date',
      'p_ip',
      'p_privacy_version',
      'p_terms_version',
      'p_user_agent',
    ]);
  });
});

describe('POST /api/legal/accept: いま有効な版との照合', () => {
  it.each([
    ['利用規約が古い版', { terms_version: 'v0-old', privacy_version: CURRENT.privacy_version }],
    ['プライバシーポリシーが古い版', { terms_version: CURRENT.terms_version, privacy_version: 'v0-old' }],
    ['両方古い版', { terms_version: 'v0-old', privacy_version: 'v0-old' }],
    ['2 文書の版を取り違えた', { terms_version: CURRENT.terms_version + 'x', privacy_version: CURRENT.privacy_version + 'x' }],
  ])('%s は 409。いま有効な版を返し、DB 関数を呼ばない', async (_name, body) => {
    const res = await POST(makeRequest(body));

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe('LEGAL_VERSION_MISMATCH');
    expect(json.current).toEqual(CURRENT);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('POST /api/legal/accept: 同意の記録', () => {
  it('★本人のセッションで DB 関数を呼ぶ。引数は版 2 つと、サーバーが受け取ったリクエストの IP / user_agent', async () => {
    const res = await POST(
      makeRequest(CURRENT, {
        'x-forwarded-for': '203.0.113.7, 10.0.0.1',
        'user-agent': 'Mozilla/5.0 (test)',
      }),
    );

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('accept_legal_documents', {
      p_terms_version: CURRENT.terms_version,
      p_privacy_version: CURRENT.privacy_version,
      p_ip: '203.0.113.7',
      p_user_agent: 'Mozilla/5.0 (test)',
      p_birth_date: null,
    });
    const json = await res.json();
    expect(json).toEqual({
      accepted: true,
      terms_version_accepted: CURRENT.terms_version,
      privacy_version_accepted: CURRENT.privacy_version,
      legal_accepted_at: '2026-10-08T06:00:00.000Z',
      birth_date: null,
    });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('クライアントが body で IP・user_agent を送ってきても使わない (サーバーが受け取った値だけを証跡にする)', async () => {
    const res = await POST(
      makeRequest(
        { ...CURRENT, ip: '198.51.100.99', user_agent: 'forged', p_ip: '198.51.100.99', p_user_agent: 'forged' },
        { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'real-agent' },
      ),
    );

    expect(res.status).toBe(200);
    const args = mockRpc.mock.calls[0][1];
    expect(args.p_ip).toBe('203.0.113.7');
    expect(args.p_user_agent).toBe('real-agent');
  });

  it('IP が読めない (ヘッダー無し・ポート付き・ゾーン ID 付き・ゴミ) ときは null。記録は止めない', async () => {
    const unreadable: Array<Record<string, string>> = [
      {},
      { 'x-forwarded-for': 'unknown' },
      { 'x-forwarded-for': '203.0.113.7:8080' },
      // IPv6 のゾーン ID は Node の isIP は通すが、DB の inet は受け付けない (渡すと関数がエラーになり、同意を記録できなくなる)
      { 'x-forwarded-for': 'fe80::1%eth0' },
      { 'x-forwarded-for': "1'; drop table x;--" },
    ];
    for (const headers of unreadable) {
      mockRpc.mockClear();
      const res = await POST(makeRequest(CURRENT, headers));
      expect(res.status).toBe(200);
      expect(mockRpc.mock.calls[0][1].p_ip).toBeNull();
    }
  });

  it('x-forwarded-for が無ければ x-real-ip を使う', async () => {
    const res = await POST(makeRequest(CURRENT, { 'x-real-ip': '2001:db8::1' }));

    expect(res.status).toBe(200);
    expect(mockRpc.mock.calls[0][1].p_ip).toBe('2001:db8::1');
  });

  it('user_agent が無いときは null', async () => {
    const res = await POST(makeRequest(CURRENT, { 'user-agent': '' }));

    expect(res.status).toBe(200);
    expect(mockRpc.mock.calls[0][1].p_user_agent).toBeNull();
  });

  it('巨大な user_agent は 512 文字で切ってから渡す', async () => {
    const res = await POST(makeRequest(CURRENT, { 'user-agent': 'u'.repeat(5000) }));

    expect(res.status).toBe(200);
    expect(mockRpc.mock.calls[0][1].p_user_agent).toBe('u'.repeat(512));
  });

  it('DB 関数が結果を返さなくても (null)、送った版で応答する', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });

    const res = await POST(makeRequest(CURRENT));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      accepted: true,
      terms_version_accepted: CURRENT.terms_version,
      privacy_version_accepted: CURRENT.privacy_version,
      legal_accepted_at: null,
    });
  });

  it('成功したことをログに残す。残すのは版だけで、IP・user_agent は残さない', async () => {
    await POST(makeRequest(CURRENT, { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'real-agent' }));

    expect(mockUserInfo).toHaveBeenCalledTimes(1);
    expect(mockUserInfo).toHaveBeenCalledWith('legal documents accepted', {
      terms_version: CURRENT.terms_version,
      privacy_version: CURRENT.privacy_version,
    });
    expect(JSON.stringify(mockUserInfo.mock.calls)).not.toContain('203.0.113.7');
    expect(JSON.stringify(mockUserInfo.mock.calls)).not.toContain('real-agent');
  });
});

describe('POST /api/legal/accept: 失敗', () => {
  it('★DB 関数のエラーは、DB の生のエラー文を応答に出さず、汎用メッセージの 500 (共通ヘルパー internalError) にする。元のエラーは構造化ログに残す (#1172)', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint "secret_internal_name"', details: 'Key (user_id)=(…) already exists.' },
    });

    const res = await POST(makeRequest(CURRENT));

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました' } });
    expect(JSON.stringify(json)).not.toContain('secret_internal_name');
    expect(JSON.stringify(json)).not.toContain('duplicate key');
    expect(JSON.stringify(json)).not.toContain('23505');
    // 調べられるよう、元のエラー (文面・SQLSTATE) は、本人の ID つきの構造化ログに残る。IP・user_agent は残さない
    expect(mockUserError).toHaveBeenCalledTimes(1);
    const [, loggedError, loggedMeta] = mockUserError.mock.calls[0];
    expect((loggedError as Error).message).toContain('secret_internal_name');
    expect(loggedMeta).toEqual({ error_code: '23505', rpc: 'accept_legal_documents' });
    expect(mockUserInfo).not.toHaveBeenCalled();
  });

  it('関数が無い (migration の反映前: PGRST202) ときも 500 の汎用メッセージ', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function public.accept_legal_documents' },
    });

    const res = await POST(makeRequest(CURRENT));

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('Could not find the function');
  });

  it('想定外の例外 (認証基盤が落ちているなど) も 500 の汎用メッセージ', async () => {
    mockGetUser.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.9:5432'));

    const res = await POST(makeRequest(CURRENT));

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました' } });
    expect(JSON.stringify(json)).not.toContain('ECONNREFUSED');
    expect(mockRootError).toHaveBeenCalledTimes(1);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('エラー応答もキャッシュさせない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await POST(makeRequest(CURRENT))).headers.get('Cache-Control')).toBe('no-store');

    mockGetUser.mockResolvedValue({ data: { user: USER }, error: null });
    expect((await POST(makeRequest({ terms_version: 'v0-old', privacy_version: 'v0-old' }))).headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('POST /api/legal/accept: 生年月日 (#1173)', () => {
  /** JST 2026-10-16 12:00 に固定する (未来・121 年前・17 歳の日付を固定するため) */
  const FIXED_NOW = new Date('2026-10-16T03:00:00.000Z');
  const ADULT_BIRTH_DATE = '1990-01-01';

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('T-A1: birth_date を送ると RPC に p_birth_date が渡る。送らなければ null', async () => {
    await POST(makeRequest({ ...CURRENT, birth_date: ADULT_BIRTH_DATE }));
    expect(mockRpc.mock.calls[0][1].p_birth_date).toBe(ADULT_BIRTH_DATE);

    mockRpc.mockClear();
    await POST(makeRequest(CURRENT));
    expect(mockRpc.mock.calls[0][1].p_birth_date).toBeNull();
  });

  it.each([['abc'], ['2000/01/01'], ['20000101']])(
    'T-A2: 形が YYYY-MM-DD でない birth_date (%s) は 400 LEGAL_BAD_REQUEST。RPC を呼ばない',
    async (birthDate) => {
      const res = await POST(makeRequest({ ...CURRENT, birth_date: birthDate }));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('LEGAL_BAD_REQUEST');
      expect(mockRpc).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['暦に無い日', '2001-02-30'],
    ['未来', '2026-10-17'],
    ['121 年前', '1905-10-16'],
  ])('T-A2: %s (%s) は 400 LEGAL_BIRTH_DATE_INVALID。RPC を呼ばない', async (_name, birthDate) => {
    const res = await POST(makeRequest({ ...CURRENT, birth_date: birthDate }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'LEGAL_BIRTH_DATE_INVALID', message: LEGAL_CONSENT_BIRTH_DATE_COPY.invalid },
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('T-A2: 120 年前の同日と今日は受け付けて RPC を呼ぶ', async () => {
    for (const birthDate of ['1906-10-16', '2026-10-16']) {
      mockRpc.mockClear();
      const res = await POST(makeRequest({ ...CURRENT, birth_date: birthDate }));
      expect(res.status).toBe(200);
      expect(mockRpc.mock.calls[0][1].p_birth_date).toBe(birthDate);
    }
  });

  it('T-A3: 応答に birth_date が入る', async () => {
    mockRpc.mockResolvedValue({
      data: {
        terms_version_accepted: CURRENT.terms_version,
        privacy_version_accepted: CURRENT.privacy_version,
        legal_accepted_at: '2026-10-08T06:00:00.000Z',
        birth_date: ADULT_BIRTH_DATE,
      },
      error: null,
    });

    const res = await POST(makeRequest({ ...CURRENT, birth_date: ADULT_BIRTH_DATE }));

    expect(res.status).toBe(200);
    expect((await res.json()).birth_date).toBe(ADULT_BIRTH_DATE);
  });

  it.each([
    ['birth_date なし', {}],
    ['暦に無い日', { birth_date: '2001-02-30' }],
    ['未来', { birth_date: '2999-01-01' }],
    ['17 歳', { birth_date: '2008-10-17' }],
  ])('T-A4: 版が違うときは %s でも 409 LEGAL_VERSION_MISMATCH (版が先)。RPC を呼ばない', async (_name, extra) => {
    const res = await POST(makeRequest({ terms_version: 'v0-old', privacy_version: CURRENT.privacy_version, ...extra }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('LEGAL_VERSION_MISMATCH');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('T-A4: 版が違っても、形に合わない birth_date (2000/01/01) は 400 LEGAL_BAD_REQUEST (parse が版より先)', async () => {
    const res = await POST(makeRequest({ terms_version: 'v0-old', privacy_version: CURRENT.privacy_version, birth_date: '2000/01/01' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('LEGAL_BAD_REQUEST');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('T-A5: RPC が LEGAL_MINOR_SELF_SIGNUP_REFUSED を返したら 403 { error: { code } } で、DB の生の文を本文に出さない', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'LEGAL_MINOR_SELF_SIGNUP_REFUSED: raw db detail' },
    });

    const res = await POST(makeRequest({ ...CURRENT, birth_date: '2010-01-01' }));
    const text = await res.text();

    expect(res.status).toBe(403);
    expect(JSON.parse(text)).toEqual({
      error: { code: 'LEGAL_MINOR_SELF_SIGNUP_REFUSED', message: LEGAL_CONSENT_BIRTH_DATE_COPY.minorRefusedHeading },
    });
    expect(text).not.toContain('raw db detail');
  });

  it.each([['LEGAL_BIRTH_DATE_REQUIRED'], ['LEGAL_BIRTH_DATE_INVALID']])(
    'T-A5: RPC が %s を返したら 400 の同じ code (DB の生の文は出さない)',
    async (code) => {
      mockRpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: `${code}: raw db detail` } });

      const res = await POST(makeRequest(CURRENT));
      const text = await res.text();

      expect(res.status).toBe(400);
      expect(JSON.parse(text)).toEqual({ error: { code, message: LEGAL_CONSENT_BIRTH_DATE_COPY.invalid } });
      expect(text).not.toContain('raw db detail');
    },
  );
});
