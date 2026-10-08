'use client';

/**
 * 返金の記録ダイアログ (#1185)
 * 請求書詳細 (/admin/finance/invoices/[id]) の「返金を記録して Stripe で開く」から開く。
 *
 * このアプリは返金を実行しない。返金は Stripe ダッシュボードで行うので、その前に
 * POST /api/admin/finance/refunds で「誰が・いつ・いくら・なぜ」を監査ログに記録する。
 * 記録できたときだけ API が Stripe のリンクを返すので、それを新しいタブで開く。
 * 記録できなかったときは Stripe を開かず、画面にエラーを出す (記録の残らない返金を作らない)。
 */

import { useEffect, useId, useState, type FormEvent } from 'react';
import { BottomSheet } from '@/components/common/BottomSheet';
import {
  REFUND_AMOUNT_MAX,
  REFUND_REASON_MAX_LENGTH,
  inputValueToMinor,
  minorToInputValue,
} from '@/lib/admin/refund';

export type RefundRecordDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  /** 返金の対象になるユーザー (請求書から特定できたもの) */
  userId: string;
  /** 返金する請求書の Stripe Invoice ID (in_...) */
  stripeInvoiceId: string;
  /** 請求書の支払済み金額 (通貨の最小単位)。返金額の初期値になる */
  amountPaid: number;
  /** 通貨 (Stripe の表記のままで良い。jpy / JPY / usd など) */
  currency: string;
  /** 表示用の請求書番号 */
  invoiceNumber?: string | null;
};

const STRIPE_DASHBOARD_PREFIX = 'https://dashboard.stripe.com/';

export default function RefundRecordDialog({
  isOpen,
  onClose,
  userId,
  stripeInvoiceId,
  amountPaid,
  currency,
  invoiceNumber,
}: RefundRecordDialogProps) {
  const titleId = useId();
  const amountId = useId();
  const reasonId = useId();
  const [amountInput, setAmountInput] = useState(() => minorToInputValue(amountPaid, currency));
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 記録できたときの Stripe ダッシュボードのリンク。入っている間は「記録済み」の表示にする */
  const [stripeUrl, setStripeUrl] = useState<string | null>(null);

  // 開くたびに入力を初期状態へ戻す (前回の理由が残って、そのまま別の返金を記録してしまわないように)
  useEffect(() => {
    if (!isOpen) return;
    setAmountInput(minorToInputValue(amountPaid, currency));
    setReason('');
    setError(null);
    setStripeUrl(null);
    setSubmitting(false);
  }, [isOpen, amountPaid, currency]);

  const isJpy = currency.toLowerCase() === 'jpy';
  const unitLabel = isJpy ? '円' : currency.toUpperCase();

  function handleClose() {
    // 記録中に閉じると結果が見えなくなるので、完了を待つ
    if (submitting) return;
    onClose();
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    const amount = inputValueToMinor(amountInput, currency);
    if (amount === null || amount <= 0) {
      setError(
        isJpy
          ? '返金額は 1 以上の整数 (円) で入力してください'
          : '返金額は 0 より大きい数字 (小数は 2 桁まで) で入力してください',
      );
      return;
    }
    if (amount > REFUND_AMOUNT_MAX) {
      setError('返金額が大きすぎます。Stripe で扱える金額の上限を超えています');
      return;
    }
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setError('返金の理由を入力してください');
      return;
    }
    if (trimmedReason.length > REFUND_REASON_MAX_LENGTH) {
      setError(`返金の理由は ${REFUND_REASON_MAX_LENGTH} 文字以内で入力してください`);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/finance/refunds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          stripe_invoice_id: stripeInvoiceId,
          amount,
          currency: currency.toUpperCase(),
          reason: trimmedReason,
        }),
      });
      const json = (await res.json().catch(() => null)) as {
        data?: { stripe_dashboard_url?: unknown };
        error?: { message?: string };
      } | null;

      if (!res.ok) {
        setError(json?.error?.message ?? '監査ログに記録できませんでした。返金はまだ行わず、もう一度お試しください');
        return;
      }

      const url = json?.data?.stripe_dashboard_url;
      if (typeof url !== 'string' || !url.startsWith(STRIPE_DASHBOARD_PREFIX)) {
        setError('監査ログには記録しましたが、Stripe のリンクを受け取れませんでした。Stripe ダッシュボードを直接開いてください');
        return;
      }

      setStripeUrl(url);
      // ブラウザによっては、非同期の処理のあとに開く新しいタブがブロックされる。
      // その場合に備えて、記録済みの表示にも同じリンクを出している
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      setError('通信に失敗しました。もう一度お試しください (記録されたか分からないときは、もう一度記録しても問題ありません)');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={handleClose}
      ariaLabelledBy={titleId}
      closeOnEscape={!submitting}
      closeOnOverlayClick={!submitting}
      panelClassName="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-white p-6 shadow-xl"
      testId="refund-record-dialog"
    >
      <h2 id={titleId} className="text-lg font-bold text-slate-800">
        返金を記録する
      </h2>

      {stripeUrl ? (
        <div className="mt-4 space-y-4">
          <p role="status" className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
            返金を監査ログに記録しました。
          </p>
          <p className="text-sm text-slate-600">
            Stripe ダッシュボードを新しいタブで開きました。開かないときは、下のリンクから開いて返金してください。
          </p>
          <a
            href={stripeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm font-medium text-indigo-700 hover:bg-indigo-100"
          >
            <span>Stripe ダッシュボードを開く</span>
            <span aria-hidden="true">↗</span>
          </a>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              閉じる
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} noValidate className="mt-4 space-y-4">
          <p className="text-sm text-slate-600">
            返金は Stripe ダッシュボードで行います。その前に、誰がいつ何のために返金するのかを監査ログへ記録します。
            記録できたときだけ Stripe が新しいタブで開きます。
          </p>

          <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            請求書: <span className="font-mono">{invoiceNumber ?? stripeInvoiceId}</span>
          </div>

          <div>
            <label htmlFor={amountId} className="mb-1 block text-sm font-medium text-slate-700">
              返金額 ({unitLabel})
            </label>
            <input
              id={amountId}
              type="text"
              inputMode={isJpy ? 'numeric' : 'decimal'}
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              disabled={submitting}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
            <p className="mt-1 text-xs text-slate-500">
              支払済みの金額が入っています。一部だけ返金するときは書き換えてください。
            </p>
          </div>

          <div>
            <label htmlFor={reasonId} className="mb-1 block text-sm font-medium text-slate-700">
              返金の理由 (必須)
            </label>
            <textarea
              id={reasonId}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting}
              maxLength={REFUND_REASON_MAX_LENGTH}
              rows={3}
              aria-required="true"
              placeholder="例: 二重に請求されたため"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
            <p className="mt-1 text-right text-xs text-slate-400">
              {reason.length} / {REFUND_REASON_MAX_LENGTH}
            </p>
          </div>

          {error && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={handleClose}
              disabled={submitting}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {submitting && (
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              )}
              {submitting ? '記録中…' : '記録して Stripe で開く'}
            </button>
          </div>
        </form>
      )}
    </BottomSheet>
  );
}
