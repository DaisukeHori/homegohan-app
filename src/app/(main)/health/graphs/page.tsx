"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { addDaysToDate, todayLocal } from "@/lib/date-utils";
import { createClient } from "@/lib/supabase/client";
import { useAiConsultationReceiver, type AiConsultationRead } from "@/hooks/useAiConsultationReceiver";
import {
  buildTrendChartA11y,
  estimateSvgTextWidth,
  formatTrendAxisDate,
  getTrendAxisIndexes,
  TREND_PERIOD_LABELS,
  type TrendPeriod,
} from "@/lib/health-trend-chart-a11y";
import {
  ArrowLeft, Scale, Heart, Moon, TrendingUp, TrendingDown,
  Calendar, ChevronLeft, ChevronRight, Target
} from 'lucide-react';
import { STATUS_COLOR_TOKENS } from '@homegohan/shared';

const colors = {
  bg: '#FAF9F7',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textLight: '#4A4A4A',
  textMuted: '#9A9A9A',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  // 状態色 (#590): 塗り・枠線・アイコンは success など、文字は successText / warningText / dangerText
  ...STATUS_COLOR_TOKENS,
  purple: '#7C4DFF',
  purpleLight: '#EDE7F6',
  blue: '#2196F3',
  blueLight: '#E3F2FD',
  border: '#EEEEEE',
};

type Period = TrendPeriod;
type Metric = 'weight' | 'body_fat' | 'bp' | 'sleep';

// グラフ内の文字 (Y 軸・X 軸・目標) の大きさ。viewBox (幅 320) を 360px 幅の画面に縮めて
// 表示すると約 0.93 倍になるため、12 にして実表示でも 11px 前後を確保する (#1119)。
const CHART_FONT_SIZE = 12;

interface HealthRecord {
  record_date: string;
  weight?: number;
  body_fat_percentage?: number;
  systolic_bp?: number;
  diastolic_bp?: number;
  sleep_hours?: number;
  sleep_quality?: number;
  /** health_checkups 由来のデータかどうか */
  fromCheckup?: boolean;
}

/** 期間ごとにグラフに並べる日数 (今日 (JST の暦日) を最後の日として、この日数の暦日を並べる) */
const PERIOD_DAYS: Record<Period, number> = { week: 7, month: 30, '3months': 90, year: 365 };

/** 開いたときの期間 (useState の初期値と、最初の描画から読み込み中にする鍵の両方に使う。#2206 G1) */
const INITIAL_PERIOD: Period = 'month';
/** 期間ごとの記録の線の置き場所の鍵 (#2206 G1。対象を替えて出す表示なので期間を鍵に含める) */
const graphsKey = (period: Period) => `graphs:${period}`;
/**
 * 目標の線 (体重の目標) の置き場所の鍵 (#2206 G1。期間に依らない)。記録の鍵と分けるのは、取り直しが記録を読めず目標だけ
 * 読めたときに記録の鍵を進めない (先に始めた開いたときの読み込みの記録の線を捨てない) ため
 */
const KEY_TARGET_WEIGHT = 'targetWeight';

/** fetchData の設定 */
interface GraphsFetchOptions {
  /**
   * 記録か健診を読めなかったときに今の線を残す (Realtime の読み直し。取り直し (read.mode が 'refetch') は指定しなくても残す)。
   * 開いたとき・期間の切り替え・再読み込みは、読めた本文で線を作り、記録か健診を読めなければ線を消して失敗の知らせ
   * (loadFailedPeriod) を置く (#2227 H3)
   */
  readonly keepOnFailure?: boolean;
}

/** GET /api/health/records の本文 (使う欄だけ) */
interface RecordsBody {
  records?: HealthRecord[];
}

/** GET /api/health/checkups の本文 (使う欄だけ) */
interface CheckupsBody {
  checkups?: {
    checkup_date: string;
    weight?: number | null;
    blood_pressure_systolic?: number | null;
    blood_pressure_diastolic?: number | null;
  }[];
}

/** GET /api/health/goals の本文 (使う欄だけ) */
interface GoalsBody {
  goals?: { goal_type: string; target_value: number }[];
}

/**
 * fetch する。通信の失敗 (fetch そのものが投げた) ときは null (投げない)。
 * 3 つを Promise.all で並べて読むので、1 つが投げると読めたほかの応答まで捨てて catch に入る (#2206 G5: 目標の取得が
 * 通信の失敗で投げて、読めた記録の線を置かずに前の期間の線を新しい見出しの下に残していた)
 */
