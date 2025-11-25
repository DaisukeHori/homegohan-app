"use client";

import { useState } from "react";
import { motion, AnimatePresence, useMotionValue, useTransform } from "framer-motion";
import { Icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import Image from "next/image";

interface DayCardProps {
  day: any; // WeeklyMenuDay
  index: number;
  total: number;
  onSwipeRight: () => void; // Keep
  onSwipeLeft: () => void; // Edit Mode
  onRegenerate: () => void; // Swap Whole Day
  onUpdateMeal: (mealIndex: number, action: 'skip' | 'regen' | 'image') => void;
}

export const DayCard = ({ day, index, total, onSwipeRight, onSwipeLeft, onRegenerate, onUpdateMeal }: DayCardProps) => {
  const [isFlipped, setIsFlipped] = useState(false);
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-200, 200], [-10, 10]);
  const opacity = useTransform(x, [-200, -150, 0, 150, 200], [0, 1, 1, 1, 0]);
  const overlayOpacityRight = useTransform(x, [0, 150], [0, 0.5]); // Green overlay for Keep
  const overlayOpacityLeft = useTransform(x, [0, -150], [0, 0.5]); // Orange overlay for Edit

  const handleDragEnd = (event: any, info: any) => {
    if (info.offset.x > 100) {
      onSwipeRight();
    } else if (info.offset.x < -100) {
      setIsFlipped(true); // Auto flip on left swipe attempt instead of discarding
      // onSwipeLeft(); 
    }
  };

  // 裏面（編集モード）
  if (isFlipped) {
    return (
      <motion.div
        className="absolute top-0 left-0 w-full h-full bg-white rounded-3xl shadow-xl border border-gray-100 overflow-hidden flex flex-col z-50"
        initial={{ rotateY: -90 }}
        animate={{ rotateY: 0 }}
        transition={{ duration: 0.4 }}
      >
        <div className="p-6 bg-gray-50 border-b border-gray-100 flex justify-between items-center">
          <div>
            <h3 className="font-bold text-gray-900 text-lg">{day.dayOfWeek}</h3>
            <p className="text-xs text-gray-500">{day.date} の調整</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setIsFlipped(false)}>
            <Icons.Close className="w-5 h-5" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {day.meals.map((meal: any, i: number) => (
            <div key={i} className={`p-4 rounded-xl border transition-all ${meal.isSkipped ? 'bg-gray-100 border-gray-200 opacity-60' : 'bg-white border-gray-200 shadow-sm'}`}>
              <div className="flex justify-between items-start mb-3">
                <span className="text-xs font-bold uppercase bg-gray-100 px-2 py-1 rounded text-gray-500">{meal.mealType}</span>
                <div className="flex gap-1">
                  <button 
                    onClick={() => onUpdateMeal(i, 'regen')}
                    className="p-2 hover:bg-blue-50 text-blue-500 rounded-full"
                    title="別のメニューを提案"
                  >
                    <Icons.Refresh className="w-4 h-4" />
                  </button>
                  <button 
                    onClick={() => onUpdateMeal(i, 'image')}
                    className="p-2 hover:bg-purple-50 text-purple-500 rounded-full"
                    title="画像を生成"
                  >
                    📷
                  </button>
                </div>
              </div>
              
              <div className="flex gap-3">
                <div className="w-16 h-16 bg-gray-100 rounded-lg relative overflow-hidden shrink-0">
                   {meal.imageUrl ? (
                     <Image src={meal.imageUrl} fill alt="meal" className="object-cover" />
                   ) : (
                     <span className="absolute inset-0 flex items-center justify-center text-2xl">🍽️</span>
                   )}
                </div>
                <div className="flex-1">
                  <p className={`font-bold text-sm mb-1 ${meal.isSkipped ? 'line-through' : ''}`}>
                    {meal.dishes[0]?.name}
                  </p>
                  <p className="text-xs text-gray-400 line-clamp-1">{meal.dishes.slice(1).map((d:any) => d.name).join(", ")}</p>
                </div>
              </div>

              <Button 
                variant="outline" 
                size="sm" 
                className={`w-full mt-3 h-8 text-xs ${meal.isSkipped ? 'text-gray-500' : 'text-red-500 border-red-100 hover:bg-red-50'}`}
                onClick={() => onUpdateMeal(i, 'skip')}
              >
                {meal.isSkipped ? "元に戻す" : "この食事をスキップ (外食など)"}
              </Button>
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-gray-100 bg-white">
          <Button onClick={onSwipeRight} className="w-full bg-black text-white font-bold py-6 rounded-xl shadow-lg">
            これで決定 (Keep)
          </Button>
        </div>
      </motion.div>
    );
  }

  // 表面（カードスタック）
  return (
    <motion.div
      style={{ x, rotate, opacity, zIndex: total - index }}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      onDragEnd={handleDragEnd}
      className="absolute top-0 left-0 w-full h-[500px] bg-white rounded-3xl shadow-2xl border border-gray-100 overflow-hidden flex flex-col cursor-grab active:cursor-grabbing"
      initial={{ scale: 0.95, y: 20 }}
      animate={{ scale: 1, y: 0 }}
      exit={{ x: 500, opacity: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 20 }}
    >
      {/* Overlays for Swipe Feedback */}
      <motion.div style={{ opacity: overlayOpacityRight }} className="absolute inset-0 bg-green-500 z-10 flex items-center justify-center pointer-events-none">
        <span className="text-white font-black text-4xl tracking-widest border-4 border-white px-4 py-2 rounded-xl transform -rotate-12">KEEP</span>
      </motion.div>
      <motion.div style={{ opacity: overlayOpacityLeft }} className="absolute inset-0 bg-orange-500 z-10 flex items-center justify-center pointer-events-none">
        <span className="text-white font-black text-4xl tracking-widest border-4 border-white px-4 py-2 rounded-xl transform rotate-12">EDIT</span>
      </motion.div>

      {/* Card Content */}
      <div className={`h-32 relative p-6 flex flex-col justify-between text-white ${day.isCheatDay ? 'bg-gradient-to-br from-yellow-400 to-orange-500' : 'bg-gradient-to-br from-gray-800 to-black'}`}>
        <div className="flex justify-between items-start">
          <div>
            <span className="text-xs font-bold opacity-70 uppercase tracking-wider">Day {index + 1}</span>
            <h2 className="text-3xl font-bold">{day.dayOfWeek}</h2>
            <p className="opacity-80 text-sm">{day.date}</p>
          </div>
          {day.isCheatDay && <span className="bg-white text-orange-500 text-xs font-bold px-2 py-1 rounded-full">Cheat Day</span>}
        </div>
      </div>

      <div className="flex-1 p-6 space-y-4 relative">
        <div className="absolute top-0 right-0 p-4">
           <div className="bg-accent/10 text-accent px-3 py-1 rounded-full text-xs font-bold">
             Focus: {day.nutritionalAdvice.slice(0, 15)}...
           </div>
        </div>

        {day.meals.map((meal: any, i: number) => (
          <div key={i} className="flex items-center gap-4">
            <div className="w-12 text-xs font-bold text-gray-400 uppercase text-right">{meal.mealType}</div>
            <div className="flex-1 p-3 bg-gray-50 rounded-xl border border-gray-100">
              <p className="font-bold text-gray-800 text-sm">{meal.dishes[0]?.name}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="p-6 bg-gray-50 flex gap-3">
        <Button variant="outline" className="flex-1 border-gray-300 text-gray-500" onClick={onRegenerate}>
          <Icons.Refresh className="w-4 h-4 mr-2" /> 丸ごと変える
        </Button>
        <Button variant="outline" className="flex-1 border-gray-300 text-gray-500" onClick={() => setIsFlipped(true)}>
          詳細調整
        </Button>
      </div>
    </motion.div>
  );
};

