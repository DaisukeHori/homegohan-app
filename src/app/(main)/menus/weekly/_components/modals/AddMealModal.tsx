"use client";

import React from "react";
import { motion } from "framer-motion";
import { X, Sparkles } from "lucide-react";
import type { MealMode } from "@/types/domain";
import { MEAL_LABELS } from "@homegohan/shared";
import { useFormDraftStore } from "../../_state";

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  purple: '#7C6BA0',
  purpleLight: '#F5F3F8',
  border: '#E8E8E8',
  danger: '#D64545',
};

type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'midnight_snack';

interface ModeConfig {
  icon: React.ElementType;
  label: string;
  color: string;
  bg: string;
}

const formatNutrition = (value: number | null | undefined, decimals = 1): string => {
  if (value === null || value === undefined) return '';
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  const factor = Math.pow(10, decimals);
  const rounded = Math.round(num * factor) / factor;
  if (rounded === 0) return '';
  if (decimals === 0) return String(Math.round(num));
  const fixed = rounded.toFixed(decimals);
  if (fixed.endsWith('.0') || fixed.endsWith('.00')) return String(Math.round(rounded));
  return fixed;
};

interface AddMealModalProps {
  modeConfig: Record<string, ModeConfig>;
  onClose: () => void;
  onOpenAiMeal: () => void;
  onAddMealWithMode: (mode: MealMode) => void;
}

