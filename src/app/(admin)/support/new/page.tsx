'use client';

/**
 * 運営側チケット起票画面
 * operator/03-ui-spec.md §15, §16 準拠
 * 権限: support, admin, super_admin
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';
type TicketCategory = 'account' | 'billing' | 'feature' | 'bug' | 'other';

export default function NewTicketPage() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    user_id: '',
    subject: '',
    category: 'other' as TicketCategory,
    priority: 'medium' as TicketPriority,
    body: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/admin/support/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (res.status === 401) {
        router.push('/login');
        return;
      }
      if (res.status === 403) {
        setError('権限がありません');
        return;
      }
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error?.message ?? 'チケット作成に失敗しました');
      }

      const json = await res.json();
      router.push(`/support/${json.data.id}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '不明なエラー');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 py-8">
        {/* ヘッダー */}
        <div className="flex items-center gap-3 mb-6">
          <Link
            href="/support"
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
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
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
                href="/support"
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </Link>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isSubmitting ? '起票中...' : 'チケットを起票'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
