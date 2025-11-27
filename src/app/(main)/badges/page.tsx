"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/types/domain";

// 拡張型定義
interface BadgeWithStatus extends Badge {
  earned: boolean;
  obtainedAt?: string;
  icon?: string; // マッピング用
}

// アイコンマッピング（コードベース）
const ICON_MAP: Record<string, string> = {
  'first_bite': '🥄',
  'streak_3': '🔥',
  'streak_7': '📅',
  'streak_30': '📆',
  'photo_10': '📸',
  'early_bird': '🌅',
  'night_guard': '🦉',
  'veggie_5': '🥗',
  'protein_5': '💪',
  'balance_king': '⚖️',
  'chef_soul': '🍳',
  'rainbow': '🌈',
  'hello_ai': '🤖',
  'planner': '📝',
  'legend_100': '👑',
};

// ランク定義
const RANKS = [
  { name: "食の初心者", min: 0, color: "bg-gray-400" },
  { name: "健康ルーキー", min: 3, color: "bg-green-400" },
  { name: "バランスの達人", min: 8, color: "bg-blue-400" },
  { name: "栄養マスター", min: 15, color: "bg-purple-400" },
  { name: "食のレジェンド", min: 25, color: "bg-yellow-400" },
];

export default function BadgesPage() {
  const [badges, setBadges] = useState<BadgeWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [earnedCount, setEarnedCount] = useState(0);
  const [newEarned, setNewEarned] = useState(false);

  useEffect(() => {
    const fetchBadges = async () => {
      try {
        const res = await fetch('/api/badges');
        if (!res.ok) throw new Error('Failed');
        const data = await res.json();
        
        const mappedBadges = data.badges.map((b: any) => ({
          ...b,
          icon: ICON_MAP[b.code] || '🏅'
        }));

        setBadges(mappedBadges);
        setEarnedCount(mappedBadges.filter((b: any) => b.earned).length);
        
        if (data.newEarnedCount > 0) {
          setNewEarned(true);
          setTimeout(() => setNewEarned(false), 5000); // 5秒後に非表示
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    fetchBadges();
  }, []);

  // ランク計算
  const currentRankIndex = RANKS.findIndex((r, i) => 
    earnedCount >= r.min && (i === RANKS.length - 1 || earnedCount < RANKS[i+1].min)
  );
  const currentRank = RANKS[currentRankIndex] || RANKS[0];
  const nextRank = RANKS[currentRankIndex + 1];
  const progress = nextRank 
    ? ((earnedCount - currentRank.min) / (nextRank.min - currentRank.min)) * 100 
    : 100;

  return (
    <div className="min-h-screen bg-gray-50 pb-24 relative overflow-hidden">
      
      {/* お祝いエフェクト（新規獲得時） */}
      <AnimatePresence>
        {newEarned && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 pointer-events-none z-[60] flex items-center justify-center"
          >
            <div className="absolute inset-0 bg-black/20" />
            <motion.div 
              initial={{ scale: 0.5, y: 50 }} animate={{ scale: 1, y: 0 }}
              className="bg-white p-8 rounded-3xl shadow-2xl text-center"
            >
              <div className="text-6xl mb-4">🎊</div>
              <h2 className="text-2xl font-bold text-gray-900">新しいバッジを獲得！</h2>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ヘッダー */}
      <div className="bg-white p-6 pb-12 rounded-b-[40px] shadow-sm mb-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">トロフィールーム</h1>
        <p className="text-gray-500">
          これまでの達成記録です。
        </p>
        
        {/* レベルプログレス */}
        <div className="mt-8 flex items-center gap-4">
          <div className={`w-14 h-14 rounded-full ${currentRank.color} flex items-center justify-center text-white font-bold text-lg shadow-lg ring-4 ring-white`}>
            {currentRankIndex + 1}
          </div>
          <div className="flex-1">
            <div className="flex justify-between items-end mb-2">
              <div>
                <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">現在のランク</span>
                <p className="font-bold text-gray-900">{currentRank.name}</p>
              </div>
              {nextRank && (
                <span className="text-xs font-bold text-[#FF8A65]">次は: {nextRank.name}</span>
              )}
            </div>
            <div className="h-3 w-full bg-gray-100 rounded-full overflow-hidden">
               <motion.div 
                 initial={{ width: 0 }} 
                 animate={{ width: `${progress}%` }} 
                 transition={{ duration: 1, ease: "easeOut" }}
                 className="h-full bg-gradient-to-r from-[#FF8A65] to-[#FF7043] rounded-full" 
               />
            </div>
            {nextRank && (
              <p className="text-xs text-right mt-1 text-gray-400">あと {nextRank.min - earnedCount} 個でランクアップ</p>
            )}
          </div>
        </div>
      </div>

      {/* バッジグリッド */}
      {loading ? (
        <div className="text-center text-gray-400 py-12">読み込み中...</div>
      ) : (
        <div className="px-6 grid grid-cols-2 md:grid-cols-3 gap-4">
          {badges.map((badge, i) => (
            <motion.div
              key={badge.code}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: i * 0.05 }}
              className={`aspect-square rounded-3xl p-4 flex flex-col items-center justify-center text-center relative overflow-hidden group transition-all duration-300 ${
                badge.earned 
                  ? 'bg-white shadow-md border border-gray-50 hover:shadow-lg hover:-translate-y-1' 
                  : 'bg-gray-100 opacity-60'
              }`}
            >
              {badge.earned && (
                 <div className="absolute inset-0 bg-gradient-to-tr from-orange-50 to-transparent opacity-50" />
              )}

              <div className={`text-5xl mb-4 transition-transform duration-300 ${badge.earned ? 'group-hover:scale-110 drop-shadow-md' : 'grayscale opacity-50 blur-[2px]'}`}>
                {badge.icon}
              </div>
              
              <h3 className={`font-bold text-sm mb-1 leading-tight ${badge.earned ? 'text-gray-900' : 'text-gray-500'}`}>
                {badge.name}
              </h3>
              
              {!badge.earned && (
                <div className="absolute inset-0 bg-black/5 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity backdrop-blur-sm p-2">
                   <p className="text-xs font-bold text-gray-700">{badge.description}</p>
                </div>
              )}
            </motion.div>
          ))}
        </div>
      )}

    </div>
  );
}
