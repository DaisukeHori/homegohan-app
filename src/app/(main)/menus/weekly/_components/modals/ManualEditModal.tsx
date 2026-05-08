"use client";

import React from "react";
import { motion } from "framer-motion";
import Image from "next/image";
import { X, Check, Trash2, Plus, Pencil, Camera, Image as ImageIcon } from "lucide-react";
import type { MealMode, PlannedMeal, DishDetail } from "@/types/domain";
import type { CatalogProductSummary } from "@/types/catalog";
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
  blue: '#5B8BC7',
  blueLight: '#EEF4FB',
  border: '#E8E8E8',
  danger: '#D64545',
  dangerLight: '#FDECEC',
};

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

interface ModeConfig {
  icon: React.ElementType;
  label: string;
  color: string;
  bg: string;
}

interface ManualEditModalProps {
  manualEditMeal: PlannedMeal;
  modeConfig: Record<string, ModeConfig>;
  onClose: () => void;
  onApplyCatalogProduct: (product: CatalogProductSummary) => void;
  onAddDish: () => void;
  onRemoveDish: (index: number) => void;
  onUpdateDish: (index: number, field: keyof DishDetail, value: string | number) => void;
  onOpenPhotoEdit: () => void;
  onOpenImageGenerate: () => void;
  onSave: () => void;
}

