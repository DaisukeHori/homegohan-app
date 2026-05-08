'use client';

/**
 * チケット詳細 + メッセージスレッド + 担当割り当て
 * operator/03-ui-spec.md §16 準拠
 * 権限: support, admin, super_admin
 * 内部メモ (is_internal=true): 薄黄色背景で視覚的区別
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface Message {
  id: string;
  sender_id: string;
  is_internal: boolean;
  body: string;
  created_at: string;
}

interface Ticket {
  id: string;
  user_id: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  assignee_id: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  messages: Message[];
}

const STATUS_LABELS: Record<string, string> = {
  open: '未対応',
  in_progress: '対応中',
  pending: '保留',
  resolved: '解決済',
  closed: 'クローズ',
};

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-blue-100 text-blue-800',
  in_progress: 'bg-yellow-100 text-yellow-800',
  pending: 'bg-gray-100 text-gray-700',
  resolved: 'bg-green-100 text-green-800',
  closed: 'bg-gray-200 text-gray-600',
};

const PRIORITY_COLORS: Record<string, string> = {
  low: 'bg-gray-100 text-gray-600',
  medium: 'bg-blue-100 text-blue-700',
  high: 'bg-orange-100 text-orange-700',
  urgent: 'bg-red-100 text-red-800',
};

type PageProps = { params: { id: string } };

export default function TicketDetailPage({ params }: PageProps) {
  const router = useRouter();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [messageBody, setMessageBody] = useState('');
  const [isInternal, setIsInternal] = useState(false);
  const [isSending, setIsSending] = useState(false);

  const [assigneeId, setAssigneeId] = useState('');
  const [isAssigning, setIsAssigning] = useState(false);

  const [statusChanging, setStatusChanging] = useState(false);

  const fetchTicket = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/support/tickets/${params.id}`);
      if (res.status === 401) { router.push('/login'); return; }
      if (res.status === 403) { setError('権限がありません'); return; }
      if (res.status === 404) { setError('チケットが見つかりません'); return; }
      if (!res.ok) throw new Error('取得失敗');
      const json = await res.json();
      setTicket(json.data);
      setAssigneeId(json.data.assignee_id ?? '');
    } catch {
      setError('チケットの取得に失敗しました');
    } finally {
      setIsLoading(false);
    }
  }, [params.id, router]);

  useEffect(() => { fetchTicket(); }, [fetchTicket]);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [ticket?.messages]);

  const handleSendMessage = async () => {
    if (!messageBody.trim()) return;
    setIsSending(true);
    try {
      const res = await fetch(`/api/admin/support/tickets/${params.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: messageBody, is_internal: isInternal }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error?.message ?? '送信失敗');
      }
      setMessageBody('');
      await fetchTicket();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '送信失敗');
    } finally {
      setIsSending(false);
    }
  };

  const handleAssign = async () => {
    if (!assigneeId.trim()) return;
    setIsAssigning(true);
    try {
      const res = await fetch(`/api/admin/support/tickets/${params.id}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignee_id: assigneeId }),
      });
      if (!res.ok) throw new Error('割り当て失敗');
      await fetchTicket();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '割り当て失敗');
    } finally {
      setIsAssigning(false);
    }
  };

  const handleStatusChange = async (status: string) => {
    setStatusChanging(true);
    try {
      const res = await fetch(`/api/admin/support/tickets/${params.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error('ステータス変更失敗');
      await fetchTicket();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'ステータス変更失敗');
    } finally {
      setStatusChanging(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-500">読み込み中...</p>
      </div>
    );
  }

  if (error && !ticket) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 mb-4">{error}</p>
          <Link href="/support" className="text-blue-600 hover:underline">チケット一覧に戻る</Link>
        </div>
      </div>
    );
  }

  if (!ticket) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* ヘッダー */}
        <div className="flex items-center gap-3 mb-6">
          <Link href="/support" className="text-gray-500 hover:text-gray-700 text-sm">
            ← チケット一覧
          </Link>
          <span className="text-gray-300">/</span>
          <h1 className="text-lg font-bold text-gray-900 truncate">{ticket.subject}</h1>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4 text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* 左カラム: 情報パネル */}
          <div className="lg:col-span-1 space-y-4">
            {/* チケット情報 */}
            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">チケット情報</h2>
              <dl className="space-y-2 text-sm">
                <div>
                  <dt className="text-gray-500">ID</dt>
                  <dd className="font-mono text-gray-900">#{ticket.id.slice(0, 8)}</dd>
                </div>
                <div>
                  <dt className="text-gray-500">カテゴリ</dt>
                  <dd className="text-gray-900">{ticket.category}</dd>
                </div>
                <div>
                  <dt className="text-gray-500">優先度</dt>
                  <dd>
                    <span className={`inline-flex px-2 py-0.5 rounded text-xs ${PRIORITY_COLORS[ticket.priority] ?? 'bg-gray-100 text-gray-600'}`}>
                      {ticket.priority}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-500">ステータス</dt>
                  <dd>
                    <span className={`inline-flex px-2 py-0.5 rounded text-xs ${STATUS_COLORS[ticket.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {STATUS_LABELS[ticket.status] ?? ticket.status}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-500">作成日</dt>
                  <dd className="text-gray-900">{new Date(ticket.created_at).toLocaleDateString('ja-JP')}</dd>
                </div>
              </dl>
            </div>

            {/* ステータス変更 */}
            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">ステータス変更</h2>
              <div className="flex flex-col gap-2">
                {['open', 'in_progress', 'pending', 'resolved', 'closed'].map((s) => (
                  <button
                    key={s}
                    onClick={() => handleStatusChange(s)}
                    disabled={statusChanging || ticket.status === s}
                    className={`w-full text-left px-3 py-1.5 text-xs rounded border transition-colors ${
                      ticket.status === s
                        ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                        : 'border-gray-200 hover:bg-gray-50 text-gray-600'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    {STATUS_LABELS[s] ?? s}
                  </button>
                ))}
              </div>
            </div>

            {/* 担当者割り当て */}
            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">担当者割り当て</h2>
              <input
                type="text"
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
                placeholder="ユーザー UUID"
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs mb-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button
                onClick={handleAssign}
                disabled={isAssigning || !assigneeId.trim()}
                className="w-full px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isAssigning ? '割り当て中...' : '担当者を設定'}
              </button>
            </div>
          </div>

          {/* 右カラム: メッセージスレッド */}
          <div className="lg:col-span-3 flex flex-col gap-4">
            {/* メッセージ一覧 */}
            <div className="bg-white rounded-lg shadow flex-1">
              <div className="px-4 py-3 border-b border-gray-100">
                <h2 className="text-sm font-semibold text-gray-700">メッセージスレッド</h2>
              </div>
              <div className="p-4 space-y-4 max-h-[50vh] overflow-y-auto">
                {ticket.messages.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-8">メッセージがありません</p>
                ) : (
                  ticket.messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`rounded-lg p-3 text-sm ${
                        msg.is_internal
                          ? 'bg-yellow-50 border border-yellow-200'
                          : 'bg-gray-50 border border-gray-200'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-gray-500">
                          {msg.is_internal ? '内部メモ' : '返信'}
                        </span>
                        <span className="text-xs text-gray-400">
                          {new Date(msg.created_at).toLocaleString('ja-JP')}
                        </span>
                      </div>
                      <p className="text-gray-800 whitespace-pre-wrap">{msg.body}</p>
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* 返信フォーム */}
            <div className="bg-white rounded-lg shadow p-4">
              <div className="flex gap-4 mb-3">
                <button
                  onClick={() => setIsInternal(false)}
                  className={`text-sm px-3 py-1 rounded-full border transition-colors ${
                    !isInternal
                      ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                      : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  外部返信
                </button>
                <button
                  onClick={() => setIsInternal(true)}
                  className={`text-sm px-3 py-1 rounded-full border transition-colors ${
                    isInternal
                      ? 'border-yellow-500 bg-yellow-50 text-yellow-700 font-medium'
                      : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  内部メモ
                </button>
              </div>
              {isInternal && (
                <p className="text-xs text-yellow-600 bg-yellow-50 px-3 py-1.5 rounded mb-3">
                  内部メモは顧客には表示されません
                </p>
              )}
              <textarea
                value={messageBody}
                onChange={(e) => setMessageBody(e.target.value)}
                rows={4}
                placeholder={isInternal ? '内部メモを入力...' : '返信内容を入力...'}
                className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 resize-y mb-3 ${
                  isInternal
                    ? 'border-yellow-300 bg-yellow-50 focus:ring-yellow-400'
                    : 'border-gray-300 focus:ring-blue-500'
                }`}
              />
              <div className="flex justify-end">
                <button
                  onClick={handleSendMessage}
                  disabled={isSending || !messageBody.trim()}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isSending ? '送信中...' : isInternal ? 'メモを保存' : '返信を送信'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
