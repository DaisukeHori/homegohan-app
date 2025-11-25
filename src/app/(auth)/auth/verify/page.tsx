"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";

function VerifyContent() {
  const [isResending, setIsResending] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);
  const searchParams = useSearchParams();
  const email = searchParams.get('email');
  const supabase = createClient();

  const handleResend = async () => {
    if (!email) {
      alert('メールアドレスが見つかりません。サインアップページから再度お試しください。');
      return;
    }

    setIsResending(true);
    try {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });

      if (error) {
        console.error('Resend error:', error);
        alert(`再送信に失敗しました: ${error.message}`);
        return;
      }

      setResendSuccess(true);
      setTimeout(() => setResendSuccess(false), 5000);
    } catch (error: any) {
      console.error('Resend error:', error);
      alert(`予期せぬエラーが発生しました: ${error.message || '不明なエラー'}`);
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
        <Button 
          variant="outline" 
          className="w-full py-6 rounded-full border-gray-200 hover:bg-gray-50 font-bold text-gray-700"
          onClick={() => window.open('https://gmail.com', '_blank')}
        >
          メールアプリを開く
        </Button>
        
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
      </div>
      
      <div className="pt-8">
        <Link href="/login" className="text-sm font-bold text-gray-400 hover:text-gray-600">
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
