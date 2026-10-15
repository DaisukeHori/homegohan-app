/**
 * #1602: モバイルの献立の食材の表示 (PantryItem) の「期限間近」を、全画面と同じ 3 日以内に揃える。
 *
 * 以前はこの表示だけ「期限間近」が 1 日以内で (2・3 日後の期限は「あと N 日」の普通の表示)、
 * 食品庫 (モバイル・Web)・ホーム・AI 相談の 3 日以内と食い違っていた。
 * 時計は日本の 0:30 (UTC では前日の 15:30) に固定する (Jest は TZ=UTC で動く)。期限の日付は手で数えた固定値。
 */
import { PANTRY_EXPIRING_SOON_DAYS } from '@homegohan/shared';
import { render, screen } from '@testing-library/react-native';
import React from 'react';

import { getExpiryStatus, PantryItem, type PantryItemData } from '../../src/components/menu/PantryItem';

jest.mock('lucide-react-native', () => ({ Trash2: 'Trash2' }));

/** 2026-10-13 15:30 UTC = 2026-10-14 00:30 JST (日本では 10/14、UTC ではまだ 10/13) */
const JST_EARLY_MORNING = new Date('2026-10-13T15:30:00Z');

afterEach(() => {
  jest.useRealTimers();
});

describe('PantryItem — 「期限間近」は全画面と同じ 3 日以内 (#1602)', () => {
  it('前提: 「期限間近」の日数は全画面共通の 3 日', () => {
    expect(PANTRY_EXPIRING_SOON_DAYS).toBe(3);
  });

  it.each([
    ['昨日', '2026-10-13', 'expired'],
    ['今日', '2026-10-14', 'expiringSoon'],
    ['明日', '2026-10-15', 'expiringSoon'],
    ['2 日後', '2026-10-16', 'expiringSoon'],
    ['3 日後', '2026-10-17', 'expiringSoon'],
    ['4 日後', '2026-10-18', 'normal'],
  ] as const)('期限が%s (%s) → %s', (_label, date, expected) => {
    jest.useFakeTimers({ now: JST_EARLY_MORNING });
    expect(getExpiryStatus(date)).toBe(expected);
  });

  it('期限が無ければ normal', () => {
    jest.useFakeTimers({ now: JST_EARLY_MORNING });
    expect(getExpiryStatus(null)).toBe('normal');
  });

  it('3 日後が期限の食材は「期限間近」の色のバッジ、4 日後は普通のバッジ', () => {
    jest.useFakeTimers({ now: JST_EARLY_MORNING });
    const base: Omit<PantryItemData, 'id' | 'expirationDate'> = { name: '卵', amount: null, category: null, addedAt: null };

    const { rerender } = render(<PantryItem item={{ ...base, id: 'd3', expirationDate: '2026-10-17' }} onDelete={jest.fn()} />);
    const soonText = screen.getByText('あと 3 日');
    const soonStyle = [soonText.props.style].flat();

    rerender(<PantryItem item={{ ...base, id: 'd4', expirationDate: '2026-10-18' }} onDelete={jest.fn()} />);
    const normalText = screen.getByText('あと 4 日');
    const normalStyle = [normalText.props.style].flat();

    // 期限間近のバッジは太字 + 警告色、普通のバッジは太字でない
    expect(soonStyle).toEqual(expect.arrayContaining([expect.objectContaining({ fontWeight: '600' })]));
    expect(normalStyle).not.toEqual(expect.arrayContaining([expect.objectContaining({ fontWeight: '600' })]));
  });
});
