"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function VerifyPage() {
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
          <button className="text-[#FF8A65] font-bold hover:underline">再送信</button> してください。
        </p>
      </div>
      
      <div className="pt-8">
        <Link href="/login" className="text-sm font-bold text-gray-400 hover:text-gray-600">
          ログイン画面に戻る
        </Link>
      </div>

    </div>
  );
}
