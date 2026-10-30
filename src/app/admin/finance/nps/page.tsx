"use client";

import { useEffect, useState } from "react";
import type { NpsSummary, CsatSummary } from "@/lib/admin/finance-schemas";
import { adminLoadFailedFallback, displayableAdminError, fetchAdminJson } from "@/lib/admin/admin-screen-messages";
import { ADMIN_PLAN_KEY_LABELS, adminPlanKeyLabel, type OfficialPlanKey } from "@/lib/admin/plan-key-labels";

/** 読み込みの失敗の文の対象 (「NPS の集計を読み込めませんでした (HTTP 502)」。#2086 V6) */
const NPS_SUBJECT = "NPS の集計";

/** プランの絞り込みの選択肢 (送る値は plan_key。並びは以前の選択肢と同じ) */
const NPS_PLAN_FILTER_KEYS: readonly OfficialPlanKey[] = [
  "free",
  "pro",
  "family_basic",
  "family_pro",
  "org_starter",
  "org_standard",
  "org_pro",
];

interface NpsApiResponse {
  nps: NpsSummary;
  csat: CsatSummary;
}

function ScoreBar({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="text-sm text-slate-500 w-20 shrink-0">{label}</div>
      <div className="flex-1 bg-slate-100 rounded-full h-2">
        <div className={`h-2 rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-sm font-medium text-slate-700 w-16 text-right">
        {count} ({pct.toFixed(1)}%)
      </div>
    </div>
  );
}

export default function NpsPage() {
  const [data, setData] = useState<NpsApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [planKey, setPlanKey] = useState("");

  const fetchData = () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (planKey) params.set("plan_key", planKey);

    // 失敗は日本語の文の例外にする (本文の無い 502 の「HTTP 502」・通信の reject の英字の文・JSON でない本文の SyntaxError を、
    // String(e) で「SyntaxError: …」「TypeError: Failed to fetch」と出さない。本文の error が文字列の形でも文を出す。#2086 V6)
    fetchAdminJson(`/api/admin/finance/nps?${params}`, NPS_SUBJECT)
      .then((body) => setData((body as { data?: NpsApiResponse }).data ?? null))
      .catch((e: unknown) => setError(displayableAdminError(e, adminLoadFailedFallback(NPS_SUBJECT))))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">NPS / CSAT</h1>
        <p className="text-sm text-slate-500 mt-1">Net Promoter Score & Customer Satisfaction</p>
      </div>

      {/* フィルタ */}
      <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4 mb-6 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs text-slate-500 mb-1">期間 FROM</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">期間 TO</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">プラン</label>
          <select value={planKey} onChange={(e) => setPlanKey(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
            <option value="">すべて</option>
            {/* 選択肢の文字はプランの表示名 (以前は英字の内部の値 free などのまま。#2112 Z3)。送る値は plan_key のまま */}
            {NPS_PLAN_FILTER_KEYS.map((key) => (
              <option key={key} value={key}>
                {ADMIN_PLAN_KEY_LABELS[key]}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={fetchData}
          className="px-4 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 transition-colors"
        >
          適用
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">{error}</div>
      ) : data ? (
        <div className="space-y-6">
          {/* NPS スコア */}
          <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-6">
            <h2 className="text-base font-semibold text-slate-700 mb-5">NPS (Net Promoter Score)</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <div className="text-center p-4 bg-indigo-50 rounded-xl">
                <div className="text-3xl font-bold text-indigo-700">{data.nps.nps_score}</div>
                <div className="text-xs text-indigo-500 mt-1">NPS スコア</div>
              </div>
              <div className="text-center p-4 bg-slate-50 rounded-xl">
                <div className="text-2xl font-bold text-slate-700">{data.nps.total_responses}</div>
                <div className="text-xs text-slate-400 mt-1">回答数</div>
              </div>
              <div className="text-center p-4 bg-slate-50 rounded-xl">
                <div className="text-2xl font-bold text-slate-700">{data.nps.avg_score}</div>
                <div className="text-xs text-slate-400 mt-1">平均スコア</div>
              </div>
              <div className="text-center p-4 bg-slate-50 rounded-xl">
                <div className="text-2xl font-bold text-slate-700">{data.nps.response_rate}%</div>
                <div className="text-xs text-slate-400 mt-1">回答率</div>
              </div>
            </div>

            <div className="space-y-3">
              <ScoreBar
                label="推薦者 (9-10)"
                count={data.nps.promoters}
                total={data.nps.total_responses}
                color="bg-green-500"
              />
              <ScoreBar
                label="中立 (7-8)"
                count={data.nps.passives}
                total={data.nps.total_responses}
                color="bg-yellow-400"
              />
              <ScoreBar
                label="批判者 (0-6)"
                count={data.nps.detractors}
                total={data.nps.total_responses}
                color="bg-red-400"
              />
            </div>
          </div>

          {/* CSAT */}
          <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-6">
            <h2 className="text-base font-semibold text-slate-700 mb-5">CSAT (Customer Satisfaction)</h2>
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div className="text-center p-4 bg-indigo-50 rounded-xl">
                <div className="text-3xl font-bold text-indigo-700">{data.csat.avg_score}</div>
                <div className="text-xs text-indigo-500 mt-1">平均スコア (1-5)</div>
              </div>
              <div className="text-center p-4 bg-slate-50 rounded-xl">
                <div className="text-2xl font-bold text-slate-700">{data.csat.total_responses}</div>
                <div className="text-xs text-slate-400 mt-1">回答数</div>
              </div>
            </div>

            <div className="space-y-2">
              {[5, 4, 3, 2, 1].map((score) => (
                <ScoreBar
                  key={score}
                  label={`★ ${score}`}
                  count={data.csat.score_distribution[String(score)] ?? 0}
                  total={data.csat.total_responses}
                  color={score >= 4 ? "bg-green-500" : score === 3 ? "bg-yellow-400" : "bg-red-400"}
                />
              ))}
            </div>
          </div>

          {/* 最近のコメント */}
          {data.nps.recent_comments.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-6">
              <h2 className="text-base font-semibold text-slate-700 mb-4">最近の NPS コメント</h2>
              <div className="space-y-3">
                {data.nps.recent_comments.map((c) => (
                  <div key={c.id} className="border border-slate-100 rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`text-sm font-bold ${c.score >= 9 ? "text-green-600" : c.score >= 7 ? "text-yellow-600" : "text-red-600"}`}>
                        {c.score}点
                      </span>
                      {c.plan_key && (
                        <span className="text-xs bg-slate-100 text-slate-500 px-2 py-0.5 rounded">
                          {/* プランは表示名で出す (以前は英字の内部の値 free などのまま。#2112 Z3) */}
                          {adminPlanKeyLabel(c.plan_key)}
                        </span>
                      )}
                      {c.responded_at && (
                        <span className="text-xs text-slate-400">
                          {new Date(c.responded_at).toLocaleDateString("ja-JP")}
                        </span>
                      )}
                    </div>
                    {c.comment && (
                      <p className="text-sm text-slate-600">{c.comment}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