export function ManualEditModal({
  manualEditMeal,
  modeConfig,
  onClose,
  onApplyCatalogProduct,
  onAddDish,
  onRemoveDish,
  onUpdateDish,
  onOpenPhotoEdit,
  onOpenImageGenerate,
  onSave,
}: ManualEditModalProps) {
  const manualDishes = useFormDraftStore((s) => s.manualDishes);
  const manualMode = useFormDraftStore((s) => s.manualMode);
  const catalogQuery = useFormDraftStore((s) => s.catalogQuery);
  const catalogResults = useFormDraftStore((s) => s.catalogResults);
  const selectedCatalogProduct = useFormDraftStore((s) => s.selectedCatalogProduct);
  const isCatalogSearching = useFormDraftStore((s) => s.isCatalogSearching);
  const catalogSearchError = useFormDraftStore((s) => s.catalogSearchError);
  const setManualMode = useFormDraftStore((s) => s.setManualMode);
  const setCatalogQuery = useFormDraftStore((s) => s.setCatalogQuery);
  const setSelectedCatalogProduct = useFormDraftStore((s) => s.setSelectedCatalogProduct);

  return (
    <motion.div
      initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col rounded-t-3xl"
      style={{ background: colors.card, maxHeight: '75vh' }}
    >
      <div className="flex justify-between items-center px-4 py-3 flex-shrink-0" style={{ borderBottom: `1px solid ${colors.border}` }}>
        <div className="flex items-center gap-2">
          <Pencil size={18} color={colors.textLight} />
          <span style={{ fontSize: 15, fontWeight: 600 }}>手動で変更</span>
        </div>
        <button onClick={onClose} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
          <X size={14} color={colors.textLight} />
        </button>
      </div>
      <div className="flex-1 p-4 overflow-auto">
        {/* Mode Selection */}
        <div className="mb-4">
          <label style={{ fontSize: 12, color: colors.textMuted, display: 'block', marginBottom: 8 }}>タイプ</label>
          <div className="flex flex-wrap gap-2">
            {(Object.entries(modeConfig) as [MealMode, ModeConfig][]).map(([key, mode]) => {
              const ModeIcon = mode.icon;
              const isSelected = manualMode === key;
              return (
                <button
                  key={key}
                  onClick={() => setManualMode(key)}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg"
                  style={{
                    background: isSelected ? mode.bg : colors.bg,
                    border: isSelected ? `2px solid ${mode.color}` : '2px solid transparent'
                  }}
                >
                  <ModeIcon size={14} color={isSelected ? mode.color : colors.textMuted} />
                  <span style={{ fontSize: 12, color: isSelected ? mode.color : colors.textMuted }}>{mode.label}</span>
                </button>
              );
            })}
          </div>
        </div>

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
            コンビニだけでなく、今後はスーパーや外食メニューも同じ catalog で追加します。
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
                    onClick={() => onApplyCatalogProduct(product)}
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

        {/* Dishes */}
        <div className="mb-4">
          <div className="flex justify-between items-center mb-2">
            <label style={{ fontSize: 12, color: colors.textMuted }}>料理（複数可）</label>
            <button onClick={onAddDish} className="text-[12px] flex items-center gap-1" style={{ color: colors.accent }}>
              <Plus size={12} /> 追加
            </button>
          </div>
          {manualDishes.map((dish, idx) => (
            <div key={idx} className="flex gap-2 mb-2">
              <select
                value={dish.role || 'main'}
                onChange={(e) => onUpdateDish(idx, 'role', e.target.value)}
                className="w-20 p-2 rounded-lg text-[12px] outline-none"
                style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
              >
                <option value="main">主菜</option>
                <option value="side">副菜</option>
                <option value="soup">汁物</option>
                <option value="rice">ご飯</option>
                <option value="salad">サラダ</option>
                <option value="dessert">デザート</option>
              </select>
              <input
                type="text"
                value={dish.name}
                onChange={(e) => onUpdateDish(idx, 'name', e.target.value)}
                placeholder="料理名"
                className="flex-1 p-2 rounded-lg text-[13px] outline-none"
                style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
              />
              <input
                type="number"
                value={dish.calories_kcal || ''}
                onChange={(e) => onUpdateDish(idx, 'calories_kcal', parseInt(e.target.value) || 0)}
                placeholder="kcal"
                className="w-16 p-2 rounded-lg text-[13px] outline-none text-center"
                style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
              />
              {manualDishes.length > 1 && (
                <button onClick={() => onRemoveDish(idx)} className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: colors.dangerLight }}>
                  <Trash2 size={14} color={colors.danger} />
                </button>
              )}
            </div>
          ))}
        </div>

        {manualEditMeal.imageUrl && (
          <div className="mb-4">
            <label style={{ fontSize: 12, color: colors.textMuted, display: 'block', marginBottom: 8 }}>現在の画像</label>
            <div className="relative h-40 rounded-2xl overflow-hidden" style={{ border: `1px solid ${colors.border}` }}>
              <Image
                src={manualEditMeal.imageUrl}
                alt={manualEditMeal.dishName || 'Meal image'}
                fill
                sizes="(max-width: 1024px) 100vw, 50vw"
                className="object-cover"
              />
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <button
            onClick={onOpenPhotoEdit}
            className="w-full p-3 rounded-xl flex items-center justify-center gap-2"
            style={{ background: colors.blueLight, border: `1px solid ${colors.blue}` }}
          >
            <Camera size={16} color={colors.blue} />
            <span style={{ fontSize: 13, color: colors.blue }}>写真から入力</span>
          </button>
          <button
            onClick={onOpenImageGenerate}
            className="w-full p-3 rounded-xl flex items-center justify-center gap-2"
            style={{ background: colors.accentLight, border: `1px solid ${colors.accent}` }}
          >
            <ImageIcon size={16} color={colors.accent} />
            <span style={{ fontSize: 13, color: colors.accent }}>AIで画像生成</span>
          </button>
        </div>
      </div>
      <div className="px-4 py-4 pb-4 lg:pb-6 flex-shrink-0" style={{ borderTop: `1px solid ${colors.border}`, background: colors.card }}>
        <button
          onClick={onSave}
          className="w-full py-3.5 rounded-xl flex items-center justify-center gap-2"
          style={{ background: colors.accent }}
        >
          <Check size={16} color="#fff" />
          <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>保存する</span>
        </button>
      </div>
    </motion.div>
  );
}
