/**
 * AIDayMenuModal.date.test.tsx
 * 1 日献立モーダル (src/components/ai/AIDayMenuModal.tsx) の初期日付のテスト (#1049 F7-21)
 *
 * 以前は、対象日の初期値を new Date().toISOString().slice(0, 10) (UTC の日付) にしていた。
 * JST の 0〜9 時は UTC では前日なので、朝にモーダルを開くと「昨日」が入っていて、
 * そのまま作成すると昨日の献立を作ってしまった。今は Asia/Tokyo の今日 (todayLocal) を入れる。
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

const mockGenerate = jest.fn();
jest.mock('../../src/hooks/useV4MenuGeneration', () => ({
  useV4MenuGeneration: () => ({ generate: (...args: unknown[]) => mockGenerate(...args), isGenerating: false }),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

import { AIDayMenuModal } from '../../src/components/ai/AIDayMenuModal';

// 時計: Date だけを固定する。2026-10-07T23:30:00Z = JST の 2026-10-08 08:30
function freezeDate(iso: string) {
  jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
      'nextTick',
      'queueMicrotask',
      'hrtime',
      'performance',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
    ],
  });
}

beforeEach(() => {
  mockGenerate.mockReset();
  mockGenerate.mockResolvedValue({ requestId: 'req-1', totalSlots: 3 });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('AIDayMenuModal — 対象日の初期値は Asia/Tokyo の今日', () => {
  it('JST の朝 (UTC ではまだ前日) でも、今日の日付が入っている', () => {
    freezeDate('2026-10-07T23:30:00Z');

    render(<AIDayMenuModal visible onClose={jest.fn()} />);

    expect(screen.getByPlaceholderText('YYYY-MM-DD').props.value).toBe('2026-10-08');
  });

  it('JST の夜でも、今日の日付が入っている', () => {
    freezeDate('2026-10-08T14:59:00Z'); // 23:59 JST

    render(<AIDayMenuModal visible onClose={jest.fn()} />);

    expect(screen.getByPlaceholderText('YYYY-MM-DD').props.value).toBe('2026-10-08');
  });

  it('そのまま作成すると、今日 (JST) の朝・昼・夕の 3 食分を依頼する', async () => {
    freezeDate('2026-10-07T23:30:00Z');
    render(<AIDayMenuModal visible onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.press(screen.getByText('作成する'));
    });

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate.mock.calls[0][0].targetSlots).toEqual([
      { date: '2026-10-08', mealType: 'breakfast' },
      { date: '2026-10-08', mealType: 'lunch' },
      { date: '2026-10-08', mealType: 'dinner' },
    ]);
  });
});
