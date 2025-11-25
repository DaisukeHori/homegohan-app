"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { useHomeData } from "@/hooks/useHomeData";
import { Icons } from "@/components/icons";
import { createClient } from "@/lib/supabase/client";

export default function HomePage() {
  const {
    user,
    meals,
    loading,
    dailySummary,
    announcement,
    activityLevel,
    confirmedPlan, // New
    suggestion,
    updateActivityLevel,
    setAnnouncement,
    setSuggestion
  } = useHomeData();

  const [showSummary, setShowSummary] = useState(false);
  const [loggingMeal, setLoggingMeal] = useState<string | null>(null); // For quick log loading state
  const supabase = createClient();

  // --- Helper: Find Today's Plan ---
  const getTodayPlan = () => {
    if (!confirmedPlan?.resultJson) return null;
    
    const today = new Date().toISOString().split('T')[0];
    // Find the day in the plan that matches today
    // Assuming resultJson.days has valid dates.
    const todayPlan = confirmedPlan.resultJson.days.find((d: any) => d.date === today);
    return todayPlan;
  };

  const todayPlan = getTodayPlan();

  // --- Helper: Quick Log ---
  const handleQuickLog = async (mealType: string, dishName: string, approxCals: number) => {
    if (!user) return;
    setLoggingMeal(dishName);
    
    try {
      // Insert into meals table
      const { error } = await supabase.from('meals').insert({
        user_id: user.id,
        meal_type: mealType,
        eaten_at: new Date().toISOString(),
        memo: dishName, // Use the dish name as memo
        // Ideally we should also store estimated nutrition, but for now this is a simple log.
        // If we want to be fancy, we could insert a dummy meal_nutrition_estimate too.
      });

      if (error) throw error;

      // Optimistic UI update or refetch would be good here, 
      // but useHomeData's useEffect dependency array is [] so it won't auto-refresh.
      // For now, just reload or show success.
      alert("記録しました！");
      window.location.reload(); // Simple reload to refresh data

    } catch (e) {
      console.error("Quick log failed", e);
      alert("記録に失敗しました");
    } finally {
      setLoggingMeal(null);
    }
  };

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 5) return "こんばんは";
    if (hour < 11) return "おはようございます";
    if (hour < 17) return "こんにちは";
    return "こんばんは";
  };

  const energyPercentage = Math.min(100, Math.round((dailySummary.energyKcal / dailySummary.targetEnergy) * 100));
  const proteinPercentage = Math.min(100, Math.round((dailySummary.proteinG / dailySummary.targetProtein) * 100));
  const fatPercentage = Math.min(100, Math.round((dailySummary.fatG / dailySummary.targetFat) * 100));
  const carbsPercentage = Math.min(100, Math.round((dailySummary.carbsG / dailySummary.targetCarbs) * 100));

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-12 relative overflow-hidden">
      
      {/* 背景装飾 */}
      <div className="absolute top-0 left-0 w-full h-48 lg:h-64 bg-foreground rounded-b-[40px] lg:rounded-b-[60px] z-0" />
      
      <div className="relative z-10 px-6 pt-12 lg:px-12 lg:pt-16 max-w-7xl mx-auto">
        
        {/* ヘッダーエリア */}
        <div className="flex flex-col lg:flex-row lg:items-end justify-between mb-8 lg:mb-12 text-white">
          <div className="mb-4 lg:mb-0">
            <p className="text-sm font-medium opacity-70 mb-1">
              {new Date().toLocaleDateString('ja-JP', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
            </p>
            <h1 className="text-3xl lg:text-4xl font-bold leading-tight">
              {getGreeting()}、<br className="lg:hidden"/>
              <span className="lg:text-5xl">{user?.nickname || user?.email?.split('@')[0] || 'ゲスト'}</span> さん
            </h1>
          </div>
          
          <div className="flex items-center gap-4">
            <div className="hidden lg:block text-right">
              <p className="text-sm opacity-80">現在のモード</p>
              <p className="font-bold text-lg text-accent">ダイエット中</p>
            </div>
            <Link href="/profile">
              <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur border border-white/30 flex items-center justify-center font-bold text-lg hover:bg-white/30 transition-colors cursor-pointer">
                {user?.email?.[0].toUpperCase() || 'G'}
              </div>
            </Link>
          </div>
        </div>

        {/* お知らせ & コンディション入力 & AI提案 */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          
          {/* お知らせ（あれば） */}
          <div className="lg:col-span-3">
            <AnimatePresence>
              {announcement && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="mb-6 lg:mb-8"
                >
                  <div className="bg-white/95 backdrop-blur-md p-4 lg:p-6 rounded-2xl shadow-sm border border-white/50 flex items-start gap-4 max-w-3xl mx-auto lg:mx-0">
                    <span className="text-2xl">📢</span>
                    <div className="flex-1">
                      <p className="text-base font-bold text-gray-800">{announcement.title}</p>
                      <p className="text-sm text-gray-600 mt-1">{announcement.content}</p>
                    </div>
                    <button 
                      onClick={() => setAnnouncement(null)}
                      className="text-gray-400 hover:text-gray-600 p-1"
                    >
                      <Icons.Close className="w-5 h-5" />
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* コンディション入力 */}
          <div className="lg:col-span-2">
             <div className="bg-white/10 lg:bg-white/5 backdrop-blur-md rounded-2xl p-1 overflow-x-auto no-scrollbar border border-white/20">
               <div className="flex gap-2 min-w-max lg:w-full lg:grid lg:grid-cols-4">
                {[
                   { id: 'rest', label: '休息日', icon: '🛋️', color: 'bg-blue-100 text-blue-600' },
                   { id: 'normal', label: '通常', icon: '🚶', color: 'bg-gray-100 text-gray-600' },
                   { id: 'active', label: '活動的', icon: '🔥', color: 'bg-orange-100 text-orange-600' },
                   { id: 'stressed', label: 'ストレス', icon: '🤯', color: 'bg-purple-100 text-purple-600' }
                ].map((item) => (
                  <button
                    key={item.id}
                    onClick={() => updateActivityLevel(item.id)}
                    className={`flex-1 px-4 py-3 rounded-xl flex items-center justify-center gap-2 transition-all duration-200 ${
                      activityLevel === item.id 
                        ? 'bg-white text-gray-900 shadow-md transform scale-[1.02] ring-2 ring-accent ring-offset-2 ring-offset-transparent' 
                        : 'text-white/80 hover:bg-white/20'
                    }`}
                  >
                    <span className="text-xl">{item.icon}</span>
                    <span className="text-sm font-bold">{item.label}</span>
                  </button>
                ))}
               </div>
             </div>
          </div>

          {/* AIサジェスト */}
          <div className="lg:col-span-1">
            <AnimatePresence mode="wait">
              {suggestion ? (
                 <motion.div
                   key="suggestion"
                   initial={{ opacity: 0, y: 10 }}
                   animate={{ opacity: 1, y: 0 }}
                   exit={{ opacity: 0, y: -10 }}
                   className="bg-accent text-white p-5 rounded-2xl shadow-lg h-full flex items-start gap-3 relative overflow-hidden"
                 >
                   <div className="absolute top-0 right-0 p-4 opacity-10 text-6xl">🤖</div>
                   <div className="relative z-10 flex-1">
                     <p className="text-xs font-bold text-white/80 mb-1 uppercase tracking-wider">AI アドバイス</p>
                     <p className="text-sm font-medium leading-relaxed">{suggestion}</p>
                   </div>
                   <button onClick={() => setSuggestion(null)} className="text-white/60 hover:text-white relative z-10">
                     <Icons.Close className="w-4 h-4" />
                   </button>
                 </motion.div>
              ) : (
                <motion.div
                  key="placeholder"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="bg-white/5 backdrop-blur-sm border border-white/10 p-5 rounded-2xl h-full flex items-center justify-center text-white/40 text-sm"
                >
                  解析中...
                </motion.div>
              )}
            </AnimatePresence>
          </div>

        </div>

        {/* メイングリッド */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          
          {/* 左カラム: Today's Meals & Plan */}
          <div className="lg:col-span-8 order-2 lg:order-1 space-y-8">
            
            {/* 🎯 Today's Mission Widget (New) */}
            {todayPlan && (
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-gradient-to-br from-gray-900 to-gray-800 rounded-3xl p-6 shadow-xl text-white relative overflow-hidden"
              >
                <div className="absolute top-0 right-0 w-64 h-64 bg-accent rounded-full blur-3xl opacity-20 -translate-y-1/2 translate-x-1/4" />
                
                <div className="flex justify-between items-center mb-4 relative z-10">
                  <h3 className="font-bold text-lg flex items-center gap-2">
                    🚀 今日のミッション
                    <span className="text-xs bg-accent px-2 py-0.5 rounded text-white font-bold">Plan</span>
                  </h3>
                  <Link href={`/menus/weekly/${confirmedPlan?.id}`} className="text-xs text-white/60 hover:text-white transition-colors">
                    全てのプランを見る &rarr;
                  </Link>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 relative z-10">
                  {['breakfast', 'lunch', 'dinner'].map((type) => {
                    const plannedMeal = todayPlan.meals.find((m: any) => m.mealType === type);
                    const isSkipped = plannedMeal?.isSkipped;
                    const isLogged = meals.some(m => m.mealType === type); // Simple check if logged

                    if (!plannedMeal || isSkipped) return null;

                    return (
                      <div key={type} className={`bg-white/10 backdrop-blur border border-white/10 rounded-xl p-3 ${isLogged ? 'opacity-50' : ''}`}>
                        <div className="flex justify-between items-start mb-2">
                          <span className="text-[10px] font-bold uppercase text-white/60 tracking-wider">{type}</span>
                          {isLogged && <span className="text-[10px] bg-green-500 text-white px-1.5 py-0.5 rounded-md">Done</span>}
                        </div>
                        
                        <p className="font-bold text-sm mb-3 line-clamp-2 min-h-[2.5em]">
                          {plannedMeal.dishes[0].name}
                        </p>

                        {!isLogged ? (
                          <button 
                            onClick={() => handleQuickLog(type, plannedMeal.dishes[0].name, 600)} // Mock calories for now
                            disabled={loggingMeal === plannedMeal.dishes[0].name}
                            className="w-full py-2 rounded-lg bg-accent hover:bg-accent-dark text-white text-xs font-bold transition-colors flex items-center justify-center gap-1"
                          >
                            {loggingMeal === plannedMeal.dishes[0].name ? (
                              <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <><span>👍</span> 食べた！</>
                            )}
                          </button>
                        ) : (
                          <div className="w-full py-2 text-center text-xs text-white/40 font-bold border border-white/10 rounded-lg">
                            完了
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            )}

            {/* Today's Meals List */}
            <div>
              <div className="flex justify-between items-center mb-6">
                 <h3 className="font-bold text-gray-900 text-xl flex items-center gap-2">
                   🍽️ 食事ログ
                   <span className="text-sm font-normal text-gray-500 bg-gray-100 px-2 py-1 rounded-full">
                     {meals.length}食
                   </span>
                 </h3>
                 <Link href="/meals/new">
                   <Button variant="outline" size="sm" className="hidden lg:flex gap-2">
                     <Icons.Plus className="w-4 h-4" /> 記録する
                   </Button>
                 </Link>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {loading ? (
                  [...Array(2)].map((_, i) => (
                    <div key={i} className="bg-white h-32 rounded-2xl animate-pulse shadow-sm" />
                  ))
                ) : meals.length === 0 ? (
                  <div className="col-span-full bg-white border-2 border-dashed border-gray-200 rounded-3xl p-12 text-center text-gray-400">
                    <p className="mb-4">まだ記録がありません</p>
                    <Link href="/meals/new">
                      <Button className="bg-accent hover:bg-accent-dark text-white rounded-full px-8">
                        最初の食事を記録
                      </Button>
                    </Link>
                  </div>
                ) : (
                  meals.map((meal, i) => (
                    <Link key={meal.id} href={`/meals/${meal.id}`} className="block h-full">
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: i * 0.05 }}
                        className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 hover:shadow-md transition-all group h-full flex flex-col"
                      >
                        <div className="flex gap-4 items-start">
                          <div className="relative w-24 h-24 rounded-xl overflow-hidden bg-gray-100 shrink-0">
                            {meal.photoUrl ? (
                              <Image src={meal.photoUrl} fill alt={meal.mealType} className="object-cover group-hover:scale-105 transition-transform duration-500" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-3xl text-gray-300">🍽️</div>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex justify-between items-start mb-2">
                              <span className="text-xs font-bold text-accent uppercase tracking-wider bg-orange-50 px-2 py-0.5 rounded-full">
                                {meal.mealType}
                              </span>
                              <span className="text-xs text-gray-400 font-mono">
                                {new Date(meal.eatenAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                              </span>
                            </div>
                            
                            <div className="space-y-1">
                               {meal.nutrition?.energyKcal ? (
                                 <p className="font-bold text-gray-900 text-lg">
                                   {Math.round(meal.nutrition.energyKcal)} <span className="text-xs font-normal text-gray-500">kcal</span>
                                 </p>
                               ) : (
                                 <p className="text-sm text-gray-400 animate-pulse">解析中...</p>
                               )}
                            </div>

                            {meal.nutrition?.vegScore && (
                              <div className="mt-2 flex items-center gap-1">
                                 <div className="flex gap-0.5">
                                   {[...Array(5)].map((_, idx) => (
                                     <div key={idx} className={`w-1.5 h-1.5 rounded-full ${idx < meal.nutrition!.vegScore! ? 'bg-green-500' : 'bg-gray-200'}`} />
                                   ))}
                                 </div>
                                 <span className="text-[10px] text-gray-500 ml-1">野菜スコア</span>
                              </div>
                            )}
                          </div>
                          <Icons.ChevronRight className="w-5 h-5 text-gray-300 group-hover:text-accent transition-colors" />
                        </div>
                        
                        {/* メモがあれば表示 */}
                        {meal.memo && (
                          <div className="mt-3 pt-3 border-t border-gray-50">
                            <p className="text-xs text-gray-500 line-clamp-1">{meal.memo}</p>
                          </div>
                        )}
                      </motion.div>
                    </Link>
                  ))
                )}
                
                {/* 追加ボタン（モバイルではFABがあるので非表示でもいいが、デスクトップでは有用） */}
                <Link href="/meals/new" className="hidden lg:block">
                  <div className="h-full min-h-[140px] bg-gray-50 border-2 border-dashed border-gray-200 rounded-2xl flex flex-col items-center justify-center gap-2 text-gray-400 hover:bg-gray-100 hover:border-gray-300 hover:text-gray-600 transition-all cursor-pointer">
                     <div className="w-12 h-12 rounded-full bg-white shadow-sm flex items-center justify-center text-2xl mb-1">+</div>
                     <span className="font-bold text-sm">食事を追加</span>
                  </div>
                </Link>
              </div>
            </div>
          </div>

          {/* 右カラム: Daily Balance (Dashboard Widget) */}
          <div className="lg:col-span-4 order-1 lg:order-2">
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="sticky top-24"
            >
              <div 
                onClick={() => setShowSummary(true)}
                className="bg-white rounded-3xl p-6 lg:p-8 shadow-xl shadow-gray-200/50 relative overflow-hidden cursor-pointer group hover:shadow-2xl transition-all duration-300"
              >
                <div className="absolute top-0 right-0 w-32 h-32 bg-orange-50 rounded-bl-[100px] -z-0 group-hover:scale-110 transition-transform duration-500" />
                
                <div className="flex justify-between items-center mb-8 relative z-10">
                  <h2 className="font-bold text-gray-800 text-lg">今日のバランス</h2>
                  <span className="text-xs font-bold bg-gray-900 text-white px-3 py-1 rounded-full group-hover:bg-accent transition-colors">
                    詳細 &rarr;
                  </span>
                </div>

                <div className="flex flex-col items-center justify-center mb-8 relative z-10">
                  {/* 円形プログレス */}
                  <div className="relative w-40 h-40 lg:w-48 lg:h-48">
                    <svg className="w-full h-full transform -rotate-90">
                      <circle cx="50%" cy="50%" r="45%" stroke="#f3f4f6" strokeWidth="8%" fill="none" />
                      <motion.circle 
                        cx="50%" cy="50%" r="45%" 
                        stroke="var(--color-accent)" 
                        strokeWidth="8%" 
                        fill="none" 
                        strokeDasharray="283" // 2 * PI * 45
                        strokeDashoffset={283 - (283 * energyPercentage / 100)} 
                        strokeLinecap="round"
                        initial={{ strokeDashoffset: 283 }}
                        animate={{ strokeDashoffset: 283 - (283 * energyPercentage / 100) }}
                        transition={{ duration: 1.5, ease: "easeOut" }}
                      />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <p className="text-sm text-gray-400 mb-1">摂取エネルギー</p>
                      <div className="flex items-baseline gap-1">
                        <span className="text-4xl lg:text-5xl font-black text-gray-900 tracking-tighter">
                          {Math.round(dailySummary.energyKcal)}
                        </span>
                        <span className="text-sm font-bold text-gray-500">kcal</span>
                      </div>
                      <div className="w-12 h-1 bg-gray-100 rounded-full mt-2 overflow-hidden">
                         <div className="h-full bg-accent" style={{ width: `${Math.min(100, (dailySummary.energyKcal / dailySummary.targetEnergy) * 100)}%` }} />
                      </div>
                      <p className="text-xs text-gray-400 mt-1">目標 {dailySummary.targetEnergy}</p>
                    </div>
                  </div>
                </div>

                {/* PFCバランス */}
                <div className="space-y-4 relative z-10">
                  <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4">PFC Balance</h3>
                  {[
                    { label: 'タンパク質 (P)', val: proteinPercentage, color: 'bg-red-400', current: dailySummary.proteinG, target: dailySummary.targetProtein },
                    { label: '脂質 (F)', val: fatPercentage, color: 'bg-yellow-400', current: dailySummary.fatG, target: dailySummary.targetFat },
                    { label: '炭水化物 (C)', val: carbsPercentage, color: 'bg-green-400', current: dailySummary.carbsG, target: dailySummary.targetCarbs },
                  ].map((nut, i) => (
                    <div key={i}>
                      <div className="flex justify-between text-xs mb-1.5">
                        <span className="font-bold text-gray-600">{nut.label}</span>
                        <div className="text-gray-900 font-mono">
                          <span className="font-bold">{Math.round(nut.current)}</span>
                          <span className="text-gray-400">/{nut.target}g</span>
                        </div>
                      </div>
                      <div className="h-2.5 w-full bg-gray-100 rounded-full overflow-hidden">
                        <motion.div 
                          className={`h-full ${nut.color} rounded-full`} 
                          initial={{ width: 0 }}
                          animate={{ width: `${nut.val}%` }}
                          transition={{ duration: 1, delay: 0.2 + (i * 0.1) }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              
              {/* 一言アドバイス */}
              <div className="mt-4 bg-white/60 backdrop-blur border border-white/40 p-4 rounded-2xl flex gap-3 items-start">
                <span className="text-2xl">💡</span>
                <p className="text-sm text-gray-700 leading-relaxed font-medium">
                  {meals.length === 0 
                    ? "まずは朝食か昼食を記録して、今日のスタートを切りましょう！" 
                    : "良い記録が続いています。水分補給も忘れずに！"}
                </p>
              </div>
            </motion.div>
          </div>
        </div>
      </div>

      {/* 詳細サマリー（ボトムシート/モーダル） */}
      <AnimatePresence>
        {showSummary && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSummary(false)}
              className="fixed inset-0 bg-black/60 z-[60] backdrop-blur-sm"
            />
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="fixed bottom-0 left-0 right-0 lg:left-auto lg:right-12 lg:bottom-12 lg:w-[480px] lg:rounded-[40px] bg-white rounded-t-[40px] z-[61] max-h-[90vh] overflow-y-auto shadow-2xl"
            >
               <div className="p-8 pb-12">
                 <div className="w-12 h-1 bg-gray-200 rounded-full mx-auto mb-8 lg:hidden" />
                 
                 <div className="flex justify-between items-center mb-8">
                   <h2 className="text-2xl font-bold text-gray-900">栄養レポート</h2>
                   <button onClick={() => setShowSummary(false)} className="p-2 bg-gray-100 rounded-full hover:bg-gray-200 transition-colors">
                     <Icons.Close className="w-5 h-5 text-gray-600" />
                   </button>
                 </div>
                 
                 {/* 詳細ステータス */}
                 <div className="space-y-4 mb-8">
                   <h3 className="text-sm font-bold text-gray-500 uppercase tracking-widest mb-2">本日の摂取量</h3>
                   {[
                     { label: "エネルギー", val: `${Math.round(dailySummary.energyKcal)} kcal`, status: `${energyPercentage}%`, color: "text-orange-500", bg: "bg-orange-50" },
                     { label: "タンパク質", val: `${Math.round(dailySummary.proteinG)} g`, status: `${proteinPercentage}%`, color: "text-red-500", bg: "bg-red-50" },
                     { label: "脂質", val: `${Math.round(dailySummary.fatG)} g`, status: `${fatPercentage}%`, color: "text-yellow-500", bg: "bg-yellow-50" },
                     { label: "炭水化物", val: `${Math.round(dailySummary.carbsG)} g`, status: `${carbsPercentage}%`, color: "text-green-500", bg: "bg-green-50" },
                   ].map((item, i) => (
                     <div key={i} className="flex justify-between items-center p-4 bg-gray-50 rounded-2xl hover:bg-gray-100 transition-colors">
                       <span className="font-bold text-gray-700">{item.label}</span>
                       <div className="flex items-center gap-3">
                          <span className="font-bold text-gray-900">{item.val}</span>
                          <span className={`text-xs font-bold px-3 py-1.5 rounded-full ${item.bg} ${item.color}`}>
                            {item.status}
                          </span>
                       </div>
                     </div>
                   ))}
                 </div>
                 
                 <div className="bg-gray-50 p-6 rounded-2xl mb-8">
                   <h3 className="font-bold text-gray-900 mb-3 flex items-center gap-2">
                     <span>🌱</span> 野菜摂取レベル
                   </h3>
                   <div className="flex items-center gap-2 mb-2">
                     <div className="flex-1 h-3 bg-gray-200 rounded-full overflow-hidden">
                       <div className="h-full bg-green-500 rounded-full" style={{ width: '40%' }}></div>
                     </div>
                     <span className="font-bold text-green-600">Lv.2</span>
                   </div>
                   <p className="text-xs text-gray-500">目標まであとサラダ1皿分です！</p>
                 </div>

                 <Button onClick={() => setShowSummary(false)} className="w-full py-6 rounded-full bg-foreground text-white font-bold hover:bg-black transition-colors shadow-lg hover:shadow-xl">
                   レポートを閉じる
                 </Button>
               </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
