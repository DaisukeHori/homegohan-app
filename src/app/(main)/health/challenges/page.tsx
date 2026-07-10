"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft, Trophy, Target, Flame, Calendar, Plus,
  CheckCircle2, Clock, X, Sparkles, Star
} from 'lucide-react';

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
  purple: '#7C4DFF',
  purpleLight: '#EDE7F6',
  blue: '#2196F3',
  blueLight: '#E3F2FD',
  border: '#EEEEEE',
};

interface Challenge {
  id: string;
  challenge_type: string;
  title: string;
  description?: string;
  start_date: string;
  end_date: string;
  target_metric: string;
  target_value: number;
  target_unit: string;
  current_value: number;
  daily_progress?: any[];
  reward_points?: number;
  reward_badge?: string;
  reward_description?: string;
  status: string;
  completed_at?: string;
}

interface ChallengeTemplate {
  id: string;
  type: string;
  title: string;
  description: string;
  metric: string;
  default_target: number;
  unit: string;
  duration_days: number;
  reward_points: number;
  reward_badge: string;
  reward_description: string;
  difficulty: string;
  emoji: string;
}

export default function HealthChallengesPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [templates, setTemplates] = useState<ChallengeTemplate[]>([]);
  const [showNewChallenge, setShowNewChallenge] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<ChallengeTemplate | null>(null);

  useEffect(() => {
    fetchChallenges();
  }, []);

  const fetchChallenges = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/health/challenges?status=all');
      if (res.ok) {
        const data = await res.json();
        setChallenges(data.challenges || []);
        setTemplates(data.templates || []);
      }
    } catch (error) {
      console.error('Failed to fetch challenges:', error);
    }
    setLoading(false);
  };

  const handleCreateChallenge = async (templateId: string) => {
    setCreating(true);
    try {
      const res = await fetch('/api/health/challenges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: templateId }),
      });

      if (res.ok) {
        setShowNewChallenge(false);
        setSelectedTemplate(null);
        fetchChallenges();
      }
    } catch (error) {
      console.error('Failed to create challenge:', error);
    }
    setCreating(false);
  };

  const activeChallenges = challenges.filter(c => c.status === 'active');
  const completedChallenges = challenges.filter(c => c.status === 'completed');
  // #1055 UX3-16: 獲得ptの行き先が無かったため、達成したチャレンジの合計を表示する
  const totalEarnedPoints = completedChallenges.reduce((sum, c) => sum + (c.reward_points || 0), 0);

  const getDaysRemaining = (endDate: string) => {
    const end = new Date(endDate);
    const now = new Date();
    const diff = Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return diff;
  };

  const getProgressPercentage = (challenge: Challenge) => {
    if (challenge.target_value === 0) return 0;
    return Math.min(100, (challenge.current_value / challenge.target_value) * 100);
  };

  const getDifficultyColor = (difficulty: string) => {
    switch (difficulty) {
      case 'easy': return colors.success;
      case 'medium': return colors.warning;
      case 'hard': return colors.error;
      default: return colors.textMuted;
    }
  };

  return (
    <div className="min-h-screen pb-24" style={{ backgroundColor: colors.bg }}>
      {/* ヘッダー */}
      <div className="sticky top-0 z-10 px-4 py-4 flex items-center justify-between" style={{ backgroundColor: colors.bg }}>
        <div className="flex items-center">
          <button onClick={() => router.back()} className="p-2 -ml-2">
            <ArrowLeft size={24} style={{ color: colors.text }} />
          </button>
          <h1 className="font-bold ml-2" style={{ color: colors.text }}>チャレンジ</h1>
        </div>
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={() => setShowNewChallenge(true)}
          className="p-2 rounded-lg"
          style={{ backgroundColor: colors.accentLight }}
        >
          <Plus size={24} style={{ color: colors.accent }} />
        </motion.button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin w-8 h-8 border-2 border-accent border-t-transparent rounded-full" />
        </div>
      ) : (
        <>
          {/* #1055 UX3-16: 獲得ptの行き先表示 */}
          {totalEarnedPoints > 0 && (
            <div className="px-4 mb-4">
              <div
                className="p-3 rounded-xl flex items-center gap-3"
                style={{ backgroundColor: colors.warningLight }}
              >
                <Star size={20} style={{ color: colors.warning }} />
                <div>
                  <p className="text-xs" style={{ color: colors.textMuted }}>累計獲得ポイント</p>
                  <p className="text-lg font-bold" style={{ color: colors.warning }}>{totalEarnedPoints} pt</p>
                </div>
              </div>
            </div>
          )}

          {/* アクティブなチャレンジ */}
          <div className="px-4 mb-6">
            <h2 className="font-semibold mb-3" style={{ color: colors.text }}>
              進行中のチャレンジ
            </h2>
            {activeChallenges.length === 0 ? (
              <div 
                className="p-6 rounded-2xl text-center"
                style={{ backgroundColor: colors.card }}
              >
                <Trophy size={48} className="mx-auto mb-3" style={{ color: colors.textMuted }} />
                <p className="font-medium mb-1" style={{ color: colors.text }}>
                  チャレンジに参加しよう！
                </p>
                <p className="text-sm mb-4" style={{ color: colors.textMuted }}>
                  目標を設定して健康習慣を身につけましょう
                </p>
                <motion.button
                  whileTap={{ scale: 0.95 }}
                  onClick={() => setShowNewChallenge(true)}
                  className="px-6 py-2 rounded-lg font-medium text-white"
                  style={{ backgroundColor: colors.accent }}
                >
                  チャレンジを選ぶ
                </motion.button>
              </div>
            ) : (
              <div className="space-y-3">
                {activeChallenges.map((challenge) => {
                  const daysRemaining = getDaysRemaining(challenge.end_date);
                  // #1055 UX3-16: 期限切れの場合「残り-3日」のような負数表示にせず、期限切れバッジ+グレーアウトにする
                  const isExpired = daysRemaining < 0;
                  const progress = getProgressPercentage(challenge);

                  return (
                    <motion.div
                      key={challenge.id}
                      className="p-4 rounded-2xl"
                      style={{
                        backgroundColor: colors.card,
                        opacity: isExpired ? 0.6 : 1,
                      }}
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <p className="font-semibold" style={{ color: colors.text }}>
                            {challenge.title}
                          </p>
                          <p className="text-sm" style={{ color: colors.textMuted }}>
                            {challenge.description}
                          </p>
                        </div>
                        {isExpired ? (
                          <div className="flex items-center gap-1 px-2 py-1 rounded-full" style={{ backgroundColor: colors.border }}>
                            <Clock size={12} style={{ color: colors.textMuted }} />
                            <span className="text-xs font-medium" style={{ color: colors.textMuted }}>
                              期限切れ
                            </span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 px-2 py-1 rounded-full" style={{ backgroundColor: colors.warningLight }}>
                            <Clock size={12} style={{ color: colors.warning }} />
                            <span className="text-xs font-medium" style={{ color: colors.warning }}>
                              残り{daysRemaining}日
                            </span>
                          </div>
                        )}
                      </div>

                      {/* 進捗バー */}
                      <div className="mb-3">
                        <div className="relative h-3 rounded-full overflow-hidden" style={{ backgroundColor: colors.bg }}>
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${progress}%` }}
                            className="absolute left-0 top-0 h-full rounded-full"
                            style={{ backgroundColor: colors.accent }}
                          />
                        </div>
                      </div>

                      <div className="flex items-center justify-between">
                        <span className="text-sm" style={{ color: colors.textMuted }}>
                          {challenge.current_value} / {challenge.target_value} {challenge.target_unit}
                        </span>
                        <span className="text-sm font-medium" style={{ color: colors.accent }}>
                          {progress.toFixed(0)}%
                        </span>
                      </div>

                      {challenge.reward_description && (
                        <div 
                          className="mt-3 pt-3 border-t flex items-center gap-2"
                          style={{ borderColor: colors.border }}
                        >
                          <Star size={14} style={{ color: colors.warning }} />
                          <span className="text-xs" style={{ color: colors.textMuted }}>
                            {challenge.reward_description}
                          </span>
                        </div>
                      )}
                    </motion.div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 完了したチャレンジ */}
          {completedChallenges.length > 0 && (
            <div className="px-4 mb-6">
              <h2 className="font-semibold mb-3" style={{ color: colors.text }}>
                達成したチャレンジ 🎉
              </h2>
              <div className="space-y-3">
                {completedChallenges.map((challenge) => (
                  <div
                    key={challenge.id}
                    className="p-4 rounded-2xl"
                    style={{ backgroundColor: colors.successLight }}
                  >
                    <div className="flex items-center gap-3">
                      <div 
                        className="w-10 h-10 rounded-lg flex items-center justify-center"
                        style={{ backgroundColor: colors.success }}
                      >
                        <CheckCircle2 size={20} color="white" />
                      </div>
                      <div>
                        <p className="font-semibold" style={{ color: colors.success }}>
                          {challenge.title}
                        </p>
                        <p className="text-sm" style={{ color: colors.success }}>
                          {challenge.target_value}{challenge.target_unit} 達成！
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* 新規チャレンジモーダル */}
      <AnimatePresence>
        {showNewChallenge && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 z-[60] flex items-end"
            onClick={() => {
              setShowNewChallenge(false);
              setSelectedTemplate(null);
            }}
          >
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25 }}
              className="w-full max-h-[80vh] overflow-y-auto rounded-t-3xl p-6 pb-28"
              style={{ backgroundColor: colors.card }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-12 h-1 bg-gray-300 rounded-full mx-auto mb-6" />
              
              <h2 className="text-xl font-bold mb-6" style={{ color: colors.text }}>
                チャレンジを選ぶ
              </h2>

              {selectedTemplate ? (
                // 確認画面
                <div>
                  <div 
                    className="p-6 rounded-2xl mb-6"
                    style={{ backgroundColor: colors.accentLight }}
                  >
                    <div className="text-center">
                      <span className="text-4xl mb-3 block">{selectedTemplate.emoji}</span>
                      <h3 className="text-xl font-bold mb-2" style={{ color: colors.accent }}>
                        {selectedTemplate.title}
                      </h3>
                      <p className="text-sm mb-4" style={{ color: colors.textLight }}>
                        {selectedTemplate.description}
                      </p>
                      <div className="flex items-center justify-center gap-4">
                        <div className="text-center">
                          <p className="text-2xl font-bold" style={{ color: colors.accent }}>
                            {selectedTemplate.default_target}
                          </p>
                          <p className="text-xs" style={{ color: colors.textMuted }}>
                            {selectedTemplate.unit}
                          </p>
                        </div>
                        <div className="text-center">
                          <p className="text-2xl font-bold" style={{ color: colors.accent }}>
                            {selectedTemplate.duration_days}
                          </p>
                          <p className="text-xs" style={{ color: colors.textMuted }}>日間</p>
                        </div>
                        <div className="text-center">
                          <p className="text-2xl font-bold" style={{ color: colors.accent }}>
                            {selectedTemplate.reward_points}
                          </p>
                          <p className="text-xs" style={{ color: colors.textMuted }}>pt</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-3">
                    <motion.button
                      whileTap={{ scale: 0.95 }}
                      onClick={() => setSelectedTemplate(null)}
                      className="flex-1 py-3 rounded-xl font-medium"
                      style={{ backgroundColor: colors.bg, color: colors.textLight }}
                    >
                      戻る
                    </motion.button>
                    <motion.button
                      whileTap={{ scale: 0.95 }}
                      onClick={() => handleCreateChallenge(selectedTemplate.id)}
                      disabled={creating}
                      className="flex-1 py-3 rounded-xl font-bold text-white"
                      style={{ backgroundColor: colors.accent }}
                    >
                      {creating ? '開始中...' : 'チャレンジ開始！'}
                    </motion.button>
                  </div>
                </div>
              ) : (
                // テンプレート一覧
                <div className="space-y-3">
                  {templates.map((template) => (
                    <motion.button
                      key={template.id}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setSelectedTemplate(template)}
                      className="w-full p-4 rounded-xl text-left flex items-center gap-4"
                      style={{ backgroundColor: colors.bg }}
                    >
                      <span className="text-3xl">{template.emoji}</span>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <p className="font-semibold" style={{ color: colors.text }}>
                            {template.title}
                          </p>
                          <span 
                            className="px-2 py-0.5 rounded-full text-xs font-medium"
                            style={{ 
                              backgroundColor: `${getDifficultyColor(template.difficulty)}20`,
                              color: getDifficultyColor(template.difficulty),
                            }}
                          >
                            {template.difficulty === 'easy' ? '初級' : 
                             template.difficulty === 'medium' ? '中級' : '上級'}
                          </span>
                        </div>
                        <p className="text-sm" style={{ color: colors.textMuted }}>
                          {template.description}
                        </p>
                        <div className="flex items-center gap-3 mt-1">
                          <span className="text-xs" style={{ color: colors.textMuted }}>
                            {template.duration_days}日間
                          </span>
                          <span className="text-xs" style={{ color: colors.warning }}>
                            🏆 {template.reward_points}pt
                          </span>
                        </div>
                      </div>
                    </motion.button>
                  ))}
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

