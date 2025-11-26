"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { MealPlan, PlannedMeal } from "@/types/domain";
import { WeeklyMealPlanner } from "@/components/planning/WeeklyMealPlanner";
import { Icons } from "@/components/icons";

export default function WeeklyMenuPage() {
  const router = useRouter();
  const supabase = createClient();
  
  const [currentPlan, setCurrentPlan] = useState<MealPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNewMenuModal, setShowNewMenuModal] = useState(false);
  
  // Date Navigation
  const [targetDate, setTargetDate] = useState(new Date().toISOString().split('T')[0]);

  // Form State
  const [startDate, setStartDate] = useState("");
  const [note, setNote] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);

  // Fetch Plan based on targetDate
  useEffect(() => {
    const fetchPlan = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/meal-plans?date=${targetDate}`);
        if (res.ok) {
          const { mealPlan } = await res.json();
          setCurrentPlan(mealPlan);
        } else {
          // If no plan found for date, maybe fetch latest?
          // For now, just null
          setCurrentPlan(null);
        }
      } catch (e) {
        console.error("Failed to fetch meal plan", e);
      } finally {
        setLoading(false);
      }
    };
    fetchPlan();
  }, [targetDate]);

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
      
      // 生成後は詳細ページ（プランニング画面）へ遷移
      router.push(`/menus/weekly/${data.id}`);
      
    } catch (error: any) {
      alert(error.message || "エラーが発生しました");
      setIsGenerating(false);
    }
  };

  const handleUpdateMeal = async (dayId: string, mealId: string | null, updates: Partial<PlannedMeal>) => {
    if (!currentPlan) return;
    
    // Optimistic Update
    const updatedDays = currentPlan.days?.map(day => {
      if (day.id !== dayId) return day;
      return {
        ...day,
        meals: day.meals?.map(meal => {
          if (meal.id !== mealId) return meal;
          return { ...meal, ...updates };
        })
      };
    });

    setCurrentPlan({ ...currentPlan, days: updatedDays });
    
    if (mealId) {
      try {
        await fetch(`/api/meal-plans/meals/${mealId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates)
        });
      } catch (e) {
        console.error('Failed to update meal:', e);
      }
    }
  };

  const navigateWeek = (direction: 'prev' | 'next') => {
    const date = new Date(targetDate);
    date.setDate(date.getDate() + (direction === 'next' ? 7 : -7));
    setTargetDate(date.toISOString().split('T')[0]);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F7F6F3]">
      
      {/* Top Navigation Bar */}
      <div className="bg-white px-4 py-3 sticky top-0 z-20 border-b border-gray-100 flex justify-between items-center">
        <button 
          onClick={() => navigateWeek('prev')}
          className="p-2 rounded-full hover:bg-gray-100 text-gray-400"
        >
          <Icons.Back className="w-5 h-5 rotate-180" /> {/* Left Arrow */}
        </button>
        
        <div className="text-center">
          <h1 className="text-sm font-bold text-gray-900">
            {currentPlan ? currentPlan.title : 'No Plan'}
          </h1>
          <p className="text-[10px] text-gray-400">
            {currentPlan 
              ? `${new Date(currentPlan.startDate).toLocaleDateString()} - ${new Date(currentPlan.endDate).toLocaleDateString()}`
              : targetDate
            }
          </p>
        </div>

        <button 
          onClick={() => navigateWeek('next')}
          className="p-2 rounded-full hover:bg-gray-100 text-gray-400"
        >
          <Icons.Back className="w-5 h-5 rotate-180 transform scale-x-[-1]" /> {/* Right Arrow */}
        </button>
      </div>

      {/* Main Content */}
      <main>
        {currentPlan ? (
          <WeeklyMealPlanner 
            mealPlan={currentPlan}
            onUpdateMeal={handleUpdateMeal}
          />
        ) : (
          <div className="flex flex-col items-center justify-center min-h-[70vh] p-8 text-center">
            <div className="w-20 h-20 bg-white rounded-full shadow-sm flex items-center justify-center mb-6">
              <span className="text-4xl">📅</span>
            </div>
            <h2 className="text-xl font-bold text-gray-900 mb-2">献立がありません</h2>
            <p className="text-gray-500 text-sm mb-8">
              この週の献立はまだ作成されていません。<br/>
              AIと一緒に新しい献立を作りましょう。
            </p>
            <Button 
              onClick={() => setShowNewMenuModal(true)}
              className="rounded-full px-8 py-6 bg-black text-white font-bold shadow-xl hover:scale-105 transition-transform"
            >
              <Icons.Plus className="w-5 h-5 mr-2" />
              献立を作成する
            </Button>
          </div>
        )}
      </main>

      {/* New Menu Modal */}
      <AnimatePresence>
        {showNewMenuModal && (
          <>
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setShowNewMenuModal(false)}
              className="fixed inset-0 bg-black/60 z-[100] backdrop-blur-sm flex items-end md:items-center justify-center"
            />
            <motion.div
              initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="fixed bottom-0 md:bottom-auto md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2 w-full md:w-[480px] bg-white rounded-t-[32px] md:rounded-[32px] z-[101] p-8 pb-32 md:pb-8 shadow-2xl max-h-[90vh] overflow-y-auto"
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

      {/* Floating Action Button (Only show if plan exists to avoid duplicate CTA) */}
      {currentPlan && !showNewMenuModal && (
        <motion.button
          initial={{ scale: 0 }} animate={{ scale: 1 }}
          onClick={() => setShowNewMenuModal(true)}
          className="fixed bottom-24 right-6 w-14 h-14 bg-black text-white rounded-full shadow-2xl flex items-center justify-center z-30 hover:scale-110 transition-transform"
        >
          <Icons.Plus className="w-6 h-6" />
        </motion.button>
      )}

    </div>
  );
}
