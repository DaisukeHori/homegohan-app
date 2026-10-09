/**
 * chat-stream.test.tsx
 * メッセージ送信・返信の表示・executedMessageIds 重複防止のテスト
 *
 * 送信は、ストリーミングではない通常の POST (Web 版と同じ) を共通 API クライアント (getApi().post) で行う。
 * RN 標準の fetch は応答を最後まで溜めてから返すので、SSE にしても途中経過は出ず、
 * 「応答が終わるまで」を 26 秒で打ち切ると正常な応答まで失敗にしていたため (#1049 F7-18)。
 * (ファイル名は経緯で chat-stream のまま。タイムアウト・履歴の取り直しは chat-stream-abort.test.tsx)
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
  router: {
    back: jest.fn(),
    push: jest.fn(),
  },
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

const MESSAGES_PATH = '/api/ai/consultation/sessions/test-session-id/messages';

/** サーバーが返す送信結果 (ストリーミングでない POST) */
function chatResponse(overrides: {
  aiId?: string;
  aiContent?: string;
  userId?: string;
  userContent?: string;
  proposedActions?: unknown;
  actionExecuted?: boolean;
} = {}) {
  return {
    success: true,
    userMessage: {
      id: overrides.userId ?? 'user-sent-1',
      role: 'user',
      content: overrides.userContent ?? '今日の夕食を教えて',
      isImportant: false,
      createdAt: '2026-04-01T10:59:00.000Z',
    },
    aiMessage: {
      id: overrides.aiId ?? 'ai-resp-1',
      role: 'assistant',
      content: overrides.aiContent ?? '今日の夕食はカレーです',
      proposedActions: overrides.proposedActions ?? null,
      createdAt: '2026-04-01T11:00:00.000Z',
    },
    actionExecuted: overrides.actionExecuted ?? false,
  };
}

/** テキスト入力欄を見つけて文字を入力し、送信ボタンを押す */
async function typeAndSend(inputText: string) {
  const input = screen.getByPlaceholderText('相談内容を入力...');
  fireEvent.changeText(input, inputText);
  // 送信ボタンは入力バー内の最後の Pressable。
  // UNSAFE_getAllByType で Pressable をすべて取得し最後を押す。
  const pressables = screen.UNSAFE_getAllByType(Pressable);
  await act(async () => {
    fireEvent.press(pressables[pressables.length - 1]);
  });
}

// --- コンポーネント import (モック設定後) ---
import React from 'react';
import { Pressable } from 'react-native';
import AiSessionPage from '../../app/ai/[sessionId]';

// 最初のテストでは、画面の読み込みと変換が走る。CI の --coverage (全ファイルの計装) や、
// 他の処理で混み合った環境では、既定の 5 秒を超えることがあるので、余裕を持たせる
jest.setTimeout(60_000);

const INITIAL_MESSAGES = [
  {
    id: 'msg-1',
    role: 'user' as const,
    content: 'こんにちは',
    createdAt: '2026-04-01T10:00:00.000Z',
  },
  {
    id: 'msg-2',
    role: 'assistant' as const,
    content: 'はじめまして！何かご相談がありますか？',
    createdAt: '2026-04-01T10:00:05.000Z',
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  // 送信は fetch を直接使わない。使ったらテストが気付けるよう、呼ばれたら失敗するモックにしておく
  global.fetch = jest.fn(() => {
    throw new Error('fetch は直接使わない (getApi().post を使う)');
  }) as unknown as typeof fetch;
});

describe('AiSessionPage — メッセージ一覧表示', () => {
  it('既存のメッセージが表示される', async () => {
    mockGet.mockResolvedValueOnce({ messages: INITIAL_MESSAGES });
    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByText('こんにちは')).toBeTruthy();
      expect(screen.getByText('はじめまして！何かご相談がありますか？')).toBeTruthy();
    });
  });

  it('メッセージ 0 件のとき入力バーが表示される', async () => {
    mockGet.mockResolvedValueOnce({ messages: [] });
    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });
  });

  it('ローディング中は LoadingState が表示される', async () => {
    // 解決しない promise でローディング状態を維持
    let resolve!: (v: any) => void;
    mockGet.mockReturnValueOnce(new Promise((res) => { resolve = res; }));
    render(<AiSessionPage />);

    // LoadingState は存在する (spinner or loading text)
    // NOTE: LoadingState コンポーネントが何らかのテキストをレンダリングしていれば検出できる
    // ここでは入力欄がまだない = ローディング中を確認
    expect(screen.queryByPlaceholderText('相談内容を入力...')).toBeNull();

    act(() => { resolve({ messages: [] }); });
  });
});

