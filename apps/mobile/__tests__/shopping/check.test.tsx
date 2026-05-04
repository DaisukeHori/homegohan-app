/**
 * チェック toggle テスト
 * - is_checked を true / false に切り替えたとき API が呼ばれるか
 * - Supabase update のモック
 */
import React, { useState } from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { Text, Pressable, View } from 'react-native';

// ---- モック ----------------------------------------------------------------

const mockPatch = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: jest.fn().mockReturnValue({
    get: jest.fn(),
    post: jest.fn(),
    patch: mockPatch,
    del: jest.fn(),
  }),
  getApiBaseUrl: jest.fn().mockReturnValue('http://localhost:3000'),
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
      getSession: jest.fn().mockResolvedValue({ data: { session: { access_token: 'tok' } } }),
    },
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    }),
    channel: jest.fn().mockReturnValue({
      on: jest.fn().mockReturnThis(),
      subscribe: jest.fn().mockReturnThis(),
    }),
    removeChannel: jest.fn(),
  },
}));

// ---- テスト用最小コンポーネント -------------------------------------------

type Item = {
  id: string;
  item_name: string;
  is_checked: boolean;
};

function CheckableItem({
  item,
  onToggle,
}: {
  item: Item;
  onToggle: (id: string, next: boolean) => Promise<void>;
}) {
  return (
    <View>
      <Text testID={`name-${item.id}`}>{item.item_name}</Text>
      <Text testID={`status-${item.id}`}>{item.is_checked ? '購入済み' : '未購入'}</Text>
      <Pressable
        testID={`toggle-${item.id}`}
        onPress={() => onToggle(item.id, !item.is_checked)}
      >
        <Text>{item.is_checked ? '戻す' : 'チェック'}</Text>
      </Pressable>
    </View>
  );
}

function ShoppingListWithCheck({ initialItems }: { initialItems: Item[] }) {
  const [items, setItems] = useState(initialItems);
  const { getApi } = require('../../src/lib/api');

  async function toggleChecked(id: string, next: boolean) {
    const api = getApi();
    await api.patch(`/api/shopping-list/${id}`, { isChecked: next });
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, is_checked: next } : x)));
  }

  return (
    <View>
      {items.map((it) => (
        <CheckableItem key={it.id} item={it} onToggle={toggleChecked} />
      ))}
    </View>
  );
}

// ---- テスト -----------------------------------------------------------------

const sampleItems: Item[] = [
  { id: 'item-1', item_name: '牛乳', is_checked: false },
  { id: 'item-2', item_name: '卵', is_checked: true },
];

beforeEach(() => {
  mockPatch.mockClear();
  mockPatch.mockResolvedValue({});
});

describe('チェック toggle', () => {
  test('未購入アイテムをチェックすると API patch が呼ばれる', async () => {
    const { getByTestId } = render(<ShoppingListWithCheck initialItems={sampleItems} />);

    await act(async () => {
      fireEvent.press(getByTestId('toggle-item-1'));
    });

    expect(mockPatch).toHaveBeenCalledTimes(1);
    expect(mockPatch).toHaveBeenCalledWith('/api/shopping-list/item-1', { isChecked: true });
  });

  test('購入済みアイテムを戻すと API patch が is_checked:false で呼ばれる', async () => {
    const { getByTestId } = render(<ShoppingListWithCheck initialItems={sampleItems} />);

    await act(async () => {
      fireEvent.press(getByTestId('toggle-item-2'));
    });

    expect(mockPatch).toHaveBeenCalledWith('/api/shopping-list/item-2', { isChecked: false });
  });

  test('チェック後にローカルステートが更新される', async () => {
    const { getByTestId } = render(<ShoppingListWithCheck initialItems={sampleItems} />);

    expect(getByTestId('status-item-1')).toHaveTextContent('未購入');

    await act(async () => {
      fireEvent.press(getByTestId('toggle-item-1'));
    });

    await waitFor(() => {
      expect(getByTestId('status-item-1')).toHaveTextContent('購入済み');
    });
  });

  test('戻す後にローカルステートが未購入に変わる', async () => {
    const { getByTestId } = render(<ShoppingListWithCheck initialItems={sampleItems} />);

    expect(getByTestId('status-item-2')).toHaveTextContent('購入済み');

    await act(async () => {
      fireEvent.press(getByTestId('toggle-item-2'));
    });

    await waitFor(() => {
      expect(getByTestId('status-item-2')).toHaveTextContent('未購入');
    });
  });

  test('API エラー時でもローカルステートがロールバックされる', async () => {
    // エラー時はステート変更がスキップされる別実装でテスト
    const mockAlertFn = jest.fn();
    jest.spyOn(require('react-native').Alert, 'alert').mockImplementation(mockAlertFn);

    // エラーが発生するパッチ関数を持つコンポーネントを直接作成
    function ShoppingListWithError({ initialItems }: { initialItems: Item[] }) {
      const [items, setItems] = React.useState(initialItems);

      async function toggleChecked(id: string, next: boolean) {
        try {
          await mockPatch(`/api/shopping-list/${id}`, { isChecked: next });
          setItems((prev) => prev.map((x) => (x.id === id ? { ...x, is_checked: next } : x)));
        } catch (_e) {
          // エラー時はステートを変更しない (ロールバック)
        }
      }

      return (
        <View>
          {items.map((it) => (
            <CheckableItem key={it.id} item={it} onToggle={toggleChecked} />
          ))}
        </View>
      );
    }

    mockPatch.mockRejectedValueOnce(new Error('network error'));

    const { getByTestId } = render(<ShoppingListWithError initialItems={sampleItems} />);

    await act(async () => {
      fireEvent.press(getByTestId('toggle-item-1'));
    });

    // エラー時はステートが変わっていない
    expect(getByTestId('status-item-1')).toHaveTextContent('未購入');
  });

  test('複数アイテムをそれぞれ独立してチェックできる', async () => {
    const threeItems: Item[] = [
      { id: 'a', item_name: 'A', is_checked: false },
      { id: 'b', item_name: 'B', is_checked: false },
      { id: 'c', item_name: 'C', is_checked: false },
    ];

    const { getByTestId } = render(<ShoppingListWithCheck initialItems={threeItems} />);

    await act(async () => {
      fireEvent.press(getByTestId('toggle-a'));
    });
    await act(async () => {
      fireEvent.press(getByTestId('toggle-c'));
    });

    expect(mockPatch).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(getByTestId('status-a')).toHaveTextContent('購入済み');
      expect(getByTestId('status-b')).toHaveTextContent('未購入');
      expect(getByTestId('status-c')).toHaveTextContent('購入済み');
    });
  });
});
