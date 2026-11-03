"use client";

import { useState, useEffect } from "react";
import { todayLocal } from "@/lib/date-utils";
import {
  useAiConsultationDataRefetch,
  useAiConsultationLoading,
  useAiConsultationPendingWrites,
  type AiConsultationFetchTicket,
} from "@/hooks/useAiConsultationDataRefetch";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft, Target, Plus, Scale, Percent, Footprints,
  Trophy, Calendar, CheckCircle2, X, Trash2, Edit2
} from 'lucide-react';
import { GOAL_TYPE_DEFS } from '@/lib/health-goal-types';
import { STATUS_COLOR_TOKENS } from '@homegohan/shared';

const colors = {
  bg: '#FAF9F7',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textLight: '#4A4A4A',
  textMuted: '#9A9A9A',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  // 状態色 (#590): 塗り・枠線・アイコンは success など、文字は successText / warningText / dangerText
  ...STATUS_COLOR_TOKENS,
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

// 表示名・単位は @/lib/health-goal-types が単一ソース (health/page.tsx ダッシュボードと共通化)。
// アイコン・色は本画面固有の見た目情報のみここで補う。
const GOAL_TYPE_VISUALS: Record<string, { icon: typeof Scale; color: string }> = {
  weight: { icon: Scale, color: colors.accent },
  body_fat: { icon: Percent, color: colors.purple },
  steps: { icon: Footprints, color: colors.blue },
};

const GOAL_TYPES = GOAL_TYPE_DEFS.map((def) => ({
  ...def,
  icon: GOAL_TYPE_VISUALS[def.type]?.icon ?? Scale,
  color: GOAL_TYPE_VISUALS[def.type]?.color ?? colors.accent,
}));

/** 開いたとき・書き込みのあとの読み込み (読み込み中の表示を出す) か、AI 相談の成功の取り直し (出さない・失敗では今の表示を残す) か */
type GoalsFetchMode = 'mount' | 'refetch';

export default function HealthGoalsPage() {
  const router = useRouter();
  // 開いたとき・書き込みのあとの読み込み中の表示。その読み込み中に始まった AI 相談の成功の取り直しは、その読み込みの役
  // (失敗の表示・読み込み中の表示を下ろす) を引き継ぐ (#2201 U1。useAiConsultationLoading)
  const { loading, setLoading, refetchReadMode, settleLoading } = useAiConsultationLoading();
  const [goals, setGoals] = useState<HealthGoal[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newGoal, setNewGoal] = useState({
    goal_type: 'weight',
    target_value: '',
    target_date: '',
  });
  const [creating, setCreating] = useState(false);
  // #1229: サーバーが目標値の範囲外 (例: 体重 500kg) を 400 で返したとき、理由を画面に出す
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null); // #87: window.confirm 廃止
  // #1055 UX3-15: 目標を編集できるようにする
  const [editGoal, setEditGoal] = useState<HealthGoal | null>(null);
  const [editForm, setEditForm] = useState({ target_value: '', target_date: '' });
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // 削除の送信の応答を待っている間 (#2201 U2)。この間に来た AI 相談の成功では取り直さず、終わったら 1 回取り直す
  // (削除の前の一覧を読んだ取り直しの応答が、削除した目標を一覧に戻さないため)。始めた回数も数えるので、取り直しの応答を待つあいだに
  // 始めて終えた削除も見分ける (札の deferIfHeld)
  const pendingWrites = useAiConsultationPendingWrites();

  /**
   * 目標の一覧を読む。mode が 'refetch' (AI 相談の成功の取り直し。#2201 U1) なら、読み込み中の表示を出さずに読み直し、
   * 失敗 (通信の失敗・非 2xx) では今の表示を残す。応答を置くのは最後に始めた取得 (ticket.isLatest()) だけ。
   * 取り直しの応答を待つあいだに開いたモーダル・始めた削除があれば置かない (ticket.deferIfHeld。閉じた・終わったあとに 1 回取り直す)
   */
  const fetchGoals = async (ticket: AiConsultationFetchTicket, mode: GoalsFetchMode = 'mount') => {
    if (mode === 'mount') setLoading(true);
    try {
      const res = await fetch('/api/health/goals?status=all');
      if (res.ok) {
        const data = await res.json();
        if (!ticket.isLatest()) return;
        if (mode === 'refetch' && ticket.deferIfHeld()) return;
        setGoals(data.goals || []);
      }
    } catch (error) {
      console.error('Failed to fetch goals:', error);
    } finally {
      settleLoading(ticket);
    }
  };
  // AI 相談の提案の実行で健康目標が変わったら取り直す (#2195 V1)。作成・編集のモーダルが出ている間・削除の応答を待つ間は
  // 取り直さず、閉じた・終わったあとに 1 回取り直す (#2201 U2)
  const { beginFetch } = useAiConsultationDataRefetch(
    (ticket) => fetchGoals(ticket, refetchReadMode()),
    { writeInFlightRef: pendingWrites },
  );
  /** 開いたとき・作成・編集・削除のあとの読み込み (これまでどおり読み込み中の表示を出す) */
  const reloadGoals = () => fetchGoals(beginFetch());

  useEffect(() => {
    void reloadGoals();
    // 開いたときに 1 回だけ読む (これまでどおり)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openCreateModal = () => {
    setCreateError(null);
    setShowCreateModal(true);
  };

  const closeCreateModal = () => {
    setShowCreateModal(false);
    setCreateError(null);
  };

  const handleCreateGoal = async () => {
    if (!newGoal.target_value) return;

    setCreating(true);
    setCreateError(null);
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
        closeCreateModal();
        setNewGoal({ goal_type: 'weight', target_value: '', target_date: '' });
        void reloadGoals();
      } else {
        const data = await res.json().catch(() => null);
        setCreateError(data?.error || '目標の作成に失敗しました');
      }
    } catch (error) {
      console.error('Failed to create goal:', error);
      setCreateError('目標の作成に失敗しました');
    }
    setCreating(false);
  };

  const handleDeleteGoal = async (id: string) => {
    // #87: window.confirm を React modal に置換（PWA/headless 対応）
    setDeleteConfirm(id);
  };

  const openEditGoal = (goal: HealthGoal) => {
    setEditError(null);
    setEditGoal(goal);
    setEditForm({
      target_value: String(goal.target_value ?? ''),
      target_date: goal.target_date ? goal.target_date.slice(0, 10) : '',
    });
  };

  const closeEditGoal = () => {
    setEditGoal(null);
    setEditError(null);
  };

  const handleSaveEditGoal = async () => {
    if (!editGoal) return;
    if (!editForm.target_value || Number.isNaN(parseFloat(editForm.target_value))) {
      setEditError('目標値を入力してください');
      return;
    }

    setSavingEdit(true);
    setEditError(null);
    try {
      const res = await fetch(`/api/health/goals/${editGoal.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_value: parseFloat(editForm.target_value),
          target_date: editForm.target_date || null,
        }),
      });

      if (res.ok) {
        closeEditGoal();
        void reloadGoals();
      } else {
        const data = await res.json().catch(() => null);
        setEditError(data?.error || '更新に失敗しました');
      }
    } catch (error) {
      console.error('Failed to update goal:', error);
      setEditError('更新に失敗しました');
    }
    setSavingEdit(false);
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    const id = deleteConfirm;
    setDeleteConfirm(null);
    const endWrite = pendingWrites.begin();
    try {
      const res = await fetch(`/api/health/goals/${id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        void reloadGoals();
      }
    } catch (error) {
      console.error('Failed to delete goal:', error);
    } finally {
      endWrite();
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
          onClick={openCreateModal}
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
                  onClick={openCreateModal}
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
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => openEditGoal(goal)}
                            className="p-2"
                            aria-label="目標を編集"
                          >
                            <Edit2 size={18} style={{ color: colors.textMuted }} />
                          </button>
                          <button
                            onClick={() => handleDeleteGoal(goal.id)}
                            className="p-2"
                            aria-label="目標を削除"
                          >
                            <Trash2 size={18} style={{ color: colors.textMuted }} />
                          </button>
                        </div>
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
                                style={{ backgroundColor: colors.successLight, color: colors.successText }}
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
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <div
                            className="w-10 h-10 rounded-lg flex items-center justify-center"
                            style={{ backgroundColor: colors.success }}
                          >
                            <Trophy size={20} color="white" />
                          </div>
                          <div>
                            <p className="font-semibold" style={{ color: colors.successText }}>
                              {config.label} 目標達成！
                            </p>
                            <p className="text-sm" style={{ color: colors.successText }}>
                              {goal.target_value}{goal.target_unit} を達成
                            </p>
                          </div>
                        </div>
                        {/* #1055 UX3-15: 達成済みでも編集・削除できるようにする */}
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => openEditGoal(goal)}
                            className="p-2"
                            aria-label="目標を編集"
                          >
                            <Edit2 size={18} style={{ color: colors.success }} />
                          </button>
                          <button
                            onClick={() => handleDeleteGoal(goal.id)}
                            className="p-2"
                            aria-label="目標を削除"
                          >
                            <Trash2 size={18} style={{ color: colors.success }} />
                          </button>
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

      {/* 目標削除確認モーダル (#87: window.confirm 廃止) */}
      <AnimatePresence>
        {deleteConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center px-4"
            onClick={() => setDeleteConfirm(null)}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                  <Trash2 size={20} style={{ color: colors.error }} />
                </div>
                <h3 className="font-bold text-lg" style={{ color: colors.text }}>目標を削除</h3>
              </div>
              <p className="text-sm mb-6" style={{ color: colors.textLight }}>
                この目標を削除しますか？この操作は取り消せません。
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setDeleteConfirm(null)}
                  className="flex-1 py-3 rounded-xl font-medium"
                  style={{ backgroundColor: colors.border, color: colors.textLight }}
                >
                  キャンセル
                </button>
                <button
                  onClick={confirmDelete}
                  className="flex-1 py-3 rounded-xl font-bold text-white"
                  style={{ backgroundColor: colors.error }}
                >
                  削除する
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 目標編集モーダル (#1055 UX3-15: 削除しか出来なかった目標を編集可能に) */}
      <AnimatePresence>
        {editGoal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center px-4"
            onClick={closeEditGoal}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-bold text-lg" style={{ color: colors.text }}>目標を編集</h3>
                <button onClick={closeEditGoal} className="p-1">
                  <X size={20} style={{ color: colors.textMuted }} />
                </button>
              </div>

              <div className="mb-4">
                <label className="block text-sm font-medium mb-2" style={{ color: colors.textLight }}>
                  {getGoalConfig(editGoal.goal_type).label} の目標値
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    step="0.1"
                    value={editForm.target_value}
                    onChange={(e) => setEditForm({ ...editForm, target_value: e.target.value })}
                    className="flex-1 p-4 rounded-xl text-xl font-bold"
                    style={{ backgroundColor: colors.bg, color: colors.text }}
                  />
                  <span className="text-lg" style={{ color: colors.textMuted }}>
                    {editGoal.target_unit}
                  </span>
                </div>
              </div>

              <div className="mb-6">
                <label className="block text-sm font-medium mb-2" style={{ color: colors.textLight }}>
                  期限（オプション）
                </label>
                <input
                  type="date"
                  value={editForm.target_date}
                  onChange={(e) => setEditForm({ ...editForm, target_date: e.target.value })}
                  className="w-full p-4 rounded-xl"
                  style={{ backgroundColor: colors.bg, color: colors.text }}
                />
              </div>

              {editError && (
                <p className="text-sm mb-4" style={{ color: colors.dangerText }}>{editError}</p>
              )}

              <div className="flex gap-3">
                <button
                  onClick={closeEditGoal}
                  className="flex-1 py-3 rounded-xl font-medium"
                  style={{ backgroundColor: colors.border, color: colors.textLight }}
                >
                  キャンセル
                </button>
                <button
                  onClick={handleSaveEditGoal}
                  disabled={savingEdit}
                  className="flex-1 py-3 rounded-xl font-bold text-white disabled:opacity-50"
                  style={{ backgroundColor: colors.accent }}
                >
                  {savingEdit ? '保存中...' : '保存する'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 目標作成モーダル */}
      <AnimatePresence>
        {showCreateModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 z-[60] flex items-end"
            onClick={closeCreateModal}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
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
                  min={todayLocal()}
                  className="w-full p-4 rounded-xl"
                  style={{ backgroundColor: colors.bg, color: colors.text }}
                />
              </div>

              {createError && (
                <p className="text-sm mb-4" style={{ color: colors.dangerText }}>{createError}</p>
              )}

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

