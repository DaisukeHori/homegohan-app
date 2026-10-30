'use client';

/**
 * サポートチケット一覧
 * operator/03-ui-spec.md §15 準拠
 * 権限: support, admin, super_admin
 *
 * #2107 Y11: 絞り込み (状態のタブ・優先度)・ページを変えて読み込みを始めるときに行を空にする。そのあとの読み込みが失敗
 * (500・403・通信の失敗・壊れた応答) しても、前の条件の行と件数を失敗の文と一緒に出さない (新しい条件の結果と見誤らせない)。
 * 読み込みを重ねたときは、遅れて届いた古い読み込みの結果で新しい条件の画面を上書きしない (読み込みの連番で捨てる)。
 * 読み込みの最中・失敗のあいだは件数を出さない (前の条件の件数を新しい条件の件数と見せない)。ページ送りのボタンは残す (前のページへ戻れる)
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { loginPathWithNext } from '@/lib/auth/signed-in-user';
import { forbiddenMessageOfResponse } from '@/lib/admin/api-error-message';
import {
  AdminScreenError,
  adminLoadFailedMessage,
  displayableAdminError,
  listRowsOfBody,
  listTotalOfBody,
} from '@/lib/admin/admin-screen-messages';
import { lastPageToRefetch } from '@/lib/list-pagination';

/** 読み込みの失敗の文の対象 (「チケットの一覧を読み込めませんでした（通信エラー）」。#2086 V6) */
const TICKETS_SUBJECT = 'チケットの一覧';
/** 一覧の読み込みが失敗の応答・読めない本文で終わったときの文 */
const TICKETS_LOAD_FAILURE_MESSAGE = 'チケット一覧の取得に失敗しました';

type TicketStatus = 'open' | 'in_progress' | 'pending' | 'resolved' | 'closed';
type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';

interface Ticket {
  id: string;
  user_id: string;
  subject: string;
  category: string;
  priority: TicketPriority;
  status: TicketStatus;
  assignee_id: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_LABELS: Record<TicketStatus, string> = {
  open: '未対応',
  in_progress: '対応中',
  pending: '保留',
  resolved: '解決済',
  closed: 'クローズ',
};

const STATUS_COLORS: Record<TicketStatus, string> = {
  open: 'bg-blue-100 text-blue-800',
  in_progress: 'bg-yellow-100 text-yellow-800',
  pending: 'bg-gray-100 text-gray-700',
  resolved: 'bg-green-100 text-green-800',
  closed: 'bg-gray-200 text-gray-600',
};

const PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: '低',
  medium: '中',
  high: '高',
  urgent: '緊急',
};

const PRIORITY_COLORS: Record<TicketPriority, string> = {
  low: 'bg-gray-100 text-gray-600',
  medium: 'bg-blue-100 text-blue-700',
  high: 'bg-orange-100 text-orange-700',
  urgent: 'bg-red-100 text-red-800 font-bold',
};

const STATUS_TABS: Array<{ key: TicketStatus | 'all'; label: string }> = [
  { key: 'all', label: 'すべて' },
  { key: 'open', label: '未対応' },
  { key: 'in_progress', label: '対応中' },
  { key: 'resolved', label: '解決済' },
];

