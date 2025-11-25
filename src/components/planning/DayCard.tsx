"use client";

import { useState } from "react";
import { motion, AnimatePresence, useMotionValue, useTransform } from "framer-motion";
import { Icons } from "@/components/icons";
import { Button } from "@/components/ui/button";

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
  
  // Swipe overlays
  const overlayOpacityRight = useTransform(x, [0, 150], [0, 0.7]); // Keep (Green)
  const overlayOpacityLeft = useTransform(x, [0, -150], [0, 0.7]); // Edit (Orange)

  const handleDragEnd = (event: any, info: any) => {
    x.set(0);
    if (info.offset.x > 100) {
      onSwipeRight();
    } else if (info.offset.x < -100) {
      setIsFlipped(true);
    }
  };

  // メイン画像の取得（昼食または夕食の画像を優先）
  const mainImage = day.meals.find((m: any) => (m.mealType === 'lunch' || m.mealType === 'dinner') && m.imageUrl)?.imageUrl 
    || day.meals.find((m: any) => m.imageUrl)?.imageUrl;

  // 裏面（詳細編集モード）
  if (isFlipped) {
    return (
      <motion.div
        key={`edit-${day.date}`}
        className="absolute top-0 left-0 w-full h-[600px] bg-white rounded-[32px] shadow-2xl border border-gray-100 overflow-hidden flex flex-col z-50"
        initial={{ rotateY: -90, opacity: 0 }}
        animate={{ rotateY: 0, opacity: 1 }}
        exit={{ rotateY: 90, opacity: 0 }}
        transition={{ duration: 0.4 }}
      >
        <div className="p-6 bg-gray-50 border-b border-gray-100 flex justify-between items-center sticky top-0 z-10">
          <div>
            <h3 className="font-bold text-gray-900 text-xl">{day.dayOfWeek}</h3>
            <p className="text-xs text-gray-500">{day.date} の調整</p>
          </div>
          <Button variant="ghost" size="icon" onClick={() => setIsFlipped(false)} className="rounded-full hover:bg-gray-200">
            <Icons.Close className="w-6 h-6" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50/50">
          {day.meals.map((meal: any, i: number) => (
            <div key={i} className={`p-4 rounded-2xl transition-all ${meal.isSkipped ? 'bg-gray-100 border-transparent opacity-60' : 'bg-white border-gray-100 shadow-sm border'}`}>
              <div className="flex justify-between items-center mb-3">
                <span className="text-[10px] font-black uppercase bg-gray-100 text-gray-500 px-2 py-1 rounded tracking-wider">{meal.mealType}</span>
                <div className="flex gap-2">
                  <button onClick={() => onUpdateMeal(i, 'regen')} className="p-2 hover:bg-blue-50 text-blue-500 rounded-full transition-colors" title="別のメニュー">
                    <Icons.Refresh className="w-4 h-4" />
                  </button>
                  <button onClick={() => onUpdateMeal(i, 'image')} className="p-2 hover:bg-purple-50 text-purple-500 rounded-full transition-colors" title="画像生成">
                    📷
                  </button>
                </div>
              </div>
              
              <div className="flex gap-4">
                <div className="w-20 h-20 bg-gray-100 rounded-xl relative overflow-hidden shrink-0 shadow-inner">
                   {meal.imageUrl ? (
                     // eslint-disable-next-line @next/next/no-img-element
                     <img src={meal.imageUrl} alt="meal" className="w-full h-full object-cover" />
                   ) : (
                     <span className="absolute inset-0 flex items-center justify-center text-2xl opacity-50">🍽️</span>
                   )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`font-bold text-base mb-1 truncate ${meal.isSkipped ? 'line-through text-gray-400' : 'text-gray-800'}`}>
                    {meal.dishes[0]?.name}
                  </p>
                  <p className="text-xs text-gray-400 line-clamp-2 leading-relaxed">
                    {meal.dishes.slice(1).map((d:any) => d.name).join(", ") || "副菜なし"}
                  </p>
                </div>
              </div>

              <Button 
                variant="outline" 
                size="sm" 
                className={`w-full mt-4 h-9 text-xs font-bold border-0 ${meal.isSkipped ? 'bg-gray-200 text-gray-500' : 'bg-red-50 text-red-500 hover:bg-red-100'}`}
                onClick={() => onUpdateMeal(i, 'skip')}
              >
                {meal.isSkipped ? "元に戻す" : "スキップする"}
              </Button>
            </div>
          ))}
        </div>

        <div className="p-6 border-t border-gray-100 bg-white">
          <Button onClick={onSwipeRight} className="w-full bg-black hover:bg-gray-800 text-white font-bold py-6 rounded-2xl shadow-xl text-lg transition-all active:scale-95">
            これで決定 (Keep)
          </Button>
        </div>
      </motion.div>
    );
  }

  // 表面（没入型カード）
  return (
    <AnimatePresence>
      {!isFlipped && (
        <motion.div
          key={`front-${day.date}`}
          style={{ x, rotate, opacity, zIndex: 100 - index }} // Fix z-index stacking
          drag="x"
          dragConstraints={{ left: 0, right: 0 }}
          onDragEnd={handleDragEnd}
          className="absolute top-0 left-0 w-full h-[600px] bg-white rounded-[32px] shadow-2xl overflow-hidden flex flex-col cursor-grab active:cursor-grabbing"
          initial={{ scale: 0.95, y: 30 }}
          animate={{ scale: 1, y: index * 10, opacity: 1 }} // Stack effect
          exit={{ scale: 1.1, opacity: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 25 }}
        >
          {/* Overlays */}
          <motion.div style={{ opacity: overlayOpacityRight }} className="absolute inset-0 bg-emerald-500 z-20 flex items-center justify-center pointer-events-none mix-blend-multiply" />
          <motion.div style={{ opacity: overlayOpacityRight }} className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
             <span className="text-white font-black text-5xl tracking-widest border-[6px] border-white px-6 py-3 rounded-2xl transform -rotate-12 drop-shadow-lg">KEEP</span>
          </motion.div>

          <motion.div style={{ opacity: overlayOpacityLeft }} className="absolute inset-0 bg-orange-500 z-20 flex items-center justify-center pointer-events-none mix-blend-multiply" />
          <motion.div style={{ opacity: overlayOpacityLeft }} className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
             <span className="text-white font-black text-5xl tracking-widest border-[6px] border-white px-6 py-3 rounded-2xl transform rotate-12 drop-shadow-lg">EDIT</span>
          </motion.div>

          {/* Main Visual Area - Full Bleed */}
          <div className="absolute inset-0 z-0 bg-gray-900">
            {mainImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img 
                src={mainImage} 
                alt="Main Dish" 
                className="w-full h-full object-cover opacity-90" 
                onError={(e) => {
                  console.error("Image load error:", mainImage);
                  e.currentTarget.style.display = 'none';
                }}
              />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-gray-800 to-gray-900 flex flex-col items-center justify-center text-white/20">
                <span className="text-6xl mb-4">🍽️</span>
              </div>
            )}
            {/* 全体の視認性を高めるためのグラデーションオーバーレイ */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-black/60 pointer-events-none" />
          </div>

          {/* Content Overlay */}
          <div className="relative z-10 h-full flex flex-col justify-between p-6 text-white pointer-events-none">
            
            {/* Header - Floating */}
            <div className="pt-4 drop-shadow-lg">
              <div className="flex justify-between items-start">
                <div>
                  <div className="inline-flex items-center gap-2 bg-white/20 backdrop-blur-md px-3 py-1 rounded-full mb-3 border border-white/10">
                    <span className="text-[10px] font-bold tracking-widest uppercase">DAY {index + 1}</span>
                  </div>
                  <h2 className="text-6xl font-bold tracking-tighter font-serif leading-none">{day.dayOfWeek}</h2>
                  <p className="text-lg font-medium opacity-90 mt-1 ml-1">{day.date}</p>
                </div>
                {day.isCheatDay && (
                  <div className="bg-orange-500 text-white text-[10px] font-black px-3 py-1.5 rounded-full shadow-lg uppercase tracking-widest transform rotate-6 border border-orange-400">
                    CHEAT DAY
                  </div>
                )}
              </div>
            </div>

            {/* Bottom Info - Glass Card */}
            <div className="space-y-4">
              
              {/* Focus Badge */}
              <div className="inline-flex items-center gap-2 bg-black/40 backdrop-blur-md text-white px-4 py-2 rounded-full text-xs font-bold border border-white/10 shadow-lg">
                <span className="text-yellow-400 text-base">💡</span>
                <span>{day.nutritionalAdvice.slice(0, 25)}...</span>
              </div>

              {/* Menu List Card - Glassmorphism */}
              <div className="bg-white/10 backdrop-blur-xl rounded-3xl p-5 border border-white/20 shadow-2xl">
                <div className="space-y-3">
                  {day.meals.map((meal: any, i: number) => (
                    <div key={i} className="flex items-center gap-4">
                      <div className="w-12 text-[10px] font-bold opacity-60 uppercase text-right tracking-wider">{meal.mealType}</div>
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-base text-white leading-tight truncate drop-shadow-md">
                          {meal.dishes[0]?.name}
                        </p>
                        <p className="text-[10px] text-white/60 truncate">
                          {meal.dishes.slice(1).map((d:any) => d.name).join(", ")}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Action Hint */}
              <div className="flex justify-between px-2 pt-2 text-[10px] font-bold tracking-widest opacity-60 uppercase">
                <span className="flex items-center gap-1">← Edit</span>
                <span className="flex items-center gap-1">Keep →</span>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

