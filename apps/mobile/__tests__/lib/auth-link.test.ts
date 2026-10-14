/**
 * auth-link.test.ts
 * apps/mobile/src/lib/authLink.ts のテスト (#1038 F7-08)
 *
 * Supabase の認証リンク (code / token_hash+type / access_token+refresh_token / error) を処理してセッションにする。
 * Google ログイン (login.tsx) とメールのリンク (verify.tsx) が共通で使う。
 */

const mockExchangeCodeForSession = jest.fn();
const mockVerifyOtp = jest.fn();
const mockSetSession = jest.fn();

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      exchangeCodeForSession: (...args: unknown[]) => mockExchangeCodeForSession(...args),
      verifyOtp: (...args: unknown[]) => mockVerifyOtp(...args),
      setSession: (...args: unknown[]) => mockSetSession(...args),
    },
  },
}));

import { completeAuthLink, resetAuthLinkResultsForTests } from '../../src/lib/authLink';
import { extractSupabaseLinkParams } from '../../src/lib/deeplink';

beforeEach(() => {
  jest.clearAllMocks();
  resetAuthLinkResultsForTests();
  mockExchangeCodeForSession.mockResolvedValue({ error: null });
  mockVerifyOtp.mockResolvedValue({ error: null });
  mockSetSession.mockResolvedValue({ error: null });
});

describe('completeAuthLink — リンクの種類ごとの処理', () => {
  it('code (PKCE / OAuth): exchangeCodeForSession で交換する', async () => {
    const outcome = await completeAuthLink({ code: 'abc123' });

    expect(outcome).toEqual({ status: 'signed_in' });
    expect(mockExchangeCodeForSession).toHaveBeenCalledWith('abc123');
    expect(mockVerifyOtp).not.toHaveBeenCalled();
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it('token_hash + type (OTP): verifyOtp で確認する', async () => {
    const outcome = await completeAuthLink({ token_hash: 'hash123', type: 'signup' });

    expect(outcome).toEqual({ status: 'signed_in' });
    expect(mockVerifyOtp).toHaveBeenCalledWith({ token_hash: 'hash123', type: 'signup' });
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('access_token + refresh_token (旧形式のフラグメント): setSession で設定する', async () => {
    const outcome = await completeAuthLink({ access_token: 'at', refresh_token: 'rt' });

    expect(outcome).toEqual({ status: 'signed_in' });
    expect(mockSetSession).toHaveBeenCalledWith({ access_token: 'at', refresh_token: 'rt' });
  });

  it('iOS の Google ログインが result.url で返す実際の URL (PKCE の ?code=...) から、そのままセッションにできる', async () => {
    const params = extractSupabaseLinkParams('homegohan:///auth/verify?code=pkce-code-1');

    expect(await completeAuthLink(params)).toEqual({ status: 'signed_in' });
    expect(mockExchangeCodeForSession).toHaveBeenCalledWith('pkce-code-1');
  });

  it('implicit フローの #access_token=...&refresh_token=... も処理できる', async () => {
    const params = extractSupabaseLinkParams('homegohan:///auth/verify#access_token=at-1&refresh_token=rt-1&token_type=bearer');

    expect(await completeAuthLink(params)).toEqual({ status: 'signed_in' });
    expect(mockSetSession).toHaveBeenCalledWith({ access_token: 'at-1', refresh_token: 'rt-1' });
  });
});

describe('completeAuthLink — 失敗・情報なし', () => {
  it('リンクが error を運んできたら、Supabase を呼ばずに link_error (説明があればそれを使う)', async () => {
    expect(await completeAuthLink({ error: 'access_denied', error_description: 'Token expired' })).toEqual({
      status: 'link_error',
      message: 'Token expired',
    });
    expect(await completeAuthLink({ error: 'access_denied' })).toEqual({ status: 'link_error', message: 'access_denied' });
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    expect(mockVerifyOtp).not.toHaveBeenCalled();
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it('処理できる情報が無ければ empty (誤って成功扱いにしない)', async () => {
    expect(await completeAuthLink(null)).toEqual({ status: 'empty' });
    expect(await completeAuthLink(undefined)).toEqual({ status: 'empty' });
    expect(await completeAuthLink({})).toEqual({ status: 'empty' });
    // 片方だけでは足りない
    expect(await completeAuthLink({ token_hash: 'hash-only' })).toEqual({ status: 'empty' });
    expect(await completeAuthLink({ access_token: 'at-only' })).toEqual({ status: 'empty' });
    expect(await completeAuthLink(extractSupabaseLinkParams('homegohan:///auth/verify'))).toEqual({ status: 'empty' });
  });

  it('交換に失敗したら failed (Supabase のメッセージをそのまま返す)', async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: new Error('invalid flow state, no valid flow state found') });

    expect(await completeAuthLink({ code: 'bad' })).toEqual({
      status: 'failed',
      message: 'invalid flow state, no valid flow state found',
    });
  });

  it('例外でも failed。メッセージが無ければ既定の文言', async () => {
    mockVerifyOtp.mockRejectedValue(new Error(''));

    expect(await completeAuthLink({ token_hash: 'h', type: 'email' })).toEqual({
      status: 'failed',
      message: '確認に失敗しました。',
    });
  });
});

describe('completeAuthLink — 同じリンクは 1 回だけ処理する', () => {
  it('Android では同じコールバック URL が result.url とディープリンクの両方で届く。code は 1 回しか交換できないので、同時に呼ばれても 1 回にする', async () => {
    let resolveExchange: (value: { error: null }) => void = () => {};
    mockExchangeCodeForSession.mockReturnValue(new Promise((resolve) => (resolveExchange = resolve)));

    const fromLogin = completeAuthLink({ code: 'shared-code' });
    const fromVerify = completeAuthLink({ code: 'shared-code' });
    resolveExchange({ error: null });

    await expect(fromLogin).resolves.toEqual({ status: 'signed_in' });
    await expect(fromVerify).resolves.toEqual({ status: 'signed_in' });
    expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(1);
  });

  it('処理が終わった後に同じリンクが届いても、再交換せず結果を返す (2 回目に「確認失敗」と出さない)', async () => {
    await completeAuthLink({ code: 'once' });
    // 2 回目に呼んでいたら失敗する状況にしておく
    mockExchangeCodeForSession.mockResolvedValue({ error: new Error('code already used') });

    expect(await completeAuthLink({ code: 'once' })).toEqual({ status: 'signed_in' });
    expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(1);
  });

  it('別のリンクは別々に処理する', async () => {
    await completeAuthLink({ code: 'first' });
    await completeAuthLink({ code: 'second' });

    expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(2);
  });

  it('失敗の結果も共有する (失敗した code を繰り返し送らない)', async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: new Error('expired') });

    const first = await completeAuthLink({ code: 'broken' });
    const second = await completeAuthLink({ code: 'broken' });

    expect(first).toEqual({ status: 'failed', message: 'expired' });
    expect(second).toEqual(first);
    expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(1);
  });

  it('60 秒を過ぎた古い結果は使わない (同じ code でも、新しいリンクとして処理し直す)', async () => {
    const realNow = Date.now;
    let now = 1_700_000_000_000;
    Date.now = () => now;
    try {
      await completeAuthLink({ code: 'old' });
      now += 61_000;
      await completeAuthLink({ code: 'old' });
    } finally {
      Date.now = realNow;
    }

    expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(2);
  });
});
