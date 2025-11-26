"use client";

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  ChefHat, Store, UtensilsCrossed, FastForward,
  Sparkles, Zap, X, Send, Plus,
  ShoppingBag, Package, RefreshCw, ChevronDown,
  ChevronLeft, ChevronRight, Check, Calendar,
  Clock, Users, Flame, TrendingUp, Refrigerator,
  Trash2, Edit3, Camera, BookOpen, AlertTriangle,
  CheckCircle, Circle, Minus, ChevronUp, Heart,
  BarChart3, ShoppingCart
} from 'lucide-react';
import type { MealPlan, MealPlanDay, PlannedMeal, PantryItem, ShoppingListItem, Recipe } from '@/types/domain';
import { cn } from '@/lib/utils';

// --- Types & Constants ---

type MealMode = 'cook' | 'quick' | 'buy' | 'out' | 'skip';
type MealType = 'breakfast' | 'lunch' | 'dinner';
type ModalType = 'ai' | 'aiPreview' | 'fridge' | 'shopping' | 'recipe' | 'add' | 'stats' | null;

const MODE_CONFIG = {
  cook: { icon: ChefHat, label: '自炊', color: 'text-green-600', bg: 'bg-green-50' },
  quick: { icon: Zap, label: '時短', color: 'text-blue-600', bg: 'bg-blue-50' },
  buy: { icon: Store, label: '買う', color: 'text-purple-600', bg: 'bg-purple-50' },
  out: { icon: UtensilsCrossed, label: '外食', color: 'text-orange-500', bg: 'bg-orange-50' },
  skip: { icon: FastForward, label: 'なし', color: 'text-gray-400', bg: 'bg-gray-100' },
};

const MEAL_LABELS: Record<MealType, string> = { breakfast: '朝食', lunch: '昼食', dinner: '夕食' };

interface WeeklyMealPlannerProps {
  mealPlan: MealPlan;
  onUpdateMeal: (dayId: string, mealId: string | null, updates: Partial<PlannedMeal>) => void;
  // 将来的にAPIから取得するデータをPropsまたは内部Fetchで扱う
}

