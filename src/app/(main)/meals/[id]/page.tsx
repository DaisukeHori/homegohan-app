"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { createClient } from "@/lib/supabase/client";
import { 
  ChefHat, Store, UtensilsCrossed, Zap, FastForward,
  Check, Flame, Clock, Users, ChevronLeft, MoreVertical,
  Trash2, Edit, Coffee, Sun, Moon, X
} from 'lucide-react';

// カラーパレット
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
};

type MealMode = 'cook' | 'quick' | 'buy' | 'out' | 'skip';
type MealType = 'breakfast' | 'lunch' | 'dinner';

const MODE_CONFIG: Record<MealMode, { icon: typeof ChefHat; label: string; color: string; bg: string }> = {
  cook: { icon: ChefHat, label: '自炊', color: colors.success, bg: colors.successLight },
  quick: { icon: Zap, label: '時短', color: colors.blue, bg: colors.blueLight },
  buy: { icon: Store, label: '買う', color: colors.purple, bg: colors.purpleLight },
  out: { icon: UtensilsCrossed, label: '外食', color: colors.warning, bg: colors.warningLight },
  skip: { icon: FastForward, label: 'なし', color: colors.textMuted, bg: colors.bg },
};

const MEAL_CONFIG: Record<MealType, { icon: typeof Coffee; label: string; color: string }> = {
  breakfast: { icon: Coffee, label: '朝食', color: colors.warning },
  lunch: { icon: Sun, label: '昼食', color: colors.accent },
  dinner: { icon: Moon, label: '夕食', color: colors.purple },
};

interface DishDetail {
  name: string;
  role: string;
  cal?: number;
  ingredients?: string;
}

interface PlannedMealDetail {
  id: string;
  mealPlanDayId: string;
  mealType: MealType;
  mode: MealMode;
  dishName: string;
  description: string | null;
  recipeUrl: string | null;
  imageUrl: string | null;
  ingredients: string[] | null;
  caloriesKcal: number | null;
  proteinG: number | null;
  fatG: number | null;
  carbsG: number | null;
  isCompleted: boolean;
  completedAt: string | null;
  dishes: DishDetail[] | null;
  isSimple: boolean;
  cookingTimeMinutes: number | null;
  dayDate: string;
}

