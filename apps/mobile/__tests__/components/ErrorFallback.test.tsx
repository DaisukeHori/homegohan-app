/**
 * ErrorFallback.test.tsx
 * apps/mobile/src/components/ErrorFallback.tsx のテスト (#1207)
 *
 * expo-router の ErrorBoundary に渡すエラー画面。
 *  - 再試行を出し、押すと retry を呼ぶ
 *  - 例外の文面・スタックは画面に出さない
 *  - Provider の外でも描画できる (ルートの境界は Provider ごと置き換えて描画されるため)
 *  - homeHref を渡した境界だけ「ホームへ戻る」を出す。押すと先に移動してから作り直す
 *  - 表示時に 1 回だけ記録し、記録の失敗で画面を壊さない
 */

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

// ── expo-router モック (router.replace だけ使う) ─────────────────────────────
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  router: { replace: (...args: unknown[]) => mockReplace(...args) },
}));

// ── 記録のモック ─────────────────────────────────────────────────────────────
const mockReport = jest.fn();
jest.mock('../../src/lib/error-report', () => ({
  reportBoundaryError: (...args: unknown[]) => mockReport(...args),
}));

import { ErrorFallback } from '../../src/components/ErrorFallback';

const SECRET_MESSAGE = 'relation "user_profiles" does not exist; password=hunter2';

function makeError() {
  const error = new Error(SECRET_MESSAGE);
  error.name = 'TypeError';
  error.stack = 'TypeError: SECRET-STACK-FRAME\n    at secretFunction (/var/task/secret.js:1:1)';
  return error;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ErrorFallback', () => {
  it('見出し・説明・再試行ボタンを出す (Provider なしで描画できる)', () => {
    const { getByText, getByTestId } = render(
      <ErrorFallback error={makeError()} retry={jest.fn()} boundary="tabs" />,
    );

    expect(getByTestId('error-fallback')).toBeTruthy();
    expect(getByText('エラーが発生しました')).toBeTruthy();
    expect(getByText(/もう一度お試しください/)).toBeTruthy();
    expect(getByTestId('error-fallback-retry')).toBeTruthy();
    expect(getByText('再試行')).toBeTruthy();
  });

  it('直らないときの案内 (アプリを終了して開き直す) を出す', () => {
    const { getByText } = render(<ErrorFallback error={makeError()} retry={jest.fn()} boundary="root" />);

    expect(getByText(/アプリを一度終了して開き直してください/)).toBeTruthy();
  });

  it('例外の文面・スタックは画面に出さない', () => {
    const { toJSON } = render(<ErrorFallback error={makeError()} retry={jest.fn()} boundary="tabs" />);

    const rendered = JSON.stringify(toJSON());
    expect(rendered).not.toContain('user_profiles');
    expect(rendered).not.toContain('hunter2');
    expect(rendered).not.toContain('SECRET-STACK-FRAME');
    expect(rendered).not.toContain('secretFunction');
    expect(rendered).not.toContain('TypeError');
  });

  it('「再試行」を押すと retry を呼ぶ', () => {
    const retry = jest.fn().mockResolvedValue(undefined);
    const { getByTestId } = render(<ErrorFallback error={makeError()} retry={retry} boundary="tabs" />);

    fireEvent.press(getByTestId('error-fallback-retry'));

    expect(retry).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('retry が同期的に例外を投げても、拒否されても、画面は壊れない', async () => {
    const throwing = jest.fn(() => {
      throw new Error('retry exploded');
    });
    const first = render(<ErrorFallback error={makeError()} retry={throwing} boundary="tabs" />);
    expect(() => fireEvent.press(first.getByTestId('error-fallback-retry'))).not.toThrow();

    const rejecting = jest.fn().mockRejectedValue(new Error('retry rejected'));
    const second = render(<ErrorFallback error={makeError()} retry={rejecting} boundary="tabs" />);
    expect(() => fireEvent.press(second.getByTestId('error-fallback-retry'))).not.toThrow();
    // 拒否が未処理のまま残らない (unhandled rejection でテストが落ちない)
    await new Promise((resolve) => setImmediate(resolve));
  });

  describe('ホームへ戻る (homeHref を渡した境界だけ)', () => {
    it('homeHref が無ければ出さない', () => {
      const { queryByTestId } = render(<ErrorFallback error={makeError()} retry={jest.fn()} boundary="root" />);

      expect(queryByTestId('error-fallback-home')).toBeNull();
    });

    it('homeHref があれば出し、押すと区画の外へ移動する (移動すれば境界ごと外れるので、作り直しは呼ばない)', () => {
      const retry = jest.fn().mockResolvedValue(undefined);
      const { getByTestId, getByText } = render(
        <ErrorFallback error={makeError()} retry={retry} boundary="org" homeHref="/(tabs)/home" />,
      );

      expect(getByText('ホームへ戻る')).toBeTruthy();
      fireEvent.press(getByTestId('error-fallback-home'));

      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith('/(tabs)/home');
      // 作り直すと、同じ画面がまた例外を投げて、重複して記録される
      expect(retry).not.toHaveBeenCalled();
    });

    it('文言を差し替えられる', () => {
      const { getByText } = render(
        <ErrorFallback error={makeError()} retry={jest.fn()} boundary="auth" homeHref="/" homeLabel="最初の画面へ戻る" />,
      );

      expect(getByText('最初の画面へ戻る')).toBeTruthy();
    });

    it('ナビゲーションが使えず移動に失敗したときは、作り直しだけでも試す', () => {
      mockReplace.mockImplementation(() => {
        throw new Error('Attempted to navigate before mounting the Root Layout component.');
      });
      const retry = jest.fn().mockResolvedValue(undefined);
      const { getByTestId } = render(
        <ErrorFallback error={makeError()} retry={retry} boundary="org" homeHref="/(tabs)/home" />,
      );

      expect(() => fireEvent.press(getByTestId('error-fallback-home'))).not.toThrow();
      expect(retry).toHaveBeenCalledTimes(1);
    });
  });

  describe('記録', () => {
    it('表示時に 1 回だけ、boundary 名と例外を渡して記録する', () => {
      const error = makeError();

      const { rerender } = render(<ErrorFallback error={error} retry={jest.fn()} boundary="org" />);
      rerender(<ErrorFallback error={error} retry={jest.fn()} boundary="org" />);

      expect(mockReport).toHaveBeenCalledTimes(1);
      expect(mockReport).toHaveBeenCalledWith('org', error);
    });

    it('別の例外に変わったら、その分も記録する', () => {
      const { rerender } = render(<ErrorFallback error={makeError()} retry={jest.fn()} boundary="org" />);
      rerender(<ErrorFallback error={makeError()} retry={jest.fn()} boundary="org" />);

      expect(mockReport).toHaveBeenCalledTimes(2);
    });
  });
});
