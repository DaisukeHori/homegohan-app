"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { createClient } from "@/lib/supabase/client";
import { ChefHat, Store, UtensilsCrossed, Zap, Check, X } from 'lucide-react';

interface PlannedMealWithUser {
  id: string;
  dish_name: string;
  meal_type: string;
  mode: string;
  image_url: string | null;
  is_completed: boolean;
  created_at: string;
  calories_kcal: number | null;
  user_id: string;
  user_daily_meals: {
    day_date: string;
  } | null;
  user_profiles: {
    nickname: string | null;
  } | null;
}

const MODE_ICONS: Record<string, typeof ChefHat> = {
  cook: ChefHat,
  quick: Zap,
  buy: Store,
  out: UtensilsCrossed,
};

const MODE_COLORS: Record<string, string> = {
  cook: 'text-green-600 bg-green-50',
  quick: 'text-blue-600 bg-blue-50',
  buy: 'text-purple-600 bg-purple-50',
  out: 'text-orange-600 bg-orange-50',
};

export default function ModerationPage() {
  const [meals, setMeals] = useState<PlannedMealWithUser[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  const fetchMeals = async () => {
    setLoading(true);
    
    // planned_mealsをJOINして取得（日付ベースモデル）
    const { data, error } = await supabase
      .from('planned_meals')
      .select(`
        id,
        dish_name,
        meal_type,
        mode,
        image_url,
        is_completed,
        created_at,
        calories_kcal,
        user_id,
        user_daily_meals(day_date),
        user_profiles:user_id(nickname)
      `)
      .order('created_at', { ascending: false })
      .limit(50);
    
    if (error) {
      console.error('Error fetching meals:', error);
    } else if (data) {
      setMeals(data as unknown as PlannedMealWithUser[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchMeals();
  }, []);

  const handleDelete = async (id: string) => {
    if (!confirm("本当に削除しますか？この操作は取り消せません。")) return;
    
    const { error } = await supabase.from('planned_meals').delete().eq('id', id);
    if (error) {
      alert("削除に失敗しました");
    } else {
      setMeals(prev => prev.filter(m => m.id !== id));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">献立一覧（モデレーション）</h1>
        <button 
          onClick={fetchMeals} 
          className="px-4 py-2 bg-gray-100 rounded-lg hover:bg-gray-200 text-sm font-bold transition-colors"
        >
          更新
        </button>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400">読み込み中...</div>
      ) : meals.length === 0 ? (
        <div className="text-center py-12 text-gray-400">献立データがありません</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {meals.map((meal) => {
            const ModeIcon = MODE_ICONS[meal.mode] || ChefHat;
            const modeColor = MODE_COLORS[meal.mode] || 'text-gray-600 bg-gray-50';
            const nickname = meal.user_profiles?.nickname || 'Unknown';
            const dayDate = meal.user_daily_meals?.day_date || '';
            
            return (
              <div key={meal.id} className="bg-white rounded-xl overflow-hidden shadow-sm border border-gray-100 group">
                <div className="relative h-40 bg-gray-100">
                  {meal.image_url ? (
                    <Image src={meal.image_url} fill alt={meal.dish_name} className="object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <ModeIcon size={48} className="text-gray-300" />
                    </div>
                  )}
                  
                  {/* 完了バッジ */}
                  {meal.is_completed && (
                    <div className="absolute top-2 left-2 bg-green-500 text-white text-xs font-bold px-2 py-1 rounded-full flex items-center gap-1">
                      <Check size={12} />
                      完了
                    </div>
                  )}
                  
                  {/* 削除ボタン */}
                  <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button 
                      onClick={() => handleDelete(meal.id)}
                      className="bg-red-500 text-white text-xs font-bold px-3 py-1.5 rounded-full shadow-lg hover:bg-red-600 flex items-center gap-1"
                    >
                      <X size={12} />
                      削除
                    </button>
                  </div>
                </div>
                
                <div className="p-4">
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-400 font-medium mb-1">
                        {dayDate} • {new Date(meal.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </p>
                      <p className="font-bold text-gray-900 truncate">{meal.dish_name}</p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={`text-xs px-2 py-1 rounded font-bold uppercase ${modeColor}`}>
                        {meal.meal_type}
                      </span>
                    </div>
                  </div>
                  
                  <div className="flex justify-between items-center">
                    <p className="text-xs text-gray-500">
                      User: <span className="font-bold text-gray-700">{nickname}</span>
                    </p>
                    <div className={`flex items-center gap-1 px-2 py-0.5 rounded ${modeColor}`}>
                      <ModeIcon size={12} />
                      <span className="text-xs font-bold">{meal.mode}</span>
                    </div>
                  </div>
                  
                  {meal.calories_kcal && (
                    <p className="text-xs text-gray-400 mt-2">
                      {meal.calories_kcal} kcal
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
