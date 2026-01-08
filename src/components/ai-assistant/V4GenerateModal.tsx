"use client";

import React, { useState, useCallback, useMemo, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  X, Sparkles, Calendar, Target,
  Refrigerator, Zap, UtensilsCrossed, Heart,
  ChevronRight, Loader2
} from "lucide-react";
import type { TargetSlot, MenuGenerationConstraints } from "@/types/domain";
import { 
  buildEmptySlots, 
  buildRangeSlots, 
  countEmptySlots,
  validateSlotCount,
  type MealDay,
} from "@/lib/slot-builder";

// ============================================
// Types
// ============================================

type GenerateMode = 'empty' | 'selected' | 'range';

// LocalStorage keys for persisting range settings
const STORAGE_KEY_RANGE_DAYS = 'v4_range_days';
const STORAGE_KEY_INCLUDE_EXISTING = 'v4_include_existing';

interface V4GenerateModalProps {
  isOpen: boolean;
  onClose: () => void;
  mealPlanDays: MealDay[];
  weekStartDate: string;
  weekEndDate: string;
  onGenerate: (params: {
    targetSlots: TargetSlot[];
    constraints: MenuGenerationConstraints;
    note: string;
  }) => Promise<void>;
  isGenerating?: boolean;
}

// ============================================
// Color Palette (matching weekly page)
// ============================================

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  success: '#6B9B6B',
  successLight: '#EDF5ED',
  warning: '#E5A84B',
  warningLight: '#FEF9EE',
  purple: '#7C6BA0',
  purpleLight: '#F5F3F8',
  blue: '#5B8BC7',
  blueLight: '#EEF4FB',
  border: '#E8E8E8',
  danger: '#D64545',
  dangerLight: '#FDECEC',
};

// ============================================
// Component
// ============================================

