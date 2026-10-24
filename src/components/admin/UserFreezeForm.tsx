'use client';

/**
 * /admin/users/{id}/freeze の凍結・凍結解除のフォーム (#1917)
 *
 * 以前はサーバーコンポーネントの中の <form action="/api/admin/users/{id}/freeze" method="POST"> だった。
 * ブラウザのフォームは本文を application/x-www-form-urlencoded で送るが、API は JSON (request.json()) だけを受けるため、
 * 「凍結する」も「凍結解除する」も 400 INVALID_JSON の JSON がそのまま画面に出て、どちらも動かなかった。
 * 解除は隠し項目 _method=DELETE で送っていたが route は読まないので、届いても POST (凍結) に入るところだった。
 * ここで fetch を使い、JSON で送る (#1101 の ModerationReviewForm と同じ形)。
 *
 * - 凍結: POST /api/admin/users/{id}/freeze に { ban_type, reason_category, reason_detail, duration_days? }。
 *   duration_days は一時 BAN のときだけ (数値で)。永久 BAN は super_admin のときだけ選べる (API も 403 で断る)
 * - 凍結解除: DELETE /api/admin/users/{id}/freeze に { reason }
 * - 送る前に API と同じ範囲 (src/lib/admin/users-schemas.ts の FreezeBodySchema / UnfreezeBodySchema) で確かめ、外れていれば送らずに知らせる
 * - 成功したら結果を出し、router.refresh() でページ (見出し・パンくず・凍結の状態) を読み直す
 * - 409 CONFLICT_STALE_DATA (読んでから書くまでに対象が super_admin になった等。API は書いていない) は、API の文を出し、
 *   ページを読み直す (運営が手で読み直さなくてよいように。isStaleDataConflict。#1917)
 * - そのほかの失敗は API の文 (こちらが書いた固定の文) を出し、フォームは閉じない。送信中は二重に送れない
 */

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { extractApiErrorMessage, isStaleDataConflict } from '@/lib/admin/api-error-message';
import {
  FREEZE_DURATION_DAYS_MAX,
  FREEZE_DURATION_DAYS_MIN,
  FREEZE_REASON_MAX_LENGTH,
  FreezeBodySchema,
  UnfreezeBodySchema,
  type FreezeBody,
} from '@/lib/admin/users-schemas';

export type UserFreezeFormProps = {
  /** 対象の利用者の ID */
  userId: string;
  /** いま凍結中か (true なら解除のフォーム、false なら凍結のフォーム) */
  isBanned: boolean;
  /** 永久 BAN を選べるのは super_admin だけ */
  isSuperAdmin: boolean;
};

type ReasonCategory = FreezeBody['reason_category'];
type BanType = FreezeBody['ban_type'];

/** 理由カテゴリの表示 (値は FreezeBodySchema の reason_category) */
export const FREEZE_REASON_CATEGORY_LABELS: Readonly<Record<ReasonCategory, string>> = {
  spam: 'スパム',
  abuse: '不正利用',
  policy_violation: '規約違反',
  other: 'その他',
};

const REASON_CATEGORIES: ReadonlyArray<ReasonCategory> = FreezeBodySchema.shape.reason_category.options;

/** 一時 BAN の日数の入力欄の初期値 (1 週間) */
const DEFAULT_DURATION_DAYS = '7';

function isReasonCategory(value: string): value is ReasonCategory {
  return (REASON_CATEGORIES as ReadonlyArray<string>).includes(value);
}

export function freezeEndpoint(userId: string): string {
  return `/api/admin/users/${encodeURIComponent(userId)}/freeze`;
}

