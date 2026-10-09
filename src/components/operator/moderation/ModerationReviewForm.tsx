'use client';

/**
 * 個別審査画面 (/admin/moderation/{type}/{id}) の「審査アクション」欄 (#1101)
 *
 * 以前はサーバーコンポーネントの中の <form method="POST" action="/api/admin/moderation/..."> だった。
 * ブラウザのフォームは本文を application/x-www-form-urlencoded で送るが、API は JSON
 * (request.json()) だけを受け付けるため、「審査を確定」を押すたびに 400 INVALID_JSON の画面へ
 * 飛び、審査を確定できなかった。ここで fetch を使い、JSON で送る。
 *
 * - 送る本文は { action, ban_duration_days?, resolution_note? }。ban_duration_days は
 *   delete_and_temp_ban のときだけ (数値で)、resolution_note は入力があるときだけ付ける
 *   (空文字は API の検証で 400 になる)
 * - 成功 (200) したら、結果を表示して router.refresh() で左側の状態表示を更新する
 * - 失敗したら、API が返した文面をそのまま出す (API の 4xx / 5xx の本文は、こちらが書いた固定の文面)。
 *   判定は保存済みだが、コンテンツを隠せなかった / BAN できなかったときの 500・422 でも、
 *   フォームは閉じない。同じ操作をもう一度実行できる
 * - 送信中は二重に送れない
 */

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export type ModerationReviewFormProps = {
  /** モデレーション対象のタイプ (food / recipe) */
  type: string;
  /** 通報 (moderation_flags / recipe_flags) の ID */
  id: string;
  /** いまの審査状態。pending のときだけフォームを出す */
  status: string;
  /** 永久 BAN を選べるのは super_admin だけ */
  isSuperAdmin: boolean;
};

const ACTION_OPTIONS = [
  { value: 'approve', label: '承認 (問題なし)' },
  { value: 'delete_only', label: 'コンテンツ削除のみ' },
  { value: 'delete_and_warn', label: '削除 + 警告' },
  { value: 'delete_and_temp_ban', label: '削除 + 一時 BAN' },
  { value: 'delete_and_perm_ban', label: '削除 + 永久 BAN (super_admin のみ)', superAdminOnly: true },
  { value: 'escalate', label: 'エスカレーション' },
] as const;

const DELETE_ACTIONS: ReadonlySet<string> = new Set([
  'delete_only',
  'delete_and_warn',
  'delete_and_temp_ban',
  'delete_and_perm_ban',
]);

const BAN_DAYS_MIN = 1;
const BAN_DAYS_MAX = 365;
const NOTE_MAX_LENGTH = 5000;

type ApiErrorBody = {
  error?: { code?: unknown; message?: unknown };
};

type ApiSuccessBody = {
  data?: { status?: unknown; ban_applied?: unknown };
};

const STATUS_LABEL: Record<string, string> = {
  approved: '承認',
  rejected: '却下 (削除)',
  escalated: 'エスカレーション',
};

