"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  ArrowLeft, Bell, BellOff, Clock, Moon, Smile, Brain,
  Trophy, Zap, Heart, Save, ChevronRight, Calendar
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
  purple: '#7C4DFF',
  purpleLight: '#EDE7F6',
  blue: '#2196F3',
  blueLight: '#E3F2FD',
  border: '#EEEEEE',
};

type RecordMode = 'standard' | 'minimal' | 'weekly' | 'off';
type PersonalityType = 'positive' | 'logical' | 'gentle' | 'competitive';

const RECORD_MODES: { value: RecordMode; label: string; description: string; icon: typeof Bell }[] = [
  { value: 'standard', label: '標準モード', description: '毎日リマインダーを受け取る', icon: Bell },
  { value: 'minimal', label: 'ミニマムモード', description: '体重だけ、週3回程度', icon: Zap },
  { value: 'weekly', label: '週1モード', description: '週末だけ記録する', icon: Calendar },
  { value: 'off', label: 'オフ', description: '通知なし、自分のペースで', icon: BellOff },
];

const PERSONALITY_TYPES: { value: PersonalityType; label: string; example: string; emoji: string }[] = [
  { value: 'positive', label: '褒めて伸ばす', example: '「すごい！この調子！」', emoji: '🎉' },
  { value: 'logical', label: '事実を伝える', example: '「-0.2kg、目標まで残り3.5kg」', emoji: '📊' },
  { value: 'gentle', label: '優しく見守る', example: '「焦らず、あなたのペースで」', emoji: '🌿' },
  { value: 'competitive', label: '競争心を刺激', example: '「上位10%に入りました！」', emoji: '🏆' },
];

interface Preferences {
  enabled: boolean;
  quiet_hours_start: string;
  quiet_hours_end: string;
  record_mode: RecordMode;
  personality_type: PersonalityType;
  morning_reminder_enabled: boolean;
  morning_reminder_time: string;
  evening_reminder_enabled: boolean;
  evening_reminder_time: string;
  vacation_mode: boolean;
  vacation_until: string | null;
}

