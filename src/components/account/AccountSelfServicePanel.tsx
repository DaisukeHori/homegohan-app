"use client";

/**
 * 本人の「データの書き出し」と「退会 (アカウントの削除)」の 2 つの枠。設定画面に入れない人のための画面が使う。
 *
 * 使う画面:
 *   - 凍結中の利用者の画面 (src/app/frozen/account/page.tsx。#1445)
 *   - 規約・プライバシーポリシーにまだ同意していない人の画面 (src/app/legal-consent/account/page.tsx。#1901 cross/20 Q-23:
 *     同意しなくても、本人が退会と書き出しをできるようにする)
 * どちらの画面も、呼ぶ API は退会 (POST /api/account/delete) と書き出し (GET /api/account/export) と、退会が 409 で止まったときの
 * 家族グループ / 組織の解散 (POST /api/family/dissolve・POST /api/org/dissolve。#1917 docs/design/family/11-self-dissolve.md §15.4) の 4 つだけ
 * (凍結中も・同意の前も止めない API。src/lib/auth/frozen.ts の FROZEN_ALLOWED_API_PATHS と
 * packages/shared/src/legal-consent-api.ts の LEGAL_CONSENT_EXEMPT_API_PATHS の両方にある)。
 * API の呼び方と退会のあとのログアウトの順番は、設定画面と共通 (src/lib/account-self-service.ts)。
 * 退会できたあとに何をするか (ログインの画面へ移る / 画面に「退会しました」を出す) と、退会できなかった (409) ときの案内は、画面ごとに違うので props で受ける。
 */

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { isInNativeWebView } from "@/lib/native-auth-bridge";
import {
  ACCOUNT_DELETE_CONFIRM_KEYWORD,
  ACCOUNT_DELETE_FAILED_MESSAGE,
  ACCOUNT_EXPORT_FAILED_MESSAGE,
  accountExportRateLimitedMessage,
  deleteOwnAccount,
  exportAccountData,
  signOutAfterAccountDeletion,
} from "@/lib/account-self-service";
import { SelfDissolveSection } from "@/components/membership/SelfDissolveSection";
import type { MembershipScope } from "@/lib/emails/membership/scope-label";
import { BLOCKED_SCOPE_UNKNOWN_GUIDANCE, SELF_DISSOLVED_NEXT_STEP } from "@/lib/membership/self-dissolve";

type Notice = { tone: "info" | "error"; text: string } | null;
/** 退会を止めている家族グループ / 組織 (409 の本文から読む。解散の区画に渡す。#1917) */
type BlockedScope = { scope: MembershipScope; id: string; name: string } | null;

export interface AccountSelfServicePanelProps {
  /** 要素の id の接頭辞 (画面ごとに変える。例: "frozen" → #frozen-delete-confirm) */
  idPrefix: string;
  /**
   * 退会できなかった (組織のオーナー・家族の代表者。409) ときに、サーバーの文に続けて出す案内。
   * その場に解散の区画を出すときの文 (立場の id が読めなかったときは BLOCKED_SCOPE_UNKNOWN_GUIDANCE を出す)
   */
  deleteBlockedGuidance: string;
  /** 退会してログアウトしたあとに呼ぶ */
  onDeleted: () => void;
  /** セッションが切れていた (401) ときに呼ぶ */
  onUnauthorized: () => void;
}

