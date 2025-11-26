"use client";

import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import type { MealPlan, MealPlanDay, PlannedMeal, PantryItem, ShoppingListItem, MealMode, MealDishes } from "@/types/domain";
import {
  ChefHat, Store, UtensilsCrossed, FastForward,
  Sparkles, Zap, X, Plus, Check, Calendar,
  Flame, Refrigerator, Trash2, AlertTriangle,
  BarChart3, ShoppingCart, ChevronDown, ChevronRight,
  Clock, Users, BookOpen, Heart, RefreshCw, Send, Package
} from 'lucide-react';

// ============================================
// Types & Constants (Reference UI Style)
// ============================================

type MealType = 'breakfast' | 'lunch' | 'dinner';
type DishType = 'main' | 'side1' | 'side2' | 'soup';
type ModalType = 'ai' | 'aiPreview' | 'aiMeal' | 'fridge' | 'shopping' | 'stats' | 'recipe' | 'add' | 'addFridge' | 'addShopping' | 'editMeal' | null;

// Reference UI Color Palette
const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  success: '#6B9B6B',
  successLight: '#EDF5ED',
  warning: '#E5A84B',
  warningLight: '#FEF9EE',
  purple: '#7C6BA0',
  purpleLight: '#F5F3F8',
  blue: '#5B8BC7',
  blueLight: '#EEF4FB',
  border: '#E8E8E8',
  danger: '#D64545',
  dangerLight: '#FDECEC',
};

const MODE_CONFIG: Record<MealMode, { icon: typeof ChefHat; label: string; color: string; bg: string }> = {
  cook: { icon: ChefHat, label: '自炊', color: colors.success, bg: colors.successLight },
  quick: { icon: Zap, label: '時短', color: colors.blue, bg: colors.blueLight },
  buy: { icon: Store, label: '買う', color: colors.purple, bg: colors.purpleLight },
  out: { icon: UtensilsCrossed, label: '外食', color: colors.warning, bg: colors.warningLight },
  skip: { icon: FastForward, label: 'なし', color: colors.textMuted, bg: colors.bg },
};

const DISH_TYPE_CONFIG: Record<DishType, { label: string; color: string; bg: string }> = {
  main: { label: '主菜', color: colors.accent, bg: colors.accentLight },
  side1: { label: '副菜', color: colors.success, bg: colors.successLight },
  side2: { label: '副菜', color: colors.success, bg: colors.successLight },
  soup: { label: '汁物', color: colors.blue, bg: colors.blueLight },
};

const MEAL_LABELS: Record<MealType, string> = { breakfast: '朝食', lunch: '昼食', dinner: '夕食' };
const AI_CONDITIONS = ['冷蔵庫の食材を優先', '時短メニュー中心', '和食多め', 'ヘルシーに'];

// Helper functions
const formatLocalDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getWeekDates = (startDate: Date): { date: Date; dayOfWeek: string; dateStr: string }[] => {
  const days = [];
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    days.push({ date: d, dayOfWeek: dayNames[d.getDay()], dateStr: formatLocalDate(d) });
  }
  return days;
};

const getWeekStart = (date: Date): Date => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

const getDaysUntil = (dateStr: string | null | undefined): number | null => {
  if (!dateStr) return null;
  const target = new Date(dateStr);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
};

// ============================================
// Main Component
// ============================================

