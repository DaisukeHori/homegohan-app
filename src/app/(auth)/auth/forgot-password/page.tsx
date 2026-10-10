"use client";

import { useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { TurnstileWidget, useTurnstile } from "@/components/auth/TurnstileWidget";
import { createClient } from "@/lib/supabase/client";
import { CAPTCHA_FAILED_MESSAGE, isCaptchaFailure } from "@/lib/auth/turnstile";
import { ArrowLeft, Mail, CheckCircle2, AlertCircle } from "lucide-react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #1165: bot 対策 (Cloudflare Turnstile)。サイトキーが未設定なら無効で、今までどおりに動く
  const captcha = useTurnstile();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // #1165: トークンは 1 回しか使えない。取り出した時点で、ウィジェットが次のトークンを取り直す。
    // Turnstile が有効なのにトークンが無いとき (Enter キーなどでボタンを通らずに送られた場合) は送らない
    const captchaToken = captcha.takeToken();
    if (captcha.enabled && !captchaToken) {
      setError("ボットではないことの確認が終わるまで、少しお待ちください。");
      return;
    }

    setLoading(true);

    const supabase = createClient();
    // #288: 大文字メールを正規化して既存アカウントとの混同を防ぐ
    const normalizedEmail = email.trim().toLowerCase();

    try {
      // resetPasswordForEmail は他の認証 API と違い、captchaToken を options の中ではなく、
      // 第 2 引数の直下 (redirectTo と同じ階層) に渡す。options に入れても Supabase には届かない。
      // Turnstile が無効のときは captchaToken を付けない (今までのリクエストと同じ)
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
        redirectTo: `${window.location.origin}/auth/reset-password`,
        ...(captchaToken ? { captchaToken } : {}),
      });

      if (resetError) {
        throw resetError;
      }

      setSuccess(true);
    } catch (err: any) {
      console.error("Password reset error:", err);
      // #1165: 英語の生のエラー文は出さない (ウィジェットは取り直し済み)
      setError(isCaptchaFailure(err) ? CAPTCHA_FAILED_MESSAGE : err.message || "パスワードリセットに失敗しました");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#FAF9F7] flex flex-col">
      {/* ヘッダー */}
      <div className="p-4">
        <Link href="/login" className="inline-flex items-center gap-2 text-gray-500 hover:text-gray-700">
          <ArrowLeft size={20} />
          <span className="text-sm font-medium">ログインに戻る</span>
        </Link>
      </div>

      {/* メインコンテンツ */}
      <div className="flex-1 flex items-center justify-center px-6 pb-20">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md"
        >
          <AnimatePresence mode="wait">
            {success ? (
              <motion.div
                key="success"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="bg-white rounded-3xl p-8 shadow-sm text-center"
              >
                <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-6">
                  <CheckCircle2 size={32} className="text-green-500" />
                </div>
                <h1 className="text-xl font-bold text-gray-900 mb-2">
                  メールを送信しました
                </h1>
                <p className="text-sm text-gray-500 mb-6">
                  <span className="font-medium text-gray-700">{email.trim().toLowerCase()}</span> 宛に
                  パスワードリセット用のリンクを送信しました。
                  メールを確認してください。
                </p>
                <p className="text-xs text-gray-400 mb-6">
                  メールが届かない場合は、迷惑メールフォルダを確認するか、
                  もう一度お試しください。
                </p>
                <div className="space-y-3">
                  <button
                    onClick={() => {
                      setSuccess(false);
                      setEmail("");
                    }}
                    className="w-full py-3 rounded-xl font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors"
                  >
                    別のメールアドレスで試す
                  </button>
                  <Link
                    href="/login"
                    className="block w-full py-3 rounded-xl font-bold text-white bg-[#E07A5F] hover:bg-[#D16A4F] transition-colors text-center"
                  >
                    ログインに戻る
                  </Link>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="form"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="bg-white rounded-3xl p-8 shadow-sm"
              >
                <div className="text-center mb-8">
                  <div className="w-16 h-16 rounded-full bg-[#FDF0ED] flex items-center justify-center mx-auto mb-4">
                    <Mail size={28} className="text-[#E07A5F]" />
                  </div>
                  <h1 className="text-xl font-bold text-gray-900 mb-2">
                    パスワードをお忘れですか？
                  </h1>
                  <p className="text-sm text-gray-500">
                    登録したメールアドレスを入力してください。
                    パスワードリセット用のリンクをお送りします。
                  </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      メールアドレス
                    </label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="example@email.com"
                      required
                      className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-[#E07A5F] focus:ring-2 focus:ring-[#E07A5F]/20 outline-none transition-all"
                    />
                  </div>

                  <TurnstileWidget {...captcha.widgetProps} action="password-reset" />

                  {error && (
                    <motion.div
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex items-center gap-2 p-3 rounded-xl bg-red-50 text-red-600"
                    >
                      <AlertCircle size={18} />
                      <span className="text-sm">{error}</span>
                    </motion.div>
                  )}

                  <button
                    type="submit"
                    disabled={loading || !email || !captcha.ready}
                    className="w-full py-4 rounded-xl font-bold text-white bg-[#E07A5F] hover:bg-[#D16A4F] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {loading ? (
                      <span className="flex items-center justify-center gap-2">
                        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        送信中...
                      </span>
                    ) : (
                      "リセットリンクを送信"
                    )}
                  </button>
                </form>

                <div className="mt-6 text-center">
                  <p className="text-sm text-gray-500">
                    アカウントをお持ちでない方は{" "}
                    <Link href="/signup" className="font-bold text-[#E07A5F] hover:underline">
                      新規登録
                    </Link>
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </div>
  );
}

