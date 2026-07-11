"use client";

/**
 * アカウント凍結通知ページ
 * #1030 [Crit] frozen_at/BAN の enforcement
 *
 * middleware (lib/supabase/middleware.ts) が frozen_at のセットされた
 * (かつ一時 BAN が未解除の) ユーザーのページナビゲーションをここへリダイレクトする。
 */

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

export default function FrozenPage() {
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = useState(false);

  const handleSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      const supabase = createClient();
      await supabase.auth.signOut();
    } finally {
      router.push("/login");
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4 sm:px-6 lg:px-8 py-12 text-center">
      <div className="max-w-md w-full space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">
          アカウントが凍結されています
        </h1>
        <p className="text-gray-600 leading-relaxed">
          利用規約違反等の理由により、このアカウントは現在凍結されています。
          一時的な凍結の場合は、解除予定日時の経過後に自動的にアクセスが回復します。
          心当たりがない場合や、詳細を確認したい場合はサポートまでお問い合わせください。
        </p>
        <div className="flex flex-col gap-3 pt-4">
          <a
            href="/contact"
            className="inline-flex justify-center items-center px-4 py-2 rounded-md bg-orange-500 text-white font-medium hover:bg-orange-600 transition-colors"
          >
            サポートに問い合わせる
          </a>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={isSigningOut}
            className="inline-flex justify-center items-center px-4 py-2 rounded-md border border-gray-300 text-gray-700 font-medium hover:bg-gray-100 transition-colors disabled:opacity-50"
          >
            ログアウト
          </button>
        </div>
      </div>
    </div>
  );
}
