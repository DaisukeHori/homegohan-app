"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { createClient } from "@/lib/supabase/client";
import {
  Scale, Heart, Moon, Droplets, Activity, TrendingUp, TrendingDown,
  Target, Flame, Calendar, ChevronRight, Plus, Camera, Sparkles,
  Award, Clock, Smile, Frown, Meh, AlertTriangle, CheckCircle2, Settings
} from 'lucide-react';
import { getGoalTypeLabel } from "@/lib/health-goal-types";

// カラーパレット
const colors = {
  bg: '#FAF9F7',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textLight: '#4A4A4A',
  textMuted: '#9A9A9A',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  success: '#4CAF50',
  successLight: '#E8F5E9',
  warning: '#FF9800',
  warningLight: '#FFF3E0',
  error: '#F44336',
  errorLight: '#FFEBEE',
  purple: '#7C4DFF',
  purpleLight: '#EDE7F6',
  blue: '#2196F3',
  blueLight: '#E3F2FD',
  border: '#EEEEEE',
  streak: '#FF6B35',
};

interface HealthRecord {
  id: string;
  record_date: string;
  weight?: number;
  body_fat_percentage?: number;
  systolic_bp?: number;
  diastolic_bp?: number;
  heart_rate?: number;
  sleep_hours?: number;
  sleep_quality?: number;
  mood_score?: number;
  overall_condition?: number;
  water_intake?: number;
  step_count?: number;
}

interface HealthStreak {
  current_streak: number;
  longest_streak: number;
  achieved_badges: string[];
  total_records: number;
}

interface HealthGoal {
  id: string;
  goal_type: string;
  target_value: number;
  target_unit: string;
  current_value?: number;
  progress_percentage?: number;
  target_date?: string;
  status: string;
}

