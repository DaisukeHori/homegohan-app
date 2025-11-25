"use client";

import { useState } from "react";
import { AnimatePresence } from "framer-motion";
import { DayCard } from "./DayCard";
import { Button } from "@/components/ui/button";

interface PlanningDeckProps {
  days: any[];
  onComplete: (updatedDays: any[]) => void;
  onUpdateMeal: (dayIndex: number, mealIndex: number, action: 'skip' | 'regen' | 'image') => void;
}

export const PlanningDeck = ({ days, onComplete, onUpdateMeal }: PlanningDeckProps) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [localDays, setLocalDays] = useState(days);

  const handleSwipeRight = () => {
    if (currentIndex < localDays.length - 1) {
      setCurrentIndex(prev => prev + 1);
    } else {
      onComplete(localDays);
    }
  };

  const handleSwipeLeft = () => {
    // Currently just opens detail view inside DayCard, so no index change here
  };

  const handleRegenerateDay = () => {
    alert("この機能はバックエンド実装待ちです（日単位の再生成）");
  };

  const handleUpdateLocalMeal = (mealIndex: number, action: 'skip' | 'regen' | 'image') => {
    // 親コンポーネントに通知してAPI呼び出しなどを行う
    onUpdateMeal(currentIndex, mealIndex, action);
    
    // ローカル状態も更新（特にスキップなど即時反映が必要なもの）
    if (action === 'skip') {
      const newDays = [...localDays];
      const meal = newDays[currentIndex].meals[mealIndex];
      meal.isSkipped = !meal.isSkipped;
      setLocalDays(newDays);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-gray-50/95 backdrop-blur-md flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md mb-6 text-center relative z-10">
        <h1 className="text-xl font-bold text-gray-900 tracking-tight">今週の献立プランニング</h1>
        <p className="text-gray-500 text-xs mt-1">AIが提案したメニューを確認してください</p>
        
        {/* Progress Bar */}
        <div className="flex gap-1.5 justify-center mt-6 px-8">
          {localDays.map((_, i) => (
            <div 
              key={i} 
              className={`h-1 rounded-full transition-all duration-300 ${
                i === currentIndex 
                  ? 'w-6 bg-gray-900' 
                  : i < currentIndex 
                    ? 'w-2 bg-orange-400' 
                    : 'w-2 bg-gray-200'
              }`} 
            />
          ))}
        </div>
      </div>

      <div className="relative w-full max-w-md h-[600px] perspective-1000">
        <AnimatePresence mode="popLayout">
          {localDays.map((day, index) => {
            // Only render current and next few cards for performance
            if (index < currentIndex || index > currentIndex + 2) return null;
            
            return (
              <DayCard
                key={day.date}
                day={day}
                index={index - currentIndex} // Pass relative index (0 = current)
                total={localDays.length}
                onSwipeRight={handleSwipeRight}
                onSwipeLeft={handleSwipeLeft}
                onRegenerate={handleRegenerateDay}
                onUpdateMeal={handleUpdateLocalMeal}
              />
            );
          })}
        </AnimatePresence>
      </div>

      <div className="mt-6 opacity-0">
         {/* Spacer for layout balance */}
         Footer Placeholder
      </div>
    </div>
  );
};

