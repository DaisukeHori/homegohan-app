"use client";

import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { MealPlan, MealPlanDay, PlannedMeal, PantryItem, ShoppingListItem } from "@/types/domain";
import { Icons } from "@/components/icons";
import { cn } from "@/lib/utils";
import {
  ChefHat, Store, UtensilsCrossed, FastForward,
  Sparkles, Zap, X, Plus, Check, Calendar,
  Flame, Refrigerator, Trash2, AlertTriangle,
  BarChart3, ShoppingCart, ChevronDown, ChevronLeft, ChevronRight
} from 'lucide-react';

// --- Types & Constants ---
type MealType = 'breakfast' | 'lunch' | 'dinner';
type ModalType = 'newMenu' | 'ai' | 'fridge' | 'shopping' | 'stats' | null;

const MODE_CONFIG = {
  cook: { icon: ChefHat, label: '自炊', color: 'text-green-600', bg: 'bg-green-50' },
  quick: { icon: Zap, label: '時短', color: 'text-blue-600', bg: 'bg-blue-50' },
  buy: { icon: Store, label: '買う', color: 'text-purple-600', bg: 'bg-purple-50' },
  out: { icon: UtensilsCrossed, label: '外食', color: 'text-orange-500', bg: 'bg-orange-50' },
  skip: { icon: FastForward, label: 'なし', color: 'text-gray-400', bg: 'bg-gray-100' },
};

const MEAL_LABELS: Record<MealType, string> = { breakfast: '朝食', lunch: '昼食', dinner: '夕食' };

// Helper to generate week dates
const getWeekDates = (startDate: Date): { date: Date; dayOfWeek: string; dateStr: string }[] => {
  const days = [];
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    days.push({
      date: d,
      dayOfWeek: dayNames[d.getDay()],
      dateStr: d.toISOString().split('T')[0],
    });
  }
  return days;
};

const getWeekStart = (date: Date): Date => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday as start
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

