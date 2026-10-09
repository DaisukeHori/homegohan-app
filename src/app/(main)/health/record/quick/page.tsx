"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  ArrowLeft, Scale, CheckCircle2, AlertTriangle,
} from 'lucide-react';
import { todayLocal } from '@/lib/date-utils';
import { STATUS_COLOR_TOKENS } from '@homegohan/shared';

const colors = {
  bg: '#FAF9F7',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textLight: '#4A4A4A',
  textMuted: '#9A9A9A',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  // 状態色 (#590): 塗り・枠線・アイコンは success など、文字は successText / warningText / dangerText
  ...STATUS_COLOR_TOKENS,
  purple: '#7C4DFF',
  purpleLight: '#EDE7F6',
  blue: '#2196F3',
  blueLight: '#E3F2FD',
  border: '#EEEEEE',
};

export default function QuickRecordPage() {
  const router = useRouter();

  // 「写真で記録」は、体重計を撮影して AI が数値を読み取る既存のフロー
  // (/meals/new の体重計モード) へのリンク (#1141)。読み取った値は /meals/new の
  // 確認ステップで利用者が見て「この体重を記録」を押すまで保存されない。
  // #1051 UX3-01 でダミー値 (65.2kg) を「読み取り結果」として出していた問題の再発防止のため、
  // この画面で読み取り結果を作ったり、確認なしに保存したりしない。
  // 手入力は、この画面の中で体重を入力して保存する。
  const [mode, setMode] = useState<'select' | 'manual'>('select');
  const [manualWeight, setManualWeight] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // #1051 UX3-05: 保存失敗時に無反応だったため、エラーを表示し入力を保持する
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!manualWeight) return;

    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/health/records/quick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          weight: parseFloat(manualWeight),
          record_date: todayLocal(),
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setMessage(data.message);
        setSuccess(true);

        // 2秒後にダッシュボードへ
        setTimeout(() => {
          router.push('/health');
        }, 2000);
        return;
      }

      const data = await res.json().catch(() => null);
      setSaveError(data?.error || '記録に失敗しました。もう一度お試しください。');
    } catch (error) {
      console.error('Failed to save:', error);
      setSaveError('記録に失敗しました。もう一度お試しください。');
    }
    setSaving(false);
  };

  // 成功画面
  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ backgroundColor: colors.bg }}>
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="text-center"
        >
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.2, type: 'spring' }}
            className="w-20 h-20 rounded-full mx-auto mb-4 flex items-center justify-center"
            style={{ backgroundColor: colors.successLight }}
          >
            <CheckCircle2 size={40} style={{ color: colors.success }} />
          </motion.div>
          <h2 className="text-xl font-bold mb-2" style={{ color: colors.text }}>
            記録完了！
          </h2>
          <p className="text-sm" style={{ color: colors.textMuted }}>
            {message}
          </p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: colors.bg }}>
      {/* ヘッダー */}
      <div className="sticky top-0 z-10 px-4 py-4 flex items-center" style={{ backgroundColor: colors.bg }}>
        <button onClick={() => router.back()} className="p-2 -ml-2">
          <ArrowLeft size={24} style={{ color: colors.text }} />
        </button>
        <h1 className="font-bold ml-2" style={{ color: colors.text }}>クイック記録</h1>
      </div>

      <div className="px-4 pb-8">
        {/* モード選択 */}
        {mode === 'select' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-4"
          >
            <p className="text-center mb-6" style={{ color: colors.textLight }}>
              記録方法を選んでください
            </p>

            {/* 写真で記録 (#1141: /meals/new の体重計モードへ。AI の読み取り結果は確認ステップで見てから記録する) */}
            <Link href="/meals/new?mode=weight_scale" className="block">
              <motion.div
                whileTap={{ scale: 0.98 }}
                className="w-full p-6 rounded-2xl text-left"
                style={{
                  backgroundColor: colors.card,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.06)'
                }}
              >
                <div className="flex items-center gap-4">
                  <div
                    className="w-16 h-16 rounded-xl flex items-center justify-center"
                    style={{ backgroundColor: colors.blueLight }}
                  >
                    <Scale size={32} style={{ color: colors.blue }} />
                  </div>
                  <div>
                    <p className="font-bold text-lg" style={{ color: colors.text }}>
                      📸 写真で記録
                    </p>
                    <p className="text-sm mt-1" style={{ color: colors.textMuted }}>
                      体重計を撮影すると、AIが数値を読み取ります。記録前に確認できます
                    </p>
                  </div>
                </div>
              </motion.div>
            </Link>

            {/* 手入力 */}
            <motion.button
              whileTap={{ scale: 0.98 }}
              onClick={() => setMode('manual')}
              className="w-full p-6 rounded-2xl text-left"
              style={{
                backgroundColor: colors.card,
                boxShadow: '0 2px 8px rgba(0,0,0,0.06)'
              }}
            >
              <div className="flex items-center gap-4">
                <div
                  className="w-16 h-16 rounded-xl flex items-center justify-center"
                  style={{ backgroundColor: colors.accentLight }}
                >
                  <Scale size={32} style={{ color: colors.accent }} />
                </div>
                <div>
                  <p className="font-bold text-lg" style={{ color: colors.text }}>
                    ⌨️ 手入力で記録
                  </p>
                  <p className="text-sm mt-1" style={{ color: colors.textMuted }}>
                    体重を直接入力
                  </p>
                </div>
              </div>
            </motion.button>
          </motion.div>
        )}

        {/* 手入力モード */}
        {mode === 'manual' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-6"
          >
            <div
              className="p-6 rounded-2xl"
              style={{ backgroundColor: colors.card }}
            >
              <label className="block text-sm font-medium mb-4" style={{ color: colors.textLight }}>
                今日の体重
              </label>
              <div className="flex items-center justify-center gap-2">
                <input
                  type="number"
                  step="0.1"
                  value={manualWeight}
                  onChange={(e) => setManualWeight(e.target.value)}
                  placeholder="65.0"
                  autoFocus
                  className="text-5xl font-bold text-center w-40 bg-transparent"
                  style={{ color: colors.text }}
                />
                <span className="text-2xl" style={{ color: colors.textMuted }}>kg</span>
              </div>
            </div>

            {/* クイック入力ボタン */}
            <div className="grid grid-cols-4 gap-2">
              {['-0.5', '-0.1', '+0.1', '+0.5'].map((delta) => (
                <motion.button
                  key={delta}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => {
                    const current = parseFloat(manualWeight) || 65;
                    const newValue = current + parseFloat(delta);
                    setManualWeight(newValue.toFixed(1));
                  }}
                  className="py-3 rounded-xl font-medium"
                  style={{
                    backgroundColor: colors.bg,
                    color: colors.textLight,
                  }}
                >
                  {delta}
                </motion.button>
              ))}
            </div>

            {/* #1051 UX3-05: 保存失敗を無反応にせず、入力を保持したままエラーを表示する */}
            {saveError && (
              <div className="flex items-start gap-2 p-3 rounded-lg" style={{ backgroundColor: colors.errorLight }}>
                <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" style={{ color: colors.error }} />
                <p className="text-sm" style={{ color: colors.dangerText }}>{saveError}</p>
              </div>
            )}

            {/* 保存ボタン */}
            <motion.button
              whileTap={{ scale: 0.98 }}
              onClick={handleSave}
              disabled={saving || !manualWeight}
              className="w-full py-4 rounded-xl font-bold text-white disabled:opacity-50"
              style={{ backgroundColor: colors.accent }}
            >
              {saving ? '保存中...' : '記録する'}
            </motion.button>

            {/* 戻る */}
            <button
              onClick={() => { setMode('select'); setSaveError(null); }}
              className="w-full py-3 text-center"
              style={{ color: colors.accent }}
            >
              戻る
            </button>
          </motion.div>
        )}
      </div>
    </div>
  );
}
