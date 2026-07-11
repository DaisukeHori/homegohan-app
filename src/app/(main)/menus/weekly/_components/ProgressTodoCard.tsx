"use client";

import React, { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronUp, ChevronDown, Check, X } from "lucide-react";
import type { PhaseDefinition } from "@homegohan/shared";
import { PROGRESS_PHASES } from "@homegohan/shared";

interface ProgressTodoCardProps {
  progress: { phase: string; message: string; percentage: number; totalSlots?: number; completedSlots?: number } | null;
  colors: { accent: string; purple: string };
  phases?: PhaseDefinition[];
  defaultMessage?: string;
  /** UX2-11: 生成を中止するハンドラ。渡された場合のみ「中止する」ボタンを表示する */
  onCancel?: () => void;
}

export const ProgressTodoCard = ({
  progress,
  colors: cardColors,
  phases = PROGRESS_PHASES,
  defaultMessage = 'AIが献立を生成中...',
  onCancel,
}: ProgressTodoCardProps) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const currentPercentage = progress?.percentage ?? 0;
  const currentPhase = progress?.phase ?? '';
  const totalSlots = progress?.totalSlots ?? 0;

  // totalSlotsから日数を計算（3スロット = 1日と仮定）
  const totalDays = totalSlots > 0 ? Math.ceil(totalSlots / 3) : 0;

  // 動的にフェーズラベルを生成
  const dynamicPhases = useMemo(() => {
    return phases.map(p => {
      if (p.phase === 'generating') {
        // totalSlotsが設定されていれば日数を表示、なければデフォルト
        if (totalDays > 0) {
          const dayLabel = totalDays === 1 ? '1日分' : `${totalDays}日分`;
          return { ...p, label: `${dayLabel}の献立をAIが作成` };
        }
        // totalSlotsがまだ来ていない場合はデフォルトのまま
        return p;
      }
      return p;
    });
  }, [phases, totalDays]);

  // 各フェーズの状態を判定
  const getPhaseStatus = (phase: PhaseDefinition) => {
    if (currentPercentage >= phase.threshold) {
      return 'completed';
    }
    if (currentPhase === phase.phase ||
        (currentPhase.startsWith(phase.phase.split('_')[0]) && currentPercentage < phase.threshold)) {
      return 'in_progress';
    }
    return 'pending';
  };

  const isError = currentPhase === 'failed';

  return (
    <div
      className="mx-3 mt-2 rounded-xl overflow-hidden cursor-pointer transition-all duration-300"
      style={{ background: isError
        ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)'
        : `linear-gradient(135deg, ${cardColors.accent} 0%, ${cardColors.purple} 100%)`
      }}
      onClick={() => setIsExpanded(!isExpanded)}
    >
      {/* ヘッダー部分 */}
      <div className="px-3.5 py-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {isError ? (
              <div className="w-4 h-4 rounded-full bg-white flex items-center justify-center">
                <span style={{ fontSize: 10, color: '#ef4444', fontWeight: 700 }}>!</span>
              </div>
            ) : (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            )}
            <span style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>
              {isError
                ? (progress?.message || 'エラーが発生しました')
                : totalDays > 0
                  ? `献立を生成中...（${progress?.completedSlots || 0}/${totalSlots}食、${totalDays}日分）`
                  : (progress?.message || defaultMessage)
              }
            </span>
          </div>
          <div className="flex items-center gap-1">
            {!isError && (
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>
                {progress?.percentage ? `${progress.percentage}%` : ''}
              </span>
            )}
            {/* UX2-11: 生成中でも中止できるように、常時タップ可能な中止ボタンを表示する。
                確認は window.confirm を使わず、親側の styled ConfirmDeleteModal に一本化するため、
                ここでは渡された onCancel をそのまま呼ぶだけにする（確認要否は呼び出し元の責務）。 */}
            {!isError && onCancel && (
              <button
                type="button"
                aria-label="生成を中止する"
                onClick={(e) => {
                  e.stopPropagation();
                  onCancel();
                }}
                className="w-5 h-5 rounded-full flex items-center justify-center"
                style={{ background: 'rgba(255,255,255,0.2)' }}
              >
                <X size={11} color="#fff" />
              </button>
            )}
            {isExpanded ? (
              <ChevronUp size={14} color="rgba(255,255,255,0.7)" />
            ) : (
              <ChevronDown size={14} color="rgba(255,255,255,0.7)" />
            )}
          </div>
        </div>
        {progress?.percentage !== undefined && !isError && (
          <div className="mt-2 h-1.5 bg-white/20 rounded-full overflow-hidden">
            <div
              className="h-full bg-white rounded-full transition-all duration-500 ease-out"
              style={{ width: `${progress.percentage}%` }}
            />
          </div>
        )}
      </div>

      {/* 展開時のToDoリスト（エラー時は表示しない） */}
      <AnimatePresence>
        {isExpanded && !isError && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-3.5 pb-3 pt-1 border-t border-white/20">
              <div className="space-y-1.5">
                {dynamicPhases.filter(p => p.phase !== 'failed').map((phase) => {
                  const status = getPhaseStatus(phase);
                  return (
                    <div
                      key={phase.phase}
                      className="flex items-center gap-2"
                    >
                      {status === 'completed' ? (
                        <div className="w-4 h-4 rounded-full bg-white flex items-center justify-center">
                          <Check size={10} color={isError ? '#ef4444' : cardColors.accent} strokeWidth={3} />
                        </div>
                      ) : status === 'in_progress' ? (
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <div className="w-4 h-4 rounded-full border-2 border-white/40" />
                      )}
                      <span
                        style={{
                          fontSize: 11,
                          color: status === 'pending' ? 'rgba(255,255,255,0.5)' : '#fff',
                          fontWeight: status === 'in_progress' ? 600 : 400,
                        }}
                      >
                        {phase.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
