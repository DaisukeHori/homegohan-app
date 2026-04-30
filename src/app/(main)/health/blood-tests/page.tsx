"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Droplet, ChevronRight, Activity, AlertTriangle, CheckCircle2,
  Calendar, TrendingUp, TrendingDown, Minus,
} from "lucide-react";

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

const METRICS: { key: keyof BloodTestResult; label: string; unit: string; normalRange?: string }[] = [
  { key: "hemoglobin",       label: "ヘモグロビン",       unit: "g/dL",  normalRange: "12.0–16.0" },
  { key: "hba1c",            label: "HbA1c",             unit: "%",     normalRange: "4.6–6.2" },
  { key: "fasting_glucose",  label: "空腹時血糖",         unit: "mg/dL", normalRange: "70–109" },
  { key: "total_cholesterol",label: "総コレステロール",   unit: "mg/dL", normalRange: "120–219" },
  { key: "ldl_cholesterol",  label: "LDLコレステロール",  unit: "mg/dL", normalRange: "60–119" },
  { key: "hdl_cholesterol",  label: "HDLコレステロール",  unit: "mg/dL", normalRange: "40–96" },
  { key: "triglycerides",    label: "中性脂肪",           unit: "mg/dL", normalRange: "30–149" },
  { key: "ast",              label: "AST (GOT)",          unit: "U/L",   normalRange: "10–40" },
  { key: "alt",              label: "ALT (GPT)",          unit: "U/L",   normalRange: "5–45" },
  { key: "gamma_gtp",        label: "γ-GTP",             unit: "U/L",   normalRange: "0–80" },
  { key: "creatinine",       label: "クレアチニン",       unit: "mg/dL", normalRange: "0.46–1.04" },
  { key: "egfr",             label: "eGFR",               unit: "mL/min/1.73m²" },
  { key: "uric_acid",        label: "尿酸",               unit: "mg/dL", normalRange: "2.1–7.0" },
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
              カメラで健診結果を撮影すると自動で記録されます
            </p>
            <Link
              href="/meals/new"
              className="inline-flex items-center gap-2 mt-4 px-5 py-2 rounded-xl text-sm font-medium text-white"
              style={{ backgroundColor: colors.accent }}
            >
              写真で記録する
            </Link>
          </div>
        </div>
      ) : (
        <div className="px-4 space-y-3">
          {results.map((result, idx) => {
            const isOpen = expanded === result.id;
            // 記録済み項目数
            const filledCount = METRICS.filter((m) => result[m.key] != null).length;

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
                        {METRICS.map((m) => {
                          const value = result[m.key];
                          if (value == null) return null;
                          return (
                            <div key={m.key} className="p-3 rounded-xl" style={{ backgroundColor: colors.bg }}>
                              <p className="text-xs mb-1" style={{ color: colors.textMuted }}>{m.label}</p>
                              <p className="font-bold text-base" style={{ color: colors.text }}>
                                {String(value)}
                                <span className="text-xs font-normal ml-1" style={{ color: colors.textMuted }}>{m.unit}</span>
                              </p>
                              {m.normalRange && (
                                <p className="text-xs mt-0.5" style={{ color: colors.textMuted }}>
                                  基準: {m.normalRange}
                                </p>
                              )}
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
