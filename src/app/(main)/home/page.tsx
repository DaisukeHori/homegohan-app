"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { useHomeData } from "@/hooks/useHomeData";

export default function HomePage() {
  const {
    user,
    meals,
    loading,
    dailySummary,
    announcement,
    activityLevel,
    suggestion,
    updateActivityLevel,
    setAnnouncement,
    setSuggestion
  } = useHomeData();

  const [showSummary, setShowSummary] = useState(false);

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 11) return "Good Morning";
    if (hour < 17) return "Good Afternoon";
    return "Good Evening";
  };

  const energyPercentage = Math.min(100, Math.round((dailySummary.energyKcal / dailySummary.targetEnergy) * 100));
  const proteinPercentage = Math.min(100, Math.round((dailySummary.proteinG / dailySummary.targetProtein) * 100));
  const fatPercentage = Math.min(100, Math.round((dailySummary.fatG / dailySummary.targetFat) * 100));
  const carbsPercentage = Math.min(100, Math.round((dailySummary.carbsG / dailySummary.targetCarbs) * 100));

  return (
    <div className="min-h-screen bg-gray-50 pb-24 relative overflow-hidden">
      
      {/* 背景装飾 */}
      <div className="absolute top-0 left-0 w-full h-64 bg-foreground rounded-b-[40px] z-0" />
      
      <div className="relative z-10 px-6 pt-12 max-w-lg mx-auto">
        
        {/* ヘッダー */}
        <div className="flex justify-between items-start mb-8 text-white">
          <div>
            <p className="text-sm font-medium opacity-70">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
            <h1 className="text-3xl font-bold">{getGreeting()},<br/>{user?.email?.split('@')[0] || 'Guest'}</h1>
          </div>
          <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur border border-white/30 flex items-center justify-center font-bold">
            {user?.email?.[0].toUpperCase() || 'G'}
          </div>
        </div>

        {/* お知らせ（あれば表示） */}
        <AnimatePresence>
          {announcement && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="mb-6"
            >
              <div className="bg-white/90 backdrop-blur-sm p-4 rounded-2xl shadow-sm border border-white/50 flex items-start gap-3">
                <span className="text-xl">📢</span>
                <div>
                  <p className="text-sm font-bold text-gray-800">{announcement.title}</p>
                  <p className="text-xs text-gray-600 mt-1 line-clamp-2">{announcement.content}</p>
                </div>
                <button 
                  onClick={() => setAnnouncement(null)}
                  className="ml-auto text-gray-400 hover:text-gray-600"
                >
                  ✕
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Phase 3: Dynamic Condition Input */}
        <div className="mb-6 overflow-x-auto pb-2 no-scrollbar flex gap-3">
          {[
             { id: 'rest', label: 'Rest Day', icon: '🛋️', color: 'bg-blue-100 text-blue-600' },
             { id: 'normal', label: 'Normal', icon: '🚶', color: 'bg-gray-100 text-gray-600' },
             { id: 'active', label: 'Active', icon: '🔥', color: 'bg-orange-100 text-orange-600' },
             { id: 'stressed', label: 'Stressed', icon: '🤯', color: 'bg-purple-100 text-purple-600' }
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => updateActivityLevel(item.id)}
              className={`flex-shrink-0 px-4 py-3 rounded-2xl flex items-center gap-2 transition-all ${
                activityLevel === item.id 
                  ? 'ring-2 ring-offset-2 ring-accent bg-white shadow-md scale-105' 
                  : 'bg-white/10 backdrop-blur-md border border-white/20 text-white hover:bg-white/20'
              }`}
            >
              <span className="text-xl">{item.icon}</span>
              <span className={`text-sm font-bold ${activityLevel === item.id ? 'text-gray-900' : 'text-white'}`}>
                {item.label}
              </span>
            </button>
          ))}
        </div>

        {/* Suggestion Toast */}
        <AnimatePresence>
          {suggestion && (
             <motion.div
               initial={{ opacity: 0, y: -10 }}
               animate={{ opacity: 1, y: 0 }}
               exit={{ opacity: 0, y: -10 }}
               className="bg-foreground text-white p-4 rounded-2xl shadow-lg mb-6 flex items-start gap-3"
             >
               <span className="text-xl">🤖</span>
               <div className="flex-1">
                 <p className="text-sm font-bold text-accent mb-1">AI Adjustment</p>
                 <p className="text-sm leading-relaxed">{suggestion}</p>
               </div>
               <button onClick={() => setSuggestion(null)} className="text-gray-400">✕</button>
             </motion.div>
          )}
        </AnimatePresence>

        {/* メインスコアカード */}
        <motion.div 
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          onClick={() => setShowSummary(true)}
          className="bg-white rounded-3xl p-6 shadow-xl mb-8 relative overflow-hidden cursor-pointer active:scale-[0.98] transition-transform"
        >
          <div className="flex justify-between items-center mb-6">
            <h2 className="font-bold text-gray-800">Daily Balance</h2>
            <button className="text-accent text-sm font-bold">Details &rarr;</button>
          </div>

          <div className="flex gap-8 items-center justify-center mb-6">
            {/* 円形プログレス */}
            <div className="relative w-32 h-32">
              <svg className="w-full h-full transform -rotate-90">
                <circle cx="64" cy="64" r="56" stroke="#f3f4f6" strokeWidth="12" fill="none" />
                <motion.circle 
                  cx="64" cy="64" r="56" 
                  stroke="var(--color-accent)" 
                  strokeWidth="12" 
                  fill="none" 
                  strokeDasharray="351" 
                  strokeDashoffset={351 - (351 * energyPercentage / 100)} 
                  strokeLinecap="round"
                  initial={{ strokeDashoffset: 351 }}
                  animate={{ strokeDashoffset: 351 - (351 * energyPercentage / 100) }}
                  transition={{ duration: 1 }}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-3xl font-bold text-gray-900">{Math.round(dailySummary.energyKcal)}</span>
                <span className="text-xs text-gray-400">/ {dailySummary.targetEnergy} kcal</span>
              </div>
            </div>

            {/* PFCバランス */}
            <div className="space-y-4 flex-1">
              {[
                { label: 'Protein', val: `${proteinPercentage}%`, color: 'bg-red-400' },
                { label: 'Fat', val: `${fatPercentage}%`, color: 'bg-yellow-400' },
                { label: 'Carbs', val: `${carbsPercentage}%`, color: 'bg-green-400' },
              ].map((nut, i) => (
                <div key={i}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-bold text-gray-500">{nut.label}</span>
                    <span className="font-bold text-gray-900">{nut.val}</span>
                  </div>
                  <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
                    <motion.div 
                      className={`h-full ${nut.color} rounded-full`} 
                      initial={{ width: 0 }}
                      animate={{ width: nut.val }}
                      transition={{ duration: 1, delay: 0.2 }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
          
          <div className="bg-blue-50 p-4 rounded-xl flex gap-3 items-start">
            <span className="text-2xl">💡</span>
            <p className="text-sm text-blue-800 leading-relaxed font-medium">
              {meals.length === 0 ? "まずは最初の食事を記録してみましょう！" : "いいペースです！夕食で少しタンパク質を多めに摂ると、目標達成できそうですよ。"}
            </p>
          </div>
        </motion.div>

        {/* 食事タイムライン */}
        <div className="space-y-4 mb-24">
          <h3 className="font-bold text-gray-900 text-lg">Today's Meals</h3>
          
          {loading ? (
            <div className="text-center text-gray-400 py-8">Loading...</div>
          ) : meals.length === 0 ? (
            <div className="text-center text-gray-400 py-8 border-2 border-dashed border-gray-100 rounded-2xl">
              <p>No meals recorded yet.</p>
            </div>
          ) : (
            meals.map((meal, i) => (
              <Link key={meal.id} href={`/meals/${meal.id}`}>
                <motion.div 
                  initial={{ x: -20, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  transition={{ delay: i * 0.1 + 0.3 }}
                  className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex gap-4 items-center group cursor-pointer hover:shadow-md transition-shadow mb-4"
                >
                  <div className="relative w-20 h-20 rounded-xl overflow-hidden bg-gray-100 shrink-0">
                    {meal.photoUrl ? (
                      <Image src={meal.photoUrl} fill alt={meal.mealType} className="object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-2xl">🍽️</div>
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="flex justify-between items-start mb-1">
                       <div>
                         <p className="text-xs text-gray-400 font-bold uppercase">{meal.mealType}</p>
                         <p className="font-bold text-gray-900">{new Date(meal.eatenAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</p>
                       </div>
                       {meal.nutrition?.vegScore && (
                         <div className="bg-green-100 text-green-700 px-2 py-1 rounded-lg text-xs font-bold">
                           Veg Score {meal.nutrition.vegScore}
                         </div>
                       )}
                    </div>
                    <div className="flex gap-4 text-xs text-gray-500 mt-2">
                       {meal.nutrition?.energyKcal ? (
                         <span>🔥 {meal.nutrition.energyKcal} kcal</span>
                       ) : (
                         <span>解析中...</span>
                       )}
                    </div>
                  </div>
                  <div className="text-gray-300">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                  </div>
                </motion.div>
              </Link>
            ))
          )}
          
          <Link href="/meals/new" className="block">
            <div className="bg-gray-50 border-2 border-dashed border-gray-200 p-4 rounded-2xl flex items-center justify-center gap-2 text-gray-400 hover:bg-gray-100 hover:border-gray-300 transition-colors h-24">
               <span className="text-2xl">＋</span>
               <span className="font-bold">食事を記録する</span>
            </div>
          </Link>
        </div>
      </div>

      {/* 詳細サマリー（ボトムシート） */}
      <AnimatePresence>
        {showSummary && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSummary(false)}
              className="fixed inset-0 bg-black/50 z-50 backdrop-blur-sm"
            />
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="fixed bottom-0 left-0 right-0 bg-white rounded-t-[40px] z-50 max-h-[90vh] overflow-y-auto"
            >
               <div className="p-8 pb-12">
                 <div className="w-12 h-1 bg-gray-200 rounded-full mx-auto mb-8" />
                 
                 <h2 className="text-2xl font-bold text-gray-900 mb-6">Nutrition Report</h2>
                 
                 {/* 詳細ステータス */}
                 <div className="space-y-4 mb-8">
                   <h3 className="text-sm font-bold text-gray-500 uppercase tracking-widest mb-2">Daily Intake</h3>
                   {[
                     { label: "Energy", val: `${Math.round(dailySummary.energyKcal)} kcal`, status: `${energyPercentage}%`, color: "text-orange-500" },
                     { label: "Protein", val: `${Math.round(dailySummary.proteinG)} g`, status: `${proteinPercentage}%`, color: "text-red-500" },
                     { label: "Fat", val: `${Math.round(dailySummary.fatG)} g`, status: `${fatPercentage}%`, color: "text-yellow-500" },
                     { label: "Carbs", val: `${Math.round(dailySummary.carbsG)} g`, status: `${carbsPercentage}%`, color: "text-green-500" },
                   ].map((item, i) => (
                     <div key={i} className="flex justify-between items-center p-4 bg-gray-50 rounded-2xl">
                       <span className="font-bold text-gray-700">{item.label}</span>
                       <div className="flex items-center gap-3">
                          <span className="font-bold text-gray-900">{item.val}</span>
                          <span className={`text-xs font-bold px-2 py-1 bg-white rounded-lg shadow-sm ${item.color}`}>{item.status}</span>
                       </div>
                     </div>
                   ))}
                 </div>
                 
                 <Button onClick={() => setShowSummary(false)} className="w-full py-6 rounded-full bg-foreground text-white font-bold hover:bg-black">
                   Close Report
                 </Button>
               </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
