/**
 * MfaVerifyGate.test.tsx
 * apps/mobile/src/components/MfaVerifyGate.tsx のテスト (#1707 段 D。docs/design/cross/12-operator-mfa.md §16.3・§21.6)
 *
 * listFactors の totp (verified な TOTP) の先頭に、6 桁で challengeAndVerify を呼ぶ。成功で onVerified。
 * 失敗の文言: 不一致 (mfa_verification_failed / 400 / 422)・429・それ以外。totp が空ならブラウザでの登録の案内。
 */
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

const mockListFactors = jest.fn();
const mockChallengeAndVerify = jest.fn();

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      mfa: {
        listFactors: (...args: unknown[]) => mockListFactors(...args),
        challengeAndVerify: (...args: unknown[]) => mockChallengeAndVerify(...args),
      },
    },
  },
}));

import {
  MFA_VERIFY_MISMATCH_MESSAGE,
  MFA_VERIFY_NETWORK_MESSAGE,
  MFA_VERIFY_RATE_LIMITED_MESSAGE,
  MfaVerifyGate,
  mfaVerifyErrorMessage,
} from '../../src/components/MfaVerifyGate';
import { MOBILE_MFA_ENROLL_ON_WEB_MESSAGE } from '../../src/lib/mfa-gate';

const FACTOR_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_FACTOR_ID = '22222222-2222-4222-8222-222222222222';

function factors(ids: string[]) {
  const totp = ids.map((id) => ({ id, factor_type: 'totp', status: 'verified' }));
  return { data: { all: totp, totp, phone: [] }, error: null };
}

function authError(status: number | undefined, code?: string) {
  return Object.assign(new Error('auth error'), { name: 'AuthApiError', status, code });
}

async function renderGate(onVerified: () => void | Promise<void> = jest.fn()) {
  const utils = render(<MfaVerifyGate onVerified={onVerified} />);
  await waitFor(() => expect(utils.queryByTestId('mfa-verify-loading')).toBeNull());
  return utils;
}

beforeEach(() => {
  mockListFactors.mockReset();
  mockChallengeAndVerify.mockReset();
  mockListFactors.mockResolvedValue(factors([FACTOR_ID, SECOND_FACTOR_ID]));
  mockChallengeAndVerify.mockResolvedValue({ data: { access_token: 'aal2-token' }, error: null });
});

