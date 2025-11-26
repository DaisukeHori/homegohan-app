"use client";

import React, { useState, useEffect, useCallback } from 'react';
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
}

export const WeeklyMealPlanner = ({ mealPlan, onUpdateMeal }: WeeklyMealPlannerProps) => {
  const [selectedDayIndex, setSelectedDayIndex] = useState(0);
  const [expandedMeal, setExpandedMeal] = useState<MealType>('dinner');
  const [activeModal, setActiveModal] = useState<ModalType>(null);
  
  // Data States
  const [fridgeItems, setFridgeItems] = useState<PantryItem[]>([]); 
  const [shoppingList, setShoppingList] = useState<ShoppingListItem[]>(mealPlan.shoppingList || []);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
  
  // Form States
  const [newItemName, setNewItemName] = useState("");
  const [newItemAmount, setNewItemAmount] = useState("");
  const [newItemCategory, setNewItemCategory] = useState("other");
  const [newItemDate, setNewItemDate] = useState("");

  // Initialize selected day
  useEffect(() => {
    const today = new Date().toISOString().split('T')[0];
    const idx = mealPlan.days?.findIndex(d => d.dayDate === today);
    if (idx !== undefined && idx !== -1) setSelectedDayIndex(idx);
  }, [mealPlan]);

  // Fetch Data on Mount
  useEffect(() => {
    fetchPantryItems();
    fetchRecipes();
  }, []);

  // API Calls
  const fetchPantryItems = async () => {
    try {
      const res = await fetch('/api/pantry');
      if (res.ok) {
        const data = await res.json();
        setFridgeItems(data.items);
      }
    } catch (e) {
      console.error("Failed to fetch pantry:", e);
    }
  };

  const fetchRecipes = async () => {
    try {
      const res = await fetch('/api/recipes');
      if (res.ok) {
        const data = await res.json();
        setRecipes(data.recipes);
      }
    } catch (e) {
      console.error("Failed to fetch recipes:", e);
    }
  };

  const addPantryItem = async () => {
    if (!newItemName) return;
    try {
      const res = await fetch('/api/pantry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newItemName,
          amount: newItemAmount,
          category: newItemCategory,
          expirationDate: newItemDate || null
        })
      });
      if (res.ok) {
        const { item } = await res.json();
        setFridgeItems(prev => [...prev, item]);
        setNewItemName("");
        setNewItemAmount("");
        setNewItemDate("");
      }
    } catch (e) {
      alert("追加に失敗しました");
    }
  };

  const deletePantryItem = async (id: string) => {
    try {
      await fetch(`/api/pantry/${id}`, { method: 'DELETE' });
      setFridgeItems(prev => prev.filter(i => i.id !== id));
    } catch (e) {
      alert("削除に失敗しました");
    }
  };

  const addShoppingItem = async () => {
    if (!newItemName) return;
    try {
      const res = await fetch('/api/shopping-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mealPlanId: mealPlan.id,
          itemName: newItemName,
          quantity: newItemAmount,
          category: newItemCategory
        })
      });
      if (res.ok) {
        const { item } = await res.json();
        setShoppingList(prev => [...prev, item]);
        setNewItemName("");
        setNewItemAmount("");
      }
    } catch (e) {
      alert("追加に失敗しました");
    }
  };

  const toggleShoppingItem = async (id: string, currentChecked: boolean) => {
    // Optimistic Update
    setShoppingList(prev => prev.map(i => i.id === id ? { ...i, isChecked: !currentChecked } : i));
    try {
      await fetch(`/api/shopping-list/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isChecked: !currentChecked })
      });
    } catch (e) {
      // Revert if failed
      setShoppingList(prev => prev.map(i => i.id === id ? { ...i, isChecked: currentChecked } : i));
    }
  };

  const deleteShoppingItem = async (id: string) => {
    setShoppingList(prev => prev.filter(i => i.id !== id));
    try {
      await fetch(`/api/shopping-list/${id}`, { method: 'DELETE' });
    } catch (e) {
      // Revert logic needed or just ignore
    }
  };

  const handleMealComplete = async (dayId: string, mealId: string, isCompleted: boolean) => {
    onUpdateMeal(dayId, mealId, { isCompleted });
    try {
      await fetch(`/api/meal-plans/meals/${mealId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isCompleted })
      });
    } catch (e) {
      console.error("Failed to update meal status:", e);
    }
  };

  // --- Computed Data ---
  const currentDay = mealPlan.days?.[selectedDayIndex];
  if (!currentDay) return <div>Loading...</div>;

  const getMeal = (day: MealPlanDay, type: MealType) => {
    return day.meals?.find(m => m.mealType === type);
  };

  const getMealStats = () => {
    let cookCount = 0, buyCount = 0, outCount = 0, totalCal = 0;
    mealPlan.days?.forEach(day => {
      day.meals?.forEach(meal => {
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
  const expiringItems = fridgeItems.filter(i => i.expirationDate && new Date(i.expirationDate) <= new Date(new Date().setDate(new Date().getDate() + 3)));

  // --- Render Components ---

  const EmptySlot = ({ type }: { type: MealType }) => (
    <div
      className="w-full flex items-center justify-center gap-2 bg-white border-2 border-dashed border-gray-200 rounded-2xl p-5 mb-2"
    >
      <span className="text-sm text-gray-400">{MEAL_LABELS[type]}なし</span>
    </div>
  );

  const MealCard = ({ type, meal }: { type: MealType, meal: PlannedMeal }) => {
    const isExpanded = expandedMeal === type;
    const mode = MODE_CONFIG['cook'];
    const ModeIcon = mode.icon;

    if (!isExpanded) {
      return (
        <div className="flex items-center gap-2 mb-2">
          <button
            onClick={() => handleMealComplete(currentDay.id, meal.id, !meal.isCompleted)}
            className={cn(
              "w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 border-2 transition-colors",
              meal.isCompleted ? "bg-green-500 border-green-500" : "bg-transparent border-gray-200 hover:border-green-400"
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
              <span className={cn("text-sm text-gray-600 truncate max-w-[150px]", meal.isCompleted && "line-through")}>
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

    return (
      <div className="bg-white rounded-3xl p-4 mb-2 shadow-sm flex flex-col">
        <div className="flex justify-between items-center mb-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => handleMealComplete(currentDay.id, meal.id, !meal.isCompleted)}
              className={cn(
                "w-7 h-7 rounded-full flex items-center justify-center border-2 transition-colors",
                meal.isCompleted ? "bg-green-500 border-green-500" : "bg-transparent border-gray-200"
              )}
            >
              {meal.isCompleted && <Check size={14} className="text-white" />}
            </button>
            <span className="text-base font-bold text-gray-900">{MEAL_LABELS[type]}</span>
          </div>
          <span className="text-sm text-gray-400">{meal.caloriesKcal || '-'} kcal</span>
        </div>

        <div className="flex gap-4">
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

          <div className="flex-1 min-w-0">
            <p className="text-base font-bold text-gray-800 mb-1">{meal.dishName}</p>
            <p className="text-xs text-gray-500 leading-relaxed line-clamp-2">{meal.description}</p>
            
            <div className="flex gap-2 mt-2">
              <span className="text-[10px] bg-gray-50 text-gray-500 px-2 py-0.5 rounded">P: {meal.proteinG || '-'}g</span>
              <span className="text-[10px] bg-gray-50 text-gray-500 px-2 py-0.5 rounded">F: {meal.fatG || '-'}g</span>
              <span className="text-[10px] bg-gray-50 text-gray-500 px-2 py-0.5 rounded">C: {meal.carbsG || '-'}g</span>
            </div>
          </div>
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
              {expiringItems.length > 0 && (
                <div className="absolute -top-1 -right-1 w-4 h-4 bg-orange-500 rounded-full flex items-center justify-center text-[9px] font-bold text-white">{expiringItems.length}</div>
              )}
            </button>
            <button onClick={() => setActiveModal('shopping')} className="w-9 h-9 rounded-full bg-gray-50 flex items-center justify-center hover:bg-gray-100 relative">
              <ShoppingCart size={18} className="text-gray-500" />
              <div className="absolute -top-1 -right-1 w-4 h-4 bg-blue-500 rounded-full flex items-center justify-center text-[9px] font-bold text-white">
                {shoppingList.filter(i => !i.isChecked).length}
              </div>
            </button>
          </div>
        </div>

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
              </button>
            );
          })}
        </div>
      </div>

      {/* --- Main Content --- */}
      <div className="flex-1 p-4 overflow-y-auto">
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
              <div className="px-5 py-4 border-b border-gray-100 flex justify-between items-center bg-white">
                <h3 className="font-bold text-lg flex items-center gap-2">
                  {activeModal === 'fridge' && '冷蔵庫管理'}
                  {activeModal === 'shopping' && '買い物リスト'}
                  {activeModal === 'stats' && '週間サマリー'}
                </h3>
                <button onClick={() => setActiveModal(null)} className="p-2 bg-gray-50 rounded-full hover:bg-gray-100">
                  <X size={16} className="text-gray-500" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-5">
                {activeModal === 'shopping' && (
                  <>
                    <div className="flex gap-2 mb-4">
                      <input 
                        value={newItemName}
                        onChange={(e) => setNewItemName(e.target.value)}
                        placeholder="アイテム名"
                        className="flex-1 p-2 border rounded-lg"
                      />
                      <input 
                        value={newItemAmount}
                        onChange={(e) => setNewItemAmount(e.target.value)}
                        placeholder="量"
                        className="w-20 p-2 border rounded-lg"
                      />
                      <button onClick={addShoppingItem} className="bg-blue-500 text-white p-2 rounded-lg">
                        <Plus size={20} />
                      </button>
                    </div>
                    <div className="space-y-3">
                      {shoppingList.map(item => (
                        <div key={item.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                          <button 
                            onClick={() => toggleShoppingItem(item.id, item.isChecked)}
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
                          <button onClick={() => deleteShoppingItem(item.id)} className="text-gray-400 hover:text-red-500">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {activeModal === 'fridge' && (
                  <>
                    <div className="flex gap-2 mb-4">
                      <input 
                        value={newItemName}
                        onChange={(e) => setNewItemName(e.target.value)}
                        placeholder="食材名"
                        className="flex-1 p-2 border rounded-lg"
                      />
                      <input 
                        type="date"
                        value={newItemDate}
                        onChange={(e) => setNewItemDate(e.target.value)}
                        className="w-32 p-2 border rounded-lg"
                      />
                      <button onClick={addPantryItem} className="bg-orange-500 text-white p-2 rounded-lg">
                        <Plus size={20} />
                      </button>
                    </div>
                    <div className="space-y-3">
                      {fridgeItems.map(item => (
                        <div key={item.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
                          <div>
                            <p className="font-medium">{item.name}</p>
                            <p className="text-xs text-gray-500">期限: {item.expirationDate || 'なし'}</p>
                          </div>
                          <button onClick={() => deletePantryItem(item.id)} className="text-gray-400 hover:text-red-500">
                            <Trash2 size={16} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {activeModal === 'stats' && (
                  <div className="space-y-6">
                    <div className="flex gap-4">
                      <div className="flex-1 bg-green-50 p-4 rounded-2xl text-center">
                        <p className="text-2xl font-black text-green-700">{stats.cookRate}%</p>
                        <p className="text-xs text-green-600 font-bold">自炊率</p>
                      </div>
                      <div className="flex-1 bg-orange-50 p-4 rounded-2xl text-center">
                        <p className="text-2xl font-black text-orange-700">{stats.avgCal}</p>
                        <p className="text-xs text-orange-600 font-bold">平均kcal</p>
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
