/**
 * session-list.test.tsx
 * AI セッション一覧・新規作成のテスト
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

// --- モック設定 ---
// jest.mock はホイストされるため、ファクトリー内で参照する変数は var か jest.fn() 直書きにする
const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({
    get: mockGet,
    post: mockPost,
  }),
}));

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  router: {
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
  },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

// --- コンポーネント import (モック設定後) ---
import React from 'react';
import AiSessionsPage from '../../app/ai/index';
import { router } from 'expo-router';

const SAMPLE_SESSIONS = [
  {
    id: 'session-1',
    // ページタイトル「AI相談」と重複しないようにユニークなタイトルを使用
    title: '夕食についての相談',
    status: 'active',
    summary: null,
    messageCount: 3,
    createdAt: '2026-04-01T10:00:00.000Z',
    updatedAt: '2026-04-01T10:30:00.000Z',
  },
  {
    id: 'session-2',
    title: '食事相談',
    status: 'active',
    summary: 'まとめ',
    messageCount: 7,
    createdAt: '2026-04-02T09:00:00.000Z',
    updatedAt: '2026-04-02T09:45:00.000Z',
  },
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AiSessionsPage — セッション一覧', () => {
  it('セッション一覧が表示される', async () => {
    mockGet.mockResolvedValueOnce({ sessions: SAMPLE_SESSIONS });
    render(<AiSessionsPage />);

    await waitFor(() => {
      expect(screen.getByText('夕食についての相談')).toBeTruthy();
    });
    expect(screen.getByText('食事相談')).toBeTruthy();
  });

  it('セッション一覧が空のとき EmptyState を表示する', async () => {
    mockGet.mockResolvedValueOnce({ sessions: [] });
    render(<AiSessionsPage />);

    await waitFor(() => {
      expect(screen.getByText('アクティブなセッションがありません。')).toBeTruthy();
    });
  });

  it('エラー時にエラーメッセージを表示する', async () => {
    mockGet.mockRejectedValueOnce(new Error('サーバーエラー'));
    render(<AiSessionsPage />);

    await waitFor(() => {
      expect(screen.getByText('サーバーエラー')).toBeTruthy();
    });
  });

  it('セッションをタップすると対応する sessionId の画面に遷移する', async () => {
    mockGet.mockResolvedValueOnce({ sessions: SAMPLE_SESSIONS });
    render(<AiSessionsPage />);

    await waitFor(() => {
      expect(screen.getByText('夕食についての相談')).toBeTruthy();
    });

    fireEvent.press(screen.getByText('夕食についての相談'));
    expect(router.push).toHaveBeenCalledWith('/ai/session-1');
  });

  it('API が /api/ai/consultation/sessions?status=active を呼ぶ', async () => {
    mockGet.mockResolvedValueOnce({ sessions: [] });
    render(<AiSessionsPage />);

    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith('/api/ai/consultation/sessions?status=active');
    });
  });
});

describe('AiSessionsPage — 新規作成', () => {
  it('「新規」ボタン押下で createSession を呼び、新セッション画面へ遷移する', async () => {
    mockGet.mockResolvedValueOnce({ sessions: [] });
    mockPost.mockResolvedValueOnce({ success: true, session: { id: 'new-session-123' } });

    render(<AiSessionsPage />);

    // 初期ロード完了を待つ
    await waitFor(() => {
      expect(screen.getByText('アクティブなセッションがありません。')).toBeTruthy();
    });

    const newBtn = screen.getByText('新規');
    await act(async () => {
      fireEvent.press(newBtn);
    });

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith('/api/ai/consultation/sessions', { title: 'AI相談' });
      expect(router.push).toHaveBeenCalledWith('/ai/new-session-123');
    });
  });

  it('新規作成中は「作成中...」テキストが表示される', async () => {
    mockGet.mockResolvedValueOnce({ sessions: [] });

    // post を delay させて非同期状態を確認
    let resolvePost!: (v: any) => void;
    mockPost.mockReturnValueOnce(new Promise((res) => { resolvePost = res; }));

    render(<AiSessionsPage />);

    await waitFor(() => {
      expect(screen.getByText('アクティブなセッションがありません。')).toBeTruthy();
    });

    const newBtn = screen.getByText('新規');
    act(() => {
      fireEvent.press(newBtn);
    });

    await waitFor(() => {
      expect(screen.getByText('作成中...')).toBeTruthy();
    });

    // クリーンアップ
    act(() => {
      resolvePost({ success: true, session: { id: 'x' } });
    });
  });

  it('新規作成が失敗したときエラーメッセージを表示する', async () => {
    mockGet.mockResolvedValueOnce({ sessions: [] });
    mockPost.mockRejectedValueOnce(new Error('作成エラー'));

    render(<AiSessionsPage />);

    await waitFor(() => {
      expect(screen.getByText('アクティブなセッションがありません。')).toBeTruthy();
    });

    const newBtn = screen.getByText('新規');
    await act(async () => {
      fireEvent.press(newBtn);
    });

    await waitFor(() => {
      expect(screen.getByText('作成エラー')).toBeTruthy();
    });
  });

  it('「新しい相談を始める」ボタン (EmptyState action) でも新規作成できる', async () => {
    mockGet.mockResolvedValueOnce({ sessions: [] });
    mockPost.mockResolvedValueOnce({ success: true, session: { id: 'empty-new-456' } });

    render(<AiSessionsPage />);

    await waitFor(() => {
      expect(screen.getByText('新しい相談を始める')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('新しい相談を始める'));
    });

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/ai/empty-new-456');
    });
  });
});

describe('AiSessionsPage — 更新', () => {
  it('「更新」ボタン押下で再取得する', async () => {
    mockGet
      .mockResolvedValueOnce({ sessions: [] })
      .mockResolvedValueOnce({ sessions: SAMPLE_SESSIONS });

    render(<AiSessionsPage />);

    await waitFor(() => {
      expect(screen.getByText('アクティブなセッションがありません。')).toBeTruthy();
    });

    const refreshBtn = screen.getByText('更新');
    await act(async () => {
      fireEvent.press(refreshBtn);
    });

    await waitFor(() => {
      expect(screen.getByText('夕食についての相談')).toBeTruthy();
    });
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});
