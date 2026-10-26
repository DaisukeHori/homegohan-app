"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ORG_CHALLENGE_MIN_PARTICIPANTS,
  ORG_CHALLENGE_TYPES,
  ORG_CHALLENGE_TYPE_LABELS,
  ORG_CHALLENGE_TYPE_META,
  formatOrgChallengeValue,
  formatParticipantCount,
  isOrgChallengeType,
} from "@/lib/org-challenges";
import { operationFailureMessage, operationNetworkFailureMessage } from "@/lib/admin/api-error-message";

/** チャレンジの一覧を読み込めなかったときの文の頭 (後ろに理由を添える)。空の一覧 (「チャレンジがありません」) と見分けるために出す (#2050) */
const LOAD_FAILURE_SUMMARY = "チャレンジの一覧を読み込めませんでした";

// #1132: 管理者に見せるのは集計 (参加者数と平均) だけ。参加者一人ひとりの進み具合・順位は、誰にも見せない (参加者どうしを除く)。
// 少人数から個人が分かってしまわないよう、参加した人 (延べ) が最小人数に満たない間は参加者数を出さない。
// #1688: 2 つの集計の差から、やめた人・組織を離れた人の値を逆算させないよう、参加者数は延べ数 (やめても減らない) にし、
// 平均はチャレンジが終了したときに 1 回だけ確定した値だけを出す (開催中は出さない。終了時点の参加者が最小人数に満たないときと、
// 同じ種類で期間が重なるチャレンジの平均をすでに出しているときも出さない)。どちらの理由で出ないかは API が返さない。
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
  /** これまでに参加した人の延べ数。最小人数に満たないときは null (API が返さない) */
  participantCount: number | null;
  /** averageValue は終了時に確定した平均。開催中・出さない理由があるときは visible = false */
  aggregate?: {
    minParticipants: number;
    visible: boolean;
    averageValue: number | null;
  };
  createdAt: string;
}

