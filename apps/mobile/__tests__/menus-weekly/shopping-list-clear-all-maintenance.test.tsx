/**
 * shopping-list-clear-all-maintenance.test.tsx
 * 買い物リストの全削除 (生の fetch の DELETE /api/shopping-list) が、メンテナンス中の 503 を固定の文で出す (#1486)
 *
 * 全削除は getApi() を通らない生の fetch で送る (本文つきの DELETE)。getApi() の置き換え (withFriendlyErrors) が効かないので、
 * 失敗の応答を errorOfFailedResponse で読み、メンテナンス中などの 503 は「ご利用いただけません」と固定の文の Alert を出す。
 * 以前は、どの失敗でも「全削除に失敗しました」の汎用の文だった (止められた理由が伝わらなかった)。
 * どの生の fetch がこの関数を通すかは tests/ai-daily-limit-mobile-raw-fetch.test.ts の 4 が見張る。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { MAINTENANCE_API_CODE, MAINTENANCE_MESSAGE } from '@homegohan/shared';

const mockGet = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet, post: jest.fn(), del: jest.fn(), patch: jest.fn() }),
  getApiBaseUrl: () => 'http://localhost:3000',
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: { getSession: jest.fn().mockResolvedValue({ data: { session: { access_token: 'token' } } }) },
    channel: jest.fn(),
    from: jest.fn(),
    removeChannel: jest.fn(),
  },
}));

import React from 'react';
import { ShoppingListModal } from '../../src/components/menu/ShoppingListModal';

/** サーバーとは違う文を入れた本文。画面に出す文は本文の文字列ではなく、code から決めた固定の文であることを確かめる */
const SERVER_TEXT = 'サーバーが返した別の文';
const ITEMS = [
  { id: 'item-1', item_name: '卵', quantity: '1パック', category: '乳製品・卵', is_checked: false },
  { id: 'item-2', item_name: '牛乳', quantity: '1本', category: '乳製品・卵', is_checked: false },
];
const PROPS = { onClose: jest.fn(), onOpenAdd: jest.fn(), onOpenRange: jest.fn() };

const fetchMock = jest.fn();
const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue({ items: ITEMS });
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

/** 全削除のボタンを押し、確認の Alert の「全削除」を押す */
async function clearAll() {
  render(<ShoppingListModal visible {...PROPS} />);
  await waitFor(() => expect(screen.getByText('卵')).toBeTruthy());
  fireEvent.press(screen.getByTestId('shopping-list-clear-all-btn'));
  const confirm = (Alert.alert as jest.Mock).mock.calls.find(([title]) => title === '全削除');
  expect(confirm).toBeTruthy();
  const buttons = confirm?.[2] as Array<{ text: string; onPress?: () => Promise<void> }>;
  const destructive = buttons.find((b) => b.text === '全削除');
  await act(async () => {
    await destructive?.onPress?.();
  });
}

describe('買い物リストの全削除 (生の fetch)', () => {
  it('メンテナンス中の 503: 「ご利用いただけません」と固定の文を出し、本文の文字列は出さない。リストは元に戻す', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: SERVER_TEXT, code: MAINTENANCE_API_CODE, retryAfter: 300 }), { status: 503 }),
    );

    await clearAll();

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/api/shopping-list', expect.objectContaining({ method: 'DELETE' }));
    expect(Alert.alert).toHaveBeenCalledWith('ご利用いただけません', MAINTENANCE_MESSAGE);
    const shown = (Alert.alert as jest.Mock).mock.calls.flat().map(String).join('\n');
    expect(shown).not.toContain(SERVER_TEXT);
    expect(shown).not.toContain('HTTP');
    // 消えたように見せたリストは戻す
    expect(screen.getByText('卵')).toBeTruthy();
    expect(screen.getByText('牛乳')).toBeTruthy();
  });

  it('ほかの失敗 (500) は、これまでどおり「全削除に失敗しました。」(生の文字列を出さない)', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: SERVER_TEXT }), { status: 500 }));

    await clearAll();

    expect(Alert.alert).toHaveBeenCalledWith('削除失敗', '全削除に失敗しました。');
    const shown = (Alert.alert as jest.Mock).mock.calls.flat().map(String).join('\n');
    expect(shown).not.toContain(SERVER_TEXT);
    expect(screen.getByText('卵')).toBeTruthy();
  });

  it('成功したら、リストを空にして Alert は出さない (上の 2 つが空振りでないことの確かめ)', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));

    await clearAll();

    expect((Alert.alert as jest.Mock).mock.calls.filter(([title]) => title !== '全削除')).toEqual([]);
    expect(screen.queryByText('卵')).toBeNull();
  });
});
