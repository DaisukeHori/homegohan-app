"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft, Target, Plus, Scale, Percent, Footprints,
  Trophy, Calendar, CheckCircle2, X, Trash2, Edit2
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

interface HealthGoal {
  id: string;
  goal_type: string;
  target_value: number;
  target_unit: string;
  start_value?: number;
  current_value?: number;
  progress_percentage?: number;
  target_date?: string;
  status: string;
  milestones?: { value: number; achieved_at: string }[];
  note?: string;
}

const GOAL_TYPES = [
  { type: 'weight', label: '体重', unit: 'kg', icon: Scale, color: colors.accent },
  { type: 'body_fat', label: '体脂肪率', unit: '%', icon: Percent, color: colors.purple },
  { type: 'steps', label: '1日の歩数', unit: '歩', icon: Footprints, color: colors.blue },
];

export default function HealthGoalsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [goals, setGoals] = useState<HealthGoal[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newGoal, setNewGoal] = useState({
    goal_type: 'weight',
    target_value: '',
    target_date: '',
  });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchGoals();
  }, []);

  const fetchGoals = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/health/goals?status=all');
      if (res.ok) {
        const data = await res.json();
        setGoals(data.goals || []);
      }
    } catch (error) {
      console.error('Failed to fetch goals:', error);
    }
    setLoading(false);
  };

  const handleCreateGoal = async () => {
    if (!newGoal.target_value) return;

    setCreating(true);
    try {
      const goalType = GOAL_TYPES.find(t => t.type === newGoal.goal_type);
      const res = await fetch('/api/health/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal_type: newGoal.goal_type,
          target_value: parseFloat(newGoal.target_value),
          target_unit: goalType?.unit || '',
          target_date: newGoal.target_date || null,
        }),
      });

      if (res.ok) {
        setShowCreateModal(false);
        setNewGoal({ goal_type: 'weight', target_value: '', target_date: '' });
        fetchGoals();
      }
    } catch (error) {
      console.error('Failed to create goal:', error);
    }
    setCreating(false);
  };

  const handleDeleteGoal = async (id: string) => {
    if (!confirm('この目標を削除しますか？')) return;

    try {
      const res = await fetch(`/api/health/goals/${id}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        fetchGoals();
      }
    } catch (error) {
      console.error('Failed to delete goal:', error);
    }
  };

  const activeGoals = goals.filter(g => g.status === 'active');
  const achievedGoals = goals.filter(g => g.status === 'achieved');

  const getGoalConfig = (type: string) => {
    return GOAL_TYPES.find(t => t.type === type) || GOAL_TYPES[0];
  };

  return (
    <div className="min-h-screen pb-24" style={{ backgroundColor: colors.bg }}>
      {/* ヘッダー */}
      <div className="sticky top-0 z-10 px-4 py-4 flex items-center justify-between" style={{ backgroundColor: colors.bg }}>
        <div className="flex items-center">
          <button onClick={() => router.back()} className="p-2 -ml-2">
            <ArrowLeft size={24} style={{ color: colors.text }} />
          </button>
          <h1 className="font-bold ml-2" style={{ color: colors.text }}>目標管理</h1>
        </div>
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={() => setShowCreateModal(true)}
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
          {/* アクティブな目標 */}
          <div className="px-4 mb-6">
            <h2 className="font-semibold mb-3" style={{ color: colors.text }}>
              進行中の目標
            </h2>
            {activeGoals.length === 0 ? (
              <div 
                className="p-6 rounded-2xl text-center"
                style={{ backgroundColor: colors.card }}
              >
                <Target size={48} className="mx-auto mb-3" style={{ color: colors.textMuted }} />
                <p className="font-medium mb-1" style={{ color: colors.text }}>
                  目標がありません
                </p>
                <p className="text-sm mb-4" style={{ color: colors.textMuted }}>
                  新しい目標を設定して健康管理を始めましょう
                </p>
                <motion.button
                  whileTap={{ scale: 0.95 }}
                  onClick={() => setShowCreateModal(true)}
                  className="px-6 py-2 rounded-lg font-medium text-white"
                  style={{ backgroundColor: colors.accent }}
                >
                  目標を設定する
                </motion.button>
              </div>
            ) : (
              <div className="space-y-3">
                {activeGoals.map((goal) => {
                  const config = getGoalConfig(goal.goal_type);
                  const Icon = config.icon;
                  return (
                    <motion.div
                      key={goal.id}
                      className="p-4 rounded-2xl"
                      style={{ backgroundColor: colors.card }}
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <div 
                            className="w-10 h-10 rounded-lg flex items-center justify-center"
                            style={{ backgroundColor: `${config.color}20` }}
                          >
                            <Icon size={20} style={{ color: config.color }} />
                          </div>
                          <div>
                            <p className="font-semibold" style={{ color: colors.text }}>
                              {config.label}
                            </p>
                            <p className="text-sm" style={{ color: colors.textMuted }}>
                              目標: {goal.target_value}{goal.target_unit}
                            </p>
                          </div>
                        </div>
                        <button
                          onClick={() => handleDeleteGoal(goal.id)}
                          className="p-2"
                        >
                          <Trash2 size={18} style={{ color: colors.textMuted }} />
                        </button>
                      </div>

                      {/* 進捗バー */}
                      <div className="mb-2">
                        <div className="relative h-3 rounded-full overflow-hidden" style={{ backgroundColor: colors.bg }}>
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${Math.min(goal.progress_percentage || 0, 100)}%` }}
                            className="absolute left-0 top-0 h-full rounded-full"
                            style={{ backgroundColor: config.color }}
                          />
                        </div>
                      </div>

                      <div className="flex items-center justify-between">
                        <span className="text-sm" style={{ color: colors.textMuted }}>
                          現在: {goal.current_value || goal.start_value || '-'}{goal.target_unit}
                        </span>
                        <span className="text-sm font-medium" style={{ color: config.color }}>
                          {(goal.progress_percentage || 0).toFixed(0)}%
                        </span>
                      </div>

                      {goal.target_date && (
                        <div className="flex items-center gap-1 mt-2">
                          <Calendar size={14} style={{ color: colors.textMuted }} />
                          <span className="text-xs" style={{ color: colors.textMuted }}>
                            期限: {new Date(goal.target_date).toLocaleDateString('ja-JP')}
                          </span>
                        </div>
                      )}

                      {/* マイルストーン */}
                      {goal.milestones && goal.milestones.length > 0 && (
                        <div className="mt-3 pt-3 border-t" style={{ borderColor: colors.border }}>
                          <p className="text-xs font-medium mb-2" style={{ color: colors.textMuted }}>
                            達成マイルストーン
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {goal.milestones.map((m, i) => (
                              <span
                                key={i}
                                className="px-2 py-1 rounded-full text-xs"
                                style={{ backgroundColor: colors.successLight, color: colors.success }}
                              >
                                ✓ {m.value}{goal.target_unit}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </motion.div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 達成した目標 */}
          {achievedGoals.length > 0 && (
            <div className="px-4 mb-6">
              <h2 className="font-semibold mb-3" style={{ color: colors.text }}>
                達成した目標 🎉
              </h2>
              <div className="space-y-3">
                {achievedGoals.map((goal) => {
                  const config = getGoalConfig(goal.goal_type);
                  const Icon = config.icon;
                  return (
                    <div
                      key={goal.id}
                      className="p-4 rounded-2xl"
                      style={{ backgroundColor: colors.successLight }}
                    >
                      <div className="flex items-center gap-3">
                        <div 
                          className="w-10 h-10 rounded-lg flex items-center justify-center"
                          style={{ backgroundColor: colors.success }}
                        >
                          <Trophy size={20} color="white" />
                        </div>
                        <div>
                          <p className="font-semibold" style={{ color: colors.success }}>
                            {config.label} 目標達成！
                          </p>
                          <p className="text-sm" style={{ color: colors.success }}>
                            {goal.target_value}{goal.target_unit} を達成
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {/* 目標作成モーダル */}
      <AnimatePresence>
        {showCreateModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 z-50 flex items-end"
            onClick={() => setShowCreateModal(false)}
          >
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25 }}
              className="w-full rounded-t-3xl p-6 pb-10"
              style={{ backgroundColor: colors.card }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-12 h-1 bg-gray-300 rounded-full mx-auto mb-6" />
              
              <h2 className="text-xl font-bold mb-6" style={{ color: colors.text }}>
                新しい目標を設定
              </h2>

              {/* 目標タイプ選択 */}
              <div className="mb-6">
                <label className="block text-sm font-medium mb-2" style={{ color: colors.textLight }}>
                  目標の種類
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {GOAL_TYPES.map((type) => {
                    const Icon = type.icon;
                    return (
                      <motion.button
                        key={type.type}
                        whileTap={{ scale: 0.95 }}
                        onClick={() => setNewGoal({ ...newGoal, goal_type: type.type })}
                        className="p-3 rounded-xl text-center"
                        style={{
                          backgroundColor: newGoal.goal_type === type.type ? `${type.color}20` : colors.bg,
                          border: newGoal.goal_type === type.type ? `2px solid ${type.color}` : '2px solid transparent',
                        }}
                      >
                        <Icon 
                          size={24} 
                          className="mx-auto mb-1"
                          style={{ color: newGoal.goal_type === type.type ? type.color : colors.textMuted }} 
                        />
                        <span 
                          className="text-xs font-medium"
                          style={{ color: newGoal.goal_type === type.type ? type.color : colors.textMuted }}
                        >
                          {type.label}
                        </span>
                      </motion.button>
                    );
                  })}
                </div>
              </div>

              {/* 目標値 */}
              <div className="mb-6">
                <label className="block text-sm font-medium mb-2" style={{ color: colors.textLight }}>
                  目標値
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    step="0.1"
                    value={newGoal.target_value}
                    onChange={(e) => setNewGoal({ ...newGoal, target_value: e.target.value })}
                    placeholder={newGoal.goal_type === 'weight' ? '60.0' : newGoal.goal_type === 'body_fat' ? '20.0' : '10000'}
                    className="flex-1 p-4 rounded-xl text-xl font-bold"
                    style={{ backgroundColor: colors.bg, color: colors.text }}
                  />
                  <span className="text-lg" style={{ color: colors.textMuted }}>
                    {GOAL_TYPES.find(t => t.type === newGoal.goal_type)?.unit}
                  </span>
                </div>
              </div>

              {/* 期限（オプション） */}
              <div className="mb-8">
                <label className="block text-sm font-medium mb-2" style={{ color: colors.textLight }}>
                  期限（オプション）
                </label>
                <input
                  type="date"
                  value={newGoal.target_date}
                  onChange={(e) => setNewGoal({ ...newGoal, target_date: e.target.value })}
                  min={new Date().toISOString().split('T')[0]}
                  className="w-full p-4 rounded-xl"
                  style={{ backgroundColor: colors.bg, color: colors.text }}
                />
              </div>

              {/* 作成ボタン */}
              <motion.button
                whileTap={{ scale: 0.98 }}
                onClick={handleCreateGoal}
                disabled={creating || !newGoal.target_value}
                className="w-full py-4 rounded-xl font-bold text-white disabled:opacity-50"
                style={{ backgroundColor: colors.accent }}
              >
                {creating ? '作成中...' : '目標を設定する'}
              </motion.button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