export default function WeeklyMenuPage() {
  const router = useRouter();
  
  const [currentPlan, setCurrentPlan] = useState<MealPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeModal, setActiveModal] = useState<ModalType>(null);
  
  // Week Navigation
  const [weekStart, setWeekStart] = useState<Date>(getWeekStart(new Date()));
  const [selectedDayIndex, setSelectedDayIndex] = useState(0);
  const weekDates = getWeekDates(weekStart);

  // Expanded Meal State
  const [expandedMeal, setExpandedMeal] = useState<MealType>('dinner');

  // Form States
  const [aiChatInput, setAiChatInput] = useState("");
  const [addMealKey, setAddMealKey] = useState<MealType | null>(null);
  const [addMealDayIndex, setAddMealDayIndex] = useState<number>(0);
  const [selectedConditions, setSelectedConditions] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatingMeal, setGeneratingMeal] = useState<{ dayIndex: number; mealType: MealType } | null>(null);
  
  // Edit meal state
  const [editingMeal, setEditingMeal] = useState<PlannedMeal | null>(null);
  const [editMealName, setEditMealName] = useState("");
  const [editMealMode, setEditMealMode] = useState<MealMode>('cook');
  
  // Pantry & Shopping
  const [fridgeItems, setFridgeItems] = useState<PantryItem[]>([]);
  const [shoppingList, setShoppingList] = useState<ShoppingListItem[]>([]);
  
  // Add fridge item form
  const [newFridgeName, setNewFridgeName] = useState("");
  const [newFridgeAmount, setNewFridgeAmount] = useState("");
  const [newFridgeExpiry, setNewFridgeExpiry] = useState("");
  
  // Add shopping item form
  const [newShoppingName, setNewShoppingName] = useState("");
  const [newShoppingAmount, setNewShoppingAmount] = useState("");
  const [newShoppingCategory, setNewShoppingCategory] = useState("食材");

  // Recipe Modal
  const [selectedRecipe, setSelectedRecipe] = useState<string | null>(null);
  const [selectedRecipeData, setSelectedRecipeData] = useState<any>(null);
  
  // AI Preview
  const [aiSuggestions, setAiSuggestions] = useState<any[]>([]);

  // Fetch Plan
  useEffect(() => {
    const fetchPlan = async () => {
      setLoading(true);
      try {
        const targetDate = formatLocalDate(weekStart);
        const res = await fetch(`/api/meal-plans?date=${targetDate}`);
        if (res.ok) {
          const { mealPlan } = await res.json();
          setCurrentPlan(mealPlan);
          if (mealPlan) setShoppingList(mealPlan.shoppingList || []);
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
    const todayStr = formatLocalDate(new Date());
    const idx = weekDates.findIndex(d => d.dateStr === todayStr);
    if (idx !== -1) setSelectedDayIndex(idx);
  }, [weekStart]);

  // --- Handlers ---
  
  const handleUpdateMeal = async (dayId: string, mealId: string | null, updates: Partial<PlannedMeal>) => {
    if (!currentPlan || !mealId) return;
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
    } catch (e) { console.error('Failed to update meal:', e); }
  };

  // Add pantry item
  const addPantryItem = async () => {
    if (!newFridgeName) return;
    try {
      const res = await fetch('/api/pantry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          name: newFridgeName, 
          amount: newFridgeAmount, 
          category: "other", 
          expirationDate: newFridgeExpiry || null 
        })
      });
      if (res.ok) {
        const { item } = await res.json();
        setFridgeItems(prev => [...prev, item]);
        setNewFridgeName(""); 
        setNewFridgeAmount(""); 
        setNewFridgeExpiry("");
        setActiveModal('fridge');
      }
    } catch (e) { alert("追加に失敗しました"); }
  };

  const deletePantryItem = async (id: string) => {
    try {
      await fetch(`/api/pantry/${id}`, { method: 'DELETE' });
      setFridgeItems(prev => prev.filter(i => i.id !== id));
    } catch (e) { alert("削除に失敗しました"); }
  };

  // Add shopping item
  const addShoppingItem = async () => {
    if (!newShoppingName || !currentPlan) return;
    try {
      const res = await fetch('/api/shopping-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          mealPlanId: currentPlan.id,
          itemName: newShoppingName, 
          quantity: newShoppingAmount, 
          category: newShoppingCategory
        })
      });
      if (res.ok) {
        const { item } = await res.json();
        setShoppingList(prev => [...prev, item]);
        setNewShoppingName(""); 
        setNewShoppingAmount(""); 
        setNewShoppingCategory("食材");
        setActiveModal('shopping');
      }
    } catch (e) { alert("追加に失敗しました"); }
  };

  const toggleShoppingItem = async (id: string, currentChecked: boolean) => {
    setShoppingList(prev => prev.map(i => i.id === id ? { ...i, isChecked: !currentChecked } : i));
    try {
      await fetch(`/api/shopping-list/${id}`, { 
        method: 'PATCH', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ isChecked: !currentChecked }) 
      });
    } catch (e) { 
      setShoppingList(prev => prev.map(i => i.id === id ? { ...i, isChecked: currentChecked } : i)); 
    }
  };

  // Regenerate shopping list from menu
  const regenerateShoppingList = async () => {
    if (!currentPlan) return;
    try {
      const res = await fetch(`/api/shopping-list/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mealPlanId: currentPlan.id })
      });
      if (res.ok) {
        const { items } = await res.json();
        setShoppingList(items);
        alert('買い物リストを再生成しました');
      }
    } catch (e) { alert("再生成に失敗しました"); }
  };

  // Add recipe ingredients to shopping list
  const addRecipeToShoppingList = async () => {
    if (!selectedRecipeData || !currentPlan) return;
    try {
      const res = await fetch('/api/shopping-list/add-recipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          mealPlanId: currentPlan.id,
          ingredients: selectedRecipeData.ingredients 
        })
      });
      if (res.ok) {
        const { items } = await res.json();
        setShoppingList(prev => [...prev, ...items]);
        alert('材料を買い物リストに追加しました');
        setActiveModal(null);
      }
    } catch (e) { alert("追加に失敗しました"); }
  };

  // Generate weekly menu with AI
  const handleGenerateWeekly = async () => {
    setIsGenerating(true);
    try {
      const preferences = {
        useFridgeFirst: selectedConditions.includes('冷蔵庫の食材を優先'),
        quickMeals: selectedConditions.includes('時短メニュー中心'),
        japaneseStyle: selectedConditions.includes('和食多め'),
        healthy: selectedConditions.includes('ヘルシーに'),
      };

      const response = await fetch("/api/ai/menu/weekly/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          startDate: weekDates[0]?.dateStr, 
          note: aiChatInput + (selectedConditions.length > 0 ? `\n【条件】${selectedConditions.join('、')}` : ''),
          preferences,
        }),
      });
      if (!response.ok) throw new Error("生成リクエストに失敗しました");
      const data = await response.json();
      router.push(`/menus/weekly/${data.id}`);
    } catch (error: any) {
      alert(error.message || "エラーが発生しました");
      setIsGenerating(false);
    }
  };

  // Generate single meal with AI
  const handleGenerateSingleMeal = async () => {
    if (!addMealKey) return;
    
    setGeneratingMeal({ dayIndex: addMealDayIndex, mealType: addMealKey });
    setActiveModal(null);
    
    try {
      const preferences: Record<string, boolean> = {};
      selectedConditions.forEach(c => {
        if (c === '冷蔵庫の食材を優先') preferences.useFridgeFirst = true;
        if (c === '時短メニュー中心') preferences.quickMeals = true;
        if (c === '和食多め') preferences.japaneseStyle = true;
        if (c === 'ヘルシーに') preferences.healthy = true;
      });

      const dayDate = weekDates[addMealDayIndex]?.dateStr;
      
      const res = await fetch('/api/ai/menu/meal/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dayDate,
          mealType: addMealKey,
          preferences,
          note: aiChatInput
        })
      });

      if (res.ok) {
        setSelectedConditions([]);
        setAiChatInput("");
        setSelectedDayIndex(addMealDayIndex);
        
        // Poll for data
        let attempts = 0;
        const maxAttempts = 10;
        const pollInterval = setInterval(async () => {
          attempts++;
          try {
            const targetDate = formatLocalDate(weekStart);
            const pollRes = await fetch(`/api/meal-plans?date=${targetDate}`);
            if (pollRes.ok) {
              const { mealPlan } = await pollRes.json();
              if (mealPlan) {
                const targetDay = mealPlan.days?.find((d: any) => d.dayDate === dayDate);
                const targetMeal = targetDay?.meals?.find((m: any) => m.mealType === addMealKey);
                if (targetMeal) {
                  setCurrentPlan(mealPlan);
                  setGeneratingMeal(null);
                  clearInterval(pollInterval);
                }
              }
            }
          } catch (e) {
            console.error('Polling error:', e);
          }
          
          if (attempts >= maxAttempts) {
            setGeneratingMeal(null);
            clearInterval(pollInterval);
            window.location.reload();
          }
        }, 3000);
      } else {
        const err = await res.json();
        alert(`エラー: ${err.error || '生成に失敗しました'}`);
        setGeneratingMeal(null);
      }
    } catch (error) {
      console.error('Meal generation error:', error);
      alert('エラーが発生しました');
      setGeneratingMeal(null);
    }
  };

  // Add meal with specific mode
  const handleAddMealWithMode = async (mode: MealMode) => {
    if (!addMealKey) return;
    
    const dayDate = weekDates[addMealDayIndex]?.dateStr;
    const defaultNames: Record<MealMode, string> = {
      cook: '自炊メニュー',
      quick: '時短メニュー',
      buy: 'コンビニ・惣菜',
      out: '外食',
      skip: 'スキップ'
    };
    
    try {
      const res = await fetch('/api/meal-plans/meals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dayDate,
          mealType: addMealKey,
          mode,
          dishName: defaultNames[mode],
          isSimple: true
        })
      });
      
      if (res.ok) {
        // Refresh data
        const targetDate = formatLocalDate(weekStart);
        const refreshRes = await fetch(`/api/meal-plans?date=${targetDate}`);
        if (refreshRes.ok) {
          const { mealPlan } = await refreshRes.json();
          setCurrentPlan(mealPlan);
        }
        setActiveModal(null);
      }
    } catch (e) {
      alert('追加に失敗しました');
    }
  };

  // Edit meal (change button)
  const openEditMeal = (meal: PlannedMeal) => {
    setEditingMeal(meal);
    setEditMealName(meal.dishName);
    setEditMealMode(meal.mode || 'cook');
    setActiveModal('editMeal');
  };

  const saveEditMeal = async () => {
    if (!editingMeal || !currentPlan) return;
    
    try {
      await fetch(`/api/meal-plans/meals/${editingMeal.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dishName: editMealName,
          mode: editMealMode
        })
      });
      
      // Update local state
      const updatedDays = currentPlan.days?.map(day => ({
        ...day,
        meals: day.meals?.map(m => 
          m.id === editingMeal.id 
            ? { ...m, dishName: editMealName, mode: editMealMode }
            : m
        )
      }));
      setCurrentPlan({ ...currentPlan, days: updatedDays });
      setActiveModal(null);
      setEditingMeal(null);
    } catch (e) {
      alert('更新に失敗しました');
    }
  };

  // --- Computed ---
  const currentDay = currentPlan?.days?.find(d => d.dayDate === weekDates[selectedDayIndex]?.dateStr);
  const getMeal = (day: MealPlanDay | undefined, type: MealType) => day?.meals?.find(m => m.mealType === type);
  const expiringItems = fridgeItems.filter(i => {
    const days = getDaysUntil(i.expirationDate);
    return days !== null && days <= 3;
  }).sort((a, b) => (getDaysUntil(a.expirationDate) || 0) - (getDaysUntil(b.expirationDate) || 0));

  const countEmptySlots = () => {
    if (!currentPlan?.days) return 21;
    let count = 0;
    const todayStr = formatLocalDate(new Date());
    currentPlan.days.forEach(day => {
      if (day.dayDate >= todayStr) {
        (['breakfast', 'lunch', 'dinner'] as MealType[]).forEach(type => {
          if (!getMeal(day, type)) count++;
        });
      }
    });
    return count;
  };

  const getWeekStats = () => {
    if (!currentPlan?.days) return { cookRate: 0, avgCal: 0, cookCount: 0, buyCount: 0, outCount: 0 };
    let cookCount = 0, buyCount = 0, outCount = 0, totalCal = 0, mealCount = 0;
    currentPlan.days.forEach(day => {
      day.meals?.forEach(meal => {
        const mode = meal.mode || 'cook';
        if (mode === 'cook' || mode === 'quick') cookCount++;
        else if (mode === 'buy') buyCount++;
        else if (mode === 'out') outCount++;
        totalCal += meal.caloriesKcal || 0;
        mealCount++;
      });
    });
    const total = cookCount + buyCount + outCount;
    return {
      cookRate: total > 0 ? Math.round((cookCount / total) * 100) : 0,
      avgCal: currentPlan.days.length > 0 ? Math.round(totalCal / currentPlan.days.length) : 0,
      cookCount, buyCount, outCount
    };
  };

  const stats = getWeekStats();
  const emptySlotCount = countEmptySlots();
  const todayStr = formatLocalDate(new Date());

  const getDayTotalCal = (day: MealPlanDay | undefined) => {
    if (!day?.meals) return 0;
    return day.meals.reduce((sum, m) => sum + (m.caloriesKcal || 0), 0);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: colors.bg }}>
        <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: colors.accent, borderTopColor: 'transparent' }} />
      </div>
    );
  }

  // ============================================
  // Render Components
  // ============================================

  const EmptySlot = ({ mealKey, dayIndex }: { mealKey: MealType; dayIndex: number }) => {
    const isGeneratingThis = generatingMeal?.dayIndex === dayIndex && generatingMeal?.mealType === mealKey;
    
    if (isGeneratingThis) {
      return (
        <div
          className="w-full rounded-[14px] p-5 mb-2 overflow-hidden relative"
          style={{ background: `linear-gradient(135deg, ${colors.accentLight} 0%, ${colors.card} 100%)`, border: `2px solid ${colors.accent}` }}
        >
          <div className="relative z-10 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: colors.accent }}>
              <Sparkles size={20} color="#fff" className="animate-pulse" />
            </div>
            <div className="flex-1">
              <p style={{ fontSize: 14, fontWeight: 600, color: colors.accent }}>
                AIが{MEAL_LABELS[mealKey]}を考え中...
              </p>
              <p style={{ fontSize: 11, color: colors.textMuted }}>
                数秒〜数十秒かかります
              </p>
            </div>
            <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: colors.accent, borderTopColor: 'transparent' }} />
          </div>
        </div>
      );
    }
    
    return (
      <button
        onClick={() => { setAddMealKey(mealKey); setAddMealDayIndex(dayIndex); setActiveModal('add'); }}
        className="w-full flex items-center justify-center gap-2 rounded-[14px] p-5 mb-2 cursor-pointer transition-all hover:border-[#E07A5F]"
        style={{ background: colors.card, border: `2px dashed ${colors.border}` }}
      >
        <Plus size={18} color={colors.textMuted} />
        <span style={{ fontSize: 14, color: colors.textMuted }}>{MEAL_LABELS[mealKey]}を追加</span>
      </button>
    );
  };

  const CollapsedMealCard = ({ mealKey, meal, isPast }: { mealKey: MealType; meal: PlannedMeal; isPast: boolean }) => {
    const mode = MODE_CONFIG[meal.mode || 'cook'];
    const ModeIcon = mode.icon;
    const isToday = weekDates[selectedDayIndex]?.dateStr === todayStr;

    return (
      <div className="flex items-center gap-2 mb-2">
        {isToday && !isPast && (
          <button
            onClick={() => !meal.isCompleted && handleUpdateMeal(currentDay!.id, meal.id, { isCompleted: true })}
            className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 transition-colors"
            style={{
              border: meal.isCompleted ? 'none' : `2px solid ${colors.border}`,
              background: meal.isCompleted ? colors.success : 'transparent',
              cursor: meal.isCompleted ? 'default' : 'pointer',
            }}
          >
            {meal.isCompleted && <Check size={14} color="#fff" />}
          </button>
        )}
        
        <button
          onClick={() => !isPast && setExpandedMeal(mealKey)}
          className="flex-1 flex items-center justify-between rounded-[14px] p-3 text-left transition-all"
          style={{
            background: isPast ? colors.bg : colors.card,
            opacity: isPast ? 0.6 : (meal.isCompleted ? 0.7 : 1),
          }}
        >
          <div className="flex items-center gap-2.5">
            <span style={{ fontSize: 13, fontWeight: 600, color: colors.text, width: 28 }}>
              {MEAL_LABELS[mealKey].slice(0, 1)}
            </span>
            <div className="flex items-center gap-1 px-2 py-1 rounded-md" style={{ background: mode.bg }}>
              <ModeIcon size={12} color={mode.color} />
            </div>
            <span style={{ 
              fontSize: 13, 
              color: colors.textLight,
              textDecoration: meal.isCompleted ? 'line-through' : 'none',
            }}>
              {meal.isSimple || !meal.dishes ? meal.dishName : `${Object.keys(meal.dishes).length}品`}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span style={{ fontSize: 12, color: colors.textMuted }}>{meal.caloriesKcal || '-'}kcal</span>
            {!isPast && <ChevronDown size={14} color={colors.textMuted} />}
          </div>
        </button>
      </div>
    );
  };

  const ExpandedMealCard = ({ mealKey, meal }: { mealKey: MealType; meal: PlannedMeal }) => {
    const mode = MODE_CONFIG[meal.mode || 'cook'];
    const ModeIcon = mode.icon;
    const isToday = weekDates[selectedDayIndex]?.dateStr === todayStr;
    const dishes = meal.dishes as MealDishes | null;
    const hasDishes = dishes && Object.keys(dishes).length > 0;

    return (
      <div className="rounded-[20px] p-4 mb-2 flex flex-col" style={{ background: colors.card }}>
        <div className="flex justify-between items-center mb-3">
          <div className="flex items-center gap-2.5">
            {isToday && (
              <button
                onClick={() => !meal.isCompleted && handleUpdateMeal(currentDay!.id, meal.id, { isCompleted: true })}
                className="w-7 h-7 rounded-full flex items-center justify-center transition-colors"
                style={{
                  border: meal.isCompleted ? 'none' : `2px solid ${colors.border}`,
                  background: meal.isCompleted ? colors.success : 'transparent',
                  cursor: meal.isCompleted ? 'default' : 'pointer',
                }}
              >
                {meal.isCompleted && <Check size={14} color="#fff" />}
              </button>
            )}
            <span style={{ fontSize: 16, fontWeight: 600, color: colors.text }}>{MEAL_LABELS[mealKey]}</span>
            <div className="flex items-center gap-1 px-2.5 py-1 rounded-lg" style={{ background: mode.bg }}>
              <ModeIcon size={14} color={mode.color} />
              <span style={{ fontSize: 11, fontWeight: 600, color: mode.color }}>{mode.label}</span>
            </div>
          </div>
          <span style={{ fontSize: 14, color: colors.textMuted }}>{meal.caloriesKcal || '-'} kcal</span>
        </div>

        {hasDishes ? (
          <div className="grid grid-cols-2 gap-2">
            {(Object.entries(dishes) as [DishType, any][]).map(([type, dish]) => {
              if (!dish) return null;
              const config = DISH_TYPE_CONFIG[type];
              return (
                <button
                  key={type}
                  onClick={() => {
                    setSelectedRecipe(dish.name);
                    setSelectedRecipeData({ name: dish.name, calories: dish.cal, ingredient: dish.ingredient });
                    setActiveModal('recipe');
                  }}
                  className="text-left flex flex-col min-h-[75px] rounded-xl p-3"
                  style={{ background: config.bg }}
                >
                  <div className="flex justify-between mb-1">
                    <span style={{ fontSize: 9, fontWeight: 700, color: config.color }}>{config.label}</span>
                    <span style={{ fontSize: 9, color: colors.textMuted }}>{dish.cal}kcal</span>
                  </div>
                  <p style={{ fontSize: 13, fontWeight: 500, color: colors.text, margin: 0, flex: 1 }}>{dish.name}</p>
                  {dish.ingredient && (
                    <span className="inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded text-[9px]" style={{ color: colors.success, background: 'rgba(255,255,255,0.7)' }}>
                      <Package size={9} /> {dish.ingredient}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1 mt-1 text-[9px]" style={{ color: colors.blue }}>
                    <BookOpen size={9} /> レシピを見る
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex items-center justify-center rounded-[14px] p-6" style={{ background: colors.bg }}>
            <div className="text-center">
              <ModeIcon size={24} color={mode.color} className="mx-auto mb-1.5" />
              <p style={{ fontSize: 15, fontWeight: 500, color: colors.text, margin: 0 }}>{meal.dishName || '未設定'}</p>
            </div>
          </div>
        )}

        <button 
          onClick={() => openEditMeal(meal)}
          className="w-full mt-3 p-2.5 rounded-[10px] flex items-center justify-center gap-1.5" 
          style={{ background: colors.bg }}
        >
          <RefreshCw size={13} color={colors.textLight} />
          <span style={{ fontSize: 12, color: colors.textLight }}>変更する</span>
        </button>
      </div>
    );
  };

  // ============================================
  // Main Render
  // ============================================

  return (
    <div className="min-h-screen flex flex-col pb-20" style={{ background: colors.bg, fontFamily: '-apple-system, BlinkMacSystemFont, "Noto Sans JP", sans-serif' }}>
      
      {/* === Header === */}
      <div className="pt-4 px-4 pb-2 sticky top-0 z-20" style={{ background: colors.card }}>
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2.5">
            <Calendar size={20} color={colors.accent} />
            <div>
              <h1 style={{ fontSize: 18, fontWeight: 600, color: colors.text, margin: 0 }}>献立表</h1>
              <p style={{ fontSize: 10, color: colors.textMuted, margin: 0 }}>
                {weekDates[0]?.date.getMonth() + 1}/{weekDates[0]?.date.getDate()} - {weekDates[6]?.date.getMonth() + 1}/{weekDates[6]?.date.getDate()}
              </p>
            </div>
          </div>
          <div className="flex gap-1.5">
            <button onClick={() => setActiveModal('stats')} className="w-[34px] h-[34px] rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
              <BarChart3 size={16} color={colors.textLight} />
            </button>
            <button onClick={() => setActiveModal('fridge')} className="w-[34px] h-[34px] rounded-full flex items-center justify-center relative" style={{ background: expiringItems.some(i => getDaysUntil(i.expirationDate)! <= 1) ? colors.dangerLight : colors.bg }}>
              <Refrigerator size={16} color={expiringItems.some(i => getDaysUntil(i.expirationDate)! <= 1) ? colors.danger : colors.textLight} />
              {expiringItems.length > 0 && (
                <div className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full flex items-center justify-center" style={{ background: colors.warning }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: '#fff' }}>{expiringItems.length}</span>
                </div>
              )}
            </button>
            <button onClick={() => setActiveModal('shopping')} className="w-[34px] h-[34px] rounded-full flex items-center justify-center relative" style={{ background: colors.bg }}>
              <ShoppingCart size={16} color={colors.textLight} />
              {shoppingList.filter(i => !i.isChecked).length > 0 && (
                <div className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full flex items-center justify-center" style={{ background: colors.accent }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: '#fff' }}>{shoppingList.filter(i => !i.isChecked).length}</span>
                </div>
              )}
            </button>
          </div>
        </div>

        {/* Week Stats Mini */}
        <div className="flex gap-3 mt-2.5 py-2">
          <div className="flex items-center gap-1">
            <ChefHat size={12} color={colors.success} />
            <span style={{ fontSize: 11, color: colors.textLight }}>自炊率 {stats.cookRate}%</span>
          </div>
          <div className="flex items-center gap-1">
            <Flame size={12} color={colors.accent} />
            <span style={{ fontSize: 11, color: colors.textLight }}>平均 {stats.avgCal}kcal/日</span>
          </div>
        </div>

        {/* Day Tabs */}
        <div className="flex py-0 pb-2.5" style={{ borderBottom: `1px solid ${colors.border}` }}>
          {weekDates.map((day, idx) => {
            const isSelected = idx === selectedDayIndex;
            const isToday = day.dateStr === todayStr;
            const isWeekend = day.date.getDay() === 0 || day.date.getDay() === 6;
            const isPast = day.dateStr < todayStr;
            return (
              <button
                key={day.dateStr}
                onClick={() => setSelectedDayIndex(idx)}
                className="flex-1 flex flex-col items-center gap-0.5 py-1.5 rounded-[10px] transition-all"
                style={{
                  background: isSelected ? colors.accent : 'transparent',
                  border: isToday && !isSelected ? `2px solid ${colors.accent}` : 'none',
                  opacity: isPast && !isSelected ? 0.4 : 1,
                }}
              >
                <span style={{ fontSize: 9, color: isSelected ? 'rgba(255,255,255,0.7)' : colors.textMuted }}>{day.date.getDate()}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: isSelected ? '#fff' : isWeekend ? colors.accent : colors.text }}>{day.dayOfWeek}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* === AI Banner === */}
      {emptySlotCount > 0 && (
        <button
          onClick={() => setActiveModal('ai')}
          className="mx-3 mt-2 px-3.5 py-2.5 rounded-xl flex items-center justify-between"
          style={{ background: colors.accent }}
        >
          <div className="flex items-center gap-2">
            <Sparkles size={16} color="#fff" />
            <span style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>空欄{emptySlotCount}件 → AIに埋めてもらう</span>
          </div>
          <ChevronRight size={16} color="rgba(255,255,255,0.7)" />
        </button>
      )}

      {/* Expiring Items Alert */}
      {expiringItems.filter(i => getDaysUntil(i.expirationDate)! <= 2).length > 0 && (
        <div className="mx-3 mt-2 px-3 py-2 rounded-[10px] flex items-center gap-2" style={{ background: colors.warningLight }}>
          <AlertTriangle size={14} color={colors.warning} />
          <span style={{ fontSize: 11, color: colors.text }}>
            <strong>早めに使い切り:</strong> {expiringItems.filter(i => getDaysUntil(i.expirationDate)! <= 2).map(i => `${i.name}(${getDaysUntil(i.expirationDate)}日)`).join(', ')}
          </span>
        </div>
      )}

      {/* === Main Content === */}
      <main className="flex-1 p-3 overflow-y-auto">
        <div className="flex justify-between items-center mb-2 px-1">
          <div className="flex items-center gap-1.5">
            <span style={{ fontSize: 16, fontWeight: 600, color: colors.text }}>
              {weekDates[selectedDayIndex]?.date.getMonth() + 1}/{weekDates[selectedDayIndex]?.date.getDate()}（{weekDates[selectedDayIndex]?.dayOfWeek}）
            </span>
            {weekDates[selectedDayIndex]?.dateStr === todayStr && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ background: colors.accent, color: '#fff' }}>今日</span>
            )}
          </div>
          <span style={{ fontSize: 12, color: colors.textMuted }}>{getDayTotalCal(currentDay)} kcal</span>
        </div>

        {/* Meal Cards */}
        {(['breakfast', 'lunch', 'dinner'] as MealType[]).map(type => {
          const meal = getMeal(currentDay, type);
          const isPast = weekDates[selectedDayIndex]?.dateStr < todayStr;
          const isExpanded = expandedMeal === type && !isPast && meal;

          if (!meal) return <EmptySlot key={type} mealKey={type} dayIndex={selectedDayIndex} />;
          return isPast ? (
            <CollapsedMealCard key={type} mealKey={type} meal={meal} isPast={true} />
          ) : isExpanded ? (
            <ExpandedMealCard key={type} mealKey={type} meal={meal} />
          ) : (
            <CollapsedMealCard key={type} mealKey={type} meal={meal} isPast={false} />
          );
        })}
      </main>

      {/* ============================================ */}
      {/* === MODALS === */}
      {/* ============================================ */}
      <AnimatePresence>
        {activeModal && (
          <>
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setActiveModal(null)}
              className="fixed inset-0 z-[200]"
              style={{ background: 'rgba(0,0,0,0.5)' }}
            />
            
            {/* AI Assistant Modal */}
            {activeModal === 'ai' && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col"
                style={{ background: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, height: '60%' }}
              >
                <div className="flex justify-between items-center px-4 py-3 flex-shrink-0" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <div className="flex items-center gap-2">
                    <Sparkles size={18} color={colors.accent} />
                    <span style={{ fontSize: 15, fontWeight: 600 }}>AIアシスタント</span>
                  </div>
                  <button onClick={() => setActiveModal(null)} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <div className="flex-1 p-4 overflow-auto">
                  <button
                    onClick={handleGenerateWeekly}
                    disabled={isGenerating}
                    className="w-full p-4 mb-3 rounded-[14px] text-left transition-opacity"
                    style={{ background: colors.accent, opacity: isGenerating ? 0.6 : 1 }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      {isGenerating ? (
                        <div className="w-[18px] h-[18px] border-2 border-white border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <Sparkles size={18} color="#fff" />
                      )}
                      <span style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>
                        {isGenerating ? '生成中...' : '空欄をすべて埋める'}
                      </span>
                    </div>
                    <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', margin: 0 }}>
                      {isGenerating ? 'AIが献立を作成しています...' : `${emptySlotCount}件の空欄にAIが献立を提案します`}
                    </p>
                  </button>
                  <p style={{ fontSize: 11, color: colors.textMuted, margin: '12px 0 8px' }}>条件を指定（複数選択可）</p>
                  {AI_CONDITIONS.map((text, i) => {
                    const isSelected = selectedConditions.includes(text);
                    return (
                      <button 
                        key={i} 
                        onClick={() => setSelectedConditions(prev => isSelected ? prev.filter(c => c !== text) : [...prev, text])}
                        className="w-full p-3 mb-1.5 rounded-[10px] text-left text-[13px] flex items-center justify-between transition-all"
                        style={{ 
                          background: isSelected ? colors.accentLight : colors.bg, 
                          color: isSelected ? colors.accent : colors.text,
                          border: isSelected ? `2px solid ${colors.accent}` : '2px solid transparent'
                        }}
                      >
                        <span>{text}</span>
                        {isSelected && <Check size={16} color={colors.accent} />}
                      </button>
                    );
                  })}
                </div>
                <div className="px-4 py-3 flex gap-2 flex-shrink-0 pb-24 lg:pb-6" style={{ borderTop: `1px solid ${colors.border}`, background: colors.card }}>
                  <input 
                    type="text" 
                    value={aiChatInput}
                    onChange={(e) => setAiChatInput(e.target.value)}
                    placeholder="例: 木金は簡単に..." 
                    className="flex-1 px-3.5 py-2.5 rounded-full text-[13px] outline-none"
                    style={{ background: colors.bg }}
                  />
                  <button 
                    onClick={handleGenerateWeekly}
                    disabled={isGenerating}
                    className="w-11 h-11 rounded-full flex items-center justify-center cursor-pointer hover:opacity-90 transition-opacity" 
                    style={{ background: colors.accent }}
                  >
                    <Send size={16} color="#fff" />
                  </button>
                </div>
              </motion.div>
            )}

            {/* Stats Modal */}
            {activeModal === 'stats' && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col"
                style={{ background: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, height: '55%' }}
              >
                <div className="flex justify-between items-center px-4 py-3" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <div className="flex items-center gap-2">
                    <BarChart3 size={18} color={colors.purple} />
                    <span style={{ fontSize: 15, fontWeight: 600 }}>今週のサマリー</span>
                  </div>
                  <button onClick={() => setActiveModal(null)} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <div className="flex-1 p-4 overflow-auto pb-24 lg:pb-6">
                  <div className="flex gap-2.5 mb-4">
                    <div className="flex-1 rounded-[14px] p-3.5 text-center" style={{ background: colors.successLight }}>
                      <ChefHat size={24} color={colors.success} className="mx-auto mb-1" />
                      <p style={{ fontSize: 24, fontWeight: 700, color: colors.success, margin: 0 }}>{stats.cookRate}%</p>
                      <p style={{ fontSize: 11, color: colors.textLight, margin: '2px 0 0' }}>自炊率</p>
                    </div>
                    <div className="flex-1 rounded-[14px] p-3.5 text-center" style={{ background: colors.accentLight }}>
                      <Flame size={24} color={colors.accent} className="mx-auto mb-1" />
                      <p style={{ fontSize: 24, fontWeight: 700, color: colors.accent, margin: 0 }}>{stats.avgCal}</p>
                      <p style={{ fontSize: 11, color: colors.textLight, margin: '2px 0 0' }}>平均kcal/日</p>
                    </div>
                  </div>
                  <p style={{ fontSize: 13, fontWeight: 600, color: colors.text, margin: '0 0 10px' }}>内訳</p>
                  <div className="flex gap-2 mb-4">
                    {[
                      { label: '自炊', count: stats.cookCount, color: colors.success, bg: colors.successLight },
                      { label: '買う', count: stats.buyCount, color: colors.purple, bg: colors.purpleLight },
                      { label: '外食', count: stats.outCount, color: colors.warning, bg: colors.warningLight },
                    ].map(item => (
                      <div key={item.label} className="flex-1 rounded-[10px] p-2.5 text-center" style={{ background: item.bg }}>
                        <p style={{ fontSize: 18, fontWeight: 600, color: item.color, margin: 0 }}>{item.count}</p>
                        <p style={{ fontSize: 10, color: colors.textLight, margin: '2px 0 0' }}>{item.label}</p>
                      </div>
                    ))}
                  </div>
                  <div className="p-3 rounded-xl" style={{ background: colors.purpleLight }}>
                    <p style={{ fontSize: 12, fontWeight: 600, color: colors.purple, margin: '0 0 4px' }}>💡 ヒント</p>
                    <p style={{ fontSize: 11, color: colors.text, margin: 0, lineHeight: 1.5 }}>
                      今週の自炊率は{stats.cookRate}%です。週末にまとめて作り置きすると、平日の自炊率が上がりますよ！
                    </p>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Fridge Modal */}
            {activeModal === 'fridge' && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col"
                style={{ background: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, height: '70%' }}
              >
                <div className="flex justify-between items-center px-4 py-3" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <div className="flex items-center gap-2">
                    <Refrigerator size={18} color={colors.blue} />
                    <span style={{ fontSize: 15, fontWeight: 600 }}>冷蔵庫</span>
                    <span style={{ fontSize: 11, color: colors.textMuted }}>{fridgeItems.length}品</span>
                  </div>
                  <button onClick={() => setActiveModal(null)} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <div className="flex-1 p-3 overflow-auto">
                  {fridgeItems.length === 0 ? (
                    <p className="text-center py-8" style={{ color: colors.textMuted }}>冷蔵庫は空です</p>
                  ) : (
                    fridgeItems.sort((a, b) => (getDaysUntil(a.expirationDate) || 999) - (getDaysUntil(b.expirationDate) || 999)).map(item => {
                      const daysLeft = getDaysUntil(item.expirationDate);
                      return (
                        <div key={item.id} className="flex items-center justify-between px-3 py-2.5 rounded-[10px] mb-1.5" style={{ 
                          background: daysLeft !== null && daysLeft <= 1 ? colors.dangerLight : daysLeft !== null && daysLeft <= 3 ? colors.warningLight : colors.bg 
                        }}>
                          <div className="flex items-center gap-2.5">
                            <span style={{ fontSize: 14, fontWeight: 500, color: colors.text }}>{item.name}</span>
                            <span style={{ fontSize: 11, color: colors.textMuted }}>{item.amount || ''}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span style={{
                              fontSize: 10,
                              fontWeight: 600,
                              color: daysLeft !== null && daysLeft <= 1 ? colors.danger : daysLeft !== null && daysLeft <= 3 ? colors.warning : colors.textMuted,
                            }}>
                              {daysLeft === null ? '' : daysLeft === 0 ? '今日まで' : daysLeft === 1 ? '明日まで' : `${daysLeft}日`}
                            </span>
                            <button onClick={() => deletePantryItem(item.id)} className="w-6 h-6 rounded-md flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.05)' }}>
                              <Trash2 size={12} color={colors.textMuted} />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
                <div className="px-4 py-2.5 pb-24 lg:pb-6" style={{ borderTop: `1px solid ${colors.border}` }}>
                  <button onClick={() => setActiveModal('addFridge')} className="w-full p-3 rounded-xl flex items-center justify-center gap-1.5" style={{ background: colors.bg, border: `1px dashed ${colors.border}` }}>
                    <Plus size={16} color={colors.textMuted} />
                    <span style={{ fontSize: 13, color: colors.textMuted }}>食材を追加</span>
                  </button>
                </div>
              </motion.div>
            )}

            {/* Add Fridge Item Modal */}
            {activeModal === 'addFridge' && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-0 left-0 right-0 lg:left-64 z-[201] px-4 py-4 pb-28 lg:pb-6"
                style={{ background: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24 }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex justify-between items-center mb-4">
                  <span style={{ fontSize: 15, fontWeight: 600 }}>食材を追加</span>
                  <button onClick={() => setActiveModal('fridge')} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <div className="space-y-3">
                  <input
                    type="text"
                    value={newFridgeName}
                    onChange={(e) => setNewFridgeName(e.target.value)}
                    placeholder="食材名（例: 鶏もも肉）"
                    className="w-full p-3 rounded-xl text-[14px] outline-none"
                    style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
                  />
                  <input
                    type="text"
                    value={newFridgeAmount}
                    onChange={(e) => setNewFridgeAmount(e.target.value)}
                    placeholder="量（例: 300g）"
                    className="w-full p-3 rounded-xl text-[14px] outline-none"
                    style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
                  />
                  <input
                    type="date"
                    value={newFridgeExpiry}
                    onChange={(e) => setNewFridgeExpiry(e.target.value)}
                    className="w-full p-3 rounded-xl text-[14px] outline-none"
                    style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
                  />
                  <button
                    onClick={addPantryItem}
                    disabled={!newFridgeName}
                    className="w-full p-3 rounded-xl font-semibold text-[14px] disabled:opacity-50"
                    style={{ background: colors.accent, color: '#fff' }}
                  >
                    追加する
                  </button>
                </div>
              </motion.div>
            )}

            {/* Shopping List Modal */}
            {activeModal === 'shopping' && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col"
                style={{ background: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, height: '70%' }}
              >
                <div className="flex justify-between items-center px-4 py-3" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <div className="flex items-center gap-2">
                    <ShoppingCart size={18} color={colors.accent} />
                    <span style={{ fontSize: 15, fontWeight: 600 }}>買い物リスト</span>
                    <span style={{ fontSize: 11, color: colors.textMuted }}>{shoppingList.filter(i => !i.isChecked).length}/{shoppingList.length}</span>
                  </div>
                  <button onClick={() => setActiveModal(null)} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <div className="flex-1 p-3 overflow-auto">
                  {shoppingList.length === 0 ? (
                    <p className="text-center py-8" style={{ color: colors.textMuted }}>買い物リストは空です</p>
                  ) : (
                    shoppingList.map(item => (
                      <button
                        key={item.id}
                        onClick={() => toggleShoppingItem(item.id, item.isChecked)}
                        className="w-full flex items-center gap-2.5 p-3 rounded-[10px] mb-1.5 text-left"
                        style={{ background: item.isChecked ? colors.bg : colors.card, border: item.isChecked ? 'none' : `1px solid ${colors.border}` }}
                      >
                        <div className="w-[22px] h-[22px] rounded-full flex items-center justify-center" style={{ 
                          border: item.isChecked ? 'none' : `2px solid ${colors.border}`,
                          background: item.isChecked ? colors.success : 'transparent'
                        }}>
                          {item.isChecked && <Check size={12} color="#fff" />}
                        </div>
                        <span className="flex-1" style={{ fontSize: 14, color: item.isChecked ? colors.textMuted : colors.text, textDecoration: item.isChecked ? 'line-through' : 'none' }}>
                          {item.itemName}
                        </span>
                        <span style={{ fontSize: 12, color: colors.textMuted }}>{item.quantity}</span>
                        <span className="px-1.5 py-0.5 rounded text-[10px]" style={{ color: colors.textMuted, background: colors.bg }}>{item.category || '食材'}</span>
                      </button>
                    ))
                  )}
                </div>
                <div className="px-4 py-2.5 pb-24 lg:pb-6 flex gap-2" style={{ borderTop: `1px solid ${colors.border}` }}>
                  <button onClick={() => setActiveModal('addShopping')} className="flex-1 p-3 rounded-xl flex items-center justify-center gap-1.5" style={{ background: colors.bg, border: `1px dashed ${colors.border}` }}>
                    <Plus size={14} color={colors.textMuted} />
                    <span style={{ fontSize: 12, color: colors.textMuted }}>追加</span>
                  </button>
                  <button onClick={regenerateShoppingList} className="flex-[2] p-3 rounded-xl flex items-center justify-center gap-1.5" style={{ background: colors.accent }}>
                    <RefreshCw size={14} color="#fff" />
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>献立から再生成</span>
                  </button>
                </div>
              </motion.div>
            )}

            {/* Add Shopping Item Modal */}
            {activeModal === 'addShopping' && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-0 left-0 right-0 lg:left-64 z-[201] px-4 py-4 pb-28 lg:pb-6"
                style={{ background: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24 }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex justify-between items-center mb-4">
                  <span style={{ fontSize: 15, fontWeight: 600 }}>買い物リストに追加</span>
                  <button onClick={() => setActiveModal('shopping')} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <div className="space-y-3">
                  <input
                    type="text"
                    value={newShoppingName}
                    onChange={(e) => setNewShoppingName(e.target.value)}
                    placeholder="品名（例: もやし）"
                    className="w-full p-3 rounded-xl text-[14px] outline-none"
                    style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
                  />
                  <input
                    type="text"
                    value={newShoppingAmount}
                    onChange={(e) => setNewShoppingAmount(e.target.value)}
                    placeholder="量（例: 2袋）"
                    className="w-full p-3 rounded-xl text-[14px] outline-none"
                    style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
                  />
                  <select
                    value={newShoppingCategory}
                    onChange={(e) => setNewShoppingCategory(e.target.value)}
                    className="w-full p-3 rounded-xl text-[14px] outline-none"
                    style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
                  >
                    <option value="野菜">野菜</option>
                    <option value="肉">肉</option>
                    <option value="魚">魚</option>
                    <option value="乳製品">乳製品</option>
                    <option value="調味料">調味料</option>
                    <option value="乾物">乾物</option>
                    <option value="食材">その他</option>
                  </select>
                  <button
                    onClick={addShoppingItem}
                    disabled={!newShoppingName}
                    className="w-full p-3 rounded-xl font-semibold text-[14px] disabled:opacity-50"
                    style={{ background: colors.accent, color: '#fff' }}
                  >
                    追加する
                  </button>
                </div>
              </motion.div>
            )}

            {/* Recipe Modal */}
            {activeModal === 'recipe' && selectedRecipe && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col"
                style={{ background: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, height: '75%' }}
              >
                <div className="flex justify-between items-center px-4 py-3" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <div className="flex items-center gap-2">
                    <BookOpen size={18} color={colors.accent} />
                    <span style={{ fontSize: 15, fontWeight: 600 }}>{selectedRecipe}</span>
                  </div>
                  <button onClick={() => { setActiveModal(null); setSelectedRecipe(null); }} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <div className="flex-1 p-4 overflow-auto">
                  <div className="flex gap-4 mb-4">
                    <div className="flex items-center gap-1">
                      <Clock size={14} color={colors.textMuted} />
                      <span style={{ fontSize: 12, color: colors.textLight }}>20分</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Users size={14} color={colors.textMuted} />
                      <span style={{ fontSize: 12, color: colors.textLight }}>2人前</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Flame size={14} color={colors.textMuted} />
                      <span style={{ fontSize: 12, color: colors.textLight }}>{selectedRecipeData?.calories || 350}kcal</span>
                    </div>
                  </div>
                  <p style={{ fontSize: 13, fontWeight: 600, color: colors.text, margin: '0 0 8px' }}>材料</p>
                  <div className="rounded-xl p-3 mb-4" style={{ background: colors.bg }}>
                    <p className="py-1.5" style={{ fontSize: 13, color: colors.text }}>
                      {selectedRecipeData?.ingredient || '材料情報なし'}
                    </p>
                  </div>
                  <p style={{ fontSize: 13, fontWeight: 600, color: colors.text, margin: '0 0 8px' }}>作り方</p>
                  <p style={{ fontSize: 13, color: colors.textMuted }}>レシピの詳細は準備中です</p>
                </div>
                <div className="px-4 py-2.5 pb-24 lg:pb-6 flex gap-2" style={{ borderTop: `1px solid ${colors.border}` }}>
                  <button className="w-11 h-11 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <Heart size={18} color={colors.textMuted} />
                  </button>
                  <button onClick={addRecipeToShoppingList} className="flex-1 p-3 rounded-xl font-semibold text-[14px]" style={{ background: colors.accent, color: '#fff' }}>
                    材料を買い物リストに追加
                  </button>
                </div>
              </motion.div>
            )}

            {/* Add Meal Modal */}
            {activeModal === 'add' && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-0 left-0 right-0 lg:left-64 z-[201] px-4 py-3.5 pb-28 lg:pb-7"
                style={{ background: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24 }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex justify-between items-center mb-3.5">
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{addMealKey && MEAL_LABELS[addMealKey]}を追加</span>
                  <button onClick={() => setActiveModal(null)} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <div className="flex flex-col gap-2">
                  {(Object.entries(MODE_CONFIG) as [MealMode, typeof MODE_CONFIG['cook']][]).filter(([k]) => k !== 'skip').map(([key, mode]) => {
                    const ModeIcon = mode.icon;
                    return (
                      <button 
                        key={key} 
                        onClick={() => handleAddMealWithMode(key)}
                        className="flex items-center gap-2.5 p-3 rounded-[10px]" 
                        style={{ background: mode.bg }}
                      >
                        <ModeIcon size={18} color={mode.color} />
                        <span style={{ fontSize: 13, fontWeight: 500, color: colors.text }}>{mode.label}で追加</span>
                      </button>
                    );
                  })}
                  <button onClick={() => setActiveModal('aiMeal')} className="flex items-center gap-2.5 p-3 rounded-[10px]" style={{ background: colors.accentLight, border: `1px solid ${colors.accent}` }}>
                    <Sparkles size={18} color={colors.accent} />
                    <span style={{ fontSize: 13, fontWeight: 500, color: colors.accent }}>AIに提案してもらう</span>
                  </button>
                </div>
              </motion.div>
            )}

            {/* AI Single Meal Modal */}
            {activeModal === 'aiMeal' && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col"
                style={{ background: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: 'calc(100vh - 200px)' }}
              >
                <div className="flex justify-between items-center px-4 py-3 flex-shrink-0" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <div className="flex items-center gap-2">
                    <Sparkles size={18} color={colors.accent} />
                    <span style={{ fontSize: 15, fontWeight: 600 }}>
                      {weekDates[addMealDayIndex] && `${weekDates[addMealDayIndex].date.getMonth() + 1}/${weekDates[addMealDayIndex].date.getDate()}（${weekDates[addMealDayIndex].dayOfWeek}）`}の{addMealKey && MEAL_LABELS[addMealKey]}
                    </span>
                  </div>
                  <button onClick={() => setActiveModal(null)} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <div className="flex-1 p-4 overflow-auto">
                  <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 12 }}>条件を指定（複数選択可）</p>
                  {AI_CONDITIONS.map((text, i) => {
                    const isSelected = selectedConditions.includes(text);
                    return (
                      <button 
                        key={i} 
                        onClick={() => setSelectedConditions(prev => isSelected ? prev.filter(c => c !== text) : [...prev, text])}
                        className="w-full p-3 mb-1.5 rounded-[10px] text-left text-[13px] flex items-center justify-between transition-all"
                        style={{ 
                          background: isSelected ? colors.accentLight : colors.bg, 
                          color: isSelected ? colors.accent : colors.text,
                          border: isSelected ? `2px solid ${colors.accent}` : '2px solid transparent'
                        }}
                      >
                        <span>{text}</span>
                        {isSelected && <Check size={16} color={colors.accent} />}
                      </button>
                    );
                  })}
                  <div className="mt-4">
                    <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 8 }}>リクエスト（任意）</p>
                    <textarea 
                      value={aiChatInput}
                      onChange={(e) => setAiChatInput(e.target.value)}
                      placeholder="例: 昨日カレーだったので違うものがいい、野菜多めで..."
                      className="w-full p-3 rounded-[10px] text-[13px] outline-none resize-none"
                      style={{ background: colors.bg, minHeight: 80 }}
                    />
                  </div>
                </div>
                <div className="px-4 py-4 pb-24 lg:pb-6 flex-shrink-0" style={{ borderTop: `1px solid ${colors.border}`, background: colors.card }}>
                  <button 
                    onClick={handleGenerateSingleMeal}
                    className="w-full py-3.5 rounded-xl flex items-center justify-center gap-2"
                    style={{ background: colors.accent }}
                  >
                    <Sparkles size={16} color="#fff" />
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>この1食をAIに提案してもらう</span>
                  </button>
                </div>
              </motion.div>
            )}

            {/* Edit Meal Modal */}
            {activeModal === 'editMeal' && editingMeal && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-0 left-0 right-0 lg:left-64 z-[201] px-4 py-4 pb-28 lg:pb-6"
                style={{ background: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24 }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex justify-between items-center mb-4">
                  <span style={{ fontSize: 15, fontWeight: 600 }}>食事を変更</span>
                  <button onClick={() => { setActiveModal(null); setEditingMeal(null); }} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <div className="space-y-3">
                  <div>
                    <label style={{ fontSize: 12, color: colors.textMuted, display: 'block', marginBottom: 4 }}>料理名</label>
                    <input
                      type="text"
                      value={editMealName}
                      onChange={(e) => setEditMealName(e.target.value)}
                      className="w-full p-3 rounded-xl text-[14px] outline-none"
                      style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: colors.textMuted, display: 'block', marginBottom: 4 }}>タイプ</label>
                    <div className="flex flex-wrap gap-2">
                      {(Object.entries(MODE_CONFIG) as [MealMode, typeof MODE_CONFIG['cook']][]).map(([key, mode]) => {
                        const ModeIcon = mode.icon;
                        const isSelected = editMealMode === key;
                        return (
                          <button
                            key={key}
                            onClick={() => setEditMealMode(key)}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg"
                            style={{ 
                              background: isSelected ? mode.bg : colors.bg,
                              border: isSelected ? `2px solid ${mode.color}` : '2px solid transparent'
                            }}
                          >
                            <ModeIcon size={14} color={isSelected ? mode.color : colors.textMuted} />
                            <span style={{ fontSize: 12, color: isSelected ? mode.color : colors.textMuted }}>{mode.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <button
                    onClick={saveEditMeal}
                    className="w-full p-3 rounded-xl font-semibold text-[14px]"
                    style={{ background: colors.accent, color: '#fff' }}
                  >
                    保存する
                  </button>
                </div>
              </motion.div>
            )}
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
