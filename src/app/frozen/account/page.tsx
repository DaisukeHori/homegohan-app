"use client";

/**
 * 凍結中の利用者の「退会とデータの書き出し」の画面 (#1445)
 *
 * #1445 のオーナーの選択 (2026-10-12): 「凍結 (BAN) 中の利用者も、退会とデータの書き出しをできるようにする (凍結の画面から行ける)」。
 * 凍結の画面 (/frozen) からここへ来る。middleware (lib/supabase/middleware.ts) は /frozen 以下を凍結の差し戻しの対象外にしているので、
 * 凍結中でもこの画面は開ける。この画面が呼ぶ API は、凍結中でも止めない 2 つ (src/lib/auth/frozen.ts の FROZEN_ALLOWED_API_PATHS) だけ。
 * 設定画面 (src/app/(main)/settings/page.tsx) は凍結中には開けない (ほかの API を多く呼ぶ) ので、退会と書き出しだけをここに置く。
 * API の呼び方と退会のあとのログアウトの順番は、設定画面と共通 (src/lib/account-self-service.ts)。
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { isInNativeWebView } from "@/lib/native-auth-bridge";
import {
  ACCOUNT_DELETE_CONFIRM_KEYWORD,
  ACCOUNT_EXPORT_FAILED_MESSAGE,
  accountExportRateLimitedMessage,
  deleteOwnAccount,
  exportAccountData,
  signOutAfterAccountDeletion,
} from "@/lib/account-self-service";

/** 退会できなかったとき (組織のオーナー・家族の代表者) に、サーバーの文に続けて出す案内 */
const DELETE_BLOCKED_GUIDANCE =
  "凍結中は、オーナー・代表者の譲渡や解散の操作ができません。お手数ですが、サポートにお問い合わせください。";
const DELETE_FAILED_MESSAGE = "アカウントの削除に失敗しました。時間をおいて再度お試しください。";

type Notice = { tone: "info" | "error"; text: string } | null;

export default function FrozenAccountPage() {
  const router = useRouter();

  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<Notice>(null);

  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState<Notice>(null);

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
          router.push("/login");
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
        router.push("/login");
        return;
      case "unauthorized":
        router.push("/login");
        return;
      case "blocked":
        setDeleteNotice({
          tone: "error",
          text: result.message ? `${result.message} ${DELETE_BLOCKED_GUIDANCE}` : DELETE_BLOCKED_GUIDANCE,
        });
        break;
      case "failed":
        setDeleteNotice({ tone: "error", text: DELETE_FAILED_MESSAGE });
        break;
    }
    setDeleting(false);
  };

  const noticeClass = (notice: NonNullable<Notice>) =>
    notice.tone === "error" ? "text-sm text-red-600" : "text-sm text-gray-600";

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center px-4 sm:px-6 lg:px-8 py-12">
      <div className="max-w-md w-full space-y-8">
        <div className="space-y-3 text-center">
          <h1 className="text-2xl font-bold text-gray-900">退会とデータの書き出し</h1>
          <p className="text-gray-600 leading-relaxed text-sm">
            アカウントが凍結されている間も、ご自身のデータの書き出しと、退会 (アカウントの削除) はできます。
          </p>
        </div>

        <section aria-labelledby="frozen-export-title" className="bg-white rounded-2xl border border-gray-100 p-5 space-y-3">
          <h2 id="frozen-export-title" className="font-bold text-gray-800">データを書き出す</h2>
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

        <section aria-labelledby="frozen-delete-title" className="bg-white rounded-2xl border border-red-100 p-5 space-y-3">
          <h2 id="frozen-delete-title" className="font-bold text-gray-800">アカウントを削除する (退会)</h2>
          <p className="text-sm text-gray-500">
            すべての食事記録・設定・データが<strong className="text-red-600">完全に削除</strong>されます。この操作は取り消せません。
            必要なデータは、先に書き出してください。
          </p>
          <label htmlFor="frozen-delete-confirm" className="block text-sm text-gray-600">
            確認のため「<span className="font-bold text-red-600">{ACCOUNT_DELETE_CONFIRM_KEYWORD}</span>」と入力してください
          </label>
          <input
            id="frozen-delete-confirm"
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

        <div className="flex flex-col gap-3 text-center text-sm">
          <a href="/contact" className="text-orange-600 font-medium hover:underline">
            サポートに問い合わせる
          </a>
          <a href="/frozen" className="text-gray-600 hover:underline">
            凍結のお知らせに戻る
          </a>
        </div>
      </div>
    </div>
  );
}
