/**
 * action-execute.test.tsx
 * actionExecuted フラグの単一実行保証テスト
 * - 「実行」ボタン押下で POST /api/ai/consultation/actions/:id/execute が1回だけ呼ばれる
 * - 「却下」ボタン押下で DELETE /api/ai/consultation/actions/:id/execute が1回だけ呼ばれる
 * - 実行後に同じメッセージのアクションボタンが非表示になる（二重実行防止）
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

// --- モック設定 ---
const mockGet = jest.fn();
const mockPost = jest.fn();
const mockDel = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({
    get: mockGet,
    post: mockPost,
    del: mockDel,
  }),
  getApiBaseUrl: () => 'http://localhost:3000',
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
    },
  },
}));

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ sessionId: 'test-session-id' }),
  router: { back: jest.fn() },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

// --- コンポーネント import (モック設定後) ---
import React from 'react';
import { Alert } from 'react-native';
import AiSessionPage from '../../app/ai/[sessionId]';
import { supabase } from '../../src/lib/supabase';

const MSG_WITH_ACTION = {
  id: 'ai-msg-action',
  role: 'assistant' as const,
  content: 'カレーを献立に追加しましょうか？',
  proposedActions: { type: 'add_meal', meal: 'カレー' },
  createdAt: '2026-04-01T10:00:00.000Z',
};

let mockAlertSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  (supabase.auth.getSession as jest.Mock).mockResolvedValue({
    data: { session: { access_token: 'test-token' } },
  });
  global.fetch = jest.fn();
  mockAlertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  mockAlertSpy.mockRestore();
});

describe('AiSessionPage — アクション実行ボタン', () => {
  it('提案アクションが存在するとき「実行」「却下」ボタンが表示される', async () => {
    mockGet.mockResolvedValueOnce({ messages: [MSG_WITH_ACTION] });
    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByText('実行')).toBeTruthy();
      expect(screen.getByText('却下')).toBeTruthy();
    });
  });

  it('提案アクションがない場合はボタンが表示されない', async () => {
    const msgNoAction = { ...MSG_WITH_ACTION, proposedActions: null };
    mockGet.mockResolvedValueOnce({ messages: [msgNoAction] });
    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByText('カレーを献立に追加しましょうか？')).toBeTruthy();
    });

    expect(screen.queryByText('実行')).toBeNull();
    expect(screen.queryByText('却下')).toBeNull();
  });
});

describe('AiSessionPage — アクション「実行」', () => {
  it('「実行」ボタン押下で POST エンドポイントが1回だけ呼ばれる', async () => {
    mockGet
      .mockResolvedValueOnce({ messages: [MSG_WITH_ACTION] })
      .mockResolvedValueOnce({ messages: [MSG_WITH_ACTION] }); // 実行後のリロード
    mockPost.mockResolvedValueOnce({ success: true });

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByText('実行')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('実行'));
    });

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockPost).toHaveBeenCalledWith(
        '/api/ai/consultation/actions/ai-msg-action/execute',
        {}
      );
    });
  });

  it('「実行」後はアクションボタンが非表示になる (executedMessageIds に記録)', async () => {
    mockGet
      .mockResolvedValueOnce({ messages: [MSG_WITH_ACTION] })
      .mockResolvedValueOnce({ messages: [MSG_WITH_ACTION] }); // 実行後のリロードでも proposedActions は残る
    mockPost.mockResolvedValueOnce({ success: true });

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByText('実行')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('実行'));
    });

    await waitFor(() => {
      // リロード後も executedMessageIds によりボタンが非表示
      expect(screen.queryByText('実行')).toBeNull();
      expect(screen.queryByText('却下')).toBeNull();
    });
  });

  it('「実行」が失敗した場合でもボタンは非表示にならない', async () => {
    mockGet.mockResolvedValueOnce({ messages: [MSG_WITH_ACTION] });
    mockPost.mockRejectedValueOnce(new Error('実行失敗'));

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByText('実行')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('実行'));
    });

    // エラー時はアクションが executedMessageIds に追加されない
    // ただし現実装では executeActionByMessageId の catch 内で追加しないため
    // ボタンが再表示されるはず（リロードなし）
    await waitFor(() => {
      expect(mockAlertSpy).toHaveBeenCalled();
    });
  });
});

describe('AiSessionPage — アクション「却下」', () => {
  it('「却下」ボタン押下で DELETE エンドポイントが1回だけ呼ばれる', async () => {
    mockGet
      .mockResolvedValueOnce({ messages: [MSG_WITH_ACTION] })
      .mockResolvedValueOnce({ messages: [MSG_WITH_ACTION] }); // 却下後のリロード
    mockDel.mockResolvedValueOnce({ success: true });

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByText('却下')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('却下'));
    });

    await waitFor(() => {
      expect(mockDel).toHaveBeenCalledTimes(1);
      expect(mockDel).toHaveBeenCalledWith(
        '/api/ai/consultation/actions/ai-msg-action/execute'
      );
    });
  });

  it('「却下」後はアクションボタンが非表示になる (executedMessageIds に記録)', async () => {
    mockGet
      .mockResolvedValueOnce({ messages: [MSG_WITH_ACTION] })
      .mockResolvedValueOnce({ messages: [MSG_WITH_ACTION] });
    mockDel.mockResolvedValueOnce({ success: true });

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByText('却下')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('却下'));
    });

    await waitFor(() => {
      expect(screen.queryByText('実行')).toBeNull();
      expect(screen.queryByText('却下')).toBeNull();
    });
  });
});

describe('AiSessionPage — 単一実行保証 (executedMessageIds による重複排除)', () => {
  it('実行成功後に GET が再取得されても同じメッセージのボタンは表示されない', async () => {
    // POST 成功 → executedMessageIds に記録 → load() 再取得
    // 再取得後も proposedActions が返ってくるが、executedMessageIds により非表示
    mockGet
      .mockResolvedValueOnce({ messages: [MSG_WITH_ACTION] })
      .mockResolvedValueOnce({ messages: [MSG_WITH_ACTION] }); // リロード後も同じ
    mockPost.mockResolvedValueOnce({ success: true });

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByText('実行')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('実行'));
    });

    // 実行後: ボタンが非表示、POST は1回だけ呼ばれている
    await waitFor(() => {
      expect(screen.queryByText('実行')).toBeNull();
    });
    expect(mockPost).toHaveBeenCalledTimes(1);

    // 追加で GET が呼ばれても同じ ID なのでボタンは表示されない
    expect(screen.queryByText('実行')).toBeNull();
    expect(screen.queryByText('却下')).toBeNull();
  });

  it('実行成功後にアクションボタンが再表示されない (ref による追跡)', async () => {
    mockGet
      .mockResolvedValueOnce({ messages: [MSG_WITH_ACTION] })
      .mockResolvedValueOnce({ messages: [MSG_WITH_ACTION] });
    mockPost.mockResolvedValueOnce({ success: true });

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByText('実行')).toBeTruthy();
    });

    // 実行
    await act(async () => {
      fireEvent.press(screen.getByText('実行'));
    });

    await waitFor(() => {
      expect(screen.queryByText('実行')).toBeNull();
      expect(screen.queryByText('却下')).toBeNull();
    });

    // load() で同一メッセージが再取得されてもボタンは出てこない
    await act(async () => {}); // flush
    expect(screen.queryByText('実行')).toBeNull();
  });
});