export default function ModerationReviewForm({ type, id, status, isSuperAdmin }: ModerationReviewFormProps) {
  const router = useRouter();
  const [action, setAction] = useState('');
  const [banDays, setBanDays] = useState('7');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 確定できたときの結果。入っている間は「確定済み」の表示にする */
  const [done, setDone] = useState<{ status: string; banApplied: boolean | null } | null>(null);

  if (done) {
    return (
      <div className="space-y-4">
        <p role="status" className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
          審査を確定しました。ステータス: {STATUS_LABEL[done.status] ?? done.status}
          {done.banApplied === true ? ' / 投稿者を BAN しました' : ''}
        </p>
        <Link
          href="/admin/moderation"
          className="block rounded-lg border border-gray-300 px-4 py-2 text-center text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
        >
          モデレーションの一覧へ戻る
        </Link>
      </div>
    );
  }

  if (status !== 'pending') {
    return (
      <div className="text-center py-8 text-gray-400">
        <p className="text-sm">このアイテムは既に審査済みです</p>
        <p className="text-xs mt-1">ステータス: {status}</p>
      </div>
    );
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    if (!action) {
      setError('アクションを選択してください');
      return;
    }

    const body: Record<string, unknown> = { action };
    if (action === 'delete_and_temp_ban') {
      const days = Number(banDays);
      if (banDays.trim() === '' || !Number.isInteger(days) || days < BAN_DAYS_MIN || days > BAN_DAYS_MAX) {
        setError(`BAN 期間は ${BAN_DAYS_MIN}〜${BAN_DAYS_MAX} の整数 (日数) で入力してください`);
        return;
      }
      body.ban_duration_days = days;
    }
    const trimmedNote = note.trim();
    if (trimmedNote.length > NOTE_MAX_LENGTH) {
      setError(`解決メモは ${NOTE_MAX_LENGTH} 文字以内で入力してください`);
      return;
    }
    if (trimmedNote) body.resolution_note = trimmedNote;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/moderation/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as (ApiErrorBody & ApiSuccessBody) | null;

      if (res.ok) {
        const savedStatus = json?.data?.status;
        const banApplied = json?.data?.ban_applied;
        setDone({
          status: typeof savedStatus === 'string' ? savedStatus : action === 'approve' ? 'approved' : 'rejected',
          banApplied: typeof banApplied === 'boolean' ? banApplied : null,
        });
        // 左側のステータス表示 (サーバーコンポーネント) を更新する
        router.refresh();
        return;
      }

      if (res.status === 401) {
        setError('ログインの有効期限が切れました。ログインし直してください');
        return;
      }
      const message = json?.error?.message;
      setError(
        typeof message === 'string' && message
          ? message
          : `審査を確定できませんでした (HTTP ${res.status})。もう一度お試しください`,
      );
    } catch {
      setError('通信に失敗しました。もう一度お試しください (確定できたか分からないときは、ページを開き直して状態を確認してください)');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <div>
        <label htmlFor="action" className="block text-sm font-medium text-gray-700 mb-1">
          アクション <span className="text-red-500">*</span>
        </label>
        <select
          id="action"
          name="action"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          disabled={submitting}
          required
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
        >
          <option value="">選択してください</option>
          {ACTION_OPTIONS.filter((option) => !('superAdminOnly' in option) || isSuperAdmin).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {DELETE_ACTIONS.has(action) && (
          <p className="mt-2 text-xs text-gray-500">
            「削除」を選ぶと、コンテンツは他のユーザー (家族を含む) から見えなくなります。投稿者本人には見えます。
            データはすぐには消えず、保管されます。
          </p>
        )}
      </div>

      {action === 'delete_and_temp_ban' && (
        <div>
          <label htmlFor="ban_duration_days" className="block text-sm font-medium text-gray-700 mb-1">
            BAN 期間 (日数)
          </label>
          <input
            id="ban_duration_days"
            name="ban_duration_days"
            type="number"
            min={BAN_DAYS_MIN}
            max={BAN_DAYS_MAX}
            value={banDays}
            onChange={(e) => setBanDays(e.target.value)}
            disabled={submitting}
            className="w-32 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
          />
        </div>
      )}

      <div>
        <label htmlFor="resolution_note" className="block text-sm font-medium text-gray-700 mb-1">
          解決メモ
        </label>
        <textarea
          id="resolution_note"
          name="resolution_note"
          rows={4}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={submitting}
          placeholder="審査内容の説明を入力してください"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
        />
      </div>

      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
        <p className="text-xs text-yellow-700">この操作は admin_audit_logs に記録されます。</p>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="flex gap-3">
        <Link
          href="/admin/moderation"
          className="flex-1 text-center px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          キャンセル
        </Link>
        <button
          type="submit"
          disabled={submitting}
          className="flex-1 px-4 py-2 rounded-lg bg-orange-500 text-white text-sm font-medium hover:bg-orange-600 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? '確定中…' : '審査を確定'}
        </button>
      </div>
    </form>
  );
}