export function AddMealModal({
  modeConfig,
  onClose,
  onOpenAiMeal,
  onAddMealWithMode,
}: AddMealModalProps) {
  const addMealKey = useFormDraftStore((s) => s.addMealKey);
  const catalogQuery = useFormDraftStore((s) => s.catalogQuery);
  const catalogResults = useFormDraftStore((s) => s.catalogResults);
  const selectedCatalogProduct = useFormDraftStore((s) => s.selectedCatalogProduct);
  const isCatalogSearching = useFormDraftStore((s) => s.isCatalogSearching);
  const catalogSearchError = useFormDraftStore((s) => s.catalogSearchError);
  const setCatalogQuery = useFormDraftStore((s) => s.setCatalogQuery);
  const setSelectedCatalogProduct = useFormDraftStore((s) => s.setSelectedCatalogProduct);

  return (
    <motion.div
      initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col rounded-t-3xl"
      style={{ background: colors.card }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex justify-between items-center px-4 py-3.5" style={{ borderBottom: `1px solid ${colors.border}` }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>{addMealKey && MEAL_LABELS[addMealKey]}を追加</span>
        <button onClick={onClose} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
          <X size={14} color={colors.textLight} />
        </button>
      </div>
      <div className="flex-1 overflow-auto px-4 py-3.5 pb-4 lg:pb-7">
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <label style={{ fontSize: 12, color: colors.textMuted }}>市販品・外食メニューから選ぶ</label>
            {selectedCatalogProduct && (
              <button
                onClick={() => {
                  setSelectedCatalogProduct(null);
                  setCatalogQuery('');
                }}
                className="text-[12px]"
                style={{ color: colors.textLight }}
              >
                解除
              </button>
            )}
          </div>
          <input
            type="text"
            value={catalogQuery}
            onChange={(e) => {
              setCatalogQuery(e.target.value);
              if (!e.target.value.trim()) {
                setSelectedCatalogProduct(null);
              }
            }}
            placeholder="商品名で検索"
            className="w-full p-3 rounded-xl text-[13px] outline-none"
            style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
          />
          <p style={{ fontSize: 11, color: colors.textMuted, margin: '6px 0 0 0' }}>
            選んだ商品は「買う」か「外食」で追加すると公開栄養値ごと保存されます。
          </p>

          {selectedCatalogProduct && (
            <div
              className="mt-3 p-3 rounded-2xl"
              style={{ background: colors.purpleLight, border: `1px solid ${colors.purple}` }}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p style={{ fontSize: 12, color: colors.purple, margin: '0 0 4px 0', fontWeight: 600 }}>
                    選択中
                  </p>
                  <p style={{ fontSize: 14, color: colors.text, margin: 0, fontWeight: 600 }}>
                    {selectedCatalogProduct.name}
                  </p>
                  <p style={{ fontSize: 12, color: colors.textLight, margin: '4px 0 0 0' }}>
                    {selectedCatalogProduct.brandName}
                    {selectedCatalogProduct.priceYen ? ` / ${selectedCatalogProduct.priceYen}円` : ''}
                  </p>
                </div>
                <div style={{ fontSize: 12, color: colors.textLight, textAlign: 'right' }}>
                  <div>{selectedCatalogProduct.caloriesKcal ?? '-'} kcal</div>
                  <div>P {formatNutrition(selectedCatalogProduct.proteinG)}g</div>
                  <div>F {formatNutrition(selectedCatalogProduct.fatG)}g</div>
                  <div>C {formatNutrition(selectedCatalogProduct.carbsG)}g</div>
                </div>
              </div>
            </div>
          )}

          {(isCatalogSearching || catalogSearchError || catalogResults.length > 0) && (
            <div className="mt-3 space-y-2">
              {isCatalogSearching && (
                <p style={{ fontSize: 12, color: colors.textMuted, margin: 0 }}>検索中...</p>
              )}
              {catalogSearchError && (
                <p style={{ fontSize: 12, color: colors.danger, margin: 0 }}>{catalogSearchError}</p>
              )}
              {catalogResults.map((product) => {
                const isSelected = selectedCatalogProduct?.id === product.id;
                return (
                  <button
                    key={product.id}
                    onClick={() => setSelectedCatalogProduct(product)}
                    className="w-full p-3 rounded-2xl text-left"
                    style={{
                      background: isSelected ? colors.purpleLight : colors.bg,
                      border: isSelected ? `1px solid ${colors.purple}` : `1px solid ${colors.border}`,
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p style={{ fontSize: 12, color: colors.textMuted, margin: '0 0 4px 0' }}>
                          {product.brandName}
                        </p>
                        <p style={{ fontSize: 13, color: colors.text, margin: 0, fontWeight: 600 }}>
                          {product.name}
                        </p>
                        <p style={{ fontSize: 11, color: colors.textLight, margin: '4px 0 0 0' }}>
                          {product.categoryCode || '分類なし'}
                          {product.priceYen ? ` / ${product.priceYen}円` : ''}
                        </p>
                      </div>
                      <div style={{ fontSize: 11, color: colors.textLight, textAlign: 'right' }}>
                        <div>{product.caloriesKcal ?? '-'} kcal</div>
                        <div>P {formatNutrition(product.proteinG)}g</div>
                        <div>F {formatNutrition(product.fatG)}g</div>
                        <div>C {formatNutrition(product.carbsG)}g</div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          {(Object.entries(modeConfig) as [MealMode, ModeConfig][]).filter(([k]) => k !== 'skip').map(([key, mode]) => {
            const ModeIcon = mode.icon;
            return (
              <button
                key={key}
                onClick={() => onAddMealWithMode(key)}
                className="flex items-center gap-2.5 p-3 rounded-[10px]"
                style={{ background: mode.bg }}
              >
                <ModeIcon size={18} color={mode.color} />
                <span style={{ fontSize: 13, fontWeight: 500, color: colors.text }}>{mode.label}で追加</span>
              </button>
            );
          })}
          <button onClick={onOpenAiMeal} className="flex items-center gap-2.5 p-3 rounded-[10px]" style={{ background: colors.accentLight, border: `1px solid ${colors.accent}` }}>
            <Sparkles size={18} color={colors.accent} />
            <span style={{ fontSize: 13, fontWeight: 500, color: colors.accent }}>AIに提案してもらう</span>
          </button>
        </div>
      </div>
    </motion.div>
  );
}
