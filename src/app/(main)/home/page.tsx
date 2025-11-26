"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { motion, AnimatePresence } from "framer-motion";
import { useHomeData } from "@/hooks/useHomeData";
import { Icons } from "@/components/icons";
import { 
  ChefHat, Store, UtensilsCrossed, Zap, FastForward,
  Check, Flame, Calendar, Coffee, Sun, Moon, Sparkles,
  ChevronRight, TrendingUp
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

export default function HomePage() {
  const {
    user,
    todayPlan,
    loading,
    dailySummary,
    announcement,
    activityLevel,
    suggestion,
    toggleMealCompletion,
    updateActivityLevel,
    setAnnouncement,
    setSuggestion,
  } = useHomeData();

  const [showSummary, setShowSummary] = useState(false);

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 5) return "こんばんは";
    if (hour < 11) return "おはようございます";
    if (hour < 17) return "こんにちは";
    return "こんばんは";
  };

  const completionRate = dailySummary.totalCount > 0 
    ? Math.round((dailySummary.completedCount / dailySummary.totalCount) * 100) 
    : 0;

  return (
    <div className="min-h-screen pb-24 lg:pb-12 relative overflow-hidden" style={{ background: colors.bg }}>
      
      {/* 背景装飾 */}
      <div className="absolute top-0 left-0 w-full h-56 lg:h-72 bg-gradient-to-br from-gray-900 to-gray-800 rounded-b-[40px] lg:rounded-b-[60px] z-0" />
      
      <div className="relative z-10 px-5 pt-12 lg:px-12 lg:pt-16 max-w-5xl mx-auto">
        
        {/* ヘッダーエリア */}
        <div className="flex justify-between items-start mb-8 text-white">
          <div>
            <p className="text-sm font-medium opacity-70 mb-1">
              {new Date().toLocaleDateString('ja-JP', { weekday: 'long', month: 'long', day: 'numeric' })}
            </p>
            <h1 className="text-2xl lg:text-3xl font-bold leading-tight">
              {getGreeting()}、<br className="lg:hidden"/>
              <span className="text-accent">{user?.nickname || user?.email?.split('@')[0] || 'ゲスト'}</span> さん
            </h1>
          </div>
          
          <Link href="/profile">
            <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur border border-white/30 flex items-center justify-center font-bold text-lg hover:bg-white/30 transition-colors cursor-pointer">
              {user?.email?.[0].toUpperCase() || 'G'}
            </div>
          </Link>
        </div>

        {/* お知らせ */}
        <AnimatePresence>
          {announcement && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="mb-6"
            >
              <div className="bg-white/95 backdrop-blur-md p-4 rounded-2xl shadow-sm border border-white/50 flex items-start gap-3">
                <span className="text-xl">📢</span>
                <div className="flex-1">
                  <p className="text-sm font-bold text-gray-800">{announcement.title}</p>
                  <p className="text-xs text-gray-600 mt-0.5">{announcement.content}</p>
                </div>
                <button onClick={() => setAnnouncement(null)} className="text-gray-400 hover:text-gray-600 p-1">
                  <Icons.Close className="w-4 h-4" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* コンディション入力 */}
        <div className="mb-6">
          <div className="bg-white/10 backdrop-blur-md rounded-2xl p-1 border border-white/20">
            <div className="flex gap-1">
              {[
                { id: 'rest', label: '休息日', icon: '🛋️' },
                { id: 'normal', label: '通常', icon: '🚶' },
                { id: 'active', label: '活動的', icon: '🔥' },
                { id: 'stressed', label: 'ストレス', icon: '🤯' }
              ].map((item) => (
                <button
                  key={item.id}
                  onClick={() => updateActivityLevel(item.id)}
                  className={`flex-1 px-3 py-2.5 rounded-xl flex items-center justify-center gap-1.5 transition-all ${
                    activityLevel === item.id 
                      ? 'bg-white text-gray-900 shadow-md' 
                      : 'text-white/80 hover:bg-white/20'
                  }`}
                >
                  <span className="text-base">{item.icon}</span>
                  <span className="text-xs font-bold hidden sm:inline">{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* AIサジェスト */}
        <AnimatePresence mode="wait">
          {suggestion && (
            <motion.div
              key="suggestion"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="mb-6"
            >
              <div className="bg-accent text-white p-4 rounded-2xl shadow-lg flex items-start gap-3 relative overflow-hidden">
                <div className="absolute top-0 right-0 p-3 opacity-10 text-5xl">🤖</div>
                <Sparkles size={18} className="flex-shrink-0 mt-0.5" />
                <div className="flex-1 relative z-10">
                  <p className="text-xs font-bold text-white/80 mb-0.5">AIアドバイス</p>
                  <p className="text-sm font-medium leading-relaxed">{suggestion}</p>
                </div>
                <button onClick={() => setSuggestion(null)} className="text-white/60 hover:text-white">
                  <Icons.Close className="w-4 h-4" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* メインコンテンツ */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* 今日の献立 */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-3xl p-5 shadow-sm">
              <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-2">
                  <Calendar size={18} color={colors.accent} />
                  <h2 className="font-bold text-gray-900">今日の献立</h2>
                </div>
                <Link href="/menus/weekly" className="text-xs text-accent font-bold flex items-center gap-1 hover:underline">
                  献立表を見る <ChevronRight size={14} />
                </Link>
              </div>

              {loading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="h-20 bg-gray-100 rounded-xl animate-pulse" />
                  ))}
                </div>
              ) : todayPlan && todayPlan.meals.length > 0 ? (
                <div className="space-y-3">
                  {(['breakfast', 'lunch', 'dinner'] as MealType[]).map((mealType) => {
                    const meal = todayPlan.meals.find(m => m.mealType === mealType);
                    const mealConfig = MEAL_CONFIG[mealType];
                    const MealIcon = mealConfig.icon;
                    
                    if (!meal) {
                      return (
                        <Link key={mealType} href="/menus/weekly">
                          <div className="p-4 rounded-xl border-2 border-dashed border-gray-200 flex items-center justify-between hover:border-gray-300 transition-colors">
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center">
                                <MealIcon size={18} color={colors.textMuted} />
                              </div>
                              <span className="text-sm text-gray-400">{mealConfig.label}を追加</span>
                            </div>
                            <Icons.Plus className="w-5 h-5 text-gray-300" />
                          </div>
                        </Link>
                      );
                    }

                    const modeConfig = MODE_CONFIG[meal.mode as MealMode] || MODE_CONFIG.cook;
                    const ModeIcon = modeConfig.icon;

                    return (
                      <motion.div
                        key={mealType}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={`p-4 rounded-xl transition-all ${meal.isCompleted ? 'bg-gray-50' : 'bg-white border border-gray-100'}`}
                      >
                        <div className="flex items-center gap-3">
                          {/* 完了チェック */}
                          <button
                            onClick={() => toggleMealCompletion(meal.id, meal.isCompleted)}
                            className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-all"
                            style={{
                              border: meal.isCompleted ? 'none' : `2px solid ${colors.border}`,
                              background: meal.isCompleted ? colors.success : 'transparent',
                            }}
                          >
                            {meal.isCompleted && <Check size={16} color="#fff" />}
                          </button>

                          {/* 画像 */}
                          <div className="w-14 h-14 rounded-xl overflow-hidden bg-gray-100 flex-shrink-0">
                            {meal.imageUrl ? (
                              <Image src={meal.imageUrl} width={56} height={56} alt={meal.dishName} className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center">
                                <MealIcon size={20} color={colors.textMuted} />
                              </div>
                            )}
                          </div>

                          {/* 情報 */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-xs font-bold" style={{ color: mealConfig.color }}>{mealConfig.label}</span>
                              <div className="flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ background: modeConfig.bg }}>
                                <ModeIcon size={10} color={modeConfig.color} />
                                <span className="text-[10px] font-bold" style={{ color: modeConfig.color }}>{modeConfig.label}</span>
                              </div>
                            </div>
                            <p className={`text-sm font-medium truncate ${meal.isCompleted ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                              {meal.dishName}
                            </p>
                          </div>

                          {/* カロリー */}
                          <div className="text-right flex-shrink-0">
                            <p className="text-sm font-bold text-gray-900">{meal.caloriesKcal || '-'}</p>
                            <p className="text-[10px] text-gray-400">kcal</p>
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-8">
                  <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-3">
                    <Calendar size={28} color={colors.textMuted} />
                  </div>
                  <p className="text-sm text-gray-500 mb-4">今日の献立がまだありません</p>
                  <Link href="/menus/weekly">
                    <button className="px-6 py-2.5 rounded-full bg-accent text-white text-sm font-bold hover:bg-accent/90 transition-colors">
                      献立を作成する
                    </button>
                  </Link>
                </div>
              )}
            </div>

            {/* クイックアクション */}
            <div className="grid grid-cols-2 gap-3 mt-4">
              <Link href="/meals/new">
                <div className="bg-white rounded-2xl p-4 shadow-sm hover:shadow-md transition-all flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: colors.accentLight }}>
                    <Icons.Camera className="w-5 h-5" style={{ color: colors.accent }} />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-gray-900">食事を記録</p>
                    <p className="text-[10px] text-gray-400">写真から入力</p>
                  </div>
                </div>
              </Link>
              <Link href="/menus/weekly">
                <div className="bg-white rounded-2xl p-4 shadow-sm hover:shadow-md transition-all flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: colors.purpleLight }}>
                    <Sparkles className="w-5 h-5" style={{ color: colors.purple }} />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-gray-900">AI献立</p>
                    <p className="text-[10px] text-gray-400">1週間分を生成</p>
                  </div>
                </div>
              </Link>
            </div>
          </div>

          {/* サマリーカード */}
          <div className="lg:col-span-1">
            <div 
              onClick={() => setShowSummary(true)}
              className="bg-white rounded-3xl p-5 shadow-sm cursor-pointer hover:shadow-md transition-all"
            >
              <div className="flex justify-between items-center mb-4">
                <h2 className="font-bold text-gray-900 flex items-center gap-2">
                  <TrendingUp size={16} color={colors.accent} />
                  今日の進捗
                </h2>
                <span className="text-xs text-accent font-bold">詳細 →</span>
              </div>

              {/* 円形プログレス */}
              <div className="flex flex-col items-center mb-4">
                <div className="relative w-32 h-32">
                  <svg className="w-full h-full transform -rotate-90">
                    <circle cx="50%" cy="50%" r="45%" stroke="#f3f4f6" strokeWidth="10%" fill="none" />
                    <motion.circle 
                      cx="50%" cy="50%" r="45%" 
                      stroke={colors.accent}
                      strokeWidth="10%" 
                      fill="none" 
                      strokeDasharray="283"
                      strokeDashoffset={283 - (283 * completionRate / 100)} 
                      strokeLinecap="round"
                      initial={{ strokeDashoffset: 283 }}
                      animate={{ strokeDashoffset: 283 - (283 * completionRate / 100) }}
                      transition={{ duration: 1, ease: "easeOut" }}
                    />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-3xl font-black text-gray-900">{completionRate}%</span>
                    <span className="text-xs text-gray-400">完了</span>
                  </div>
                </div>
              </div>

              {/* 統計 */}
              <div className="space-y-2">
                <div className="flex justify-between items-center p-2.5 rounded-lg" style={{ background: colors.accentLight }}>
                  <div className="flex items-center gap-2">
                    <Flame size={14} color={colors.accent} />
                    <span className="text-xs font-medium text-gray-600">カロリー</span>
                  </div>
                  <span className="text-sm font-bold" style={{ color: colors.accent }}>{dailySummary.totalCalories} kcal</span>
                </div>
                <div className="flex justify-between items-center p-2.5 rounded-lg" style={{ background: colors.successLight }}>
                  <div className="flex items-center gap-2">
                    <ChefHat size={14} color={colors.success} />
                    <span className="text-xs font-medium text-gray-600">自炊</span>
                  </div>
                  <span className="text-sm font-bold" style={{ color: colors.success }}>{dailySummary.cookCount}食</span>
                </div>
                <div className="flex justify-between items-center p-2.5 rounded-lg" style={{ background: colors.purpleLight }}>
                  <div className="flex items-center gap-2">
                    <Store size={14} color={colors.purple} />
                    <span className="text-xs font-medium text-gray-600">買う/外食</span>
                  </div>
                  <span className="text-sm font-bold" style={{ color: colors.purple }}>{dailySummary.buyCount + dailySummary.outCount}食</span>
                </div>
              </div>
            </div>

            {/* ヒント */}
            <div className="mt-4 bg-white/80 backdrop-blur border border-gray-100 p-4 rounded-2xl">
              <div className="flex gap-3 items-start">
                <span className="text-xl">💡</span>
                <p className="text-xs text-gray-600 leading-relaxed">
                  {dailySummary.completedCount === 0 
                    ? "まずは朝食から始めましょう！完了したらチェックを入れてね。" 
                    : dailySummary.completedCount === dailySummary.totalCount
                    ? "今日の食事は全て完了！お疲れ様でした 🎉"
                    : "良い調子です！残りの食事も頑張りましょう。"}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 詳細サマリーモーダル */}
      <AnimatePresence>
        {showSummary && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSummary(false)}
              className="fixed inset-0 bg-black/60 z-[60] backdrop-blur-sm"
            />
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="fixed bottom-0 left-0 right-0 lg:left-auto lg:right-8 lg:bottom-8 lg:w-[400px] lg:rounded-3xl bg-white rounded-t-3xl z-[61] max-h-[80vh] overflow-y-auto shadow-2xl"
            >
              <div className="p-6 pb-10">
                <div className="w-12 h-1 bg-gray-200 rounded-full mx-auto mb-6 lg:hidden" />
                
                <div className="flex justify-between items-center mb-6">
                  <h2 className="text-xl font-bold text-gray-900">今日のサマリー</h2>
                  <button onClick={() => setShowSummary(false)} className="p-2 bg-gray-100 rounded-full hover:bg-gray-200 transition-colors">
                    <Icons.Close className="w-5 h-5 text-gray-600" />
                  </button>
                </div>
                
                {/* 進捗 */}
                <div className="flex items-center gap-4 mb-6 p-4 rounded-2xl" style={{ background: colors.accentLight }}>
                  <div className="relative w-16 h-16">
                    <svg className="w-full h-full transform -rotate-90">
                      <circle cx="50%" cy="50%" r="40%" stroke="#fff" strokeWidth="12%" fill="none" />
                      <circle 
                        cx="50%" cy="50%" r="40%" 
                        stroke={colors.accent}
                        strokeWidth="12%" 
                        fill="none" 
                        strokeDasharray="251"
                        strokeDashoffset={251 - (251 * completionRate / 100)} 
                        strokeLinecap="round"
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-lg font-black" style={{ color: colors.accent }}>{completionRate}%</span>
                    </div>
                  </div>
                  <div>
                    <p className="text-sm font-bold text-gray-900">食事完了率</p>
                    <p className="text-xs text-gray-500">{dailySummary.completedCount} / {dailySummary.totalCount} 食完了</p>
                  </div>
                </div>

                {/* 詳細統計 */}
                <div className="space-y-3">
                  <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">詳細</h3>
                  {[
                    { label: "総カロリー", value: `${dailySummary.totalCalories} kcal`, icon: Flame, color: colors.accent, bg: colors.accentLight },
                    { label: "自炊", value: `${dailySummary.cookCount}食`, icon: ChefHat, color: colors.success, bg: colors.successLight },
                    { label: "買う", value: `${dailySummary.buyCount}食`, icon: Store, color: colors.purple, bg: colors.purpleLight },
                    { label: "外食", value: `${dailySummary.outCount}食`, icon: UtensilsCrossed, color: colors.warning, bg: colors.warningLight },
                  ].map((item, i) => {
                    const Icon = item.icon;
                    return (
                      <div key={i} className="flex justify-between items-center p-3 rounded-xl" style={{ background: item.bg }}>
                        <div className="flex items-center gap-2">
                          <Icon size={16} color={item.color} />
                          <span className="text-sm font-medium text-gray-700">{item.label}</span>
                        </div>
                        <span className="text-sm font-bold" style={{ color: item.color }}>{item.value}</span>
                      </div>
                    );
                  })}
                </div>

                <button 
                  onClick={() => setShowSummary(false)} 
                  className="w-full mt-6 py-3.5 rounded-full bg-gray-900 text-white font-bold hover:bg-black transition-colors"
                >
                  閉じる
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
