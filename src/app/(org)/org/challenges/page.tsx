"use client";

import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  DISABLED_ORG_CHALLENGE_TYPES,
  ORG_CHALLENGE_MIN_PARTICIPANTS,
  ORG_CHALLENGE_TYPES,
  ORG_CHALLENGE_TYPE_LABELS,
  ORG_CHALLENGE_TYPE_META,
  formatOrgChallengeValue,
  formatParticipantCount,
  isOrgChallengeType,
} from "@/lib/org-challenges";

// #1132: 管理者に見せるのは集計 (参加者数と平均) だけ。参加者一人ひとりの進み具合・順位は、誰にも見せない (参加者どうしを除く)。
// 少人数から個人が分かってしまわないよう、参加者が最小人数に満たない間は参加者数を、集計が済んだ参加者が最小人数に満たない間は平均を出さない。
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
  /** 参加者が最小人数に満たないときは null (API が返さない) */
  participantCount: number | null;
  aggregate?: {
    minParticipants: number;
    visible: boolean;
    averageValue: number | null;
  };
  createdAt: string;
}

// 作成できるのは、食事の記録から計算できる種類だけ。歩数・体重・カスタムは、健康データの同意の仕組みができるまで選べない
const ENABLED_TYPE_OPTIONS = ORG_CHALLENGE_TYPES.map((value) => ({
  value,
  label: ORG_CHALLENGE_TYPE_META[value].label,
}));

const DISABLED_TYPE_OPTIONS = DISABLED_ORG_CHALLENGE_TYPES.map((value) => ({
  value,
  label: `${ORG_CHALLENGE_TYPE_LABELS[value]} (準備中)`,
}));

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  draft: { label: "下書き", color: "bg-gray-100 text-gray-600" },
  active: { label: "開催中", color: "bg-green-100 text-green-700" },
  completed: { label: "終了", color: "bg-blue-100 text-blue-700" },
  cancelled: { label: "中止", color: "bg-red-100 text-red-700" },
};

/** 目標値の初期値を入力欄の文字列にする (初期値なしは空欄) */
function defaultTargetText(defaultTarget: number | null): string {
  return defaultTarget === null ? "" : String(defaultTarget);
}

const INITIAL_FORM = {
  title: "",
  description: "",
  challengeType: "breakfast_rate",
  targetValue: defaultTargetText(ORG_CHALLENGE_TYPE_META.breakfast_rate.defaultTarget),
  targetUnit: ORG_CHALLENGE_TYPE_META.breakfast_rate.unit,
  startDate: "",
  endDate: "",
  rewardDescription: "",
};

/** API のエラー本文から、画面に出す文を取り出す (本文が読めなければ既定の文) */
async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.error === "string") return body.error;
    if (typeof body?.error?.message === "string") return body.error.message;
  } catch {
    // 本文が JSON でない
  }
  return fallback;
}

