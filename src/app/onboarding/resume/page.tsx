"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { parseErrorMessage } from "@/app/onboarding/questions/complete-flow";

// 再開ウェルカム画面 (OB-UI-01)
export default function OnboardingResumePage() {
  const [progress, setProgress] = useState<{
    currentStep: number;
    totalQuestions: number;
    nickname?: string;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isResetting, setIsResetting] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isSkipping, setIsSkipping] = useState(false);
  const [skipError, setSkipError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/onboarding/status');
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'in_progress' && data.progress) {
            setProgress({
              currentStep: data.progress.currentStep,
              totalQuestions: data.progress.totalQuestions,
              nickname: data.nickname,
            });
          } else if (data.status === 'completed') {
            // 完了済みの場合はホームへ
            window.location.href = '/home';
          } else if (data.status === 'not_started') {
            // 未開始の場合はウェルカムへ
            window.location.href = '/onboarding/welcome';
          }
        }
      } catch (error) {
        console.error('Failed to fetch onboarding status:', error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchStatus();
  }, []);

  const handleReset = async () => {
    setIsResetting(true);
    try {
      const res = await fetch('/api/onboarding/status', { method: 'DELETE' });
      if (res.ok) {
        window.location.href = '/onboarding/welcome';
      }
    } catch (error) {
      console.error('Failed to reset onboarding:', error);
    } finally {
      setIsResetting(false);
      setShowResetConfirm(false);
    }
  };

  // #1045 (F6-11): 「あとで設定する」は素の /home Link だったため、
  // onboarding_completed_at が未設定のまま middleware (src/middleware.ts →
  // lib/supabase/middleware.ts の updateSession → lib/onboarding-routing.ts の
  // resolveOnboardingRedirect) が status=in_progress の /home アクセスを
  // /onboarding/resume へ差し戻し、永久ループになっていた。
  // login ページ ((auth)/login/page.tsx) と auth コールバック
  // ((auth)/auth/callback/route.ts) も同じ onboarding_completed_at を見て
  // /onboarding/resume へ遷移させる同種のロジックを持つが、これらは
  // ログイン直後の遷移先決定であり、本ループ (/home ⇔ /onboarding/resume) の
  // 直接の原因は middleware 側である。
  // welcome page の handleSkip と同様に complete API (共通 skip ハンドラ) を呼んでから
  // 遷移することで、onboarding_completed_at を設定してループを断ち切る。
  //
  // #1045 round-2 (Suggestion): complete の res.ok を確認せず常に /home へ遷移していたため、
  // complete が失敗すると onboarding_completed_at が未設定のままとなり、/home→resume の
  // F6-11 ループが再現し得た (defense-in-depth)。fail-closed にし、失敗時はエラーを提示して
  // 再試行できるようにする (/home へは進ませない)。
  //
  // #1045 round-4 (Sonnet Warning): res.json().error を無条件にそのまま表示しており、
  // Supabase の生エラーメッセージ (テーブル名・カラム名等を含み得る) が画面に露出し得た。
  // complete-flow.ts の parseErrorMessage (許可リスト + 日本語マッピング、範囲外は
  // 汎用メッセージ) を使って表示内容を制御する。
  const handleSkipForNow = async () => {
    if (isSkipping) return;
    setIsSkipping(true);
    setSkipError(null);
    try {
      const res = await fetch('/api/onboarding/complete', { method: 'POST' });
      if (!res.ok) {
        setSkipError(await parseErrorMessage(res));
        setIsSkipping(false);
        return;
      }
      window.location.href = '/home';
    } catch (error) {
      console.error('Failed to skip onboarding:', error);
      setSkipError('通信エラーが発生しました。もう一度お試しください。');
      setIsSkipping(false);
    }
  };

  const progressPercent = progress
    ? Math.round((progress.currentStep / progress.totalQuestions) * 100)
    : 0;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-orange-50 to-white flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-orange-50 to-white flex flex-col items-center justify-center px-4 sm:px-6 lg:px-8 py-8 sm:py-12 text-center overflow-hidden relative">

      {/* 背景エフェクト */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute w-[300px] h-[300px] sm:w-[500px] sm:h-[500px] lg:w-[700px] lg:h-[700px] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-orange-100 rounded-full opacity-30 blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.8 }}
        className="relative z-10 max-w-sm sm:max-w-md lg:max-w-lg xl:max-w-xl w-full space-y-6 sm:space-y-8 lg:space-y-10"
      >
        {/* アイコン */}
        <div className="relative mx-auto w-24 h-24 sm:w-28 sm:h-28 lg:w-32 lg:h-32">
          <motion.div
            initial={{ scale: 0, rotate: -180 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: "spring", stiffness: 100, delay: 0.2 }}
            className="w-full h-full rounded-full bg-gradient-to-tr from-[#FF8A65] to-[#FFAB91] flex items-center justify-center text-white text-3xl sm:text-4xl shadow-2xl"
          >
            👋
          </motion.div>
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: [1, 1.2, 1] }}
            transition={{ repeat: Infinity, duration: 2 }}
            className="absolute inset-0 rounded-full border-4 border-[#FF8A65]/30"
          />
        </div>

        {/* タイトル */}
        <div className="space-y-3 sm:space-y-4">
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900"
          >
            おかえりなさい{progress?.nickname ? `、${progress.nickname}さん` : ''}！
          </motion.h1>
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
            className="text-gray-500 text-base sm:text-lg leading-relaxed"
          >
            前回の設定の続きから再開しましょう
          </motion.p>
        </div>

        {/* 進捗カード */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.8 }}
          className="bg-white/80 backdrop-blur border border-gray-100 rounded-2xl sm:rounded-3xl p-4 sm:p-6 shadow-xl"
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between text-sm">
              <span className="font-bold text-gray-600">設定の進捗</span>
              <span className="font-bold text-[#FF8A65]">{progressPercent}%</span>
            </div>
            <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${progressPercent}%` }}
                transition={{ duration: 0.8, delay: 1.0 }}
                className="h-full bg-gradient-to-r from-[#FF8A65] to-[#FFAB91] rounded-full"
              />
            </div>
            <p className="text-xs text-gray-400">
              {progress?.currentStep || 0} / {progress?.totalQuestions || 0} 問完了
            </p>
          </div>
        </motion.div>

        {/* ボタン */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.0 }}
          className="space-y-3"
        >
          <Link
            href="/onboarding/questions?resume=true"
            className="inline-flex items-center justify-center w-full py-4 sm:py-5 lg:py-6 rounded-full bg-[#333] hover:bg-black text-white font-bold text-base sm:text-lg shadow-xl hover:shadow-2xl transition-all duration-300 hover:scale-105"
          >
            続きから再開
          </Link>

          <button
            onClick={() => setShowResetConfirm(true)}
            className="inline-flex items-center justify-center w-full py-3 sm:py-4 rounded-full border-2 border-gray-200 hover:border-gray-300 text-gray-500 font-bold text-sm sm:text-base transition-all duration-300"
          >
            最初からやり直す
          </button>
        </motion.div>

        {/* スキップリンク */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.2 }}
        >
          <button
            onClick={handleSkipForNow}
            disabled={isSkipping}
            className="text-sm text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
          >
            {isSkipping ? 'しばらくお待ちください...' : 'あとで設定する'}
          </button>
          {/* #1045 round-2 (Suggestion): fail-closed — 失敗時はエラーを提示し再試行できるようにする */}
          {skipError && (
            <p className="text-xs text-red-500 mt-2">{skipError}</p>
          )}
        </motion.div>

      </motion.div>

      {/* リセット確認モーダル */}
      {showResetConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl"
          >
            <h3 className="text-lg font-bold text-gray-900 mb-2">確認</h3>
            <p className="text-gray-600 text-sm mb-6">
              これまでの回答がすべてリセットされます。<br />
              本当に最初からやり直しますか？
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowResetConfirm(false)}
                className="flex-1 py-3 rounded-full border-2 border-gray-200 text-gray-600 font-bold transition-colors hover:bg-gray-50"
              >
                キャンセル
              </button>
              <button
                onClick={handleReset}
                disabled={isResetting}
                className="flex-1 py-3 rounded-full bg-red-500 hover:bg-red-600 text-white font-bold transition-colors disabled:opacity-50"
              >
                {isResetting ? 'リセット中...' : 'リセット'}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
