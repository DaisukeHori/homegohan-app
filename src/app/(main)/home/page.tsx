"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { motion, AnimatePresence } from "framer-motion";
import { useHomeData } from "@/hooks/useHomeData";
import { Icons } from "@/components/icons";
import { 
  ChefHat, Store, UtensilsCrossed, Zap, FastForward,
  Check, Flame, Calendar, Coffee, Sun, Moon, Sparkles,
  ChevronRight, TrendingUp, TrendingDown, ShoppingCart, Trophy, AlertTriangle,
  Camera, Clock, Target, Award, Refrigerator, X, Scale, Heart, Activity
} from 'lucide-react';

// カラーパレット
const colors = {
  bg: '#FAF9F7',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textLight: '#4A4A4A',
  textMuted: '#9A9A9A',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  accentDark: '#C4634C',
  success: '#4CAF50',
  successLight: '#E8F5E9',
  warning: '#FF9800',
  warningLight: '#FFF3E0',
  error: '#F44336',
  purple: '#7C4DFF',
  purpleLight: '#EDE7F6',
  blue: '#2196F3',
  blueLight: '#E3F2FD',
  border: '#EEEEEE',
  streak: '#FF6B35',
};

type MealMode = 'cook' | 'quick' | 'buy' | 'out' | 'skip';
type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'midnight_snack';

const MODE_CONFIG: Record<MealMode, { icon: typeof ChefHat; label: string; color: string; bg: string }> = {
  cook: { icon: ChefHat, label: '自炊', color: colors.success, bg: colors.successLight },
  quick: { icon: Zap, label: '時短', color: colors.blue, bg: colors.blueLight },
  buy: { icon: Store, label: '買う', color: colors.purple, bg: colors.purpleLight },
  out: { icon: UtensilsCrossed, label: '外食', color: colors.warning, bg: colors.warningLight },
  skip: { icon: FastForward, label: 'なし', color: colors.textMuted, bg: colors.bg },
};

const MEAL_CONFIG: Record<string, { icon: typeof Coffee; label: string; color: string; time: string }> = {
  breakfast: { icon: Coffee, label: '朝食', color: '#FF9800', time: '7:00' },
  lunch: { icon: Sun, label: '昼食', color: '#4CAF50', time: '12:00' },
  dinner: { icon: Moon, label: '夕食', color: '#7C4DFF', time: '19:00' },
  snack: { icon: Coffee, label: 'おやつ', color: '#E91E63', time: '15:00' },
  midnight_snack: { icon: Moon, label: '夜食', color: '#3F51B5', time: '22:00' },
};

// 現在の時間帯を取得
const getCurrentMealType = (): MealType => {
  const hour = new Date().getHours();
  if (hour < 10) return 'breakfast';
  if (hour < 14) return 'lunch';
  if (hour < 17) return 'snack';
  if (hour < 21) return 'dinner';
  return 'midnight_snack';
};

