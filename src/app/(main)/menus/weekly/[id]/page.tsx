"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { toWeeklyMenuRequest } from "@/lib/converter";
import type { WeeklyMenuRequest, ProjectedImpact } from "@/types/domain";
import { PlanningDeck } from "@/components/planning/PlanningDeck";
import { Icons } from "@/components/icons";

interface WeeklyMenuPageProps {
  params: { id: string };
}

export default function WeeklyMenuDetailPage({ params }: WeeklyMenuPageProps) {
  const [request, setRequest] = useState<WeeklyMenuRequest | null>(null);
  const [activeTab, setActiveTab] = useState<'menu' | 'shopping' | 'report'>('menu');
  const [loading, setLoading] = useState(true);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isPlanningMode, setIsPlanningMode] = useState(false); // Toggle for Swipe UI

  const supabase = createClient();

  // ... (既存のuseEffectなどはそのまま) ...
  // ポーリングでステータス監視
  useEffect(() => {
    let intervalId: any;

    const fetchRequest = async () => {
      const { data, error } = await supabase
        .from('weekly_menu_requests')
        .select('*')
        .eq('id', params.id)
        .single();

      if (error) {
        console.error(error);
        setLoading(false);
        if (error.code === '22P02' || params.id === 'dummy-1') {
          setRequest(null);
          return;
        }
        return;
      }

      if (!data) {
        setLoading(false);
        setRequest(null);
        return;
      }

      const domainRequest = toWeeklyMenuRequest(data);
      setRequest(domainRequest);
      setLoading(false);

      // 初回ロード時、未確定ならプランニングモードをON
      if (domainRequest.status === 'completed' && !isPlanningMode && activeTab === 'menu') {
         // 自動でONにするか、ボタンでONにするか。今回は「未確定ならまずプランニング」とする
         // ただし、ユーザーが一覧から戻ってきた場合なども考慮し、stateで管理
      }

      if (domainRequest.status === 'completed' || domainRequest.status === 'failed' || domainRequest.status === 'confirmed') {
        clearInterval(intervalId);
      }
    };

    fetchRequest();
    intervalId = setInterval(fetchRequest, 3000);

    return () => clearInterval(intervalId);
  }, [params.id, supabase]);

  // Trigger Planning Mode if status is 'completed' (not confirmed yet)
  useEffect(() => {
    if (request?.status === 'completed') {
      setIsPlanningMode(true);
    }
  }, [request?.status]);


  const handleUpdateMeal = async (dayIndex: number, mealIndex: number, action: 'skip' | 'regen' | 'image') => {
    if (!request?.resultJson) return;
    const newDays = [...request.resultJson.days];
    const meal = newDays[dayIndex].meals[mealIndex];

    if (action === 'skip') {
      meal.isSkipped = !meal.isSkipped;
    } else if (action === 'regen') {
      // 個別料理の再生成
      try {
        const res = await fetch('/api/ai/menu/meal/regenerate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mealName: meal.dishes[0].name,
            mealType: meal.mealType,
            dayIndex: dayIndex,
            weeklyMenuRequestId: request.id,
          }),
        });
        if (!res.ok) {
          const errorData = await res.json();
          throw new Error(errorData.error || 'Failed to regenerate meal');
        }
        const { updatedMenu } = await res.json();
        // 更新されたメニューで状態を更新
        setRequest({
          ...request,
          resultJson: updatedMenu
        });
        return; // 早期リターン（状態は既に更新済み）
      } catch (e: any) {
        alert(`メニュー再生成に失敗しました: ${e.message}`);
        return;
      }
    } else if (action === 'image') {
      // 画像生成
      try {
        const res = await fetch('/api/ai/image/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: meal.dishes[0].name }),
        });
        if (!res.ok) {
          const errorData = await res.json();
          // 429エラー（クォータ超過）の場合は特別なメッセージを表示
          if (res.status === 429 || errorData.code === 'QUOTA_EXCEEDED') {
            alert(`画像生成のクォータが超過しています。\n\n${errorData.error || 'しばらく待ってから再度お試しください。'}\n\n${errorData.suggestion || ''}`);
          } else {
            throw new Error(errorData.error || 'Failed to generate image');
          }
          return;
        }
        const { imageUrl } = await res.json();
        meal.imageUrl = imageUrl;
      } catch (e: any) {
        alert(`画像生成に失敗しました: ${e.message}`);
        return;
      }
    }
    
    // Update local state
    setRequest({
      ...request,
      resultJson: {
        ...request.resultJson,
        days: newDays
      }
    });
  };

  const handlePlanningComplete = (updatedDays: any[]) => {
    if (!request) return;
    // Update local state with final days from deck
    setRequest({
      ...request,
      resultJson: {
        ...request.resultJson!,
        days: updatedDays
      }
    });
    setIsPlanningMode(false); // Exit planning mode
  };

  // ... (handleConfirmPlan, handleGenerateImage 等は既存のまま維持、または統合) ...
  // handleConfirmPlan はプランニング完了後の「最終確定」として使う

  const handleConfirmPlan = async () => {
    if (!request?.resultJson) return;
    setIsConfirming(true);
    try {
      const res = await fetch(`/api/ai/menu/weekly/${request.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: request.resultJson.days }),
      });

      if (!res.ok) throw new Error('Failed to confirm');
      
      setRequest({ ...request, status: 'confirmed' });
      alert('Plan Confirmed! Check your dashboard.');
    } catch (e) {
      console.error(e);
      alert('Failed to confirm plan.');
    } finally {
      setIsConfirming(false);
    }
  };

  // ... (Loading, Error states) ...
  if (loading) return <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50"><div className="w-16 h-16 border-4 border-[#FF8A65] border-t-transparent rounded-full animate-spin" /><p className="mt-4 text-gray-500 font-bold">Loading Plan...</p></div>;
  if (!request) return <div>Not Found</div>; // Improve later
  if (request.status === 'pending' || request.status === 'processing') return <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-8 text-center"><div className="text-4xl animate-bounce mb-4">👨‍🍳</div><h1 className="font-bold">AI Nutritionist is working...</h1></div>;
  if (request.status === 'failed') return <div>Failed</div>;

  const result = request.resultJson;
  const days = result?.days || [];
  const shoppingList = result?.shoppingList || [];
  const impact: ProjectedImpact | null = result?.projectedImpact || null;

  return (
    <div className="min-h-screen bg-gray-50 pb-24 relative">
      
      {/* Planning Mode Overlay */}
      <AnimatePresence>
        {isPlanningMode && (
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }} 
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-gray-100"
          >
            <PlanningDeck 
              days={days} 
              onComplete={handlePlanningComplete}
              onUpdateMeal={handleUpdateMeal}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ... (Existing Header, Tabs, Content) ... */}
      
      {/* ヘッダーエリア: 未来予測 (Impact) */}
      <div className="bg-foreground text-white p-6 pt-12 pb-20 rounded-b-[40px] relative overflow-hidden shadow-xl">
        {/* ... (既存のヘッダーコンテンツ) ... */}
        <div className="absolute inset-0 bg-gradient-to-br from-accent to-transparent opacity-20" />
        <div className="relative z-10">
          <Link href="/home" className="inline-flex items-center gap-2 text-sm text-white/60 hover:text-white mb-6 group">
            <Icons.Back className="w-4 h-4" /> Home
          </Link>
          <div className="flex justify-between items-start mb-6">
            <div>
              <h1 className="text-2xl font-bold">Projected Impact</h1>
              <p className="text-white/60 text-sm">1週間後の予測変化</p>
            </div>
            <div className="text-right">
              <span className="text-4xl font-black text-accent">{impact?.weightChange || '-'}</span>
              <p className="text-xs font-bold uppercase tracking-wider text-white/60">Weight</p>
            </div>
          </div>
          <div className="bg-white/10 backdrop-blur-md rounded-2xl p-4 border border-white/10">
            <p className="text-sm leading-relaxed text-white/90">&quot;{impact?.comment}&quot;</p>
          </div>
        </div>
      </div>

      {/* タブ切り替え */}
      <div className="px-6 -mt-8 relative z-20">
        <div className="bg-white rounded-2xl shadow-lg p-1.5 flex mb-6">
          {['menu', 'shopping', 'report'].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab as any)}
              className={`flex-1 py-3 rounded-xl text-sm font-bold transition-all ${
                activeTab === tab ? 'bg-foreground text-white shadow-md' : 'text-gray-400 hover:text-gray-600'
              }`}
            >
              {tab === 'menu' ? 'Menu' : tab === 'shopping' ? 'Shopping' : 'Advice'}
            </button>
          ))}
        </div>
      </div>

      {/* コンテンツ (一覧表示) - プランニング終了後に表示 */}
      <div className="px-6 pb-28">
        <AnimatePresence mode="wait">
          {activeTab === 'menu' && (
            <motion.div key="menu" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
              {days.map((day: any, i: number) => (
                <div key={i} className={`rounded-3xl p-6 shadow-sm border relative overflow-hidden ${day.isCheatDay ? 'bg-orange-50 border-orange-100' : 'bg-white border-gray-100'}`}>
                  {/* Header */}
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-12 h-12 rounded-xl bg-gray-900 text-white flex flex-col items-center justify-center font-bold">
                      <span className="text-xs opacity-60">{day.dayOfWeek.slice(0,3)}</span>
                      <span className="text-lg leading-none">{new Date(day.date).getDate()}</span>
                    </div>
                    <div>
                       <p className="text-xs text-gray-400 font-bold uppercase">Focus</p>
                       <p className="text-sm font-bold text-gray-800 line-clamp-1">{day.nutritionalAdvice}</p>
                    </div>
                  </div>
                  {/* Meals */}
                  <div className="space-y-4 pl-2">
                    {day.meals.map((meal: any, j: number) => (
                      <div key={j} className={`flex gap-4 items-start p-2 rounded-lg ${meal.isSkipped ? 'opacity-40 bg-gray-100' : ''}`}>
                        <div className="w-20 h-20 bg-gray-200 rounded-lg overflow-hidden relative shrink-0">
                          {meal.imageUrl ? (
                             // eslint-disable-next-line @next/next/no-img-element
                             <img src={meal.imageUrl} alt="meal" className="w-full h-full object-cover" />
                          ) : (
                             <div className="w-full h-full flex items-center justify-center text-xs text-gray-400">No Image</div>
                          )}
                        </div>
                        <div className="flex-1">
                          <p className="font-bold text-sm text-gray-800">{meal.dishes[0].name}</p>
                          <p className="text-xs text-gray-400">{meal.mealType}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </motion.div>
          )}
          {/* Shopping & Report tabs remain similar... */}
          {activeTab === 'shopping' && (
             <motion.div key="shopping" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
                {shoppingList.map((cat: any, i: number) => (
                  <div key={i} className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
                    <h3 className="font-bold text-gray-900 mb-2">{cat.category}</h3>
                    <ul className="text-sm text-gray-600 space-y-1">
                      {cat.items.map((item: string, j: number) => <li key={j}>• {item}</li>)}
                    </ul>
                  </div>
                ))}
             </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Re-open Planning Mode Button (if not confirmed) */}
      {request.status !== 'confirmed' && !isPlanningMode && (
        <div className="fixed bottom-24 right-6 z-40">
          <Button 
            onClick={() => setIsPlanningMode(true)}
            className="rounded-full w-14 h-14 bg-white text-black shadow-xl border border-gray-200 flex items-center justify-center hover:scale-110 transition-transform"
          >
            <Icons.Edit className="w-6 h-6" />
          </Button>
        </div>
      )}

      {/* Confirm Button Footer */}
      {request.status !== 'confirmed' && !isPlanningMode && (
        <div className="fixed bottom-0 left-0 w-full bg-white border-t border-gray-100 p-4 pb-8 z-30 shadow-lg">
           <Button 
             onClick={handleConfirmPlan} 
             disabled={isConfirming}
             className="w-full max-w-md mx-auto rounded-full bg-black text-white font-bold h-12 text-lg shadow-xl hover:bg-gray-800 transition-all active:scale-95 block"
           >
             {isConfirming ? "Confirming..." : "Confirm Plan 🚀"}
           </Button>
        </div>
      )}

    </div>
  );
}
