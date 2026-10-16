"use client";

/**
 * 特定商取引法の最終確認の表示 (billing/01 §10.2・cross/08 §3.2 の形を踏襲)
 *
 * 必須の表示: プラン名 / 料金 (月額 or 年額、税込) / 自動更新であること・解約しない限り課金が続くこと / 解約方法 (/account/billing から) /
 * 解約予告期間 (いつでも。次回更新日まで利用可) / 最低契約期間 (なし) / 利用規約・プライバシーポリシーへのリンク /
 * 無料期間 (trial_days > 0 なら「X 日間の無料期間のあと課金」、0 なら「お申し込み後すぐに課金」)。
 * 「上記内容を確認しました」のチェックが ON のときだけ「申し込む」を押せる。can_purchase が false なら「すでに有効な契約があります」で押せない。
 */

import { useState } from "react";
import Link from "next/link";
import { BILLING_ERROR_MESSAGES, BILLING_PAGE_PATH, type BillingInterval } from "@/lib/billing/core";
import type { CheckoutPreview } from "@/lib/billing/service";

/** 料金の行の見出しと、更新の周期の言い方 (月額 / 年額) */
const INTERVAL_TEXT: Readonly<Record<BillingInterval, { label: string; renewal: string }>> = {
  month: { label: "月額料金", renewal: "毎月" },
  year: { label: "年額料金", renewal: "毎年" },
};

/** 金額の書き方の言語 (「1,480」のような桁区切り) */
const PRICE_LOCALE = "ja-JP";

export interface CheckoutConfirmationProps {
  preview: CheckoutPreview;
  /** 「申し込む」を押して POST /api/billing/checkout を待っている間 */
  submitting: boolean;
  /** 申し込みに失敗したときの固定の文 (BILLING_ERROR_MESSAGES など)。無ければ null */
  errorMessage: string | null;
  onConfirm: () => void;
}

export function CheckoutConfirmation({ preview, submitting, errorMessage, onConfirm }: CheckoutConfirmationProps) {
  const [confirmed, setConfirmed] = useState(false);
  const interval = INTERVAL_TEXT[preview.interval];
  const canSubmit = preview.can_purchase && confirmed && !submitting;

  return (
    <div className="space-y-6 p-6 border rounded-xl bg-white">
      <h2 className="text-xl font-bold">お申し込み内容の確認</h2>

      <table className="w-full text-sm">
        <tbody>
          <tr>
            <th scope="row" className="py-2 text-left font-normal text-gray-500">プラン名</th>
            <td className="py-2 font-medium">{preview.display_name}</td>
          </tr>
          <tr>
            <th scope="row" className="py-2 text-left font-normal text-gray-500">{interval.label}</th>
            <td className="py-2 font-medium">¥{preview.amount_jpy.toLocaleString(PRICE_LOCALE)} (税込)</td>
          </tr>
          <tr>
            <th scope="row" className="py-2 text-left font-normal text-gray-500">無料期間</th>
            <td className="py-2">
              {preview.trial_days > 0
                ? `${preview.trial_days}日間の無料期間のあと課金が始まります。`
                : "お申し込み後すぐに課金が始まります。"}
            </td>
          </tr>
          <tr>
            <th scope="row" className="py-2 text-left font-normal text-gray-500">更新</th>
            <td className="py-2">{interval.renewal}自動更新。解約しない限り{interval.renewal}課金されます。</td>
          </tr>
          <tr>
            <th scope="row" className="py-2 text-left font-normal text-gray-500">解約方法</th>
            <td className="py-2">
              <Link href={BILLING_PAGE_PATH} className="underline">
                プランとお支払い
              </Link>
              から 1 タップで解約できます。
            </td>
          </tr>
          <tr>
            <th scope="row" className="py-2 text-left font-normal text-gray-500">解約予告期間</th>
            <td className="py-2">いつでも解約できます (次回更新日まで利用できます)。</td>
          </tr>
          <tr>
            <th scope="row" className="py-2 text-left font-normal text-gray-500">最低契約期間</th>
            <td className="py-2">なし</td>
          </tr>
        </tbody>
      </table>

      <p className="text-sm text-gray-500">
        <Link href="/terms" className="underline">利用規約</Link> および{" "}
        <Link href="/privacy" className="underline">プライバシーポリシー</Link>
        に同意の上でお申し込みください。
      </p>

      {preview.can_purchase ? (
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            aria-required="true"
            className="mt-1"
          />
          <span className="text-sm">上記内容を確認しました</span>
        </label>
      ) : (
        <p role="status" className="text-sm text-gray-700">
          {BILLING_ERROR_MESSAGES.OP_SUBSCRIPTION_ALREADY_ACTIVE}
        </p>
      )}

      {errorMessage !== null && (
        <p role="alert" className="text-sm text-red-600">
          {errorMessage}
        </p>
      )}

      <button
        type="button"
        onClick={onConfirm}
        disabled={!canSubmit}
        aria-disabled={!canSubmit}
        className="w-full py-3 rounded-full font-bold text-sm text-white bg-[#E07A5F] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? "お手続き中…" : "申し込む"}
      </button>
    </div>
  );
}