export default function MealDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const supabase = createClient();
  const [meal, setMeal] = useState<PlannedMealDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [showMenu, setShowMenu] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      
      // planned_mealsとmeal_plan_daysをJOINして取得
      const { data, error } = await supabase
        .from('planned_meals')
        .select(`
          *,
          meal_plan_days!inner(day_date)
        `)
        .eq('id', params.id)
        .single();

      if (error || !data) {
        console.error("Error fetching meal:", error);
        setLoading(false);
        return;
      }

      const mappedMeal: PlannedMealDetail = {
        id: data.id,
        mealPlanDayId: data.meal_plan_day_id,
        mealType: data.meal_type as MealType,
        mode: (data.mode || 'cook') as MealMode,
        dishName: data.dish_name,
        description: data.description,
        recipeUrl: data.recipe_url,
        imageUrl: data.image_url,
        ingredients: data.ingredients,
        caloriesKcal: data.calories_kcal,
        proteinG: data.protein_g,
        fatG: data.fat_g,
        carbsG: data.carbs_g,
        isCompleted: data.is_completed || false,
        completedAt: data.completed_at,
        dishes: data.dishes,
        isSimple: data.is_simple,
        cookingTimeMinutes: data.cooking_time_minutes,
        dayDate: data.meal_plan_days.day_date,
      };

      setMeal(mappedMeal);
      setLoading(false);
    };

    fetchData();
  }, [params.id]);

  const toggleCompletion = async () => {
    if (!meal) return;
    const newStatus = !meal.isCompleted;
    
    setMeal({ ...meal, isCompleted: newStatus, completedAt: newStatus ? new Date().toISOString() : null });

    await supabase
      .from('planned_meals')
      .update({
        is_completed: newStatus,
        completed_at: newStatus ? new Date().toISOString() : null,
      })
      .eq('id', meal.id);
  };

  const handleDelete = async () => {
    try {
      const { error } = await supabase
        .from('planned_meals')
        .delete()
        .eq('id', params.id);
      
      if (error) throw error;

      setShowDeleteModal(false);
      setTimeout(() => router.push('/menus/weekly'), 300);
    } catch (error) {
      alert("削除に失敗しました");
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: colors.bg }}>
        <div className="w-10 h-10 border-4 border-accent border-t-transparent rounded-full animate-spin" style={{ borderColor: colors.accent, borderTopColor: 'transparent' }}></div>
      </div>
    );
  }

  if (!meal) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4" style={{ background: colors.bg }}>
        <p className="text-gray-500 mb-4">食事データが見つかりませんでした。</p>
        <Link href="/menus/weekly">
          <button className="px-6 py-2 rounded-full text-white font-bold" style={{ background: colors.accent }}>献立表へ戻る</button>
        </Link>
      </div>
    );
  }

  const mealConfig = MEAL_CONFIG[meal.mealType];
  const modeConfig = MODE_CONFIG[meal.mode];
  const ModeIcon = modeConfig.icon;
  const MealIcon = mealConfig.icon;

  const formattedDate = new Date(meal.dayDate).toLocaleDateString('ja-JP', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });

  return (
    <div className="min-h-screen pb-20" style={{ background: colors.bg }}>
      
      {/* ヒーロー画像エリア */}
      <div className="relative h-[35vh] w-full">
        {meal.imageUrl ? (
          <Image 
            src={meal.imageUrl} 
            fill 
            alt={meal.dishName} 
            className="object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-6xl" style={{ background: modeConfig.bg }}>
            <ModeIcon size={64} color={modeConfig.color} />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/30" />
        
        {/* ナビゲーション */}
        <div className="absolute top-0 w-full p-5 flex justify-between items-center z-10">
          <button 
            onClick={() => router.back()}
            className="w-10 h-10 rounded-full bg-black/40 backdrop-blur flex items-center justify-center border border-white/20 text-white hover:bg-black/60 transition-colors"
          >
            <ChevronLeft size={24} />
          </button>
          <div className="relative">
            <button 
              onClick={() => setShowMenu(!showMenu)}
              className="w-10 h-10 rounded-full bg-black/40 backdrop-blur flex items-center justify-center border border-white/20 text-white hover:bg-black/60 transition-colors"
            >
              <MoreVertical size={20} />
            </button>

            <AnimatePresence>
              {showMenu && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.9, y: 10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9, y: 10 }}
                  className="absolute right-0 top-12 w-44 bg-white rounded-xl shadow-xl border border-gray-100 overflow-hidden z-50"
                >
                  <Link href={`/menus/weekly`}>
                    <button className="w-full text-left px-4 py-3 hover:bg-gray-50 text-sm font-bold text-gray-700 flex items-center gap-2">
                      <Edit size={16} />
                      編集する
                    </button>
                  </Link>
                  <div className="h-px bg-gray-100" />
                  <button 
                    onClick={() => { setShowMenu(false); setShowDeleteModal(true); }}
                    className="w-full text-left px-4 py-3 hover:bg-red-50 text-sm font-bold text-red-500 flex items-center gap-2"
                  >
                    <Trash2 size={16} />
                    削除する
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* 基本情報 */}
        <div className="absolute bottom-0 w-full p-5 text-white">
          <div className="flex items-center gap-2 mb-2">
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full" style={{ background: modeConfig.bg }}>
              <ModeIcon size={14} color={modeConfig.color} />
              <span className="text-xs font-bold" style={{ color: modeConfig.color }}>{modeConfig.label}</span>
            </div>
            <span className="text-xs text-white/70">{formattedDate}</span>
            <span className="text-xs font-bold" style={{ color: mealConfig.color }}>{mealConfig.label}</span>
          </div>
          <h1 className="text-2xl font-bold mb-1">{meal.dishName}</h1>
          {meal.description && (
            <p className="text-sm text-white/80 line-clamp-2">{meal.description}</p>
          )}
        </div>
      </div>

      {/* コンテンツエリア */}
      <div className="relative -mt-4 bg-white rounded-t-3xl px-5 pt-6">
        
        {/* 完了ボタン */}
        <button
          onClick={toggleCompletion}
          className={`w-full py-3.5 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all mb-6 ${
            meal.isCompleted 
              ? 'bg-gray-100 text-gray-500' 
              : 'text-white'
          }`}
          style={{ background: meal.isCompleted ? undefined : colors.success }}
        >
          {meal.isCompleted ? (
            <>
              <Check size={18} />
              完了済み（タップで取り消し）
            </>
          ) : (
            <>
              <Check size={18} />
              食べた！
            </>
          )}
        </button>

        {/* 栄養情報 */}
        <div className="mb-6">
          <h3 className="text-sm font-bold text-gray-900 mb-3">栄養情報</h3>
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: 'カロリー', value: meal.caloriesKcal || '-', unit: 'kcal', color: colors.accent, bg: colors.accentLight },
              { label: 'タンパク質', value: meal.proteinG || '-', unit: 'g', color: colors.success, bg: colors.successLight },
              { label: '脂質', value: meal.fatG || '-', unit: 'g', color: colors.warning, bg: colors.warningLight },
              { label: '炭水化物', value: meal.carbsG || '-', unit: 'g', color: colors.purple, bg: colors.purpleLight },
            ].map((item, i) => (
              <div key={i} className="p-3 rounded-xl text-center" style={{ background: item.bg }}>
                <p className="text-lg font-bold" style={{ color: item.color }}>{item.value}</p>
                <p className="text-[10px] text-gray-500">{item.unit}</p>
                <p className="text-[10px] text-gray-400 mt-0.5">{item.label}</p>
              </div>
            ))}
          </div>
        </div>

        {/* 調理情報（自炊の場合） */}
        {(meal.mode === 'cook' || meal.mode === 'quick') && (
          <div className="mb-6">
            <h3 className="text-sm font-bold text-gray-900 mb-3">調理情報</h3>
            <div className="flex gap-4">
              {meal.cookingTimeMinutes && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: colors.blueLight }}>
                  <Clock size={16} color={colors.blue} />
                  <span className="text-sm font-medium" style={{ color: colors.blue }}>{meal.cookingTimeMinutes}分</span>
                </div>
              )}
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: colors.successLight }}>
                <Users size={16} color={colors.success} />
                <span className="text-sm font-medium" style={{ color: colors.success }}>1人前</span>
              </div>
            </div>
          </div>
        )}

        {/* おかず一覧（複数ある場合） */}
        {meal.dishes && meal.dishes.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-bold text-gray-900 mb-3">メニュー構成</h3>
            <div className="space-y-2">
              {meal.dishes.map((dish, i) => (
                <div key={i} className="flex items-center justify-between p-3 rounded-xl bg-gray-50">
                  <div className="flex items-center gap-3">
                    <span className="text-xs px-2 py-1 rounded bg-gray-200 text-gray-600 font-bold">
                      {dish.role === 'main' ? '主菜' : dish.role === 'soup' ? '汁物' : '副菜'}
                    </span>
                    <span className="text-sm font-medium text-gray-900">{dish.name}</span>
                  </div>
                  {dish.calories_kcal && (
                    <span className="text-xs text-gray-500">{dish.calories_kcal} kcal</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 材料（あれば） */}
        {meal.ingredients && meal.ingredients.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-bold text-gray-900 mb-3">材料</h3>
            <div className="flex flex-wrap gap-2">
              {meal.ingredients.map((ing, i) => (
                <span key={i} className="px-3 py-1.5 rounded-full bg-gray-100 text-xs font-medium text-gray-700">
                  {ing}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* レシピリンク */}
        {meal.recipeUrl && (
          <a 
            href={meal.recipeUrl} 
            target="_blank" 
            rel="noopener noreferrer"
            className="block w-full py-3.5 rounded-xl font-bold text-sm text-center border-2 mb-6 transition-all hover:bg-gray-50"
            style={{ borderColor: colors.accent, color: colors.accent }}
          >
            レシピを見る →
          </a>
        )}
      </div>

      {/* 削除確認モーダル */}
      <AnimatePresence>
        {showDeleteModal && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-white rounded-3xl p-6 w-full max-w-sm text-center shadow-2xl"
            >
              <div className="w-16 h-16 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-4">
                <Trash2 size={28} color="#ef4444" />
              </div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">この献立を削除しますか？</h3>
              <p className="text-gray-500 mb-6 text-sm">
                この操作は取り消せません。
              </p>
              <div className="flex gap-3">
                <button 
                  onClick={() => setShowDeleteModal(false)}
                  className="flex-1 py-3 rounded-full font-bold text-gray-600 hover:bg-gray-100 transition-colors"
                >
                  キャンセル
                </button>
                <button 
                  onClick={handleDelete}
                  className="flex-1 py-3 rounded-full bg-red-500 text-white font-bold hover:bg-red-600 transition-colors"
                >
                  削除する
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