export function V4GenerateModal({
  isOpen,
  onClose,
  mealPlanDays,
  weekStartDate,
  weekEndDate,
  onGenerate,
  isGenerating = false,
}: V4GenerateModalProps) {
  // Mode selection
  const [selectedMode, setSelectedMode] = useState<GenerateMode | null>(null);
  
  // Range mode state
  const [rangeStart, setRangeStart] = useState(weekStartDate);
  const [rangeEnd, setRangeEnd] = useState(weekEndDate);
  const [includeExisting, setIncludeExisting] = useState(false);
  
  // 今日の日付を取得（他のhooksより先に定義）
  const todayStr = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }, []);

  // Helper: 日付を加算
  const addDays = useCallback((dateStr: string, days: number): string => {
    const date = new Date(dateStr);
    date.setDate(date.getDate() + days);
    return date.toISOString().split('T')[0];
  }, []);

  // Helper: 日付の差（日数）を計算
  const daysBetween = useCallback((startStr: string, endStr: string): number => {
    const start = new Date(startStr);
    const end = new Date(endStr);
    return Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  }, []);

  // 初期化: localStorageから設定を復元し、今日を基準に日付を設定
  useEffect(() => {
    // includeExistingを復元
    const savedIncludeExisting = localStorage.getItem(STORAGE_KEY_INCLUDE_EXISTING);
    if (savedIncludeExisting !== null) {
      setIncludeExisting(savedIncludeExisting === 'true');
    }

    // 保存された日数を復元
    const savedRangeDays = localStorage.getItem(STORAGE_KEY_RANGE_DAYS);
    if (savedRangeDays) {
      try {
        const { startDays, endDays } = JSON.parse(savedRangeDays);
        // 今日を基準に日付を計算
        const newStart = addDays(todayStr, startDays);
        const newEnd = addDays(todayStr, endDays);
        setRangeStart(newStart);
        setRangeEnd(newEnd);
        return;
      } catch (e) {
        // パースエラーの場合はデフォルト値を使用
      }
    }

    // デフォルト: 今日から週末まで
    setRangeStart(todayStr);
    setRangeEnd(weekEndDate >= todayStr ? weekEndDate : addDays(todayStr, 6));
  }, [todayStr, weekEndDate, addDays]);

  // rangeStartが変更されたら日数を保存
  useEffect(() => {
    if (rangeStart && rangeEnd) {
      const startDays = daysBetween(todayStr, rangeStart);
      const endDays = daysBetween(todayStr, rangeEnd);
      localStorage.setItem(STORAGE_KEY_RANGE_DAYS, JSON.stringify({ startDays, endDays }));
    }
  }, [rangeStart, rangeEnd, todayStr, daysBetween]);

  // includeExistingが変更されたら保存
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_INCLUDE_EXISTING, String(includeExisting));
  }, [includeExisting]);

  // rangeStart/rangeEndのsetterをラップして、過去日付の場合は今日に調整
  // 開始日が終了日より後になった場合は終了日を開始日に合わせる
  const handleSetRangeStart = useCallback((value: string) => {
    const adjusted = value < todayStr ? todayStr : value;
    setRangeStart(adjusted);
    // 開始日が終了日より後になった場合、終了日を開始日に合わせる
    if (adjusted > rangeEnd) {
      setRangeEnd(adjusted);
    }
  }, [todayStr, rangeEnd]);

  // 終了日が開始日より前になった場合は開始日を終了日に合わせる
  const handleSetRangeEnd = useCallback((value: string) => {
    const adjusted = value < todayStr ? todayStr : value;
    setRangeEnd(adjusted);
    // 終了日が開始日より前になった場合、開始日を終了日に合わせる
    if (adjusted < rangeStart) {
      setRangeStart(adjusted);
    }
  }, [todayStr, rangeStart]);
  
  // Constraints
  const [constraints, setConstraints] = useState<MenuGenerationConstraints>({
    useFridgeFirst: false,
    quickMeals: false,
    japaneseStyle: false,
    healthy: false,
  });
  
  // Free text note
  const [note, setNote] = useState("");

  // 計算開始日は今日とweekStartDateの遅い方（過去の空欄はカウントしない）
  const effectiveStartDate = useMemo(() => {
    return weekStartDate >= todayStr ? weekStartDate : todayStr;
  }, [weekStartDate, todayStr]);

  // Calculate empty slots count for current week (今日以降のみ)
  const emptySlotCount = useMemo(() => {
    // 開始日が終了日を超える場合は0（週全体が過去の場合）
    if (effectiveStartDate > weekEndDate) return 0;
    return countEmptySlots({
      mealPlanDays,
      startDate: effectiveStartDate,
      endDate: weekEndDate,
    });
  }, [mealPlanDays, effectiveStartDate, weekEndDate]);

  // Build target slots based on selected mode (今日以降のみ対象)
  const buildTargetSlots = useCallback((): TargetSlot[] => {
    switch (selectedMode) {
      case 'empty':
        // 今日以降の空欄のみ
        if (effectiveStartDate > weekEndDate) return [];
        return buildEmptySlots({
          mealPlanDays,
          startDate: effectiveStartDate,
          endDate: weekEndDate,
        });
      case 'range':
        // 範囲指定は指定された日付をそのまま使う（ユーザーの意図を尊重）
        // ただし開始日が過去の場合は今日に調整済み
        return buildRangeSlots({
          mealPlanDays,
          startDate: rangeStart,
          endDate: rangeEnd,
          includeExisting,
        });
      default:
        return [];
    }
  }, [selectedMode, mealPlanDays, effectiveStartDate, weekEndDate, rangeStart, rangeEnd, includeExisting]);

  // Handle generate
  const handleGenerate = async () => {
    const slots = buildTargetSlots();
    const validation = validateSlotCount(slots);
    
    if (!validation.valid) {
      alert(validation.message);
      return;
    }

    await onGenerate({
      targetSlots: slots,
      constraints,
      note,
    });
  };

  // Toggle constraint
  const toggleConstraint = (key: keyof MenuGenerationConstraints) => {
    setConstraints(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // Reset state when closing
  const handleClose = () => {
    setSelectedMode(null);
    onClose();
  };

  if (!isOpen) return null;

  // Mode selection buttons
  const modes = [
    {
      id: 'empty' as const,
      icon: Sparkles,
      label: '空欄を埋める',
      description: `既存の献立はそのまま、空いているところだけ（${emptySlotCount}件）`,
      color: colors.accent,
      bg: colors.accentLight,
      disabled: emptySlotCount === 0,
    },
    {
      id: 'selected' as const,
      icon: Target,
      label: '選択したところだけ',
      description: '変更したい食事を選んで（準備中）',
      color: colors.blue,
      bg: colors.blueLight,
      disabled: true, // Phase 2で実装
    },
    {
      id: 'range' as const,
      icon: Calendar,
      label: '期間を指定',
      description: '開始〜終了を選んで生成（最大31日）',
      color: colors.purple,
      bg: colors.purpleLight,
      disabled: false,
    },
  ];

  // Constraint options
  const constraintOptions = [
    { key: 'useFridgeFirst' as const, icon: Refrigerator, label: '冷蔵庫優先' },
    { key: 'quickMeals' as const, icon: Zap, label: '時短中心' },
    { key: 'japaneseStyle' as const, icon: UtensilsCrossed, label: '和食多め' },
    { key: 'healthy' as const, icon: Heart, label: 'ヘルシー' },
  ];

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
        onClick={handleClose}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] overflow-hidden shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: colors.border }}>
            <div className="flex items-center gap-2">
              <Sparkles size={20} style={{ color: colors.accent }} />
              <h2 className="text-lg font-bold" style={{ color: colors.text }}>AIアシスタント</h2>
            </div>
            <button
              onClick={handleClose}
              className="p-2 rounded-full hover:bg-gray-100 transition-colors"
            >
              <X size={20} style={{ color: colors.textLight }} />
            </button>
          </div>

          {/* Content */}
          <div className="p-4 overflow-y-auto" style={{ maxHeight: 'calc(90vh - 140px)' }}>
            {/* Mode selection */}
                <div className="space-y-3 mb-6">
                  <p className="text-sm font-bold" style={{ color: colors.textLight }}>何を生成しますか？</p>
                  {modes.map((mode) => (
                    <button
                      key={mode.id}
                      onClick={() => !mode.disabled && setSelectedMode(mode.id)}
                      disabled={mode.disabled}
                      className={`w-full p-4 rounded-xl text-left transition-all border-2 ${
                        selectedMode === mode.id ? 'border-current' : 'border-transparent'
                      } ${mode.disabled ? 'opacity-50 cursor-not-allowed' : 'hover:scale-[1.02]'}`}
                      style={{
                        backgroundColor: selectedMode === mode.id ? mode.bg : colors.bg,
                        borderColor: selectedMode === mode.id ? mode.color : 'transparent',
                      }}
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className="w-10 h-10 rounded-full flex items-center justify-center"
                          style={{ backgroundColor: mode.bg }}
                        >
                          <mode.icon size={20} style={{ color: mode.color }} />
                        </div>
                        <div className="flex-1">
                          <p className="font-bold" style={{ color: colors.text }}>{mode.label}</p>
                          <p className="text-sm" style={{ color: colors.textLight }}>{mode.description}</p>
                        </div>
                        <ChevronRight size={18} style={{ color: colors.textMuted }} />
                      </div>
                    </button>
                  ))}
                </div>

                {/* Range mode options */}
                {selectedMode === 'range' && (
                  <div className="mb-6 p-4 rounded-xl" style={{ backgroundColor: colors.purpleLight }}>
                    <p className="text-sm font-bold mb-3" style={{ color: colors.purple }}>期間を選択</p>
                    <div className="grid grid-cols-2 gap-3 mb-3">
                      <div>
                        <label className="text-xs" style={{ color: colors.textLight }}>開始日</label>
                        <input
                          type="date"
                          value={rangeStart}
                          min={todayStr}
                          onChange={(e) => handleSetRangeStart(e.target.value)}
                          className="w-full p-2 rounded-lg border mt-1"
                          style={{ borderColor: colors.border }}
                        />
                      </div>
                      <div>
                        <label className="text-xs" style={{ color: colors.textLight }}>終了日</label>
                        <input
                          type="date"
                          value={rangeEnd}
                          min={todayStr}
                          onChange={(e) => handleSetRangeEnd(e.target.value)}
                          className="w-full p-2 rounded-lg border mt-1"
                          style={{ borderColor: colors.border }}
                        />
                      </div>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={includeExisting}
                        onChange={(e) => setIncludeExisting(e.target.checked)}
                        className="w-4 h-4 rounded"
                      />
                      <span className="text-sm" style={{ color: colors.textLight }}>
                        既存の献立も作り直す
                      </span>
                    </label>
                  </div>
                )}

                {/* Constraints */}
                <div className="mb-6">
                  <p className="text-sm font-bold mb-3" style={{ color: colors.textLight }}>条件を指定</p>
                  <div className="flex flex-wrap gap-2">
                    {constraintOptions.map((opt) => (
                      <button
                        key={opt.key}
                        onClick={() => toggleConstraint(opt.key)}
                        className={`px-3 py-2 rounded-full text-sm font-bold flex items-center gap-1.5 transition-all ${
                          constraints[opt.key] ? 'text-white' : ''
                        }`}
                        style={{
                          backgroundColor: constraints[opt.key] ? colors.accent : colors.bg,
                          color: constraints[opt.key] ? 'white' : colors.textLight,
                        }}
                      >
                        <opt.icon size={14} />
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Free text note */}
                <div className="mb-6">
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="自由にリクエスト（例: 木金は簡単に、和食多めで）"
                    className="w-full p-3 rounded-xl border resize-none"
                    style={{ borderColor: colors.border }}
                    rows={2}
                  />
                </div>

                {/* Generate button */}
                <button
                  onClick={handleGenerate}
                  disabled={!selectedMode || isGenerating}
                  className="w-full py-4 rounded-xl font-bold text-white transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                  style={{ backgroundColor: colors.accent }}
                >
                  {isGenerating ? (
                    <>
                      <Loader2 size={18} className="animate-spin" />
                      生成中...
                    </>
                  ) : (
                    <>
                      <Sparkles size={18} />
                      献立を生成
                    </>
                  )}
                </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
