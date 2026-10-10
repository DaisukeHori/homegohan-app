"use client";

// 組織チャレンジの詳細 (#1132)。数え方を読んで参加を決め、参加したら自分の記録と順位表を見る。
//
// オーナー判断 (2026-10-08):
//   - 参加は任意。いつでもやめられる (やめると、記録は順位から外れる)
//   - 順位表は参加者どうしにだけ見せる。管理者(参加していない人を含む)には、順位表を出さない
//   - 参加者の表示名は、社内の方針が決まるまで出さない (順位と「参加者」「あなた」だけ)。出すかどうかは API が決める
// 画面は、API (GET /api/org/challenges/[id]) が返したものをそのまま見せる。

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ORG_CHALLENGE_MIN_PARTICIPANTS,
  ORG_CHALLENGE_TYPE_LABELS,
  ORG_CHALLENGE_TYPE_META,
  formatOrgChallengeValue,
  formatParticipantCount,
  isOrgChallengeType,
} from "@/lib/org-challenges";

interface RankingEntry {
  rank: number;
  value: number;
  isMe: boolean;
  label: string;
}

interface ChallengeDetail {
  challenge: {
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
  };
  /** 参加者が最小人数に満たないときは null (API が人数を返さない) */
  participantCount: number | null;
  minParticipants?: number;
  joined: boolean;
  me: { currentValue: number; rank: number | null; joinedAt: string | null } | null;
  ranking:
    | { available: false; showNames?: boolean }
    | {
        available: true;
        showNames: boolean;
        rankedCount: number;
        truncated: boolean;
        entries: RankingEntry[];
      };
}

type DetailState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "not-member" }
  | { status: "not-found" }
  | { status: "loaded"; detail: ChallengeDetail };

/** YYYY-MM-DD を 10/1 の形にする */
function shortDate(date: string): string {
  const [, month, day] = date.split("-");
  return month && day ? `${Number(month)}/${Number(day)}` : date;
}

/** API のエラー本文から、画面に出す文を取り出す (本文が読めなければ既定の文) */
async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.error?.message === "string") return body.error.message;
    if (typeof body?.error === "string") return body.error;
  } catch {
    // 本文が JSON でない
  }
  return fallback;
}

function rankLabel(rank: number): string {
  return `${rank}位`;
}