export function AccountSelfServicePanel({
  idPrefix,
  deleteBlockedGuidance,
  onDeleted,
  onUnauthorized,
}: AccountSelfServicePanelProps) {
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<Notice>(null);

  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState<Notice>(null);
  const [blockedScope, setBlockedScope] = useState<BlockedScope>(null);

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    setExportNotice(null);
    try {
      const result = await exportAccountData({ isNativeApp: isInNativeWebView() });
      switch (result.kind) {
        case "saved":
          setExportNotice({ tone: "info", text: "データを書き出しました。" });
          break;
        case "unauthorized":
          onUnauthorized();
          break;
        case "rate_limited":
          setExportNotice({ tone: "error", text: accountExportRateLimitedMessage(result.retryAfterSec) });
          break;
        case "failed":
          setExportNotice({ tone: "error", text: ACCOUNT_EXPORT_FAILED_MESSAGE });
          break;
      }
    } finally {
      setExporting(false);
    }
  };

  const handleDelete = async () => {
    if (confirmText !== ACCOUNT_DELETE_CONFIRM_KEYWORD || deleting) return;
    setDeleting(true);
    setDeleteNotice(null);
    const result = await deleteOwnAccount();
    switch (result.kind) {
      case "deleted":
        await signOutAfterAccountDeletion(createClient());
        onDeleted();
        return;
      case "unauthorized":
        onUnauthorized();
        return;
      case "blocked": {
        const nextScope: BlockedScope =
          result.blocker && result.scope
            ? {
                scope: result.blocker === "organization" ? "organization" : "family",
                id: result.scope.id,
                name: result.scope.name,
              }
            : null;
        setBlockedScope(nextScope);
        const guidance = nextScope ? deleteBlockedGuidance : BLOCKED_SCOPE_UNKNOWN_GUIDANCE;
        setDeleteNotice({ tone: "error", text: result.message ? `${result.message} ${guidance}` : guidance });
        break;
      }
      case "failed":
        setDeleteNotice({ tone: "error", text: ACCOUNT_DELETE_FAILED_MESSAGE });
        break;
    }
    setDeleting(false);
  };

  /** 解散の区画で解散が済んだ (200)。区画を閉じ、退会を続ける案内を出す (入力欄はそのまま) */
  const handleDissolved = () => {
    setBlockedScope(null);
    setDeleteNotice({ tone: "info", text: SELF_DISSOLVED_NEXT_STEP });
  };

  const noticeClass = (notice: NonNullable<Notice>) =>
    notice.tone === "error" ? "text-sm text-red-600" : "text-sm text-gray-600";

  const exportTitleId = `${idPrefix}-export-title`;
  const deleteTitleId = `${idPrefix}-delete-title`;
  const deleteConfirmId = `${idPrefix}-delete-confirm`;

  return (
    <>
      <section aria-labelledby={exportTitleId} className="bg-white rounded-2xl border border-gray-100 p-5 space-y-3">
        <h2 id={exportTitleId} className="font-bold text-gray-800">データを書き出す</h2>
        <p className="text-sm text-gray-500">これまでの記録などのデータを、JSON 形式のファイルで保存します。</p>
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting}
          className="w-full py-3 rounded-xl border border-gray-300 text-gray-700 font-bold hover:bg-gray-100 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {exporting ? "エクスポート中…" : "データをエクスポート"}
        </button>
        {exportNotice && (
          <p role={exportNotice.tone === "error" ? "alert" : "status"} className={noticeClass(exportNotice)}>
            {exportNotice.text}
          </p>
        )}
      </section>

      <section aria-labelledby={deleteTitleId} className="bg-white rounded-2xl border border-red-100 p-5 space-y-3">
        <h2 id={deleteTitleId} className="font-bold text-gray-800">アカウントを削除する (退会)</h2>
        <p className="text-sm text-gray-500">
          すべての食事記録・設定・データが<strong className="text-red-600">完全に削除</strong>されます。この操作は取り消せません。
          必要なデータは、先に書き出してください。
        </p>
        <label htmlFor={deleteConfirmId} className="block text-sm text-gray-600">
          確認のため「<span className="font-bold text-red-600">{ACCOUNT_DELETE_CONFIRM_KEYWORD}</span>」と入力してください
        </label>
        <input
          id={deleteConfirmId}
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={ACCOUNT_DELETE_CONFIRM_KEYWORD}
          disabled={deleting}
          className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-red-300 focus:border-transparent"
        />
        <button
          type="button"
          onClick={handleDelete}
          disabled={confirmText !== ACCOUNT_DELETE_CONFIRM_KEYWORD || deleting}
          className="w-full py-3 rounded-xl bg-red-600 text-white font-bold hover:bg-red-700 transition-colors text-sm disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {deleting ? "削除中…" : "アカウントを削除"}
        </button>
        {deleteNotice && (
          <p role="alert" className={noticeClass(deleteNotice)}>
            {deleteNotice.text}
          </p>
        )}
      </section>
      {blockedScope && (
        <SelfDissolveSection
          key={`${blockedScope.scope}-${blockedScope.id}`}
          scope={blockedScope.scope}
          scopeId={blockedScope.id}
          scopeName={blockedScope.name}
          onDissolved={handleDissolved}
          onUnauthorized={onUnauthorized}
        />
      )}
    </>
  );
}
