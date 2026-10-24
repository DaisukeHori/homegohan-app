"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { TurnstileWidget, useTurnstile } from "@/components/auth/TurnstileWidget";
import { CAPTCHA_FAILED_MESSAGE, isCaptchaFailure } from "@/lib/auth/turnstile";
import { authErrorMessageForDisplay } from "@/lib/auth/auth-error-message";
import { getSafeRedirectPath } from "@/lib/auth/safe-redirect";
import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AlertCircle } from "lucide-react";

/** 再送が断られたときの文 (GoTrue の英語の文は付け足さない。#1917 の続き) */
const RESEND_FAILED_MESSAGE = '再送信に失敗しました。しばらくしてから再度お試しください。';
/** 再送で予期しない例外が起きたときの文 (例外の文面は出さず console に残す。#1917 の続き) */
const UNEXPECTED_RESEND_ERROR_MESSAGE = '予期せぬエラーが発生しました。しばらくしてから再度お試しください。';

function VerifyContent() {
  const [isResending, setIsResending] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const email = searchParams.get('email');
  // #1057 (UX1-01): signup から引き継いだ招待リダイレクト先(あれば)をメール確認リンクにも伝播
  const safeRedirect = getSafeRedirectPath(searchParams.get('redirect'));
  const supabase = createClient();
  // #1474: Supabase の CAPTCHA を有効にすると、トークンの無い再送 (resend) は断られる。
  // ログイン・新規登録と同じ Turnstile の部品でトークンを取る。サイトキーが未設定なら無効で、今までどおりに動く
  const captcha = useTurnstile();

  const handleResend = async () => {
    setResendError(null);
    if (!email) {
      // #1057 (UX1-07): native alert() → 既存の赤インラインエラーに統一
      setResendError('メールアドレスが見つかりません。サインアップページから再度お試しください。');
      return;
    }

    // #1474: トークンは 1 回しか使えない。取り出した時点で、ウィジェットが次のトークンを取り直す。
    // Turnstile が有効なのにトークンが無いとき (ボタンの無効化をすり抜けて呼ばれた場合) は送らない
    const captchaToken = captcha.takeToken();
    if (captcha.enabled && !captchaToken) {
      setResendError('ボットではないことの確認が終わるまで、少しお待ちください。');
      return;
    }

    setIsResending(true);
    try {
      // resend の captchaToken は options の中 (emailRedirectTo と同じ階層) に渡す。
      // Turnstile が無効のときは captchaToken を付けない (今までのリクエストと同じ)
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback${safeRedirect ? `?next=${encodeURIComponent(safeRedirect)}` : ''}`,
          ...(captchaToken ? { captchaToken } : {}),
        },
      });

      if (error) {
        console.error('Resend error:', error);
        // #1474: CAPTCHA の確認で断られたときは、英語の生のエラー文を出さない (ウィジェットは取り直し済み)。
        // GoTrue の英語の文 (回数の制限など) も付け足さない (#1917 の続き)
        setResendError(isCaptchaFailure(error) ? CAPTCHA_FAILED_MESSAGE : authErrorMessageForDisplay(error, RESEND_FAILED_MESSAGE));
        return;
      }

      setResendSuccess(true);
      setTimeout(() => setResendSuccess(false), 5000);
    } catch (error: any) {
      console.error('Resend error:', error);
      setResendError(
        isCaptchaFailure(error)
          ? CAPTCHA_FAILED_MESSAGE
          : authErrorMessageForDisplay(error, UNEXPECTED_RESEND_ERROR_MESSAGE),
      );
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

        {/* #1474: サイトキーが未設定なら何も出さない */}
        <TurnstileWidget {...captcha.widgetProps} action="resend-confirmation" />

        <p className="text-xs text-gray-400">
          メールが届かない場合は、迷惑メールフォルダをご確認いただくか、<br/>
          <button
            type="button"
            data-testid="resend-confirmation-button"
            onClick={handleResend}
            disabled={isResending || !captcha.ready}
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
