"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toWeeklyMenuRequest } from "@/lib/converter";
import type { WeeklyMenuRequest } from "@/types/domain";
import { Icons } from "@/components/icons";

export default function WeeklyMenuPage() {
  const router = useRouter();
  const supabase = createClient();
  const [requests, setRequests] = useState<WeeklyMenuRequest[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [showNewMenuModal, setShowNewMenuModal] = useState(false);

  // Form State
  const [startDate, setStartDate] = useState("");
  const [note, setNote] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);

  // 過去のリクエスト一覧を取得
  useEffect(() => {
    const fetchRequests = async () => {
      setLoadingHistory(true);
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;

        const { data, error } = await supabase
          .from('weekly_menu_requests')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(20); // Fetch more for gallery

        if (error) throw error;

        const domainRequests = (data || []).map(toWeeklyMenuRequest);
        setRequests(domainRequests);
      } catch (error) {
        console.error('Error fetching menu requests:', error);
      } finally {
        setLoadingHistory(false);
      }
    };
    fetchRequests();
  }, [supabase]);

  const handleGenerate = async () => {
    if (!startDate) {
      alert("開始日を選択してください");
      return;
    }

    setIsGenerating(true);
    try {
      const response = await fetch("/api/ai/menu/weekly/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate, note }),
      });

      if (!response.ok) throw new Error("生成リクエストに失敗しました");

      const data = await response.json();
      
      // 成功後、即座に詳細ページ（ローディング/プランニング画面）へ遷移
      router.push(`/menus/weekly/${data.id}`);
      
    } catch (error: any) {
      alert(error.message || "エラーが発生しました");
      setIsGenerating(false);
    }
  };

  // 最新のアクティブな献立（あれば）
  const activePlan = requests.find(r => r.status === 'confirmed' || r.status === 'completed');

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      
      {/* Header */}
      <div className="bg-white sticky top-0 z-20 px-6 py-4 border-b border-gray-100 flex justify-between items-center">
        <h1 className="text-xl font-black tracking-tight text-gray-900">Weekly Eats</h1>
        <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center">
           <span className="text-lg">📅</span>
        </div>
      </div>

      <main className="p-6 space-y-10">
        
        {/* 1. Active Plan / Hero Section */}
        <section>
           <div className="flex justify-between items-end mb-4">
             <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest">今週の献立</h2>
           </div>
           
           {activePlan ? (
             <Link href={`/menus/weekly/${activePlan.id}`}>
               <motion.div 
                 whileHover={{ scale: 1.01 }}
                 whileTap={{ scale: 0.99 }}
                 className="relative aspect-[4/3] rounded-[32px] overflow-hidden shadow-sm border border-gray-100 bg-white group cursor-pointer"
               >
                  {/* Background Image Area - シンプルに */}
                  <div className="absolute inset-0 bg-gray-50">
                    {/* TODO: 実際の料理画像を表示する。今回はプレースホルダーとして穏やかなパターンを表示 */}
                    <div className="w-full h-full opacity-30 bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px]" />
                  </div>
                  
                  <div className="absolute inset-0 p-6 flex flex-col justify-between">
                    <div className="flex justify-between items-start">
                      <div>
                        <span className={`inline-block px-3 py-1 rounded-full text-[10px] font-bold mb-3 ${
                          activePlan.status === 'confirmed' ? 'bg-green-50 text-green-600' : 'bg-orange-50 text-orange-600'
                        }`}>
                          {activePlan.status === 'completed' ? '確認待ち' : '進行中'}
                        </span>
                        <h3 className="text-2xl font-bold text-gray-800 leading-tight font-serif">
                          {new Date(activePlan.startDate).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })}
                          <span className="text-sm font-sans text-gray-400 ml-1">からの週</span>
                        </h3>
                      </div>
                    </div>
                    
                    <div className="bg-white/80 backdrop-blur-sm rounded-2xl p-4 flex justify-between items-center border border-gray-100">
                       <div>
                         <p className="text-xs font-bold text-gray-400 mb-0.5">予想される変化</p>
                         <p className="text-lg font-bold text-gray-800">
                           体重 <span className="text-orange-500">{activePlan.resultJson?.projectedImpact?.weightChange || '---'}</span>
                         </p>
                       </div>
                       <div className="w-10 h-10 rounded-full bg-gray-900 text-white flex items-center justify-center font-bold shadow-md">
                         <Icons.ChevronRight className="w-4 h-4" />
                       </div>
                    </div>
                  </div>
               </motion.div>
             </Link>
           ) : (
             <div 
               onClick={() => setShowNewMenuModal(true)}
               className="aspect-[4/3] rounded-[32px] bg-white border border-dashed border-gray-300 flex flex-col items-center justify-center cursor-pointer hover:bg-gray-50 hover:border-orange-300 transition-all group"
             >
                <div className="w-14 h-14 rounded-full bg-orange-50 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                  <Icons.Plus className="w-6 h-6 text-orange-400" />
                </div>
                <p className="font-bold text-gray-600">来週の献立を作る</p>
                <p className="text-xs text-gray-400 mt-1">AIが提案します</p>
             </div>
           )}
        </section>

        {/* 2. Gallery (Past Logs) */}
        <section>
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4">Memories</h2>
          
          {loadingHistory ? (
             <div className="grid grid-cols-2 gap-4">
               {[1,2,3,4].map(i => <div key={i} className="aspect-square bg-gray-100 rounded-2xl animate-pulse" />)}
             </div>
          ) : (
             <div className="grid grid-cols-2 gap-4">
               {requests.filter(r => r.id !== activePlan?.id).map((req) => (
                 <Link key={req.id} href={`/menus/weekly/${req.id}`}>
                   <motion.div 
                     whileHover={{ y: -4 }}
                     className="aspect-square bg-white rounded-2xl overflow-hidden border border-gray-100 shadow-sm relative group"
                   >
                      {/* Thumbnail logic can be added here */}
                      <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/60" />
                      <div className="absolute bottom-0 left-0 p-4 text-white">
                        <p className="text-xs font-bold opacity-80">
                          {new Date(req.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </p>
                        <p className="font-bold text-sm truncate">
                          {req.resultJson?.projectedImpact?.weightChange || 'Log'}
                        </p>
                      </div>
                   </motion.div>
                 </Link>
               ))}
               
               {/* Add New Button in Grid */}
               <button 
                 onClick={() => setShowNewMenuModal(true)}
                 className="aspect-square rounded-2xl bg-gray-50 border border-gray-100 flex flex-col items-center justify-center hover:bg-gray-100 transition-colors"
               >
                 <Icons.Plus className="w-6 h-6 text-gray-300 mb-2" />
                 <span className="text-xs font-bold text-gray-400">New</span>
               </button>
             </div>
          )}
        </section>

      </main>

      {/* New Menu Modal (Bottom Sheet style) */}
      <AnimatePresence>
        {showNewMenuModal && (
          <>
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setShowNewMenuModal(false)}
              className="fixed inset-0 bg-black/60 z-40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="fixed bottom-0 left-0 right-0 bg-white rounded-t-[32px] z-50 p-8 pb-12 shadow-2xl"
            >
               <div className="w-12 h-1.5 bg-gray-200 rounded-full mx-auto mb-8" />
               
               <h2 className="text-2xl font-black text-gray-900 mb-2">Design Next Week</h2>
               <p className="text-gray-500 text-sm mb-8">来週の目標や予定を教えてください。</p>
               
               <div className="space-y-6">
                 <div className="space-y-2">
                    <Label className="font-bold text-gray-700">開始日</Label>
                    <Input 
                      type="date" 
                      value={startDate} 
                      onChange={(e) => setStartDate(e.target.value)}
                      className="h-14 rounded-xl bg-gray-50 border-gray-100 text-lg"
                    />
                 </div>
                 
                 <div className="space-y-2">
                    <Label className="font-bold text-gray-700">今週のフォーカス・予定</Label>
                    <textarea 
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="例: 水曜日は飲み会、週末はジムに行きます。"
                      className="w-full h-32 p-4 rounded-xl bg-gray-50 border-gray-100 text-base resize-none focus:ring-2 focus:ring-accent focus:bg-white transition-all"
                    />
                 </div>
                 
                 <Button 
                   onClick={handleGenerate}
                   disabled={isGenerating || !startDate}
                   className="w-full h-14 rounded-xl bg-black text-white font-bold text-lg shadow-xl hover:scale-[1.02] active:scale-95 transition-all"
                 >
                   {isGenerating ? "AIが思考中..." : "献立を生成する 🪄"}
                 </Button>
               </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Floating Action Button (New) */}
      {!showNewMenuModal && (
        <motion.button
          initial={{ scale: 0 }} animate={{ scale: 1 }}
          onClick={() => setShowNewMenuModal(true)}
          className="fixed bottom-24 right-6 w-16 h-16 bg-black text-white rounded-full shadow-2xl flex items-center justify-center z-30 hover:scale-110 transition-transform"
        >
          <Icons.Plus className="w-8 h-8" />
        </motion.button>
      )}

    </div>
  );
}
