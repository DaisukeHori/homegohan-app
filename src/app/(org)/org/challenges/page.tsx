"use client";

import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface Challenge {
  id: string;
  title: string;
  description: string | null;
  challengeType: string;
  targetValue: number | null;
  targetUnit: string | null;
  startDate: string;
  endDate: string;
  rewardDescription: string | null;
  status: string;
  participantCount: number;
  createdAt: string;
}

const CHALLENGE_TYPES = [
  { value: "breakfast_rate", label: "朝食摂取率" },
  { value: "veg_score", label: "野菜スコア" },
  { value: "cooking_rate", label: "自炊率" },
  { value: "steps", label: "歩数" },
  { value: "weight_loss", label: "体重減量" },
  { value: "custom", label: "カスタム" },
];

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  draft: { label: "下書き", color: "bg-gray-100 text-gray-600" },
  active: { label: "開催中", color: "bg-green-100 text-green-700" },
  completed: { label: "終了", color: "bg-blue-100 text-blue-700" },
  cancelled: { label: "中止", color: "bg-red-100 text-red-700" },
};

export default function OrgChallengesPage() {
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    title: "",
    description: "",
    challengeType: "breakfast_rate",
    targetValue: "",
    targetUnit: "%",
    startDate: "",
    endDate: "",
    rewardDescription: "",
  });
  const [submitting, setSubmitting] = useState(false);

  const fetchChallenges = useCallback(async () => {
    try {
      const res = await fetch("/api/org/challenges");
      if (res.ok) {
        const data = await res.json();
        setChallenges(data.challenges);
      }
    } catch (error) {
      console.error("Failed to fetch challenges:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchChallenges();
  }, [fetchChallenges]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      const res = await fetch("/api/org/challenges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: formData.title,
          description: formData.description || null,
          challengeType: formData.challengeType,
          targetValue: formData.targetValue ? parseFloat(formData.targetValue) : null,
          targetUnit: formData.targetUnit || null,
          startDate: formData.startDate,
          endDate: formData.endDate,
          rewardDescription: formData.rewardDescription || null,
        }),
      });

      if (res.ok) {
        fetchChallenges();
        setShowForm(false);
        setFormData({
          title: "",
          description: "",
          challengeType: "breakfast_rate",
          targetValue: "",
          targetUnit: "%",
          startDate: "",
          endDate: "",
          rewardDescription: "",
        });
      }
    } catch (error) {
      console.error("Failed to create challenge:", error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleStatusChange = async (challengeId: string, newStatus: string) => {
    try {
      const res = await fetch("/api/org/challenges", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: challengeId, status: newStatus }),
      });

      if (res.ok) {
        fetchChallenges();
      }
    } catch (error) {
      console.error("Failed to update challenge:", error);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">チャレンジ管理</h1>
          <p className="text-gray-500 mt-1">組織内のチャレンジを作成・管理</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
        >
          + 新規チャレンジ
        </button>
      </div>

      <AnimatePresence>
        {showForm && (
          <motion.form
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            onSubmit={handleSubmit}
            className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 space-y-4"
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">タイトル</label>
                <input
                  type="text"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  required
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="例: 朝食30日チャレンジ"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">種別</label>
                <select
                  value={formData.challengeType}
                  onChange={(e) => setFormData({ ...formData, challengeType: e.target.value })}
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {CHALLENGE_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>{type.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">開始日</label>
                <input
                  type="date"
                  value={formData.startDate}
                  onChange={(e) => setFormData({ ...formData, startDate: e.target.value })}
                  required
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">終了日</label>
                <input
                  type="date"
                  value={formData.endDate}
                  onChange={(e) => setFormData({ ...formData, endDate: e.target.value })}
                  required
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-2">説明</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                  rows={2}
                  placeholder="チャレンジの詳細..."
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-2">報酬</label>
                <input
                  type="text"
                  value={formData.rewardDescription}
                  onChange={(e) => setFormData({ ...formData, rewardDescription: e.target.value })}
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="例: 達成者にはスペシャルバッジを付与"
                />
              </div>
            </div>
            <div className="flex gap-3">
              <button
                type="submit"
                disabled={submitting}
                className="px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {submitting ? "作成中..." : "作成"}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-6 py-3 bg-gray-100 text-gray-700 rounded-xl font-medium hover:bg-gray-200 transition-colors"
              >
                キャンセル
              </button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      <div className="space-y-4">
        {challenges.map((challenge) => (
          <motion.div
            key={challenge.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100"
          >
            <div className="flex justify-between items-start">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-bold text-gray-800">{challenge.title}</h3>
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_LABELS[challenge.status]?.color}`}>
                    {STATUS_LABELS[challenge.status]?.label}
                  </span>
                </div>
                <p className="text-sm text-gray-500 mt-1">
                  {CHALLENGE_TYPES.find(t => t.value === challenge.challengeType)?.label} |
                  {challenge.startDate} 〜 {challenge.endDate}
                </p>
                {challenge.description && (
                  <p className="text-gray-600 mt-2">{challenge.description}</p>
                )}
              </div>
              <div className="flex items-center gap-4">
                <div className="text-center">
                  <p className="text-2xl font-bold text-blue-600">{challenge.participantCount}</p>
                  <p className="text-xs text-gray-500">参加者</p>
                </div>
                {challenge.status === "draft" && (
                  <button
                    onClick={() => handleStatusChange(challenge.id, "active")}
                    className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition-colors"
                  >
                    開始
                  </button>
                )}
                {challenge.status === "active" && (
                  <button
                    onClick={() => handleStatusChange(challenge.id, "completed")}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
                  >
                    終了
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        ))}
        {challenges.length === 0 && (
          <div className="text-center text-gray-400 py-12">
            チャレンジがありません
          </div>
        )}
      </div>
    </div>
  );
}

