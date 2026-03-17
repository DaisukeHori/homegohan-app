"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  MessageCircle, X, Send, Sparkles, ChevronDown,
  Check, XCircle, Loader2, Calendar, ShoppingCart,
  Target, UtensilsCrossed, BookOpen, Star, Archive, MoreVertical,
  Plus, Trash2, CheckCircle, Refrigerator, Heart, FolderPlus,
  Activity, User, Edit, CalendarDays
} from "lucide-react";
import { useV4MenuGeneration } from "@/hooks/useV4MenuGeneration";

// シンプルなマークダウンパーサー
const parseMarkdown = (text: string): string => {
  if (!text) return '';
  
  // アクションブロックを除去（別途表示されるため）
  let html = text.replace(/```action[\s\S]*?```/g, '');
  
  // コードブロック（```）を処理
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre class="md-code-block"><code>$2</code></pre>');
  
  // インラインコード（`）を処理
  html = html.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
  
  // 太字（**text** または __text__）
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  
  // 斜体（*text* または _text_）- 太字の後に処理
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');
  
  // 見出し（### ## #）
  html = html.replace(/^### (.+)$/gm, '<h4 class="md-h4">$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3 class="md-h3">$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2 class="md-h2">$1</h2>');
  
  // 箇条書き（- または *）
  html = html.replace(/^[-*] (.+)$/gm, '<li class="md-li">$1</li>');
  // 連続するliをulで囲む
  html = html.replace(/(<li class="md-li">.*?<\/li>\n?)+/g, '<ul class="md-ul">$&</ul>');
  
  // 番号付きリスト
  html = html.replace(/^\d+\. (.+)$/gm, '<li class="md-li-num">$1</li>');
  html = html.replace(/(<li class="md-li-num">.*?<\/li>\n?)+/g, '<ol class="md-ol">$&</ol>');
  
  // リンク [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="md-link">$1</a>');
  
  // 改行を<br>に変換（ただし、HTMLタグの直後は除く）
  html = html.replace(/\n(?!<)/g, '<br>');
  
  return html;
};

const colors = {
  primary: '#E07A5F',
  primaryLight: '#FDF0ED',
  secondary: '#3D5A80',
  success: '#6B9B6B',
  successLight: '#EDF5ED',
  warning: '#F4A261',
  bg: '#FAF9F7',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textLight: '#4A4A4A',
  textMuted: '#8A8A8A',
  border: '#E8E8E8',
  purple: '#8B5CF6',
  purpleLight: '#F3E8FF',
};

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  proposedActions?: ProposedAction | null;
  createdAt: string;
  isImportant?: boolean;
  isStreaming?: boolean; // ストリーミング表示中かどうか
}

interface ProposedAction {
  type: string;
  params: Record<string, any>;
  actionId?: string;
}

interface Session {
  id: string;
  title: string;
  messageCount: number;
  status?: string;
  summary?: string;
}

const ACTION_LABELS: Record<string, { label: string; icon: any; color: string }> = {
  // 献立関連
  generate_day_menu: { label: '1日の献立を作成', icon: Calendar, color: colors.primary },
  generate_week_menu: { label: '1週間の献立を作成', icon: Calendar, color: colors.primary },
  create_meal: { label: '食事を登録', icon: Plus, color: colors.success },
  update_meal: { label: '献立を変更', icon: Edit, color: colors.warning },
  delete_meal: { label: '献立を削除', icon: Trash2, color: '#EF4444' },
  complete_meal: { label: '食事を完了', icon: CheckCircle, color: colors.success },
  
  // 買い物リスト関連
  add_to_shopping_list: { label: '買い物リストに追加', icon: ShoppingCart, color: colors.success },
  update_shopping_item: { label: '買い物リストを更新', icon: Edit, color: colors.warning },
  delete_shopping_item: { label: '買い物リストから削除', icon: Trash2, color: '#EF4444' },
  check_shopping_item: { label: '買い物をチェック', icon: CheckCircle, color: colors.success },
  
  // 冷蔵庫/パントリー関連
  add_pantry_item: { label: '冷蔵庫に追加', icon: Refrigerator, color: colors.secondary },
  update_pantry_item: { label: '冷蔵庫を更新', icon: Edit, color: colors.warning },
  delete_pantry_item: { label: '冷蔵庫から削除', icon: Trash2, color: '#EF4444' },
  
  // レシピ関連
  suggest_recipe: { label: 'レシピを提案', icon: BookOpen, color: colors.secondary },
  like_recipe: { label: 'レシピにいいね', icon: Heart, color: '#EC4899' },
  add_recipe_to_collection: { label: 'コレクションに追加', icon: FolderPlus, color: colors.purple },
  
  // 栄養目標関連
  update_nutrition_target: { label: '栄養目標を更新', icon: Target, color: colors.purple },
  
  // 健康目標関連
  set_health_goal: { label: '健康目標を設定', icon: Target, color: colors.success },
  update_health_goal: { label: '健康目標を更新', icon: Edit, color: colors.warning },
  delete_health_goal: { label: '健康目標を削除', icon: Trash2, color: '#EF4444' },
  
  // 健康記録関連
  add_health_record: { label: '健康記録を追加', icon: Activity, color: colors.success },
  update_health_record: { label: '健康記録を更新', icon: Edit, color: colors.warning },
  
  // プロフィール関連
  update_profile_preferences: { label: '好み・習慣を更新', icon: User, color: colors.secondary },
};

