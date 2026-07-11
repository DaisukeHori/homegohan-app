"use client";

import React, { useId, useRef } from "react";
import { motion } from "framer-motion";
import FocusTrap from "focus-trap-react";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BookOpen, X, Flame, ShoppingCart, Heart } from "lucide-react";
import { useDialogA11y } from "@/components/common/useDialogA11y";

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#767676', // #1052 (コントラスト): #A0A0A0 (白地で約2.7:1) から WCAG AA相当の #767676 (約4.5:1) へ
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  success: '#6B9B6B',
  purple: '#7C6BA0',
  blue: '#5B8BC7',
  border: '#E8E8E8',
};

const formatNutrition = (value: number | null | undefined, decimals = 1): string => {
  if (value === null || value === undefined) return '';
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  const factor = Math.pow(10, decimals);
  const rounded = Math.round(num * factor) / factor;
  if (rounded === 0) return '';
  if (decimals === 0) {
    return String(Math.round(num));
  }
  const fixed = rounded.toFixed(decimals);
  if (fixed.endsWith('.0') || fixed.endsWith('.00')) {
    return String(Math.round(rounded));
  }
  return fixed;
};

const shouldShowNutrition = (value: number | null | undefined, decimals = 1): boolean => {
  if (value === null || value === undefined) return false;
  const num = Number(value);
  if (!Number.isFinite(num)) return false;
  const rounded = Math.round(num * Math.pow(10, decimals)) / Math.pow(10, decimals);
  return rounded !== 0;
};

const NutritionItem = ({ label, value, unit, decimals = 1, textColor }: {
  label: string;
  value: number | null | undefined;
  unit: string;
  decimals?: number;
  textColor?: string;
}) => {
  if (!shouldShowNutrition(value, decimals)) return null;
  const formatted = formatNutrition(value, decimals);
  if (!formatted) return null;
  return (
    <div className="flex justify-between">
      <span style={{ color: textColor }}>{label}</span>
      <span className="font-medium">{formatted}{unit}</span>
    </div>
  );
};

const parseIngredientsText = (text: string): { name: string; amount: string }[] => {
  const results: { name: string; amount: string }[] = [];
  let cleaned = text.replace(/^材料\d*人分使用量買い物量\s*\(目安\)/g, '');
  cleaned = cleaned.replace(/※.+$/g, '');
  const regex = /([ぁ-んァ-ヶー一-龯a-zA-ZＡ-Ｚａ-ｚ（）\(\)・]+)(\d+\.?\d*\s*[gGmlMLm㎖㎗ℓ]|\d*[小大]さじ[\d\/]+[強弱]?\s*(?:\([^)]+\))?|少々|適量|\d+個|\d+枚|\d+本|\d+束|\d+袋|\d+缶|\d+丁|\d+片|\d+切れ|\d+合)/g;
  let match;
  while ((match = regex.exec(cleaned)) !== null) {
    const name = match[1].trim();
    const amount = match[2].trim();
    if (name.length > 0 && !['A', '調味料', '合わせ調味料'].includes(name)) {
      results.push({ name, amount });
    }
  }
  return results;
};

const formatIngredientsToMarkdown = (ingredientsText: string | null | undefined, ingredients: string[] | null | undefined): string => {
  if (ingredients && ingredients.length > 0) {
    const firstItem = ingredients[0];
    if (firstItem.length > 100) {
      const parsed = parseIngredientsText(firstItem);
      if (parsed.length > 0) {
        let md = "| 材料 | 分量 |\n|------|------|\n";
        const seen = new Set<string>();
        for (const p of parsed) {
          const key = `${p.name}-${p.amount}`;
          if (!seen.has(key)) {
            seen.add(key);
            md += `| ${p.name} | ${p.amount} |\n`;
          }
        }
        return md;
      }
    }
    let md = "| 材料 | 分量 |\n|------|------|\n";
    for (const ing of ingredients) {
      if (ing.length < 100) {
        md += `| ${ing} |  |\n`;
      }
    }
    return md;
  }
  return '';
};

