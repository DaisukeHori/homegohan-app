"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { toWeeklyMenuRequest } from "@/lib/converter";
import type { WeeklyMenuRequest, ProjectedImpact, MealPlan, PlannedMeal } from "@/types/domain";
import { PlanningDeck } from "@/components/planning/PlanningDeck";
import { WeeklyMealPlanner } from "@/components/planning/WeeklyMealPlanner";
import { Icons } from "@/components/icons";

interface WeeklyMenuPageProps {
  params: { id: string };
}

export default function WeeklyMenuDetailPage({ params }: WeeklyMenuPageProps) {
  const [request, setRequest] = useState<WeeklyMenuRequest | null>(null);
  const [mealPlan, setMealPlan] = useState<MealPlan | null>(null); // 確定後のデータ
  const [activeTab, setActiveTab] = useState<'menu' | 'shopping' | 'report'>('menu');
  const [loading, setLoading] = useState(true);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isPlanningMode, setIsPlanningMode] = useState(false);

  const supabase = createClient();

  // データ取得
  useEffect(() => {
    let intervalId: any;

    const fetchRequest = async () => {
      // 1. リクエスト情報の取得
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
      
      // 2. 確定済みなら MealPlan も取得
      if (domainRequest.status === 'confirmed') {
        try {
          const res = await fetch(`/api/meal-plans/by-request/${domainRequest.id}`);
          if (res.ok) {
            const { mealPlan } = await res.json();
            setMealPlan(mealPlan);
          }
        } catch (e) {
          console.error("Failed to fetch meal plan:", e);
        }
        setIsPlanningMode(false);
      } else if (domainRequest.status === 'completed' && !isPlanningMode) {
        // 生成完了直後はプランニングモードへ
        setIsPlanningMode(true);
      }

      setLoading(false);

      if (domainRequest.status === 'completed' || domainRequest.status === 'failed' || domainRequest.status === 'confirmed') {
        clearInterval(intervalId);
      }
    };

    fetchRequest();
    intervalId = setInterval(fetchRequest, 3000);

    return () => clearInterval(intervalId);
  }, [params.id, supabase]);

  // プランニング中の食事更新
  const handleUpdateMeal = async (dayIndex: number, mealIndex: number, action: 'skip' | 'regen' | 'image') => {
    if (!request?.resultJson) return;
    const newDays = [...request.resultJson.days];
    const meal = newDays[dayIndex].meals[mealIndex];

    if (action === 'skip') {
      meal.isSkipped = !meal.isSkipped;
    } else if (action === 'regen') {
      alert('再生成機能は開発中です');
      return;
    } else if (action === 'image') {
      try {
        const res = await fetch('/api/ai/image/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: meal.dishes[0].name }),
        });
        if (!res.ok) throw new Error('Image generation failed');
        const { imageUrl } = await res.json();
        meal.imageUrl = imageUrl;
      } catch (e: any) {
        alert(`画像生成に失敗しました: ${e.message}`);
        return;
      }
    }
    
    setRequest({
      ...request,
      resultJson: { ...request.resultJson, days: newDays }
    });
  };

  // プランニング完了ハンドラ
  const handlePlanningComplete = (updatedDays: any[]) => {
    if (!request) return;
    setRequest({
      ...request,
      resultJson: { ...request.resultJson!, days: updatedDays }
    });
    setIsPlanningMode(false);
  };

  // 確定ハンドラ
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
      
      window.location.reload(); 
      
    } catch (e) {
      console.error(e);
      alert('Failed to confirm plan.');
      setIsConfirming(false);
    }
  };

  // ダッシュボードモードでの食事更新 (モック)
  const handleDashboardUpdate = (dayId: string, mealId: string | null, updates: Partial<PlannedMeal>) => {
    // UI Optimistic Update
    if (!mealPlan) return;
    
    const updatedDays = mealPlan.days?.map(day => {
      if (day.id !== dayId) return day;
      return {
        ...day,
        meals: day.meals?.map(meal => {
          if (meal.id !== mealId) return meal;
          return { ...meal, ...updates };
        })
      };
    });

    setMealPlan({ ...mealPlan, days: updatedDays });
    
    // TODO: API Call to persist update
    console.log('Update meal:', mealId, updates);
  };

  // --- Render Helpers ---

  if (loading) return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50">
      <div className="w-16 h-16 border-4 border-[#FF8A65] border-t-transparent rounded-full animate-spin" />
      <p className="mt-4 text-gray-500 font-bold">読み込み中...</p>
    </div>
  );
  
  if (!request) return <div>Not Found</div>;

  if (request.status === 'pending' || request.status === 'processing') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-8 text-center">
        <motion.div animate={{ rotate: 360 }} transition={{ duration: 2, repeat: Infinity, ease: "linear" }} className="text-6xl mb-6">👨‍🍳</motion.div>
        <h2 className="text-xl font-bold text-gray-900 mb-2">AI管理栄養士が献立を作成中です</h2>
        <p className="text-gray-500 text-sm mb-6">しばらくお待ちください...</p>
        <Link href="/menus/weekly" className="text-accent hover:underline text-sm font-bold">一覧に戻る →</Link>
      </div>
    );
  }

  // Data Source Selection
  const isDashboardMode = request.status === 'confirmed' && mealPlan;
  const daysData = (isDashboardMode ? mealPlan!.days : request.resultJson?.days) || [];
  const impact = request.resultJson?.projectedImpact;

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
              days={daysData as any[]} 
              onComplete={handlePlanningComplete}
              onUpdateMeal={handleUpdateMeal}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header Area (Common) */}
      <div className="bg-white sticky top-0 z-20 border-b border-gray-100">
        <div className="px-6 py-4 flex items-center justify-between">
          <Link href="/menus/weekly" className="inline-flex items-center gap-2 text-gray-500 hover:text-gray-900">
            <Icons.Back className="w-5 h-5" />
          </Link>
          <h1 className="font-bold text-lg">
            {isDashboardMode ? '今週の献立' : 'プランニング'}
          </h1>
          <div className="w-5" />
        </div>
        
        {/* Impact Summary (Collapsed in Dashboard) */}
        {!isDashboardMode && (
          <div className="px-6 pb-4">
            <div className="flex justify-between items-end">
              <div>
                <p className="text-xs text-gray-400 font-bold uppercase tracking-wider">EXPECTED IMPACT</p>
                <p className="text-sm text-gray-600 mt-1 line-clamp-1">{impact?.comment}</p>
              </div>
              <div className="text-right">
                <span className="text-2xl font-black text-accent">{impact?.weightChange}</span>
              </div>
            </div>
          </div>
        )}

        {/* Tabs (Only for Planning Mode) */}
        {!isDashboardMode && (
          <div className="px-6 pb-0 flex gap-6 border-b border-gray-100">
            {['menu', 'shopping'].map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab as any)}
                className={`pb-3 text-sm font-bold transition-colors relative ${
                  activeTab === tab ? 'text-gray-900' : 'text-gray-400'
                }`}
              >
                {tab === 'menu' ? '献立' : '買い物リスト'}
                {activeTab === tab && (
                  <motion.div layoutId="activeTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-black" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Content Area */}
      <div className={isDashboardMode ? "" : "p-6"}>
        {isDashboardMode ? (
          // Dashboard Mode: Use the new WeeklyMealPlanner component
          <WeeklyMealPlanner 
            mealPlan={mealPlan!} 
            onUpdateMeal={handleDashboardUpdate}
          />
        ) : (
          // Planning Mode (Fallback list view before confirm)
          <AnimatePresence mode="wait">
            {activeTab === 'menu' && (
              <motion.div key="menu" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-6">
                {daysData?.map((day: any, i: number) => (
                  <div key={i} className="space-y-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-gray-100 flex flex-col items-center justify-center text-xs font-bold text-gray-600">
                        <span>{new Date(day.date).getDate()}</span>
                        <span className="text-[10px] opacity-60">{day.dayOfWeek.slice(0,3)}</span>
                      </div>
                      <div>
                        <p className="font-bold text-gray-900">{day.dayOfWeek}</p>
                        <p className="text-xs text-gray-500">{day.nutritionalAdvice}</p>
                      </div>
                    </div>
                    <div className="pl-12 space-y-4">
                      {day.meals?.map((meal: any, j: number) => (
                        <div key={j} className="relative bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden flex gap-4 p-4">
                          <div className="w-16 h-16 bg-gray-100 rounded-xl shrink-0 overflow-hidden">
                            {meal.imageUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={meal.imageUrl} alt="meal" className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-lg">🍽️</div>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-bold text-gray-400 uppercase mb-1">{meal.mealType}</p>
                            <h4 className="font-bold text-gray-900 text-sm mb-1">{meal.dishes[0].name}</h4>
                            <p className="text-xs text-gray-500 line-clamp-1">{meal.dishes.slice(1).map((d: any) => d.name).join(', ')}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </motion.div>
            )}
            {activeTab === 'shopping' && (
              <motion.div key="shopping" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <div className="bg-white p-6 rounded-2xl border border-gray-100 text-center text-gray-500">
                  <p>買い物リストは確定後に詳細表示されます</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </div>

      {/* Confirm Button (Planning Mode / Not Confirmed) */}
      {!isDashboardMode && !isPlanningMode && (
        <div className="fixed bottom-0 left-0 w-full bg-white border-t border-gray-100 p-4 pb-8 z-30">
           <Button 
             onClick={handleConfirmPlan} 
             disabled={isConfirming}
             className="w-full rounded-full bg-black text-white font-bold h-12 text-lg"
           >
             {isConfirming ? "確定中..." : "この献立で確定する"}
           </Button>
        </div>
      )}

    </div>
  );
}
