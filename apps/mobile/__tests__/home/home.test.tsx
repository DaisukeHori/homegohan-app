/**
 * home.test.tsx
 * ホームのタブ (apps/mobile/app/(tabs)/home.tsx) のユニットテスト
 *
 * アプリのホームは Web の画面 (/home) の WebView。ホームの表示 (買い物リストのカード・栄養の提案など) は
 * Web の画面 (src/app/(main)/home/page.tsx と src/hooks/useHomeData.ts) が受け持ち、アプリはネイティブで描かない。
 *
 * テスト対象:
 *  - ホームのタブが WebViewScreen で Web の /home を開く
 *  - ISO date による「今日」判定の境界 (00:00:00 / 23:59:59)
 */

import React from 'react';
import { render } from '@testing-library/react-native';

// ── WebViewScreen のモック ────────────────────────────────────────────────────
// WebViewScreen はセッションの取得や WebView を持つので、受け取った props を記録し、testID だけを描く
const mockWebViewScreenProps: Array<Record<string, unknown>> = [];
jest.mock('../../src/components/web/WebViewScreen', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');
  return {
    WebViewScreen: (props: { testID?: string } & Record<string, unknown>) => {
      mockWebViewScreenProps.push(props);
      return ReactActual.createElement(View, { testID: props.testID });
    },
  };
});

// ── 対象コンポーネントのインポート ─────────────────────────────────────────────
import HomeScreen from '../../app/(tabs)/home';

beforeEach(() => {
  jest.clearAllMocks();
  mockWebViewScreenProps.length = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. ホームのタブは Web の /home を WebView で開く
// ─────────────────────────────────────────────────────────────────────────────

describe('ホームのタブ — Web の /home の WebView', () => {
  it('WebViewScreen に path "/home" と testID "webview-home" を渡す', () => {
    const { getByTestId } = render(<HomeScreen />);

    expect(getByTestId('webview-home')).toBeTruthy();
    expect(mockWebViewScreenProps).toHaveLength(1);
    expect(mockWebViewScreenProps[0]).toEqual({ path: '/home', testID: 'webview-home' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ISO date による「今日」判定の境界
//    `new Date().toISOString().slice(0, 10)` は UTC の暦日を返す。UTC 基準の境界値を純粋な日付計算で検証し、
//    この判定で「今日」を決めると日本の暦日とずれる時間帯があることを文書化する。
// ─────────────────────────────────────────────────────────────────────────────

// モック外で RealDate を保持 (jest.spyOn で上書き前の参照)
const RealDate = Date;

describe('ISO date による「今日」判定の境界', () => {
  afterEach(() => {
    // Date が spyOn されていればリストア
    jest.restoreAllMocks();
  });

  it('UTC 00:00:00 (= JST 09:00:00) のとき toISOString().slice(0,10) が正しく今日の日付を返す', () => {
    // 2026-05-01T00:00:00.000Z = UTC 深夜0時 = JST 09:00
    const d = new RealDate('2026-05-01T00:00:00.000Z');
    expect(d.toISOString().slice(0, 10)).toBe('2026-05-01');
  });

  it('UTC 23:59:59 (= JST 翌08:59:59) のとき toISOString().slice(0,10) が今日(UTC)を返す', () => {
    // 2026-05-01T23:59:59.999Z = UTC 当日終端
    const d = new RealDate('2026-05-01T23:59:59.999Z');
    expect(d.toISOString().slice(0, 10)).toBe('2026-05-01');
  });

  it('JST 00:00:00 (= UTC 前日 15:00:00) のとき toISOString().slice(0,10) は前日(UTC)になる', () => {
    // 2026-05-01T00:00:00+09:00 = 2026-04-30T15:00:00Z
    // → UTC 基準では「前日」扱いになることを文書化するテスト
    const d = new RealDate('2026-04-30T15:00:00.000Z');
    expect(d.toISOString().slice(0, 10)).toBe('2026-04-30');
  });

  it('JST 23:59:59 (= UTC 同日 14:59:59) のとき toISOString().slice(0,10) は今日(UTC)になる', () => {
    // 2026-05-01T23:59:59+09:00 = 2026-05-01T14:59:59Z
    const d = new RealDate('2026-05-01T14:59:59.000Z');
    expect(d.toISOString().slice(0, 10)).toBe('2026-05-01');
  });

  it('Date のモックで new Date() が引数なしのとき固定日時を返すスパイが動作する', () => {
    const fixedDate = new RealDate('2026-05-01T10:00:00.000Z');
    jest.spyOn(global, 'Date').mockImplementation(
      (...args: any[]) => args.length === 0 ? fixedDate as any : new RealDate(...args as [any]),
    );

    // 引数なし → 固定日時
    const now = new Date();
    expect(now.toISOString().slice(0, 10)).toBe('2026-05-01');

    // 引数あり → 実際の Date を使う
    const specified = new Date('2020-01-15T00:00:00.000Z');
    expect(specified.toISOString().slice(0, 10)).toBe('2020-01-15');
  });
});
