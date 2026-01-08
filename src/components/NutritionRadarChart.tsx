"use client";

import React, { useMemo } from "react";
import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { 
  getNutrientDefinition, 
  calculateDriPercentage,
  DEFAULT_RADAR_NUTRIENTS,
} from "@/lib/nutrition-constants";

// ============================================
// Types
// ============================================

interface DayNutrition {
  caloriesKcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  sodiumG: number;
  sugarG: number;
  fiberG: number;
  potassiumMg: number;
  calciumMg: number;
  phosphorusMg: number;
  magnesiumMg: number;
  ironMg: number;
  zincMg: number;
  iodineUg: number;
  cholesterolMg: number;
  vitaminAUg: number;
  vitaminB1Mg: number;
  vitaminB2Mg: number;
  vitaminB6Mg: number;
  vitaminB12Ug: number;
  vitaminCMg: number;
  vitaminDUg: number;
  vitaminEMg: number;
  vitaminKUg: number;
  folicAcidUg: number;
  saturatedFatG: number;
}

interface NutritionRadarChartProps {
  nutrition: DayNutrition;
  selectedNutrients?: string[] | null;
  size?: number;
  showLabels?: boolean;
  onTap?: () => void;
}

// ============================================
// Color Palette
// ============================================

const colors = {
  accent: '#E07A5F',
  accentLight: 'rgba(224, 122, 95, 0.3)',
  success: '#6B9B6B',
  warning: '#E5A84B',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  grid: '#E8E8E8',
};

// ============================================
// Component
// ============================================

export function NutritionRadarChart({
  nutrition,
  selectedNutrients,
  size = 200,
  showLabels = true,
  onTap,
}: NutritionRadarChartProps) {
  // 表示する栄養素（ユーザー設定 or デフォルト）
  const nutrients = selectedNutrients?.length ? selectedNutrients : DEFAULT_RADAR_NUTRIENTS;

  // レーダーチャート用のデータを生成
  const chartData = useMemo(() => {
    return nutrients.map(key => {
      const def = getNutrientDefinition(key);
      const value = (nutrition as any)[key] ?? 0;
      const percentage = calculateDriPercentage(key, value);
      
      return {
        nutrient: def?.label ?? key,
        value: Math.min(percentage, 150), // 150%でキャップ（表示上）
        fullValue: percentage,
        actualValue: value,
        unit: def?.unit ?? '',
        dri: def?.dri ?? 0,
      };
    });
  }, [nutrients, nutrition]);

  // 全体の達成率（平均）
  const averagePercentage = useMemo(() => {
    const total = chartData.reduce((sum, d) => sum + d.fullValue, 0);
    return Math.round(total / chartData.length);
  }, [chartData]);

  // 達成率に応じた色
  const getStatusColor = (percentage: number) => {
    if (percentage >= 80 && percentage <= 120) return colors.success;
    if (percentage < 50 || percentage > 150) return colors.warning;
    return colors.accent;
  };

  // カスタムツールチップ
  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div
          className="px-3 py-2 rounded-lg shadow-lg"
          style={{ background: 'white', border: `1px solid ${colors.grid}` }}
        >
          <p className="text-xs font-bold" style={{ color: colors.text }}>
            {data.nutrient}
          </p>
          <p className="text-xs" style={{ color: colors.textLight }}>
            {data.actualValue.toFixed(1)}{data.unit} / {data.dri}{data.unit}
          </p>
          <p className="text-xs font-bold" style={{ color: getStatusColor(data.fullValue) }}>
            {data.fullValue}%
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <div
      className={`relative ${onTap ? 'cursor-pointer' : ''}`}
      onClick={onTap}
      style={{ width: size, height: size }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={chartData} margin={{ top: 10, right: 10, bottom: 10, left: 10 }}>
          <PolarGrid stroke={colors.grid} />
          <PolarAngleAxis
            dataKey="nutrient"
            tick={showLabels ? { fill: colors.textMuted, fontSize: 9 } : false}
          />
          <PolarRadiusAxis
            angle={90}
            domain={[0, 150]}
            tick={false}
            axisLine={false}
          />
          {/* 100%ライン（推奨量） */}
          <Radar
            name="推奨量"
            dataKey={() => 100}
            stroke={colors.grid}
            strokeDasharray="3 3"
            fill="none"
          />
          {/* 実際の値 */}
          <Radar
            name="摂取量"
            dataKey="value"
            stroke={colors.accent}
            strokeWidth={2}
            fill={colors.accentLight}
            fillOpacity={0.6}
          />
          <Tooltip content={<CustomTooltip />} />
        </RadarChart>
      </ResponsiveContainer>

      {/* 中央に達成率表示 */}
      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        style={{ top: '35%' }}
      >
        <div className="text-center">
          <span
            className="text-2xl font-bold"
            style={{ color: getStatusColor(averagePercentage) }}
          >
            {averagePercentage}%
          </span>
          <p className="text-[9px]" style={{ color: colors.textMuted }}>
            平均達成率
          </p>
        </div>
      </div>
    </div>
  );
}

export default NutritionRadarChart;
