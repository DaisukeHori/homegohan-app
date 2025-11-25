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
    <div className="fixed inset-0 z-50 bg-gray-100 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">Weekly Planning</h1>
        <p className="text-gray-500 text-sm">1週間をデザインしましょう。</p>
        <div className="flex gap-1 justify-center mt-4">
          {localDays.map((_, i) => (
            <div key={i} className={`h-1 rounded-full transition-all ${i === currentIndex ? 'w-8 bg-black' : i < currentIndex ? 'w-2 bg-green-500' : 'w-2 bg-gray-300'}`} />
          ))}
        </div>
      </div>

      <div className="relative w-full max-w-md h-[500px]">
        <AnimatePresence>
          {localDays.map((day, index) => {
            if (index < currentIndex) return null;
            return (
              <DayCard
                key={day.date} // unique key is important
                day={day}
                index={index}
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

      <div className="mt-8 text-center text-xs text-gray-400 font-bold">
        <span className="mr-4">👈 Edit / Adjust</span>
        <span>Keep / Next 👉</span>
      </div>
    </div>
  );
};