export default function OrgChallengesPage() {
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
    setErrorMessage(null);

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
        setFormData(INITIAL_FORM);
      } else {
        setErrorMessage(await readErrorMessage(res, "チャレンジを作成できませんでした"));
      }
    } catch (error) {
      console.error("Failed to create challenge:", error);
      setErrorMessage("チャレンジを作成できませんでした。通信状況を確認して、もう一度お試しください");
    } finally {
      setSubmitting(false);
    }
  };

  const handleStatusChange = async (challengeId: string, newStatus: string) => {
    setErrorMessage(null);
    try {
      const res = await fetch("/api/org/challenges", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: challengeId, status: newStatus }),
      });

      if (res.ok) {
        fetchChallenges();
      } else {
        setErrorMessage(await readErrorMessage(res, "チャレンジの状態を変更できませんでした"));
      }
    } catch (error) {
      console.error("Failed to update challenge:", error);
      setErrorMessage("チャレンジの状態を変更できませんでした。通信状況を確認して、もう一度お試しください");
    }
  };

  /** 種類を選んだら、単位と目標値の初期値をその種類に合わせる */
  const handleTypeChange = (challengeType: string) => {
    if (!isOrgChallengeType(challengeType)) return;
    const meta = ORG_CHALLENGE_TYPE_META[challengeType];
    setFormData({
      ...formData,
      challengeType,
      targetUnit: meta.unit,
      targetValue: defaultTargetText(meta.defaultTarget),
    });
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

      <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 text-sm text-blue-900 space-y-1">
        <p className="font-medium">参加は社員の自由です。管理者に見えるのは、チャレンジごとの集計 (参加者数と平均) だけです。</p>
        <p className="text-blue-800">
          一人ひとりの記録・順位は、管理者にも表示されません。順位は、参加した社員どうしにだけ表示されます。
          参加者が{ORG_CHALLENGE_MIN_PARTICIPANTS}人以上になるまでは参加者数を、集計が済んだ参加者が{ORG_CHALLENGE_MIN_PARTICIPANTS}人以上になるまでは平均を表示しません (少人数だと、誰が参加しているか・誰の値かが分かってしまうのを防ぐためです)。
        </p>
      </div>

      {errorMessage && (
        <div role="alert" className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
          {errorMessage}
        </div>
      )}

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
                  onChange={(e) => handleTypeChange(e.target.value)}
                  aria-describedby="challenge-type-help"
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {ENABLED_TYPE_OPTIONS.map((type) => (
                    <option key={type.value} value={type.value}>{type.label}</option>
                  ))}
                  {DISABLED_TYPE_OPTIONS.map((type) => (
                    <option key={type.value} value={type.value} disabled>{type.label}</option>
                  ))}
                </select>
                <p id="challenge-type-help" className="text-xs text-gray-500 mt-1">
                  {isOrgChallengeType(formData.challengeType) ? ORG_CHALLENGE_TYPE_META[formData.challengeType].description : ""}
                  {" "}歩数・体重のチャレンジは、健康データの同意の仕組みができてから選べるようになります。
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  目標値 ({formData.targetUnit})
                </label>
                <input
                  type="number"
                  step="any"
                  value={formData.targetValue}
                  onChange={(e) => setFormData({ ...formData, targetValue: e.target.value })}
                  min={isOrgChallengeType(formData.challengeType) ? ORG_CHALLENGE_TYPE_META[formData.challengeType].targetMin : undefined}
                  max={isOrgChallengeType(formData.challengeType) ? ORG_CHALLENGE_TYPE_META[formData.challengeType].targetMax : undefined}
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
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
                  {ORG_CHALLENGE_TYPE_LABELS[challenge.challengeType] ?? challenge.challengeType} |
                  {challenge.startDate} 〜 {challenge.endDate}
                </p>
                {challenge.description && (
                  <p className="text-gray-600 mt-2">{challenge.description}</p>
                )}
              </div>
              <div className="flex items-center gap-4">
                <div className="text-center">
                  {challenge.participantCount === null ? (
                    <p className="text-lg font-bold text-gray-400">
                      {formatParticipantCount(null, challenge.aggregate?.minParticipants)}
                    </p>
                  ) : (
                    <p className="text-2xl font-bold text-blue-600">{challenge.participantCount}</p>
                  )}
                  <p className="text-xs text-gray-500">参加者</p>
                </div>
                {isOrgChallengeType(challenge.challengeType) && (
                  <div className="text-center min-w-[7rem]">
                    {challenge.aggregate?.visible ? (
                      <>
                        <p className="text-2xl font-bold text-emerald-600">
                          {formatOrgChallengeValue(challenge.challengeType, challenge.aggregate.averageValue)}
                        </p>
                        <p className="text-xs text-gray-500">参加者の平均</p>
                      </>
                    ) : (
                      <>
                        <p className="text-lg font-bold text-gray-400">集計中</p>
                        <p className="text-xs text-gray-500 max-w-[9rem]">
                          集計が済んだ参加者が{challenge.aggregate?.minParticipants || ORG_CHALLENGE_MIN_PARTICIPANTS}人以上になると、平均を表示します
                        </p>
                      </>
                    )}
                  </div>
                )}
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