export default function UserFreezeForm({ userId, isBanned, isSuperAdmin }: UserFreezeFormProps) {
  const router = useRouter();
  const [reasonCategory, setReasonCategory] = useState('');
  const [reasonDetail, setReasonDetail] = useState('');
  const [banType, setBanType] = useState<BanType>('temporary');
  const [durationDays, setDurationDays] = useState(DEFAULT_DURATION_DAYS);
  const [unfreezeReason, setUnfreezeReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 成功したときの文。入っている間は「済み」の表示にする */
  const [done, setDone] = useState<string | null>(null);

  async function send(method: 'POST' | 'DELETE', body: Record<string, unknown>, failureLabel: string): Promise<boolean> {
    setSubmitting(true);
    try {
      const res = await fetch(freezeEndpoint(userId), {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json: unknown = await res.json().catch(() => null);
      if (res.ok) return true;

      if (isStaleDataConflict(res.status, json)) {
        // 読んでから書くまでに対象が変わっていた (API は書いていない)。文を出し、ページを読み直していまの状態を出す
        setError(extractApiErrorMessage(json) ?? `${failureLabel}できませんでした。画面を読み込み直して、もう一度確認してください`);
        router.refresh();
        return false;
      }
      if (res.status === 401) {
        setError('ログインの有効期限が切れました。ログインし直してください');
        return false;
      }
      setError(extractApiErrorMessage(json) ?? `${failureLabel}できませんでした (HTTP ${res.status})。もう一度お試しください`);
      return false;
    } catch {
      setError(`通信に失敗しました。もう一度お試しください (${failureLabel}できたか分からないときは、ページを開き直して状態を確認してください)`);
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function handleFreeze(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    if (!isReasonCategory(reasonCategory)) {
      setError('理由カテゴリを選択してください');
      return;
    }
    const detail = reasonDetail.trim();
    if (detail === '') {
      setError('詳細理由を入力してください');
      return;
    }
    if (detail.length > FREEZE_REASON_MAX_LENGTH) {
      setError(`詳細理由は ${FREEZE_REASON_MAX_LENGTH} 文字以内で入力してください`);
      return;
    }
    const effectiveBanType: BanType = isSuperAdmin ? banType : 'temporary';
    const body: Record<string, unknown> = {
      ban_type: effectiveBanType,
      reason_category: reasonCategory,
      reason_detail: detail,
    };
    let temporaryDays: number | null = null;
    if (effectiveBanType === 'temporary') {
      const days = Number(durationDays);
      if (
        durationDays.trim() === '' ||
        !Number.isInteger(days) ||
        days < FREEZE_DURATION_DAYS_MIN ||
        days > FREEZE_DURATION_DAYS_MAX
      ) {
        setError(`BAN 期間は ${FREEZE_DURATION_DAYS_MIN}〜${FREEZE_DURATION_DAYS_MAX} の整数 (日数) で入力してください`);
        return;
      }
      body.duration_days = days;
      temporaryDays = days;
    }
    if (!FreezeBodySchema.safeParse(body).success) {
      setError('入力に誤りがあります。各項目を確認してください');
      return;
    }

    if (await send('POST', body, '凍結')) {
      setDone(temporaryDays === null ? '永久 BAN で凍結しました' : `${temporaryDays} 日間の一時 BAN で凍結しました`);
      router.refresh();
    }
  }

  async function handleUnfreeze(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    const reason = unfreezeReason.trim();
    if (reason === '') {
      setError('解除理由を入力してください');
      return;
    }
    if (reason.length > FREEZE_REASON_MAX_LENGTH) {
      setError(`解除理由は ${FREEZE_REASON_MAX_LENGTH} 文字以内で入力してください`);
      return;
    }
    const body = { reason };
    if (!UnfreezeBodySchema.safeParse(body).success) {
      setError('入力に誤りがあります。解除理由を確認してください');
      return;
    }

    if (await send('DELETE', body, '凍結解除')) {
      setDone('凍結を解除しました');
      router.refresh();
    }
  }

  if (done) {
    return (
      <div className="space-y-4">
        <p role="status" className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
          {done}
        </p>
        <Link
          href={`/admin/users/${userId}`}
          className="block rounded-lg border border-gray-300 px-4 py-2 text-center text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
        >
          ユーザー詳細へ戻る
        </Link>
      </div>
    );
  }

  const errorBox = error && (
    <p role="alert" className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
      {error}
    </p>
  );

  const cancelLink = (
    <Link
      href={`/admin/users/${userId}`}
      className="flex-1 text-center px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
    >
      キャンセル
    </Link>
  );

  if (isBanned) {
    return (
      <form onSubmit={handleUnfreeze} noValidate>
        <div className="mb-4">
          <label htmlFor="reason" className="block text-sm font-medium text-gray-700 mb-1">
            解除理由 <span className="text-red-500">*</span>
          </label>
          <textarea
            id="reason"
            name="reason"
            required
            rows={4}
            value={unfreezeReason}
            onChange={(e) => setUnfreezeReason(e.target.value)}
            disabled={submitting}
            placeholder="凍結を解除する理由を入力してください"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
          />
        </div>
        {errorBox}
        <div className="flex gap-3">
          {cancelLink}
          <button
            type="submit"
            disabled={submitting}
            className="flex-1 px-4 py-2 rounded-lg bg-green-500 text-white text-sm font-medium hover:bg-green-600 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? '解除中…' : '凍結解除する'}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={handleFreeze} noValidate>
      <div className="mb-4">
        <label htmlFor="reason_category" className="block text-sm font-medium text-gray-700 mb-1">
          理由カテゴリ <span className="text-red-500">*</span>
        </label>
        <select
          id="reason_category"
          name="reason_category"
          required
          value={reasonCategory}
          onChange={(e) => setReasonCategory(e.target.value)}
          disabled={submitting}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
        >
          <option value="">選択してください</option>
          {REASON_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {FREEZE_REASON_CATEGORY_LABELS[category]}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-4">
        <label htmlFor="reason_detail" className="block text-sm font-medium text-gray-700 mb-1">
          詳細理由 <span className="text-red-500">*</span>
        </label>
        <textarea
          id="reason_detail"
          name="reason_detail"
          required
          rows={4}
          value={reasonDetail}
          onChange={(e) => setReasonDetail(e.target.value)}
          disabled={submitting}
          placeholder="凍結の詳細理由を入力してください"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
        />
      </div>

      <fieldset className="mb-4">
        <legend className="block text-sm font-medium text-gray-700 mb-1">
          BAN 種別 <span className="text-red-500">*</span>
        </legend>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="ban_type"
              value="temporary"
              checked={banType === 'temporary'}
              onChange={() => setBanType('temporary')}
              disabled={submitting}
            />
            一時 BAN
          </label>
          {isSuperAdmin && (
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="ban_type"
                value="permanent"
                checked={banType === 'permanent'}
                onChange={() => setBanType('permanent')}
                disabled={submitting}
              />
              永久 BAN (super_admin のみ)
            </label>
          )}
        </div>
      </fieldset>

      {banType === 'temporary' && (
        <div className="mb-6">
          <label htmlFor="duration_days" className="block text-sm font-medium text-gray-700 mb-1">
            BAN 期間 (日数)
          </label>
          <input
            id="duration_days"
            name="duration_days"
            type="number"
            min={FREEZE_DURATION_DAYS_MIN}
            max={FREEZE_DURATION_DAYS_MAX}
            value={durationDays}
            onChange={(e) => setDurationDays(e.target.value)}
            disabled={submitting}
            className="w-32 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
          />
        </div>
      )}

      <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-6">
        <p className="text-sm text-red-700 font-medium">注意</p>
        <p className="text-xs text-red-600 mt-1">
          この操作はユーザーのアクセスを停止します。admin_audit_logs に記録されます。
        </p>
      </div>

      {errorBox}

      <div className="flex gap-3">
        {cancelLink}
        <button
          type="submit"
          disabled={submitting}
          className="flex-1 px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-medium hover:bg-red-600 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? '凍結中…' : '凍結する'}
        </button>
      </div>
    </form>
  );
}
