'use client';

/**
 * 新規 Lead 起票画面
 * operator/03-ui-spec.md §17 準拠
 * 権限: sales, admin, super_admin
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

type LeadSource = 'website' | 'referral' | 'event' | 'cold_call' | 'other';

export default function NewLeadPage() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    company_name: '',
    industry: '',
    employee_count: '',
    contact_name: '',
    contact_email: '',
    contact_phone: '',
    source: 'other' as LeadSource,
    estimated_acv: '',
    notes: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!formData.company_name.trim()) {
      setError('会社名を入力してください');
      return;
    }

    setIsSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        company_name: formData.company_name,
        source: formData.source,
      };
      if (formData.industry) payload.industry = formData.industry;
      if (formData.employee_count) payload.employee_count = parseInt(formData.employee_count, 10);
      if (formData.contact_name) payload.contact_name = formData.contact_name;
      if (formData.contact_email) payload.contact_email = formData.contact_email;
      if (formData.contact_phone) payload.contact_phone = formData.contact_phone;
      if (formData.estimated_acv) payload.estimated_acv = parseInt(formData.estimated_acv, 10);
      if (formData.notes) payload.notes = formData.notes;

      const res = await fetch('/api/admin/sales/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.status === 401) { router.push('/login'); return; }
      if (res.status === 403) { setError('権限がありません'); return; }
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error?.message ?? 'リード作成に失敗しました');
      }

      const json = await res.json();
      router.push(`/sales/${json.data.id}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '不明なエラー');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/sales" className="text-gray-500 hover:text-gray-700 text-sm">
            ← リード一覧
          </Link>
          <span className="text-gray-300">/</span>
          <h1 className="text-xl font-bold text-gray-900">新規リード登録</h1>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4 text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* 会社名 */}
            <div>
              <label htmlFor="company_name" className="block text-sm font-medium text-gray-700 mb-1">
                会社名 <span className="text-red-500">*</span>
              </label>
              <input
                id="company_name"
                type="text"
                value={formData.company_name}
                onChange={(e) => setFormData((f) => ({ ...f, company_name: e.target.value }))}
                maxLength={200}
                placeholder="株式会社〇〇"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            {/* 業種 + 従業員数 */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="industry" className="block text-sm font-medium text-gray-700 mb-1">
                  業種
                </label>
                <input
                  id="industry"
                  type="text"
                  value={formData.industry}
                  onChange={(e) => setFormData((f) => ({ ...f, industry: e.target.value }))}
                  placeholder="製造業、IT など"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label htmlFor="employee_count" className="block text-sm font-medium text-gray-700 mb-1">
                  従業員数
                </label>
                <input
                  id="employee_count"
                  type="number"
                  min={1}
                  value={formData.employee_count}
                  onChange={(e) => setFormData((f) => ({ ...f, employee_count: e.target.value }))}
                  placeholder="500"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* 担当者情報 */}
            <div>
              <label htmlFor="contact_name" className="block text-sm font-medium text-gray-700 mb-1">
                担当者名
              </label>
              <input
                id="contact_name"
                type="text"
                value={formData.contact_name}
                onChange={(e) => setFormData((f) => ({ ...f, contact_name: e.target.value }))}
                placeholder="山田部長"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="contact_email" className="block text-sm font-medium text-gray-700 mb-1">
                  メールアドレス
                </label>
                <input
                  id="contact_email"
                  type="email"
                  value={formData.contact_email}
                  onChange={(e) => setFormData((f) => ({ ...f, contact_email: e.target.value }))}
                  placeholder="yamada@example.com"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label htmlFor="contact_phone" className="block text-sm font-medium text-gray-700 mb-1">
                  電話番号
                </label>
                <input
                  id="contact_phone"
                  type="tel"
                  value={formData.contact_phone}
                  onChange={(e) => setFormData((f) => ({ ...f, contact_phone: e.target.value }))}
                  placeholder="03-XXXX-XXXX"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* 流入経路 + 推定 ACV */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="source" className="block text-sm font-medium text-gray-700 mb-1">
                  流入経路
                </label>
                <select
                  id="source"
                  value={formData.source}
                  onChange={(e) => setFormData((f) => ({ ...f, source: e.target.value as LeadSource }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="website">ウェブサイト</option>
                  <option value="referral">紹介</option>
                  <option value="event">イベント</option>
                  <option value="cold_call">コールドコール</option>
                  <option value="other">その他</option>
                </select>
              </div>
              <div>
                <label htmlFor="estimated_acv" className="block text-sm font-medium text-gray-700 mb-1">
                  推定 ACV (円)
                </label>
                <input
                  id="estimated_acv"
                  type="number"
                  min={0}
                  value={formData.estimated_acv}
                  onChange={(e) => setFormData((f) => ({ ...f, estimated_acv: e.target.value }))}
                  placeholder="1200000"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* メモ */}
            <div>
              <label htmlFor="notes" className="block text-sm font-medium text-gray-700 mb-1">
                メモ
              </label>
              <textarea
                id="notes"
                value={formData.notes}
                onChange={(e) => setFormData((f) => ({ ...f, notes: e.target.value }))}
                rows={4}
                placeholder="特記事項..."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
              />
            </div>

            {/* 送信ボタン */}
            <div className="flex justify-end gap-3">
              <Link
                href="/sales"
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </Link>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isSubmitting ? '登録中...' : 'リードを登録'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