export default function AIChatBubble() {
  const [isMounted, setIsMounted] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [executingActionId, setExecutingActionId] = useState<string | null>(null);
  const [showSessionList, setShowSessionList] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [showMessageMenu, setShowMessageMenu] = useState<string | null>(null);
  const [isClosingSession, setIsClosingSession] = useState(false);
  const [showDayMenuModal, setShowDayMenuModal] = useState(false);
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [v4Progress, setV4Progress] = useState<string | null>(null);

  // V4 献立生成フック
  const {
    isGenerating: isGeneratingDayMenu,
    generate: generateV4,
    subscribeToProgress,
  } = useV4MenuGeneration({
    onGenerationComplete: () => {
      setV4Progress(null);
      // 成功メッセージをチャットに追加
      setMessages(prev => [...prev, {
        id: `v4-success-${Date.now()}`,
        role: 'assistant',
        content: '✅ 献立の作成が完了しました！献立表で確認できます。',
        createdAt: new Date().toISOString(),
      }]);
      // 他のコンポーネントに通知
      window.dispatchEvent(new CustomEvent('mealPlanUpdated', {
        detail: { actionType: 'generate_day_menu' }
      }));
    },
    onError: (error) => {
      setV4Progress(null);
      setMessages(prev => [...prev, {
        id: `v4-error-${Date.now()}`,
        role: 'assistant',
        content: `❌ 献立の作成に失敗しました: ${error}`,
        createdAt: new Date().toISOString(),
      }]);
    },
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const streamingRef = useRef<{ messageId: string; fullContent: string; currentIndex: number } | null>(null);
  const streamingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // クライアントサイドでのみレンダリング
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // スクロールを最下部に
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (messages.length > 0) {
      scrollToBottom();
    }
  }, [messages]);

  // ストリーミング表示のクリーンアップ
  useEffect(() => {
    return () => {
      if (streamingIntervalRef.current) {
        clearInterval(streamingIntervalRef.current);
      }
    };
  }, []);

  // ストリーミング表示を開始
  const startStreaming = (messageId: string, fullContent: string) => {
    // 既存のストリーミングをクリア
    if (streamingIntervalRef.current) {
      clearInterval(streamingIntervalRef.current);
    }

    streamingRef.current = {
      messageId,
      fullContent,
      currentIndex: 0,
    };

    // 1文字ずつではなく、チャンク単位で表示（より自然に見える）
    const chunkSize = 3; // 一度に表示する文字数
    const intervalMs = 20; // 更新間隔（ミリ秒）

    streamingIntervalRef.current = setInterval(() => {
      if (!streamingRef.current) {
        clearInterval(streamingIntervalRef.current!);
        return;
      }

      const { messageId, fullContent, currentIndex } = streamingRef.current;
      const nextIndex = Math.min(currentIndex + chunkSize, fullContent.length);
      const displayContent = fullContent.slice(0, nextIndex);

      setMessages(prev => prev.map(m => 
        m.id === messageId 
          ? { ...m, content: displayContent, isStreaming: nextIndex < fullContent.length }
          : m
      ));

      if (nextIndex >= fullContent.length) {
        // ストリーミング完了
        clearInterval(streamingIntervalRef.current!);
        streamingRef.current = null;
        scrollToBottom();
      } else {
        streamingRef.current.currentIndex = nextIndex;
      }
    }, intervalMs);
  };

  // セッション一覧取得
  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/consultation/sessions?status=all');
      if (res.status === 401) {
        setIsAuthenticated(false);
        return false;
      }
      if (res.ok) {
        setIsAuthenticated(true);
        const data = await res.json();
        setSessions(data.sessions || []);
        return true;
      }
      return false;
    } catch (e) {
      console.error('Failed to fetch sessions:', e);
      return false;
    }
  }, []);

  // メッセージ取得
  const fetchMessages = useCallback(async (sessionId: string) => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/ai/consultation/sessions/${sessionId}/messages`);
      if (res.ok) {
        const data = await res.json();
        setMessages((data.messages || []).map((m: any) => ({
          ...m,
          isImportant: m.isImportant || false,
        })));
      }
    } catch (e) {
      console.error('Failed to fetch messages:', e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // チャットを開く
  const openChat = async () => {
    setIsOpen(true);
    setHasUnread(false);
    const authenticated = await fetchSessions();
    
    if (!authenticated) {
      return; // 認証されていない場合は何もしない
    }
    
    // 既存のアクティブセッションがあればそれを使う、なければ新規作成
    if (sessions.length > 0 && !currentSessionId) {
      const activeSession = sessions.find(s => s.messageCount > 0) || sessions[0];
      setCurrentSessionId(activeSession.id);
      await fetchMessages(activeSession.id);
    } else if (!currentSessionId) {
      await createNewSession();
    } else {
      await fetchMessages(currentSessionId);
    }
  };

  // 新規セッション作成
  const createNewSession = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/ai/consultation/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'AI相談' }),
      });
      
      if (res.ok) {
        const data = await res.json();
        setCurrentSessionId(data.session.id);
        setMessages([]);
        setShowSessionList(false);
        
        // 初期メッセージを表示
        setMessages([{
          id: 'welcome',
          role: 'assistant',
          content: 'こんにちは！🍳 ほめゴハンのAIアドバイザーです。\n\n食事や栄養のことで気になることがあれば、何でも聞いてくださいね。献立の提案や、買い物リストの作成もお手伝いできますよ！',
          createdAt: new Date().toISOString(),
        }]);
      }
    } catch (e) {
      console.error('Failed to create session:', e);
    } finally {
      setIsLoading(false);
    }
  };

  // メッセージ送信（リアルストリーミング対応）
  const sendMessage = async () => {
    if (!inputText.trim() || !currentSessionId || isSending) return;

    const userMessage = inputText.trim();
    setInputText('');
    setIsSending(true);

    // 楽観的UI更新：ユーザーメッセージを即時表示
    const tempUserMsgId = `temp-user-${Date.now()}`;
    const tempAiMsgId = `temp-ai-${Date.now()}`;

    setMessages(prev => [
      ...prev,
      {
        id: tempUserMsgId,
        role: 'user',
        content: userMessage,
        createdAt: new Date().toISOString(),
      },
      {
        id: tempAiMsgId,
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString(),
        isStreaming: true,
      },
    ]);

    try {
      // ストリーミングモードでAPI呼び出し
      const res = await fetch(`/api/ai/consultation/sessions/${currentSessionId}/messages?stream=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage }),
      });

      if (!res.ok) {
        throw new Error(`HTTP error: ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) {
        throw new Error('No reader available');
      }

      const decoder = new TextDecoder();
      let accumulatedContent = '';
      let finalData: any = null;

      // SSEストリームを読み取り
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);

            if (data === '[DONE]') {
              // ストリーム完了
              continue;
            }

            try {
              const parsed = JSON.parse(data);

              // 最終データ（メタ情報含む）
              if (parsed.userMessage && parsed.aiMessage) {
                finalData = parsed;
                continue;
              }

              // コンテンツチャンク
              if (parsed.choices?.[0]?.delta?.content) {
                accumulatedContent += parsed.choices[0].delta.content;

                // UIをリアルタイム更新
                setMessages(prev => prev.map(m =>
                  m.id === tempAiMsgId
                    ? { ...m, content: accumulatedContent }
                    : m
                ));
              }
            } catch {
              // JSONパースエラーは無視
            }
          }
        }
      }

      // ストリーム完了後：メッセージを最終状態に更新
      if (finalData) {
        setMessages(prev => prev.map(m => {
          if (m.id === tempUserMsgId) {
            return {
              ...m,
              id: finalData.userMessage.id,
              isImportant: finalData.userMessage.isImportant || false,
            };
          }
          if (m.id === tempAiMsgId) {
            return {
              ...m,
              id: finalData.aiMessage.id,
              content: accumulatedContent || finalData.aiMessage.content,
              proposedActions: finalData.aiMessage.proposedActions ? {
                ...finalData.aiMessage.proposedActions,
                actionId: finalData.aiMessage.id,
              } : null,
              isStreaming: false,
            };
          }
          return m;
        }));

        // アクション自動実行結果を表示
        if (finalData.actionExecuted && finalData.actionResult) {
          setTimeout(() => {
            setMessages(prev => [...prev, {
              id: `action-result-${Date.now()}`,
              role: 'assistant',
              content: `✅ ${ACTION_LABELS[finalData.actionResult.actionType]?.label || 'アクション'}を実行しました！`,
              createdAt: new Date().toISOString(),
            }]);

            window.dispatchEvent(new CustomEvent('mealPlanUpdated', {
              detail: { actionType: finalData.actionResult.actionType, result: finalData.actionResult.result }
            }));
          }, 300);
        }
      } else {
        // finalDataがない場合（フォールバック）
        setMessages(prev => prev.map(m =>
          m.id === tempAiMsgId
            ? { ...m, content: accumulatedContent, isStreaming: false }
            : m
        ));
      }

    } catch (e) {
      console.error('Failed to send message:', e);
      // エラー時は一時メッセージを削除してエラー表示
      setMessages(prev => prev.filter(m => m.id !== tempUserMsgId && m.id !== tempAiMsgId));
      alert('メッセージの送信に失敗しました');
    } finally {
      setIsSending(false);
    }
  };

  // アクション実行
  const executeAction = async (actionId: string, messageId: string) => {
    setExecutingActionId(messageId);
    try {
      // まずアクションログを取得
      const res = await fetch(`/api/ai/consultation/actions/${messageId}/execute`, {
        method: 'POST',
      });

      if (res.ok) {
        const data = await res.json();
        
        // 成功メッセージを追加
        setMessages(prev => [
          ...prev,
          {
            id: `action-result-${Date.now()}`,
            role: 'assistant',
            content: `✅ ${ACTION_LABELS[data.actionType]?.label || 'アクション'}を実行しました！`,
            createdAt: new Date().toISOString(),
          },
        ]);

        // アクションを削除（実行済みとして）
        setMessages(prev => prev.map(m => 
          m.id === messageId ? { ...m, proposedActions: null } : m
        ));

        // 他のコンポーネントにデータ更新を通知（献立表ページなど）
        window.dispatchEvent(new CustomEvent('mealPlanUpdated', { 
          detail: { actionType: data.actionType, result: data.result }
        }));
      } else {
        alert('アクションの実行に失敗しました');
      }
    } catch (e) {
      console.error('Failed to execute action:', e);
    } finally {
      setExecutingActionId(null);
    }
  };

  // アクション拒否
  const rejectAction = async (messageId: string) => {
    try {
      await fetch(`/api/ai/consultation/actions/${messageId}/execute`, {
        method: 'DELETE',
      });
      
      // アクションを削除
      setMessages(prev => prev.map(m => 
        m.id === messageId ? { ...m, proposedActions: null } : m
      ));
    } catch (e) {
      console.error('Failed to reject action:', e);
    }
  };

  // セッション切り替え
  const switchSession = async (sessionId: string) => {
    setCurrentSessionId(sessionId);
    setShowSessionList(false);
    await fetchMessages(sessionId);
  };

  // 重要マークをトグル
  const toggleImportant = async (messageId: string) => {
    if (!currentSessionId) return;
    
    try {
      const res = await fetch(
        `/api/ai/consultation/sessions/${currentSessionId}/messages/${messageId}/important`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );
      
      if (res.ok) {
        const data = await res.json();
        setMessages(prev => prev.map(m => 
          m.id === messageId ? { ...m, isImportant: data.isImportant } : m
        ));
      }
    } catch (e) {
      console.error('Failed to toggle important:', e);
    }
    setShowMessageMenu(null);
  };

  // セッションを終了して要約を生成
  const closeSession = async () => {
    if (!currentSessionId || isClosingSession) return;

    setIsClosingSession(true);
    try {
      const res = await fetch(
        `/api/ai/consultation/sessions/${currentSessionId}/close`,
        { method: 'POST' }
      );

      if (res.ok) {
        const data = await res.json();
        // セッション一覧を更新
        await fetchSessions();
        // 新しいセッションを作成
        await createNewSession();

        if (data.summary) {
          // 要約完了メッセージを表示
          setMessages(prev => [
            ...prev,
            {
              id: `summary-${Date.now()}`,
              role: 'assistant',
              content: `📝 前回の相談を要約しました：\n\n${data.summary.summary}\n\nトピック: ${(data.summary.key_topics || []).join(', ')}`,
              createdAt: new Date().toISOString(),
            },
          ]);
        }
      }
    } catch (e) {
      console.error('Failed to close session:', e);
    } finally {
      setIsClosingSession(false);
    }
  };

  // 1日献立変更を実行（V4直接呼び出し）
  const generateDayMenu = async () => {
    if (isGeneratingDayMenu) return;

    setShowDayMenuModal(false);

    // 日付をフォーマット
    const dateObj = new Date(selectedDate);
    const formattedDate = `${dateObj.getMonth() + 1}月${dateObj.getDate()}日`;

    // 開始メッセージをチャットに追加
    setMessages(prev => [...prev, {
      id: `v4-start-${Date.now()}`,
      role: 'assistant',
      content: `🍳 ${formattedDate}の献立を作成中...`,
      createdAt: new Date().toISOString(),
    }]);

    try {
      // V4 API を直接呼び出し
      const targetSlots = [
        { date: selectedDate, mealType: 'breakfast' as const },
        { date: selectedDate, mealType: 'lunch' as const },
        { date: selectedDate, mealType: 'dinner' as const },
      ];

      const result = await generateV4({
        targetSlots,
        resolveExistingMeals: true,
        constraints: {},
        note: `${formattedDate}の献立を作成`,
        ultimateMode: false,
      });

      // 進捗を購読
      if (result?.requestId) {
        subscribeToProgress(result.requestId, (progress) => {
          if (progress.message) {
            setV4Progress(progress.message);
          }
        });
      }
    } catch (e: any) {
      console.error('Failed to generate day menu:', e);
      // エラーはフックのonErrorで処理される
    }
  };

  // サーバーサイドでは何もレンダリングしない
  if (!isMounted) {
    return null;
  }

  return (
    <>
      {/* チャットバブルボタン */}
      <AnimatePresence>
        {!isOpen && (
          <motion.button
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.95 }}
            onClick={openChat}
            className="fixed bottom-24 right-4 z-[40] w-14 h-14 rounded-full shadow-lg flex items-center justify-center"
            style={{ 
              background: `linear-gradient(135deg, ${colors.primary} 0%, ${colors.warning} 100%)`,
            }}
          >
            <Sparkles size={24} color="#fff" />
            {hasUnread && (
              <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full border-2 border-white" />
            )}
          </motion.button>
        )}
      </AnimatePresence>

      {/* チャットウィンドウ */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 100, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 100, scale: 0.9 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed bottom-24 right-4 z-[30] w-[calc(100vw-32px)] max-w-[380px] h-[500px] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
            style={{ background: colors.bg }}
          >
            {/* ヘッダー */}
            <div 
              className="flex items-center justify-between px-4 py-3 border-b"
              style={{ background: colors.card, borderColor: colors.border }}
            >
              <div className="flex items-center gap-2">
                <div 
                  className="w-8 h-8 rounded-full flex items-center justify-center"
                  style={{ background: `linear-gradient(135deg, ${colors.primary} 0%, ${colors.warning} 100%)` }}
                >
                  <Sparkles size={16} color="#fff" />
                </div>
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 600, color: colors.text, margin: 0 }}>
                    AIアドバイザー
                  </h3>
                  <p style={{ fontSize: 11, color: colors.textMuted, margin: 0 }}>
                    いつでも相談できます
                  </p>
                </div>
              </div>
              
              <div className="flex items-center gap-1">
                <button
                  onClick={closeSession}
                  disabled={isClosingSession || !currentSessionId}
                  className="p-2 rounded-full hover:bg-gray-100"
                  title="相談を終了して要約を保存"
                >
                  {isClosingSession ? (
                    <Loader2 size={16} color={colors.textMuted} className="animate-spin" />
                  ) : (
                    <Archive size={16} color={colors.textMuted} />
                  )}
                </button>
                <button
                  onClick={() => setShowSessionList(!showSessionList)}
                  className="p-2 rounded-full hover:bg-gray-100"
                >
                  <ChevronDown size={18} color={colors.textMuted} />
                </button>
                <button
                  onClick={() => setIsOpen(false)}
                  className="p-2 rounded-full hover:bg-gray-100"
                >
                  <X size={18} color={colors.textMuted} />
                </button>
              </div>
            </div>

            {/* セッションリスト（ドロップダウン） */}
            <AnimatePresence>
              {showSessionList && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="border-b overflow-hidden"
                  style={{ background: colors.card, borderColor: colors.border }}
                >
                  <div className="p-2 max-h-40 overflow-y-auto">
                    <button
                      onClick={createNewSession}
                      className="w-full px-3 py-2 rounded-lg text-left flex items-center gap-2 hover:bg-gray-100"
                    >
                      <MessageCircle size={14} color={colors.primary} />
                      <span style={{ fontSize: 13, color: colors.primary, fontWeight: 500 }}>
                        新しい相談を始める
                      </span>
                    </button>
                    
                    {sessions.map(session => (
                      <button
                        key={session.id}
                        onClick={() => switchSession(session.id)}
                        className={`w-full px-3 py-2 rounded-lg text-left hover:bg-gray-100 ${
                          currentSessionId === session.id ? 'bg-gray-100' : ''
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span style={{ fontSize: 13, color: colors.text }}>
                            {session.title}
                          </span>
                          {session.status === 'closed' && (
                            <span 
                              className="px-1.5 py-0.5 rounded text-[10px]"
                              style={{ background: colors.border, color: colors.textMuted }}
                            >
                              終了
                            </span>
                          )}
                          <span style={{ fontSize: 11, color: colors.textMuted }}>
                            ({session.messageCount}件)
                          </span>
                        </div>
                        {session.summary && (
                          <p style={{ fontSize: 11, color: colors.textMuted, marginTop: 2 }} className="truncate">
                            {session.summary}
                          </p>
                        )}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* メッセージエリア */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {isAuthenticated === false ? (
                <div className="flex flex-col items-center justify-center h-full text-center px-4">
                  <div 
                    className="w-16 h-16 rounded-full flex items-center justify-center mb-4"
                    style={{ background: colors.primaryLight }}
                  >
                    <Sparkles size={28} color={colors.primary} />
                  </div>
                  <h4 style={{ fontSize: 16, fontWeight: 600, color: colors.text, margin: '0 0 8px 0' }}>
                    ログインが必要です
                  </h4>
                  <p style={{ fontSize: 13, color: colors.textMuted, margin: '0 0 16px 0', lineHeight: 1.5 }}>
                    AIアドバイザーと相談するには<br />ログインしてください
                  </p>
                  <a
                    href="/login"
                    className="px-6 py-2 rounded-full"
                    style={{ background: colors.primary, color: '#fff', fontSize: 14, fontWeight: 500, textDecoration: 'none' }}
                  >
                    ログインする
                  </a>
                </div>
              ) : isLoading ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 size={24} color={colors.primary} className="animate-spin" />
                </div>
              ) : (
                <>
                  {messages.map((msg) => (
                    <div key={msg.id} className="group relative">
                      {/* メッセージバブル */}
                      <div className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className="relative max-w-[85%]">
                          {/* 重要マーク */}
                          {msg.isImportant && (
                            <div 
                              className="absolute -top-1 -left-1 w-4 h-4 rounded-full flex items-center justify-center z-10"
                              style={{ background: colors.warning }}
                            >
                              <Star size={10} color="#fff" fill="#fff" />
                            </div>
                          )}
                          
                          <div
                            className="px-3 py-2 rounded-2xl markdown-content"
                            style={{
                              background: msg.role === 'user' ? colors.primary : colors.card,
                              color: msg.role === 'user' ? '#fff' : colors.text,
                              borderBottomRightRadius: msg.role === 'user' ? 4 : 16,
                              borderBottomLeftRadius: msg.role === 'user' ? 16 : 4,
                              boxShadow: msg.role === 'assistant' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                              border: msg.isImportant ? `2px solid ${colors.warning}` : 'none',
                            }}
                          >
                            {msg.role === 'user' ? (
                              <p style={{ fontSize: 14, margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                                {msg.content}
                              </p>
                            ) : (
                              <div 
                                className="markdown-body"
                                style={{ fontSize: 14, lineHeight: 1.6 }}
                              >
                                <span dangerouslySetInnerHTML={{ __html: parseMarkdown(msg.content) }} />
                                {msg.isStreaming && (
                                  <span className="streaming-cursor" />
                                )}
                              </div>
                            )}
                          </div>

                          {/* メッセージメニューボタン */}
                          {!msg.id.startsWith('temp-') && !msg.id.startsWith('welcome') && !msg.id.startsWith('action-') && !msg.id.startsWith('summary-') && (
                            <button
                              onClick={() => setShowMessageMenu(showMessageMenu === msg.id ? null : msg.id)}
                              className="absolute top-1 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-full hover:bg-gray-200"
                              style={{ 
                                right: msg.role === 'user' ? 'auto' : -24,
                                left: msg.role === 'user' ? -24 : 'auto',
                              }}
                            >
                              <MoreVertical size={14} color={colors.textMuted} />
                            </button>
                          )}

                          {/* メッセージメニュー */}
                          {showMessageMenu === msg.id && (
                            <div 
                              className="absolute top-6 z-20 py-1 rounded-lg shadow-lg border"
                              style={{ 
                                background: colors.card, 
                                borderColor: colors.border,
                                right: msg.role === 'user' ? 'auto' : -80,
                                left: msg.role === 'user' ? -80 : 'auto',
                              }}
                            >
                              <button
                                onClick={() => toggleImportant(msg.id)}
                                className="w-full px-3 py-2 text-left hover:bg-gray-100 flex items-center gap-2"
                              >
                                <Star size={14} color={msg.isImportant ? colors.warning : colors.textMuted} fill={msg.isImportant ? colors.warning : 'none'} />
                                <span style={{ fontSize: 12, color: colors.text }}>
                                  {msg.isImportant ? '重要を解除' : '重要としてマーク'}
                                </span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* アクション提案カード */}
                      {msg.proposedActions && (
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="mt-2 ml-2"
                        >
                          <div 
                            className="p-3 rounded-xl border"
                            style={{ 
                              background: colors.purpleLight, 
                              borderColor: colors.purple + '40',
                            }}
                          >
                            <div className="flex items-center gap-2 mb-2">
                              {(() => {
                                const actionInfo = ACTION_LABELS[msg.proposedActions.type];
                                const Icon = actionInfo?.icon || Sparkles;
                                return (
                                  <>
                                    <Icon size={16} color={actionInfo?.color || colors.purple} />
                                    <span style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>
                                      {actionInfo?.label || msg.proposedActions.type}
                                    </span>
                                  </>
                                );
                              })()}
                            </div>
                            
                            <div className="flex gap-2">
                              <button
                                onClick={() => executeAction(msg.proposedActions!.type, msg.id)}
                                disabled={executingActionId === msg.id}
                                className="flex-1 py-2 rounded-lg flex items-center justify-center gap-1"
                                style={{ background: colors.success, opacity: executingActionId === msg.id ? 0.7 : 1 }}
                              >
                                {executingActionId === msg.id ? (
                                  <Loader2 size={14} color="#fff" className="animate-spin" />
                                ) : (
                                  <Check size={14} color="#fff" />
                                )}
                                <span style={{ fontSize: 12, color: '#fff', fontWeight: 500 }}>
                                  実行する
                                </span>
                              </button>
                              <button
                                onClick={() => rejectAction(msg.id)}
                                className="px-3 py-2 rounded-lg"
                                style={{ background: colors.border }}
                              >
                                <XCircle size={14} color={colors.textMuted} />
                              </button>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </div>
                  ))}
                  
                  {isSending && (
                    <div className="flex justify-start">
                      <div 
                        className="px-4 py-3 rounded-2xl"
                        style={{ background: colors.card, borderBottomLeftRadius: 4 }}
                      >
                        <div className="flex gap-1">
                          <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                          <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                          <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                      </div>
                    </div>
                  )}
                  
                  <div ref={messagesEndRef} />
                </>
              )}
            </div>

            {/* クイックアクションバー */}
            {isAuthenticated !== false && currentSessionId && (
              <div
                className="px-3 pt-2 pb-1 border-t flex gap-2 overflow-x-auto"
                style={{ background: colors.card, borderColor: colors.border }}
              >
                <button
                  onClick={() => setShowDayMenuModal(true)}
                  disabled={isSending || isGeneratingDayMenu}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border whitespace-nowrap hover:bg-gray-50 transition-colors"
                  style={{ borderColor: colors.primary, opacity: (isSending || isGeneratingDayMenu) ? 0.5 : 1 }}
                >
                  <CalendarDays size={14} color={colors.primary} />
                  <span style={{ fontSize: 12, color: colors.primary, fontWeight: 500 }}>
                    1日献立変更
                  </span>
                </button>
              </div>
            )}

            {/* 入力エリア */}
            {isAuthenticated !== false && (
              <div
                className="p-3 border-t"
                style={{ background: colors.card, borderColor: colors.border }}
              >
                <div className="flex items-center gap-2">
                  <input
                    ref={inputRef}
                    type="text"
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={(e) => {
                      // IME変換中（日本語入力の変換確定時など）は送信しない
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage();
                      }
                    }}
                    placeholder="メッセージを入力..."
                    className="flex-1 px-4 py-2 rounded-full border-none outline-none"
                    style={{
                      background: colors.bg,
                      fontSize: 14,
                      color: colors.text,
                    }}
                    disabled={isSending || !currentSessionId}
                  />
                  <button
                    onClick={sendMessage}
                    disabled={!inputText.trim() || isSending || !currentSessionId}
                    className="w-10 h-10 rounded-full flex items-center justify-center"
                    style={{
                      background: inputText.trim() ? colors.primary : colors.border,
                      opacity: isSending ? 0.7 : 1,
                    }}
                  >
                    <Send size={18} color={inputText.trim() ? '#fff' : colors.textMuted} />
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 1日献立変更モーダル */}
      <AnimatePresence>
        {showDayMenuModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-[50]"
            onClick={() => setShowDayMenuModal(false)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-white rounded-2xl p-5 mx-4 w-full max-w-[320px] shadow-xl"
            >
              <div className="flex items-center gap-3 mb-4">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center"
                  style={{ background: colors.primaryLight }}
                >
                  <CalendarDays size={20} color={colors.primary} />
                </div>
                <div>
                  <h3 style={{ fontSize: 16, fontWeight: 600, color: colors.text, margin: 0 }}>
                    1日献立変更
                  </h3>
                  <p style={{ fontSize: 12, color: colors.textMuted, margin: 0 }}>
                    選択した日の献立を作り直します
                  </p>
                </div>
              </div>

              <div className="mb-4">
                <label style={{ fontSize: 13, color: colors.textLight, marginBottom: 6, display: 'block' }}>
                  日付を選択
                </label>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  min={new Date().toISOString().split('T')[0]}
                  max={(() => {
                    const maxDate = new Date();
                    maxDate.setDate(maxDate.getDate() + 14);
                    return maxDate.toISOString().split('T')[0];
                  })()}
                  className="w-full px-4 py-3 rounded-xl border text-center"
                  style={{
                    borderColor: colors.border,
                    fontSize: 16,
                    color: colors.text,
                    background: colors.bg,
                  }}
                />
                <p style={{ fontSize: 11, color: colors.textMuted, marginTop: 6, textAlign: 'center' }}>
                  今日から2週間先まで選択できます
                </p>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => setShowDayMenuModal(false)}
                  className="flex-1 py-3 rounded-xl"
                  style={{ background: colors.border, color: colors.textLight, fontSize: 14, fontWeight: 500 }}
                >
                  キャンセル
                </button>
                <button
                  onClick={generateDayMenu}
                  disabled={isGeneratingDayMenu}
                  className="flex-1 py-3 rounded-xl flex items-center justify-center gap-2"
                  style={{ background: colors.primary, color: '#fff', fontSize: 14, fontWeight: 500, opacity: isGeneratingDayMenu ? 0.7 : 1 }}
                >
                  {isGeneratingDayMenu ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Check size={16} />
                  )}
                  作成する
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* マークダウン用スタイル */}
      <style jsx global>{`
        .markdown-body {
          word-wrap: break-word;
        }
        .markdown-body strong {
          font-weight: 600;
        }
        .markdown-body em {
          font-style: italic;
        }
        .markdown-body .md-h2 {
          font-size: 18px;
          font-weight: 700;
          margin: 12px 0 8px 0;
        }
        .markdown-body .md-h3 {
          font-size: 16px;
          font-weight: 600;
          margin: 10px 0 6px 0;
        }
        .markdown-body .md-h4 {
          font-size: 14px;
          font-weight: 600;
          margin: 8px 0 4px 0;
        }
        .markdown-body .md-ul,
        .markdown-body .md-ol {
          margin: 8px 0;
          padding-left: 20px;
        }
        .markdown-body .md-li {
          list-style-type: disc;
          margin: 4px 0;
        }
        .markdown-body .md-li-num {
          list-style-type: decimal;
          margin: 4px 0;
        }
        .markdown-body .md-inline-code {
          background: rgba(0,0,0,0.08);
          padding: 2px 6px;
          border-radius: 4px;
          font-family: monospace;
          font-size: 13px;
        }
        .markdown-body .md-code-block {
          background: rgba(0,0,0,0.08);
          padding: 12px;
          border-radius: 8px;
          margin: 8px 0;
          overflow-x: auto;
        }
        .markdown-body .md-code-block code {
          font-family: monospace;
          font-size: 13px;
          white-space: pre-wrap;
        }
        .markdown-body .md-link {
          color: #3B82F6;
          text-decoration: underline;
        }
        .markdown-body .md-link:hover {
          color: #2563EB;
        }
        .streaming-cursor {
          display: inline-block;
          width: 2px;
          height: 1em;
          background: ${colors.primary};
          margin-left: 2px;
          animation: blink 0.8s infinite;
          vertical-align: text-bottom;
        }
        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
      `}</style>
    </>
  );
}
