"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { createClient } from "@/lib/supabase/client";
import type { Meal, MealNutritionEstimate, MealAiFeedback } from "@/types/domain";

interface MealDetailData extends Meal {
  nutrition?: MealNutritionEstimate;
  feedback?: MealAiFeedback;
}

export default function MealDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const supabase = createClient();
  const [meal, setMeal] = useState<MealDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'feedback' | 'nutrition'>('feedback');
  const [showMenu, setShowMenu] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      // 1. 食事基本データ取得
      const { data: mealData, error: mealError } = await supabase
        .from('meals')
        .select('*')
        .eq('id', params.id)
        .single();

      if (mealError || !mealData) {
        console.error("Error fetching meal:", mealError);
        // エラー時はホームへ戻すなどの処理が望ましい
        setLoading(false);
        return;
      }

      // 2. 栄養推定データ取得
      const { data: nutritionData } = await supabase
        .from('meal_nutrition_estimates')
        .select('*')
        .eq('meal_id', params.id)
        .single();

      // 3. フィードバックデータ取得
      const { data: feedbackData } = await supabase
        .from('meal_ai_feedbacks')
        .select('*')
        .eq('meal_id', params.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      // マッピング（snake_case -> camelCase）
      // ※本来は型変換ユーティリティを使うべきだが、ここでは手動マッピング
      const mappedMeal: MealDetailData = {
        ...mealData,
        userId: mealData.user_id,
        eatenAt: mealData.eaten_at,
        mealType: mealData.meal_type,
        photoUrl: mealData.photo_url,
        createdAt: mealData.created_at,
        updatedAt: mealData.updated_at,
        nutrition: nutritionData ? {
          ...nutritionData,
          mealId: nutritionData.meal_id,
          energyKcal: nutritionData.energy_kcal,
          proteinG: nutritionData.protein_g,
          fatG: nutritionData.fat_g,
          carbsG: nutritionData.carbs_g,
          vegScore: nutritionData.veg_score,
          qualityTags: nutritionData.quality_tags || [],
        } : undefined,
        feedback: feedbackData ? {
          ...feedbackData,
          mealId: feedbackData.meal_id,
          feedbackText: feedbackData.feedback_text,
          adviceText: feedbackData.advice_text,
          modelName: feedbackData.model_name,
        } : undefined
      };

      setMeal(mappedMeal);
      setLoading(false);
    };

    fetchData();
  }, [params.id]);

  const handleDelete = async () => {
    try {
      const { error } = await supabase
        .from('meals')
        .delete()
        .eq('id', params.id);
      
      if (error) throw error;

      setShowDeleteModal(false);
      // 削除完了演出の後、ホームへ
      setTimeout(() => router.push('/home'), 500);
    } catch (error) {
      alert("削除に失敗しました");
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="w-10 h-10 border-4 border-[#FF8A65] border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!meal) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-white p-4">
        <p className="text-gray-500 mb-4">食事データが見つかりませんでした。</p>
        <Link href="/home">
          <button className="px-6 py-2 bg-[#FF8A65] text-white rounded-full">ホームへ戻る</button>
        </Link>
      </div>
    );
  }

  // 表示用データの整形
  const timeString = new Date(meal.eatenAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const score = meal.nutrition?.vegScore ? meal.nutrition.vegScore * 20 : null; // 5段階を100点満点換算（仮）
  const calories = meal.nutrition?.energyKcal ? Math.round(meal.nutrition.energyKcal) : "---";
  
  return (
    <div className="min-h-screen bg-white pb-20 relative">
      
      {/* ヒーロー画像エリア */}
      <div className="relative h-[40vh] w-full">
        {meal.photoUrl ? (
          <Image 
            src={meal.photoUrl} 
            fill 
            alt="Meal" 
            className="object-cover"
          />
        ) : (
          <div className="w-full h-full bg-gray-200 flex items-center justify-center text-4xl">🍽️</div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
        
        {/* ナビゲーション */}
        <div className="absolute top-0 w-full p-6 flex justify-between items-center z-10">
          <Link href="/home" className="w-10 h-10 rounded-full bg-black/40 backdrop-blur flex items-center justify-center border border-white/20 text-white hover:bg-black/60 transition-colors">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </Link>
          <div className="relative">
            <button 
              onClick={() => setShowMenu(!showMenu)}
              className="w-10 h-10 rounded-full bg-black/40 backdrop-blur flex items-center justify-center border border-white/20 text-white hover:bg-black/60 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" /></svg>
            </button>

            {/* ドロップダウンメニュー */}
            <AnimatePresence>
              {showMenu && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.9, y: 10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9, y: 10 }}
                  className="absolute right-0 top-12 w-48 bg-white rounded-xl shadow-xl border border-gray-100 overflow-hidden z-50 origin-top-right"
                >
                  <button className="w-full text-left px-4 py-3 hover:bg-gray-50 text-sm font-bold text-gray-700 flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                    Edit Meal
                  </button>
                  <div className="h-px bg-gray-100 my-1" />
                  <button 
                    onClick={() => { setShowMenu(false); setShowDeleteModal(true); }}
                    className="w-full text-left px-4 py-3 hover:bg-red-50 text-sm font-bold text-red-500 flex items-center gap-2"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    Delete
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* 基本情報 */}
        <div className="absolute bottom-0 w-full p-6 text-white">
          <div className="flex justify-between items-end mb-2">
             <div>
               <p className="text-sm font-bold opacity-80 uppercase tracking-widest">{meal.mealType}</p>
               <h1 className="text-3xl font-bold">{timeString}</h1>
             </div>
             {score && (
               <div className="text-right">
                 <div className="text-4xl font-black text-[#FF8A65] drop-shadow-lg">{score}</div>
                 <p className="text-xs font-bold opacity-80 uppercase">AI Score</p>
               </div>
             )}
          </div>
          <div className="flex gap-2 mt-4 overflow-x-auto pb-1">
             {meal.nutrition?.qualityTags?.map((tag, i) => (
               <span key={i} className="px-3 py-1 bg-white/20 backdrop-blur rounded-full text-xs font-bold whitespace-nowrap">{tag}</span>
             ))}
          </div>
        </div>
      </div>

      {/* コンテンツエリア */}
      <div className="relative -mt-6 bg-white rounded-t-3xl px-6 pt-8">
        
        {/* メモ表示 */}
        {meal.memo && (
          <div className="mb-6 p-4 bg-gray-50 rounded-xl text-sm text-gray-600 font-medium italic border border-gray-100">
             “ {meal.memo} ”
          </div>
        )}
        
        {/* タブ切り替え */}
        <div className="flex bg-gray-100 p-1 rounded-xl mb-8">
           <button 
             onClick={() => setActiveTab('feedback')}
             className={`flex-1 py-3 rounded-lg text-sm font-bold transition-all ${activeTab === 'feedback' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-400'}`}
           >
             AI Feedback
           </button>
           <button 
             onClick={() => setActiveTab('nutrition')}
             className={`flex-1 py-3 rounded-lg text-sm font-bold transition-all ${activeTab === 'nutrition' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-400'}`}
           >
             Nutrition Data
           </button>
        </div>

        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          {activeTab === 'feedback' ? (
            <div className="space-y-6">
              {meal.feedback ? (
                <>
                  <div className="bg-orange-50 border border-orange-100 p-6 rounded-2xl relative">
                     <div className="absolute -top-3 -left-2 text-4xl text-orange-200">❝</div>
                     <p className="text-gray-700 leading-relaxed font-medium relative z-10 pt-2">
                       {meal.feedback.feedbackText}
                     </p>
                     <div className="mt-4 flex items-center gap-3">
                       <div className="w-8 h-8 rounded-full bg-[#FF8A65] flex items-center justify-center text-white font-bold text-xs">AI</div>
                       <span className="text-xs font-bold text-gray-400">AI Nutritionist</span>
                     </div>
                  </div>

                  {meal.feedback.adviceText && (
                    <div className="bg-blue-50 p-4 rounded-2xl border border-blue-100">
                      <span className="text-2xl mb-2 block">💡</span>
                      <p className="text-xs font-bold text-blue-800 uppercase mb-1">Advice</p>
                      <p className="text-sm font-bold text-gray-700">{meal.feedback.adviceText}</p>
                    </div>
                  )}
                </>
              ) : (
                <div className="text-center text-gray-400 py-8">
                  <p>AIフィードバックはまだありません。<br/>（解析待ちか、エラーが発生しました）</p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-8">
              {/* 簡易的なレーダーチャート風ビジュアル（データがあれば表示） */}
              {meal.nutrition && (
                <div className="relative aspect-square max-w-[240px] mx-auto">
                   <div className="absolute inset-0 rounded-full border border-gray-100" />
                   <div className="absolute inset-4 rounded-full border border-gray-100" />
                   <div className="absolute inset-8 rounded-full border border-gray-100" />
                   
                   {/* 軸 */}
                   <div className="absolute inset-0 flex items-center justify-center">
                      <div className="w-full h-px bg-gray-100 absolute" />
                      <div className="h-full w-px bg-gray-100 absolute" />
                      <div className="w-full h-px bg-gray-100 absolute rotate-45" />
                      <div className="h-full w-px bg-gray-100 absolute rotate-45" />
                   </div>

                   {/* データポリゴン（※静的モック表示のまま。動的描画は複雑なため） */}
                   <div className="absolute inset-0 flex items-center justify-center">
                      <div className="w-3/4 h-3/4 bg-[#FF8A65]/20 border-2 border-[#FF8A65] rounded-full blur-[2px]" 
                           style={{ clipPath: 'polygon(50% 0%, 90% 20%, 100% 60%, 75% 100%, 25% 100%, 0% 60%, 10% 20%)' }}
                      />
                   </div>
                   
                   <span className="absolute -top-6 left-1/2 -translate-x-1/2 text-xs font-bold text-gray-400">VITAMIN</span>
                   <span className="absolute top-1/4 -right-8 text-xs font-bold text-gray-400">PROTEIN</span>
                   <span className="absolute bottom-1/4 -right-8 text-xs font-bold text-gray-400">FAT</span>
                   <span className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-xs font-bold text-gray-400">CARBS</span>
                   <span className="absolute bottom-1/4 -left-10 text-xs font-bold text-gray-400">MINERAL</span>
                   <span className="absolute top-1/4 -left-8 text-xs font-bold text-gray-400">FIBER</span>
                </div>
              )}

              <div className="space-y-4">
                 <div className="flex justify-between items-center border-b border-gray-100 pb-3">
                   <span className="font-bold text-gray-500">Energy</span>
                   <span className="font-bold text-xl text-gray-900">{calories} <span className="text-sm font-normal text-gray-400">kcal</span></span>
                 </div>
                 <div className="flex justify-between items-center border-b border-gray-100 pb-3">
                   <span className="font-bold text-gray-500">Protein</span>
                   <span className="font-bold text-xl text-gray-900">{meal.nutrition?.proteinG || '-'} <span className="text-sm font-normal text-gray-400">g</span></span>
                 </div>
                 <div className="flex justify-between items-center border-b border-gray-100 pb-3">
                   <span className="font-bold text-gray-500">Fat</span>
                   <span className="font-bold text-xl text-gray-900">{meal.nutrition?.fatG || '-'} <span className="text-sm font-normal text-gray-400">g</span></span>
                 </div>
                 <div className="flex justify-between items-center border-b border-gray-100 pb-3">
                   <span className="font-bold text-gray-500">Carbs</span>
                   <span className="font-bold text-xl text-gray-900">{meal.nutrition?.carbsG || '-'} <span className="text-sm font-normal text-gray-400">g</span></span>
                 </div>
              </div>
            </div>
          )}
        </motion.div>
      </div>

      {/* 削除確認モーダル */}
      <AnimatePresence>
        {showDeleteModal && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-white rounded-3xl p-6 w-full max-w-sm text-center shadow-2xl"
            >
              <div className="w-16 h-16 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-4 text-3xl">
                🗑
              </div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">Delete this meal?</h3>
              <p className="text-gray-500 mb-8 text-sm leading-relaxed">
                この操作は取り消せません。<br/>
                解析データと獲得ポイントも削除されます。
              </p>
              <div className="flex gap-4">
                <button 
                  onClick={() => setShowDeleteModal(false)}
                  className="flex-1 py-3 rounded-full font-bold text-gray-600 hover:bg-gray-100 transition-colors"
                >
                  Cancel
                </button>
                <button 
                  onClick={handleDelete}
                  className="flex-1 py-3 rounded-full bg-red-500 text-white font-bold hover:bg-red-600 transition-colors shadow-lg shadow-red-200"
                >
                  Delete
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
