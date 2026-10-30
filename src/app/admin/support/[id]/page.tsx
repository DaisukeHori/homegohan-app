'use client';

/**
 * チケット詳細 + メッセージスレッド + 担当割り当て
 * operator/03-ui-spec.md §16 準拠
 * 権限: support, admin, super_admin
 * 内部メモ (is_internal=true): 薄黄色背景で視覚的区別
 */
import { useState, useEffect, useCallback, useRef, use } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { loginPathWithNext } from '@/lib/auth/signed-in-user';
import { forbiddenMessageOfResponse } from '@/lib/admin/api-error-message';
import {
  AdminActionNoResponseError,
  AdminScreenError,
  adminActionErrorOfResponse,
  adminActionNoResponseMessage,
  displayableAdminError,
  sendAdminAction,
} from '@/lib/admin/admin-screen-messages';
import { describeReplyEmailOutcome } from '@/lib/admin/support-reply-email-status';
import {
  REPLY_DELIVERED_EMAIL_UNKNOWN_GUIDE,
  REPLY_DELIVERED_GUIDE,
  REPLY_NOT_DELIVERED_GUIDE,
  REPLY_RELOAD_FAILED_GUIDE,
  REPLY_RELOAD_UNAVAILABLE_GUIDE,
  isReplyDelivered,
  replyNoResponseMessage,
} from '@/lib/admin/support-reply-no-response';
import { rereadDetailRow } from '@/lib/super-admin/detail-reread';

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

/** 403 (Forbidden) の HTTP ステータス */
const HTTP_FORBIDDEN = 403;
/** 担当者の割り当ての失敗の文。403 の本文が理由の文 (二段階認証の確認が要る など) ならそちらを出す (#1917) */
const ASSIGN_FAILURE_MESSAGE = '割り当て失敗';
/** 状態の変更の失敗の文。403 の本文が理由の文 (二段階認証の確認が要る など) ならそちらを出す (#1917) */
const STATUS_CHANGE_FAILURE_MESSAGE = 'ステータス変更失敗';
/** 書き込みの通信そのものが失敗したときの文の操作の名前 (「メッセージの送信の応答を受け取れませんでした（通信エラー）」。#2086 V6) */
const SEND_MESSAGE_ACTION = 'メッセージの送信';
const ASSIGN_ACTION = '割り当て';
/** チケットが無い (404) ときの文。送信の応答を受け取れなかったあとの読み直しの 404 も同じ文にする (読み込み直しても変わらない) */
const TICKET_NOT_FOUND_MESSAGE = 'チケットが見つかりません';
const STATUS_CHANGE_ACTION = 'ステータスの変更';

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

type PageProps = { params: Promise<{ id: string }> };

/**
 * 応答を受け取れなかった送信 (#2093 W1)。読み直して届いていたかを確かめるまで、次の送信をさせない。
 * knownIds は送る前に画面が持っていたメッセージの id (これに無い行だけを「届いた」と数える)。summary は「<操作>の応答を受け取れませんでした …」の文
 */
interface UnconfirmedSend {
  readonly body: string;
  readonly isInternal: boolean;
  readonly knownIds: ReadonlySet<string>;
  readonly summary: string;
}

/**
 * 送れたか分からない送信を止めているあいだの、止めている理由 (#2093 W1・#2101 X3)。
 * message は止めている理由の文 (「<操作>の応答を受け取れませんでした …。チケットも読み込めなかったため、送られたか分かりません …」)。
 * エラー欄 (error) とは別に持つので、担当者の設定・ステータスの変更のあとのチケットの読み込み (fetchTicket の setError(null)) で消えない。
 * retryable は「再試行」(チケットの読み直し) を出すか。読み直しが 401 (ログインが切れた)・403 (権限が外れた)・404 (チケットが消えた) で
 * 断られたときは、読み込み直しても変わらないので false (押しても必ず失敗する「再試行」を出さない。送信は止めたまま)
 */
interface BlockedSend {
  readonly pending: UnconfirmedSend;
  readonly message: string;
  readonly retryable: boolean;
}