export default function HealthDashboardPage() {
  const [loading, setLoading] = useState(true);
  const [todayRecord, setTodayRecord] = useState<HealthRecord | null>(null);
  const [yesterdayRecord, setYesterdayRecord] = useState<HealthRecord | null>(null);
  const [streak, setStreak] = useState<HealthStreak | null>(null);
  const [goals, setGoals] = useState<HealthGoal[]>([]);
  const [weeklyRecords, setWeeklyRecords] = useState<string[]>([]);
  const [showQuickRecord, setShowQuickRecord] = useState(false);
  const [quickWeight, setQuickWeight] = useState<string>('');
  const [quickMood, setQuickMood] = useState<number | null>(null);
  const [quickSleep, setQuickSleep] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // #1051 UX3-05: クイック記録の保存失敗が無反応だったため、モーダルを保持したまま表示する
  const [quickSaveError, setQuickSaveError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedDateRecord, setSelectedDateRecord] = useState<HealthRecord | null>(null);
  const [loadingSelectedDate, setLoadingSelectedDate] = useState(false);

  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();

  const fetchData = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    
    if (!user) {
      setLoading(false);
      return;
    }

    // 今日の記録を取得
    const recordRes = await fetch(`/api/health/records/${today}`);
    if (recordRes.ok) {
      const data = await recordRes.json();
      setTodayRecord(data.record);
      setYesterdayRecord(data.previous);
      if (data.record?.weight) {
        setQuickWeight(data.record.weight.toString());
      }
    }

    // 連続記録を取得
    const streakRes = await fetch('/api/health/streaks');
    if (streakRes.ok) {
      const data = await streakRes.json();
      setStreak(data.streak);
      setWeeklyRecords(data.weeklyRecords || []);
    }

    // 目標を取得
    const goalsRes = await fetch('/api/health/goals?status=active');
    if (goalsRes.ok) {
      const data = await goalsRes.json();
      setGoals(data.goals || []);
    }

    setLoading(false);
  }, [today]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handleDaySelect = async (date: string) => {
    // 今日のセル、または既に選択中の日をクリック → パネルを閉じる
    if (date === today || date === selectedDate) {
      setSelectedDate(null);
      setSelectedDateRecord(null);
      return;
    }
    setSelectedDate(date);
    setLoadingSelectedDate(true);
    try {
      const res = await fetch(`/api/health/records/${date}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedDateRecord(data.record ?? null);
      } else {
        setSelectedDateRecord(null);
      }
    } catch {
      setSelectedDateRecord(null);
    }
    setLoadingSelectedDate(false);
  };

  const handleQuickSave = async () => {
    if (!quickWeight && quickMood === null && quickSleep === null) {
      return;
    }

    setSaving(true);
    setQuickSaveError(null);
    try {
      const res = await fetch('/api/health/records/quick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          weight: quickWeight ? parseFloat(quickWeight) : undefined,
          mood_score: quickMood,
          sleep_quality: quickSleep,
          record_date: today,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setTodayRecord(data.record);
        setMessage(data.message);
        setShowQuickRecord(false);
        void fetchData(); // 再取得

        // メッセージを3秒後に消す
        setTimeout(() => setMessage(null), 5000);
        setSaving(false);
        return;
      }

      // #1051 UX3-05: 失敗時に無反応にせず、モーダルを保持したまま再試行できるようにする
      const data = await res.json().catch(() => null);
      setQuickSaveError(data?.error || '記録に失敗しました。もう一度お試しください。');
    } catch (error) {
      console.error('Failed to save:', error);
      setQuickSaveError('記録に失敗しました。もう一度お試しください。');
    }
    setSaving(false);
  };

  const getWeightChange = () => {
    if (!todayRecord?.weight || !yesterdayRecord?.weight) return null;
    return parseFloat((todayRecord.weight - yesterdayRecord.weight).toFixed(2));
  };

  const weightChange = getWeightChange();

  // #1051 UX3-08: 「減少=緑/増加=赤」の固定意味付けは増量目標だと意味が逆になるため、
  // 目標体重が分かる場合は目標に近づく方向を「良い」とする。目標が無ければ判定しない(中立表示)。
  const weightGoal = goals.find((g) => g.goal_type === 'weight') ?? null;
  const getWeightChangeSentiment = (): 'good' | 'bad' | 'neutral' => {
    if (weightChange === null || weightChange === 0) return 'neutral';
    if (!weightGoal || todayRecord?.weight == null) return 'neutral';
    const target = weightGoal.target_value;
    const current = todayRecord.weight;
    if (current === target) return 'neutral';
    const goodDirection: 'up' | 'down' = current > target ? 'down' : 'up';
    const actualDirection: 'up' | 'down' = weightChange > 0 ? 'up' : 'down';
    return actualDirection === goodDirection ? 'good' : 'bad';
  };
  const weightChangeSentiment = getWeightChangeSentiment();
  const weightChangeColor = weightChangeSentiment === 'good'
    ? colors.success
    : weightChangeSentiment === 'bad'
      ? colors.error
      : colors.textMuted;

  // 週間カレンダーを生成
  const getWeekDays = () => {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      days.push({
        date: `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`,
        day: ['日', '月', '火', '水', '木', '金', '土'][date.getDay()],
        dayNum: date.getDate(),
        isToday: i === 0,
      });
    }
    return days;
  };

  const weekDays = getWeekDays();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: colors.bg }}>
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
        >
          <Activity size={32} style={{ color: colors.accent }} />
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-24" style={{ backgroundColor: colors.bg }}>
      {/* ヘッダー */}
      <div className="px-4 pt-6 pb-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: colors.text }}>健康記録</h1>
          <p className="text-sm mt-1" style={{ color: colors.textMuted }}>
            毎日の記録があなたの健康を支えます
          </p>
        </div>
        {/* #1051 UX3-03: 記録設定(通知設定含む)への導線がURL直打ちでしか無かったため追加 */}
        <Link
          href="/health/settings"
          aria-label="記録設定"
          className="p-2 -mr-2 -mt-1 rounded-full"
          style={{ color: colors.textMuted }}
        >
          <Settings size={22} />
        </Link>
      </div>

      {/* 成功メッセージ */}
      <AnimatePresence>
        {message && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="mx-4 mb-4 p-4 rounded-xl"
            style={{ backgroundColor: colors.successLight }}
          >
            <div className="flex items-center gap-3">
              <CheckCircle2 size={24} style={{ color: colors.success }} />
              <p className="text-sm font-medium" style={{ color: colors.success }}>
                {message}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 連続記録カード */}
      <div className="px-4 mb-4">
        {/* #1051 UX3-03: 連続記録詳細(/health/streaks)への導線が無くURL直打ちでしか開けなかった */}
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold" style={{ color: colors.text }}>連続記録</h3>
          <Link
            href="/health/streaks"
            className="text-sm flex items-center gap-1"
            style={{ color: colors.accent }}
          >
            詳細を見る <ChevronRight size={16} />
          </Link>
        </div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-4 rounded-2xl"
          style={{ 
            background: `linear-gradient(135deg, ${colors.accent} 0%, ${colors.streak} 100%)`,
          }}
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Flame size={20} color="white" />
                <span className="text-white/80 text-sm">連続記録</span>
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-4xl font-bold text-white">
                  {streak?.current_streak || 0}
                </span>
                <span className="text-white/80 text-sm">日</span>
              </div>
              <p className="text-white/60 text-xs mt-1">
                最長: {streak?.longest_streak || 0}日
              </p>
            </div>
            <div className="text-right">
              <Award size={48} color="white" className="opacity-30" />
            </div>
          </div>

          {/* 週間カレンダー */}
          <div className="flex gap-2 mt-4">
            {weekDays.map((day) => {
              const hasRecord = weeklyRecords.includes(day.date);
              const isSelected = selectedDate === day.date || (day.isToday && selectedDate === null);
              return (
                <button
                  key={day.date}
                  type="button"
                  aria-label={`${day.day}${day.dayNum}日${hasRecord ? '（記録あり）' : ''}`}
                  aria-pressed={isSelected}
                  onClick={() => handleDaySelect(day.date)}
                  className={`flex-1 text-center py-2 rounded-lg transition-all ${
                    isSelected ? 'ring-2 ring-white' : ''
                  }`}
                  style={{
                    backgroundColor: hasRecord ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)',
                    cursor: 'pointer',
                    border: 'none',
                    outline: 'none',
                  }}
                >
                  <div className="text-white/60 text-xs">{day.day}</div>
                  <div className="text-white font-bold text-sm">{day.dayNum}</div>
                  {hasRecord && (
                    <CheckCircle2 size={12} className="mx-auto mt-1" color="white" />
                  )}
                </button>
              );
            })}
          </div>
        </motion.div>
      </div>

      {/* 過去日選択時のレコード表示 */}
      <AnimatePresence>
        {selectedDate && (
          <motion.div
            key={selectedDate}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="px-4 mb-4"
          >
            <div
              className="p-4 rounded-2xl"
              style={{
                backgroundColor: colors.card,
                boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
              }}
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold" style={{ color: colors.text }}>
                  {selectedDate} の記録
                </h3>
                <Link
                  href={`/health/record?date=${selectedDate}`}
                  className="text-sm flex items-center gap-1"
                  style={{ color: colors.accent }}
                >
                  {selectedDateRecord ? '詳細を編集' : '記録を追加'} <ChevronRight size={16} />
                </Link>
              </div>
              {loadingSelectedDate ? (
                <div className="flex justify-center py-4">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                  >
                    <Activity size={24} style={{ color: colors.accent }} />
                  </motion.div>
                </div>
              ) : selectedDateRecord ? (
                <div className="grid grid-cols-3 gap-3">
                  <div className="p-3 rounded-xl text-center" style={{ backgroundColor: colors.bg }}>
                    <Scale size={20} className="mx-auto mb-1" style={{ color: colors.accent }} aria-hidden="true" />
                    <p className="text-xs font-medium mb-0.5" style={{ color: colors.textMuted }}>体重</p>
                    <p className="text-lg font-bold" style={{ color: colors.text }}>{selectedDateRecord.weight || '-'}</p>
                    <p className="text-xs" style={{ color: colors.textMuted }}>kg</p>
                  </div>
                  <div className="p-3 rounded-xl text-center" style={{ backgroundColor: colors.bg }}>
                    {selectedDateRecord.mood_score ? (
                      selectedDateRecord.mood_score >= 4 ? (
                        <Smile size={20} className="mx-auto mb-1" style={{ color: colors.success }} aria-hidden="true" />
                      ) : selectedDateRecord.mood_score <= 2 ? (
                        <Frown size={20} className="mx-auto mb-1" style={{ color: colors.error }} aria-hidden="true" />
                      ) : (
                        <Meh size={20} className="mx-auto mb-1" style={{ color: colors.warning }} aria-hidden="true" />
                      )
                    ) : (
                      <Meh size={20} className="mx-auto mb-1" style={{ color: colors.textMuted }} aria-hidden="true" />
                    )}
                    <p className="text-xs font-medium mb-0.5" style={{ color: colors.textMuted }}>気分</p>
                    <p className="text-lg font-bold" style={{ color: colors.text }}>
                      {selectedDateRecord.mood_score || '-'}
                    </p>
                    <p className="text-xs" style={{ color: colors.textMuted }}>{selectedDateRecord.mood_score ? '/ 5' : '未記録'}</p>
                  </div>
                  <div className="p-3 rounded-xl text-center" style={{ backgroundColor: colors.bg }}>
                    <Moon size={20} className="mx-auto mb-1" style={{ color: colors.purple }} aria-hidden="true" />
                    <p className="text-xs font-medium mb-0.5" style={{ color: colors.textMuted }}>
                      {selectedDateRecord.sleep_hours ? '睡眠時間' : '睡眠の質'}
                    </p>
                    <p className="text-lg font-bold" style={{ color: colors.text }}>
                      {selectedDateRecord.sleep_hours || selectedDateRecord.sleep_quality || '-'}
                    </p>
                    <p className="text-xs" style={{ color: colors.textMuted }}>
                      {selectedDateRecord.sleep_hours ? '時間' : selectedDateRecord.sleep_quality ? '/ 5' : '未記録'}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="py-4 text-center">
                  <p className="text-sm" style={{ color: colors.textMuted }}>この日の記録はありません</p>
                  <Link
                    href={`/health/record?date=${selectedDate}`}
                    className="inline-flex items-center gap-1 mt-3 px-4 py-2 rounded-xl text-sm font-medium text-white"
                    style={{ backgroundColor: colors.accent }}
                  >
                    <Plus size={16} />
                    記録を追加
                  </Link>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* クイック記録ボタン / 今日の記録サマリー */}
      <div className="px-4 mb-4">
        {!todayRecord ? (
          <motion.button
            whileTap={{ scale: 0.98 }}
            onClick={() => { setQuickSaveError(null); setShowQuickRecord(true); }}
            className="w-full p-4 rounded-2xl flex items-center justify-between"
            style={{ 
              backgroundColor: colors.card,
              boxShadow: '0 2px 8px rgba(0,0,0,0.06)'
            }}
          >
            <div className="flex items-center gap-3">
              <div 
                className="w-12 h-12 rounded-xl flex items-center justify-center"
                style={{ backgroundColor: colors.accentLight }}
              >
                <Plus size={24} style={{ color: colors.accent }} />
              </div>
              <div className="text-left">
                <p className="font-semibold" style={{ color: colors.text }}>
                  今日の記録をつける
                </p>
                <p className="text-sm" style={{ color: colors.textMuted }}>
                  体重・気分・睡眠を30秒で記録
                </p>
              </div>
            </div>
            <ChevronRight size={20} style={{ color: colors.textMuted }} />
          </motion.button>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-4 rounded-2xl"
            style={{ 
              backgroundColor: colors.card,
              boxShadow: '0 2px 8px rgba(0,0,0,0.06)'
            }}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold" style={{ color: colors.text }}>今日の記録</h3>
              <Link 
                href="/health/record"
                className="text-sm flex items-center gap-1"
                style={{ color: colors.accent }}
              >
                詳細を編集 <ChevronRight size={16} />
              </Link>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {/* 体重 */}
              <div
                className="p-3 rounded-xl text-center"
                style={{ backgroundColor: colors.bg }}
              >
                <Scale size={20} className="mx-auto mb-1" style={{ color: colors.accent }} aria-hidden="true" />
                <p className="text-xs font-medium mb-0.5" style={{ color: colors.textMuted }}>体重</p>
                <p className="text-lg font-bold" style={{ color: colors.text }}>
                  {todayRecord.weight || '-'}
                </p>
                <p className="text-xs" style={{ color: colors.textMuted }}>kg</p>
                {weightChange !== null && (
                  <div className="flex items-center justify-center gap-1 mt-1">
                    {weightChange < 0 ? (
                      <TrendingDown size={12} style={{ color: weightChangeColor }} />
                    ) : weightChange > 0 ? (
                      <TrendingUp size={12} style={{ color: weightChangeColor }} />
                    ) : null}
                    <span
                      className="text-xs"
                      style={{ color: weightChangeColor }}
                    >
                      {weightChange > 0 ? '+' : ''}{weightChange}
                    </span>
                  </div>
                )}
              </div>

              {/* 気分 */}
              <div
                className="p-3 rounded-xl text-center"
                style={{ backgroundColor: colors.bg }}
              >
                {todayRecord.mood_score ? (
                  <>
                    {todayRecord.mood_score >= 4 ? (
                      <Smile size={20} className="mx-auto mb-1" style={{ color: colors.success }} aria-hidden="true" />
                    ) : todayRecord.mood_score <= 2 ? (
                      <Frown size={20} className="mx-auto mb-1" style={{ color: colors.error }} aria-hidden="true" />
                    ) : (
                      <Meh size={20} className="mx-auto mb-1" style={{ color: colors.warning }} aria-hidden="true" />
                    )}
                    <p className="text-xs font-medium mb-0.5" style={{ color: colors.textMuted }}>気分</p>
                    <p className="text-lg font-bold" style={{ color: colors.text }}>
                      {todayRecord.mood_score}
                    </p>
                    <p className="text-xs" style={{ color: colors.textMuted }}>/ 5</p>
                  </>
                ) : (
                  <>
                    <Meh size={20} className="mx-auto mb-1" style={{ color: colors.textMuted }} aria-hidden="true" />
                    <p className="text-xs font-medium mb-0.5" style={{ color: colors.textMuted }}>気分</p>
                    <p className="text-lg font-bold" style={{ color: colors.textMuted }}>-</p>
                    <p className="text-xs" style={{ color: colors.textMuted }}>未記録</p>
                  </>
                )}
              </div>

              {/* 睡眠 */}
              <div
                className="p-3 rounded-xl text-center"
                style={{ backgroundColor: colors.bg }}
              >
                <Moon size={20} className="mx-auto mb-1" style={{ color: colors.purple }} aria-hidden="true" />
                <p className="text-xs font-medium mb-0.5" style={{ color: colors.textMuted }}>
                  {todayRecord.sleep_hours ? '睡眠時間' : '睡眠の質'}
                </p>
                <p className="text-lg font-bold" style={{ color: colors.text }}>
                  {todayRecord.sleep_hours || todayRecord.sleep_quality || '-'}
                </p>
                <p className="text-xs" style={{ color: colors.textMuted }}>
                  {todayRecord.sleep_hours ? '時間' : todayRecord.sleep_quality ? '/ 5' : '未記録'}
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </div>

      {/* 目標進捗 */}
      {goals.length > 0 && (
        <div className="px-4 mb-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold" style={{ color: colors.text }}>目標進捗</h3>
            <Link 
              href="/health/goals"
              className="text-sm flex items-center gap-1"
              style={{ color: colors.accent }}
            >
              すべて見る <ChevronRight size={16} />
            </Link>
          </div>
          <div className="space-y-3">
            {goals.slice(0, 2).map((goal) => (
              <motion.div
                key={goal.id}
                className="p-4 rounded-xl"
                style={{ 
                  backgroundColor: colors.card,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.06)'
                }}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Target size={18} style={{ color: colors.accent }} />
                    <span className="font-medium" style={{ color: colors.text }}>
                      {goal.goal_type === 'weight' ? '目標体重' :
                       goal.goal_type === 'body_fat' ? '目標体脂肪率' : getGoalTypeLabel(goal.goal_type)}
                    </span>
                  </div>
                  <span className="text-sm font-bold" style={{ color: colors.accent }}>
                    {goal.target_value}{goal.target_unit}
                  </span>
                </div>
                <div className="relative h-2 rounded-full overflow-hidden" style={{ backgroundColor: colors.bg }}>
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.min(goal.progress_percentage || 0, 100)}%` }}
                    className="absolute left-0 top-0 h-full rounded-full"
                    style={{ backgroundColor: colors.accent }}
                  />
                </div>
                <div className="flex items-center justify-between mt-2">
                  <span className="text-xs" style={{ color: colors.textMuted }}>
                    現在: {goal.current_value || '-'}{goal.target_unit}
                  </span>
                  <span className="text-xs font-medium" style={{ color: colors.accent }}>
                    {(goal.progress_percentage || 0).toFixed(0)}%
                  </span>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {/* クイックアクション */}
      <div className="px-4 mb-4">
        <h3 className="font-semibold mb-3" style={{ color: colors.text }}>クイックアクション</h3>
        <div className="grid grid-cols-2 gap-3">
          <Link href="/health/record">
            <motion.div
              whileTap={{ scale: 0.98 }}
              className="p-4 rounded-xl"
              style={{ 
                backgroundColor: colors.card,
                boxShadow: '0 2px 8px rgba(0,0,0,0.06)'
              }}
            >
              <div 
                className="w-10 h-10 rounded-lg flex items-center justify-center mb-2"
                style={{ backgroundColor: colors.accentLight }}
              >
                <Calendar size={20} style={{ color: colors.accent }} />
              </div>
              <p className="font-medium text-sm" style={{ color: colors.text }}>詳細記録</p>
              <p className="text-xs" style={{ color: colors.textMuted }}>すべての項目を記録</p>
            </motion.div>
          </Link>

          <Link href="/health/record/quick">
            <motion.div
              whileTap={{ scale: 0.98 }}
              className="p-4 rounded-xl"
              style={{ 
                backgroundColor: colors.card,
                boxShadow: '0 2px 8px rgba(0,0,0,0.06)'
              }}
            >
              <div 
                className="w-10 h-10 rounded-lg flex items-center justify-center mb-2"
                style={{ backgroundColor: colors.blueLight }}
              >
                <Camera size={20} style={{ color: colors.blue }} />
              </div>
              <p className="font-medium text-sm" style={{ color: colors.text }}>写真で記録</p>
              <p className="text-xs" style={{ color: colors.textMuted }}>体重計を撮影</p>
            </motion.div>
          </Link>

          <Link href="/health/graphs">
            <motion.div
              whileTap={{ scale: 0.98 }}
              className="p-4 rounded-xl"
              style={{ 
                backgroundColor: colors.card,
                boxShadow: '0 2px 8px rgba(0,0,0,0.06)'
              }}
            >
              <div 
                className="w-10 h-10 rounded-lg flex items-center justify-center mb-2"
                style={{ backgroundColor: colors.purpleLight }}
              >
                <TrendingUp size={20} style={{ color: colors.purple }} />
              </div>
              <p className="font-medium text-sm" style={{ color: colors.text }}>グラフ</p>
              <p className="text-xs" style={{ color: colors.textMuted }}>推移を確認</p>
            </motion.div>
          </Link>

          <Link href="/health/goals">
            <motion.div
              whileTap={{ scale: 0.98 }}
              className="p-4 rounded-xl"
              style={{
                backgroundColor: colors.card,
                boxShadow: '0 2px 8px rgba(0,0,0,0.06)'
              }}
            >
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center mb-2"
                style={{ backgroundColor: colors.successLight }}
              >
                <Target size={20} style={{ color: colors.success }} />
              </div>
              <p className="font-medium text-sm" style={{ color: colors.text }}>目標設定</p>
              <p className="text-xs" style={{ color: colors.textMuted }}>目標を管理</p>
            </motion.div>
          </Link>

          {/* #1051 UX3-03: 血液検査/AI分析/チャレンジへの導線が無くURL直打ちでしか開けなかった */}
          <Link href="/health/blood-tests">
            <motion.div
              whileTap={{ scale: 0.98 }}
              className="p-4 rounded-xl"
              style={{
                backgroundColor: colors.card,
                boxShadow: '0 2px 8px rgba(0,0,0,0.06)'
              }}
            >
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center mb-2"
                style={{ backgroundColor: colors.errorLight }}
              >
                <Droplets size={20} style={{ color: colors.error }} />
              </div>
              <p className="font-medium text-sm" style={{ color: colors.text }}>血液検査</p>
              <p className="text-xs" style={{ color: colors.textMuted }}>検査結果を確認</p>
            </motion.div>
          </Link>

          <Link href="/health/insights">
            <motion.div
              whileTap={{ scale: 0.98 }}
              className="p-4 rounded-xl"
              style={{
                backgroundColor: colors.card,
                boxShadow: '0 2px 8px rgba(0,0,0,0.06)'
              }}
            >
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center mb-2"
                style={{ backgroundColor: colors.purpleLight }}
              >
                <Sparkles size={20} style={{ color: colors.purple }} />
              </div>
              <p className="font-medium text-sm" style={{ color: colors.text }}>AI分析</p>
              <p className="text-xs" style={{ color: colors.textMuted }}>気づきを確認</p>
            </motion.div>
          </Link>

          <Link href="/health/challenges">
            <motion.div
              whileTap={{ scale: 0.98 }}
              className="p-4 rounded-xl"
              style={{
                backgroundColor: colors.card,
                boxShadow: '0 2px 8px rgba(0,0,0,0.06)'
              }}
            >
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center mb-2"
                style={{ backgroundColor: colors.warningLight }}
              >
                <Award size={20} style={{ color: colors.streak }} />
              </div>
              <p className="font-medium text-sm" style={{ color: colors.text }}>チャレンジ</p>
              <p className="text-xs" style={{ color: colors.textMuted }}>達成に挑戦</p>
            </motion.div>
          </Link>
        </div>
      </div>

      {/* 健康診断 */}
      <div className="px-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold" style={{ color: colors.text }}>健康診断</h3>
          <Link
            href="/health/checkups"
            className="text-sm flex items-center gap-1"
            style={{ color: colors.accent }}
          >
            すべて見る <ChevronRight size={16} />
          </Link>
        </div>
        <Link href="/health/checkups">
          <motion.div
            whileTap={{ scale: 0.98 }}
            className="p-4 rounded-xl"
            style={{
              backgroundColor: colors.card,
              boxShadow: '0 2px 8px rgba(0,0,0,0.06)'
            }}
          >
            <div className="flex items-center gap-4">
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center"
                style={{ backgroundColor: colors.errorLight }}
              >
                <Activity size={24} style={{ color: colors.error }} />
              </div>
              <div className="flex-1">
                <p className="font-medium" style={{ color: colors.text }}>
                  健康診断結果を記録
                </p>
                <p className="text-sm" style={{ color: colors.textMuted }}>
                  検査値をAIが分析・献立に反映
                </p>
              </div>
              <ChevronRight size={20} style={{ color: colors.textMuted }} />
            </div>
          </motion.div>
        </Link>
      </div>

      {/* クイック記録モーダル */}
      <AnimatePresence>
        {showQuickRecord && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 z-[60] flex items-end"
            onClick={() => { setShowQuickRecord(false); setQuickSaveError(null); }}
          >
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25 }}
              className="w-full rounded-t-3xl p-6 pb-28"
              style={{ backgroundColor: colors.card }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-12 h-1 bg-gray-300 rounded-full mx-auto mb-6" />
              
              <h2 className="text-xl font-bold mb-6" style={{ color: colors.text }}>
                今日の記録
              </h2>

              {/* #1051 UX3-05: 保存失敗を無反応にせず、入力を保持したままエラーを表示する */}
              {quickSaveError && (
                <div className="flex items-start gap-2 p-3 mb-4 rounded-lg" style={{ backgroundColor: colors.errorLight }}>
                  <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" style={{ color: colors.error }} />
                  <p className="text-sm" style={{ color: colors.error }}>{quickSaveError}</p>
                </div>
              )}

              {/* 体重入力 */}
              <div className="mb-6">
                <label className="block text-sm font-medium mb-2" style={{ color: colors.textLight }}>
                  体重 (kg)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    step="0.1"
                    value={quickWeight}
                    onChange={(e) => setQuickWeight(e.target.value)}
                    placeholder={yesterdayRecord?.weight?.toString() || '65.0'}
                    className="flex-1 p-4 rounded-xl text-2xl font-bold text-center"
                    style={{ 
                      backgroundColor: colors.bg,
                      color: colors.text,
                      border: 'none',
                      outline: 'none',
                    }}
                  />
                  <span className="text-lg" style={{ color: colors.textMuted }}>kg</span>
                </div>
                {yesterdayRecord?.weight && (
                  <p className="text-xs mt-2 text-center" style={{ color: colors.textMuted }}>
                    昨日: {yesterdayRecord.weight}kg
                  </p>
                )}
              </div>

              {/* 気分入力 */}
              <div className="mb-6">
                <label className="block text-sm font-medium mb-2" style={{ color: colors.textLight }}>
                  今の気分
                </label>
                <div className="flex justify-between gap-2">
                  {[1, 2, 3, 4, 5].map((score) => (
                    <motion.button
                      key={score}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => setQuickMood(quickMood === score ? null : score)}
                      className="flex-1 py-3 rounded-xl text-2xl"
                      style={{ 
                        backgroundColor: quickMood === score ? colors.accentLight : colors.bg,
                        border: quickMood === score ? `2px solid ${colors.accent}` : '2px solid transparent',
                      }}
                    >
                      {score === 1 ? '😫' : score === 2 ? '😔' : score === 3 ? '😐' : score === 4 ? '🙂' : '😄'}
                    </motion.button>
                  ))}
                </div>
              </div>

              {/* 睡眠入力 */}
              <div className="mb-8">
                <label className="block text-sm font-medium mb-2" style={{ color: colors.textLight }}>
                  昨夜の睡眠
                </label>
                <div className="flex justify-between gap-2">
                  {[1, 2, 3, 4, 5].map((score) => (
                    <motion.button
                      key={score}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => setQuickSleep(quickSleep === score ? null : score)}
                      className="flex-1 py-3 rounded-xl text-2xl"
                      style={{ 
                        backgroundColor: quickSleep === score ? colors.purpleLight : colors.bg,
                        border: quickSleep === score ? `2px solid ${colors.purple}` : '2px solid transparent',
                      }}
                    >
                      {score === 1 ? '😵' : score === 2 ? '😪' : score === 3 ? '😴' : score === 4 ? '😌' : '🌟'}
                    </motion.button>
                  ))}
                </div>
              </div>

              {/* 保存ボタン */}
              <motion.button
                whileTap={{ scale: 0.98 }}
                onClick={handleQuickSave}
                disabled={saving || (!quickWeight && quickMood === null && quickSleep === null)}
                className="w-full py-4 rounded-xl font-bold text-white disabled:opacity-50"
                style={{ backgroundColor: colors.accent }}
              >
                {saving ? '保存中...' : '記録する'}
              </motion.button>

              <Link href="/health/record">
                <p className="text-center mt-4 text-sm" style={{ color: colors.accent }}>
                  もっと詳しく記録する →
                </p>
              </Link>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
