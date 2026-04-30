"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Flame, Award, ChevronRight, Activity, CheckCircle2, Calendar,
} from "lucide-react";

const colors = {
  bg: "#FAF9F7",
  card: "#FFFFFF",
  text: "#1A1A1A",
  textLight: "#4A4A4A",
  textMuted: "#9A9A9A",
  accent: "#E07A5F",
  accentLight: "#FDF0ED",
  success: "#4CAF50",
  successLight: "#E8F5E9",
  warning: "#FF9800",
  warningLight: "#FFF3E0",
  error: "#F44336",
  errorLight: "#FFEBEE",
  purple: "#7C4DFF",
  purpleLight: "#EDE7F6",
  blue: "#2196F3",
  blueLight: "#E3F2FD",
  border: "#EEEEEE",
  streak: "#FF6B35",
};

interface StreakData {
  current_streak: number;
  longest_streak: number;
  achieved_badges: string[];
  total_records: number;
  streak_type: string;
  last_activity_date?: string | null;
  streak_start_date?: string | null;
}

const BADGE_MILESTONES = [7, 14, 30, 60, 100];

function BadgeCard({ days, achieved }: { days: number; achieved: boolean }) {
  return (
    <motion.div
      className="p-3 rounded-xl flex flex-col items-center gap-1"
      style={{
        backgroundColor: achieved ? colors.accentLight : colors.bg,
        border: achieved ? `1.5px solid ${colors.accent}` : `1.5px solid ${colors.border}`,
      }}
    >
      <Award size={28} style={{ color: achieved ? colors.accent : colors.textMuted }} />
      <p className="text-sm font-bold" style={{ color: achieved ? colors.accent : colors.textMuted }}>
        {days}日
      </p>
      {achieved ? (
        <CheckCircle2 size={14} style={{ color: colors.success }} />
      ) : (
        <p className="text-xs" style={{ color: colors.textMuted }}>未達成</p>
      )}
    </motion.div>
  );
}

