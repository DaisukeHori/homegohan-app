'use client';

/**
 * 運営側チケット起票画面
 * operator/03-ui-spec.md §15, §16 準拠
 * 権限: support, admin, super_admin
 */
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { forbiddenMessageOfResponse } from '@/lib/admin/api-error-message';
import {
  AdminActionNoResponseError,
  adminActionErrorOfResponse,
  adminCreateUnconfirmedMessage,
  adminCreatedButNotOpenedMessage,
  createdIdOfBody,
  displayableAdminError,
  sendAdminAction,
} from '@/lib/admin/admin-screen-messages';

/** 失敗の文の操作の名前 (「チケットの作成に失敗しました (HTTP 502)」。#2086 V6) */
const TICKET_CREATE_ACTION = 'チケットの作成';
/** 作成したものの名前 (「チケットは作成されましたが、…」。#2093 W1) */
const TICKET_SUBJECT = 'チケット';
/** 作成の応答を受け取れなかったときに確かめさせる一覧 (#2093 W1) */
const TICKET_LIST_HREF = '/admin/support';
import Link from 'next/link';

type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';
type TicketCategory = 'account' | 'billing' | 'feature' | 'bug' | 'other';

export default function NewTicketPage() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 作成の応答を受け取れなかった (済んだか分からない)・作成できたが開けなかったときの文 (#2093 W1)。
  // support_tickets には一意の制約が無く、押し直すとチケットと最初のメッセージが 2 件ずつできるので、これがあるあいだは送信を止め、一覧で確かめさせる
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  // 送信中・作成済み・済んだか分からないあいだは true (再描画の前に続けて押されたときも送らない守り。#2093 W1)
  const submitLockedRef = useRef(false);
  // 作成できて、作成したチケットへ移るのを待っているあいだ (ボタンを止めたままにする。#2093 W1)
  const [isOpeningCreated, setIsOpeningCreated] = useState(false);

  const [formData, setFormData] = useState({
    user_id: '',
    subject: '',
    category: 'other' as TicketCategory,
    priority: 'medium' as TicketPriority,
    body: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitLockedRef.current) return;
    setError(null);

    if (!formData.user_id.trim()) {
      setError('ユーザー ID を入力してください');
      return;
    }
    if (!formData.subject.trim()) {
      setError('件名を入力してください');
      return;
    }
    if (!formData.body.trim()) {
      setError('本文を入力してください');
      return;
    }

    submitLockedRef.current = true;
    // 作成が済んだ・済んだか分からないときは、送信を止めたままにする (押し直しで二重に作らない。#2093 W1)
    let keepLocked = false;
    setIsSubmitting(true);
    try {
      // 通信そのものの失敗は AdminActionNoResponseError (ブラウザの英字の例外の文を出さない。#2086 V6)
      const res = await sendAdminAction(
        '/api/admin/support/tickets',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData),
        },
        TICKET_CREATE_ACTION,
      );

      if (res.status === 401) {
        router.push('/login');
        return;
      }
      // 403 は本文の理由の文 (二段階認証の確認が要る など) を捨てずに出す。それ以外は「権限がありません」(#1917)
      if (res.status === 403) {
        setError(await forbiddenMessageOfResponse(res));
        return;
      }
      if (!res.ok) {
        // 本文は JSON でないこともある (プロキシの 502 の HTML など) ので読み失敗で例外にしない (#2086 V6)。
        // 本文に API の文の無い 502 / 503 / 504 は応答を受け取れなかったもの (AdminActionNoResponseError。#2093 W1)
        throw await adminActionErrorOfResponse(res, TICKET_CREATE_ACTION);
      }

      // 作成は済んでいる。画面が移るまで押し直させない (#2093 W1)
      keepLocked = true;
      const json: unknown = await res.json().catch(() => null);
      const createdId = createdIdOfBody(json);
      if (createdId === null) {
        // 作成したチケットを開けない (本文が読めない)。押し直すと二重になるので、一覧で確かめさせる (#2093 W1)
        setUnconfirmed(adminCreatedButNotOpenedMessage(TICKET_SUBJECT));
        return;
      }
      setIsOpeningCreated(true);
      router.push(`/admin/support/${createdId}`);
    } catch (e: unknown) {
      if (e instanceof AdminActionNoResponseError) {
        // サーバーで作成が済んでから応答が切れたこともある。読み直しで同じものかを決める鍵が無いので、送信を止めて一覧で確かめさせる (#2093 W1)
        keepLocked = true;
        setUnconfirmed(adminCreateUnconfirmedMessage(e.message));
      } else {
        // 画面に出すのは日本語の文だけ (JSON でない本文の SyntaxError などの英字の文は出さない。#2086 V6)
        setError(displayableAdminError(e, `${TICKET_CREATE_ACTION}に失敗しました`));
      }
    } finally {
      submitLockedRef.current = keepLocked;
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 py-8">
        {/* ヘッダー */}
        <div className="flex items-center gap-3 mb-6">
          <Link
            href="/admin/support"
            className="text-gray-500 hover:text-gray-700 text-sm"
          >
            ← チケット一覧
          </Link>
          <span className="text-gray-300">/</span>
          <h1 className="text-xl font-bold text-gray-900">新規チケット起票</h1>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4 text-sm">
              {error}
            </div>
          )}
          {unconfirmed && (
            <div role="alert" className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded mb-4 text-sm">
              <p>{unconfirmed}</p>
              <Link href={TICKET_LIST_HREF} className="mt-2 inline-block text-blue-600 hover:underline">
                チケット一覧で確かめる
              </Link>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* ユーザー ID */}
            <div>
              <label htmlFor="user_id" className="block text-sm font-medium text-gray-700 mb-1">
                ユーザー ID <span className="text-red-500">*</span>
              </label>
              <input
                id="user_id"
                type="text"
                value={formData.user_id}
                onChange={(e) => setFormData((f) => ({ ...f, user_id: e.target.value }))}
                placeholder="UUID 形式"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            {/* 件名 */}
            <div>
              <label htmlFor="subject" className="block text-sm font-medium text-gray-700 mb-1">
                件名 <span className="text-red-500">*</span>
              </label>
              <input
                id="subject"
                type="text"
                value={formData.subject}
                onChange={(e) => setFormData((f) => ({ ...f, subject: e.target.value }))}
                maxLength={200}
                placeholder="チケットの件名"
                aria-describedby="subject-hint"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
              {/* 顧客向けの返信メール (#1183) は、チケットの件名を件名と本文に載せる。内部向けの文言を書かないよう案内する */}
              <p id="subject-hint" className="mt-1 text-xs text-gray-500">
                この件名は、お客様への返信メールの件名と本文に載ります。お客様に見られても問題のない表現にしてください。
              </p>
            </div>

            {/* カテゴリ + 優先度 */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="category" className="block text-sm font-medium text-gray-700 mb-1">
                  カテゴリ
                </label>
                <select
                  id="category"
                  value={formData.category}
                  onChange={(e) => setFormData((f) => ({ ...f, category: e.target.value as TicketCategory }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="account">アカウント</option>
                  <option value="billing">課金</option>
                  <option value="feature">機能リクエスト</option>
                  <option value="bug">バグ</option>
                  <option value="other">その他</option>
                </select>
              </div>
              <div>
                <label htmlFor="priority" className="block text-sm font-medium text-gray-700 mb-1">
                  優先度
                </label>
                <select
                  id="priority"
                  value={formData.priority}
                  onChange={(e) => setFormData((f) => ({ ...f, priority: e.target.value as TicketPriority }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                  <option value="urgent">緊急</option>
                </select>
              </div>
            </div>

            {/* 本文 */}
            <div>
              <label htmlFor="body" className="block text-sm font-medium text-gray-700 mb-1">
                本文 <span className="text-red-500">*</span>
              </label>
              <textarea
                id="body"
                value={formData.body}
                onChange={(e) => setFormData((f) => ({ ...f, body: e.target.value }))}
                rows={6}
                placeholder="チケットの詳細を入力"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                required
              />
            </div>

            {/* 送信ボタン */}
            <div className="flex justify-end gap-3">
              <Link
                href="/admin/support"
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </Link>
              <button
                type="submit"
                disabled={isSubmitting || isOpeningCreated || unconfirmed !== null}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isSubmitting || isOpeningCreated ? '起票中...' : 'チケットを起票'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