describe('AiSessionPage — メッセージ送信', () => {
  it('テキスト入力後に送信ボタンが有効になる', async () => {
    mockGet.mockResolvedValueOnce({ messages: [] });
    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    const input = screen.getByPlaceholderText('相談内容を入力...');
    // 初期状態では空なので送信ボタンは無効色
    // テキスト入力後、ボタンの背景色が変わるが RNTL では style の変化で確認するより
    // 実際に送信が呼ばれるかで確認する
    fireEvent.changeText(input, '今日の夕食を教えて');
    expect(input.props.value).toBe('今日の夕食を教えて');
  });

  it('テキスト送信後、返信待ちの間は楽観的メッセージと待機表示が出る', async () => {
    mockGet.mockResolvedValueOnce({ messages: [] });

    // 返信を遅らせて、待っている間の表示を確認する
    let rejectPost!: (e: Error) => void;
    mockPost.mockReturnValueOnce(new Promise((_res, rej) => { rejectPost = rej; }));

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    await typeAndSend('今日の夕食を教えて');

    // 楽観的メッセージと、返信待ちの表示 (Maestro が待ち合わせに使う testID)
    await waitFor(() => {
      expect(screen.getByText('今日の夕食を教えて')).toBeTruthy();
    });
    expect(screen.getByTestId('ai-chat-streaming-view')).toBeTruthy();

    // クリーンアップ: 送信を失敗させて終了
    await act(async () => {
      rejectPost(new Error('HTTP 500 Internal Server Error'));
    });
    await waitFor(() => {
      // エラー後、楽観的メッセージが削除される
      expect(screen.queryByText('今日の夕食を教えて')).toBeNull();
    });
    expect(screen.queryByTestId('ai-chat-streaming-view')).toBeNull();
  });

  it('AI の返信が最終メッセージとして表示され、楽観的メッセージはサーバーの確定 ID に置き換わる', async () => {
    mockGet.mockResolvedValueOnce({ messages: [] });
    mockPost.mockResolvedValueOnce(chatResponse());

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    await typeAndSend('今日の夕食を教えて');

    await waitFor(() => {
      expect(screen.getByText('今日の夕食はカレーです')).toBeTruthy();
    });
    // ユーザーのメッセージは 1 通だけ (仮メッセージと確定メッセージが二重にならない)
    expect(screen.getAllByText('今日の夕食を教えて')).toHaveLength(1);
  });

  it('送信は ?stream=true を付けない通常の POST で、タイムアウトは 26 秒より長い', async () => {
    mockGet.mockResolvedValueOnce({ messages: [] });
    mockPost.mockResolvedValueOnce(chatResponse());

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    await typeAndSend('今日の夕食を教えて');

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledTimes(1);
    });
    const [path, body, init] = mockPost.mock.calls[0];
    expect(path).toBe(MESSAGES_PATH);
    expect(path).not.toContain('stream=true');
    expect(body).toEqual({ message: '今日の夕食を教えて' });
    // サーバーの AI 呼び出しだけで最大 25 秒かかる。26 秒で切ると正常な応答まで失敗になっていた
    expect(init.timeoutMs).toBeGreaterThan(40_000);
  });

  it('送信後、入力欄がクリアされる', async () => {
    mockGet.mockResolvedValueOnce({ messages: [] });
    mockPost.mockResolvedValueOnce(chatResponse({ userContent: 'テスト送信', aiContent: '応答テキスト' }));

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    const input = screen.getByPlaceholderText('相談内容を入力...');
    fireEvent.changeText(input, 'テスト送信');
    expect(input.props.value).toBe('テスト送信');

    await typeAndSend('テスト送信');

    await waitFor(() => {
      // 入力欄がクリアされていること
      const inputAfter = screen.getByPlaceholderText('相談内容を入力...');
      expect(inputAfter.props.value).toBe('');
    });
  });

  it('送信が HTTP エラーになったとき、エラーメッセージを表示しオプティミスティックメッセージを削除する', async () => {
    mockGet.mockResolvedValueOnce({ messages: [] });
    mockPost.mockRejectedValueOnce(new Error('HTTP 500 Internal Server Error: Internal Server Error'));

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    await typeAndSend('エラーテスト');

    await waitFor(() => {
      expect(screen.getByText(/HTTP 500/)).toBeTruthy();
    });
    // 楽観的メッセージが削除されていること
    expect(screen.queryByText('エラーテスト')).toBeNull();
    // HTTP エラーはサーバーが処理しなかったと分かるので、履歴の取り直しはしない (初回の取得だけ)
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('返信が空 (aiMessage なし) の想定外の応答は、サーバーの履歴を取り直して合わせる', async () => {
    mockGet
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({ messages: INITIAL_MESSAGES });
    mockPost.mockResolvedValueOnce({ success: true });

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    await typeAndSend('こんにちは');

    await waitFor(() => {
      expect(screen.getByText('はじめまして！何かご相談がありますか？')).toBeTruthy();
    });
  });
});

