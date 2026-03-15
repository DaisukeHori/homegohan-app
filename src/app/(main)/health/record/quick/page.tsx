/* eslint-disable @next/next/no-img-element */
"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  Camera, ArrowLeft, Scale, Sparkles, CheckCircle2,
  Upload, X, Loader2
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
  purple: '#7C4DFF',
  purpleLight: '#EDE7F6',
  blue: '#2196F3',
  blueLight: '#E3F2FD',
  border: '#EEEEEE',
};

export default function QuickRecordPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [mode, setMode] = useState<'select' | 'camera' | 'manual'>('select');
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [detectedWeight, setDetectedWeight] = useState<string>('');
  const [manualWeight, setManualWeight] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // プレビュー表示
    const reader = new FileReader();
    reader.onload = (e) => {
      setPhotoPreview(e.target?.result as string);
    };
    reader.readAsDataURL(file);

    setMode('camera');
    setAnalyzing(true);

    // AIで体重を読み取り（TODO: Edge Function実装後に有効化）
    try {
      // const formData = new FormData();
      // formData.append('file', file);
      // const res = await fetch('/api/health/records/photo', {
      //   method: 'POST',
      //   body: formData,
      // });
      // if (res.ok) {
      //   const data = await res.json();
      //   setDetectedWeight(data.weight?.toString() || '');
      // }
      
      // 仮実装：3秒後にダミーデータ
      await new Promise(resolve => setTimeout(resolve, 2000));
      setDetectedWeight('65.2');
    } catch (error) {
      console.error('Failed to analyze photo:', error);
    }
    setAnalyzing(false);
  };

  const handleSave = async () => {
    const weight = mode === 'camera' ? detectedWeight : manualWeight;
    if (!weight) return;

    setSaving(true);
    try {
      const res = await fetch('/api/health/records/quick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          weight: parseFloat(weight),
          record_date: new Date().toISOString().split('T')[0],
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
      }
    } catch (error) {
      console.error('Failed to save:', error);
    }
    setSaving(false);
  };

  const resetPhoto = () => {
    setPhotoPreview(null);
    setDetectedWeight('');
    setMode('select');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
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

            {/* 写真で記録 */}
            <motion.button
              whileTap={{ scale: 0.98 }}
              onClick={() => fileInputRef.current?.click()}
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
                  <Camera size={32} style={{ color: colors.blue }} />
                </div>
                <div>
                  <p className="font-bold text-lg" style={{ color: colors.text }}>
                    📸 写真で記録
                  </p>
                  <p className="text-sm mt-1" style={{ color: colors.textMuted }}>
                    体重計の画面を撮影するだけ
                  </p>
                </div>
              </div>
            </motion.button>

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

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleFileSelect}
              className="hidden"
            />
          </motion.div>
        )}

        {/* 写真モード */}
        {mode === 'camera' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-4"
          >
            {/* 写真プレビュー */}
            <div className="relative">
              {photoPreview && (
                <img
                  src={photoPreview}
                  alt="体重計"
                  className="w-full rounded-2xl"
                />
              )}
              <button
                onClick={resetPhoto}
                className="absolute top-2 right-2 p-2 rounded-full bg-black/50"
              >
                <X size={20} color="white" />
              </button>
            </div>

            {/* 解析中 */}
            {analyzing && (
              <div 
                className="p-6 rounded-2xl text-center"
                style={{ backgroundColor: colors.card }}
              >
                <Loader2 size={32} className="animate-spin mx-auto mb-3" style={{ color: colors.accent }} />
                <p className="font-medium" style={{ color: colors.text }}>
                  AIが体重を読み取り中...
                </p>
              </div>
            )}

            {/* 読み取り結果 */}
            {!analyzing && detectedWeight && (
              <div 
                className="p-6 rounded-2xl"
                style={{ backgroundColor: colors.card }}
              >
                <div className="flex items-center gap-2 mb-4">
                  <Sparkles size={20} style={{ color: colors.accent }} />
                  <span className="font-medium" style={{ color: colors.text }}>
                    読み取り結果
                  </span>
                </div>
                <div className="text-center">
                  <input
                    type="number"
                    step="0.1"
                    value={detectedWeight}
                    onChange={(e) => setDetectedWeight(e.target.value)}
                    className="text-5xl font-bold text-center w-full bg-transparent"
                    style={{ color: colors.text }}
                  />
                  <span className="text-2xl" style={{ color: colors.textMuted }}>kg</span>
                </div>
                <p className="text-center text-sm mt-2" style={{ color: colors.textMuted }}>
                  数値が違う場合はタップして修正できます
                </p>
              </div>
            )}

            {/* 保存ボタン */}
            {!analyzing && detectedWeight && (
              <motion.button
                whileTap={{ scale: 0.98 }}
                onClick={handleSave}
                disabled={saving}
                className="w-full py-4 rounded-xl font-bold text-white"
                style={{ backgroundColor: colors.accent }}
              >
                {saving ? '保存中...' : 'この体重で記録する'}
              </motion.button>
            )}

            {/* 撮り直し */}
            {!analyzing && (
              <button
                onClick={resetPhoto}
                className="w-full py-3 text-center"
                style={{ color: colors.accent }}
              >
                撮り直す
              </button>
            )}
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
              onClick={() => setMode('select')}
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
