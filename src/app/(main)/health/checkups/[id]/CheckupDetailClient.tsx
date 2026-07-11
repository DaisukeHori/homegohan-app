/* eslint-disable @next/next/no-img-element */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  ArrowLeft, Trash2, Activity, Heart, Droplet, AlertTriangle,
  CheckCircle2, Sparkles, Calendar, MapPin, Loader2, Scale,
} from 'lucide-react';
import {
  ALL_METRIC_DEFS, evaluateStatus, formatRangeText, getRangeForSex, getStatusLabel,
  type BiologicalSex, type MetricStatus,
} from '@/lib/health-blood-test-reference';

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

// #1055 UX3-24: 基準値は @/lib/health-blood-test-reference (性別依存・blood-tests画面と共通) を単一ソースにする

interface Props {
  id: string;
}

export default function CheckupDetailClient({ id }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [checkup, setCheckup] = useState<HealthCheckup | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // #1051 UX3-05: 削除失敗が無反応になっていたため、モーダルを保持したままエラーを表示する
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // #1055 UX3-24: 基準値をプロフィールの性別で分岐させる
  const [sex, setSex] = useState<BiologicalSex>(null);

  const fetchCheckup = useCallback(async () => {
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
  }, [id]);

  useEffect(() => {
    void fetchCheckup();
  }, [fetchCheckup]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/profile', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          setSex(data?.gender ?? null);
        }
      } catch (error) {
        console.error('Failed to fetch profile for reference ranges:', error);
      }
    })();
  }, []);

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/health/checkups/${id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        router.push('/health/checkups');
        return;
      }
      // #1051 UX3-05: 失敗時に無反応にせず、モーダルを保持したまま再試行できるようにする
      const data = await res.json().catch(() => null);
      setDeleteError(data?.error || '削除に失敗しました。もう一度お試しください。');
    } catch (error) {
      console.error('Failed to delete:', error);
      setDeleteError('削除に失敗しました。もう一度お試しください。');
    }
    setDeleting(false);
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  };

  const getStatusStyle = (status: MetricStatus) => {
    switch (status) {
      case 'high':
      case 'low':
        return { bg: colors.errorLight, text: colors.error };
      // #1051 UX3-07: 基準値ぎりぎりも一律の赤ではなく「注意」として区別する
      case 'warning_high':
      case 'warning_low':
        return { bg: colors.warningLight, text: colors.warning };
      default:
        return { bg: colors.successLight, text: colors.success };
    }
  };

  const renderMetricRow = (key: string, value: number | undefined) => {
    if (value === undefined) return null;
    const def = ALL_METRIC_DEFS[key];
    if (!def) return null;

    const status = evaluateStatus(key, value, sex);
    const statusStyle = getStatusStyle(status);
    const rangeText = formatRangeText(getRangeForSex(key, sex));
    const statusLabel = getStatusLabel(status);

    return (
      <div key={key} className="flex items-center justify-between py-2 border-b" style={{ borderColor: colors.border }}>
        <div>
          <span className="text-sm" style={{ color: colors.textLight }}>{def.label}</span>
          <p className="text-xs" style={{ color: colors.textMuted }}>基準: {rangeText}</p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="font-bold"
            style={{ color: status === 'normal' || status === 'unknown' ? colors.text : statusStyle.text }}
          >
            {value}
          </span>
          <span className="text-xs" style={{ color: colors.textMuted }}>{def.unit}</span>
          {/* #1051 UX3-07: 色ドットだけでなくテキストラベルも併記する */}
          {statusLabel && (
            <span className="flex items-center gap-1">
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: statusStyle.text }}
              />
              <span className="text-xs font-medium" style={{ color: statusStyle.text }}>{statusLabel}</span>
            </span>
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
          {sex !== 'male' && sex !== 'female' && (
            // #1055 (wave-3b): 性別未設定時は男女どちらでも確定的に異常と言える場合のみ
            // フラグする一般基準であることを明示する
            <p className="text-xs mb-3" style={{ color: colors.textMuted }}>
              ※ 性別未設定のため一般基準で判定しています
            </p>
          )}

          {/* 身体測定 (#1051 UX3-07: 従来この画面で一切表示されていなかった) */}
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <Scale size={16} style={{ color: colors.accent }} />
              <span className="text-sm font-bold" style={{ color: colors.textLight }}>身体測定</span>
            </div>
            {renderMetricRow('height', checkup.height)}
            {renderMetricRow('weight', checkup.weight)}
            {renderMetricRow('bmi', checkup.bmi)}
            {renderMetricRow('waist_circumference', checkup.waist_circumference)}
          </div>

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
            {/* #1055 UX3-24: hemoglobin は従来この画面で一切表示されていなかった */}
            {renderMetricRow('hemoglobin', checkup.hemoglobin)}
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
            <p className="text-sm mb-4" style={{ color: colors.textMuted }}>
              この操作は取り消せません。
            </p>
            {/* #1051 UX3-05: 削除失敗を無反応にせず、モーダルを保持したままエラーを表示する */}
            {deleteError && (
              <div className="flex items-start gap-2 p-3 mb-4 rounded-lg" style={{ backgroundColor: colors.errorLight }}>
                <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" style={{ color: colors.error }} />
                <p className="text-sm" style={{ color: colors.error }}>{deleteError}</p>
              </div>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => { setShowDeleteConfirm(false); setDeleteError(null); }}
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