async function fetchOrNull(input: string, label: string): Promise<Response | null> {
  try {
    return await fetch(input);
  } catch (error) {
    console.error(`Failed to fetch ${label}:`, error);
    return null;
  }
}

/**
 * 2xx の応答の本文を読む。応答が無い (通信の失敗)・2xx でない・本文が壊れている (JSON として読めない) ときは null (投げない)。
 * 1 つの本文が壊れていても、ほかの読めた本文を置く (#2206 G5: 目標の本文の解析が投げて、読めた記録の線を置かずに
 * 前の期間の線を新しい見出しの下に残していた)
 */
async function readOkJson<T>(res: Response | null, label: string): Promise<T | null> {
  if (res === null || !res.ok) return null;
  try {
    const body: T = await res.json();
    return body;
  } catch (error) {
    console.error(`Failed to parse ${label}:`, error);
    return null;
  }
}

export default function HealthGraphsPage() {
  const router = useRouter();
  const [records, setRecords] = useState<HealthRecord[]>([]);
  const [period, setPeriod] = useState<Period>(INITIAL_PERIOD);
  /** いま出している期間 (描画のたびに写す)。届いた応答の期間がもう今の期間でなければ記録の線を置かない (#2206 G1) */
  const periodRef = useRef(period);
  periodRef.current = period;
  const [metric, setMetric] = useState<Metric>('weight');
  const [targetWeight, setTargetWeight] = useState<number | null>(null);
  /**
   * 記録か健診を読めなかったページの読み取り (開いたとき・期間の切り替え・再読み込み) の期間 (#2227 H3)。その期間を出している間は
   * 空のグラフ (「データがありません」) の代わりに「読み込めませんでした」と再読み込みのボタンを出す (記録が無いのと区別する)。
   * 記録の鍵 (graphsKey) に記録の線と一緒に置く (読めたら null に戻す)
   */
  const [loadFailedPeriod, setLoadFailedPeriod] = useState<Period | null>(null);
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>['channel']> | null>(null);
  // <svg aria-describedby> が参照する <desc> の id
  const chartDescId = useId();

  /**
   * 期間の健康記録・健診・目標を読む。開いたとき・期間の切り替え・Realtime・AI 相談の成功の取り直しで呼ぶ (#2206 G1)。
   * 取り直し (read.mode が 'refetch') と Realtime の読み直し (keepOnFailure) は、記録か健診を読めなかった (通信の失敗・非 2xx・
   * 本文が壊れている) ときは記録の鍵に置かない (今の線を残す)。応答は read.place の中で置く (順序・番兵・読み込み中の印の判断は
   * hook)。記録の線は置く直前にいまもその期間を出しているかを見る (期間を切り替えたあとに前の期間の応答が届いても置かない)
   */
  const fetchData = useCallback(async (read: AiConsultationRead, options: GraphsFetchOptions = {}) => {
    // 読み始めた期間 (置く鍵と、置く直前の比べに使う)
    const requestedPeriod = period;
    // 読み始めの日 = 今日 (JST の暦日) の期間の日数だけ前 (グラフの最初の日の前の日から読む)。時計は 1 回だけ読み、暦日の文字列で数える (#2227 H6)
    const startDay = addDaysToDate(todayLocal(), -PERIOD_DAYS[requestedPeriod]);

    try {
      // 3 つとも投げずに読む (どれかが通信の失敗で投げても・本文が壊れていても、読めた本文は置く。#2206 G5)。
      // 記録・健診を通信の失敗・本文の壊れで読めなかったときは、その応答が 2xx でないときと同じに扱う
      const [recordsRes, checkupsRes, goalsRes] = await Promise.all([
        fetchOrNull(`/api/health/records?start_date=${startDay}&limit=365`, 'health records'),
        fetchOrNull(`/api/health/checkups?limit=365`, 'health checkups'),
        fetchOrNull('/api/health/goals?status=active', 'health goals'),
      ]);

      const [recordsBody, checkupsBody, goalsBody] = await Promise.all([
        readOkJson<RecordsBody>(recordsRes, 'health records'),
        readOkJson<CheckupsBody>(checkupsRes, 'health checkups'),
        readOkJson<GoalsBody>(goalsRes, 'health goals'),
      ]);

      // 記録か健診を読めなかった (通信の失敗・非 2xx・本文の壊れ)
      const recordsUnread = recordsBody === null || checkupsBody === null;
      // 取り直しで記録か健診を読めなかった: 片方だけで線を作り直すと点が欠けるので、今の線を残す (記録の鍵に置かない。
      // 目標は読めていれば別の鍵に置く。#2206 G1)
      const keepShownRecords = (read.mode === 'refetch' || options.keepOnFailure === true) && recordsUnread;

      const mergedRecords: HealthRecord[] = [];

      if (recordsBody !== null) {
        for (const r of (recordsBody.records || [])) {
          mergedRecords.push(r);
        }
      }

      if (checkupsBody !== null) {
        for (const c of (checkupsBody.checkups || [])) {
          // checkup_date が期間内のものだけ
          if (c.checkup_date < startDay) continue;
          // 同じ日付がすでに health_records にあれば weight/bp のみ補完
          const existing = mergedRecords.find(r => r.record_date === c.checkup_date);
          if (existing) {
            if (c.weight != null && existing.weight == null) existing.weight = c.weight;
            if (c.blood_pressure_systolic != null && existing.systolic_bp == null) {
              existing.systolic_bp = c.blood_pressure_systolic;
              existing.diastolic_bp = c.blood_pressure_diastolic ?? undefined;
            }
          } else {
            mergedRecords.push({
              record_date: c.checkup_date,
              weight: c.weight ?? undefined,
              systolic_bp: c.blood_pressure_systolic ?? undefined,
              diastolic_bp: c.blood_pressure_diastolic ?? undefined,
              fromCheckup: true,
            });
          }
        }
      }

      // 日付降順でソート（gridsを日付昇順で表示するため reversed later in getGraphData）
      mergedRecords.sort((a, b) => b.record_date.localeCompare(a.record_date));
      // 記録は目標より先に置く (目標を読めなくても、読めた記録の線を出す。#2206 G5)。
      // ページの読み取り (開いたとき・期間の切り替え・再読み込み) で記録か健診を読めなかったときは、空のグラフでなく失敗の知らせを置く
      // (記録が無いのと区別する。前の期間の線も残さない。#2227 H3)
      if (!keepShownRecords) {
        read.place(graphsKey(requestedPeriod), () => {
          if (periodRef.current !== requestedPeriod) return;
          if (recordsUnread) {
            setRecords([]);
            setLoadFailedPeriod(requestedPeriod);
          } else {
            setRecords(mergedRecords);
            setLoadFailedPeriod(null);
          }
        });
      }

      if (goalsBody !== null) {
        const weightGoal = goalsBody.goals?.find((g) => g.goal_type === 'weight');
        // 体重の目標が無くなった (削除・達成) ときは線を消す (取り直しで前の目標の線を残さない。#2195 V1)
        read.place(KEY_TARGET_WEIGHT, () => setTargetWeight(weightGoal ? weightGoal.target_value : null));
      }
    } catch (error) {
      // 上の読み取りは投げない (fetchOrNull・readOkJson) ので、ここは思わぬ例外の受け皿 (読み込み中の表示は読み取りの終わりで下りる)
      console.error('Failed to fetch data:', error);
    }
  }, [period]);

  // AI 相談の提案の実行で健康記録・健康目標が変わったら取り直す (#2195 V1)。
  // 下の購読は健康記録・健診の行の変化だけを見るので、目標 (体重の目標の線) の変化はこちらで拾う。
  // 取り直しは描画のたびに最新の fetchData を呼ぶので、今の期間を読む。最初の描画から読み込み中 (今までの初期値 true)
  const receiver = useAiConsultationReceiver(fetchData, { initialLoadingKeys: [graphsKey(INITIAL_PERIOD)] });
  // スピナーは表示中の期間の鍵 (古い期間の読み取りの終わり・置いたことでは、今の期間の鍵は下りない)
  const loading = receiver.isLoading(graphsKey(period));
  /** 今の期間の記録か健診を読めなかった (読み込み中は出さない。#2227 H3) */
  const loadFailed = !loading && loadFailedPeriod === period;

  // 開いたとき・期間の切り替えの読み込み (読み込み中の表示を出す)。receiver の参照は一生同じなので、期間が変わったときだけ走る
  useEffect(() => {
    void receiver.read({ loadingKeys: [graphsKey(period)] }, fetchData);
  }, [receiver, fetchData, period]);

  // Realtime subscription for health_records
  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel('health-graphs-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'health_records' },
        () => { void receiver.read({}, (read) => fetchData(read, { keepOnFailure: true })); }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'health_checkups' },
        () => { void receiver.read({}, (read) => fetchData(read, { keepOnFailure: true })); }
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [fetchData, receiver]);

  // グラフデータを生成
  // #1055 UX3-13/14: 血圧は収縮期のみ描画されていたため、拡張期 (value2) も持たせて2系列描画する
  const getGraphData = (): {
    data: { date: string; value: number | null; value2?: number | null; fromCheckup?: boolean }[];
    min: number | null;
    max: number | null;
    avg: number | null;
  } => {
    if (records.length === 0) return { data: [], min: null, max: null, avg: null };

    let values: { date: string; value: number | null; value2?: number | null; fromCheckup?: boolean }[] = [];

    // 期間内の全日付 (今日 (JST の暦日) までの PERIOD_DAYS 日) を生成する。
    // 時計は 1 回だけ読み、暦日の文字列で前の日を数える (#2227 H6: 以前は期間の終わりと始まりで時計を 2 回読み、始まりから 1 日ずつ
    // 進めた日時が終わりの日時以下のあいだを並べていたので、2 回の読み取りの間に時計が 1 ms 進むと今日が期間から落ちた)
    const today = todayLocal();
    for (let daysBefore = PERIOD_DAYS[period] - 1; daysBefore >= 0; daysBefore -= 1) {
      const dateStr = addDaysToDate(today, -daysBefore);
      const record = records.find(r => r.record_date === dateStr);

      let value: number | null = null;
      let value2: number | null = null;
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
            value2 = record.diastolic_bp || null;
            break;
          case 'sleep':
            value = record.sleep_hours || null;
            break;
        }
      }
      values.push({ date: dateStr, value, value2, fromCheckup: record?.fromCheckup });
    }

    const validValues = values.filter(v => v.value !== null).map(v => v.value as number);
    const validValues2 = metric === 'bp' ? values.filter(v => v.value2 != null).map(v => v.value2 as number) : [];
    const allValues = [...validValues, ...validValues2];
    if (allValues.length === 0) return { data: values, min: null, max: null, avg: null };

    const min = Math.min(...allValues);
    const max = Math.max(...allValues);
    // 平均は主系列 (体重/体脂肪率/収縮期血圧/睡眠時間) のみで算出する
    const avg = validValues.length > 0
      ? validValues.reduce((a, b) => a + b, 0) / validValues.length
      : null;

    return { data: values, min, max, avg };
  };

  const { data: graphData, min, max, avg } = getGraphData();
  const formatStat = (v: number | null) => (v === null ? '-' : v.toFixed(1));

  // #1055 (wave-3b): 血圧は最小=拡張期/最大=収縮期/平均=収縮期の系列混在のまま
  // 無ラベルで表示されていたため、どの系列の統計かを明示する
  const statLabels = metric === 'bp'
    ? { min: '最小（拡張期）', avg: '平均（収縮期）', max: '最大（収縮期）' }
    : { min: '最小', avg: '平均', max: '最大' };

  // 変化を計算
  const getChange = () => {
    const validData = graphData.filter(d => d.value !== null);
    if (validData.length < 2) return null;
    
    const first = validData[0].value!;
    const last = validData[validData.length - 1].value!;
    return parseFloat((last - first).toFixed(2));
  };

  const change = getChange();

  // 最新値 (血圧は収縮期と拡張期)。グラフの読み上げ文に使う
  const latestValue = graphData.filter(d => d.value !== null).slice(-1)[0]?.value ?? null;
  const latestDiastolic = graphData.filter(d => d.value2 != null).slice(-1)[0]?.value2 ?? null;
  // 健診由来の点 (菱形) があるときだけ、丸/菱形の凡例を出す (#1119)。
  // 読み込み中は前の期間のデータが残っているため、凡例も出さない
  const hasCheckupPoints = graphData.some(d => d.value !== null && d.fromCheckup);
  const showCheckupLegend = hasCheckupPoints && !loading;
  // 目標との比較のカード (体重のみ)。読み込み中 (前の期間の値か、読めなかった後の空の記録が残っている)・記録を読めなかったときは出さない
  // (最新の値が無いまま、目標の値そのものを「目標まであと」として出してしまう。#2227 H3・#2235 I4)。
  // 目標体重は今までの `targetWeight &&` と同じく、null と 0 では出さない (比べ方を型で絞れる形にしただけ)
  const showTargetComparison = metric === 'weight' && targetWeight != null && targetWeight !== 0 && !loading && !loadFailed;

  // SVGグラフを描画
  const renderGraph = () => {
    if (graphData.length === 0) return null;
    if (min === null || max === null) return null;

    const width = 320;
    const height = 180;

    // スケール計算
    const range = max - min || 1;
    const yMin = min - range * 0.1;
    const yMax = max + range * 0.1;

    // Y軸ラベル (単位付き)。単位が長い血圧 (mmHg) でも左に見切れないよう、
    // ラベルの概算幅から左余白を決める (最小は従来の 40)
    const yMaxLabel = `${yMax.toFixed(1)}${currentMetric.unit}`;
    const yMinLabel = `${yMin.toFixed(1)}${currentMetric.unit}`;
    const yLabelWidth = Math.max(
      estimateSvgTextWidth(yMaxLabel, CHART_FONT_SIZE),
      estimateSvgTextWidth(yMinLabel, CHART_FONT_SIZE),
    );
    const padding = { top: 20, right: 28, bottom: 30, left: Math.max(40, Math.ceil(yLabelWidth) + 6) };
    const graphWidth = width - padding.left - padding.right;
    const graphHeight = height - padding.top - padding.bottom;

    const points: { x: number; y: number; value: number | null; fromCheckup?: boolean }[] = graphData.map((d, i) => ({
      x: padding.left + (i / (graphData.length - 1)) * graphWidth,
      y: d.value !== null
        ? padding.top + graphHeight - ((d.value - yMin) / (yMax - yMin)) * graphHeight
        : -1,
      value: d.value,
      fromCheckup: d.fromCheckup,
    }));

    // パスを生成（null値をスキップ）
    const validPoints = points.filter(p => p.y >= 0) as { x: number; y: number; value: number | null; fromCheckup?: boolean }[];
    const pathD = validPoints.length > 1
      ? `M ${validPoints.map(p => `${p.x},${p.y}`).join(' L ')}`
      : '';

    // #1055 UX3-13/14: 血圧は拡張期 (value2) も同じスケールで第2系列として描画する
    const points2 = metric === 'bp'
      ? graphData.map((d, i) => ({
          x: padding.left + (i / (graphData.length - 1)) * graphWidth,
          y: d.value2 != null
            ? padding.top + graphHeight - ((d.value2 - yMin) / (yMax - yMin)) * graphHeight
            : -1,
          fromCheckup: d.fromCheckup,
        }))
      : [];
    const validPoints2 = points2.filter(p => p.y >= 0);
    const pathD2 = validPoints2.length > 1
      ? `M ${validPoints2.map(p => `${p.x},${p.y}`).join(' L ')}`
      : '';

    // 目標ラインのY座標
    const targetY = targetWeight && metric === 'weight'
      ? padding.top + graphHeight - ((targetWeight - yMin) / (yMax - yMin)) * graphHeight
      : null;

    // #1119: <svg> を role="img" の 1 枚の画像として読み上げさせる。
    // 中の点や文字は読み上げられないため、指標・期間・最新値・最小/最大・変化を aria-label に集約する
    const chartA11y = buildTrendChartA11y({
      chartTitle,
      periodLabel: TREND_PERIOD_LABELS[period],
      unit: currentMetric.unit,
      isBloodPressure: metric === 'bp',
      latest: latestValue,
      latestDiastolic,
      min,
      max,
      change,
      startDate: graphData[0].date,
      endDate: graphData[graphData.length - 1].date,
      recordedDays: graphData.filter(d => d.value !== null).length,
      checkupDays: graphData.filter(d => d.value !== null && d.fromCheckup).length,
    });

    // X軸ラベルは先頭・中央・末尾の 3 点 (どの期間でも日付が分かるように)
    const axisIndexes = getTrendAxisIndexes(graphData.length);
    const lastAxisIndex = axisIndexes[axisIndexes.length - 1];

    return (
      <svg
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        className="overflow-visible"
        role="img"
        aria-label={chartA11y.ariaLabel}
        aria-describedby={chartDescId}
      >
        <title>{chartA11y.title}</title>
        <desc id={chartDescId}>{chartA11y.desc}</desc>
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
              x={width - padding.right + 4}
              y={targetY + 4}
              fontSize={CHART_FONT_SIZE}
              fill={colors.successText}
            >
              目標
            </text>
          </>
        )}

        {/* グラフ線 (収縮期血圧 or 体重/体脂肪率/睡眠) */}
        <path
          d={pathD}
          fill="none"
          stroke={colors.accent}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* 拡張期血圧 (血圧選択時のみ第2系列として描画) */}
        {metric === 'bp' && (
          <path
            d={pathD2}
            fill="none"
            stroke={colors.blue}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="5,3"
          />
        )}

        {/* データポイント (健診由来は菱形で区別。凡例は健診由来の点があるときだけ表示する) */}
        {validPoints.map((p, i) =>
          p.fromCheckup ? (
            <polygon
              key={i}
              points={`${p.x},${p.y - 5} ${p.x + 5},${p.y} ${p.x},${p.y + 5} ${p.x - 5},${p.y}`}
              fill={colors.purple}
              stroke={colors.card}
              strokeWidth={1.5}
            />
          ) : (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={4}
              fill={colors.card}
              stroke={colors.accent}
              strokeWidth={2}
            />
          )
        )}

        {/* 拡張期血圧のデータポイント (健診由来は主系列と同じ菱形。凡例の「菱形=健診」を系列によらず成り立たせる) */}
        {metric === 'bp' && validPoints2.map((p, i) =>
          p.fromCheckup ? (
            <polygon
              key={`d-${i}`}
              points={`${p.x},${p.y - 4.5} ${p.x + 4.5},${p.y} ${p.x},${p.y + 4.5} ${p.x - 4.5},${p.y}`}
              fill={colors.purple}
              stroke={colors.card}
              strokeWidth={1.5}
            />
          ) : (
            <circle
              key={`d-${i}`}
              cx={p.x}
              cy={p.y}
              r={3.5}
              fill={colors.card}
              stroke={colors.blue}
              strokeWidth={2}
            />
          )
        )}

        {/* Y軸ラベル (単位付き) */}
        <text x={padding.left - 5} y={padding.top + 5} fontSize={CHART_FONT_SIZE} fill={colors.textMuted} textAnchor="end">
          {yMaxLabel}
        </text>
        <text x={padding.left - 5} y={padding.top + graphHeight} fontSize={CHART_FONT_SIZE} fill={colors.textMuted} textAnchor="end">
          {yMinLabel}
        </text>

        {/* X軸ラベル (先頭・中央・末尾の日付。#1119 で 1 週間以外の期間にも表示) */}
        {axisIndexes.map((index) => (
          <text
            key={`x-${index}`}
            x={padding.left + (index / (graphData.length - 1)) * graphWidth}
            y={height - 5}
            fontSize={CHART_FONT_SIZE}
            fill={colors.textMuted}
            textAnchor={index === 0 ? 'start' : index === lastAxisIndex ? 'end' : 'middle'}
          >
            {formatTrendAxisDate(graphData[index].date, period)}
          </text>
        ))}
      </svg>
    );
  };

  // #1051 UX3-08: 「減少=緑/増加=赤」の固定意味付けは指標によって意味が逆になる
  // (例: 睡眠時間の減少は改善ではない)。指標ごとに「良い方向」を持たせる。
  // 体重のみ目標体重との大小関係で動的に決まるため null にし、後段の getChangeSentiment で判定する。
  const metricConfig: Record<Metric, { icon: typeof Scale; label: string; unit: string; color: string; goodDirection: 'up' | 'down' | null }> = {
    weight: { icon: Scale, label: '体重', unit: 'kg', color: colors.accent, goodDirection: null },
    body_fat: { icon: Scale, label: '体脂肪率', unit: '%', color: colors.purple, goodDirection: 'down' },
    bp: { icon: Heart, label: '血圧', unit: 'mmHg', color: colors.error, goodDirection: 'down' },
    sleep: { icon: Moon, label: '睡眠', unit: '時間', color: colors.blue, goodDirection: 'up' },
  };

  const currentMetric = metricConfig[metric];

  // #1055 UX3-13/14: 血圧は収縮期のみのラベルにせず両方を明示する。
  // 画面の見出しと、グラフ (<svg>) の読み上げ文で同じ言葉を使う
  const chartTitle = metric === 'bp' ? '血圧(収縮期/拡張期)の推移' : `${currentMetric.label}の推移`;

  // #1051 UX3-08: 体重は目標体重が分かっている場合のみ、目標に近づく方向を「良い」とする。
  // 目標未設定時は判定できないため中立表示にする(誤った「改善/悪化」を主張しない)。
  const getChangeSentiment = (): 'good' | 'bad' | 'neutral' => {
    if (change === null || change === 0) return 'neutral';
    let goodDirection = metricConfig[metric].goodDirection;
    if (metric === 'weight') {
      const currentValue = graphData.filter(d => d.value !== null).slice(-1)[0]?.value;
      goodDirection = (targetWeight != null && currentValue != null && currentValue !== targetWeight)
        ? (currentValue > targetWeight ? 'down' : 'up')
        : null;
    }
    if (goodDirection == null) return 'neutral';
    const actualDirection: 'up' | 'down' = change > 0 ? 'up' : 'down';
    return actualDirection === goodDirection ? 'good' : 'bad';
  };
  const changeSentiment = getChangeSentiment();
  // 矢印アイコンは塗りの色、数字は文字用の濃い色 (#590)
  const changeColors = changeSentiment === 'good'
    ? { icon: colors.success, text: colors.successText }
    : changeSentiment === 'bad'
      ? { icon: colors.error, text: colors.dangerText }
      : { icon: colors.textMuted, text: colors.textMuted };

  return (
    <div className="min-h-screen pb-24" style={{ backgroundColor: colors.bg }}>
      {/* ヘッダー */}
      <div className="sticky top-0 z-10 px-4 py-4 flex items-center" style={{ backgroundColor: colors.bg }}>
        <button onClick={() => router.back()} aria-label="戻る" className="p-2 -ml-2">
          <ArrowLeft size={24} style={{ color: colors.text }} />
        </button>
        <h1 className="font-bold ml-2" style={{ color: colors.text }}>推移グラフ</h1>
      </div>

      {/* 指標選択 (#1119: 選択中の指標を aria-pressed で支援技術に伝える) */}
      <div className="px-4 mb-4">
        {/* w-0 min-w-full: 4 つのボタンを並べた幅 (約 388px) が、親の <main> (flex アイテム) の最小幅を
            押し広げ、360px 幅の画面でページ全体が横に約 60px はみ出していた。
            幅は親と同じまま、収まらない分はこの行の中で横スクロールさせる */}
        <div role="group" aria-label="表示する指標" className="flex gap-2 overflow-x-auto pb-2 w-0 min-w-full">
          {(Object.keys(metricConfig) as Metric[]).map((m) => {
            const config = metricConfig[m];
            const Icon = config.icon;
            return (
              <motion.button
                key={m}
                whileTap={{ scale: 0.95 }}
                onClick={() => setMetric(m)}
                aria-pressed={metric === m}
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

      {/* 期間選択 (#1119: 選択中の期間を aria-pressed で支援技術に伝える) */}
      <div className="px-4 mb-4">
        <div role="group" aria-label="表示する期間" className="flex gap-2">
          {(['week', 'month', '3months', 'year'] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              aria-pressed={period === p}
              className="flex-1 py-2 rounded-lg text-sm font-medium"
              style={{
                backgroundColor: period === p ? colors.accent : colors.card,
                color: period === p ? 'white' : colors.textLight,
              }}
            >
              {TREND_PERIOD_LABELS[p]}
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
                {chartTitle}
              </p>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold" style={{ color: colors.text }}>
                  {graphData.filter(d => d.value !== null).slice(-1)[0]?.value?.toFixed(1) || '-'}
                </span>
                <span className="text-sm" style={{ color: colors.textMuted }}>
                  {currentMetric.unit}
                  {metric === 'bp' && (
                    <> / {graphData.filter(d => d.value2 != null).slice(-1)[0]?.value2?.toFixed(1) ?? '-'} {currentMetric.unit}</>
                  )}
                </span>
              </div>
            </div>
            {change !== null && (
              <div
                className="flex items-center gap-1 px-3 py-1 rounded-full"
                style={{
                  backgroundColor: changeSentiment === 'good' ? colors.successLight : changeSentiment === 'bad' ? colors.errorLight : colors.bg,
                }}
              >
                {change < 0 ? (
                  <TrendingDown size={16} style={{ color: changeColors.icon }} />
                ) : change > 0 ? (
                  <TrendingUp size={16} style={{ color: changeColors.icon }} />
                ) : null}
                <span
                  className="text-sm font-medium"
                  style={{ color: changeColors.text }}
                >
                  {change > 0 ? '+' : ''}{change} {currentMetric.unit}
                </span>
              </div>
            )}
          </div>

          {/* 凡例。
              #1055 UX3-13/14: 血圧選択時は収縮期/拡張期の線を示す。
              #1119: 健診由来の点 (菱形) があるときだけ、丸 (日々の記録) と菱形 (健診) の意味を示す */}
          {(metric === 'bp' || showCheckupLegend) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2" data-testid="trend-chart-legend">
              {metric === 'bp' && (
                <>
                  <div className="flex items-center gap-1.5">
                    <span className="w-3 h-0.5 rounded-full" style={{ backgroundColor: colors.accent }} />
                    <span className="text-xs" style={{ color: colors.textLight }}>収縮期</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-3 h-0.5 rounded-full border-t-2 border-dashed" style={{ borderColor: colors.blue }} />
                    <span className="text-xs" style={{ color: colors.textLight }}>拡張期</span>
                  </div>
                </>
              )}
              {showCheckupLegend && (
                <>
                  <div className="flex items-center gap-1.5">
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                      <circle cx="6" cy="6" r="4" fill={colors.card} stroke={colors.accent} strokeWidth={2} />
                    </svg>
                    <span className="text-xs" style={{ color: colors.textLight }}>日々の記録（丸）</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                      <polygon points="6,1 11,6 6,11 1,6" fill={colors.purple} stroke={colors.card} strokeWidth={1.5} />
                    </svg>
                    <span className="text-xs" style={{ color: colors.textLight }}>健診（菱形）</span>
                  </div>
                </>
              )}
            </div>
          )}

          {/* グラフ */}
          <div className="h-48">
            {loading ? (
              <div className="h-full flex items-center justify-center">
                <div className="animate-spin w-8 h-8 border-2 border-accent border-t-transparent rounded-full" />
              </div>
            ) : loadFailed ? (
              // 記録か健診を読めなかった: 記録が無いのと区別して知らせ、読み直せるようにする (#2227 H3)
              <div role="alert" className="h-full flex flex-col items-center justify-center gap-3">
                <p className="text-sm" style={{ color: colors.dangerText }}>
                  記録を読み込めませんでした
                </p>
                <button
                  type="button"
                  onClick={() => void receiver.read({ loadingKeys: [graphsKey(period)] }, fetchData)}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-white"
                  style={{ backgroundColor: colors.accent }}
                >
                  再読み込み
                </button>
              </div>
            ) : graphData.filter(d => d.value !== null).length > 0 ? (
              renderGraph()
            ) : (
              // #1055 UX3-36: 空状態に次アクションが無かったため、記録への導線を追加
              <div className="h-full flex flex-col items-center justify-center gap-3">
                <p className="text-sm" style={{ color: colors.textMuted }}>
                  データがありません
                </p>
                <Link
                  href="/health/record"
                  className="px-4 py-2 rounded-lg text-sm font-medium text-white"
                  style={{ backgroundColor: colors.accent }}
                >
                  今日の記録をつける
                </Link>
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
            <p className="text-xs mb-1" style={{ color: colors.textMuted }}>{statLabels.min}</p>
            <p className="text-lg font-bold" style={{ color: colors.text }}>
              {formatStat(min)}
            </p>
          </div>
          <div
            className="p-4 rounded-xl text-center"
            style={{ backgroundColor: colors.card }}
          >
            <p className="text-xs mb-1" style={{ color: colors.textMuted }}>{statLabels.avg}</p>
            <p className="text-lg font-bold" style={{ color: colors.text }}>
              {formatStat(avg)}
            </p>
          </div>
          <div
            className="p-4 rounded-xl text-center"
            style={{ backgroundColor: colors.card }}
          >
            <p className="text-xs mb-1" style={{ color: colors.textMuted }}>{statLabels.max}</p>
            <p className="text-lg font-bold" style={{ color: colors.text }}>
              {formatStat(max)}
            </p>
          </div>
        </div>
      </div>

      {/* 目標との比較（体重のみ）。読み込み中・記録を読めなかったときは出さない (showTargetComparison) */}
      {showTargetComparison && (
        <div className="px-4 mb-4">
          <div 
            className="p-4 rounded-xl"
            style={{ backgroundColor: colors.successLight }}
          >
            <div className="flex items-center gap-3">
              <Target size={24} style={{ color: colors.success }} />
              <div>
                <p className="font-medium" style={{ color: colors.successText }}>
                  目標体重: {targetWeight}kg
                </p>
                {/* #1051 UX3-08: 「あと」に符号付きの差分をそのまま出すと増量目標で
                    負の値になり意味が伝わらないため、絶対値+「目標まで」に統一する。
                    最新の値が無い (記録が 0 件) ときは差を出さない (0 との差 = 目標の値そのものになる。#2235 I4) */}
                {latestValue !== null && (
                  <p className="text-sm" style={{ color: colors.successText }}>
                    目標まであと {Math.abs(latestValue - targetWeight).toFixed(1)}kg
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