export default function ChallengeDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Array.isArray(params?.id) ? params.id[0] : params?.id;

  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!id) return;
      try {
        const res = await fetch(`/api/org/challenges/${id}`, { signal });
        if (res.status === 403) {
          setState({ status: "not-member" });
          return;
        }
        if (res.status === 404) {
          setState({ status: "not-found" });
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setState({ status: "loaded", detail: (await res.json()) as ChallengeDetail });
      } catch (error) {
        if (signal?.aborted) return;
        console.error("Failed to load challenge:", error);
        setState({ status: "error", message: "チャレンジを読み込めませんでした。通信状況を確認して、もう一度お試しください。" });
      }
    },
    [id],
  );

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /** 参加する / 参加をやめる。成功したら読み込み直す */
  const changeParticipation = async (method: "POST" | "DELETE") => {
    if (!id || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/org/challenges/${id}/join`, { method });
      if (!res.ok) {
        setActionError(
          await readErrorMessage(
            res,
            method === "POST" ? "参加できませんでした。もう一度お試しください。" : "参加をやめられませんでした。もう一度お試しください。",
          ),
        );
        return;
      }
      setConfirmingLeave(false);
      await load();
    } catch (error) {
      console.error("Failed to change participation:", error);
      setActionError("通信に失敗しました。通信状況を確認して、もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <Link href="/challenges" className="inline-block text-sm text-gray-600 mb-3 hover:text-gray-900">
      ← チャレンジ一覧へ戻る
    </Link>
  );

  if (state.status !== "loaded") {
    return (
      <div className="min-h-screen bg-gray-50 pb-24">
        <header className="bg-white p-6 shadow-sm mb-6">{header}</header>
        <div className="px-4">
          {state.status === "loading" && (
            <div role="status" aria-live="polite" className="text-center text-gray-600 py-12">
              <div className="animate-spin w-8 h-8 border-4 border-gray-700 border-t-transparent rounded-full mx-auto mb-4" aria-hidden="true" />
              読み込み中...
            </div>
          )}
          {state.status === "not-member" && (
            <div className="bg-white rounded-3xl p-8 text-center shadow-sm">
              <h1 className="text-lg font-bold text-gray-900 mb-2">組織に所属している方のための機能です</h1>
              <p className="text-gray-600 text-sm">会社などの組織に招待されると、組織のチャレンジに参加できます。</p>
            </div>
          )}
          {state.status === "not-found" && (
            <div className="bg-white rounded-3xl p-8 text-center shadow-sm">
              <h1 className="text-lg font-bold text-gray-900 mb-2">チャレンジが見つかりませんでした</h1>
              <p className="text-gray-600 text-sm">終了して見られなくなったか、対象外のチャレンジです。</p>
            </div>
          )}
          {state.status === "error" && (
            <div role="alert" className="bg-white rounded-3xl p-8 text-center shadow-sm">
              <p className="text-gray-700 text-sm mb-4">{state.message}</p>
              <button
                type="button"
                onClick={() => {
                  setState({ status: "loading" });
                  void load();
                }}
                className="px-5 py-2 bg-gray-900 text-white rounded-full text-sm font-medium"
              >
                もう一度読み込む
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const { detail } = state;
  const { challenge } = detail;
  const meta = isOrgChallengeType(challenge.challengeType) ? ORG_CHALLENGE_TYPE_META[challenge.challengeType] : null;
  const isActive = challenge.status === "active";
  const ranking = detail.ranking;
  const showNames = ranking.showNames === true;

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <header className="bg-white p-6 pb-8 rounded-b-[40px] shadow-sm mb-6">
        {header}
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-2xl font-bold text-gray-900 break-words">{challenge.title}</h1>
          <span
            className={`shrink-0 mt-1 px-2 py-1 rounded-full text-xs font-medium ${
              isActive ? "bg-emerald-100 text-emerald-800" : "bg-gray-100 text-gray-700"
            }`}
          >
            {isActive ? "開催中" : "終了"}
          </span>
        </div>
        <p className="text-sm text-gray-600 mt-2">
          {ORG_CHALLENGE_TYPE_LABELS[challenge.challengeType] ?? challenge.challengeType}
          {" ・ "}
          {shortDate(challenge.startDate)}〜{shortDate(challenge.endDate)}
          {" ・ "}参加者 {formatParticipantCount(detail.participantCount, detail.minParticipants ?? ORG_CHALLENGE_MIN_PARTICIPANTS)}
        </p>
        {challenge.description && <p className="text-gray-700 text-sm mt-3">{challenge.description}</p>}
        <dl className="mt-3 space-y-1 text-sm text-gray-700">
          {challenge.targetValue !== null && (
            <div className="flex gap-2">
              <dt className="text-gray-600">目標</dt>
              <dd className="font-medium">{formatOrgChallengeValue(challenge.challengeType, challenge.targetValue)}</dd>
            </div>
          )}
          {challenge.rewardDescription && (
            <div className="flex gap-2">
              <dt className="text-gray-600">報酬</dt>
              <dd className="font-medium">{challenge.rewardDescription}</dd>
            </div>
          )}
        </dl>
      </header>

      <div className="px-4 space-y-4">
        {actionError && (
          <div role="alert" className="bg-red-50 border border-red-200 text-red-800 rounded-2xl px-4 py-3 text-sm">
            {actionError}
          </div>
        )}

        <section aria-labelledby="how-to-count" className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
          <h2 id="how-to-count" className="font-bold text-gray-900 mb-2">数え方</h2>
          {meta && <p className="text-sm text-gray-700 mb-2">{meta.description}</p>}
          <ul className="list-disc pl-5 space-y-1 text-sm text-gray-700">
            <li>食事の記録は、前日の分までを毎日 午前 3 時ごろに集計します。</li>
            <li>参加する前の記録も、チャレンジの期間内なら数えます。</li>
            <li>「食べない」にした食事と、お試し (ハンズオン) の記録は数えません。</li>
          </ul>
        </section>

        {!detail.joined && (
          <section aria-labelledby="about-joining" className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <h2 id="about-joining" className="font-bold text-gray-900 mb-2">参加について</h2>
            <ul className="list-disc pl-5 space-y-1 text-sm text-gray-700 mb-4">
              <li>参加は自由です。参加しなくても、ほかの機能には影響しません。</li>
              <li>
                参加すると、あなたの記録から計算した値と順位が、参加した人どうしにだけ表示されます。
                {showNames
                  ? "順位表には、参加した人のニックネームが表示されます。"
                  : "順位表に、ほかの参加者のニックネームは表示されません (順位と記録だけ)。"}
              </li>
              <li>会社の管理者には、参加者全体の人数と平均だけが表示されます (参加者が少ない間は、人数も平均も表示されません)。あなたの記録や順位は表示されません。</li>
              <li>いつでも参加をやめられます。やめると、あなたの記録は順位から外れます。</li>
            </ul>
            {isActive ? (
              <button
                type="button"
                onClick={() => void changeParticipation("POST")}
                disabled={busy}
                aria-busy={busy}
                className="w-full sm:w-auto px-6 py-3 bg-gray-900 text-white rounded-full text-sm font-bold disabled:opacity-50"
              >
                {busy ? "参加しています..." : "このチャレンジに参加する"}
              </button>
            ) : (
              <p className="text-sm text-gray-700 font-medium">このチャレンジは終了しました。</p>
            )}
          </section>
        )}

        {detail.joined && detail.me && (
          <section aria-labelledby="my-record" className="bg-white rounded-2xl p-4 shadow-sm border border-emerald-100">
            <div className="flex items-center justify-between mb-3">
              <h2 id="my-record" className="font-bold text-gray-900">あなたの記録</h2>
              <span className="px-2 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">参加中</span>
            </div>
            {detail.me.rank !== null ? (
              <div className="flex items-end gap-6">
                <div>
                  <p className="text-xs text-gray-600">順位</p>
                  <p className="text-3xl font-bold text-gray-900">
                    {rankLabel(detail.me.rank)}
                    {ranking.available && ranking.rankedCount > 0 && (
                      <span className="text-sm font-normal text-gray-600"> / {ranking.rankedCount}人</span>
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-600">{meta?.label ?? "記録"}</p>
                  <p className="text-3xl font-bold text-emerald-700">
                    {formatOrgChallengeValue(challenge.challengeType, detail.me.currentValue)}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-700">
                参加したばかりのため、まだ集計されていません。次の集計 (毎日 午前 3 時ごろ) のあとに、順位と記録が表示されます。
              </p>
            )}
          </section>
        )}

        {ranking.available && (
          <section aria-labelledby="ranking-title" className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <h2 id="ranking-title" className="font-bold text-gray-900 mb-1">順位表</h2>
            <p className="text-xs text-gray-600 mb-3">
              参加した人だけに表示されます。
              {ranking.showNames ? "" : "ほかの参加者のニックネームは表示されません。"}
              {ranking.truncated ? "上位の人とあなたの順位を表示しています。" : ""}
            </p>
            {ranking.entries.length === 0 ? (
              <p className="text-sm text-gray-700">まだ集計された参加者がいません。</p>
            ) : (
              <ol className="space-y-2">
                {ranking.entries.map((entry, index) => (
                  <li
                    key={`${entry.rank}-${index}`}
                    aria-current={entry.isMe ? "true" : undefined}
                    className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm ${
                      entry.isMe ? "bg-emerald-50 border border-emerald-200 font-bold text-emerald-900" : "bg-gray-50 text-gray-800"
                    }`}
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <span className="w-10 shrink-0 text-right font-bold">{rankLabel(entry.rank)}</span>
                      <span className="truncate">{entry.label}</span>
                    </span>
                    <span className="shrink-0">{formatOrgChallengeValue(challenge.challengeType, entry.value)}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}

        {detail.joined && (
          <section aria-labelledby="leave-title" className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <h2 id="leave-title" className="font-bold text-gray-900 mb-2">参加をやめる</h2>
            {!confirmingLeave ? (
              <>
                <p className="text-sm text-gray-700 mb-3">
                  参加をやめると、あなたの記録は順位から外れ、順位表も見られなくなります。
                  {isActive ? "もう一度参加することもできます。" : ""}
                </p>
                <button
                  type="button"
                  onClick={() => setConfirmingLeave(true)}
                  disabled={busy}
                  className="px-5 py-2 border border-gray-300 text-gray-800 rounded-full text-sm font-medium disabled:opacity-50"
                >
                  参加をやめる
                </button>
              </>
            ) : (
              <div role="group" aria-label="参加をやめる確認">
                <p className="text-sm text-gray-800 font-medium mb-3">本当に参加をやめますか?</p>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => void changeParticipation("DELETE")}
                    disabled={busy}
                    aria-busy={busy}
                    className="px-5 py-2 bg-red-700 text-white rounded-full text-sm font-bold disabled:opacity-50"
                  >
                    {busy ? "処理しています..." : "やめる"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingLeave(false)}
                    disabled={busy}
                    className="px-5 py-2 border border-gray-300 text-gray-800 rounded-full text-sm font-medium disabled:opacity-50"
                  >
                    続ける
                  </button>
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
