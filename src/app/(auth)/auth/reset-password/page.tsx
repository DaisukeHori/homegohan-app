"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { createClient } from "@/lib/supabase/client";
import { validatePassword, PASSWORD_MIN_LENGTH } from "@/lib/auth/validate-password";
import { clearUserScopedLocalStorage, broadcastSignOut } from "@/lib/user-storage";
import { notifyNativeSignOut } from "@/lib/native-auth-bridge";
import { Lock, CheckCircle2, AlertCircle, Eye, EyeOff } from "lucide-react";

/**
 * #1188: パスワードを更新できた後に、この端末を含むすべての端末のログインを無効にする。
 *
 * scope: 'global' は、このリセットメールのリンクで作られたセッションも含め、
 * そのユーザーの全セッションを失効させる (設計書 docs/design/cross/01-auth-session.md §9.1 の
 * 「全セッション revoke (リセット後は再ログイン強制)」。モバイルの reset-password.tsx と同じ挙動)。
 * 'others' だとこの端末のセッションが残ってしまうので使わない。
 * (GoTrue は updateUser({ password }) の時点で、更新した本人以外のセッションを自動で消す。
 *  それでも更新した本人のセッションは残るので、ここで明示的に消す。
 *  この挙動は tests/integration/security/password-update-revokes-sessions.test.ts で確認している。)
 *
 * パスワードはもう更新できているので、失敗しても例外にはしない (エラー画面に戻すと、
 * 更新済みなのに「失敗した」と見えてしまう)。無効にできたら true を返す。
 */
async function signOutEverywhere(supabase: ReturnType<typeof createClient>): Promise<boolean> {
  try {
    // CLAUDE.md: サインアウトでは Supabase の signOut より前に、端末のユーザー別データを消す
    clearUserScopedLocalStorage();
    // WebView ならネイティブへも signOut の前に知らせる (#1038 F7-10。理由は native-auth-bridge.ts の notifyNativeSignOut)
    notifyNativeSignOut();
    const { error } = await supabase.auth.signOut({ scope: "global" });
    if (error) {
      throw error;
    }
    // 同じブラウザで開いている他のタブも /login へ移す
    broadcastSignOut();
    return true;
  } catch (err) {
    console.error("Sign out error after password update:", err);
    return false;
  }
}

