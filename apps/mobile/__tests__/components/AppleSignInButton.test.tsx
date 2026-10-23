/**
 * AppleSignInButton.test.tsx
 * apps/mobile/src/components/auth/AppleSignInButton.tsx (docs/design/mobile/08-sign-in-with-apple.md §10.1・§14.1)
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react-native';

// ---- Mocks (before any component imports) ----

// 受けた props を残し、押せる host の要素を返す (testID で押す。高さは mockAppleButtonProps.at(-1).style.height で読む)
const mockAppleButtonProps: Array<{ buttonType: string; buttonStyle: string; cornerRadius: number; style: { width: string; height: number }; onPress: () => void }> = [];
const mockIsAvailableAsync = jest.fn();
jest.mock('expo-apple-authentication', () => {
  const ReactActual = require('react');
  const { Pressable } = require('react-native');
  return {
    isAvailableAsync: (...args: any[]) => mockIsAvailableAsync(...args),
    signInAsync: jest.fn(),
    AppleAuthenticationButton: (props: (typeof mockAppleButtonProps)[number]) => {
      mockAppleButtonProps.push(props);
      return ReactActual.createElement(Pressable, { testID: 'apple-authentication-button', style: props.style, onPress: props.onPress });
    },
    AppleAuthenticationButtonType: { SIGN_IN: 'SIGN_IN', CONTINUE: 'CONTINUE', SIGN_UP: 'SIGN_UP' },
    AppleAuthenticationButtonStyle: { WHITE: 'WHITE', WHITE_OUTLINE: 'WHITE_OUTLINE', BLACK: 'BLACK' },
    AppleAuthenticationScope: { FULL_NAME: 'FULL_NAME', EMAIL: 'EMAIL' },
  };
});

jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn(() => 'raw-nonce'),
  digestStringAsync: jest.fn(async () => 'hashed-nonce'),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));

jest.mock('../../src/lib/supabase', () => ({ supabase: { auth: {} } }));
jest.mock('../../src/lib/api', () => ({ getApi: () => ({ post: jest.fn() }) }));

// theme mock (radius.lg を見張る)
jest.mock('../../src/theme', () => ({
  radius: { lg: 12 },
}));

// ---- Component import (after mocks) ----
import {
  AppleSignInButton,
  AUTH_PROVIDER_BUTTON_MIN_HEIGHT,
  useAuthProviderButtonHeight,
} from '../../src/components/auth/AppleSignInButton';

const originalFlag = process.env.EXPO_PUBLIC_APPLE_SIGN_IN;

function layoutEvent(height: number) {
  return { nativeEvent: { layout: { x: 0, y: 0, width: 320, height } } } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAppleButtonProps.length = 0;
  process.env.EXPO_PUBLIC_APPLE_SIGN_IN = 'on';
  mockIsAvailableAsync.mockResolvedValue(true);
});

afterEach(() => {
  if (originalFlag === undefined) delete process.env.EXPO_PUBLIC_APPLE_SIGN_IN;
  else process.env.EXPO_PUBLIC_APPLE_SIGN_IN = originalFlag;
});

describe('AppleSignInButton', () => {
  it.each([
    ['sign_in', 'SIGN_IN'],
    ['sign_up', 'SIGN_UP'],
  ] as const)('isAppleSignInAvailable が true なら AppleAuthenticationButton を描く (%s → %s・WHITE_OUTLINE・cornerRadius は radius.lg・幅 100%・高さは props の height)', async (kind, buttonType) => {
    const { findByTestId } = render(
      <AppleSignInButton kind={kind} onPress={jest.fn()} disabled={false} testID="x-apple-button" height={70} />,
    );

    expect(await findByTestId('x-apple-button')).toBeTruthy();
    const props = mockAppleButtonProps[mockAppleButtonProps.length - 1];
    expect(props.buttonType).toBe(buttonType);
    expect(props.buttonStyle).toBe('WHITE_OUTLINE');
    expect(props.cornerRadius).toBe(12);
    expect(props.style).toEqual({ width: '100%', height: 70 });
  });

  it('押すと onPress を呼ぶ', async () => {
    const onPress = jest.fn();
    const { findByTestId } = render(<AppleSignInButton kind="sign_in" onPress={onPress} disabled={false} testID="x-apple-button" height={56} />);

    fireEvent.press(await findByTestId('apple-authentication-button'));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('isAppleSignInAvailable が false (端末が対応していない) なら何も描かない', async () => {
    mockIsAvailableAsync.mockResolvedValue(false);
    const { queryByTestId } = render(<AppleSignInButton kind="sign_in" onPress={jest.fn()} disabled={false} testID="x-apple-button" height={56} />);

    await waitFor(() => expect(mockIsAvailableAsync).toHaveBeenCalled());
    expect(queryByTestId('x-apple-button')).toBeNull();
    expect(queryByTestId('apple-authentication-button')).toBeNull();
    expect(mockAppleButtonProps).toHaveLength(0);
  });

  it('スイッチが on でなければ何も描かない (端末の対応も見に行かない)', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN = '';
    const { queryByTestId } = render(<AppleSignInButton kind="sign_in" onPress={jest.fn()} disabled={false} testID="x-apple-button" height={56} />);

    await act(async () => {});
    expect(queryByTestId('x-apple-button')).toBeNull();
    expect(mockIsAvailableAsync).not.toHaveBeenCalled();
  });

  it('disabled のとき押せない (pointerEvents none・薄くする)', async () => {
    const { findByTestId } = render(<AppleSignInButton kind="sign_in" onPress={jest.fn()} disabled testID="x-apple-button" height={56} />);

    const wrapper = await findByTestId('x-apple-button');
    expect(wrapper.props.pointerEvents).toBe('none');
    expect(StyleSheet.flatten(wrapper.props.style).opacity).toBe(0.7);
  });

  it('disabled でなければ押せる (pointerEvents auto・薄くしない)', async () => {
    const { findByTestId } = render(<AppleSignInButton kind="sign_in" onPress={jest.fn()} disabled={false} testID="x-apple-button" height={56} />);

    const wrapper = await findByTestId('x-apple-button');
    expect(wrapper.props.pointerEvents).toBe('auto');
    expect(StyleSheet.flatten(wrapper.props.style).opacity).toBe(1);
  });

  it('描く前に外されても、終わった確認で state を更新しない (警告を出さない)', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let resolveAvailable: (value: boolean) => void = () => {};
    mockIsAvailableAsync.mockReturnValue(new Promise<boolean>((resolve) => { resolveAvailable = resolve; }));
    const { unmount } = render(<AppleSignInButton kind="sign_in" onPress={jest.fn()} disabled={false} testID="x-apple-button" height={56} />);

    unmount();
    await act(async () => { resolveAvailable(true); });

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('useAuthProviderButtonHeight', () => {
  it('AUTH_PROVIDER_BUTTON_MIN_HEIGHT は 56', () => {
    expect(AUTH_PROVIDER_BUTTON_MIN_HEIGHT).toBe(56);
  });

  it('初めの height は AUTH_PROVIDER_BUTTON_MIN_HEIGHT (56)', () => {
    const { result } = renderHook(() => useAuthProviderButtonHeight());
    expect(result.current.height).toBe(AUTH_PROVIDER_BUTTON_MIN_HEIGHT);
  });

  it('Google の onLayout の高さが AUTH_PROVIDER_BUTTON_MIN_HEIGHT より大きければその高さ、以下なら AUTH_PROVIDER_BUTTON_MIN_HEIGHT (大きくしたあと標準に戻しても下限に戻る。S-33)', () => {
    const { result } = renderHook(() => useAuthProviderButtonHeight());

    act(() => result.current.onGoogleButtonLayout(layoutEvent(70)));
    expect(result.current.height).toBe(70);

    // 標準の高さ (下限と同じ) に戻る
    act(() => result.current.onGoogleButtonLayout(layoutEvent(AUTH_PROVIDER_BUTTON_MIN_HEIGHT)));
    expect(result.current.height).toBe(AUTH_PROVIDER_BUTTON_MIN_HEIGHT);

    // 下限より低い測定値 (文字を小さくした・測りはじめの値) は下限のまま
    act(() => result.current.onGoogleButtonLayout(layoutEvent(70)));
    act(() => result.current.onGoogleButtonLayout(layoutEvent(40)));
    expect(result.current.height).toBe(AUTH_PROVIDER_BUTTON_MIN_HEIGHT);
  });
});
