"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

interface InvoiceDetail {
  id: string;
  stripe_event_id: string;
  event_type: string;
  processing_status: string;
  user_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  amount_paid: number | null;
  amount_due: number | null;
  currency: string | null;
  invoice_number: string | null;
  invoice_pdf: string | null;
  period_start: string | null;
  period_end: string | null;
  stripe_links: {
    customer: string | null;
    subscription: string | null;
    invoice: string | null;
  };
  received_at: string;
  processed_at: string | null;
  error_message: string | null;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    completed: "bg-green-100 text-green-700",
    processing: "bg-yellow-100 text-yellow-700",
    failed: "bg-red-100 text-red-700",
    pending: "bg-slate-100 text-slate-600",
  };
  return (
    <span className={`inline-block text-xs font-semibold px-2 py-1 rounded ${colors[status] ?? "bg-slate-100 text-slate-600"}`}>
      {status}
    </span>
  );
}

function formatAmount(amount: number | null, currency: string | null) {
  if (amount == null) return "-";
  const divisor = currency?.toLowerCase() === "jpy" ? 1 : 100;
  const value = amount / divisor;
  if (currency?.toLowerCase() === "jpy") return `¥${value.toLocaleString()}`;
  return `${currency?.toUpperCase()} ${value.toFixed(2)}`;
}

export default function InvoiceDetailPage() {
  const params = useParams();
  const id = params?.id as string;
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/admin/finance/invoices/${id}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.error) setError(json.error.message);
        else setInvoice(json.data as InvoiceDetail);
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="p-8 flex justify-center py-16">
        <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !invoice) {
    return (
      <div className="p-8">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          {error ?? "請求書が見つかりません"}
        </div>
        <Link href="/finance/invoices" className="mt-4 inline-block text-indigo-600 hover:underline text-sm">
          ← 一覧に戻る
        </Link>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/finance/invoices" className="text-indigo-600 hover:text-indigo-800 text-sm">
          ← 請求書一覧
        </Link>
      </div>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">
            請求書詳細
          </h1>
          {invoice.invoice_number && (
            <p className="text-slate-500 mt-1 font-mono">{invoice.invoice_number}</p>
          )}
        </div>
        <StatusBadge status={invoice.processing_status} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* 基本情報 */}
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-6">
          <h2 className="text-base font-semibold text-slate-700 mb-4">基本情報</h2>
          <dl className="space-y-3">
            <div className="flex justify-between text-sm">
              <dt className="text-slate-500">イベント種別</dt>
              <dd className="font-medium text-slate-700">{invoice.event_type}</dd>
            </div>
            <div className="flex justify-between text-sm">
              <dt className="text-slate-500">支払金額</dt>
              <dd className="font-bold text-slate-800 text-base">
                {formatAmount(invoice.amount_paid, invoice.currency)}
              </dd>
            </div>
            <div className="flex justify-between text-sm">
              <dt className="text-slate-500">請求金額</dt>
              <dd className="font-medium text-slate-700">
                {formatAmount(invoice.amount_due, invoice.currency)}
              </dd>
            </div>
            <div className="flex justify-between text-sm">
              <dt className="text-slate-500">対象期間</dt>
              <dd className="text-slate-700 text-right">
                {invoice.period_start
                  ? `${new Date(invoice.period_start).toLocaleDateString("ja-JP")} 〜 ${invoice.period_end ? new Date(invoice.period_end).toLocaleDateString("ja-JP") : "-"}`
                  : "-"}
              </dd>
            </div>
            <div className="flex justify-between text-sm">
              <dt className="text-slate-500">受信日時</dt>
              <dd className="text-slate-700">
                {new Date(invoice.received_at).toLocaleString("ja-JP")}
              </dd>
            </div>
            {invoice.processed_at && (
              <div className="flex justify-between text-sm">
                <dt className="text-slate-500">処理完了</dt>
                <dd className="text-slate-700">
                  {new Date(invoice.processed_at).toLocaleString("ja-JP")}
                </dd>
              </div>
            )}
            {invoice.error_message && (
              <div className="text-sm">
                <dt className="text-red-500 mb-1">エラー</dt>
                <dd className="bg-red-50 rounded px-3 py-2 text-red-700 text-xs font-mono">
                  {invoice.error_message}
                </dd>
              </div>
            )}
          </dl>
        </div>

        {/* Stripe リンク */}
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-6">
          <h2 className="text-base font-semibold text-slate-700 mb-4">Stripe リンク</h2>
          <div className="space-y-3">
            {invoice.stripe_links.customer && (
              <a
                href={invoice.stripe_links.customer}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between p-3 border border-slate-200 rounded-lg hover:border-indigo-300 hover:bg-indigo-50 transition-colors"
              >
                <span className="text-sm text-slate-700">Stripe Customer</span>
                <span className="text-xs text-indigo-600 font-mono">
                  {invoice.stripe_customer_id} ↗
                </span>
              </a>
            )}
            {invoice.stripe_links.subscription && (
              <a
                href={invoice.stripe_links.subscription}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between p-3 border border-slate-200 rounded-lg hover:border-indigo-300 hover:bg-indigo-50 transition-colors"
              >
                <span className="text-sm text-slate-700">Stripe Subscription</span>
                <span className="text-xs text-indigo-600 font-mono">
                  {invoice.stripe_subscription_id} ↗
                </span>
              </a>
            )}
            {invoice.stripe_links.invoice && (
              <a
                href={invoice.stripe_links.invoice}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between p-3 border border-indigo-200 rounded-lg bg-indigo-50 hover:bg-indigo-100 transition-colors"
              >
                <span className="text-sm font-medium text-indigo-700">Stripe Invoice で開く</span>
                <span className="text-indigo-600">↗</span>
              </a>
            )}
            {invoice.invoice_pdf && (
              <a
                href={invoice.invoice_pdf}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between p-3 border border-slate-200 rounded-lg hover:border-slate-300 transition-colors"
              >
                <span className="text-sm text-slate-700">請求書 PDF ダウンロード</span>
                <span className="text-slate-500">↓</span>
              </a>
            )}
          </div>

          {invoice.user_id && (
            <div className="mt-4 pt-4 border-t border-slate-100">
              <div className="text-xs text-slate-500 mb-1">ユーザー ID</div>
              <div className="font-mono text-xs text-slate-700 break-all">{invoice.user_id}</div>
            </div>
          )}
        </div>
      </div>

      {/* イベント ID */}
      <div className="mt-6 bg-slate-50 rounded-xl border border-slate-100 p-4">
        <div className="text-xs text-slate-400 mb-1">Stripe Event ID</div>
        <div className="font-mono text-sm text-slate-700">{invoice.stripe_event_id}</div>
      </div>
    </div>
  );
}
