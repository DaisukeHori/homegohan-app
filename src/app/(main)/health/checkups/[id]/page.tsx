"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  ArrowLeft, Trash2, Activity, Heart, Droplet, AlertTriangle,
  CheckCircle2, Sparkles, Calendar, MapPin, Loader2
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
  errorLight: '#FFEBEE',
  purple: '#7C4DFF',
  purpleLight: '#EDE7F6',
  blue: '#2196F3',
  blueLight: '#E3F2FD',
  border: '#EEEEEE',
};

interface HealthCheckup {
  id: string;
  checkup_date: string;
  facility_name?: string;
  checkup_type?: string;
  image_url?: string;
  height?: number;
  weight?: number;
  bmi?: number;
  waist_circumference?: number;
  blood_pressure_systolic?: number;
  blood_pressure_diastolic?: number;
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
  individual_review?: {
    summary: string;
    concerns: string[];
    positives: string[];
    recommendations: string[];
    riskLevel: 'low' | 'medium' | 'high';
  };
}

// 基準値の定義
const referenceValues: Record<string, { label: string; unit: string; normal: string; low?: number; high?: number }> = {
  blood_pressure_systolic: { label: '収縮期血圧', unit: 'mmHg', normal: '<130', high: 130 },
  blood_pressure_diastolic: { label: '拡張期血圧', unit: 'mmHg', normal: '<85', high: 85 },
  hba1c: { label: 'HbA1c', unit: '%', normal: '<5.6', high: 5.6 },
  fasting_glucose: { label: '空腹時血糖', unit: 'mg/dL', normal: '<100', high: 100 },
  total_cholesterol: { label: '総コレステロール', unit: 'mg/dL', normal: '<220', high: 220 },
  ldl_cholesterol: { label: 'LDL', unit: 'mg/dL', normal: '<140', high: 140 },
  hdl_cholesterol: { label: 'HDL', unit: 'mg/dL', normal: '≥40', low: 40 },
  triglycerides: { label: '中性脂肪', unit: 'mg/dL', normal: '<150', high: 150 },
  ast: { label: 'AST(GOT)', unit: 'U/L', normal: '≤30', high: 30 },
  alt: { label: 'ALT(GPT)', unit: 'U/L', normal: '≤30', high: 30 },
  gamma_gtp: { label: 'γ-GTP', unit: 'U/L', normal: '≤50', high: 50 },
  creatinine: { label: 'クレアチニン', unit: 'mg/dL', normal: '0.6-1.1', low: 0.6, high: 1.1 },
  egfr: { label: 'eGFR', unit: '', normal: '≥60', low: 60 },
  uric_acid: { label: '尿酸', unit: 'mg/dL', normal: '≤7.0', high: 7.0 },
};