/** POST /api/auth/login-lock/clear (#1165)。例外は投げない */
async function clearLoginLockAfterReset(): Promise<void> {
  try {
    const response = await fetch("/api/auth/login-lock/clear", { method: "POST", credentials: "same-origin" });
    if (!response.ok) console.warn("Login lock clear after password reset failed:", response.status);
  } catch (err) {
    console.warn("Login lock clear after password reset failed:", err);
  }
}

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  // パスワードは更新できたが、全端末のログアウトを完了できなかった
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isValidSession, setIsValidSession] = useState<boolean | null>(null);

  useEffect(() => {
    // セッションの確認
    const checkSession = async () => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      setIsValidSession(!!session);
    };
    checkSession();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (password !== confirmPassword) {
      setError("パスワードが一致しません");
      return;
    }

    // #1057 (UX1-05): signup と要件を統一(以前は6文字のみでOKだったため
    // `123456` のような弱いパスワードでリセットが成立してしまっていた)
    const pwdError = validatePassword(password);
    if (pwdError) {
      setError(pwdError);
      return;
    }

    setLoading(true);
    setError(null);

    const supabase = createClient();
    
    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password: password,
      });

      if (updateError) {
        throw updateError;
      }

      // #1165: ログインに続けて失敗してロックされていても、再設定を済ませたらすぐにログインできるようにする
      // (設計 docs/design/cross/01-auth-session.md §8 「メール経由のリセットのみ解除可能」)。
      // 全端末のログアウトより前に呼ぶ (このリンクのセッションで呼ぶ API のため)。失敗してもロックは期限で外れるので、再設定は成功のまま
      await clearLoginLockAfterReset();

      // #1188: 更新できたら、この端末も含めて全端末をログアウトし、新しいパスワードで入り直してもらう
      const signedOut = await signOutEverywhere(supabase);
      setSignOutFailed(!signedOut);
      setSuccess(true);
      
      // 3秒後にログインページへリダイレクト
      setTimeout(() => {
        router.push("/login");
      }, 3000);
    } catch (err: any) {
      console.error("Password update error:", err);
      setError(err.message || "パスワードの更新に失敗しました");
    } finally {
      setLoading(false);
    }
  };

  // セッション確認中
  if (isValidSession === null) {
    return (
      <div className="min-h-screen bg-[#FAF9F7] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[#E07A5F] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // 無効なセッション
  if (isValidSession === false) {
    return (
      <div className="min-h-screen bg-[#FAF9F7] flex items-center justify-center px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md bg-white rounded-3xl p-8 shadow-sm text-center"
        >
          <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-6">
            <AlertCircle size={32} className="text-red-500" />
          </div>
          <h1 className="text-xl font-bold text-gray-900 mb-2">
            リンクが無効です
          </h1>
          <p className="text-sm text-gray-500 mb-6">
            パスワードリセットリンクが無効または期限切れです。
            もう一度パスワードリセットをリクエストしてください。
          </p>
          <Link
            href="/auth/forgot-password"
            className="block w-full py-3 rounded-xl font-bold text-white bg-[#E07A5F] hover:bg-[#D16A4F] transition-colors text-center"
          >
            パスワードリセットをリクエスト
          </Link>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FAF9F7] flex items-center justify-center px-6">
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
                パスワードを更新しました
              </h1>
              <p className="text-sm text-gray-500 mb-6">
                {signOutFailed
                  ? "新しいパスワードでログインできます。"
                  : "セキュリティのため、すべての端末からログアウトしました。新しいパスワードでログインしてください。"}
                自動的にログインページに移動します...
              </p>
              {signOutFailed && (
                <div
                  role="alert"
                  className="flex items-start gap-2 p-3 mb-6 rounded-xl bg-amber-50 text-amber-800 text-left"
                >
                  <AlertCircle size={18} className="shrink-0 mt-0.5" />
                  <span className="text-sm">
                    他の端末のログアウトを確認できませんでした。
                    心配な場合は、ログイン後に「設定」からログアウトしてください。
                  </span>
                </div>
              )}
              <Link
                href="/login"
                className="block w-full py-3 rounded-xl font-bold text-white bg-[#E07A5F] hover:bg-[#D16A4F] transition-colors text-center"
              >
                今すぐログイン
              </Link>
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
                  <Lock size={28} className="text-[#E07A5F]" />
                </div>
                <h1 className="text-xl font-bold text-gray-900 mb-2">
                  新しいパスワードを設定
                </h1>
                <p className="text-sm text-gray-500">
                  {PASSWORD_MIN_LENGTH}文字以上、英字と数字を含む新しいパスワードを入力してください。
                </p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    新しいパスワード
                  </label>
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      required
                      minLength={PASSWORD_MIN_LENGTH}
                      className="w-full px-4 py-3 pr-12 rounded-xl border border-gray-200 focus:border-[#E07A5F] focus:ring-2 focus:ring-[#E07A5F]/20 outline-none transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    パスワード（確認）
                  </label>
                  <input
                    type={showPassword ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    minLength={PASSWORD_MIN_LENGTH}
                    className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-[#E07A5F] focus:ring-2 focus:ring-[#E07A5F]/20 outline-none transition-all"
                  />
                </div>

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
                  disabled={loading || !password || !confirmPassword}
                  className="w-full py-4 rounded-xl font-bold text-white bg-[#E07A5F] hover:bg-[#D16A4F] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      更新中...
                    </span>
                  ) : (
                    "パスワードを更新"
                  )}
                </button>
              </form>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

