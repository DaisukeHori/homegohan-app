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
} from "@homegohan/shared";

// ============================================
// Types
// ============================================

interface NutritionRadarChartProps {
  nutrition: Record<string, number>;
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
  danger: '#D9534F',
  dangerBg: '#FDECEA',
  dangerBorder: '#F5C2C0',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#767676', // #1052 (コントラスト): #A0A0A0 (白地で約2.7:1) から WCAG AA相当の #767676 (約4.5:1) へ
  grid: '#E8E8E8',
};

// 過剰摂取警告のしきい値（%）
const OVERCONSUMPTION_THRESHOLD = 150;
// 達成率の表示上限（%） — Bug-21 ガード
const DISPLAY_CAP = 200;

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
      const value = nutrition[key] ?? 0;
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
    if (chartData.length === 0) return 0;
    const total = chartData.reduce((sum, d) => sum + d.fullValue, 0);
    return Math.round(total / chartData.length);
  }, [chartData]);

  // 表示用の達成率（DISPLAY_CAP で上限ガード）— Bug-21
  const displayPercentage = Math.min(averagePercentage, DISPLAY_CAP);
  const isCapped = averagePercentage > DISPLAY_CAP;

  // 過剰摂取軸（>OVERCONSUMPTION_THRESHOLD%）の検出 — Bug-21
  const overconsumedNutrients = useMemo(
    () => chartData.filter(d => d.fullValue > OVERCONSUMPTION_THRESHOLD),
    [chartData]
  );
  const showOverconsumptionWarning =
    overconsumedNutrients.length > 0 || averagePercentage > OVERCONSUMPTION_THRESHOLD;

  // 達成率に応じた色
  const getStatusColor = (percentage: number) => {
    if (percentage > OVERCONSUMPTION_THRESHOLD) return colors.danger;
    if (percentage >= 80 && percentage <= 120) return colors.success;
    if (percentage < 50 || percentage > 120) return colors.warning;
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

  // #1052 (体系的 a11y): 推移グラフ同様に <svg> へ role/aria-label がゼロだった問題への対応。
  // recharts の SVG はマウスホバーのツールチップでしか各栄養素の詳細を出せずキーボード/
  // スクリーンリーダーから内容を辿れないため、role="img" + aria-label で概要を、
  // 視覚上は隠す（sr-only）データテーブルで全栄養素の詳細を代替提供する。
  const chartAriaLabel = `栄養素レーダーチャート。平均達成率${displayPercentage}${isCapped ? '%以上' : '%'}${
    showOverconsumptionWarning ? '。過剰摂取の可能性がある栄養素があります' : ''
  }。詳細は表を参照してください。`;

  // #1052 (レビュー残指摘: mini radar の accessible name): onTap 指定時（day-card の
  // mini radar 等）は外側ラッパーに role="button" を付与するが、WAI-ARIA 上 button は
  // children-presentational（子孫が名前計算に取り込まれる/アクセシビリティツリーから
  // 実質剪定される）ため、明示的な aria-label を付けないと sr-only データテーブルの
  // 全セル文字列がボタン名に平坦化されてしまう。ここで chartAriaLabel 相当の要約に
  // 操作案内を足した文言を明示的に aria-label として与える。
  const interactiveAriaLabel = onTap ? `${chartAriaLabel}タップで詳細を表示します。` : undefined;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onTap) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onTap();
    }
  };

  return (
    <>
    <div
      className={`relative ${onTap ? 'cursor-pointer' : ''}`}
      onClick={onTap}
      onKeyDown={onTap ? handleKeyDown : undefined}
      role={onTap ? 'button' : undefined}
      aria-label={interactiveAriaLabel}
      tabIndex={onTap ? 0 : undefined}
      style={{ width: size, height: size }}
    >
      {/* #1052 (Opus 指摘の Critical 修正): role="img" は WAI-ARIA 上、子孫をアクセシビリティ
          ツリーから剪定する。以前は sr-only データテーブルや過剰摂取アラート(role="alert")を
          この role="img" の子孫に置いていたため、支援技術から到達不能になっていた。
          そのため role="img" はチャート本体（recharts の SVG）だけを包み、テーブルとアラートは
          兄弟要素として配置する。
          また、この内側ラッパーに幅/高さ 100% を明示的に継承させないと、外側の固定サイズ
          (width/height=size) が ResponsiveContainer の height="100%" まで伝播せず、
          高さ 0 に解決してチャートが描画されない回帰を招くため w-full h-full を必須で付与する。 */}
      <div
        role="img"
        aria-label={chartAriaLabel}
        className="w-full h-full"
      >
        {/* 装飾的な SVG 本体自体も aria-hidden にし、二重読み上げを防止する */}
        <div aria-hidden="true" className="w-full h-full">
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
        </div>
      </div>

      {/* 中央に達成率表示 */}
      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        style={{ top: '35%' }}
        data-testid="radar-average-display"
      >
        <div className="text-center">
          <span
            className="text-2xl font-bold"
            style={{ color: getStatusColor(averagePercentage) }}
            data-overconsumption={showOverconsumptionWarning ? 'true' : 'false'}
          >
            {displayPercentage}{isCapped ? '+' : ''}%
          </span>
          <p className="text-[9px]" style={{ color: colors.textMuted }}>
            平均達成率
          </p>
        </div>
      </div>

      {/* 過剰摂取アラート (Bug-21) */}
      {showOverconsumptionWarning && showLabels && (
        <div
          role="alert"
          data-testid="overconsumption-warning"
          className="absolute left-0 right-0 -bottom-2 translate-y-full px-2 py-1.5 rounded-md text-[10px] leading-tight pointer-events-none"
          style={{
            background: colors.dangerBg,
            color: colors.danger,
            border: `1px solid ${colors.dangerBorder}`,
          }}
        >
          <span className="font-bold">⚠ 過剰摂取の可能性</span>
          <span className="ml-1">
            {overconsumedNutrients.length > 0
              ? `${overconsumedNutrients
                  .slice(0, 3)
                  .map(n => `${n.nutrient}(${n.fullValue}%)`)
                  .join(', ')}${overconsumedNutrients.length > 3 ? ' …' : ''}`
              : `平均 ${averagePercentage}% は推奨量を大きく超えています`}
          </span>
        </div>
      )}
    </div>

    {/* #1052 (レビュー残指摘: mini radar の accessible name): スクリーンリーダー向け
        データテーブル代替（視覚上は非表示）。role="img" だけでなく、外側の相互作用
        ラッパー（onTap 指定時は role="button"）の外にも配置する。role="button" は
        children-presentational のため、内側に置いたままだと onTap 指定時（day-card の
        mini radar 等）にテーブルの全セル文字列がボタン名へ平坦化されたり、テーブルの
        セマンティクスが支援技術から到達不能になる。外に出すことで、モーダル用途
        （onTap 非指定）では従来どおり露出したまま、mini radar 用途でも平坦化されずに
        独立した表として読み上げ可能になる。 */}
    <table
      className="sr-only"
      data-testid="radar-chart-data-table"
    >
      <caption>栄養素ごとの摂取量と推奨量に対する達成率</caption>
      <thead>
        <tr>
          <th scope="col">栄養素</th>
          <th scope="col">摂取量</th>
          <th scope="col">推奨量</th>
          <th scope="col">達成率</th>
        </tr>
      </thead>
      <tbody>
        {chartData.map((d) => (
          <tr key={d.nutrient}>
            <th scope="row">{d.nutrient}</th>
            <td>{d.actualValue.toFixed(1)}{d.unit}</td>
            <td>{d.dri}{d.unit}</td>
            <td>{d.fullValue}%</td>
          </tr>
        ))}
      </tbody>
    </table>
    </>
  );
}

export default NutritionRadarChart;
