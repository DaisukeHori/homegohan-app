"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Droplet, ChevronRight, Activity, AlertTriangle, CheckCircle2,
  Calendar, TrendingUp, TrendingDown, Minus,
} from "lucide-react";
import {
  BLOOD_METRIC_DEFS, evaluateStatus, formatRangeText, getRangeForSex, getStatusLabel,
  type BiologicalSex,
} from "@/lib/health-blood-test-reference";

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
};

interface BloodTestResult {
  id: string;
  test_date: string;
  facility_name?: string;
  hemoglobin?: number;
  hba1c?: number;
  fasting_glucose?: number;
  total_cholesterol?: number;
  ldl_cholesterol?: number;
  hdl_cholesterol?: number;
  triglycerides?: number;
  ast?: number;
  alt?: number;
  gamma_gtp?: number;
  creatinine?: number;
  egfr?: number;
  uric_acid?: number;
}

// #1055 UX3-24: METRICS のキー一覧は BLOOD_METRIC_DEFS (性別依存・checkups詳細画面と共通) から生成する
type NumericMetricKey = Exclude<keyof BloodTestResult, 'id' | 'test_date' | 'facility_name'>;
const METRIC_KEYS: NumericMetricKey[] = [
  "hemoglobin", "hba1c", "fasting_glucose",
  "total_cholesterol", "ldl_cholesterol", "hdl_cholesterol", "triglycerides",
  "ast", "alt", "gamma_gtp", "creatinine", "egfr", "uric_acid",
];

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export default function BloodTestsPage() {
  const [results, setResults] = useState<BloodTestResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // #1055 UX3-24: 基準値をプロフィールの性別で分岐させる
  const [sex, setSex] = useState<BiologicalSex>(null);

  const fetchResults = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/health/blood-tests?limit=20");
      if (!res.ok) throw new Error("データの取得に失敗しました");
      const data = await res.json();
      setResults(data.results || []);
    } catch (e: any) {
      setError(e.message ?? "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchResults();
  }, [fetchResults]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/profile", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          setSex(data?.gender ?? null);
        }
      } catch (e) {
        console.error("Failed to fetch profile for reference ranges:", e);
      }
    })();
  }, []);

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
          <span className="text-sm" style={{ color: colors.textMuted }}>血液検査</span>
        </div>
        <h1 className="text-2xl font-bold" style={{ color: colors.text }}>血液検査結果</h1>
        <p className="text-sm mt-1" style={{ color: colors.textMuted }}>
          過去の血液検査データを一覧で確認できます
        </p>
        {sex !== 'male' && sex !== 'female' && (
          // #1055 (wave-3b): 性別未設定時は男女どちらでも確定的に異常と言える場合のみ
          // フラグする一般基準であることを明示する
          <p className="text-xs mt-1" style={{ color: colors.textMuted }}>
            ※ 性別未設定のため一般基準で判定しています
          </p>
        )}
      </div>

      {error && (
        <div className="mx-4 mb-4 p-4 rounded-xl flex items-center gap-3" style={{ backgroundColor: colors.errorLight }}>
          <AlertTriangle size={20} style={{ color: colors.error }} />
          <p className="text-sm" style={{ color: colors.error }}>{error}</p>
        </div>
      )}

      {results.length === 0 && !error ? (
        <div className="px-4">
          <div className="p-8 rounded-2xl text-center" style={{ backgroundColor: colors.card, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}>
            <Droplet size={48} className="mx-auto mb-4" style={{ color: colors.textMuted }} />
            <p className="font-medium mb-2" style={{ color: colors.text }}>血液検査結果がありません</p>
            <p className="text-sm" style={{ color: colors.textMuted }}>
              健診結果をカメラで撮影すると自動で記録されます
            </p>
            {/* #1051 UX3-02: 血液検査の記録は健診アップロード導線でしか作れないため、
                誤って食事スキャン(/meals/new)に誘導していたのを修正する */}
            <Link
              href="/health/checkups/new"
              className="inline-flex items-center gap-2 mt-4 px-5 py-2 rounded-xl text-sm font-medium text-white"
              style={{ backgroundColor: colors.accent }}
            >
              健診結果を記録する
            </Link>
          </div>
        </div>
      ) : (
        <div className="px-4 space-y-3">
          {results.map((result, idx) => {
            const isOpen = expanded === result.id;
            // 記録済み項目数
            const filledCount = METRIC_KEYS.filter((key) => result[key] != null).length;

            return (
              <motion.div
                key={result.id}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.05 }}
                className="rounded-2xl overflow-hidden"
                style={{ backgroundColor: colors.card, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}
              >
                {/* カードヘッダー */}
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : result.id)}
                  className="w-full p-4 flex items-center justify-between text-left"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: colors.errorLight }}>
                      <Droplet size={20} style={{ color: colors.error }} />
                    </div>
                    <div>
                      <p className="font-semibold" style={{ color: colors.text }}>
                        {formatDate(result.test_date)}
                      </p>
                      <p className="text-xs mt-0.5" style={{ color: colors.textMuted }}>
                        {result.facility_name ?? "施設名未記録"} · {filledCount}項目
                      </p>
                    </div>
                  </div>
                  <ChevronRight
                    size={18}
                    style={{
                      color: colors.textMuted,
                      transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
                      transition: "transform 0.2s",
                    }}
                  />
                </button>

                {/* 展開時の詳細 */}
                {isOpen && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="px-4 pb-4"
                  >
                    <div className="border-t pt-3" style={{ borderColor: colors.border }}>
                      <div className="grid grid-cols-2 gap-2">
                        {/* #1055 UX3-24: checkups詳細画面と同じ基準値モジュールで異常値をハイライトする (従来は範囲表示のみで判定が無かった) */}
                        {METRIC_KEYS.map((key) => {
                          const value = result[key];
                          if (value == null) return null;
                          const def = BLOOD_METRIC_DEFS[key];
                          const status = evaluateStatus(key, value, sex);
                          const isAbnormal = status === "high" || status === "low";
                          // #1051 UX3-07: 基準ぎりぎりも一律の異常扱いにせず「注意」として区別する
                          const isWarning = status === "warning_high" || status === "warning_low";
                          const statusColor = isAbnormal ? colors.error : isWarning ? colors.warning : colors.text;
                          const statusLabel = getStatusLabel(status);
                          const rangeText = formatRangeText(getRangeForSex(key, sex));
                          return (
                            <div
                              key={key}
                              className="p-3 rounded-xl"
                              style={{ backgroundColor: isAbnormal ? colors.errorLight : isWarning ? colors.warningLight : colors.bg }}
                            >
                              <p className="text-xs mb-1" style={{ color: colors.textMuted }}>{def.label}</p>
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <p
                                  className="font-bold text-base"
                                  style={{ color: statusColor }}
                                >
                                  {String(value)}
                                  <span className="text-xs font-normal ml-1" style={{ color: colors.textMuted }}>{def.unit}</span>
                                </p>
                                {/* #1051 UX3-07: 色ドットだけでなくテキストラベルも併記する */}
                                {statusLabel && (
                                  <span className="flex items-center gap-1">
                                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: statusColor }} />
                                    <span className="text-[10px] font-medium" style={{ color: statusColor }}>{statusLabel}</span>
                                  </span>
                                )}
                              </div>
                              <p className="text-xs mt-0.5" style={{ color: colors.textMuted }}>
                                基準: {rangeText}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </motion.div>
                )}
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