describe('MfaVerifyGate', () => {
  it('listFactors の totp の先頭に challengeAndVerify を呼び、成功で onVerified を 1 回呼ぶ', async () => {
    const onVerified = jest.fn();
    const { getByTestId, queryByTestId } = await renderGate(onVerified);

    fireEvent.changeText(getByTestId('mfa-verify-code-input'), '123456');
    fireEvent.press(getByTestId('mfa-verify-submit'));

    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    expect(mockChallengeAndVerify).toHaveBeenCalledTimes(1);
    expect(mockChallengeAndVerify).toHaveBeenCalledWith({ factorId: FACTOR_ID, code: '123456' });
    expect(queryByTestId('mfa-verify-error')).toBeNull();
  });

  it.each([
    ['mfa_verification_failed', authError(422, 'mfa_verification_failed'), MFA_VERIFY_MISMATCH_MESSAGE],
    ['code が無い 400', authError(400), MFA_VERIFY_MISMATCH_MESSAGE],
    ['code が無い 422', authError(422), MFA_VERIFY_MISMATCH_MESSAGE],
    ['status の無い mfa_verification_failed', authError(undefined, 'mfa_verification_failed'), MFA_VERIFY_MISMATCH_MESSAGE],
    ['429', authError(429, 'over_request_rate_limit'), MFA_VERIFY_RATE_LIMITED_MESSAGE],
    ['500', authError(500), MFA_VERIFY_NETWORK_MESSAGE],
    ['status の無い失敗', authError(undefined), MFA_VERIFY_NETWORK_MESSAGE],
  ])('失敗 (%s) は文言を出し、onVerified を呼ばない', async (_label, error, message) => {
    mockChallengeAndVerify.mockResolvedValue({ data: null, error });
    const onVerified = jest.fn();
    const { getByTestId } = await renderGate(onVerified);

    fireEvent.changeText(getByTestId('mfa-verify-code-input'), '654321');
    fireEvent.press(getByTestId('mfa-verify-submit'));

    await waitFor(() => expect(getByTestId('mfa-verify-error')).toHaveTextContent(message));
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('challengeAndVerify が例外を投げたら、通信の失敗の文言', async () => {
    mockChallengeAndVerify.mockRejectedValue(new TypeError('fetch failed'));
    const onVerified = jest.fn();
    const { getByTestId } = await renderGate(onVerified);

    fireEvent.changeText(getByTestId('mfa-verify-code-input'), '123456');
    fireEvent.press(getByTestId('mfa-verify-submit'));

    await waitFor(() => expect(getByTestId('mfa-verify-error')).toHaveTextContent(MFA_VERIFY_NETWORK_MESSAGE));
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('失敗の後に打ち直して成功すれば、文言を消して onVerified', async () => {
    mockChallengeAndVerify.mockResolvedValueOnce({ data: null, error: authError(422, 'mfa_verification_failed') });
    const onVerified = jest.fn();
    const { getByTestId, queryByTestId } = await renderGate(onVerified);

    fireEvent.changeText(getByTestId('mfa-verify-code-input'), '111111');
    fireEvent.press(getByTestId('mfa-verify-submit'));
    await waitFor(() => expect(getByTestId('mfa-verify-error')).toBeTruthy());

    fireEvent.changeText(getByTestId('mfa-verify-code-input'), '222222');
    fireEvent.press(getByTestId('mfa-verify-submit'));

    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    expect(queryByTestId('mfa-verify-error')).toBeNull();
    expect(mockChallengeAndVerify).toHaveBeenLastCalledWith({ factorId: FACTOR_ID, code: '222222' });
  });

  it.each([['12345'], ['1234567'], ['12345a'], [' 12345'], ['']])(
    '6 桁の数字になるまで送信できない (%j)',
    async (value) => {
      const { getByTestId } = await renderGate();

      fireEvent.changeText(getByTestId('mfa-verify-code-input'), value);
      fireEvent.press(getByTestId('mfa-verify-submit'));

      await act(async () => {
        await Promise.resolve();
      });
      expect(mockChallengeAndVerify).not.toHaveBeenCalled();
      expect(getByTestId('mfa-verify-submit')).toBeDisabled();
    },
  );

  it('6 桁になると送信ボタンが押せる', async () => {
    const { getByTestId } = await renderGate();

    expect(getByTestId('mfa-verify-submit')).toBeDisabled();
    fireEvent.changeText(getByTestId('mfa-verify-code-input'), '123456');
    expect(getByTestId('mfa-verify-submit')).toBeEnabled();
  });

  it('送信中は二重に送らない (応答の前に何度押しても challengeAndVerify は 1 回)', async () => {
    let resolveVerify: (value: unknown) => void = () => undefined;
    mockChallengeAndVerify.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveVerify = resolve;
        }),
    );
    const onVerified = jest.fn();
    const { getByTestId } = await renderGate(onVerified);

    fireEvent.changeText(getByTestId('mfa-verify-code-input'), '123456');
    const submit = getByTestId('mfa-verify-submit');
    fireEvent.press(submit);
    fireEvent.press(submit);
    fireEvent.press(getByTestId('mfa-verify-submit'));

    expect(mockChallengeAndVerify).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveVerify({ data: {}, error: null });
    });
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    expect(mockChallengeAndVerify).toHaveBeenCalledTimes(1);
  });

  it('totp が空ならブラウザでの登録を案内し、入力欄も送信ボタンも出さない', async () => {
    mockListFactors.mockResolvedValue(factors([]));
    const { getByTestId, queryByTestId } = await renderGate();

    expect(getByTestId('mfa-verify-enroll-on-web')).toHaveTextContent(MOBILE_MFA_ENROLL_ON_WEB_MESSAGE);
    expect(queryByTestId('mfa-verify-code-input')).toBeNull();
    expect(queryByTestId('mfa-verify-submit')).toBeNull();
    expect(mockChallengeAndVerify).not.toHaveBeenCalled();
  });

  it('listFactors が失敗したら通信の失敗の文言と再試行を出し、再試行で読み直す', async () => {
    mockListFactors.mockResolvedValueOnce({ data: null, error: authError(500) });
    const { getByTestId, queryByTestId } = await renderGate();

    expect(getByTestId('mfa-verify-error')).toHaveTextContent(MFA_VERIFY_NETWORK_MESSAGE);
    expect(queryByTestId('mfa-verify-submit')).toBeNull();

    fireEvent.press(getByTestId('mfa-verify-reload'));

    await waitFor(() => expect(getByTestId('mfa-verify-code-input')).toBeTruthy());
    expect(mockListFactors).toHaveBeenCalledTimes(2);
  });

  it('listFactors が例外を投げても、通信の失敗の文言', async () => {
    mockListFactors.mockRejectedValueOnce(new TypeError('fetch failed'));
    const { getByTestId } = await renderGate();

    expect(getByTestId('mfa-verify-error')).toHaveTextContent(MFA_VERIFY_NETWORK_MESSAGE);
  });
});

describe('mfaVerifyErrorMessage', () => {
  it('code が mfa_verification_failed なら status に関わらず不一致', () => {
    expect(mfaVerifyErrorMessage({ code: 'mfa_verification_failed', status: 500 })).toBe(MFA_VERIFY_MISMATCH_MESSAGE);
  });

  it('400 / 422 は不一致・429 は回数制限・それ以外は通信の失敗', () => {
    expect(mfaVerifyErrorMessage({ status: 400 })).toBe(MFA_VERIFY_MISMATCH_MESSAGE);
    expect(mfaVerifyErrorMessage({ status: 422 })).toBe(MFA_VERIFY_MISMATCH_MESSAGE);
    expect(mfaVerifyErrorMessage({ status: 429 })).toBe(MFA_VERIFY_RATE_LIMITED_MESSAGE);
    expect(mfaVerifyErrorMessage({ status: 401 })).toBe(MFA_VERIFY_NETWORK_MESSAGE);
    expect(mfaVerifyErrorMessage({ status: '422' })).toBe(MFA_VERIFY_NETWORK_MESSAGE);
    expect(mfaVerifyErrorMessage(null)).toBe(MFA_VERIFY_NETWORK_MESSAGE);
  });
});
