"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  FileText, Plus, ChevronRight, TrendingUp, TrendingDown, Minus,
  Activity, AlertTriangle, CheckCircle2, Clock, Heart, Droplet
} from 'lucide-react';

// カラーパレット
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
  blood_pressure_systolic?: number;
  blood_pressure_diastolic?: number;
  hba1c?: number;
  ldl_cholesterol?: number;
  triglycerides?: number;
  individual_review?: {
    summary: string;
    concerns: string[];
    positives: string[];
    recommendations: string[];
    riskLevel: 'low' | 'medium' | 'high';
  };
}

interface LongitudinalReview {
  id: string;
  review_date: string;
  trend_analysis?: {
    overallAssessment: string;
    improvingMetrics: { metric: string; detail: string }[];
    worseningMetrics: { metric: string; detail: string; severity: string }[];
    stableMetrics: string[];
    priorityActions: string[];
  };
  nutrition_guidance?: {
    generalDirection: string;
    avoidanceHints: string[];
    emphasisHints: string[];
    specialNotes: string;
  };
}

export default function HealthCheckupsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [checkups, setCheckups] = useState<HealthCheckup[]>([]);
  const [longitudinalReview, setLongitudinalReview] = useState<LongitudinalReview | null>(null);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/health/checkups');
      if (res.ok) {
        const data = await res.json();
        setCheckups(data.checkups || []);
        setLongitudinalReview(data.longitudinalReview);
      }
    } catch (error) {
      console.error('Failed to fetch checkups:', error);
    }
    setLoading(false);
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return `${date.getFullYear()}/${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getDate().toString().padStart(2, '0')}`;
  };

  const getRiskLevelStyle = (level?: string) => {
    switch (level) {
      case 'high':
        return { bg: colors.errorLight, text: colors.error };
      case 'medium':
        return { bg: colors.warningLight, text: colors.warning };
      default:
        return { bg: colors.successLight, text: colors.success };
    }
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

  return (
    <div className="min-h-screen pb-24" style={{ backgroundColor: colors.bg }}>
      {/* ヘッダー */}
      <div className="sticky top-0 z-10 px-4 py-4" style={{ backgroundColor: colors.bg }}>
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold" style={{ color: colors.text }}>
            健康診断記録
          </h1>
          <Link href="/health/checkups/new">
            <motion.button
              whileTap={{ scale: 0.95 }}
              className="w-10 h-10 rounded-full flex items-center justify-center shadow-md"
              style={{ backgroundColor: colors.accent }}
            >
              <Plus size={20} color="white" />
            </motion.button>
          </Link>
        </div>
      </div>

      <div className="px-4 space-y-4">
        {/* 経年分析カード */}
        {longitudinalReview && longitudinalReview.trend_analysis && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-4 rounded-2xl"
            style={{
              background: `linear-gradient(135deg, ${colors.purple} 0%, ${colors.blue} 100%)`,
            }}
          >
            <div className="flex items-center gap-2 mb-3">
              <Activity size={20} color="white" />
              <span className="text-white font-bold">経年分析</span>
              <span className="text-white/60 text-xs ml-auto">
                {formatDate(longitudinalReview.review_date)}
              </span>
            </div>

            <p className="text-white/90 text-sm mb-4 leading-relaxed">
              {longitudinalReview.trend_analysis.overallAssessment}
            </p>

            {/* 傾向指標 */}
            <div className="space-y-2">
              {longitudinalReview.trend_analysis.improvingMetrics?.slice(0, 2).map((item, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <div className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center">
                    <TrendingDown size={14} className="text-green-300" />
                  </div>
                  <span className="text-white/90">{item.metric}</span>
                  <span className="text-green-300 text-xs ml-auto">改善</span>
                </div>
              ))}
              {longitudinalReview.trend_analysis.worseningMetrics?.slice(0, 2).map((item, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <div className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center">
                    <TrendingUp size={14} className="text-red-300" />
                  </div>
                  <span className="text-white/90">{item.metric}</span>
                  <span className="text-red-300 text-xs ml-auto">要注意</span>
                </div>
              ))}
            </div>

            {/* 食事方針 */}
            {longitudinalReview.nutrition_guidance && (
              <div className="mt-4 pt-4 border-t border-white/20">
                <p className="text-white/70 text-xs mb-1">食事方針</p>
                <p className="text-white text-sm">
                  {longitudinalReview.nutrition_guidance.generalDirection}
                </p>
              </div>
            )}
          </motion.div>
        )}

        {/* 健康診断一覧 */}
        <div className="space-y-3">
          {checkups.length === 0 ? (
            <div className="text-center py-12">
              <FileText size={48} className="mx-auto mb-4" style={{ color: colors.textMuted }} />
              <p className="text-sm" style={{ color: colors.textMuted }}>
                健康診断の記録がありません
              </p>
              <Link href="/health/checkups/new">
                <motion.button
                  whileTap={{ scale: 0.95 }}
                  className="mt-4 px-6 py-3 rounded-full text-white font-bold text-sm"
                  style={{ backgroundColor: colors.accent }}
                >
                  最初の記録を追加
                </motion.button>
              </Link>
            </div>
          ) : (
            checkups.map((checkup, index) => {
              const riskStyle = getRiskLevelStyle(checkup.individual_review?.riskLevel);
              return (
                <motion.div
                  key={checkup.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05 }}
                  onClick={() => router.push(`/health/checkups/${checkup.id}`)}
                  className="p-4 rounded-xl cursor-pointer active:scale-[0.98] transition-transform"
                  style={{ backgroundColor: colors.card, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-bold" style={{ color: colors.text }}>
                          {formatDate(checkup.checkup_date)}
                        </span>
                        {checkup.checkup_type && (
                          <span
                            className="text-xs px-2 py-0.5 rounded-full"
                            style={{ backgroundColor: colors.blueLight, color: colors.blue }}
                          >
                            {checkup.checkup_type}
                          </span>
                        )}
                      </div>
                      {checkup.facility_name && (
                        <p className="text-xs mb-2" style={{ color: colors.textMuted }}>
                          {checkup.facility_name}
                        </p>
                      )}

                      {/* 主要指標 */}
                      <div className="flex flex-wrap gap-3 text-xs">
                        {checkup.blood_pressure_systolic && (
                          <div className="flex items-center gap-1">
                            <Heart size={12} style={{ color: colors.error }} />
                            <span style={{ color: colors.textLight }}>
                              {checkup.blood_pressure_systolic}/{checkup.blood_pressure_diastolic}
                            </span>
                          </div>
                        )}
                        {checkup.hba1c && (
                          <div className="flex items-center gap-1">
                            <Droplet size={12} style={{ color: colors.purple }} />
                            <span style={{ color: colors.textLight }}>
                              HbA1c {checkup.hba1c}%
                            </span>
                          </div>
                        )}
                        {checkup.ldl_cholesterol && (
                          <div className="flex items-center gap-1">
                            <Activity size={12} style={{ color: colors.warning }} />
                            <span style={{ color: colors.textLight }}>
                              LDL {checkup.ldl_cholesterol}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* AIサマリー */}
                      {checkup.individual_review?.summary && (
                        <p
                          className="text-xs mt-2 line-clamp-2"
                          style={{ color: colors.textMuted }}
                        >
                          {checkup.individual_review.summary}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      {checkup.individual_review?.riskLevel && (
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center"
                          style={{ backgroundColor: riskStyle.bg }}
                        >
                          {checkup.individual_review.riskLevel === 'high' ? (
                            <AlertTriangle size={16} style={{ color: riskStyle.text }} />
                          ) : checkup.individual_review.riskLevel === 'medium' ? (
                            <Clock size={16} style={{ color: riskStyle.text }} />
                          ) : (
                            <CheckCircle2 size={16} style={{ color: riskStyle.text }} />
                          )}
                        </div>
                      )}
                      <ChevronRight size={20} style={{ color: colors.textMuted }} />
                    </div>
                  </div>
                </motion.div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
