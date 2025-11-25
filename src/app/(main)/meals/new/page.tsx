"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { motion, AnimatePresence } from "framer-motion";

export default function NewMealPage() {
  const router = useRouter();
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setPreview(url);
      await startUploadAndAnalysis(file);
    }
  };

  const startUploadAndAnalysis = async (file: File) => {
    setIsAnalyzing(true);
    
    try {
      // 1. 食事データの作成と画像アップロード
      const formData = new FormData();
      formData.append('file', file);
      formData.append('mealType', getMealType()); // 時間帯から自動判定
      formData.append('eatenAt', new Date().toISOString());
      
      const mealRes = await fetch('/api/meals', {
        method: 'POST',
        body: formData,
      });
      
      if (!mealRes.ok) throw new Error('Upload failed');
      const { meal } = await mealRes.json();

      // 2. AI解析リクエスト
      const aiRes = await fetch('/api/ai/nutrition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          mealId: meal.id,
          imageUrl: meal.photo_url 
        }),
      });

      // 解析失敗しても食事は作成されているので遷移する
      router.push(`/meals/${meal.id}`);

    } catch (error) {
      console.error(error);
      alert('エラーが発生しました。もう一度お試しください。');
      setIsAnalyzing(false);
    }
  };

  const getMealType = () => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 11) return 'breakfast';
    if (hour >= 11 && hour < 16) return 'lunch';
    if (hour >= 16 && hour < 23) return 'dinner';
    return 'snack';
  };

  return (
    <div className="min-h-screen bg-black text-white relative overflow-hidden flex flex-col">
      
      {/* ヘッダー */}
      <div className="absolute top-0 w-full z-50 p-6 flex justify-between items-center">
        <Link href="/home" className="w-10 h-10 rounded-full bg-black/40 backdrop-blur flex items-center justify-center border border-white/20">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        </Link>
        <span className="font-bold text-sm tracking-widest uppercase opacity-80">AI Lens Active</span>
        <div className="w-10 h-10" /> {/* Spacer */}
      </div>

      {/* メインエリア：カメラビューファインダー */}
      <div className="flex-1 relative flex items-center justify-center bg-gray-900">
        
        {preview ? (
          // プレビュー表示中
          <div className="relative w-full h-full">
            <img src={preview} alt="Preview" className="w-full h-full object-cover opacity-80" />
            
            {/* 解析中のエフェクト */}
            {isAnalyzing && (
              <div className="absolute inset-0 z-10">
                {/* スキャンライン */}
                <motion.div 
                  initial={{ top: 0 }}
                  animate={{ top: "100%" }}
                  transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                  className="absolute left-0 w-full h-1 bg-gradient-to-r from-transparent via-[#FF8A65] to-transparent shadow-[0_0_20px_#FF8A65]"
                />
                
                {/* 検出枠（ランダムに出現） */}
                <motion.div 
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ duration: 0.5, repeat: Infinity, repeatType: "reverse" }}
                  className="absolute top-1/3 left-1/4 w-32 h-32 border-2 border-[#FF8A65] rounded-lg opacity-50"
                >
                  <div className="absolute -top-6 left-0 bg-[#FF8A65] text-black text-xs font-bold px-2 py-1 rounded">Analyzing...</div>
                </motion.div>

                {/* 解析ステータス */}
                <div className="absolute bottom-32 left-0 w-full text-center space-y-2">
                  <motion.p 
                    animate={{ opacity: [0.5, 1, 0.5] }}
                    transition={{ duration: 1, repeat: Infinity }}
                    className="text-[#FF8A65] font-bold text-lg tracking-widest uppercase"
                  >
                    Generating Nutrition Data...
                  </motion.p>
                  <p className="text-xs text-gray-400">Sending to AI Cloud...</p>
                </div>
              </div>
            )}
          </div>
        ) : (
          // カメラ待機状態
          <div className="text-center space-y-6">
             <div className="w-64 h-64 border-2 border-white/20 rounded-3xl flex items-center justify-center relative">
               <div className="absolute top-0 left-0 w-6 h-6 border-t-4 border-l-4 border-white rounded-tl-xl" />
               <div className="absolute top-0 right-0 w-6 h-6 border-t-4 border-r-4 border-white rounded-tr-xl" />
               <div className="absolute bottom-0 left-0 w-6 h-6 border-b-4 border-l-4 border-white rounded-bl-xl" />
               <div className="absolute bottom-0 right-0 w-6 h-6 border-b-4 border-r-4 border-white rounded-br-xl" />
               <p className="text-white/50 text-sm">食事をフレームに合わせてください</p>
             </div>
          </div>
        )}

        {/* グリッドオーバーレイ */}
        <div className="absolute inset-0 pointer-events-none opacity-10" 
             style={{ backgroundImage: 'linear-gradient(white 1px, transparent 1px), linear-gradient(90deg, white 1px, transparent 1px)', backgroundSize: '100px 100px' }} 
        />
      </div>

      {/* コントロールエリア */}
      <div className="h-48 bg-black/80 backdrop-blur-xl border-t border-white/10 flex flex-col items-center justify-center gap-6 relative z-20">
        {!isAnalyzing && (
          <>
            <div className="flex gap-8 text-sm font-bold text-gray-400 uppercase tracking-widest">
              <button className="text-white border-b-2 border-[#FF8A65] pb-1">Photo</button>
              <button className="hover:text-white transition-colors">Barcode</button>
              <button className="hover:text-white transition-colors">Text</button>
            </div>

            <div className="flex items-center gap-8">
              <button className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center">
                 <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
              </button>

              <button 
                onClick={() => fileInputRef.current?.click()}
                className="w-20 h-20 rounded-full border-4 border-white flex items-center justify-center relative group"
              >
                <div className="w-16 h-16 rounded-full bg-white group-hover:scale-90 transition-transform duration-200" />
              </button>

              <button className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center">
                 <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
              </button>
            </div>
            
            <input 
              type="file" 
              ref={fileInputRef} 
              className="hidden" 
              accept="image/*"
              onChange={handleFileSelect}
            />
          </>
        )}
      </div>
    </div>
  );
}
