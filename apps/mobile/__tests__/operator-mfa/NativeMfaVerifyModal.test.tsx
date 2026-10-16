/**
 * NativeMfaVerifyModal.test.tsx
 * apps/mobile/src/components/NativeMfaVerifyModal.tsx のテスト (#1707 段 D。docs/design/cross/12-operator-mfa.md §16.4.5・§21.6)
 *
 * WebView から頼まれた確認 (mfa-verify-required) で出すネイティブの確認画面。
 * resolveSessionMfaGate の結果で描き分ける: allow → 6 桁を求めずに onVerified / verify → MfaVerifyGate /
 * enroll_on_web → ブラウザでの登録の案内 / OperatorMfaGateError → 再試行。[閉じる] で onClose。
 */
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

const mockResolveSessionMfaGate = jest.fn();

jest.mock('../../src/lib/operator-mfa', () => {
  class OperatorMfaGateError extends Error {
    constructor() {
      super('二段階認証の状態を確認できませんでした。');
      this.name = 'OperatorMfaGateError';
    }
  }
  return {
    OperatorMfaGateError,
    resolveSessionMfaGate: (...args: unknown[]) => mockResolveSessionMfaGate(...args),
  };
});

// MfaVerifyGate は自分のテスト (MfaVerifyGate.test.tsx) で確かめる。ここでは onVerified をつないでいることだけを見る
jest.mock('../../src/components/MfaVerifyGate', () => {
  const { Pressable, Text, View } = require('react-native');
  return {
    MfaVerifyGate: ({ onVerified }: { onVerified: () => void }) => (
      <View testID="mock-mfa-verify-gate">
        <Pressable testID="mock-mfa-verify-gate-verified" onPress={() => onVerified()}>
          <Text>verified</Text>
        </Pressable>
      </View>
    ),
  };
});

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { NATIVE_MFA_VERIFY_GATE_ERROR_MESSAGE, NativeMfaVerifyModal } from '../../src/components/NativeMfaVerifyModal';
import { OperatorMfaGateError } from '../../src/lib/operator-mfa';
import { MOBILE_MFA_ENROLL_ON_WEB_MESSAGE } from '../../src/lib/mfa-gate';

function renderModal() {
  const onVerified = jest.fn();
  const onClose = jest.fn();
  const utils = render(<NativeMfaVerifyModal onVerified={onVerified} onClose={onClose} />);
  return { ...utils, onVerified, onClose };
}

beforeEach(() => {
  mockResolveSessionMfaGate.mockReset();
});

describe('NativeMfaVerifyModal', () => {
  it('判定の間は読み込み中を出す', async () => {
    mockResolveSessionMfaGate.mockReturnValue(new Promise(() => undefined));
    const { getByTestId, queryByTestId } = renderModal();

    expect(getByTestId('native-mfa-verify-modal')).toBeTruthy();
    expect(getByTestId('native-mfa-verify-loading')).toBeTruthy();
    expect(queryByTestId('mock-mfa-verify-gate')).toBeNull();
  });

  it('resolveSessionMfaGate が allow なら 6 桁を求めずに onVerified を 1 回', async () => {
    mockResolveSessionMfaGate.mockResolvedValue('allow');
    const { queryByTestId, onVerified, onClose } = renderModal();

    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    expect(queryByTestId('mock-mfa-verify-gate')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(mockResolveSessionMfaGate).toHaveBeenCalledTimes(1);
  });

  it('verify なら MfaVerifyGate を出し、その onVerified で onVerified', async () => {
    mockResolveSessionMfaGate.mockResolvedValue('verify');
    const { getByTestId, onVerified } = renderModal();

    await waitFor(() => expect(getByTestId('mock-mfa-verify-gate')).toBeTruthy());
    expect(onVerified).not.toHaveBeenCalled();

    fireEvent.press(getByTestId('mock-mfa-verify-gate-verified'));
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it('enroll_on_web ならブラウザでの登録を案内し、6 桁の入力を出さない', async () => {
    mockResolveSessionMfaGate.mockResolvedValue('enroll_on_web');
    const { getByTestId, queryByTestId, onVerified } = renderModal();

    await waitFor(() =>
      expect(getByTestId('native-mfa-verify-enroll-on-web')).toHaveTextContent(MOBILE_MFA_ENROLL_ON_WEB_MESSAGE),
    );
    expect(queryByTestId('mock-mfa-verify-gate')).toBeNull();
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('OperatorMfaGateError なら案内と再試行を出し、再試行で判定し直す', async () => {
    mockResolveSessionMfaGate.mockRejectedValueOnce(new OperatorMfaGateError()).mockResolvedValueOnce('verify');
    const { getByTestId, queryByTestId, onVerified } = renderModal();

    await waitFor(() =>
      expect(getByTestId('native-mfa-verify-error')).toHaveTextContent(NATIVE_MFA_VERIFY_GATE_ERROR_MESSAGE),
    );
    expect(queryByTestId('mock-mfa-verify-gate')).toBeNull();
    expect(onVerified).not.toHaveBeenCalled();

    fireEvent.press(getByTestId('native-mfa-verify-retry'));

    await waitFor(() => expect(getByTestId('mock-mfa-verify-gate')).toBeTruthy());
    expect(queryByTestId('native-mfa-verify-error')).toBeNull();
    expect(mockResolveSessionMfaGate).toHaveBeenCalledTimes(2);
  });

  it('[閉じる] で onClose (onVerified は呼ばない)', async () => {
    mockResolveSessionMfaGate.mockResolvedValue('verify');
    const { getByTestId, onClose, onVerified } = renderModal();
    await waitFor(() => expect(getByTestId('mock-mfa-verify-gate')).toBeTruthy());

    fireEvent.press(getByTestId('native-mfa-verify-close'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('閉じた後 (アンマウントの後) に判定が返っても onVerified を呼ばない', async () => {
    let resolveGate: (value: string) => void = () => undefined;
    mockResolveSessionMfaGate.mockReturnValue(
      new Promise((resolve) => {
        resolveGate = resolve;
      }),
    );
    const { unmount, onVerified } = renderModal();
    unmount();

    resolveGate('allow');
    await Promise.resolve();
    await Promise.resolve();

    expect(onVerified).not.toHaveBeenCalled();
  });
});