const formatRecipeStepsToMarkdown = (recipeStepsText: string | null | undefined, recipeSteps: string[] | null | undefined): string => {
  if (recipeSteps && recipeSteps.length > 0) {
    return recipeSteps.map((step, i) => `${i + 1}. ${step.replace(/^\d+\.\s*/, '')}`).join('\n\n');
  }
  return '';
};

interface RecipeModalProps {
  selectedRecipe: string;
  selectedRecipeData: any;
  isFavorite: boolean;
  isFavoriteLoading: boolean;
  onClose: () => void;
  onToggleFavorite: () => void;
  onAddToShoppingList: () => void;
}

export function RecipeModal({
  selectedRecipe,
  selectedRecipeData,
  isFavorite,
  isFavoriteLoading,
  onClose,
  onToggleFavorite,
  onAddToShoppingList,
}: RecipeModalProps) {
  // #1052 (体系的 a11y)
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogA11y({ onClose });

  return (
    <FocusTrap
      focusTrapOptions={{
        allowOutsideClick: true,
        escapeDeactivates: false,
        fallbackFocus: () => panelRef.current ?? document.body,
      }}
    >
    <motion.div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col rounded-t-3xl overflow-hidden"
      style={{ background: colors.card, maxHeight: '90vh' }}
    >
      <div className="flex justify-between items-center px-4 py-3 flex-shrink-0" style={{ borderBottom: `1px solid ${colors.border}` }}>
        <div className="flex items-center gap-2">
          <BookOpen size={18} color={colors.accent} />
          <span id={titleId} style={{ fontSize: 15, fontWeight: 600 }}>{selectedRecipe}</span>
        </div>
        <button onClick={onClose} aria-label="閉じる" className="min-w-[44px] min-h-[44px] -m-2 flex items-center justify-center">
          <span className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
            <X size={14} color={colors.textLight} />
          </span>
        </button>
      </div>
      <div className="flex-1 min-h-0 p-4 overflow-y-auto">
        {/* 基本情報 */}
        <div className="flex flex-wrap gap-3 mb-4">
          {selectedRecipeData?.role && (
            <span className="px-2 py-0.5 rounded text-[11px] font-bold" style={{
              background: selectedRecipeData.role === 'main' ? colors.accent : selectedRecipeData.role === 'rice' ? '#8B4513' : selectedRecipeData.role === 'soup' ? colors.blue : colors.success,
              color: '#fff'
            }}>
              {selectedRecipeData.role === 'main' ? '主菜' : selectedRecipeData.role === 'soup' ? '汁物' : selectedRecipeData.role === 'rice' ? '主食' : '副菜'}
            </span>
          )}
          <div className="flex items-center gap-1">
            <Flame size={14} color={colors.textMuted} />
            <span style={{ fontSize: 12, color: colors.textLight }}>{selectedRecipeData?.calories_kcal ?? selectedRecipeData?.cal ?? '-'}kcal</span>
          </div>
        </div>

        {(selectedRecipeData?.imageUrl || selectedRecipeData?.image_status) && (
          <div className="mb-4">
            {selectedRecipeData?.imageUrl ? (
              <div className="relative h-48 rounded-2xl overflow-hidden" style={{ border: `1px solid ${colors.border}` }}>
                <Image
                  src={selectedRecipeData.imageUrl}
                  alt={selectedRecipe ?? 'Dish image'}
                  fill
                  sizes="(max-width: 1024px) 100vw, 50vw"
                  className="object-cover"
                />
              </div>
            ) : (
              <div
                className="h-48 rounded-2xl flex items-center justify-center px-4 text-center"
                style={{ background: colors.bg, border: `1px dashed ${colors.border}` }}
              >
                <p style={{ fontSize: 13, color: colors.textMuted, margin: 0 }}>
                  {selectedRecipeData?.image_status === 'pending'
                    ? '料理画像を生成中です'
                    : selectedRecipeData?.image_status === 'stale'
                      ? '料理内容の変更後、画像を再生成待ちです'
                      : '料理画像の生成に失敗しました'}
                </p>
              </div>
            )}
            {selectedRecipeData?.image_status && selectedRecipeData.image_status !== 'ready' && (
              <p style={{ fontSize: 11, color: colors.textMuted, marginTop: 8, marginBottom: 0 }}>
                {selectedRecipeData.image_status === 'pending'
                  ? 'AIが料理画像を生成しています。'
                  : selectedRecipeData.image_status === 'stale'
                    ? '現在の料理内容に合わせた画像へ更新待ちです。'
                    : '画像生成に失敗しました。後でもう一度お試しください。'}
              </p>
            )}
          </div>
        )}

        {/* この料理の栄養素 */}
        {selectedRecipeData && (selectedRecipeData.protein_g || selectedRecipeData.fat_g || selectedRecipeData.carbs_g) && (
          <div className="rounded-xl p-3 mb-4" style={{ background: colors.bg }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: colors.text, margin: '0 0 8px' }}>📊 この料理の栄養素</p>
            <div className="grid grid-cols-3 gap-x-3 gap-y-1.5 text-[11px]" style={{ color: colors.text }}>
              {/* 基本栄養素 */}
              <NutritionItem label="エネルギー" value={selectedRecipeData.calories_kcal} unit="kcal" decimals={0} textColor={colors.textMuted} />
              <NutritionItem label="タンパク質" value={selectedRecipeData.protein_g} unit="g" textColor={colors.textMuted} />
              <NutritionItem label="脂質" value={selectedRecipeData.fat_g} unit="g" textColor={colors.textMuted} />
              <NutritionItem label="炭水化物" value={selectedRecipeData.carbs_g} unit="g" textColor={colors.textMuted} />
              <NutritionItem label="食物繊維" value={selectedRecipeData.fiber_g} unit="g" textColor={colors.textMuted} />
              <NutritionItem label="糖質" value={selectedRecipeData.sugar_g} unit="g" textColor={colors.textMuted} />
              {/* ミネラル */}
              <NutritionItem label="塩分" value={selectedRecipeData.sodium_g} unit="g" textColor={colors.textMuted} />
              <NutritionItem label="カリウム" value={selectedRecipeData.potassium_mg} unit="mg" decimals={0} textColor={colors.textMuted} />
              <NutritionItem label="カルシウム" value={selectedRecipeData.calcium_mg} unit="mg" decimals={0} textColor={colors.textMuted} />
              <NutritionItem label="リン" value={selectedRecipeData.phosphorus_mg} unit="mg" decimals={0} textColor={colors.textMuted} />
              <NutritionItem label="鉄分" value={selectedRecipeData.iron_mg} unit="mg" textColor={colors.textMuted} />
              <NutritionItem label="亜鉛" value={selectedRecipeData.zinc_mg} unit="mg" textColor={colors.textMuted} />
              <NutritionItem label="ヨウ素" value={selectedRecipeData.iodine_ug} unit="µg" decimals={0} textColor={colors.textMuted} />
              <NutritionItem label="コレステロール" value={selectedRecipeData.cholesterol_mg} unit="mg" decimals={0} textColor={colors.textMuted} />
              {/* ビタミン */}
              <NutritionItem label="ビタミンA" value={selectedRecipeData.vitamin_a_ug} unit="µg" decimals={0} textColor={colors.textMuted} />
              <NutritionItem label="ビタミンB1" value={selectedRecipeData.vitamin_b1_mg} unit="mg" decimals={2} textColor={colors.textMuted} />
              <NutritionItem label="ビタミンB2" value={selectedRecipeData.vitamin_b2_mg} unit="mg" decimals={2} textColor={colors.textMuted} />
              <NutritionItem label="ビタミンB6" value={selectedRecipeData.vitamin_b6_mg} unit="mg" decimals={2} textColor={colors.textMuted} />
              <NutritionItem label="ビタミンB12" value={selectedRecipeData.vitamin_b12_ug} unit="µg" textColor={colors.textMuted} />
              <NutritionItem label="ビタミンC" value={selectedRecipeData.vitamin_c_mg} unit="mg" decimals={0} textColor={colors.textMuted} />
              <NutritionItem label="ビタミンD" value={selectedRecipeData.vitamin_d_ug} unit="µg" textColor={colors.textMuted} />
              <NutritionItem label="ビタミンE" value={selectedRecipeData.vitamin_e_mg} unit="mg" textColor={colors.textMuted} />
              <NutritionItem label="ビタミンK" value={selectedRecipeData.vitamin_k_ug} unit="µg" decimals={0} textColor={colors.textMuted} />
              <NutritionItem label="葉酸" value={selectedRecipeData.folic_acid_ug} unit="µg" decimals={0} textColor={colors.textMuted} />
              {/* 脂肪酸 */}
              <NutritionItem label="飽和脂肪酸" value={selectedRecipeData.saturated_fat_g} unit="g" textColor={colors.textMuted} />
              <NutritionItem label="一価不飽和脂肪酸" value={selectedRecipeData.monounsaturated_fat_g} unit="g" textColor={colors.textMuted} />
              <NutritionItem label="多価不飽和脂肪酸" value={selectedRecipeData.polyunsaturated_fat_g} unit="g" textColor={colors.textMuted} />
            </div>
          </div>
        )}

        {/* 材料 */}
        <p style={{ fontSize: 13, fontWeight: 600, color: colors.text, margin: '0 0 8px' }}>🥕 材料</p>
        <div className="rounded-xl p-3 mb-4" style={{ background: colors.bg }}>
          {(() => {
            const dish = selectedRecipeData?.dishes?.[0];
            const ingredientsMd = dish?.ingredientsMd || formatIngredientsToMarkdown(
              dish?.ingredientsText,
              selectedRecipeData?.ingredients
            );
            if (ingredientsMd) {
              return (
                <div className="prose prose-sm max-w-none [&_table]:w-full [&_th]:text-left [&_th]:p-2 [&_td]:p-2 [&_tr]:border-b" style={{ fontSize: 13, color: colors.text }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{ingredientsMd}</ReactMarkdown>
                </div>
              );
            }
            return <p style={{ fontSize: 13, color: colors.textMuted }}>材料情報なし</p>;
          })()}
        </div>

        {/* 作り方 */}
        <p style={{ fontSize: 13, fontWeight: 600, color: colors.text, margin: '0 0 8px' }}>👨‍🍳 作り方</p>
        <div className="rounded-xl p-3" style={{ background: colors.bg }}>
          {(() => {
            const dish = selectedRecipeData?.dishes?.[0];
            const recipeStepsMd = dish?.recipeStepsMd || formatRecipeStepsToMarkdown(
              dish?.recipeStepsText,
              selectedRecipeData?.recipeSteps
            );
            if (recipeStepsMd) {
              return (
                <div className="prose prose-sm max-w-none [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:mb-2" style={{ fontSize: 13, color: colors.text }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{recipeStepsMd}</ReactMarkdown>
                </div>
              );
            }
            return (
              <p style={{ fontSize: 13, color: colors.textMuted }}>
                レシピはAI献立を生成すると自動で作成されます。<br />
                「AIで変更」ボタンから再生成してください。
              </p>
            );
          })()}
        </div>
      </div>
      <div className="px-4 py-2.5 pb-4 lg:pb-6 flex gap-2 flex-shrink-0" style={{ borderTop: `1px solid ${colors.border}` }}>
        <button
          onClick={onToggleFavorite}
          disabled={isFavoriteLoading}
          aria-pressed={isFavorite}
          aria-label={isFavorite ? 'お気に入りから削除' : 'お気に入りに追加'}
          className="w-11 h-11 rounded-full flex items-center justify-center transition-colors active:scale-95 transition-transform"
          style={{ background: isFavorite ? '#FFF0F0' : colors.bg }}
          data-testid="favorite-button"
        >
          <Heart
            size={18}
            color={isFavorite ? '#FF6B6B' : colors.textMuted}
            fill={isFavorite ? '#FF6B6B' : 'none'}
          />
        </button>
        <button
          onClick={onAddToShoppingList}
          className="flex-1 p-3 rounded-xl font-semibold text-[14px] flex items-center justify-center gap-2 active:scale-95 transition-transform"
          style={{ background: colors.accent, color: '#fff' }}
        >
          <ShoppingCart size={18} />
          材料を買い物リストに追加
        </button>
      </div>
    </motion.div>
    </FocusTrap>
  );
}