// 作成できるのは、食事の記録から計算できる種類だけ。歩数・体重・カスタム (DISABLED_ORG_CHALLENGE_TYPES) は選択肢に出さない (#1911: 未完成の機能は「準備中」とも出さない)
const ENABLED_TYPE_OPTIONS = ORG_CHALLENGE_TYPES.map((value) => ({
  value,
  label: ORG_CHALLENGE_TYPE_META[value].label,
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

/**
 * 平均の欄。平均は終了時に確定した値だけを出す (#1688)。
 *   - 終了 (completed) で API が出してよいとしたとき: 確定した平均
 *   - 終了で出さないとき: 「表示なし」(終了時点の参加者が最小人数に満たないか、重なるチャレンジの平均をすでに出している)
 *   - 下書き・開催中: 「終了後に表示」(API が平均を返しても、終了前の値としては出さない)
 */
function AverageCell({ challenge }: { challenge: Challenge }) {
  const minParticipants = challenge.aggregate?.minParticipants || ORG_CHALLENGE_MIN_PARTICIPANTS;
  if (challenge.status === "completed" && challenge.aggregate?.visible) {
    return (
      <>
        <p className="text-2xl font-bold text-emerald-600">
          {formatOrgChallengeValue(challenge.challengeType, challenge.aggregate.averageValue)}
        </p>
        <p className="text-xs text-gray-500">参加者の平均 (終了時点)</p>
      </>
    );
  }
  if (challenge.status === "completed") {
    return (
      <>
        <p className="text-lg font-bold text-gray-400">表示なし</p>
        <p className="text-xs text-gray-500 max-w-[9rem]">
          終了時点の参加者が{minParticipants}人未満か、同じ種類で期間が重なるチャレンジの平均をすでに表示しているため、平均は表示しません
        </p>
      </>
    );
  }
  return (
    <>
      <p className="text-lg font-bold text-gray-400">終了後に表示</p>
      <p className="text-xs text-gray-500 max-w-[9rem]">
        チャレンジが終了すると、終了時点の参加者 ({minParticipants}人以上) の平均を表示します
      </p>
    </>
  );
}

export default function OrgChallengesPage() {
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // 一覧を読み込めなかったときの文。あるあいだは一覧と「チャレンジがありません」の代わりにこの文と「再試行」を出す (#2050)
  const [loadError, setLoadError] = useState<string | null>(null);
  // 状態の変更 (開始・終了) の応答を待っているチャレンジの id。待つあいだは状態のボタンを止める
  // (二度押しで 2 本目を送ると、変えられているのに断られて失敗の文が出るため。#2050)
  const [changingStatusId, setChangingStatusId] = useState<string | null>(null);
  // 作成か状態の変更のどちらかの書き込みとそのあとの読み直しの応答を待っているか (10/26 の整合ゲート 1026e。#2050)。
  // 書き込みのあとの読み直しは一覧を丸ごと差し替えるので、2 つの書き込みを重ねると、先に送った読み直しの応答が後に届いたとき、
  // その古い一覧 (例: 開始したチャレンジがまだ下書きの一覧) で表示が上書きされ、開始したチャレンジの「開始」をもう一度押せてしまう
  // (#2053 のクーポン・機能パッケージと同じ型)。待つあいだは作成と開始・終了のボタン (と一覧の「再試行」。#2059) を止め、押されても送らない。
  // ref は再描画の前に続けて押されたとき (ボタンがまだ止まっていない) の守り
  const writeInFlightRef = useRef(false);
  const isWriting = submitting || changingStatusId !== null;

  const fetchChallenges = useCallback(async () => {
    try {
      const res = await fetch("/api/org/challenges");
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        setLoadError(operationFailureMessage(LOAD_FAILURE_SUMMARY, res.status, body));
        return;
      }
      const data = await res.json();
      setChallenges(data.challenges);
      setLoadError(null);
    } catch (error) {
      console.error("Failed to fetch challenges:", error);
      setLoadError(operationNetworkFailureMessage(LOAD_FAILURE_SUMMARY));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchChallenges();
  }, [fetchChallenges]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // 開始・終了 (とその読み直し) の応答を待つあいだは送らない (writeInFlightRef)
    if (writeInFlightRef.current) return;
    writeInFlightRef.current = true;
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
        setShowForm(false);
        setFormData(INITIAL_FORM);
        // 読み直しの応答まで待ってからボタンを戻す (待たずに次の書き込みを送ると、この読み直しの古い一覧で上書きされうるため)
        await fetchChallenges();
      } else {
        setErrorMessage(await readErrorMessage(res, "チャレンジを作成できませんでした"));
      }
    } catch (error) {
      console.error("Failed to create challenge:", error);
      setErrorMessage("チャレンジを作成できませんでした。通信状況を確認して、もう一度お試しください");
    } finally {
      writeInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const handleStatusChange = async (challengeId: string, newStatus: string) => {
    // 作成 (とその読み直し) の応答を待つあいだも送らない (writeInFlightRef)
    if (writeInFlightRef.current) return;
    writeInFlightRef.current = true;
    setChangingStatusId(challengeId);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/org/challenges", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: challengeId, status: newStatus }),
      });

      if (res.ok) {
        // 読み直し (ボタンが次の状態のものに変わる) まで待ってからボタンを戻す
        await fetchChallenges();
      } else {
        setErrorMessage(await readErrorMessage(res, "チャレンジの状態を変更できませんでした"));
      }
    } catch (error) {
      console.error("Failed to update challenge:", error);
      setErrorMessage("チャレンジの状態を変更できませんでした。通信状況を確認して、もう一度お試しください");
    } finally {
      writeInFlightRef.current = false;
      setChangingStatusId(null);
    }
  };

  // 一覧の読み込みをやり直す (読み込めなかったときの「再試行」)。
  // 書き込みとそのあとの読み直しの応答を待つあいだは送らない (#2059)。待つあいだに送ると、この読み込みが書き込みより前の一覧を読み、
  // 書き込みのあとの読み直しより後に届いたとき、その古い一覧で表示が上書きされ、作ったものが表示から消える (もう一度作って重複させうる)。
  // ボタンも isWriting で止める。ref は再描画の前に押されたとき (ボタンがまだ止まっていない) の守り
  const retryLoad = () => {
    if (writeInFlightRef.current) return;
    setLoading(true);
    void fetchChallenges();
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
          参加者数は、これまでに参加した人の数で、やめた人や組織を離れた人を引きません。{ORG_CHALLENGE_MIN_PARTICIPANTS}人以上になるまでは表示しません。平均は、チャレンジが終了したあとに、終了時点の参加者が{ORG_CHALLENGE_MIN_PARTICIPANTS}人以上のときだけ表示します (開催中は表示しません)。同じ種類で期間が重なるチャレンジは、先に終了したものの平均だけを表示します (少人数だと、誰が参加しているか・誰の値かが分かってしまうのを防ぐためです)。
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
                </select>
                <p id="challenge-type-help" className="text-xs text-gray-500 mt-1">
                  {isOrgChallengeType(formData.challengeType) ? ORG_CHALLENGE_TYPE_META[formData.challengeType].description : ""}
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
                disabled={isWriting}
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

      {loadError ? (
        <div
          role="alert"
          data-testid="challenge-load-error"
          className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm flex items-center justify-between gap-3"
        >
          <span>{loadError}</span>
          <button
            type="button"
            onClick={retryLoad}
            disabled={isWriting}
            className="shrink-0 px-3 py-1.5 bg-white border border-red-300 rounded-lg text-red-700 hover:bg-red-100 transition-colors disabled:opacity-50"
          >
            再試行
          </button>
        </div>
      ) : (
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
                  <p className="text-xs text-gray-500">参加した人</p>
                </div>
                {/* 中止したチャレンジは平均を確定しないので、平均の欄を出さない */}
                {isOrgChallengeType(challenge.challengeType) && challenge.status !== "cancelled" && (
                  <div className="text-center min-w-[7rem]">
                    <AverageCell challenge={challenge} />
                  </div>
                )}
                {challenge.status === "draft" && (
                  <button
                    onClick={() => handleStatusChange(challenge.id, "active")}
                    disabled={isWriting}
                    className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50"
                  >
                    開始
                  </button>
                )}
                {challenge.status === "active" && (
                  <button
                    onClick={() => handleStatusChange(challenge.id, "completed")}
                    disabled={isWriting}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
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
      )}
    </div>
  );
}

