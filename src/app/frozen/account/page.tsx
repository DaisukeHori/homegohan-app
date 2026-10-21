"use client";

/**
 * 凍結中の利用者の「退会とデータの書き出し」の画面 (#1445)
 *
 * #1445 のオーナーの選択 (2026-10-12): 「凍結 (BAN) 中の利用者も、退会とデータの書き出しをできるようにする (凍結の画面から行ける)」。
 * 凍結の画面 (/frozen) からここへ来る。middleware (lib/supabase/middleware.ts) は /frozen 以下を凍結の差し戻しの対象外にしているので、
 * 凍結中でもこの画面は開ける。この画面が呼ぶ API は、凍結中でも止めない API (src/lib/auth/frozen.ts の FROZEN_ALLOWED_API_PATHS) のうち退会と書き出しの 2 つだけ。
 * 設定画面 (src/app/(main)/settings/page.tsx) は凍結中には開けない (ほかの API を多く呼ぶ) ので、退会と書き出しだけをここに置く。
 * 退会と書き出しの 2 つの枠は、同意の前の画面 (/legal-consent/account。#1901) と共通の部品 (src/components/account/AccountSelfServicePanel.tsx)。
 */

import { useRouter } from "next/navigation";
import { AccountSelfServicePanel } from "@/components/account/AccountSelfServicePanel";

/** 退会できなかったとき (組織のオーナー・家族の代表者) に、サーバーの文に続けて出す案内 */
const DELETE_BLOCKED_GUIDANCE =
  "凍結中は、オーナー・代表者の譲渡や解散の操作ができません。お手数ですが、サポートにお問い合わせください。";

export default function FrozenAccountPage() {
  const router = useRouter();

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center px-4 sm:px-6 lg:px-8 py-12">
      <div className="max-w-md w-full space-y-8">
        <div className="space-y-3 text-center">
          <h1 className="text-2xl font-bold text-gray-900">退会とデータの書き出し</h1>
          <p className="text-gray-600 leading-relaxed text-sm">
            アカウントが凍結されている間も、ご自身のデータの書き出しと、退会 (アカウントの削除) はできます。
          </p>
        </div>

        <AccountSelfServicePanel
          idPrefix="frozen"
          deleteBlockedGuidance={DELETE_BLOCKED_GUIDANCE}
          onDeleted={() => router.push("/login")}
          onUnauthorized={() => router.push("/login")}
        />

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
