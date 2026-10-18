'use client';

/**
 * 個別審査画面 (/admin/moderation/{type}/{id}) の「非表示の解除」のカード (#1538 の項目 4)
 * 設計: docs/design/operator/13-hidden-content-restore.md §9.2
 *
 * - 親 (page) は条件なしで描く。カードの枠と見出しはこのコンポーネントが持つ。隠れていない (hiddenAt が null) うえに、
 *   結果の表示も失敗の文も無いときは何も描かない
 * - 戻せる期間 (89 日) を過ぎていたら (restorable = false)、理由の欄とボタンを出さず案内だけ
 * - 送る本文は { restore_note } (前後の空白を除く。空・5000 字超は送らずに画面で知らせる)
 * - 成功 (200) したら結果を表示して router.refresh() (左側の「表示」とステータスを更新する)。refresh で hiddenAt が null に
 *   なっても、このコンポーネントは同じ位置・同じ key のまま描かれるので、結果の表示 (done) は残る
 * - 409 / 410 (すでに表示されている・削除された・期限切れ・状態が変わった) は API の文面を出し、router.refresh() で状態を読み直す。
 *   refresh で hiddenAt が null になっても、文面 (error) は残る
 * - 500 は API の文面を出し、欄を閉じない (もう一度押せる)。401 はログインし直す案内
 * - 送信中は二重に送れない
 */

import { useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

export type ModerationRestoreFormProps = {
  /** モデレーション対象のタイプ (food / recipe) */
  type: string;
  /** 通報 (moderation_flags / recipe_flags) の ID */
  id: string;
  /** 隠した日時 (ISO)。隠れていなければ null。表示と、欄を出すかに使う */
  hiddenAt: string | null;
  /** 戻せる期間の中か (サーバーが isWithinHiddenContentRestoreWindow で決める。hiddenAt が null なら false) */
  restorable: boolean;
  /** 戻せる期間 (日)。案内の文に使う */
  restoreWindowDays: number;
  /** 保管期間 (日)。案内の文に使う */
  retentionDays: number;
};

/** 戻す理由の長さ (src/lib/admin/moderation-schemas.ts の MODERATION_NOTE_MIN_LENGTH / MODERATION_NOTE_MAX_LENGTH と同じ値。client には schemas を読み込まない) */
const NOTE_MIN_LENGTH = 1;
const NOTE_MAX_LENGTH = 5000;

/** API が「状態が変わった」と答えるコード (画面を読み直す) */
const REFRESH_STATUSES: ReadonlySet<number> = new Set([409, 410]);

type ApiErrorBody = { error?: { code?: unknown; message?: unknown } };
type ApiSuccessBody = { data?: { restored_ids?: unknown; approved_flag_ids?: unknown } };

const SUBMIT_LABEL = '表示に戻す';
const CARD_TITLE = '非表示の解除';

function formatJst(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

export default function ModerationRestoreForm({
  type,
  id,
  hiddenAt,
  restorable,
  restoreWindowDays,
  retentionDays,
}: ModerationRestoreFormProps) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 戻せたときの結果。入っている間は「戻した」の表示にする (refresh で hiddenAt が null になっても残す) */
  const [done, setDone] = useState<{ restoredCount: number } | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    const trimmed = note.trim();
    if (trimmed.length < NOTE_MIN_LENGTH) {
      setError('戻す理由を入力してください');
      return;
    }
    if (trimmed.length > NOTE_MAX_LENGTH) {
      setError(`戻す理由は ${NOTE_MAX_LENGTH} 文字以内で入力してください`);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/moderation/${encodeURIComponent(type)}/${encodeURIComponent(id)}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restore_note: trimmed }),
      });
      const json = (await res.json().catch(() => null)) as (ApiErrorBody & ApiSuccessBody) | null;

      if (res.ok) {
        const restoredIds = json?.data?.restored_ids;
        setDone({ restoredCount: Array.isArray(restoredIds) ? restoredIds.length : 1 });
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
          : `表示に戻せませんでした (HTTP ${res.status})。もう一度お試しください`,
      );
      if (REFRESH_STATUSES.has(res.status)) {
        // すでに表示されている・削除された・期限切れ・状態が変わった: 左側の表示を読み直す
        router.refresh();
      }
    } catch {
      setError('通信に失敗しました。もう一度お試しください (戻せたか分からないときは、ページを開き直して状態を確認してください)');
    } finally {
      setSubmitting(false);
    }
  }

  let body: ReactNode;
  if (done) {
    body = (
      <div className="space-y-2">
        <p role="status" className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
          表示に戻しました ({done.restoredCount} 行)。投稿者本人以外にも再び見えます。
        </p>
        <p className="text-xs text-gray-500">投稿者を BAN している場合、BAN はこの操作では解除されません (利用者の画面から解除します)。</p>
      </div>
    );
  } else if (hiddenAt === null) {
    // 隠れていない (はじめから・または 409 のあとの refresh で表示中になった)。失敗の文があればそれだけを残す
    if (error === null) return null;
    body = (
      <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
        {error}
      </p>
    );
  } else if (!restorable) {
    body = (
      <div className="space-y-2 text-sm text-gray-700">
        <p>隠した日時: {formatJst(hiddenAt)}</p>
        <p role="status" className="rounded-lg bg-gray-50 px-3 py-2 text-gray-600">
          隠してから {restoreWindowDays} 日を過ぎたため戻せません。保管期間 ({retentionDays} 日) を過ぎると、定期のジョブが完全に削除します。
        </p>
      </div>
    );
  } else {
    body = (
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <p className="text-sm text-gray-700">隠した日時: {formatJst(hiddenAt)}</p>
        <p className="text-xs text-gray-500">
          戻すと、このコンテンツは投稿者本人以外 (家族を含む) にも再び見えます。
          {type === 'food' && '家族への貼り付けの複製のうち、同じ操作で見えなくなったものと、同じ中身のまま見えなくなったものも一緒に戻ります。'}
          却下 (削除) にした通報は「承認」に変わります。
        </p>
        <div>
          <label htmlFor="restore_note" className="block text-sm font-medium text-gray-700 mb-1">
            戻す理由 <span className="text-red-500">*</span>
          </label>
          <textarea
            id="restore_note"
            name="restore_note"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={submitting}
            placeholder="戻す理由を入力してください (監査ログに残ります)"
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
        <button
          type="submit"
          disabled={submitting}
          className="w-full px-4 py-2 rounded-lg border border-orange-500 text-orange-600 text-sm font-medium hover:bg-orange-50 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? '戻しています…' : SUBMIT_LABEL}
        </button>
      </form>
    );
  }

  return (
    <section className="bg-white rounded-lg border border-gray-200 p-6">
      <h2 className="text-lg font-semibold text-gray-800 mb-4">{CARD_TITLE}</h2>
      {body}
    </section>
  );
}
