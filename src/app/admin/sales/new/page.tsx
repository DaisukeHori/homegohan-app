'use client';

/**
 * 新規 Lead 起票画面
 * operator/03-ui-spec.md §17 準拠
 * 権限: sales, admin, super_admin
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

/** 失敗の文の操作の名前 (「リードの作成に失敗しました (HTTP 502)」。#2086 V6) */
const LEAD_CREATE_ACTION = 'リードの作成';
/** 作成したものの名前 (「リードは作成されましたが、…」。#2093 W1) */
const LEAD_SUBJECT = 'リード';
/** 作成の応答を受け取れなかったときに確かめさせる一覧 (#2093 W1) */
const LEAD_LIST_HREF = '/admin/sales';
import Link from 'next/link';

type LeadSource = 'website' | 'referral' | 'event' | 'cold_call' | 'other';

export default function NewLeadPage() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 作成の応答を受け取れなかった (済んだか分からない)・作成できたが開けなかったときの文 (#2093 W1)。
  // sales_leads には一意の制約が無く、押し直すとリードが 2 件できるので、これがあるあいだは送信を止め、一覧で確かめさせる
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  // 送信中・作成済み・済んだか分からないあいだは true (再描画の前に続けて押されたときも送らない守り。#2093 W1)
  const submitLockedRef = useRef(false);
  // 作成できて、作成したリードへ移るのを待っているあいだ (ボタンを止めたままにする。#2093 W1)
  const [isOpeningCreated, setIsOpeningCreated] = useState(false);

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
    if (submitLockedRef.current) return;
    setError(null);

    if (!formData.company_name.trim()) {
      setError('会社名を入力してください');
      return;
    }

    submitLockedRef.current = true;
    // 作成が済んだ・済んだか分からないときは、送信を止めたままにする (押し直しで二重に作らない。#2093 W1)
    let keepLocked = false;
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

      // 通信そのものの失敗は AdminActionNoResponseError (ブラウザの英字の例外の文を出さない。#2086 V6)
      const res = await sendAdminAction(
        '/api/admin/sales/leads',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        LEAD_CREATE_ACTION,
      );

      if (res.status === 401) { router.push('/login'); return; }
      // 403 は本文の理由の文 (二段階認証の確認が要る など) を捨てずに出す。それ以外は「権限がありません」(#1917)
      if (res.status === 403) { setError(await forbiddenMessageOfResponse(res)); return; }
      if (!res.ok) {
        // 本文は JSON でないこともある (プロキシの 502 の HTML など) ので読み失敗で例外にしない (#2086 V6)。
        // 本文に API の文の無い 502 / 503 / 504 は応答を受け取れなかったもの (AdminActionNoResponseError。#2093 W1)
        throw await adminActionErrorOfResponse(res, LEAD_CREATE_ACTION);
      }

      // 作成は済んでいる。画面が移るまで押し直させない (#2093 W1)
      keepLocked = true;
      const json: unknown = await res.json().catch(() => null);
      const createdId = createdIdOfBody(json);
      if (createdId === null) {
        // 作成したリードを開けない (本文が読めない)。押し直すと二重になるので、一覧で確かめさせる (#2093 W1)
        setUnconfirmed(adminCreatedButNotOpenedMessage(LEAD_SUBJECT));
        return;
      }
      setIsOpeningCreated(true);
      router.push(`/admin/sales/${createdId}`);
    } catch (e: unknown) {
      if (e instanceof AdminActionNoResponseError) {
        // サーバーで作成が済んでから応答が切れたこともある。読み直しで同じものかを決める鍵が無いので、送信を止めて一覧で確かめさせる (#2093 W1)
        keepLocked = true;
        setUnconfirmed(adminCreateUnconfirmedMessage(e.message));
      } else {
        // 画面に出すのは日本語の文だけ (JSON でない本文の SyntaxError などの英字の文は出さない。#2086 V6)
        setError(displayableAdminError(e, `${LEAD_CREATE_ACTION}に失敗しました`));
      }
    } finally {
      submitLockedRef.current = keepLocked;
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/admin/sales" className="text-gray-500 hover:text-gray-700 text-sm">
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
          {unconfirmed && (
            <div role="alert" className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded mb-4 text-sm">
              <p>{unconfirmed}</p>
              <Link href={LEAD_LIST_HREF} className="mt-2 inline-block text-blue-600 hover:underline">
                リード一覧で確かめる
              </Link>
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
                href="/admin/sales"
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </Link>
              <button
                type="submit"
                disabled={isSubmitting || isOpeningCreated || unconfirmed !== null}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isSubmitting || isOpeningCreated ? '登録中...' : 'リードを登録'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
