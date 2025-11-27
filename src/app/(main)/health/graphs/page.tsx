"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  ArrowLeft, Scale, Heart, Moon, TrendingUp, TrendingDown,
  Calendar, ChevronLeft, ChevronRight, Target
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
  error: '#F44336',
  purple: '#7C4DFF',
  purpleLight: '#EDE7F6',
  blue: '#2196F3',
  blueLight: '#E3F2FD',
  border: '#EEEEEE',
};

type Period = 'week' | 'month' | '3months' | 'year';
type Metric = 'weight' | 'body_fat' | 'bp' | 'sleep';

interface HealthRecord {
  record_date: string;
  weight?: number;
  body_fat_percentage?: number;
  systolic_bp?: number;
  diastolic_bp?: number;
  sleep_hours?: number;
  sleep_quality?: number;
}

export default function HealthGraphsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<HealthRecord[]>([]);
  const [period, setPeriod] = useState<Period>('month');
  const [metric, setMetric] = useState<Metric>('weight');
  const [targetWeight, setTargetWeight] = useState<number | null>(null);

  useEffect(() => {
    fetchData();
  }, [period]);

  const fetchData = async () => {
    setLoading(true);
    
    // 期間に応じた日数を計算
    const days = period === 'week' ? 7 : period === 'month' ? 30 : period === '3months' ? 90 : 365;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    try {
      const res = await fetch(`/api/health/records?start_date=${startDate.toISOString().split('T')[0]}&limit=365`);
      if (res.ok) {
        const data = await res.json();
        setRecords(data.records || []);
      }

      // 目標体重を取得
      const goalsRes = await fetch('/api/health/goals?status=active');
      if (goalsRes.ok) {
        const goalsData = await goalsRes.json();
        const weightGoal = goalsData.goals?.find((g: any) => g.goal_type === 'weight');
        if (weightGoal) {
          setTargetWeight(weightGoal.target_value);
        }
      }
    } catch (error) {
      console.error('Failed to fetch data:', error);
    }
    setLoading(false);
  };

  // グラフデータを生成
  const getGraphData = () => {
    if (records.length === 0) return { data: [], min: 0, max: 100, avg: 0 };

    let values: { date: string; value: number | null }[] = [];
    
    // 期間内の全日付を生成
    const days = period === 'week' ? 7 : period === 'month' ? 30 : period === '3months' ? 90 : 365;
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days + 1);
    
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      const record = records.find(r => r.record_date === dateStr);
      
      let value: number | null = null;
      if (record) {
        switch (metric) {
          case 'weight':
            value = record.weight || null;
            break;
          case 'body_fat':
            value = record.body_fat_percentage || null;
            break;
          case 'bp':
            value = record.systolic_bp || null;
            break;
          case 'sleep':
            value = record.sleep_hours || null;
            break;
        }
      }
      values.push({ date: dateStr, value });
    }

    const validValues = values.filter(v => v.value !== null).map(v => v.value as number);
    if (validValues.length === 0) return { data: values, min: 0, max: 100, avg: 0 };

    const min = Math.min(...validValues);
    const max = Math.max(...validValues);
    const avg = validValues.reduce((a, b) => a + b, 0) / validValues.length;

    return { data: values, min, max, avg };
  };

  const { data: graphData, min, max, avg } = getGraphData();

  // 変化を計算
  const getChange = () => {
    const validData = graphData.filter(d => d.value !== null);
    if (validData.length < 2) return null;
    
    const first = validData[0].value!;
    const last = validData[validData.length - 1].value!;
    return parseFloat((last - first).toFixed(2));
  };

  const change = getChange();

  // SVGグラフを描画
  const renderGraph = () => {
    if (graphData.length === 0) return null;

    const width = 320;
    const height = 180;
    const padding = { top: 20, right: 20, bottom: 30, left: 40 };
    const graphWidth = width - padding.left - padding.right;
    const graphHeight = height - padding.top - padding.bottom;

    // スケール計算
    const range = max - min || 1;
    const yMin = min - range * 0.1;
    const yMax = max + range * 0.1;

    const points: { x: number; y: number; value: number | null }[] = graphData.map((d, i) => ({
      x: padding.left + (i / (graphData.length - 1)) * graphWidth,
      y: d.value !== null
        ? padding.top + graphHeight - ((d.value - yMin) / (yMax - yMin)) * graphHeight
        : -1,
      value: d.value,
    }));

    // パスを生成（null値をスキップ）
    const validPoints = points.filter(p => p.y >= 0);
    const pathD = validPoints.length > 1
      ? `M ${validPoints.map(p => `${p.x},${p.y}`).join(' L ')}`
      : '';

    // 目標ラインのY座標
    const targetY = targetWeight && metric === 'weight'
      ? padding.top + graphHeight - ((targetWeight - yMin) / (yMax - yMin)) * graphHeight
      : null;

    return (
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
        {/* グリッド線 */}
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
          <line
            key={ratio}
            x1={padding.left}
            y1={padding.top + graphHeight * ratio}
            x2={width - padding.right}
            y2={padding.top + graphHeight * ratio}
            stroke={colors.border}
            strokeDasharray="4,4"
          />
        ))}

        {/* 目標ライン */}
        {targetY !== null && targetY >= padding.top && targetY <= padding.top + graphHeight && (
          <>
            <line
              x1={padding.left}
              y1={targetY}
              x2={width - padding.right}
              y2={targetY}
              stroke={colors.success}
              strokeWidth={2}
              strokeDasharray="6,4"
            />
            <text
              x={width - padding.right + 5}
              y={targetY + 4}
              fontSize={10}
              fill={colors.success}
            >
              目標
            </text>
          </>
        )}

        {/* グラフ線 */}
        <path
          d={pathD}
          fill="none"
          stroke={colors.accent}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* データポイント */}
        {validPoints.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={4}
            fill={colors.card}
            stroke={colors.accent}
            strokeWidth={2}
          />
        ))}

        {/* Y軸ラベル */}
        <text x={padding.left - 5} y={padding.top + 5} fontSize={10} fill={colors.textMuted} textAnchor="end">
          {yMax.toFixed(1)}
        </text>
        <text x={padding.left - 5} y={padding.top + graphHeight} fontSize={10} fill={colors.textMuted} textAnchor="end">
          {yMin.toFixed(1)}
        </text>

        {/* X軸ラベル */}
        {period === 'week' && graphData.length > 0 && (
          <>
            <text x={padding.left} y={height - 5} fontSize={10} fill={colors.textMuted}>
              {graphData[0].date.slice(5)}
            </text>
            <text x={width - padding.right} y={height - 5} fontSize={10} fill={colors.textMuted} textAnchor="end">
              {graphData[graphData.length - 1].date.slice(5)}
            </text>
          </>
        )}
      </svg>
    );
  };

  const metricConfig = {
    weight: { icon: Scale, label: '体重', unit: 'kg', color: colors.accent },
    body_fat: { icon: Scale, label: '体脂肪率', unit: '%', color: colors.purple },
    bp: { icon: Heart, label: '血圧', unit: 'mmHg', color: colors.error },
    sleep: { icon: Moon, label: '睡眠', unit: '時間', color: colors.blue },
  };

  const currentMetric = metricConfig[metric];

  return (
    <div className="min-h-screen pb-24" style={{ backgroundColor: colors.bg }}>
      {/* ヘッダー */}
      <div className="sticky top-0 z-10 px-4 py-4 flex items-center" style={{ backgroundColor: colors.bg }}>
        <button onClick={() => router.back()} className="p-2 -ml-2">
          <ArrowLeft size={24} style={{ color: colors.text }} />
        </button>
        <h1 className="font-bold ml-2" style={{ color: colors.text }}>推移グラフ</h1>
      </div>

      {/* 指標選択 */}
      <div className="px-4 mb-4">
        <div className="flex gap-2 overflow-x-auto pb-2">
          {(Object.keys(metricConfig) as Metric[]).map((m) => {
            const config = metricConfig[m];
            const Icon = config.icon;
            return (
              <motion.button
                key={m}
                whileTap={{ scale: 0.95 }}
                onClick={() => setMetric(m)}
                className="flex items-center gap-2 px-4 py-2 rounded-full whitespace-nowrap"
                style={{
                  backgroundColor: metric === m ? config.color : colors.card,
                  color: metric === m ? 'white' : colors.textLight,
                }}
              >
                <Icon size={16} />
                <span className="text-sm font-medium">{config.label}</span>
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* 期間選択 */}
      <div className="px-4 mb-4">
        <div className="flex gap-2">
          {(['week', 'month', '3months', 'year'] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className="flex-1 py-2 rounded-lg text-sm font-medium"
              style={{
                backgroundColor: period === p ? colors.accent : colors.card,
                color: period === p ? 'white' : colors.textLight,
              }}
            >
              {p === 'week' ? '1週間' : p === 'month' ? '1ヶ月' : p === '3months' ? '3ヶ月' : '1年'}
            </button>
          ))}
        </div>
      </div>

      {/* グラフカード */}
      <div className="px-4 mb-4">
        <div 
          className="p-4 rounded-2xl"
          style={{ backgroundColor: colors.card }}
        >
          {/* サマリー */}
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm" style={{ color: colors.textMuted }}>
                {currentMetric.label}の推移
              </p>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold" style={{ color: colors.text }}>
                  {graphData.filter(d => d.value !== null).slice(-1)[0]?.value?.toFixed(1) || '-'}
                </span>
                <span className="text-sm" style={{ color: colors.textMuted }}>
                  {currentMetric.unit}
                </span>
              </div>
            </div>
            {change !== null && (
              <div 
                className="flex items-center gap-1 px-3 py-1 rounded-full"
                style={{ 
                  backgroundColor: change < 0 ? colors.successLight : change > 0 ? '#FFEBEE' : colors.bg,
                }}
              >
                {change < 0 ? (
                  <TrendingDown size={16} style={{ color: colors.success }} />
                ) : change > 0 ? (
                  <TrendingUp size={16} style={{ color: colors.error }} />
                ) : null}
                <span 
                  className="text-sm font-medium"
                  style={{ color: change < 0 ? colors.success : change > 0 ? colors.error : colors.textMuted }}
                >
                  {change > 0 ? '+' : ''}{change} {currentMetric.unit}
                </span>
              </div>
            )}
          </div>

          {/* グラフ */}
          <div className="h-48">
            {loading ? (
              <div className="h-full flex items-center justify-center">
                <div className="animate-spin w-8 h-8 border-2 border-accent border-t-transparent rounded-full" />
              </div>
            ) : graphData.filter(d => d.value !== null).length > 0 ? (
              renderGraph()
            ) : (
              <div className="h-full flex items-center justify-center">
                <p className="text-sm" style={{ color: colors.textMuted }}>
                  データがありません
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 統計カード */}
      <div className="px-4 mb-4">
        <div className="grid grid-cols-3 gap-3">
          <div 
            className="p-4 rounded-xl text-center"
            style={{ backgroundColor: colors.card }}
          >
            <p className="text-xs mb-1" style={{ color: colors.textMuted }}>最小</p>
            <p className="text-lg font-bold" style={{ color: colors.text }}>
              {min.toFixed(1)}
            </p>
          </div>
          <div 
            className="p-4 rounded-xl text-center"
            style={{ backgroundColor: colors.card }}
          >
            <p className="text-xs mb-1" style={{ color: colors.textMuted }}>平均</p>
            <p className="text-lg font-bold" style={{ color: colors.text }}>
              {avg.toFixed(1)}
            </p>
          </div>
          <div 
            className="p-4 rounded-xl text-center"
            style={{ backgroundColor: colors.card }}
          >
            <p className="text-xs mb-1" style={{ color: colors.textMuted }}>最大</p>
            <p className="text-lg font-bold" style={{ color: colors.text }}>
              {max.toFixed(1)}
            </p>
          </div>
        </div>
      </div>

      {/* 目標との比較（体重のみ） */}
      {metric === 'weight' && targetWeight && (
        <div className="px-4 mb-4">
          <div 
            className="p-4 rounded-xl"
            style={{ backgroundColor: colors.successLight }}
          >
            <div className="flex items-center gap-3">
              <Target size={24} style={{ color: colors.success }} />
              <div>
                <p className="font-medium" style={{ color: colors.success }}>
                  目標体重: {targetWeight}kg
                </p>
                <p className="text-sm" style={{ color: colors.success }}>
                  あと {((graphData.filter(d => d.value !== null).slice(-1)[0]?.value || 0) - targetWeight).toFixed(1)}kg
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