export default function WeeklyMenuPage() {
  const router = useRouter();
  const supabase = createClient();
  
  const [currentPlan, setCurrentPlan] = useState<MealPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeModal, setActiveModal] = useState<ModalType>(null);
  
  // Week Navigation
  const [weekStart, setWeekStart] = useState<Date>(getWeekStart(new Date()));
  const [selectedDayIndex, setSelectedDayIndex] = useState(0);
  const weekDates = getWeekDates(weekStart);

  // Form State for New Menu
  const [startDate, setStartDate] = useState("");
  const [note, setNote] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  
  // Pantry & Shopping
  const [fridgeItems, setFridgeItems] = useState<PantryItem[]>([]);
  const [shoppingList, setShoppingList] = useState<ShoppingListItem[]>([]);
  const [newItemName, setNewItemName] = useState("");
  const [newItemAmount, setNewItemAmount] = useState("");
  const [newItemDate, setNewItemDate] = useState("");

  // Fetch Plan based on weekStart
  useEffect(() => {
    const fetchPlan = async () => {
      setLoading(true);
      try {
        const targetDate = weekStart.toISOString().split('T')[0];
        const res = await fetch(`/api/meal-plans?date=${targetDate}`);
        if (res.ok) {
          const { mealPlan } = await res.json();
          setCurrentPlan(mealPlan);
          if (mealPlan) {
            setShoppingList(mealPlan.shoppingList || []);
          }
        } else {
          setCurrentPlan(null);
        }
      } catch (e) {
        console.error("Failed to fetch meal plan", e);
        setCurrentPlan(null);
      } finally {
        setLoading(false);
      }
    };
    fetchPlan();
  }, [weekStart]);
  
  // Fetch Pantry
  useEffect(() => {
    const fetchPantry = async () => {
      try {
        const res = await fetch('/api/pantry');
        if (res.ok) {
          const data = await res.json();
          setFridgeItems(data.items || []);
        }
      } catch (e) {
        console.error("Failed to fetch pantry:", e);
      }
    };
    fetchPantry();
  }, []);

  // Initialize selected day to today
  useEffect(() => {
    const today = new Date().toISOString().split('T')[0];
    const idx = weekDates.findIndex(d => d.dateStr === today);
    if (idx !== -1) setSelectedDayIndex(idx);
  }, [weekStart]);

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
      router.push(`/menus/weekly/${data.id}`);
    } catch (error: any) {
      alert(error.message || "エラーが発生しました");
      setIsGenerating(false);
    }
  };

  const handleUpdateMeal = async (dayId: string, mealId: string | null, updates: Partial<PlannedMeal>) => {
    if (!currentPlan || !mealId) return;
    // Optimistic Update
    const updatedDays = currentPlan.days?.map(day => {
      if (day.id !== dayId) return day;
      return { ...day, meals: day.meals?.map(meal => meal.id === mealId ? { ...meal, ...updates } : meal) };
    });
    setCurrentPlan({ ...currentPlan, days: updatedDays });
    try {
      await fetch(`/api/meal-plans/meals/${mealId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
    } catch (e) {
      console.error('Failed to update meal:', e);
    }
  };

  const navigateWeek = (direction: 'prev' | 'next') => {
    const newStart = new Date(weekStart);
    newStart.setDate(newStart.getDate() + (direction === 'next' ? 7 : -7));
    setWeekStart(newStart);
    setSelectedDayIndex(0);
  };

  // Pantry & Shopping Handlers
  const addPantryItem = async () => {
    if (!newItemName) return;
    try {
      const res = await fetch('/api/pantry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newItemName, amount: newItemAmount, category: "other", expirationDate: newItemDate || null })
      });
      if (res.ok) {
        const { item } = await res.json();
        setFridgeItems(prev => [...prev, item]);
        setNewItemName(""); setNewItemAmount(""); setNewItemDate("");
      }
    } catch (e) { alert("追加に失敗しました"); }
  };
  const deletePantryItem = async (id: string) => {
    try {
      await fetch(`/api/pantry/${id}`, { method: 'DELETE' });
      setFridgeItems(prev => prev.filter(i => i.id !== id));
    } catch (e) { alert("削除に失敗しました"); }
  };
  const toggleShoppingItem = async (id: string, currentChecked: boolean) => {
    setShoppingList(prev => prev.map(i => i.id === id ? { ...i, isChecked: !currentChecked } : i));
    try {
      await fetch(`/api/shopping-list/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isChecked: !currentChecked }) });
    } catch (e) { setShoppingList(prev => prev.map(i => i.id === id ? { ...i, isChecked: currentChecked } : i)); }
  };

  // --- Computed ---
  const currentDay = currentPlan?.days?.find(d => d.dayDate === weekDates[selectedDayIndex]?.dateStr);
  const getMeal = (day: MealPlanDay | undefined, type: MealType) => day?.meals?.find(m => m.mealType === type);
  const expiringItems = fridgeItems.filter(i => i.expirationDate && new Date(i.expirationDate) <= new Date(new Date().setDate(new Date().getDate() + 3)));
  const emptySlotCount = currentPlan ? 0 : 21; // All slots empty if no plan

  const getWeekStats = () => {
    if (!currentPlan?.days) return { cookRate: 0, avgCal: 0 };
    let totalCal = 0, mealCount = 0;
    currentPlan.days.forEach(day => {
      day.meals?.forEach(meal => { totalCal += meal.caloriesKcal || 0; mealCount++; });
    });
    return { cookRate: mealCount > 0 ? 100 : 0, avgCal: currentPlan.days.length > 0 ? Math.round(totalCal / currentPlan.days.length) : 0 };
  };
  const stats = getWeekStats();

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F7F6F3] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // --- Render ---
  return (
    <div className="min-h-screen bg-[#F7F6F3] flex flex-col pb-20">
      
      {/* === Header === */}
      <div className="bg-white pt-4 px-4 pb-2 sticky top-0 z-20 shadow-sm">
        <div className="flex justify-between items-center mb-3">
          <div className="flex items-center gap-2">
            <Calendar size={20} className="text-orange-500" />
            <div>
              <h1 className="text-lg font-bold text-gray-900 leading-none">献立表</h1>
              <p className="text-[10px] text-gray-400 mt-0.5">
                {weekDates[0]?.date.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })} - {weekDates[6]?.date.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setActiveModal('stats')} className="w-9 h-9 rounded-full bg-gray-50 flex items-center justify-center hover:bg-gray-100">
              <BarChart3 size={18} className="text-gray-500" />
            </button>
            <button onClick={() => setActiveModal('fridge')} className="w-9 h-9 rounded-full bg-gray-50 flex items-center justify-center hover:bg-gray-100 relative">
              <Refrigerator size={18} className={expiringItems.some(i => i.expirationDate && new Date(i.expirationDate) <= new Date(new Date().setDate(new Date().getDate() + 1))) ? "text-red-500" : "text-gray-500"} />
              {expiringItems.length > 0 && (
                <div className="absolute -top-1 -right-1 w-4 h-4 bg-orange-500 rounded-full flex items-center justify-center text-[9px] font-bold text-white">{expiringItems.length}</div>
              )}
            </button>
            <button onClick={() => setActiveModal('shopping')} className="w-9 h-9 rounded-full bg-gray-50 flex items-center justify-center hover:bg-gray-100 relative">
              <ShoppingCart size={18} className="text-gray-500" />
              {shoppingList.filter(i => !i.isChecked).length > 0 && (
                <div className="absolute -top-1 -right-1 w-4 h-4 bg-blue-500 rounded-full flex items-center justify-center text-[9px] font-bold text-white">
                  {shoppingList.filter(i => !i.isChecked).length}
                </div>
              )}
            </button>
          </div>
        </div>

        {/* Week Stats Mini */}
        <div className="flex gap-4 mb-3 text-xs text-gray-500">
          <div className="flex items-center gap-1">
            <ChefHat size={12} className="text-green-600" />
            <span>自炊率 {stats.cookRate}%</span>
          </div>
          <div className="flex items-center gap-1">
            <Flame size={12} className="text-orange-500" />
            <span>平均 {stats.avgCal}kcal/日</span>
          </div>
        </div>

        {/* Day Tabs with Week Navigation */}
        <div className="flex items-center gap-1">
          <button onClick={() => navigateWeek('prev')} className="p-1 rounded-full hover:bg-gray-100 text-gray-400">
            <ChevronLeft size={18} />
          </button>
          <div className="flex flex-1 justify-around">
            {weekDates.map((day, idx) => {
              const isSelected = idx === selectedDayIndex;
              const isToday = day.dateStr === new Date().toISOString().split('T')[0];
              const isWeekend = day.date.getDay() === 0 || day.date.getDay() === 6;
              const hasMeals = currentPlan?.days?.some(d => d.dayDate === day.dateStr && d.meals && d.meals.length > 0);
              return (
                <button
                  key={day.dateStr}
                  onClick={() => setSelectedDayIndex(idx)}
                  className={cn(
                    "flex flex-col items-center justify-center min-w-[36px] py-1.5 rounded-xl transition-all relative",
                    isSelected ? "bg-orange-500 text-white shadow-md" : isToday ? "border-2 border-orange-400 text-orange-500" : "text-gray-400 hover:bg-gray-50"
                  )}
                >
                  <span className="text-[9px] opacity-80">{day.date.getDate()}</span>
                  <span className={cn("text-xs font-bold", isWeekend && !isSelected && "text-orange-400")}>{day.dayOfWeek}</span>
                  {hasMeals && !isSelected && <div className="absolute bottom-0.5 w-1 h-1 bg-green-500 rounded-full" />}
                </button>
              );
            })}
          </div>
          <button onClick={() => navigateWeek('next')} className="p-1 rounded-full hover:bg-gray-100 text-gray-400">
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      {/* === AI Banner === */}
      {!currentPlan && (
        <button
          onClick={() => setActiveModal('newMenu')}
          className="mx-4 mt-3 p-3 bg-orange-500 rounded-xl flex items-center justify-between shadow-lg hover:bg-orange-600 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-white" />
            <span className="text-sm font-bold text-white">AIで献立を作成する</span>
          </div>
          <ChevronRight size={18} className="text-white/70" />
        </button>
      )}

      {/* Expiring Items Alert */}
      {expiringItems.filter(i => i.expirationDate && new Date(i.expirationDate) <= new Date(new Date().setDate(new Date().getDate() + 2))).length > 0 && (
        <div className="mx-4 mt-3 p-2 bg-amber-50 border border-amber-200 rounded-xl flex items-center gap-2">
          <AlertTriangle size={14} className="text-amber-600" />
          <span className="text-[11px] text-gray-700">
            <strong>早めに使い切り:</strong> {expiringItems.filter(i => i.expirationDate && new Date(i.expirationDate) <= new Date(new Date().setDate(new Date().getDate() + 2))).map(i => i.name).join(', ')}
          </span>
        </div>
      )}

      {/* === Main Content === */}
      <main className="flex-1 p-4">
        <div className="flex justify-between items-center mb-3 px-1">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold text-gray-900">
              {weekDates[selectedDayIndex]?.date.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })} ({weekDates[selectedDayIndex]?.dayOfWeek})
            </span>
            {weekDates[selectedDayIndex]?.dateStr === new Date().toISOString().split('T')[0] && (
              <span className="text-[10px] font-bold bg-orange-500 text-white px-2 py-0.5 rounded">今日</span>
            )}
          </div>
        </div>

        <div className="space-y-2">
          {(['breakfast', 'lunch', 'dinner'] as MealType[]).map(type => {
            const meal = getMeal(currentDay, type);
            if (meal) {
              // --- Meal Card ---
              return (
                <div key={type} className="flex items-center gap-2">
                  <button
                    onClick={() => handleUpdateMeal(currentDay!.id, meal.id, { isCompleted: !meal.isCompleted })}
                    className={cn(
                      "w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 border-2 transition-colors",
                      meal.isCompleted ? "bg-green-500 border-green-500" : "bg-transparent border-gray-200 hover:border-green-400"
                    )}
                  >
                    {meal.isCompleted && <Check size={14} className="text-white" />}
                  </button>
                  <div className={cn(
                    "flex-1 flex items-center justify-between bg-white rounded-2xl p-3 shadow-sm transition-all",
                    meal.isCompleted && "opacity-60"
                  )}>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-bold text-gray-800 w-7">{MEAL_LABELS[type].slice(0, 1)}</span>
                      <span className={cn("text-sm text-gray-600", meal.isCompleted && "line-through")}>
                        {meal.dishName}
                      </span>
                    </div>
                    <span className="text-xs text-gray-400">{meal.caloriesKcal || '-'}kcal</span>
                  </div>
                </div>
              );
            } else {
              // --- Empty Slot ---
              return (
                <button
                  key={type}
                  onClick={() => setActiveModal('newMenu')}
                  className="w-full flex items-center justify-center gap-2 bg-white border-2 border-dashed border-gray-200 rounded-2xl p-5 hover:border-orange-300 hover:bg-orange-50/30 transition-colors"
                >
                  <Plus size={18} className="text-gray-400" />
                  <span className="text-sm text-gray-400">{MEAL_LABELS[type]}を追加</span>
                </button>
              );
            }
          })}
        </div>
      </main>

      {/* === FAB (if plan exists) === */}
      {currentPlan && (
        <motion.button
          initial={{ scale: 0 }} animate={{ scale: 1 }}
          onClick={() => setActiveModal('newMenu')}
          className="fixed bottom-24 right-6 w-14 h-14 bg-black text-white rounded-full shadow-2xl flex items-center justify-center z-30 hover:scale-110 transition-transform"
        >
          <Plus className="w-6 h-6" />
        </motion.button>
      )}

      {/* === Modals === */}
      <AnimatePresence>
        {activeModal && (
          <>
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setActiveModal(null)}
              className="fixed inset-0 bg-black/60 z-[100] backdrop-blur-sm"
            />
            <motion.div
              initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="fixed bottom-0 md:bottom-auto md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2 w-full md:w-[480px] bg-white rounded-t-[32px] md:rounded-[32px] z-[101] shadow-2xl max-h-[85vh] flex flex-col overflow-hidden"
            >
              {/* Modal Header */}
              <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-white flex-shrink-0">
                <h3 className="font-bold text-lg flex items-center gap-2">
                  {activeModal === 'newMenu' && <><Sparkles size={20} className="text-orange-500" /> 新しい献立を作成</>}
                  {activeModal === 'fridge' && <><Refrigerator size={20} className="text-blue-500" /> 冷蔵庫</>}
                  {activeModal === 'shopping' && <><ShoppingCart size={20} className="text-purple-500" /> 買い物リスト</>}
                  {activeModal === 'stats' && <><BarChart3 size={20} className="text-green-500" /> 週間サマリー</>}
                </h3>
                <button onClick={() => setActiveModal(null)} className="p-2 bg-gray-50 rounded-full hover:bg-gray-100">
                  <X size={16} className="text-gray-500" />
                </button>
              </div>

              {/* Modal Content */}
              <div className="flex-1 overflow-y-auto p-6 pb-32 md:pb-8">
                {/* New Menu Modal */}
                {activeModal === 'newMenu' && (
                  <div className="space-y-6">
                    <p className="text-gray-500 text-sm">来週の目標や予定を教えてください。AIが最適な献立を提案します。</p>
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
                        className="w-full h-32 p-4 rounded-xl bg-gray-50 border border-gray-100 text-base resize-none focus:ring-2 focus:ring-orange-400 focus:bg-white transition-all"
                      />
                    </div>
                    <Button 
                      onClick={handleGenerate}
                      disabled={isGenerating || !startDate}
                      className="w-full h-14 rounded-xl bg-black text-white font-bold text-lg shadow-xl hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-50"
                    >
                      {isGenerating ? "AIが思考中..." : "献立を生成する 🪄"}
                    </Button>
                  </div>
                )}

                {/* Fridge Modal */}
                {activeModal === 'fridge' && (
                  <>
                    <div className="flex gap-2 mb-4">
                      <input value={newItemName} onChange={(e) => setNewItemName(e.target.value)} placeholder="食材名" className="flex-1 p-3 border border-gray-200 rounded-xl bg-gray-50" />
                      <input type="date" value={newItemDate} onChange={(e) => setNewItemDate(e.target.value)} className="w-32 p-3 border border-gray-200 rounded-xl bg-gray-50" />
                      <button onClick={addPantryItem} className="bg-orange-500 text-white p-3 rounded-xl hover:bg-orange-600"><Plus size={20} /></button>
                    </div>
                    <div className="space-y-2">
                      {fridgeItems.length === 0 ? (
                        <p className="text-center text-gray-400 py-8">冷蔵庫は空です</p>
                      ) : (
                        fridgeItems.sort((a, b) => (a.expirationDate || '').localeCompare(b.expirationDate || '')).map(item => {
                          const daysLeft = item.expirationDate ? Math.ceil((new Date(item.expirationDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : null;
                          return (
                            <div key={item.id} className={cn(
                              "flex items-center justify-between p-3 rounded-xl",
                              daysLeft !== null && daysLeft <= 1 ? "bg-red-50" : daysLeft !== null && daysLeft <= 3 ? "bg-amber-50" : "bg-gray-50"
                            )}>
                              <div>
                                <p className="font-medium text-gray-800">{item.name}</p>
                                <p className="text-xs text-gray-500">{item.expirationDate ? `期限: ${item.expirationDate}` : '期限なし'}</p>
                              </div>
                              <div className="flex items-center gap-2">
                                {daysLeft !== null && (
                                  <span className={cn(
                                    "text-[10px] font-bold px-2 py-0.5 rounded",
                                    daysLeft <= 1 ? "bg-red-500 text-white" : daysLeft <= 3 ? "bg-amber-500 text-white" : "bg-gray-200 text-gray-600"
                                  )}>
                                    {daysLeft <= 0 ? '今日まで' : `${daysLeft}日`}
                                  </span>
                                )}
                                <button onClick={() => deletePantryItem(item.id)} className="text-gray-400 hover:text-red-500 p-1"><Trash2 size={16} /></button>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </>
                )}

                {/* Shopping Modal */}
                {activeModal === 'shopping' && (
                  <div className="space-y-2">
                    {shoppingList.length === 0 ? (
                      <p className="text-center text-gray-400 py-8">買い物リストは空です</p>
                    ) : (
                      shoppingList.map(item => (
                        <button
                          key={item.id}
                          onClick={() => toggleShoppingItem(item.id, item.isChecked)}
                          className={cn(
                            "w-full flex items-center gap-3 p-3 rounded-xl text-left transition-colors",
                            item.isChecked ? "bg-gray-100" : "bg-gray-50 hover:bg-gray-100"
                          )}
                        >
                          <div className={cn(
                            "w-5 h-5 rounded-full border-2 flex items-center justify-center",
                            item.isChecked ? "bg-green-500 border-green-500" : "border-gray-300"
                          )}>
                            {item.isChecked && <Check size={12} className="text-white" />}
                          </div>
                          <span className={cn("flex-1 font-medium", item.isChecked && "text-gray-400 line-through")}>{item.itemName}</span>
                          <span className="text-xs text-gray-400">{item.quantity}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}

                {/* Stats Modal */}
                {activeModal === 'stats' && (
                  <div className="space-y-6">
                    <div className="flex gap-4">
                      <div className="flex-1 bg-green-50 p-5 rounded-2xl text-center">
                        <ChefHat size={28} className="text-green-600 mx-auto mb-1" />
                        <p className="text-3xl font-black text-green-700">{stats.cookRate}%</p>
                        <p className="text-xs text-green-600 font-bold">自炊率</p>
                      </div>
                      <div className="flex-1 bg-orange-50 p-5 rounded-2xl text-center">
                        <Flame size={28} className="text-orange-500 mx-auto mb-1" />
                        <p className="text-3xl font-black text-orange-700">{stats.avgCal}</p>
                        <p className="text-xs text-orange-600 font-bold">平均kcal/日</p>
                      </div>
                    </div>
                    <div className="bg-purple-50 p-4 rounded-xl">
                      <p className="text-sm font-bold text-purple-700 mb-1">💡 ヒント</p>
                      <p className="text-xs text-gray-700 leading-relaxed">
                        {currentPlan 
                          ? `今週の献立は${currentPlan.days?.length || 0}日分登録されています。毎日の食事を記録して、自炊率を上げましょう！`
                          : '献立を作成して、計画的な食生活を始めましょう！AIがあなたに合った献立を提案します。'
                        }
                      </p>
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
}