/** チケットの読み直しで読めたチケットが、メッセージの配列を持つか (形が違えば読めなかったものとして扱う) */
function hasMessages(ticket: Ticket): boolean {
  return Array.isArray((ticket as { messages?: unknown }).messages);
}

export default function TicketDetailPage(props: PageProps) {
  const params = use(props.params);
  const router = useRouter();
  // ログインが切れた (401) ときに、ログインし直したあとこの画面へ戻れるよう next に付けるパス (#2101 X5)
  const pathname = usePathname();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [messageBody, setMessageBody] = useState('');
  const [isInternal, setIsInternal] = useState(false);
  const [isSending, setIsSending] = useState(false);
  // 返信は保存できたが、顧客へのメール通知が届いていないときの案内 (#1183)
  const [emailNotice, setEmailNotice] = useState<string | null>(null);

  const [assigneeId, setAssigneeId] = useState('');
  const [isAssigning, setIsAssigning] = useState(false);

  const [statusChanging, setStatusChanging] = useState(false);
  // 送信の応答を受け取れなかったあと、チケットの読み直しにも失敗して、送れたか分からない送信 (#2093 W1)。
  // これがあるあいだは送信のボタンを止め、「再試行」でチケットを読み直して確かめるまで送らせない (押し直すと返信が 2 行入り、顧客にメールが 2 通届く)。
  // ref は再描画の前に続けて押されたときの守り。止めている理由の文はエラー欄と別に出す (ほかの操作のあとの読み込みで消さない。#2101 X3)
  const [blockedSend, setBlockedSend] = useState<BlockedSend | null>(null);
  const blockedSendRef = useRef<BlockedSend | null>(null);
  const [isConfirmingSend, setIsConfirmingSend] = useState(false);
  // 返信・担当者の設定・ステータスの変更のどれかの書き込みとそのあとの読み直しの応答を待っているか (10/26 の整合ゲート 1026e。#2050)。
  // どの書き込みのあとの読み直しもチケットを丸ごと差し替えるので、2 つを重ねると、先に送った読み直しの応答が後に届いたとき、
  // その古いチケット (例: 変える前のステータス) で表示が上書きされる (#2053 のクーポン・機能パッケージと同じ型)。
  // 待つあいだは 3 つの書き込みのボタンを止め、押されても送らない。ref は再描画の前に続けて押されたとき (ボタンがまだ止まっていない) の守り
  const writeInFlightRef = useRef(false);
  const isWriting = isSending || isAssigning || statusChanging || isConfirmingSend;

  const fetchTicket = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/support/tickets/${params.id}`);
      if (res.status === 401) { router.push(loginPathWithNext(pathname)); return; }
      // 403 は本文の理由の文 (二段階認証の確認が要る など) を捨てずに出す。それ以外は「権限がありません」(#1917)
      if (res.status === HTTP_FORBIDDEN) { setError(await forbiddenMessageOfResponse(res)); return; }
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
  }, [params.id, router, pathname]);

  useEffect(() => { fetchTicket(); }, [fetchTicket]);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [ticket?.messages]);

  const markBlockedSend = (blocked: BlockedSend | null) => {
    blockedSendRef.current = blocked;
    setBlockedSend(blocked);
  };

  /**
   * 送信の応答を受け取れなかったあと、チケットを読み直して送った返信が届いていたかを確かめる (#2093 W1)。
   * 届いていれば済んだとして入力欄を空にし、届いていなければ本文を残して送り直せるようにする。
   * 読み直しにも失敗したら、送れたか分からないので送信を止める:
   *   - 500・通信の失敗・本文が読めない: 「再試行」でこの関数をもう一度呼ぶ
   *   - 401 / 403 / 404: 読み込み直しても変わらないので、理由の文 (「ログインし直してください」・403 の理由の文・
   *     「チケットが見つかりません」) を添え、「再試行」は出さない (#2101 X3)
   */
  const confirmUnconfirmedSend = async (pending: UnconfirmedSend) => {
    const outcome = await rereadDetailRow<Ticket>(`/api/admin/support/tickets/${params.id}`, TICKET_NOT_FOUND_MESSAGE);
    if (outcome.kind !== 'loaded' || !hasMessages(outcome.row)) {
      setEmailNotice(null);
      setError(null);
      markBlockedSend(
        outcome.kind === 'unavailable'
          ? { pending, message: replyNoResponseMessage(pending.summary, REPLY_RELOAD_UNAVAILABLE_GUIDE, outcome.message), retryable: false }
          : { pending, message: replyNoResponseMessage(pending.summary, REPLY_RELOAD_FAILED_GUIDE), retryable: true },
      );
      return;
    }
    const reloaded = outcome.row;
    markBlockedSend(null);
    setTicket(reloaded);
    setAssigneeId(reloaded.assignee_id ?? '');
    if (isReplyDelivered(reloaded.messages, pending.knownIds, pending)) {
      // 済んでいた。入力欄が送った本文のままなら空にする (待つあいだに書き足した文は消さない)
      setMessageBody((current) => (current.trim() === pending.body.trim() ? '' : current));
      setError(null);
      // 外部返信は保存のあとにメールを送るので、応答が切れたときはメールが届いたかは分からない。内部メモはメールにしない
      setEmailNotice(
        pending.isInternal
          ? replyNoResponseMessage(pending.summary, REPLY_DELIVERED_GUIDE)
          : replyNoResponseMessage(pending.summary, REPLY_DELIVERED_GUIDE, REPLY_DELIVERED_EMAIL_UNKNOWN_GUIDE),
      );
      return;
    }
    setEmailNotice(null);
    setError(replyNoResponseMessage(pending.summary, REPLY_NOT_DELIVERED_GUIDE));
  };

  const handleSendMessage = async () => {
    if (!messageBody.trim() || writeInFlightRef.current || blockedSendRef.current !== null) return;
    writeInFlightRef.current = true;
    setIsSending(true);
    setEmailNotice(null);
    // 応答を受け取れなかったときに、読み直したメッセージと比べるための、送る前の状態と送った内容 (#2093 W1)
    const knownIds: ReadonlySet<string> = new Set((ticket?.messages ?? []).map((message) => message.id));
    const sent = { body: messageBody, isInternal };
    try {
      // 通信そのものの失敗は AdminActionNoResponseError (ブラウザの英字の例外の文を出さない。#2086 V6)
      const res = await sendAdminAction(
        `/api/admin/support/tickets/${params.id}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: sent.body, is_internal: sent.isInternal }),
        },
        SEND_MESSAGE_ACTION,
      );
      if (!res.ok) {
        // 本文は JSON でないこともある (プロキシの 502 の HTML など) ので読み失敗で例外にしない (#2086 V6)。
        // 本文に API の文の無い 502 / 503 / 504 は応答を受け取れなかったもの (AdminActionNoResponseError。#2093 W1)
        throw await adminActionErrorOfResponse(res, SEND_MESSAGE_ACTION);
      }
      // 外部返信は顧客へメールで知らせる。メッセージ自体は保存済みなので、送れなかったときは案内だけ出す
      // (内部メモは通知しないため、応答に email が無い)
      const created = await res.json().catch(() => null);
      setEmailNotice(describeReplyEmailOutcome(created?.email));
      setMessageBody('');
      await fetchTicket();
    } catch (e: unknown) {
      if (e instanceof AdminActionNoResponseError) {
        // route は保存のあとにメールの送信を待ってから応答するので、応答が切れても返信は保存されていることがある。
        // 失敗と見せて押し直させず、チケットを読み直して確かめる (#2093 W1)
        await confirmUnconfirmedSend({ ...sent, knownIds, summary: e.message });
      } else {
        // 画面に出すのは日本語の文だけ (ブラウザの英字の例外の文などは出さない。#2086 V6)
        setError(displayableAdminError(e, '送信失敗'));
      }
    } finally {
      writeInFlightRef.current = false;
      setIsSending(false);
    }
  };

  /** 「再試行」: 送れたか分からない送信を、チケットを読み直して確かめる (#2093 W1) */
  const handleRetryConfirmSend = async () => {
    const blocked = blockedSendRef.current;
    // 読み込み直しても変わらない理由で止めているときは読み直さない (「再試行」は出していない。#2101 X3)
    if (blocked === null || !blocked.retryable || writeInFlightRef.current) return;
    writeInFlightRef.current = true;
    setIsConfirmingSend(true);
    try {
      await confirmUnconfirmedSend(blocked.pending);
    } finally {
      writeInFlightRef.current = false;
      setIsConfirmingSend(false);
    }
  };

  const handleAssign = async () => {
    if (!assigneeId.trim() || writeInFlightRef.current) return;
    writeInFlightRef.current = true;
    setIsAssigning(true);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/admin/support/tickets/${params.id}/assign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignee_id: assigneeId }),
        });
      } catch {
        // 通信そのものの失敗 (ブラウザの英字の例外の文を出さない。#2086 V6)
        throw new AdminScreenError(adminActionNoResponseMessage(ASSIGN_ACTION));
      }
      // 403 は本文の理由の文 (二段階認証の確認が要る など) を捨てずに出す。それ以外の 403 と失敗は「割り当て失敗」(#1917)
      if (res.status === HTTP_FORBIDDEN) throw new AdminScreenError(await forbiddenMessageOfResponse(res, ASSIGN_FAILURE_MESSAGE));
      if (!res.ok) throw new AdminScreenError(ASSIGN_FAILURE_MESSAGE);
      await fetchTicket();
    } catch (e: unknown) {
      setError(displayableAdminError(e, ASSIGN_FAILURE_MESSAGE));
    } finally {
      writeInFlightRef.current = false;
      setIsAssigning(false);
    }
  };

  const handleStatusChange = async (status: string) => {
    if (writeInFlightRef.current) return;
    writeInFlightRef.current = true;
    setStatusChanging(true);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/admin/support/tickets/${params.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
      } catch {
        // 通信そのものの失敗 (ブラウザの英字の例外の文を出さない。#2086 V6)
        throw new AdminScreenError(adminActionNoResponseMessage(STATUS_CHANGE_ACTION));
      }
      // 403 は本文の理由の文 (二段階認証の確認が要る など) を捨てずに出す。それ以外の 403 と失敗は「ステータス変更失敗」(#1917)
      if (res.status === HTTP_FORBIDDEN) throw new AdminScreenError(await forbiddenMessageOfResponse(res, STATUS_CHANGE_FAILURE_MESSAGE));
      if (!res.ok) throw new AdminScreenError(STATUS_CHANGE_FAILURE_MESSAGE);
      await fetchTicket();
    } catch (e: unknown) {
      setError(displayableAdminError(e, STATUS_CHANGE_FAILURE_MESSAGE));
    } finally {
      writeInFlightRef.current = false;
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
          <Link href="/admin/support" className="text-blue-600 hover:underline">チケット一覧に戻る</Link>
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
          <Link href="/admin/support" className="text-gray-500 hover:text-gray-700 text-sm">
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

        {blockedSend !== null && (
          <div
            role="alert"
            data-testid="blocked-send-reason"
            className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4 text-sm"
          >
            {blockedSend.message}
          </div>
        )}

        {emailNotice && (
          <div
            role="status"
            className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded mb-4 text-sm"
          >
            {emailNotice}
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
                    disabled={isWriting || ticket.status === s}
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
                disabled={isWriting || !assigneeId.trim()}
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
              <div className="flex justify-end gap-2">
                {blockedSend !== null && blockedSend.retryable && (
                  <button
                    onClick={handleRetryConfirmSend}
                    disabled={isWriting}
                    className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {isConfirmingSend ? '確認中...' : '再試行'}
                  </button>
                )}
                <button
                  onClick={handleSendMessage}
                  disabled={isWriting || !messageBody.trim() || blockedSend !== null}
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
