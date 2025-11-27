"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  MessageCircle, X, Send, Sparkles, ChevronDown, 
  Check, XCircle, Loader2, Calendar, ShoppingCart, 
  Target, UtensilsCrossed, BookOpen
} from "lucide-react";

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
}

const ACTION_LABELS: Record<string, { label: string; icon: any; color: string }> = {
  generate_day_menu: { label: '今日の献立を作成', icon: Calendar, color: colors.primary },
  generate_week_menu: { label: '1週間の献立を作成', icon: Calendar, color: colors.primary },
  update_meal: { label: '献立を変更', icon: UtensilsCrossed, color: colors.warning },
  add_to_shopping_list: { label: '買い物リストに追加', icon: ShoppingCart, color: colors.success },
  suggest_recipe: { label: 'レシピを提案', icon: BookOpen, color: colors.secondary },
  update_nutrition_target: { label: '栄養目標を更新', icon: Target, color: colors.purple },
  set_health_goal: { label: '健康目標を設定', icon: Target, color: colors.success },
};

export default function AIChatBubble() {
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
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // スクロールを最下部に
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (messages.length > 0) {
      scrollToBottom();
    }
  }, [messages]);

  // セッション一覧取得
  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/consultation/sessions?status=all');
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions || []);
      }
    } catch (e) {
      console.error('Failed to fetch sessions:', e);
    }
  }, []);

  // メッセージ取得
  const fetchMessages = useCallback(async (sessionId: string) => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/ai/consultation/sessions/${sessionId}/messages`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || []);
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
    await fetchSessions();
    
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

  // メッセージ送信
  const sendMessage = async () => {
    if (!inputText.trim() || !currentSessionId || isSending) return;

    const userMessage = inputText.trim();
    setInputText('');
    setIsSending(true);

    // 楽観的UI更新
    const tempUserMsg: Message = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: userMessage,
      createdAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, tempUserMsg]);

    try {
      const res = await fetch(`/api/ai/consultation/sessions/${currentSessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage }),
      });

      if (res.ok) {
        const data = await res.json();
        
        // 一時メッセージを実際のメッセージに置き換え
        setMessages(prev => {
          const filtered = prev.filter(m => m.id !== tempUserMsg.id);
          return [
            ...filtered,
            {
              id: data.userMessage.id,
              role: 'user',
              content: data.userMessage.content,
              createdAt: data.userMessage.createdAt,
            },
            {
              id: data.aiMessage.id,
              role: 'assistant',
              content: data.aiMessage.content,
              proposedActions: data.aiMessage.proposedActions ? {
                ...data.aiMessage.proposedActions,
                actionId: data.aiMessage.id, // アクションIDとしてメッセージIDを使用
              } : null,
              createdAt: data.aiMessage.createdAt,
            },
          ];
        });
      } else {
        // エラー時は一時メッセージを削除
        setMessages(prev => prev.filter(m => m.id !== tempUserMsg.id));
        alert('メッセージの送信に失敗しました');
      }
    } catch (e) {
      console.error('Failed to send message:', e);
      setMessages(prev => prev.filter(m => m.id !== tempUserMsg.id));
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
            className="fixed bottom-24 right-4 z-50 w-14 h-14 rounded-full shadow-lg flex items-center justify-center"
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
            className="fixed bottom-24 right-4 z-50 w-[calc(100vw-32px)] max-w-[380px] h-[500px] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
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
                        <span style={{ fontSize: 13, color: colors.text }}>
                          {session.title}
                        </span>
                        <span style={{ fontSize: 11, color: colors.textMuted, marginLeft: 8 }}>
                          ({session.messageCount}件)
                        </span>
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* メッセージエリア */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {isLoading ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 size={24} color={colors.primary} className="animate-spin" />
                </div>
              ) : (
                <>
                  {messages.map((msg) => (
                    <div key={msg.id}>
                      {/* メッセージバブル */}
                      <div className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div
                          className="max-w-[85%] px-3 py-2 rounded-2xl"
                          style={{
                            background: msg.role === 'user' ? colors.primary : colors.card,
                            color: msg.role === 'user' ? '#fff' : colors.text,
                            borderBottomRightRadius: msg.role === 'user' ? 4 : 16,
                            borderBottomLeftRadius: msg.role === 'user' ? 16 : 4,
                            boxShadow: msg.role === 'assistant' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                          }}
                        >
                          <p style={{ fontSize: 14, margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                            {msg.content}
                          </p>
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

            {/* 入力エリア */}
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
                  onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && sendMessage()}
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
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

