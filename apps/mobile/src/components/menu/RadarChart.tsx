import React from 'react';
import { Text, View } from 'react-native';
import Svg, {
  Circle,
  Line,
  Polygon,
  Text as SvgText,
} from 'react-native-svg';

import { NUTRIENT_DEFINITIONS } from '@homegohan/shared';

import { colors } from '../../theme/colors';

// ============================================================
// helpers
// ============================================================

function getDriPercent(key: string, value: number): number {
  const def = NUTRIENT_DEFINITIONS.find((d) => d.key === key);
  if (!def || def.dri === 0) return 0;
  return Math.round((value / def.dri) * 100);
}

function getBarColor(pct: number): string {
  if (pct > 150) return colors.error;
  if (pct >= 80 && pct <= 120) return colors.success;
  if (pct < 50) return colors.warning;
  return colors.accent;
}

// ============================================================
// RadarChart
// ============================================================

export interface RadarChartProps {
  /** nutrientKey → value のマップ */
  totals: Record<string, number>;
  /** 表示する栄養素キー (3〜8 個) */
  nutrientKeys: string[];
  size?: number;
}

export const RadarChart: React.FC<RadarChartProps> = ({
  totals,
  nutrientKeys,
  size = 220,
}) => {
  const n = nutrientKeys.length;
  if (n < 3) return null;

  const cx = size / 2;
  const cy = size / 2;
  const maxRadius = size * 0.37;
  const labelRadius = size * 0.47;
  const LEVELS = 3;
  const MAX_PCT = 150;

  const angleOf = (i: number) =>
    ((2 * Math.PI) / n) * i - Math.PI / 2;

  const ptOnCircle = (r: number, i: number) => ({
    x: cx + r * Math.cos(angleOf(i)),
    y: cy + r * Math.sin(angleOf(i)),
  });

  const gridPolygons = Array.from({ length: LEVELS }, (_, l) => {
    const r = (maxRadius * (l + 1)) / LEVELS;
    return Array.from({ length: n }, (__, i) => ptOnCircle(r, i))
      .map((p) => `${p.x},${p.y}`)
      .join(' ');
  });

  const spokes = Array.from({ length: n }, (_, i) =>
    ptOnCircle(maxRadius, i)
  );

  const dataPoints = nutrientKeys.map((key, i) => {
    const val = totals[key] ?? 0;
    const pct = Math.min(getDriPercent(key, val), MAX_PCT);
    return ptOnCircle((pct / MAX_PCT) * maxRadius, i);
  });

  const dataPolygon = dataPoints.map((p) => `${p.x},${p.y}`).join(' ');
  const refPolygon = Array.from({ length: n }, (_, i) =>
    ptOnCircle((100 / MAX_PCT) * maxRadius, i)
  )
    .map((p) => `${p.x},${p.y}`)
    .join(' ');

  const pcts = nutrientKeys.map((key) =>
    Math.min(getDriPercent(key, totals[key] ?? 0), MAX_PCT)
  );
  const avgPct = Math.round(
    pcts.reduce((s, v) => s + v, 0) / pcts.length
  );

  const labelFontSize = Math.max(7, Math.min(9, size / 26));

  return (
    <View style={{ alignItems: 'center', width: size, height: size }}>
      <Svg width={size} height={size}>
        {gridPolygons.map((pts, l) => (
          <Polygon
            key={`g${l}`}
            points={pts}
            fill="none"
            stroke="#E8E8E8"
            strokeWidth={1}
          />
        ))}
        <Polygon
          points={refPolygon}
          fill="none"
          stroke="#B0B0B0"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        {spokes.map((p, i) => (
          <Line
            key={`s${i}`}
            x1={cx}
            y1={cy}
            x2={p.x}
            y2={p.y}
            stroke="#E8E8E8"
            strokeWidth={1}
          />
        ))}
        <Polygon
          points={dataPolygon}
          fill="rgba(224,122,95,0.25)"
          stroke={colors.accent}
          strokeWidth={2}
        />
        {dataPoints.map((p, i) => (
          <Circle key={`d${i}`} cx={p.x} cy={p.y} r={3} fill={colors.accent} />
        ))}
        {nutrientKeys.map((key, i) => {
          const lp = ptOnCircle(labelRadius, i);
          const def = NUTRIENT_DEFINITIONS.find((d) => d.key === key);
          const label = def?.label ?? key;
          const anchor =
            Math.abs(lp.x - cx) < 4
              ? 'middle'
              : lp.x < cx
              ? 'end'
              : 'start';
          return (
            <SvgText
              key={`l${i}`}
              x={lp.x}
              y={lp.y}
              fontSize={labelFontSize}
              fill="#9A9A9A"
              textAnchor={anchor}
              alignmentBaseline="middle"
            >
              {label}
            </SvgText>
          );
        })}
      </Svg>
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text
          style={{
            fontSize: 20,
            fontWeight: '800',
            color: getBarColor(avgPct),
          }}
        >
          {avgPct}%
        </Text>
        <Text style={{ fontSize: 9, color: colors.textMuted }}>
          平均達成率
        </Text>
      </View>
    </View>
  );
};