export default function HomePage() {
  // Hydration 対応: new Date() 系は CSR のみで評価する
  const [clientDate, setClientDate] = useState<string>('');
  const [greeting, setGreeting] = useState<string>('');
  const [currentMealTypeState, setCurrentMealTypeState] = useState<MealType>('breakfast');
  const [todayISODate, setTodayISODate] = useState<string>('');

  useEffect(() => {
    const now = new Date();
    setClientDate(now.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }));
    setTodayISODate(now.toISOString().split('T')[0]);
    const hour = now.getHours();
    if (hour < 5) setGreeting('おやすみなさい');
    else if (hour < 11) setGreeting('おはようございます');
    else if (hour < 17) setGreeting('こんにちは');
    else setGreeting('こんばんは');
    setCurrentMealTypeState(getCurrentMealType());
  }, []);

  const {
    user,
    todayPlan,
    loading,
    dailySummary,
    announcement,
    activityLevel,
    suggestion,
    cookingStreak,
    weeklyStats,
    monthlyStats,
    expiringItems,
    shoppingRemaining,
    badgeCount,
    latestBadge,
    bestMealThisWeek,
    healthSummary,
    nutritionAnalysis,
    performanceAnalysis,
    toggleMealCompletion,
    updateActivityLevel,
    setAnnouncement,
    setSuggestion,
    executeNutritionSuggestion,
    submitPerformanceCheckin,
  } = useHomeData();

  const [showWeeklyDetail, setShowWeeklyDetail] = useState(false);

  // #199: Escape キーで週間統計モーダルを閉じる
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showWeeklyDetail) {
        setShowWeeklyDetail(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showWeeklyDetail]);

  const [showCheckin, setShowCheckin] = useState(false);
  const [checkinSubmitting, setCheckinSubmitting] = useState(false);
  const [checkinFeedback, setCheckinFeedback] = useState<
    { type: 'success' | 'error'; message: string } | null
  >(null);
  const [checkinForm, setCheckinForm] = useState({
    sleepHours: 7,
    sleepQuality: 3,
    fatigue: 3,
    focus: 3,
    hunger: 3,
  });

  // チェックインのフィードバックは数秒で自動的にフェードアウト
  useEffect(() => {
    if (!checkinFeedback) return;
    const timer = setTimeout(() => setCheckinFeedback(null), 4000);
    return () => clearTimeout(timer);
  }, [checkinFeedback]);

  const completionRate = dailySummary.totalCount > 0
    ? Math.round((dailySummary.completedCount / dailySummary.totalCount) * 100)
    : 0;

  const nextMeal = todayPlan?.meals.find(m =>
    !m.isCompleted && (m.mealType === currentMealTypeState ||
      ['breakfast', 'lunch', 'dinner'].indexOf(m.mealType) > ['breakfast', 'lunch', 'dinner'].indexOf(currentMealTypeState))
  );

  return (
    <div className="min-h-screen pb-24 lg:pb-8" style={{ background: colors.bg }}>
      
      {/* ========== ヒーローセクション ========== */}
      <div className="relative overflow-hidden">
        {/* グラデーション背景 */}
        <div className="absolute inset-0 bg-gradient-to-br from-orange-50 via-amber-50 to-rose-50" />
        <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-orange-200/30 to-transparent rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-0 w-48 h-48 bg-gradient-to-tr from-rose-200/30 to-transparent rounded-full blur-3xl" />
        
        <div className="relative px-5 pt-10 pb-6 lg:px-12 lg:pt-12 max-w-5xl mx-auto">
          {/* 日付 & プロフィール */}
          <div className="flex justify-between items-start mb-6">
            <div>
              <p className="text-sm font-medium text-gray-500 mb-1" suppressHydrationWarning>
                {clientDate}
              </p>
              <h1 className="text-2xl lg:text-3xl font-bold text-gray-900">
                {user === null ? (
                  <span className="text-gray-400">読み込み中...</span>
                ) : (
                  <><span suppressHydrationWarning>{greeting}</span>、<span style={{ color: colors.accent }}>{user.nickname || 'ゲスト'}</span>さん</>
                )}
              </h1>
            </div>
            <Link href="/profile">
              <div className="w-12 h-12 rounded-full bg-white shadow-md flex items-center justify-center font-bold text-lg text-gray-700 hover:shadow-lg transition-shadow cursor-pointer border border-gray-100">
                {user?.email?.[0].toUpperCase() || 'G'}
              </div>
            </Link>
          </div>

          {/* ストリーク & 月間統計 */}
          <div className="flex gap-3 mb-4">
            {/* ストリーク */}
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="flex-1 bg-white rounded-2xl p-4 shadow-sm border border-orange-100"
            >
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${colors.streak} 0%, #FF8F5C 100%)` }}>
                  <Flame size={24} color="#fff" />
                </div>
                <div>
                  <p className="text-xs text-gray-500 font-medium">連続自炊</p>
                  <p className="text-2xl font-black" style={{ color: colors.streak }}>
                    {cookingStreak}<span className="text-sm font-bold ml-0.5">日</span>
                  </p>
                </div>
              </div>
            </motion.div>

            {/* 今月の自炊 */}
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.1 }}
              className="flex-1 bg-white rounded-2xl p-4 shadow-sm border border-green-100"
            >
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${colors.success} 0%, #66BB6A 100%)` }}>
                  <ChefHat size={24} color="#fff" />
                </div>
                <div>
                  <p className="text-xs text-gray-500 font-medium">今月の自炊</p>
                  <p className="text-2xl font-black" style={{ color: colors.success }}>
                    {monthlyStats.cookCount}<span className="text-sm font-bold ml-0.5">食</span>
                  </p>
                </div>
              </div>
            </motion.div>
          </div>

          {/* 健康記録サマリー */}
          <Link href="/health" prefetch={false}>
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.15 }}
              className="mb-4 bg-white rounded-2xl p-4 shadow-sm border border-purple-100 hover:shadow-md transition-shadow"
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Activity size={18} style={{ color: colors.purple }} />
                  <span className="font-semibold text-sm" style={{ color: colors.text }}>健康記録</span>
                  {healthSummary.hasAlert && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-600">
                      要確認
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 text-xs" style={{ color: colors.purple }}>
                  詳細を見る <ChevronRight size={14} />
                </div>
              </div>
              
              <div className="grid grid-cols-3 gap-3">
                {/* 体重 */}
                <div className="text-center">
                  <div className="flex items-center justify-center gap-1 mb-1">
                    <Scale size={14} style={{ color: colors.accent }} />
                    <span className="text-xs" style={{ color: colors.textMuted }}>体重</span>
                  </div>
                  <p className="text-lg font-bold" style={{ color: colors.text }}>
                    {healthSummary.latestWeight ? `${healthSummary.latestWeight}` : '-'}
                    <span className="text-xs font-normal ml-0.5">kg</span>
                  </p>
                  {healthSummary.weightChange !== null && (
                    <div className="flex items-center justify-center gap-0.5">
                      {healthSummary.weightChange < 0 ? (
                        <TrendingDown size={12} style={{ color: colors.success }} />
                      ) : healthSummary.weightChange > 0 ? (
                        <TrendingUp size={12} style={{ color: colors.error }} />
                      ) : null}
                      <span 
                        className="text-xs"
                        style={{ 
                          color: healthSummary.weightChange < 0 ? colors.success : 
                                 healthSummary.weightChange > 0 ? colors.error : colors.textMuted 
                        }}
                      >
                        {healthSummary.weightChange > 0 ? '+' : ''}{healthSummary.weightChange}
                      </span>
                    </div>
                  )}
                </div>

                {/* 連続記録 */}
                <div className="text-center">
                  <div className="flex items-center justify-center gap-1 mb-1">
                    <Flame size={14} style={{ color: colors.streak }} />
                    <span className="text-xs" style={{ color: colors.textMuted }}>連続</span>
                  </div>
                  <p className="text-lg font-bold" style={{ color: colors.text }}>
                    {healthSummary.healthStreak}
                    <span className="text-xs font-normal ml-0.5">日</span>
                  </p>
                </div>

                {/* 目標まで */}
                <div className="text-center">
                  <div className="flex items-center justify-center gap-1 mb-1">
                    <Target size={14} style={{ color: colors.success }} />
                    <span className="text-xs" style={{ color: colors.textMuted }}>目標まで</span>
                  </div>
                  {healthSummary.latestWeight && healthSummary.targetWeight ? (
                    <p className="text-lg font-bold" style={{ color: colors.text }}>
                      {(healthSummary.latestWeight - healthSummary.targetWeight).toFixed(1)}
                      <span className="text-xs font-normal ml-0.5">kg</span>
                    </p>
                  ) : (
                    <p className="text-lg font-bold" style={{ color: colors.textMuted }}>-</p>
                  )}
                </div>
              </div>

              {/* 今日の記録ステータス */}
              {!healthSummary.todayRecord && (
                <div 
                  className="mt-3 pt-3 border-t flex items-center justify-center gap-2"
                  style={{ borderColor: colors.border }}
                >
                  <span className="text-xs" style={{ color: colors.accent }}>
                    📝 今日の記録がまだありません
                  </span>
                </div>
              )}
            </motion.div>
          </Link>

          {/* 栄養スコア */}
          {nutritionAnalysis && nutritionAnalysis.score > 0 && (
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.2 }}
              className="mb-4 bg-white rounded-2xl p-4 shadow-sm border border-green-100"
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <TrendingUp size={18} style={{ color: colors.success }} />
                  <span className="font-semibold text-sm" style={{ color: colors.text }}>今日の栄養スコア</span>
                </div>
                <div 
                  className="px-3 py-1 rounded-full text-sm font-bold"
                  style={{ 
                    background: nutritionAnalysis.score >= 80 ? colors.successLight : 
                               nutritionAnalysis.score >= 60 ? colors.warningLight : '#FFEBEE',
                    color: nutritionAnalysis.score >= 80 ? colors.success : 
                           nutritionAnalysis.score >= 60 ? colors.warning : colors.error,
                  }}
                >
                  {nutritionAnalysis.score}点
                </div>
              </div>

              {/* 主要栄養素のバー */}
              <div className="grid grid-cols-4 gap-2 mb-3">
                {[
                  { key: 'calories', label: 'カロリー', color: colors.accent },
                  { key: 'protein', label: 'タンパク質', color: colors.success },
                  { key: 'fat', label: '脂質', color: colors.warning },
                  { key: 'carbs', label: '炭水化物', color: colors.blue },
                ].map(item => {
                  const data = nutritionAnalysis.comparison[item.key];
                  const percentage = data ? Math.min(data.percentage, 100) : 0;
                  return (
                    <div key={item.key} className="text-center">
                      <div className="text-[10px] font-medium" style={{ color: colors.textMuted }}>{item.label}</div>
                      <div className="h-1.5 bg-gray-100 rounded-full mt-1 overflow-hidden">
                        <div 
                          className="h-full rounded-full transition-all duration-500"
                          style={{ width: `${percentage}%`, background: item.color }}
                        />
                      </div>
                      <div className="text-[10px] mt-0.5" style={{ color: colors.textLight }}>{percentage}%</div>
                    </div>
                  );
                })}
              </div>

              {/* 課題がある場合 */}
              {nutritionAnalysis.issues.length > 0 && (
                <div className="bg-amber-50 rounded-lg p-2 text-xs" style={{ color: colors.warning }}>
                  <div className="flex items-start gap-1.5">
                    <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                    <span>{nutritionAnalysis.issues[0]}</span>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* お知らせ */}
          <AnimatePresence>
            {announcement && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="mb-4"
              >
                <div className="bg-blue-50 border border-blue-100 p-3 rounded-xl flex items-start gap-3">
                  <span className="text-lg">📢</span>
                  <div className="flex-1">
                    <p className="text-sm font-bold text-blue-900">{announcement.title}</p>
                    <p className="text-xs text-blue-700 mt-0.5">{announcement.content}</p>
                  </div>
                  <button onClick={() => setAnnouncement(null)} className="text-blue-400 hover:text-blue-600 p-1">
                    <X size={16} />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="px-5 lg:px-12 max-w-5xl mx-auto mt-4">
        
        {/* ========== 今日のコンディション ========== */}
        <div className="mb-6">
          <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">今日のコンディション</p>
          <div className="bg-white rounded-2xl p-1 shadow-sm border border-gray-100">
            <div className="flex gap-1">
              {[
                { id: 'rest', label: '休息日', icon: '🛋️', color: colors.blue },
                { id: 'normal', label: '通常', icon: '🚶', color: colors.textLight },
                { id: 'active', label: '活動的', icon: '🔥', color: colors.warning },
                { id: 'stressed', label: 'ストレス', icon: '🤯', color: colors.purple }
              ].map((item) => (
                <button
                  key={item.id}
                  onClick={() => updateActivityLevel(item.id)}
                  className={`flex-1 px-2 py-2.5 rounded-xl flex items-center justify-center gap-1.5 transition-all ${
                    activityLevel === item.id 
                      ? 'bg-gray-900 text-white shadow-md' 
                      : 'text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  <span className="text-base">{item.icon}</span>
                  <span className="text-xs font-bold hidden sm:inline">{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ========== Performance OS v3: 次の一手 + 30秒チェックイン ========== */}
        {/* チェックイン送信後のフィードバック (Bug-9) */}
        <AnimatePresence>
          {checkinFeedback && (
            <motion.div
              key="checkin-feedback"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              role="status"
              aria-live="polite"
              data-testid="checkin-feedback"
              className="mb-4 rounded-2xl p-3 flex items-center gap-2 border"
              style={{
                background:
                  checkinFeedback.type === 'success'
                    ? colors.successLight
                    : '#FFEBEE',
                borderColor:
                  checkinFeedback.type === 'success'
                    ? colors.success
                    : colors.error,
                color:
                  checkinFeedback.type === 'success'
                    ? colors.success
                    : colors.error,
              }}
            >
              <span className="text-sm font-bold">
                {checkinFeedback.message}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
        {/* 次の一手（分析が有効な場合） */}
        {performanceAnalysis?.nextAction && (
          <div className="mb-6">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-4"
            >
              <div className="bg-gradient-to-r from-purple-500 to-indigo-500 text-white p-4 rounded-2xl shadow-lg relative overflow-hidden">
                <div className="absolute top-0 right-0 w-24 h-24 bg-white/10 rounded-full -translate-y-1/2 translate-x-1/2" />
                <div className="flex items-start gap-3">
                  <Target size={18} className="flex-shrink-0 mt-0.5" />
                  <div className="flex-1 relative z-10">
                    <p className="text-xs font-bold text-white/80 mb-0.5">🎯 今日の次の一手</p>
                    <p className="text-sm font-medium leading-relaxed">
                      {performanceAnalysis.nextAction.actionType === 'increase_calories' && 'カロリーを少し増やしましょう'}
                      {performanceAnalysis.nextAction.actionType === 'decrease_calories' && 'カロリーを少し減らしましょう'}
                      {performanceAnalysis.nextAction.actionType === 'increase_protein' && 'タンパク質を増やしましょう'}
                      {performanceAnalysis.nextAction.actionType === 'increase_carbs' && '炭水化物を増やしましょう'}
                      {performanceAnalysis.nextAction.actionType === 'improve_sleep' && '睡眠の質を改善しましょう'}
                      {performanceAnalysis.nextAction.actionType === 'reduce_fatigue' && '疲労回復を優先しましょう'}
                      {performanceAnalysis.nextAction.actionType === 'maintain' && '現状を維持しましょう'}
                    </p>
                    <p className="text-xs text-white/70 mt-1">{performanceAnalysis.nextAction.reason}</p>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {/* 30秒チェックイン or 完了メッセージ */}
        <div className="mb-6">
          {/* 30秒チェックイン（未完了の場合） */}
          {!performanceAnalysis?.todayCheckin && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-white rounded-2xl p-4 shadow-sm border border-purple-100"
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Activity size={16} style={{ color: colors.purple }} />
                  <span className="text-sm font-bold" style={{ color: colors.text }}>30秒チェックイン</span>
                </div>
                <button
                  onClick={() => setShowCheckin(!showCheckin)}
                  className="text-xs px-3 py-1 rounded-full font-bold transition-all"
                  style={{
                    background: showCheckin ? colors.purple : colors.purpleLight,
                    color: showCheckin ? 'white' : colors.purple,
                  }}
                >
                  {showCheckin ? '閉じる' : '記録する'}
                </button>
              </div>

              <AnimatePresence>
                {showCheckin && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="space-y-4 pt-3 border-t" style={{ borderColor: colors.border }}>
                      {/* 睡眠時間 */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-medium" style={{ color: colors.textLight }}>😴 睡眠時間</span>
                          <span className="text-sm font-bold" style={{ color: colors.text }}>{checkinForm.sleepHours}時間</span>
                        </div>
                        <input
                          type="range"
                          min="3"
                          max="12"
                          step="0.5"
                          value={checkinForm.sleepHours}
                          onChange={(e) => setCheckinForm({ ...checkinForm, sleepHours: parseFloat(e.target.value) })}
                          className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-purple-500"
                        />
                      </div>

                      {/* 各項目（5段階） */}
                      {[
                        { key: 'sleepQuality', label: '💤 睡眠の質', options: ['悪い', 'やや悪い', '普通', '良い', '最高'] },
                        { key: 'fatigue', label: '😫 疲労度', options: ['元気', 'やや疲れ', '普通', '疲れ', 'ヘトヘト'] },
                        { key: 'focus', label: '🎯 集中力', options: ['低い', 'やや低い', '普通', '良い', '最高'] },
                        { key: 'hunger', label: '🍽️ 空腹感', options: ['ない', '少し', '普通', 'ある', 'すごくある'] },
                      ].map((item) => (
                        <div key={item.key}>
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-medium" style={{ color: colors.textLight }}>{item.label}</span>
                            <span className="text-xs" style={{ color: colors.textMuted }}>
                              {item.options[(checkinForm as any)[item.key] - 1]}
                            </span>
                          </div>
                          <div className="flex gap-1">
                            {[1, 2, 3, 4, 5].map((val) => (
                              <button
                                key={val}
                                onClick={() => setCheckinForm({ ...checkinForm, [item.key]: val })}
                                className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all ${
                                  (checkinForm as any)[item.key] === val
                                    ? 'bg-purple-500 text-white'
                                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                                }`}
                              >
                                {val}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}

                      {/* 送信ボタン */}
                      <button
                        onClick={async () => {
                          setCheckinSubmitting(true);
                          setCheckinFeedback(null);
                          const result = await submitPerformanceCheckin({
                            sleepHours: checkinForm.sleepHours,
                            sleepQuality: checkinForm.sleepQuality,
                            fatigue: checkinForm.fatigue,
                            focus: checkinForm.focus,
                            hunger: checkinForm.hunger,
                          });
                          setCheckinSubmitting(false);
                          if (result.success) {
                            setShowCheckin(false);
                            setCheckinFeedback({
                              type: 'success',
                              message: '✅ チェックインを保存しました！',
                            });
                          } else {
                            setCheckinFeedback({
                              type: 'error',
                              message: '保存に失敗しました。再試行してください。',
                            });
                          }
                        }}
                        disabled={checkinSubmitting}
                        className="w-full py-3 rounded-xl font-bold text-white transition-all"
                        style={{ background: checkinSubmitting ? colors.textMuted : colors.purple }}
                      >
                        {checkinSubmitting ? '保存中...' : '✓ チェックイン完了'}
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {!showCheckin && (
                <p className="text-xs" style={{ color: colors.textMuted }}>
                  {performanceAnalysis?.eligibilityReason || '毎日のチェックインで、あなたに最適な栄養提案ができるようになります'}
                </p>
              )}
            </motion.div>
          )}

          {/* チェックイン完了済みの場合 */}
          {performanceAnalysis?.todayCheckin && (
            <div className="bg-green-50 border border-green-100 rounded-2xl p-4 flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
                <Check size={16} style={{ color: colors.success }} />
              </div>
              <div>
                <p className="text-sm font-bold" style={{ color: colors.success }}>今日のチェックイン完了！</p>
                <p className="text-xs" style={{ color: colors.textMuted }}>
                  {performanceAnalysis.eligibilityReason || '7日分のデータが揃うと分析が始まります'}
                </p>
              </div>
            </div>
          )}
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
              <div className="bg-gradient-to-r from-amber-500 to-orange-500 text-white p-4 rounded-2xl shadow-lg relative overflow-hidden">
                <div className="absolute top-0 right-0 w-24 h-24 bg-white/10 rounded-full -translate-y-1/2 translate-x-1/2" />
                <div className="flex items-start gap-3">
                  <Sparkles size={18} className="flex-shrink-0 mt-0.5" />
                  <div className="flex-1 relative z-10">
                    <p className="text-xs font-bold text-white/80 mb-0.5">💡 今日のアドバイス</p>
                    <p className="text-sm font-medium leading-relaxed">{suggestion}</p>
                  </div>
                  <button onClick={() => setSuggestion(null)} className="text-white/60 hover:text-white">
                    <X size={16} />
                  </button>
                </div>
                
                {/* AIが献立変更を提案している場合（suggestionまたはissuesがある） */}
                {(nutritionAnalysis?.suggestion || (nutritionAnalysis?.issues && nutritionAnalysis.issues.length > 0)) && (
                  <div className="mt-3 pt-3 border-t border-white/20">
                    <Link href="/menus/weekly">
                      <div className="w-full py-2 px-4 bg-white/20 hover:bg-white/30 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 cursor-pointer">
                        <ChevronRight size={16} />
                        献立表でAI変更する
                      </div>
                    </Link>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ========== メインコンテンツ ========== */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* 左カラム: 今日の献立 */}
          <div className="lg:col-span-2 space-y-6">
            
            {/* 今日の献立タイムライン */}
            <div className="bg-white rounded-3xl p-5 shadow-sm border border-gray-100">
              <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: colors.accentLight }}>
                    <Calendar size={16} color={colors.accent} />
                  </div>
                  <h2 className="font-bold text-gray-900">今日の献立</h2>
                </div>
                <Link href="/menus/weekly" className="text-xs font-bold flex items-center gap-1 hover:underline" style={{ color: colors.accent }}>
                  献立表 <ChevronRight size={14} />
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
                    const meals = todayPlan.meals.filter(m => m.mealType === mealType);
                    const mealConfig = MEAL_CONFIG[mealType];
                    const MealIcon = mealConfig.icon;
                    const isCurrentMeal = mealType === currentMealTypeState;
                    
                    if (meals.length === 0) {
                      return (
                        <Link key={mealType} href="/menus/weekly">
                          <div className={`p-4 rounded-xl border-2 border-dashed flex items-center justify-between transition-all ${
                            isCurrentMeal ? 'border-orange-300 bg-orange-50/50' : 'border-gray-200 hover:border-gray-300'
                          }`}>
                            <div className="flex items-center gap-3">
                              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                                isCurrentMeal ? 'bg-orange-100' : 'bg-gray-100'
                              }`}>
                                <MealIcon size={18} color={isCurrentMeal ? colors.accent : colors.textMuted} />
                              </div>
                              <div>
                                <span className={`text-sm ${isCurrentMeal ? 'text-orange-600 font-medium' : 'text-gray-400'}`}>
                                  {mealConfig.label}を追加
                                </span>
                                {isCurrentMeal && (
                                  <p className="text-xs text-orange-500">← 今の時間帯</p>
                                )}
                              </div>
                            </div>
                            <Icons.Plus className="w-5 h-5 text-gray-300" />
                          </div>
                        </Link>
                      );
                    }

                    return meals.map((meal, idx) => {
                      const modeConfig = MODE_CONFIG[meal.mode as MealMode] || MODE_CONFIG.cook;
                      const ModeIcon = modeConfig.icon;

                      return (
                        <motion.div
                          key={meal.id}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: idx * 0.05 }}
                          className={`p-4 rounded-xl transition-all ${
                            meal.isCompleted 
                              ? 'bg-gray-50 opacity-60' 
                              : isCurrentMeal 
                                ? 'bg-gradient-to-r from-orange-50 to-amber-50 border-2 border-orange-200' 
                                : 'bg-white border border-gray-100'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            {/* 完了チェック (Bug-10: ヒット領域 44x44 確保) */}
                            <button
                              type="button"
                              onClick={() => toggleMealCompletion(meal.id, meal.isCompleted)}
                              aria-label={meal.isCompleted ? `${mealConfig.label}を未完了に戻す` : `${mealConfig.label}を完了にする`}
                              aria-pressed={meal.isCompleted}
                              data-testid={`meal-toggle-${meal.mealType}`}
                              className="min-w-[44px] min-h-[44px] -m-1.5 p-1.5 flex items-center justify-center flex-shrink-0 cursor-pointer"
                            >
                              <span
                                className="w-8 h-8 rounded-full flex items-center justify-center transition-all"
                                style={{
                                  border: meal.isCompleted ? 'none' : `2px solid ${colors.border}`,
                                  background: meal.isCompleted ? colors.success : 'transparent',
                                }}
                              >
                                {meal.isCompleted && <Check size={16} color="#fff" />}
                              </span>
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
                                <span className="text-xs font-bold" style={{ color: mealConfig.color }}>
                                  {mealConfig.label}{meals.length > 1 ? idx + 1 : ''}
                                </span>
                                <div className="flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ background: modeConfig.bg }}>
                                  <ModeIcon size={10} color={modeConfig.color} />
                                  <span className="text-[10px] font-bold" style={{ color: modeConfig.color }}>{modeConfig.label}</span>
                                </div>
                                {isCurrentMeal && !meal.isCompleted && (
                                  <span className="text-[10px] font-bold text-orange-500 bg-orange-100 px-1.5 py-0.5 rounded">NOW</span>
                                )}
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
                    });
                  })}
                </div>
              ) : (
                <div className="text-center py-10">
                  <div className="w-20 h-20 rounded-full bg-gradient-to-br from-orange-100 to-amber-100 flex items-center justify-center mx-auto mb-4">
                    <Calendar size={32} color={colors.accent} />
                  </div>
                  <p className="text-gray-600 font-medium mb-2">今日の献立がまだありません</p>
                  <p className="text-sm text-gray-400 mb-4">AIで1週間分の献立を作成しましょう</p>
                  <Link href="/menus/weekly">
                    <button className="px-6 py-3 rounded-full text-white text-sm font-bold shadow-lg hover:shadow-xl transition-all" style={{ background: `linear-gradient(135deg, ${colors.accent} 0%, ${colors.accentDark} 100%)` }}>
                      <Sparkles size={16} className="inline mr-2" />
                      献立を作成する
                    </button>
                  </Link>
                </div>
              )}
            </div>

            {/* クイックアクション */}
            <div className="grid grid-cols-2 gap-3">
              <Link href="/meals/new">
                <motion.div 
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 hover:shadow-md transition-all"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${colors.accent} 0%, ${colors.accentDark} 100%)` }}>
                      <Camera size={22} color="#fff" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-gray-900">食事を記録</p>
                      <p className="text-xs text-gray-400">写真から入力</p>
                    </div>
                  </div>
                </motion.div>
              </Link>
              <Link href="/menus/weekly">
                <motion.div 
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 hover:shadow-md transition-all"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${colors.purple} 0%, #9575CD 100%)` }}>
                      <Sparkles size={22} color="#fff" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-gray-900">AI献立</p>
                      <p className="text-xs text-gray-400">1週間分を生成</p>
                    </div>
                  </div>
                </motion.div>
              </Link>
            </div>

            {/* 週間グラフ */}
            <div 
              onClick={() => setShowWeeklyDetail(true)}
              className="bg-white rounded-3xl p-5 shadow-sm border border-gray-100 cursor-pointer hover:shadow-md transition-all"
            >
              <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: colors.successLight }}>
                    <TrendingUp size={16} color={colors.success} />
                  </div>
                  <h2 className="font-bold text-gray-900">今週の自炊率</h2>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-black" style={{ color: colors.success }}>{weeklyStats.avgCookRate}%</span>
                  <ChevronRight size={18} color={colors.textMuted} />
                </div>
              </div>

              {/* 棒グラフ */}
              <div className="flex items-end justify-between gap-2 h-24">
                {weeklyStats.days.map((day, i) => {
                  const isToday = todayISODate ? day.date === todayISODate : false;
                  const height = day.mealCount > 0 ? Math.max(day.cookRate, 10) : 5;
                  
                  return (
                    <div key={day.date} className="flex-1 flex flex-col items-center gap-1">
                      <motion.div
                        initial={{ height: 0 }}
                        animate={{ height: `${height}%` }}
                        transition={{ delay: i * 0.05, duration: 0.5 }}
                        className="w-full rounded-t-lg"
                        style={{ 
                          background: day.mealCount > 0 
                            ? `linear-gradient(180deg, ${colors.success} 0%, #81C784 100%)`
                            : colors.border,
                          minHeight: 4,
                        }}
                      />
                      <span className={`text-[10px] font-bold ${isToday ? 'text-green-600' : 'text-gray-400'}`}>
                        {day.dayOfWeek}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* 右カラム: サイドバー */}
          <div className="space-y-4">
            
            {/* 今日の進捗 */}
            <div className="bg-white rounded-3xl p-5 shadow-sm border border-gray-100">
              <h3 className="font-bold text-gray-900 mb-4 flex items-center gap-2">
                <Target size={16} color={colors.accent} />
                今日の進捗
              </h3>
              
              {/* 円形プログレス */}
              <div className="flex flex-col items-center mb-4">
                <div className="relative w-28 h-28">
                  <svg className="w-full h-full transform -rotate-90">
                    <circle cx="50%" cy="50%" r="42%" stroke={colors.border} strokeWidth="8%" fill="none" />
                    <motion.circle 
                      cx="50%" cy="50%" r="42%" 
                      stroke={colors.accent}
                      strokeWidth="8%" 
                      fill="none" 
                      strokeDasharray="264"
                      strokeDashoffset={264 - (264 * completionRate / 100)} 
                      strokeLinecap="round"
                      initial={{ strokeDashoffset: 264 }}
                      animate={{ strokeDashoffset: 264 - (264 * completionRate / 100) }}
                      transition={{ duration: 1, ease: "easeOut" }}
                    />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span data-testid="home-progress-percent" className="text-3xl font-black text-gray-900">{completionRate}%</span>
                  </div>
                </div>
                <p data-testid="home-progress-fraction" className="text-xs text-gray-500 mt-2">{dailySummary.completedCount} / {dailySummary.totalCount} 食完了</p>
              </div>

              {/* 統計 */}
              <div className="space-y-2">
                <div className="flex justify-between items-center p-2.5 rounded-lg" style={{ background: colors.accentLight }}>
                  <div className="flex items-center gap-2">
                    <Flame size={14} color={colors.accent} aria-hidden="true" />
                    <span className="text-xs font-medium text-gray-600">今日の献立合計</span>
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
              </div>
            </div>

            {/* 冷蔵庫アラート */}
            {expiringItems.length > 0 && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-2xl p-4 border border-amber-200"
              >
                <div className="flex items-center gap-2 mb-3">
                  <AlertTriangle size={16} color={colors.warning} />
                  <h3 className="font-bold text-amber-800 text-sm">期限切れ間近</h3>
                </div>
                <div className="space-y-2">
                  {expiringItems.slice(0, 3).map(item => {
                    const daysLeft = Math.ceil((new Date(item.expirationDate!).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
                    return (
                      <div key={item.id} className="flex justify-between items-center">
                        <span className="text-sm text-amber-900">{item.name}</span>
                        <span suppressHydrationWarning className={`text-xs font-bold px-2 py-0.5 rounded ${
                          daysLeft <= 1 ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-600'
                        }`}>
                          {daysLeft <= 0 ? '今日まで' : `あと${daysLeft}日`}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {expiringItems.length > 3 && (
                  <p className="text-xs text-amber-600 mt-2">他{expiringItems.length - 3}件</p>
                )}
              </motion.div>
            )}

            {/* 買い物リスト */}
            {shoppingRemaining > 0 && (
              <Link href="/menus/weekly">
                <motion.div 
                  whileHover={{ scale: 1.02 }}
                  className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 flex items-center gap-3"
                >
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: colors.blueLight }}>
                    <ShoppingCart size={18} color={colors.blue} />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-bold text-gray-900">買い物リスト</p>
                    <p className="text-xs text-gray-400">残り{shoppingRemaining}品</p>
                  </div>
                  <ChevronRight size={18} color={colors.textMuted} />
                </motion.div>
              </Link>
            )}

            {/* バッジ */}
            <Link href="/badges">
              <motion.div 
                whileHover={{ scale: 1.02 }}
                className="bg-gradient-to-br from-purple-50 to-indigo-50 rounded-2xl p-4 border border-purple-100 flex items-center gap-3"
              >
                <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${colors.purple} 0%, #9575CD 100%)` }}>
                  <Trophy size={18} color="#fff" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-bold text-purple-900">獲得バッジ</p>
                  <p className="text-xs text-purple-600">{badgeCount}個獲得</p>
                </div>
                {latestBadge && (
                  <div className="text-right">
                    <p className="text-[10px] text-purple-400">最新</p>
                    <p className="text-xs font-bold text-purple-700">{latestBadge.name}</p>
                  </div>
                )}
              </motion.div>
            </Link>

            {/* 今週のベスト */}
            {bestMealThisWeek && bestMealThisWeek.imageUrl && (
              <div className="bg-white rounded-2xl overflow-hidden shadow-sm border border-gray-100">
                <div className="relative h-32">
                  <Image 
                    src={bestMealThisWeek.imageUrl} 
                    fill 
                    alt={bestMealThisWeek.dishName} 
                    className="object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                  <div className="absolute bottom-0 left-0 right-0 p-3">
                    <div className="flex items-center gap-1 mb-1">
                      <Award size={12} color="#FFD700" />
                      <span className="text-[10px] font-bold text-yellow-300">今週のベスト</span>
                    </div>
                    <p className="text-sm font-bold text-white truncate">{bestMealThisWeek.dishName}</p>
                  </div>
                </div>
              </div>
            )}

            {/* ヒント */}
            <div className="bg-gray-50 p-4 rounded-2xl border border-gray-100">
              <div className="flex gap-3 items-start">
                <span className="text-xl">💡</span>
                <p className="text-xs text-gray-600 leading-relaxed">
                  {dailySummary.completedCount === 0 
                    ? "まずは朝食から始めましょう！完了したらチェックを入れてね。" 
                    : dailySummary.completedCount === dailySummary.totalCount && dailySummary.totalCount > 0
                    ? "今日の食事は全て完了！お疲れ様でした 🎉"
                    : cookingStreak >= 7
                    ? `${cookingStreak}日連続自炊おめでとう！🎉 この調子で続けましょう！`
                    : "良い調子です！残りの食事も頑張りましょう。"}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 週間詳細モーダル */}
      <AnimatePresence>
        {showWeeklyDetail && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowWeeklyDetail(false)}
              className="fixed inset-0 bg-black/60 z-[60] backdrop-blur-sm"
            />
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="weekly-stats-title"
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="fixed bottom-0 left-0 right-0 lg:left-auto lg:right-8 lg:bottom-8 lg:w-[400px] lg:rounded-3xl bg-white rounded-t-3xl z-[61] max-h-[80vh] overflow-y-auto shadow-2xl"
            >
              <div className="p-6 pb-28">
                <div className="w-12 h-1 bg-gray-200 rounded-full mx-auto mb-6 lg:hidden" />
                
                <div className="flex justify-between items-center mb-6">
                  <h2 id="weekly-stats-title" className="text-xl font-bold text-gray-900">今週の統計</h2>
                  <button onClick={() => setShowWeeklyDetail(false)} className="p-2 bg-gray-100 rounded-full hover:bg-gray-200 transition-colors">
                    <X size={20} color={colors.textLight} />
                  </button>
                </div>

                {/* サマリー */}
                <div className="grid grid-cols-2 gap-3 mb-6">
                  <div className="p-4 rounded-xl" style={{ background: colors.successLight }}>
                    <p className="text-xs text-gray-500 mb-1">自炊率</p>
                    <p className="text-2xl font-black" style={{ color: colors.success }}>{weeklyStats.avgCookRate}%</p>
                  </div>
                  <div className="p-4 rounded-xl" style={{ background: colors.accentLight }}>
                    <p className="text-xs text-gray-500 mb-1">総食事数</p>
                    <p className="text-2xl font-black" style={{ color: colors.accent }}>{weeklyStats.totalMealCount}食</p>
                  </div>
                </div>

                {/* 日別詳細 */}
                <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">日別詳細</h3>
                <div className="space-y-2">
                  {weeklyStats.days.map((day) => {
                    const isToday = todayISODate ? day.date === todayISODate : false;
                    return (
                      <div key={day.date} className={`flex items-center justify-between p-3 rounded-xl ${isToday ? 'bg-orange-50 border border-orange-200' : 'bg-gray-50'}`}>
                        <div className="flex items-center gap-3">
                          <span className={`text-sm font-bold ${isToday ? 'text-orange-600' : 'text-gray-600'}`}>
                            {day.dayOfWeek}
                          </span>
                          <span className="text-xs text-gray-400">
                            {day.date.slice(5).replace('-', '/')}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-gray-500">{day.mealCount}食</span>
                          <div className="w-16 h-2 bg-gray-200 rounded-full overflow-hidden">
                            <div 
                              className="h-full rounded-full" 
                              style={{ 
                                width: `${day.cookRate}%`, 
                                background: colors.success 
                              }} 
                            />
                          </div>
                          <span className="text-sm font-bold" style={{ color: colors.success }}>{day.cookRate}%</span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <button 
                  onClick={() => setShowWeeklyDetail(false)} 
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