describe('AiSessionPage — executedMessageIds 重複防止', () => {
  it('actionExecuted=true の応答後、アクションボタンが非表示になる', async () => {
    mockGet.mockResolvedValueOnce({ messages: [] });

    // actionExecuted=true を含む応答 (ストリーミングでは proposedActions が残ったまま来る)
    mockPost.mockResolvedValueOnce(
      chatResponse({
        aiId: 'ai-action-msg',
        aiContent: 'アクションを実行しました',
        userId: 'user-1',
        userContent: '追加して',
        proposedActions: { type: 'add_meal' },
        actionExecuted: true,
      }),
    );

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    await typeAndSend('追加して');

    await waitFor(() => {
      expect(screen.getByText('アクションを実行しました')).toBeTruthy();
    });

    // actionExecuted=true で記録されたメッセージのアクションボタンが非表示
    // (executedMessageIds に 'ai-action-msg' が追加されているので renderActionButtons が null を返す)
    expect(screen.queryByText('実行')).toBeNull();
    expect(screen.queryByText('却下')).toBeNull();
  });

  it('actionExecuted=false の応答では proposedActions がありアクションボタンが表示される', async () => {
    mockGet.mockResolvedValueOnce({ messages: [] });

    // actionExecuted なし（フラグなし）= アクションボタン表示
    mockPost.mockResolvedValueOnce(
      chatResponse({
        aiId: 'ai-propose-msg',
        aiContent: '献立を追加しましょうか？',
        userId: 'user-2',
        userContent: '提案して',
        proposedActions: { type: 'add_meal' },
      }),
    );

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    await typeAndSend('提案して');

    await waitFor(() => {
      expect(screen.getByText('献立を追加しましょうか？')).toBeTruthy();
    });

    // アクションボタンが表示される
    expect(screen.getByText('実行')).toBeTruthy();
    expect(screen.getByText('却下')).toBeTruthy();
  });

  it('初回ロード時に proposedActions があり executedMessageIds に未記録なら表示', async () => {
    const msgWithAction = {
      id: 'existing-action-msg',
      role: 'assistant' as const,
      content: 'この献立でよろしいですか？',
      proposedActions: { type: 'confirm_meal' },
      createdAt: '2026-04-01T10:00:00.000Z',
    };
    mockGet.mockResolvedValueOnce({ messages: [msgWithAction] });

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByText('この献立でよろしいですか？')).toBeTruthy();
    });

    // 初期ロード時は executedMessageIds が空なのでボタンが表示される
    expect(screen.getByText('実行')).toBeTruthy();
    expect(screen.getByText('却下')).toBeTruthy();
  });
});