export default function HealthCheckupDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [checkup, setCheckup] = useState<HealthCheckup | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    fetchCheckup();
  }, [id]);

  const fetchCheckup = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/health/checkups/${id}`);
      if (res.ok) {
        const data = await res.json();
        setCheckup(data.checkup);
      }
    } catch (error) {
      console.error('Failed to fetch checkup:', error);
    }
    setLoading(false);
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/health/checkups/${id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        router.push('/health/checkups');
      }
    } catch (error) {
      console.error('Failed to delete:', error);
    }
    setDeleting(false);
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  };

  const getValueStatus = (key: string, value: number | undefined): 'normal' | 'warning' | 'danger' => {
    if (value === undefined) return 'normal';
    const ref = referenceValues[key];
    if (!ref) return 'normal';

    if (ref.high && value > ref.high) return 'danger';
    if (ref.low && value < ref.low) return 'danger';
    return 'normal';
  };

  const getStatusStyle = (status: 'normal' | 'warning' | 'danger') => {
    switch (status) {
      case 'danger':
        return { bg: colors.errorLight, text: colors.error };
      case 'warning':
        return { bg: colors.warningLight, text: colors.warning };
      default:
        return { bg: colors.successLight, text: colors.success };
    }
  };

  const renderMetricRow = (key: string, value: number | undefined) => {
    if (value === undefined) return null;
    const ref = referenceValues[key];
    if (!ref) return null;

    const status = getValueStatus(key, value);
    const statusStyle = getStatusStyle(status);

    return (
      <div key={key} className="flex items-center justify-between py-2 border-b" style={{ borderColor: colors.border }}>
        <span className="text-sm" style={{ color: colors.textLight }}>{ref.label}</span>
        <div className="flex items-center gap-2">
          <span
            className="font-bold"
            style={{ color: status === 'normal' ? colors.text : statusStyle.text }}
          >
            {value}
          </span>
          <span className="text-xs" style={{ color: colors.textMuted }}>{ref.unit}</span>
          {status !== 'normal' && (
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: statusStyle.text }}
            />
          )}
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: colors.bg }}>
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
        >
          <Activity size={32} style={{ color: colors.accent }} />
        </motion.div>
      </div>
    );
  }

  if (!checkup) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: colors.bg }}>
        <p style={{ color: colors.textMuted }}>記録が見つかりません</p>
      </div>
    );
  }

  const review = checkup.individual_review;

  return (
    <div className="min-h-screen pb-24" style={{ backgroundColor: colors.bg }}>
      {/* ヘッダー */}
      <div className="sticky top-0 z-10 px-4 py-4" style={{ backgroundColor: colors.bg }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => router.back()}>
              <ArrowLeft size={24} style={{ color: colors.text }} />
            </button>
            <h1 className="text-xl font-bold" style={{ color: colors.text }}>
              健康診断詳細
            </h1>
          </div>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="p-2 rounded-full"
            style={{ backgroundColor: colors.errorLight }}
          >
            <Trash2 size={20} style={{ color: colors.error }} />
          </button>
        </div>
      </div>

      <div className="px-4 space-y-4">
        {/* 基本情報カード */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-4 rounded-xl"
          style={{ backgroundColor: colors.card }}
        >
          <div className="flex items-center gap-3 mb-3">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center"
              style={{ backgroundColor: colors.accentLight }}
            >
              <Calendar size={24} style={{ color: colors.accent }} />
            </div>
            <div>
              <p className="font-bold text-lg" style={{ color: colors.text }}>
                {formatDate(checkup.checkup_date)}
              </p>
              {checkup.checkup_type && (
                <span
                  className="text-xs px-2 py-0.5 rounded-full"
                  style={{ backgroundColor: colors.blueLight, color: colors.blue }}
                >
                  {checkup.checkup_type}
                </span>
              )}
            </div>
          </div>
          {checkup.facility_name && (
            <div className="flex items-center gap-2 text-sm" style={{ color: colors.textMuted }}>
              <MapPin size={14} />
              <span>{checkup.facility_name}</span>
            </div>
          )}
        </motion.div>

        {/* AIレビュー */}
        {review && (
          <>
            {/* 総評 */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="p-4 rounded-xl"
              style={{ backgroundColor: colors.purpleLight }}
            >
              <div className="flex items-center gap-2 mb-3">
                <Sparkles size={20} style={{ color: colors.purple }} />
                <span className="font-bold" style={{ color: colors.purple }}>AI分析</span>
              </div>
              <p className="text-sm leading-relaxed" style={{ color: colors.textLight }}>
                {review.summary}
              </p>
            </motion.div>

            {/* 気になる点 */}
            {review.concerns?.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 }}
                className="p-4 rounded-xl"
                style={{ backgroundColor: colors.warningLight }}
              >
                <div className="flex items-center gap-2 mb-3">
                  <AlertTriangle size={20} style={{ color: colors.warning }} />
                  <span className="font-bold" style={{ color: colors.warning }}>気になる点</span>
                </div>
                <ul className="space-y-2">
                  {review.concerns.map((item, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm" style={{ color: colors.textLight }}>
                      <span>•</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </motion.div>
            )}

            {/* 良い点 */}
            {review.positives?.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="p-4 rounded-xl"
                style={{ backgroundColor: colors.successLight }}
              >
                <div className="flex items-center gap-2 mb-3">
                  <CheckCircle2 size={20} style={{ color: colors.success }} />
                  <span className="font-bold" style={{ color: colors.success }}>良い点</span>
                </div>
                <ul className="space-y-2">
                  {review.positives.map((item, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm" style={{ color: colors.textLight }}>
                      <span>•</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </motion.div>
            )}

            {/* アドバイス */}
            {review.recommendations?.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.25 }}
                className="p-4 rounded-xl"
                style={{ backgroundColor: colors.card }}
              >
                <div className="flex items-center gap-2 mb-3">
                  <Sparkles size={20} style={{ color: colors.accent }} />
                  <span className="font-bold" style={{ color: colors.accent }}>改善アドバイス</span>
                </div>
                <ul className="space-y-2">
                  {review.recommendations.map((item, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm" style={{ color: colors.textLight }}>
                      <span className="font-bold" style={{ color: colors.accent }}>{i + 1}.</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </motion.div>
            )}
          </>
        )}

        {/* 検査値一覧 */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="p-4 rounded-xl"
          style={{ backgroundColor: colors.card }}
        >
          <h3 className="font-bold mb-4" style={{ color: colors.text }}>検査値</h3>

          {/* 血圧・代謝 */}
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <Heart size={16} style={{ color: colors.error }} />
              <span className="text-sm font-bold" style={{ color: colors.textLight }}>血圧・代謝</span>
            </div>
            {renderMetricRow('blood_pressure_systolic', checkup.blood_pressure_systolic)}
            {renderMetricRow('blood_pressure_diastolic', checkup.blood_pressure_diastolic)}
            {renderMetricRow('hba1c', checkup.hba1c)}
            {renderMetricRow('fasting_glucose', checkup.fasting_glucose)}
          </div>

          {/* 脂質 */}
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <Droplet size={16} style={{ color: colors.warning }} />
              <span className="text-sm font-bold" style={{ color: colors.textLight }}>脂質</span>
            </div>
            {renderMetricRow('total_cholesterol', checkup.total_cholesterol)}
            {renderMetricRow('ldl_cholesterol', checkup.ldl_cholesterol)}
            {renderMetricRow('hdl_cholesterol', checkup.hdl_cholesterol)}
            {renderMetricRow('triglycerides', checkup.triglycerides)}
          </div>

          {/* 肝機能 */}
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <Activity size={16} style={{ color: colors.purple }} />
              <span className="text-sm font-bold" style={{ color: colors.textLight }}>肝機能</span>
            </div>
            {renderMetricRow('ast', checkup.ast)}
            {renderMetricRow('alt', checkup.alt)}
            {renderMetricRow('gamma_gtp', checkup.gamma_gtp)}
          </div>

          {/* 腎機能 */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Activity size={16} style={{ color: colors.blue }} />
              <span className="text-sm font-bold" style={{ color: colors.textLight }}>腎機能・尿酸</span>
            </div>
            {renderMetricRow('creatinine', checkup.creatinine)}
            {renderMetricRow('egfr', checkup.egfr)}
            {renderMetricRow('uric_acid', checkup.uric_acid)}
          </div>
        </motion.div>

        {/* 画像 */}
        {checkup.image_url && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.35 }}
            className="rounded-xl overflow-hidden"
          >
            <img
              src={checkup.image_url}
              alt="健康診断結果"
              className="w-full h-auto"
            />
          </motion.div>
        )}
      </div>

      {/* 削除確認モーダル */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-full max-w-sm p-6 rounded-2xl"
            style={{ backgroundColor: colors.card }}
          >
            <h3 className="text-lg font-bold mb-2" style={{ color: colors.text }}>
              記録を削除しますか？
            </h3>
            <p className="text-sm mb-6" style={{ color: colors.textMuted }}>
              この操作は取り消せません。
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="flex-1 py-3 rounded-full font-bold"
                style={{ backgroundColor: colors.bg, color: colors.text }}
              >
                キャンセル
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex-1 py-3 rounded-full font-bold text-white flex items-center justify-center gap-2"
                style={{ backgroundColor: colors.error }}
              >
                {deleting ? (
                  <Loader2 size={20} className="animate-spin" />
                ) : (
                  '削除'
                )}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