export default function StreaksPage() {
  const [streak, setStreak] = useState<StreakData | null>(null);
  const [nextBadge, setNextBadge] = useState<number | null>(null);
  const [daysToNextBadge, setDaysToNextBadge] = useState<number | null>(null);
  const [weeklyRecords, setWeeklyRecords] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStreak = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/health/streaks");
      if (!res.ok) throw new Error("データの取得に失敗しました");
      const data = await res.json();
      setStreak(data.streak);
      setNextBadge(data.nextBadge ?? null);
      setDaysToNextBadge(data.daysToNextBadge ?? null);
      setWeeklyRecords(data.weeklyRecords || []);
    } catch (e: any) {
      setError(e.message ?? "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStreak();
  }, [fetchStreak]);

  // 過去7日間のカレンダー生成
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - i));
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return {
      date: dateStr,
      day: ["日", "月", "火", "水", "木", "金", "土"][date.getDay()],
      dayNum: date.getDate(),
      isToday: i === 6,
      hasRecord: weeklyRecords.includes(dateStr),
    };
  });

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: colors.bg }}>
        <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
          <Activity size={32} style={{ color: colors.accent }} />
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-24" style={{ backgroundColor: colors.bg }}>
      {/* ヘッダー */}
      <div className="px-4 pt-6 pb-4">
        <div className="flex items-center gap-2 mb-1">
          <Link href="/health" className="text-sm" style={{ color: colors.accent }}>
            健康記録
          </Link>
          <ChevronRight size={14} style={{ color: colors.textMuted }} />
          <span className="text-sm" style={{ color: colors.textMuted }}>連続記録</span>
        </div>
        <h1 className="text-2xl font-bold" style={{ color: colors.text }}>連続記録</h1>
        <p className="text-sm mt-1" style={{ color: colors.textMuted }}>
          毎日の記録を続けてバッジを獲得しましょう
        </p>
      </div>

      {error && (
        <div className="mx-4 mb-4 p-4 rounded-xl flex items-center gap-3" style={{ backgroundColor: colors.errorLight }}>
          <Activity size={20} style={{ color: colors.error }} />
          <p className="text-sm" style={{ color: colors.error }}>{error}</p>
        </div>
      )}

      {/* メインカード: 連続日数 */}
      <div className="px-4 mb-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-5 rounded-2xl"
          style={{
            background: `linear-gradient(135deg, ${colors.accent} 0%, ${colors.streak} 100%)`,
          }}
        >
          <div className="flex items-center gap-2 mb-2">
            <Flame size={22} color="white" />
            <span className="text-white/80 text-sm font-medium">現在の連続記録</span>
          </div>
          <div className="flex items-end gap-2 mb-1">
            <span className="text-5xl font-bold text-white">
              {streak?.current_streak ?? 0}
            </span>
            <span className="text-white/80 text-lg mb-1">日</span>
          </div>
          <p className="text-white/60 text-sm">
            最長記録: {streak?.longest_streak ?? 0}日 · 累計: {streak?.total_records ?? 0}回
          </p>

          {nextBadge != null && daysToNextBadge != null && daysToNextBadge > 0 && (
            <div className="mt-4 bg-white/20 rounded-xl p-3 flex items-center gap-3">
              <Award size={22} color="white" />
              <div>
                <p className="text-white text-sm font-medium">次のバッジまで あと {daysToNextBadge}日</p>
                <p className="text-white/70 text-xs">{nextBadge}日達成バッジ</p>
              </div>
            </div>
          )}
        </motion.div>
      </div>

      {/* 週間カレンダー */}
      <div className="px-4 mb-4">
        <h2 className="font-semibold mb-3" style={{ color: colors.text }}>今週の記録</h2>
        <div
          className="p-4 rounded-2xl"
          style={{ backgroundColor: colors.card, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}
        >
          <div className="flex gap-2">
            {weekDays.map((day) => (
              <div
                key={day.date}
                className="flex-1 flex flex-col items-center gap-1 py-2 rounded-xl"
                style={{
                  backgroundColor: day.hasRecord
                    ? colors.accentLight
                    : day.isToday
                    ? colors.bg
                    : "transparent",
                  border: day.isToday ? `1.5px solid ${colors.accent}` : "1.5px solid transparent",
                }}
              >
                <span className="text-xs" style={{ color: colors.textMuted }}>{day.day}</span>
                <span className="text-sm font-bold" style={{ color: day.hasRecord ? colors.accent : colors.text }}>
                  {day.dayNum}
                </span>
                {day.hasRecord ? (
                  <CheckCircle2 size={14} style={{ color: colors.success }} />
                ) : (
                  <div className="w-3.5 h-3.5 rounded-full border" style={{ borderColor: colors.border }} />
                )}
              </div>
            ))}
          </div>
          <p className="text-xs text-center mt-3" style={{ color: colors.textMuted }}>
            今週 {weeklyRecords.length}/7 日記録済み
          </p>
        </div>
      </div>

      {/* バッジ一覧 */}
      <div className="px-4 mb-4">
        <h2 className="font-semibold mb-3" style={{ color: colors.text }}>バッジ</h2>
        <div className="grid grid-cols-5 gap-2">
          {BADGE_MILESTONES.map((days) => (
            <BadgeCard
              key={days}
              days={days}
              achieved={(streak?.achieved_badges ?? []).includes(`${days}_days`)}
            />
          ))}
        </div>
      </div>

      {/* 記録へのリンク */}
      <div className="px-4">
        <Link href="/health/record">
          <motion.div
            whileTap={{ scale: 0.98 }}
            className="p-4 rounded-2xl flex items-center justify-between"
            style={{ backgroundColor: colors.card, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: colors.accentLight }}>
                <Calendar size={20} style={{ color: colors.accent }} />
              </div>
              <div>
                <p className="font-semibold" style={{ color: colors.text }}>今日の記録をつける</p>
                <p className="text-sm" style={{ color: colors.textMuted }}>連続記録を維持しよう</p>
              </div>
            </div>
            <ChevronRight size={20} style={{ color: colors.textMuted }} />
          </motion.div>
        </Link>
      </div>
    </div>
  );
}
