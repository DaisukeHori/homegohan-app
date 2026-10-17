"use client";

/**
 * 認証リンクの戻り先で、サーバー (/auth/callback) が読めない URL のハッシュを読んで、知らせを出す画面 (#1574)
 *
 * /auth/callback は、認証の情報 (code・token_hash・token) が無いとき・メールアドレス変更の確認の 1 通目だと分かったときに、
 * 本来の遷移先を next に入れてここへ移す。ブラウザは元の URL のハッシュ (#message=... など) を引き継ぐ。
 *   - メールアドレス変更の 1 通目 (Secure email change): 「もう一方のメールアドレスのリンクも開いて」を出す
 *     (文はモバイルと共通。packages/shared の email-change-link.ts)。自動では移らない
 *   - ハッシュにエラー (期限切れなど) が付いている: /auth/callback がクエリのエラーで移るのと同じく、ログイン画面へ
 *   - どちらでもない: そのまま next へ移る
 * 判定は src/lib/auth/link-notice.ts の resolveLinkNotice。
 */

import { EMAIL_CHANGE_AWAITING_OTHER_NOTICE } from "@homegohan/shared";
import { Mail } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { resolveLinkNotice, type LinkNoticeResolution } from "@/lib/auth/link-notice";

export default function LinkNoticePage() {
  const router = useRouter();
  const [resolution, setResolution] = useState<LinkNoticeResolution | null>(null);

  useEffect(() => {
    // ハッシュはサーバーに届かず、描画の前には読めないので、ブラウザで開いたあとに読む
    const resolved = resolveLinkNotice({ search: window.location.search, hash: window.location.hash });
    setResolution(resolved);
    if (resolved.kind === "link_error") router.replace(resolved.redirectTo);
    else if (resolved.kind === "continue") router.replace(resolved.next);
  }, [router]);

  if (resolution?.kind === "email_change_awaiting_other") {
    return (
      <div
        data-testid="link-notice-email-change-awaiting-other"
        className="flex flex-col items-center justify-center min-h-[50vh] text-center space-y-8"
      >
        <div className="w-24 h-24 bg-blue-50 rounded-full flex items-center justify-center">
          <Mail className="w-10 h-10 text-blue-500" aria-hidden="true" />
        </div>
        <div className="space-y-4 max-w-sm mx-auto">
          <h1 className="text-2xl font-bold text-gray-900">メールアドレスの変更</h1>
          <p role="status" className="text-gray-600 leading-relaxed">
            {EMAIL_CHANGE_AWAITING_OTHER_NOTICE}
          </p>
        </div>
        <Link
          href={resolution.next}
          data-testid="link-notice-next"
          className="inline-flex items-center justify-center w-full max-w-sm py-4 rounded-full bg-[#FF8A65] hover:bg-[#FF7043] font-bold text-white transition-colors"
        >
          続ける
        </Link>
      </div>
    );
  }

  return (
    <div data-testid="link-notice-checking" className="flex items-center justify-center min-h-[50vh]">
      <p className="text-gray-500">確認しています...</p>
    </div>
  );
}