export default function SupportTicketsPage() {
  const router = useRouter();
  // ログインが切れた (401) ときに、ログインし直したあとこの画面へ戻れるよう next に付けるパス (#2101 X5)
  const pathname = usePathname();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [activeTab, setActiveTab] = useState<TicketStatus | 'all'>('all');
  const [priorityFilter, setPriorityFilter] = useState<TicketPriority | ''>('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 読み込みを重ねたとき、古い読み込みの結果で新しい条件の画面を上書きしないための連番 (#2107 Y11)
  const loadSeqRef = useRef(0);

  const perPage = 50;

  const fetchTickets = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    const isLatest = () => seq === loadSeqRef.current;
    // 件数より後ろのページから最後のページへ取り直すときは、読み込み中のまま次の読み込みへ渡す (空の一覧を一瞬も見せない)
    let refetching = false;
    setIsLoading(true);
    setError(null);
    // 前の条件の行を、新しい条件の読み込みの結果 (とくに失敗) と一緒に出さない (#2107 Y11)
    setTickets([]);
    try {
      const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
      if (activeTab !== 'all') params.set('status', activeTab);
      if (priorityFilter) params.set('priority', priorityFilter);

      let res: Response;
      try {
        res = await fetch(`/api/admin/support/tickets?${params}`);
      } catch {
        // 通信そのものの失敗 (ブラウザの英字の例外の文を出さない。#2086 V6)
        throw new AdminScreenError(adminLoadFailedMessage(TICKETS_SUBJECT, null));
      }
      if (!isLatest()) return;
      if (res.status === 401) {
        router.push(loginPathWithNext(pathname));
        return;
      }
      // 403 は本文の理由の文 (二段階認証の確認が要る など) を捨てずに出す。それ以外は「権限がありません」(#1917)
      if (res.status === 403) {
        const forbiddenMessage = await forbiddenMessageOfResponse(res);
        if (isLatest()) setError(forbiddenMessage);
        return;
      }
      if (!res.ok) {
        throw new AdminScreenError(TICKETS_LOAD_FAILURE_MESSAGE);
      }
      const json: unknown = await res.json().catch(() => null);
      if (!isLatest()) return;
      // 200 なのに本文が読めない・data が配列でない壊れた応答は、0 件と見せずに読み込めなかったものとして扱う (#2101 X8)
      const rows = listRowsOfBody<Ticket>(json);
      if (rows === null) throw new AdminScreenError(TICKETS_LOAD_FAILURE_MESSAGE);
      const total = listTotalOfBody(json);
      // 件数より後ろのページ (最後のページの唯一の行が消えたあとの読み直しなど) は、空のページを見せずに最後のページへ取り直す (#1917)
      const refetchPage = lastPageToRefetch({ rows: rows.length, page, total, perPage });
      if (refetchPage !== null) {
        refetching = true;
        setPage(refetchPage);
        return;
      }
      setTickets(rows);
      setTotal(total);
    } catch (e: unknown) {
      // 画面に出すのは日本語の文だけ (JSON でない本文の SyntaxError などの英字の文は出さない。#2086 V6)
      if (isLatest()) setError(displayableAdminError(e, TICKETS_LOAD_FAILURE_MESSAGE));
    } finally {
      if (isLatest() && !refetching) setIsLoading(false);
    }
  }, [page, activeTab, priorityFilter, router, pathname]);

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  const totalPages = Math.ceil(total / perPage);
  // 読み込みに失敗して出せる行が無い。「全 0 件」「チケットはありません」と 0 件に見せない (#2101 X8)
  const loadFailedWithoutRows = error !== null && tickets.length === 0;
  // 件数 (total) が今の条件の読み込みの結果か。読み込みの最中・失敗のあいだの total は前の条件の件数なので出さない (#2107 Y11)
  const showsCurrentTotal = !isLoading && error === null;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* ヘッダー */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">サポートチケット</h1>
            {showsCurrentTotal && <p className="text-sm text-gray-500 mt-1">全 {total} 件</p>}
          </div>
          <Link
            href="/admin/support/new"
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            + 新規チケット起票
          </Link>
        </div>

        {/* フィルタタブ */}
        <div className="flex gap-1 mb-4 border-b border-gray-200">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => { setActiveTab(tab.key); setPage(1); }}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                activeTab === tab.key
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2 pb-2">
            <label htmlFor="priority-filter" className="text-sm text-gray-500">優先度:</label>
            <select
              id="priority-filter"
              value={priorityFilter}
              onChange={(e) => { setPriorityFilter(e.target.value as TicketPriority | ''); setPage(1); }}
              className="text-sm border border-gray-300 rounded px-2 py-1"
            >
              <option value="">すべて</option>
              <option value="urgent">緊急</option>
              <option value="high">高</option>
              <option value="medium">中</option>
              <option value="low">低</option>
            </select>
          </div>
        </div>

        {/* エラー */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        {/* テーブル */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          {isLoading ? (
            <div className="text-center py-12 text-gray-500">読み込み中...</div>
          ) : loadFailedWithoutRows ? null : tickets.length === 0 ? (
            <div className="text-center py-12 text-gray-500">チケットはありません</div>
          ) : (
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">ID</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">件名</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">カテゴリ</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">優先度</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">ステータス</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">作成日</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {tickets.map((ticket) => (
                  <tr key={ticket.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-mono text-gray-500">
                      #{ticket.id.slice(0, 8)}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900 max-w-xs truncate">
                      {ticket.subject}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{ticket.category}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${PRIORITY_COLORS[ticket.priority]}`}>
                        {PRIORITY_LABELS[ticket.priority]}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${STATUS_COLORS[ticket.status]}`}>
                        {STATUS_LABELS[ticket.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">
                      {new Date(ticket.created_at).toLocaleDateString('ja-JP')}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/admin/support/${ticket.id}`}
                        className="text-blue-600 hover:text-blue-800 text-sm"
                      >
                        詳細
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ページネーション */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            {/* 範囲と件数は今の条件の読み込みが済んだときだけ (読み込みの最中・失敗のあいだは前の条件の件数なので出さない。#2107 Y11) */}
            <p className="text-sm text-gray-500">
              {showsCurrentTotal && <>{(page - 1) * perPage + 1}〜{Math.min(page * perPage, total)} / {total} 件</>}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1 text-sm border border-gray-300 rounded disabled:opacity-40 hover:bg-gray-50"
              >
                前へ
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-3 py-1 text-sm border border-gray-300 rounded disabled:opacity-40 hover:bg-gray-50"
              >
                次へ
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
