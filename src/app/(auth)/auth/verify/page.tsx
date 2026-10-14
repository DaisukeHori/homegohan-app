"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { getSafeRedirectPath } from "@/lib/auth/safe-redirect";
import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AlertCircle } from "lucide-react";

function VerifyContent() {
  const [isResending, setIsResending] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const email = searchParams.get('email');
  // #1057 (UX1-01): signup から引き継いだ招待リダイレクト先(あれば)をメール確認リンクにも伝播
  const safeRedirect = getSafeRedirectPath(searchParams.get('redirect'));
  const supabase = createClient();

  const handleResend = async () => {
    setResendError(null);
    if (!email) {
      // #1057 (UX1-07): native alert() → 既存の赤インラインエラーに統一
      setResendError('メールアドレスが見つかりません。サインアップページから再度お試しください。');
      return;
    }

    setIsResending(true);
    try {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback${safeRedirect ? `?next=${encodeURIComponent(safeRedirect)}` : ''}`,
        },
      });

      if (error) {
        console.error('Resend error:', error);
        setResendError(`再送信に失敗しました: ${error.message}`);
        return;
      }

      setResendSuccess(true);
      setTimeout(() => setResendSuccess(false), 5000);
    } catch (error: any) {
      console.error('Resend error:', error);
      setResendError(`予期せぬエラーが発生しました: ${error.message || '不明なエラー'}`);
    } finally {
      setIsResending(false);
    }
  };
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] text-center space-y-8 animate-fade-up">
      
      {/* メールアニメーション */}
      <div className="relative w-32 h-32">
        <motion.div 
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 200, damping: 15 }}
          className="w-full h-full bg-orange-50 rounded-full flex items-center justify-center relative z-10"
        >
          <span className="text-5xl">✉️</span>
        </motion.div>
        <motion.div 
          initial={{ scale: 1, opacity: 0.5 }}
          animate={{ scale: 1.5, opacity: 0 }}
          transition={{ duration: 1.5, repeat: Infinity }}
          className="absolute inset-0 bg-orange-100 rounded-full -z-0"
        />
      </div>

      <div className="space-y-4 max-w-sm mx-auto">
        <h1 className="text-2xl font-bold text-gray-900">メールを確認してください</h1>
        <p className="text-gray-500 leading-relaxed">
          認証用リンクをメールでお送りしました。<br/>
          リンクをクリックして、登録を完了してください。
        </p>
      </div>

      <div className="pt-4 space-y-4 w-full">
        {/* #1057 (UX1-10): Gmail 固定のリンクだと他のメールサービス利用者には無関係な
            導線になるため、端末の既定メールアプリを開く mailto: リンクに変更 */}
        <a
          href="mailto:"
          className="inline-flex items-center justify-center w-full py-6 rounded-full border border-gray-200 hover:bg-gray-50 font-bold text-gray-700 transition-colors"
        >
          メールアプリを開く
        </a>

        <p className="text-xs text-gray-400">
          メールが届かない場合は、迷惑メールフォルダをご確認いただくか、<br/>
          <button
            onClick={handleResend}
            disabled={isResending}
            className="text-[#FF8A65] font-bold hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isResending ? '送信中...' : '再送信'}
          </button> してください。
        </p>
        {resendSuccess && (
          <motion.p
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-sm text-green-600 font-bold"
          >
            ✓ 確認メールを再送信しました
          </motion.p>
        )}
        {resendError && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            role="alert"
            className="flex items-start gap-2 p-3 rounded-xl bg-red-50 border border-red-200 text-left"
          >
            <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm font-medium text-red-800">{resendError}</p>
          </motion.div>
        )}
      </div>
      
      <div className="pt-8 space-y-3 text-center">
        <p className="text-sm text-gray-400">
          すでにアカウントをお持ちの場合は{" "}
          <Link href="/login" className="font-bold text-[#FF8A65] hover:text-[#FF7043] hover:underline underline-offset-4">
            ログインへ
          </Link>
        </p>
        <Link href="/login" className="text-sm font-bold text-gray-400 hover:text-gray-600 block">
          ログイン画面に戻る
        </Link>
      </div>

    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={
      <div className="flex flex-col items-center justify-center min-h-[50vh] text-center space-y-8">
        <div className="w-16 h-16 border-4 border-[#FF8A65] border-t-transparent rounded-full animate-spin" />
        <p className="text-gray-500">読み込み中...</p>
      </div>
    }>
      <VerifyContent />
    </Suspense>
  );
}