export default function HealthSettingsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>({
    enabled: true,
    quiet_hours_start: '22:00',
    quiet_hours_end: '07:00',
    record_mode: 'standard',
    personality_type: 'positive',
    morning_reminder_enabled: true,
    morning_reminder_time: '07:30',
    evening_reminder_enabled: false,
    evening_reminder_time: '21:00',
    vacation_mode: false,
    vacation_until: null,
  });

  useEffect(() => {
    fetchPreferences();
  }, []);

  const fetchPreferences = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/health/notifications/preferences');
      if (res.ok) {
        const data = await res.json();
        if (data.preferences) {
          setPreferences(data.preferences);
        }
      }
    } catch (error) {
      console.error('Failed to fetch preferences:', error);
    }
    setLoading(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/health/notifications/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(preferences),
      });

      if (res.ok) {
        router.back();
      }
    } catch (error) {
      console.error('Failed to save preferences:', error);
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: colors.bg }}>
        <div className="animate-spin w-8 h-8 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-24" style={{ backgroundColor: colors.bg }}>
      {/* ヘッダー */}
      <div className="sticky top-0 z-10 px-4 py-4 flex items-center justify-between" style={{ backgroundColor: colors.bg }}>
        <div className="flex items-center">
          <button onClick={() => router.back()} className="p-2 -ml-2">
            <ArrowLeft size={24} style={{ color: colors.text }} />
          </button>
          <h1 className="font-bold ml-2" style={{ color: colors.text }}>記録設定</h1>
        </div>
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

      {/* 記録モード */}
      <div className="px-4 mb-6">
        <h2 className="font-semibold mb-3" style={{ color: colors.text }}>
          記録モード
        </h2>
        <p className="text-sm mb-4" style={{ color: colors.textMuted }}>
          あなたのペースに合わせて選んでください
        </p>
        <div className="space-y-2">
          {RECORD_MODES.map((mode) => {
            const Icon = mode.icon;
            return (
              <motion.button
                key={mode.value}
                whileTap={{ scale: 0.98 }}
                onClick={() => setPreferences({ ...preferences, record_mode: mode.value })}
                className="w-full p-4 rounded-xl flex items-center gap-3 text-left"
                style={{
                  backgroundColor: preferences.record_mode === mode.value ? colors.accentLight : colors.card,
                  border: preferences.record_mode === mode.value ? `2px solid ${colors.accent}` : '2px solid transparent',
                }}
              >
                <div 
                  className="w-10 h-10 rounded-lg flex items-center justify-center"
                  style={{ 
                    backgroundColor: preferences.record_mode === mode.value ? colors.accent : colors.bg,
                  }}
                >
                  <Icon 
                    size={20} 
                    style={{ color: preferences.record_mode === mode.value ? 'white' : colors.textMuted }} 
                  />
                </div>
                <div className="flex-1">
                  <p 
                    className="font-medium"
                    style={{ color: preferences.record_mode === mode.value ? colors.accent : colors.text }}
                  >
                    {mode.label}
                  </p>
                  <p className="text-sm" style={{ color: colors.textMuted }}>
                    {mode.description}
                  </p>
                </div>
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* 通知スタイル */}
      <div className="px-4 mb-6">
        <h2 className="font-semibold mb-3" style={{ color: colors.text }}>
          通知スタイル
        </h2>
        <p className="text-sm mb-4" style={{ color: colors.textMuted }}>
          どんな声かけが嬉しいですか？
        </p>
        <div className="grid grid-cols-2 gap-2">
          {PERSONALITY_TYPES.map((type) => (
            <motion.button
              key={type.value}
              whileTap={{ scale: 0.95 }}
              onClick={() => setPreferences({ ...preferences, personality_type: type.value })}
              className="p-4 rounded-xl text-left"
              style={{
                backgroundColor: preferences.personality_type === type.value ? colors.accentLight : colors.card,
                border: preferences.personality_type === type.value ? `2px solid ${colors.accent}` : '2px solid transparent',
              }}
            >
              <span className="text-2xl mb-2 block">{type.emoji}</span>
              <p 
                className="font-medium text-sm"
                style={{ color: preferences.personality_type === type.value ? colors.accent : colors.text }}
              >
                {type.label}
              </p>
              <p className="text-xs mt-1" style={{ color: colors.textMuted }}>
                {type.example}
              </p>
            </motion.button>
          ))}
        </div>
      </div>

      {/* リマインダー時間 */}
      {preferences.record_mode !== 'off' && (
        <div className="px-4 mb-6">
          <h2 className="font-semibold mb-3" style={{ color: colors.text }}>
            リマインダー時間
          </h2>
          
          {/* 朝のリマインダー */}
          <div 
            className="p-4 rounded-xl mb-3"
            style={{ backgroundColor: colors.card }}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Clock size={18} style={{ color: colors.warning }} />
                <span className="font-medium" style={{ color: colors.text }}>朝のリマインダー</span>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={preferences.morning_reminder_enabled}
                  onChange={(e) => setPreferences({ 
                    ...preferences, 
                    morning_reminder_enabled: e.target.checked 
                  })}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-orange-500"></div>
              </label>
            </div>
            {preferences.morning_reminder_enabled && (
              <input
                type="time"
                value={preferences.morning_reminder_time}
                onChange={(e) => setPreferences({ 
                  ...preferences, 
                  morning_reminder_time: e.target.value 
                })}
                className="w-full p-3 rounded-lg"
                style={{ backgroundColor: colors.bg, color: colors.text }}
              />
            )}
          </div>

          {/* 夜のリマインダー */}
          <div 
            className="p-4 rounded-xl"
            style={{ backgroundColor: colors.card }}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Moon size={18} style={{ color: colors.purple }} />
                <span className="font-medium" style={{ color: colors.text }}>夜のリマインダー</span>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={preferences.evening_reminder_enabled}
                  onChange={(e) => setPreferences({ 
                    ...preferences, 
                    evening_reminder_enabled: e.target.checked 
                  })}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-500"></div>
              </label>
            </div>
            {preferences.evening_reminder_enabled && (
              <input
                type="time"
                value={preferences.evening_reminder_time}
                onChange={(e) => setPreferences({ 
                  ...preferences, 
                  evening_reminder_time: e.target.value 
                })}
                className="w-full p-3 rounded-lg"
                style={{ backgroundColor: colors.bg, color: colors.text }}
              />
            )}
          </div>
        </div>
      )}

      {/* お休みモード */}
      <div className="px-4 mb-6">
        <h2 className="font-semibold mb-3" style={{ color: colors.text }}>
          お休みモード
        </h2>
        <div 
          className="p-4 rounded-xl"
          style={{ backgroundColor: colors.card }}
        >
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="font-medium" style={{ color: colors.text }}>お休みモード</p>
              <p className="text-sm" style={{ color: colors.textMuted }}>
                一時的に通知を停止します
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={preferences.vacation_mode}
                onChange={(e) => setPreferences({ 
                  ...preferences, 
                  vacation_mode: e.target.checked,
                  vacation_until: e.target.checked ? null : null,
                })}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
            </label>
          </div>
          {preferences.vacation_mode && (
            <div>
              <label className="block text-sm mb-2" style={{ color: colors.textLight }}>
                いつまでお休みしますか？（オプション）
              </label>
              <input
                type="date"
                value={preferences.vacation_until || ''}
                onChange={(e) => setPreferences({ 
                  ...preferences, 
                  vacation_until: e.target.value || null 
                })}
                min={new Date().toISOString().split('T')[0]}
                className="w-full p-3 rounded-lg"
                style={{ backgroundColor: colors.bg, color: colors.text }}
              />
            </div>
          )}
        </div>
      </div>

      {/* 静かな時間 */}
      <div className="px-4 mb-6">
        <h2 className="font-semibold mb-3" style={{ color: colors.text }}>
          静かな時間
        </h2>
        <p className="text-sm mb-4" style={{ color: colors.textMuted }}>
          この時間帯は通知を送りません
        </p>
        <div 
          className="p-4 rounded-xl"
          style={{ backgroundColor: colors.card }}
        >
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm mb-2" style={{ color: colors.textLight }}>
                開始
              </label>
              <input
                type="time"
                value={preferences.quiet_hours_start}
                onChange={(e) => setPreferences({ 
                  ...preferences, 
                  quiet_hours_start: e.target.value 
                })}
                className="w-full p-3 rounded-lg"
                style={{ backgroundColor: colors.bg, color: colors.text }}
              />
            </div>
            <div>
              <label className="block text-sm mb-2" style={{ color: colors.textLight }}>
                終了
              </label>
              <input
                type="time"
                value={preferences.quiet_hours_end}
                onChange={(e) => setPreferences({ 
                  ...preferences, 
                  quiet_hours_end: e.target.value 
                })}
                className="w-full p-3 rounded-lg"
                style={{ backgroundColor: colors.bg, color: colors.text }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

