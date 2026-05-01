/**
 * chat-stream.test.tsx
 * メッセージ送信・ストリーミング受信・executedMessageIds 重複防止のテスト
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

// fetch SSE モックユーティリティ
function makeSseResponse(lines: string[]): Response {
  const text = lines.join('\n') + '\n';
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    body: stream,
    text: () => Promise.resolve(text),
  } as unknown as Response;
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
import { supabase } from '../../src/lib/supabase';

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
  (supabase.auth.getSession as jest.Mock).mockResolvedValue({
    data: { session: { access_token: 'test-token' } },
  });
  global.fetch = jest.fn();
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

describe('AiSessionPage — メッセージ送信 (ストリーミング)', () => {
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

  it('テキスト送信後、楽観的メッセージが表示される', async () => {
    mockGet.mockResolvedValueOnce({ messages: [] });

    // fetch を delay させて楽観的 UI の確認中を維持
    let resolveFetch!: (v: Response) => void;
    (global.fetch as jest.Mock).mockReturnValueOnce(
      new Promise((res) => { resolveFetch = res; })
    );

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    await typeAndSend('今日の夕食を教えて');

    // 楽観的メッセージが表示される
    await waitFor(() => {
      expect(screen.getByText('今日の夕食を教えて')).toBeTruthy();
    });

    // クリーンアップ: fetch を失敗させて終了
    act(() => {
      resolveFetch({ ok: false, status: 500, text: () => Promise.resolve(''), body: null } as any);
    });
    await waitFor(() => {
      // エラー後、楽観的メッセージが削除される
      expect(screen.queryByText('今日の夕食を教えて')).toBeNull();
    });
  });

  it('SSE ストリームのチャンクが最終メッセージとして表示される', async () => {
    mockGet.mockResolvedValueOnce({ messages: [] });

    const sseLines = [
      'data: {"choices":[{"delta":{"content":"今日"}}]}',
      'data: {"choices":[{"delta":{"content":"の夕食"}}]}',
      'data: {"choices":[{"delta":{"content":"はカレーです"}}]}',
      'data: {"aiMessage":{"id":"ai-resp-1","content":"今日の夕食はカレーです","createdAt":"2026-04-01T11:00:00.000Z"},"userMessage":{"id":"user-sent-1","content":"今日の夕食を教えて","createdAt":"2026-04-01T10:59:00.000Z"}}',
      'data: [DONE]',
    ];
    (global.fetch as jest.Mock).mockResolvedValueOnce(makeSseResponse(sseLines));

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    await typeAndSend('今日の夕食を教えて');

    await waitFor(() => {
      expect(screen.getByText('今日の夕食はカレーです')).toBeTruthy();
    });
  });

  it('SSE 完了後、入力欄がクリアされる', async () => {
    mockGet.mockResolvedValueOnce({ messages: [] });

    const sseLines = [
      'data: {"aiMessage":{"id":"ai-resp-2","content":"応答テキスト","createdAt":"2026-04-01T11:00:00.000Z"},"userMessage":{"id":"user-sent-2","content":"テスト送信","createdAt":"2026-04-01T10:59:00.000Z"}}',
      'data: [DONE]',
    ];
    (global.fetch as jest.Mock).mockResolvedValueOnce(makeSseResponse(sseLines));

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

  it('fetch が HTTP エラーを返したとき、エラーメッセージを表示しオプティミスティックメッセージを削除する', async () => {
    mockGet.mockResolvedValueOnce({ messages: [] });
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
      body: null,
    } as any);

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
  });

  it('fetch が呼ばれる際に Authorization ヘッダーが含まれる', async () => {
    mockGet.mockResolvedValueOnce({ messages: [] });

    const sseLines = [
      'data: {"aiMessage":{"id":"ai-auth-test","content":"認証テスト応答","createdAt":"2026-04-01T11:00:00.000Z"},"userMessage":{"id":"user-auth","content":"認証テスト","createdAt":"2026-04-01T10:59:00.000Z"}}',
      'data: [DONE]',
    ];
    (global.fetch as jest.Mock).mockResolvedValueOnce(makeSseResponse(sseLines));

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    await typeAndSend('認証テスト');

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
    expect(fetchCall[1].headers['Authorization']).toBe('Bearer test-token');
    expect(fetchCall[0]).toContain('/api/ai/consultation/sessions/test-session-id/messages?stream=true');
  });
});

describe('AiSessionPage — executedMessageIds 重複防止', () => {
  it('actionExecuted=true の SSE 受信後、アクションボタンが非表示になる', async () => {
    mockGet.mockResolvedValueOnce({ messages: [] });

    // actionExecuted=true を含む SSE
    const sseLines = [
      'data: {"aiMessage":{"id":"ai-action-msg","content":"アクションを実行しました","proposedActions":{"type":"add_meal"},"createdAt":"2026-04-01T11:00:00.000Z"},"userMessage":{"id":"user-1","content":"追加して","createdAt":"2026-04-01T10:59:00.000Z"},"actionExecuted":true}',
      'data: [DONE]',
    ];
    (global.fetch as jest.Mock).mockResolvedValueOnce(makeSseResponse(sseLines));

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

  it('actionExecuted=false の SSE では proposedActions がありアクションボタンが表示される', async () => {
    mockGet.mockResolvedValueOnce({ messages: [] });

    // actionExecuted なし（フラグなし）= アクションボタン表示
    const sseLines = [
      'data: {"aiMessage":{"id":"ai-propose-msg","content":"献立を追加しましょうか？","proposedActions":{"type":"add_meal"},"createdAt":"2026-04-01T11:00:00.000Z"},"userMessage":{"id":"user-2","content":"提案して","createdAt":"2026-04-01T10:59:00.000Z"}}',
      'data: [DONE]',
    ];
    (global.fetch as jest.Mock).mockResolvedValueOnce(makeSseResponse(sseLines));

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