export const WeeklyMealPlanner = ({ mealPlan, onUpdateMeal }: WeeklyMealPlannerProps) => {
  const [selectedDayIndex, setSelectedDayIndex] = useState(0); // Default to today logic later
  const [expandedMeal, setExpandedMeal] = useState<MealType>('dinner');
  const [activeModal, setActiveModal] = useState<ModalType>(null);
  
  // Local State for Features not yet in DB fully (Mocking for UI)
  const [fridgeItems, setFridgeItems] = useState<PantryItem[]>([]); 
  const [shoppingList, setShoppingList] = useState<ShoppingListItem[]>(mealPlan.shoppingList || []);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
  const [addMealType, setAddMealKey] = useState<MealType | null>(null);

  // Initialize selected day to today or first day
  useEffect(() => {
    const today = new Date().toISOString().split('T')[0];
    const idx = mealPlan.days?.findIndex(d => d.dayDate === today);
    if (idx !== undefined && idx !== -1) setSelectedDayIndex(idx);
  }, [mealPlan]);

  const currentDay = mealPlan.days?.[selectedDayIndex];
  if (!currentDay) return <div>Loading...</div>;

  // --- Helpers ---

  const getMeal = (day: MealPlanDay, type: MealType) => {
    return day.meals?.find(m => m.mealType === type);
  };

  const getMealStats = () => {
    let cookCount = 0, buyCount = 0, outCount = 0, totalCal = 0;
    mealPlan.days?.forEach(day => {
      day.meals?.forEach(meal => {
        // Mode判定は現状のDBにないため、mealTypeやdescriptionから推測するか、デフォルトcookとする
        // ここでは簡易的に全てcookとしてカウント（後でmodeカラムを追加推奨）
        cookCount++;
        totalCal += meal.caloriesKcal || 0;
      });
    });
    const totalMeals = cookCount + buyCount + outCount;
    return {
      cookRate: totalMeals > 0 ? Math.round((cookCount / totalMeals) * 100) : 0,
      avgCal: mealPlan.days?.length ? Math.round(totalCal / mealPlan.days.length) : 0,
      cookCount, buyCount, outCount
    };
  };

  const stats = getMealStats();

  // --- Render Components ---

  const EmptySlot = ({ type }: { type: MealType }) => (
    <button
      onClick={() => { setAddMealKey(type); setActiveModal('add'); }}
      className="w-full flex items-center justify-center gap-2 bg-white border-2 border-dashed border-gray-200 rounded-2xl p-5 mb-2 hover:bg-gray-50 transition-colors"
    >
      <Plus size={18} className="text-gray-400" />
      <span className="text-sm text-gray-400">{MEAL_LABELS[type]}を追加</span>
    </button>
  );

  const MealCard = ({ type, meal }: { type: MealType, meal: PlannedMeal }) => {
    const isExpanded = expandedMeal === type;
    const mode = MODE_CONFIG['cook']; // Default mode
    const ModeIcon = mode.icon;

    if (!isExpanded) {
      // Collapsed View
      return (
        <div className="flex items-center gap-2 mb-2">
          {/* Check Button */}
          <button
            onClick={() => onUpdateMeal(currentDay.id, meal.id, { isCompleted: !meal.isCompleted })}
            className={cn(
              "w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 border-2 transition-colors",
              meal.isCompleted 
                ? "bg-green-500 border-green-500" 
                : "bg-transparent border-gray-200 hover:border-green-400"
            )}
          >
            {meal.isCompleted && <Check size={14} className="text-white" />}
          </button>

          <button
            onClick={() => setExpandedMeal(type)}
            className={cn(
              "flex-1 flex items-center justify-between bg-white rounded-2xl p-3 text-left transition-all",
              meal.isCompleted ? "opacity-60" : "shadow-sm"
            )}
          >
            <div className="flex items-center gap-3">
              <span className="text-sm font-bold text-gray-800 w-7">{MEAL_LABELS[type].slice(0, 1)}</span>
              <div className={cn("flex items-center gap-1 px-2 py-1 rounded-md", mode.bg)}>
                <ModeIcon size={12} className={mode.color} />
              </div>
              <span className={cn("text-sm text-gray-600 truncate max-w-[120px]", meal.isCompleted && "line-through")}>
                {meal.dishName}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">{meal.caloriesKcal || '-'}kcal</span>
              <ChevronDown size={14} className="text-gray-400" />
            </div>
          </button>
        </div>
      );
    }

    // Expanded View
    return (
      <div className="bg-white rounded-3xl p-4 mb-2 shadow-sm flex flex-col">
        <div className="flex justify-between items-center mb-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => onUpdateMeal(currentDay.id, meal.id, { isCompleted: !meal.isCompleted })}
              className={cn(
                "w-7 h-7 rounded-full flex items-center justify-center border-2 transition-colors",
                meal.isCompleted ? "bg-green-500 border-green-500" : "bg-transparent border-gray-200"
              )}
            >
              {meal.isCompleted && <Check size={14} className="text-white" />}
            </button>
            <span className="text-base font-bold text-gray-900">{MEAL_LABELS[type]}</span>
            <div className={cn("flex items-center gap-1.5 px-2.5 py-1 rounded-lg", mode.bg)}>
              <ModeIcon size={14} className={mode.color} />
              <span className={cn("text-[10px] font-bold", mode.color)}>{mode.label}</span>
            </div>
          </div>
          <span className="text-sm text-gray-400">{meal.caloriesKcal || '-'} kcal</span>
        </div>

        <div className="flex gap-4">
          {/* Image */}
          <div className="w-20 h-20 bg-gray-100 rounded-xl overflow-hidden shrink-0 relative">
            {meal.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={meal.imageUrl} alt={meal.dishName} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-300">
                <UtensilsCrossed size={20} />
              </div>
            )}
          </div>

          {/* Details */}
          <div className="flex-1 min-w-0">
            <p className="text-base font-bold text-gray-800 mb-1">{meal.dishName}</p>
            <p className="text-xs text-gray-500 leading-relaxed line-clamp-2">{meal.description}</p>
            
            <div className="flex gap-2 mt-2">
              {/* Tags / PFC Mock */}
              <span className="text-[10px] bg-gray-50 text-gray-500 px-2 py-0.5 rounded">P: {meal.proteinG || '-'}g</span>
              <span className="text-[10px] bg-gray-50 text-gray-500 px-2 py-0.5 rounded">F: {meal.fatG || '-'}g</span>
              <span className="text-[10px] bg-gray-50 text-gray-500 px-2 py-0.5 rounded">C: {meal.carbsG || '-'}g</span>
            </div>
          </div>
        </div>

        <div className="mt-4 pt-3 border-t border-gray-100 flex justify-end">
          <button className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 rounded-lg text-xs text-gray-500 hover:bg-gray-100 transition-colors">
            <RefreshCw size={12} />
            変更する
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col min-h-full bg-[#F7F6F3] font-sans pb-20">
      
      {/* --- Header --- */}
      <div className="bg-white pt-4 px-4 pb-2 sticky top-0 z-10 shadow-sm">
        <div className="flex justify-between items-center mb-4">
          <div className="flex items-center gap-2">
            <Calendar size={20} className="text-orange-500" />
            <div>
              <h1 className="text-lg font-bold text-gray-900 leading-none">{mealPlan.title}</h1>
              <p className="text-[10px] text-gray-400 mt-0.5">
                {new Date(mealPlan.startDate).toLocaleDateString()} - {new Date(mealPlan.endDate).toLocaleDateString()}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setActiveModal('stats')} className="w-9 h-9 rounded-full bg-gray-50 flex items-center justify-center hover:bg-gray-100">
              <BarChart3 size={18} className="text-gray-500" />
            </button>
            <button onClick={() => setActiveModal('fridge')} className="w-9 h-9 rounded-full bg-gray-50 flex items-center justify-center hover:bg-gray-100 relative">
              <Refrigerator size={18} className="text-gray-500" />
              {/* Badge Mock */}
              <div className="absolute -top-1 -right-1 w-4 h-4 bg-orange-500 rounded-full flex items-center justify-center text-[9px] font-bold text-white">3</div>
            </button>
            <button onClick={() => setActiveModal('shopping')} className="w-9 h-9 rounded-full bg-gray-50 flex items-center justify-center hover:bg-gray-100 relative">
              <ShoppingCart size={18} className="text-gray-500" />
              <div className="absolute -top-1 -right-1 w-4 h-4 bg-blue-500 rounded-full flex items-center justify-center text-[9px] font-bold text-white">
                {shoppingList.filter(i => !i.isChecked).length}
              </div>
            </button>
          </div>
        </div>

        {/* Day Tabs */}
        <div className="flex justify-between overflow-x-auto no-scrollbar pb-2">
          {mealPlan.days?.map((day, idx) => {
            const date = new Date(day.dayDate);
            const isSelected = idx === selectedDayIndex;
            return (
              <button
                key={day.id}
                onClick={() => setSelectedDayIndex(idx)}
                className={cn(
                  "flex flex-col items-center justify-center min-w-[44px] py-2 rounded-xl transition-all relative",
                  isSelected ? "bg-orange-500 text-white shadow-md" : "text-gray-400 hover:bg-gray-50"
                )}
              >
                <span className="text-[9px] opacity-80 mb-0.5">{date.getDate()}</span>
                <span className="text-sm font-bold">{day.dayOfWeek?.slice(0, 3)}</span>
                {/* Indicator dot for today or status */}
              </button>
            );
          })}
        </div>
      </div>

      {/* --- Main Content --- */}
      <div className="flex-1 p-4 overflow-y-auto">
        {/* AI Banner */}
        <button
          onClick={() => setActiveModal('ai')}
          className="w-full mb-4 p-3 bg-gradient-to-r from-orange-400 to-pink-500 rounded-2xl flex items-center justify-between text-white shadow-lg"
        >
          <div className="flex items-center gap-2">
            <Sparkles size={18} />
            <span className="text-xs font-bold">AIアシスタントに相談</span>
          </div>
          <ChevronRight size={16} className="opacity-80" />
        </button>

        {/* Day Info */}
        <div className="flex justify-between items-center mb-4 px-1">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold text-gray-900">
              {new Date(currentDay.dayDate).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })} ({currentDay.dayOfWeek})
            </span>
            {currentDay.isCheatDay && (
              <span className="text-[10px] font-bold bg-orange-100 text-orange-600 px-2 py-0.5 rounded">CHEAT DAY</span>
            )}
          </div>
          <span className="text-xs text-gray-400 font-mono">
            Target: {currentDay.nutritionalFocus || 'Balance'}
          </span>
        </div>

        {/* Meals */}
        <div className="space-y-1">
          {(['breakfast', 'lunch', 'dinner'] as MealType[]).map(type => {
            const meal = getMeal(currentDay, type);
            return meal ? (
              <MealCard key={type} type={type} meal={meal} />
            ) : (
              <EmptySlot key={type} type={type} />
            );
          })}
        </div>
      </div>

      {/* --- Modals --- */}
      <AnimatePresence>
        {activeModal && (
          <>
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 z-50 backdrop-blur-sm"
              onClick={() => setActiveModal(null)}
            />
            <motion.div
              initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="fixed bottom-0 left-0 right-0 bg-white rounded-t-[32px] z-50 max-h-[85vh] flex flex-col overflow-hidden shadow-2xl"
            >
              {/* Modal Header */}
              <div className="px-5 py-4 border-b border-gray-100 flex justify-between items-center bg-white">
                <h3 className="font-bold text-lg flex items-center gap-2">
                  {activeModal === 'fridge' && <Refrigerator className="text-blue-500" />}
                  {activeModal === 'shopping' && <ShoppingCart className="text-orange-500" />}
                  {activeModal === 'stats' && <BarChart3 className="text-purple-500" />}
                  {activeModal === 'fridge' ? '冷蔵庫管理' : activeModal === 'shopping' ? '買い物リスト' : activeModal === 'stats' ? '週間サマリー' : 'メニュー'}
                </h3>
                <button onClick={() => setActiveModal(null)} className="p-2 bg-gray-50 rounded-full hover:bg-gray-100">
                  <X size={16} className="text-gray-500" />
                </button>
              </div>

              {/* Modal Content */}
              <div className="flex-1 overflow-y-auto p-5">
                {activeModal === 'shopping' && (
                  <div className="space-y-3">
                    {shoppingList.map(item => (
                      <div key={item.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                        <button 
                          className={cn(
                            "w-5 h-5 rounded-full border-2 flex items-center justify-center",
                            item.isChecked ? "bg-green-500 border-green-500" : "border-gray-300"
                          )}
                        >
                          {item.isChecked && <Check size={12} className="text-white" />}
                        </button>
                        <span className={cn("flex-1 font-medium", item.isChecked && "text-gray-400 line-through")}>
                          {item.itemName}
                        </span>
                        <span className="text-xs text-gray-400">{item.quantity}</span>
                      </div>
                    ))}
                    {shoppingList.length === 0 && <p className="text-center text-gray-400 py-8">リストは空です</p>}
                  </div>
                )}

                {activeModal === 'fridge' && (
                  <div className="text-center py-10 text-gray-400">
                    <Refrigerator size={48} className="mx-auto mb-4 opacity-20" />
                    <p>冷蔵庫連携機能は準備中です</p>
                  </div>
                )}

                {activeModal === 'stats' && (
                  <div className="space-y-6">
                    <div className="flex gap-4">
                      <div className="flex-1 bg-green-50 p-4 rounded-2xl text-center">
                        <ChefHat size={24} className="text-green-600 mx-auto mb-2" />
                        <p className="text-2xl font-black text-green-700">{stats.cookRate}%</p>
                        <p className="text-xs text-green-600 font-bold">自炊率</p>
                      </div>
                      <div className="flex-1 bg-orange-50 p-4 rounded-2xl text-center">
                        <Flame size={24} className="text-orange-600 mx-auto mb-2" />
                        <p className="text-2xl font-black text-orange-700">{stats.avgCal}</p>
                        <p className="text-xs text-orange-600 font-bold">平均kcal</p>
                      </div>
                    </div>
                    <div className="bg-gray-50 p-4 rounded-2xl">
                      <h4 className="font-bold text-gray-700 mb-3 text-sm">内訳</h4>
                      <div className="flex justify-between text-sm">
                        <span>🍳 自炊: <b>{stats.cookCount}</b></span>
                        <span>🏪 買う: <b>{stats.buyCount}</b></span>
                        <span>🍽️ 外食: <b>{stats.outCount}</b></span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
};
