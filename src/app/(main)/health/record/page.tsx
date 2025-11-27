"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { createClient } from "@/lib/supabase/client";
import {
  Scale, Heart, Moon, Droplets, Activity, Thermometer,
  ArrowLeft, Save, ChevronDown, ChevronUp, Smile, Frown, Meh,
  Footprints, Brain, Sparkles, AlertCircle
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

interface FormData {
  weight: string;
  body_fat_percentage: string;
  systolic_bp: string;
  diastolic_bp: string;
  heart_rate: string;
  body_temp: string;
  sleep_hours: string;
  sleep_quality: number | null;
  water_intake: string;
  step_count: string;
  bowel_movement: string;
  overall_condition: number | null;
  mood_score: number | null;
  energy_level: number | null;
  stress_level: number | null;
  daily_note: string;
}

export default function HealthRecordPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    body: true,
    vitals: false,
    lifestyle: false,
    condition: true,
  });
  
  const today = new Date().toISOString().split('T')[0];
  const [recordDate, setRecordDate] = useState(today);
  
  const [formData, setFormData] = useState<FormData>({
    weight: '',
    body_fat_percentage: '',
    systolic_bp: '',
    diastolic_bp: '',
    heart_rate: '',
    body_temp: '',
    sleep_hours: '',
    sleep_quality: null,
    water_intake: '',
    step_count: '',
    bowel_movement: '',
    overall_condition: null,
    mood_score: null,
    energy_level: null,
    stress_level: null,
    daily_note: '',
  });

  useEffect(() => {
    fetchRecord();
  }, [recordDate]);

  const fetchRecord = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/health/records/${recordDate}`);
      if (res.ok) {
        const data = await res.json();
        if (data.record) {
          setFormData({
            weight: data.record.weight?.toString() || '',
            body_fat_percentage: data.record.body_fat_percentage?.toString() || '',
            systolic_bp: data.record.systolic_bp?.toString() || '',
            diastolic_bp: data.record.diastolic_bp?.toString() || '',
            heart_rate: data.record.heart_rate?.toString() || '',
            body_temp: data.record.body_temp?.toString() || '',
            sleep_hours: data.record.sleep_hours?.toString() || '',
            sleep_quality: data.record.sleep_quality || null,
            water_intake: data.record.water_intake?.toString() || '',
            step_count: data.record.step_count?.toString() || '',
            bowel_movement: data.record.bowel_movement?.toString() || '',
            overall_condition: data.record.overall_condition || null,
            mood_score: data.record.mood_score || null,
            energy_level: data.record.energy_level || null,
            stress_level: data.record.stress_level || null,
            daily_note: data.record.daily_note || '',
          });
        }
      }
    } catch (error) {
      console.error('Failed to fetch record:', error);
    }
    setLoading(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload: Record<string, any> = {
        record_date: recordDate,
      };

      // 数値フィールドの変換
      if (formData.weight) payload.weight = parseFloat(formData.weight);
      if (formData.body_fat_percentage) payload.body_fat_percentage = parseFloat(formData.body_fat_percentage);
      if (formData.systolic_bp) payload.systolic_bp = parseInt(formData.systolic_bp);
      if (formData.diastolic_bp) payload.diastolic_bp = parseInt(formData.diastolic_bp);
      if (formData.heart_rate) payload.heart_rate = parseInt(formData.heart_rate);
      if (formData.body_temp) payload.body_temp = parseFloat(formData.body_temp);
      if (formData.sleep_hours) payload.sleep_hours = parseFloat(formData.sleep_hours);
      if (formData.sleep_quality !== null) payload.sleep_quality = formData.sleep_quality;
      if (formData.water_intake) payload.water_intake = parseInt(formData.water_intake);
      if (formData.step_count) payload.step_count = parseInt(formData.step_count);
      if (formData.bowel_movement) payload.bowel_movement = parseInt(formData.bowel_movement);
      if (formData.overall_condition !== null) payload.overall_condition = formData.overall_condition;
      if (formData.mood_score !== null) payload.mood_score = formData.mood_score;
      if (formData.energy_level !== null) payload.energy_level = formData.energy_level;
      if (formData.stress_level !== null) payload.stress_level = formData.stress_level;
      if (formData.daily_note) payload.daily_note = formData.daily_note;

      const res = await fetch('/api/health/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        router.push('/health');
      }
    } catch (error) {
      console.error('Failed to save:', error);
    }
    setSaving(false);
  };

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const renderScoreButtons = (
    value: number | null,
    onChange: (v: number | null) => void,
    emojis: string[]
  ) => (
    <div className="flex justify-between gap-2">
      {[1, 2, 3, 4, 5].map((score) => (
        <motion.button
          key={score}
          type="button"
          whileTap={{ scale: 0.95 }}
          onClick={() => onChange(value === score ? null : score)}
          className="flex-1 py-3 rounded-xl text-xl"
          style={{ 
            backgroundColor: value === score ? colors.accentLight : colors.bg,
            border: value === score ? `2px solid ${colors.accent}` : '2px solid transparent',
          }}
        >
          {emojis[score - 1]}
        </motion.button>
      ))}
    </div>
  );

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: colors.bg }}>
        <Activity size={32} className="animate-spin" style={{ color: colors.accent }} />
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-24" style={{ backgroundColor: colors.bg }}>
      {/* ヘッダー */}
      <div className="sticky top-0 z-10 px-4 py-4 flex items-center justify-between" style={{ backgroundColor: colors.bg }}>
        <button onClick={() => router.back()} className="p-2 -ml-2">
          <ArrowLeft size={24} style={{ color: colors.text }} />
        </button>
        <h1 className="font-bold" style={{ color: colors.text }}>健康記録</h1>
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 rounded-lg font-medium text-white"
          style={{ backgroundColor: colors.accent }}
        >
          {saving ? '保存中...' : '保存'}
        </motion.button>
      </div>

      {/* 日付選択 */}
      <div className="px-4 mb-4">
        <input
          type="date"
          value={recordDate}
          onChange={(e) => setRecordDate(e.target.value)}
          max={today}
          className="w-full p-3 rounded-xl font-medium"
          style={{ 
            backgroundColor: colors.card,
            color: colors.text,
            border: `1px solid ${colors.border}`,
          }}
        />
      </div>

      {/* 体組成セクション */}
      <div className="px-4 mb-4">
        <motion.div
          className="rounded-2xl overflow-hidden"
          style={{ backgroundColor: colors.card }}
        >
          <button
            onClick={() => toggleSection('body')}
            className="w-full p-4 flex items-center justify-between"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: colors.accentLight }}>
                <Scale size={20} style={{ color: colors.accent }} />
              </div>
              <span className="font-semibold" style={{ color: colors.text }}>体組成</span>
            </div>
            {expandedSections.body ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
          </button>
          
          {expandedSections.body && (
            <div className="px-4 pb-4 space-y-4">
              <div>
                <label className="block text-sm mb-1" style={{ color: colors.textLight }}>体重 (kg)</label>
                <input
                  type="number"
                  step="0.1"
                  value={formData.weight}
                  onChange={(e) => setFormData({ ...formData, weight: e.target.value })}
                  placeholder="65.0"
                  className="w-full p-3 rounded-xl"
                  style={{ backgroundColor: colors.bg, color: colors.text }}
                />
              </div>
              <div>
                <label className="block text-sm mb-1" style={{ color: colors.textLight }}>体脂肪率 (%)</label>
                <input
                  type="number"
                  step="0.1"
                  value={formData.body_fat_percentage}
                  onChange={(e) => setFormData({ ...formData, body_fat_percentage: e.target.value })}
                  placeholder="20.0"
                  className="w-full p-3 rounded-xl"
                  style={{ backgroundColor: colors.bg, color: colors.text }}
                />
              </div>
            </div>
          )}
        </motion.div>
      </div>

      {/* バイタルセクション */}
      <div className="px-4 mb-4">
        <motion.div
          className="rounded-2xl overflow-hidden"
          style={{ backgroundColor: colors.card }}
        >
          <button
            onClick={() => toggleSection('vitals')}
            className="w-full p-4 flex items-center justify-between"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: colors.errorLight }}>
                <Heart size={20} style={{ color: colors.error }} />
              </div>
              <span className="font-semibold" style={{ color: colors.text }}>バイタル</span>
            </div>
            {expandedSections.vitals ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
          </button>
          
          {expandedSections.vitals && (
            <div className="px-4 pb-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm mb-1" style={{ color: colors.textLight }}>収縮期血圧</label>
                  <input
                    type="number"
                    value={formData.systolic_bp}
                    onChange={(e) => setFormData({ ...formData, systolic_bp: e.target.value })}
                    placeholder="120"
                    className="w-full p-3 rounded-xl"
                    style={{ backgroundColor: colors.bg, color: colors.text }}
                  />
                </div>
                <div>
                  <label className="block text-sm mb-1" style={{ color: colors.textLight }}>拡張期血圧</label>
                  <input
                    type="number"
                    value={formData.diastolic_bp}
                    onChange={(e) => setFormData({ ...formData, diastolic_bp: e.target.value })}
                    placeholder="80"
                    className="w-full p-3 rounded-xl"
                    style={{ backgroundColor: colors.bg, color: colors.text }}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm mb-1" style={{ color: colors.textLight }}>脈拍 (bpm)</label>
                  <input
                    type="number"
                    value={formData.heart_rate}
                    onChange={(e) => setFormData({ ...formData, heart_rate: e.target.value })}
                    placeholder="70"
                    className="w-full p-3 rounded-xl"
                    style={{ backgroundColor: colors.bg, color: colors.text }}
                  />
                </div>
                <div>
                  <label className="block text-sm mb-1" style={{ color: colors.textLight }}>体温 (℃)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.body_temp}
                    onChange={(e) => setFormData({ ...formData, body_temp: e.target.value })}
                    placeholder="36.5"
                    className="w-full p-3 rounded-xl"
                    style={{ backgroundColor: colors.bg, color: colors.text }}
                  />
                </div>
              </div>
            </div>
          )}
        </motion.div>
      </div>

      {/* 生活習慣セクション */}
      <div className="px-4 mb-4">
        <motion.div
          className="rounded-2xl overflow-hidden"
          style={{ backgroundColor: colors.card }}
        >
          <button
            onClick={() => toggleSection('lifestyle')}
            className="w-full p-4 flex items-center justify-between"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: colors.purpleLight }}>
                <Moon size={20} style={{ color: colors.purple }} />
              </div>
              <span className="font-semibold" style={{ color: colors.text }}>生活習慣</span>
            </div>
            {expandedSections.lifestyle ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
          </button>
          
          {expandedSections.lifestyle && (
            <div className="px-4 pb-4 space-y-4">
              <div>
                <label className="block text-sm mb-1" style={{ color: colors.textLight }}>睡眠時間 (時間)</label>
                <input
                  type="number"
                  step="0.5"
                  value={formData.sleep_hours}
                  onChange={(e) => setFormData({ ...formData, sleep_hours: e.target.value })}
                  placeholder="7.0"
                  className="w-full p-3 rounded-xl"
                  style={{ backgroundColor: colors.bg, color: colors.text }}
                />
              </div>
              <div>
                <label className="block text-sm mb-2" style={{ color: colors.textLight }}>睡眠の質</label>
                {renderScoreButtons(
                  formData.sleep_quality,
                  (v) => setFormData({ ...formData, sleep_quality: v }),
                  ['😵', '😪', '😴', '😌', '🌟']
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm mb-1" style={{ color: colors.textLight }}>水分摂取 (ml)</label>
                  <input
                    type="number"
                    step="100"
                    value={formData.water_intake}
                    onChange={(e) => setFormData({ ...formData, water_intake: e.target.value })}
                    placeholder="2000"
                    className="w-full p-3 rounded-xl"
                    style={{ backgroundColor: colors.bg, color: colors.text }}
                  />
                </div>
                <div>
                  <label className="block text-sm mb-1" style={{ color: colors.textLight }}>歩数</label>
                  <input
                    type="number"
                    value={formData.step_count}
                    onChange={(e) => setFormData({ ...formData, step_count: e.target.value })}
                    placeholder="8000"
                    className="w-full p-3 rounded-xl"
                    style={{ backgroundColor: colors.bg, color: colors.text }}
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm mb-1" style={{ color: colors.textLight }}>便通 (回)</label>
                <input
                  type="number"
                  value={formData.bowel_movement}
                  onChange={(e) => setFormData({ ...formData, bowel_movement: e.target.value })}
                  placeholder="1"
                  className="w-full p-3 rounded-xl"
                  style={{ backgroundColor: colors.bg, color: colors.text }}
                />
              </div>
            </div>
          )}
        </motion.div>
      </div>

      {/* 体調・メンタルセクション */}
      <div className="px-4 mb-4">
        <motion.div
          className="rounded-2xl overflow-hidden"
          style={{ backgroundColor: colors.card }}
        >
          <button
            onClick={() => toggleSection('condition')}
            className="w-full p-4 flex items-center justify-between"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: colors.successLight }}>
                <Sparkles size={20} style={{ color: colors.success }} />
              </div>
              <span className="font-semibold" style={{ color: colors.text }}>体調・メンタル</span>
            </div>
            {expandedSections.condition ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
          </button>
          
          {expandedSections.condition && (
            <div className="px-4 pb-4 space-y-4">
              <div>
                <label className="block text-sm mb-2" style={{ color: colors.textLight }}>全体的な体調</label>
                {renderScoreButtons(
                  formData.overall_condition,
                  (v) => setFormData({ ...formData, overall_condition: v }),
                  ['😫', '😔', '😐', '🙂', '😄']
                )}
              </div>
              <div>
                <label className="block text-sm mb-2" style={{ color: colors.textLight }}>気分</label>
                {renderScoreButtons(
                  formData.mood_score,
                  (v) => setFormData({ ...formData, mood_score: v }),
                  ['😢', '😔', '😐', '😊', '🥰']
                )}
              </div>
              <div>
                <label className="block text-sm mb-2" style={{ color: colors.textLight }}>エネルギーレベル</label>
                {renderScoreButtons(
                  formData.energy_level,
                  (v) => setFormData({ ...formData, energy_level: v }),
                  ['🪫', '🔋', '⚡', '💪', '🚀']
                )}
              </div>
              <div>
                <label className="block text-sm mb-2" style={{ color: colors.textLight }}>ストレスレベル</label>
                {renderScoreButtons(
                  formData.stress_level,
                  (v) => setFormData({ ...formData, stress_level: v }),
                  ['😌', '🙂', '😐', '😰', '🤯']
                )}
              </div>
            </div>
          )}
        </motion.div>
      </div>

      {/* メモ */}
      <div className="px-4 mb-4">
        <div className="rounded-2xl p-4" style={{ backgroundColor: colors.card }}>
          <label className="block text-sm font-medium mb-2" style={{ color: colors.textLight }}>
            今日のメモ
          </label>
          <textarea
            value={formData.daily_note}
            onChange={(e) => setFormData({ ...formData, daily_note: e.target.value })}
            placeholder="今日の気づきや出来事を記録..."
            rows={3}
            className="w-full p-3 rounded-xl resize-none"
            style={{ backgroundColor: colors.bg, color: colors.text }}
          />
        </div>
      </div>
    </div>
  );
}

