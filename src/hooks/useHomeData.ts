/* eslint-disable react-hooks/exhaustive-deps */
import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { LIST_ORDERS, orderListBy } from "@/lib/api/list-order";
import { toAnnouncement, toPlannedMeal } from "@/lib/converter";
import { resolveDisplayName } from "@/lib/user-display";
import { shouldRefetchHomeOnAuthChange, type HomeLastReadAuthUserId } from "@/lib/home-auth-refetch";
import { addDaysToDate, calendarDaysEndingAt, pantryExpiringSoonUntil, todayLocal, WEEKDAY_LABELS_JA, PLANNED_MEALS_SET_COMPLETED_RPC, plannedMealsSetCompletedArgs } from "@homegohan/shared";
import type { Tables } from "@homegohan/shared";
import type { Announcement, PlannedMeal, PantryItem, Badge } from "@/types/domain";
import { aiFetch, isAiConsentRequiredResponse } from "@/lib/ai/consent-required";
import { aiSkippedReasonOf, type AiSkippedReason } from "@/lib/ai/consent-config";
import { useAiConsultationReceiver, type AiConsultationRead } from "@/hooks/useAiConsultationReceiver";

// 今日の献立データ
interface TodayMealPlan {
  dayId: string;
  dayDate: string;
  meals: PlannedMeal[];
}

// 日次サマリー
interface DailySummary {
  totalCalories: number;
  completedCount: number;
  totalCount: number;
  cookCount: number;
  buyCount: number;
  outCount: number;
}

// 週間統計
interface WeeklyStats {
  days: { date: string; dayOfWeek: string; cookRate: number; totalCalories: number; mealCount: number }[];
  avgCookRate: number;
  totalCookCount: number;
  totalMealCount: number;
}

// 月間統計
interface MonthlyStats {
  cookCount: number;
  totalMeals: number;
  cookRate: number;
}

// 記録の集計で読む日数 (どれも読み取りの始めに 1 回読んだ JST の今日 (today) から addDaysToDate / calendarDaysEndingAt で数える。#2235 I3・#2245 K2)
/** 連続自炊の数を数えるために読む過去の日数 (今日の 30 日前から今日まで) */
const COOKING_STREAK_LOOKBACK_DAYS = 30;
/** 週間統計・今週のベスト料理の日数 (今日を含む過去 7 日) */
const WEEKLY_STATS_DAYS = 7;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 食事の完了の切り替えの連打よけの待ち (#191/#322。今の setTimeout(…, 250) の名前付け。運用で変える値ではない) */
const MEAL_TOGGLE_DEBOUNCE_MS = 250;

/** 置き場所の鍵 (#2206 G1。docs/design/cross/26-ai-consultation-refetch-receivers.md §7.5)。readHomeData の置く場所ごとに 1 つ */
const KEY_USER = 'user';
const KEY_ACTIVITY = 'activity';
/** 今日の献立と dailySummary */
const KEY_TODAY_PLAN = 'todayPlan';
const KEY_COOKING_STREAK = 'cookingStreak';
const KEY_WEEKLY_STATS = 'weeklyStats';
const KEY_MONTHLY_STATS = 'monthlyStats';
const KEY_EXPIRING_ITEMS = 'expiringItems';
const KEY_SHOPPING_REMAINING = 'shoppingRemaining';
/** バッジの数と最新のバッジ */
const KEY_BADGE_INFO = 'badgeInfo';
const KEY_BEST_MEAL = 'bestMeal';
const KEY_HEALTH_SUMMARY = 'healthSummary';
const KEY_ANNOUNCEMENT = 'announcement';
/** 栄養の分析の点数・課題・栄養素の比べ (栄養の分析の読み込み中の鍵) */
const KEY_NUTRITION_SCORE = 'nutritionScore';
/** 栄養の分析のアドバイス・提案・aiSkipped と、今日のアドバイスの帯 (出所 'ai_advice')。AI つきの読み取りと「分析できない」だけが置く */
const KEY_NUTRITION_AI = 'nutritionAi';
/**
 * 取り直しの同意の知らせの片づけ (aiSkipped の consent_required を消すだけ。#2206 G3)。取り直しの読み取りが失敗しても置くので、
 * 点数の鍵と分ける (点数の鍵に置くと、先に始めた開いたときの分析の応答が 'superseded' で捨てられる。§6.2・S-28)。読み込み中の鍵にしない
 */
const KEY_NUTRITION_CONSENT_NOTICE = 'nutritionConsentNotice';
/** パフォーマンスの分析 (eligible・理由・次の行動・おすすめ。パフォーマンスの分析の読み込み中の鍵) */
const KEY_PERFORMANCE = 'performance';
/**
 * 今日のチェックイン。7 日の分析 (/api/performance/analyze) が非 ok でも読めたチェックインは置く (今の挙動) ので、分析の鍵と分ける
 * (§6.2・S-28)。読み込み中の鍵にしない
 */
const KEY_TODAY_CHECKIN = 'todayCheckin';
/**
 * 全画面の読み込み中の表示の鍵 (読み込み中だけの鍵。データは置かない。§6.4)。主のデータの読み取り (集計・お知らせまで) が終わったときに
 * 下りる: ページの読み取りが立て、その読み取りの終わりで下りる。取り直しは主のデータを読み終えたら何もしない apply で置いて下ろす
 */
const KEY_HOME_LOADING = 'homeLoading';

/** ホームの栄養の分析 (GET /api/ai/nutrition-analysis?period=today の結果) */
interface NutritionAnalysisState {
  score: number;
  issues: string[];
  advice: string | null;
  suggestion: any | null;
  comparison: Record<string, { actual: number; target: number; percentage: number; status: string }>;
  /** 同意が無くて (または同意の状況を読めなくて) サーバーが AI のアドバイスを省いた理由 (応答の aiSkipped。T15 / #1154) */
  aiSkipped: AiSkippedReason | null;
}

/** 栄養の分析の点数の部分 (点数・課題・栄養素の比べ。AI を付けない読み取りも置く) */
type NutritionAnalysisScoreParts = Pick<NutritionAnalysisState, 'score' | 'issues' | 'comparison'>;
/** 栄養の分析の AI の部分 (アドバイス・献立の変更の提案・AI を省いた知らせ。AI つきの読み取りだけが置く。#2201 U4) */
type NutritionAnalysisAiParts = Pick<NutritionAnalysisState, 'advice' | 'suggestion' | 'aiSkipped'>;

/** 点数の部分が無い (今日の完了した食事が無くて分析できない) */
const NO_NUTRITION_ANALYSIS_SCORE_PARTS: NutritionAnalysisScoreParts = { score: 0, issues: [], comparison: {} };
/** AI の部分が無い (今日の完了した食事が無くて分析できない) */
const NO_NUTRITION_ANALYSIS_AI_PARTS: NutritionAnalysisAiParts = { advice: null, suggestion: null, aiSkipped: null };

/** 栄養の分析が無い (まだ取っていない・今日の完了した食事が無くて分析できない) */
const NO_NUTRITION_ANALYSIS: NutritionAnalysisState = {
  ...NO_NUTRITION_ANALYSIS_SCORE_PARTS,
  ...NO_NUTRITION_ANALYSIS_AI_PARTS,
};

/** 栄養の分析の読み取り (fetchNutritionAnalysis) の決まり */
interface HomeFetchOptions {
  /**
   * 栄養の分析を、AI のアドバイス・献立の変更の提案を付けずに読み直す (点数・課題・栄養素の比べだけ。#2201 U4)。
   * 取り直し (AI 相談の成功のあと) で true: 成功のたびに LLM を 1 回呼び、上限に数えない枠の安全弁
   * ('nutrition_advice_auto'。ai_unmetered_daily_caps) を 1 回使っていたのをやめる。今日のアドバイスの帯 (suggestion) と、
   * 分析のアドバイス・提案・AI を省いた知らせ (aiSkipped) は前の値を残す (安全弁に達した aiSkipped で帯が消える道も無くなる)。
   * AI つきの読み取りの応答待ちに始めても、その応答の AI の部分は置かれる (AI の部分は鍵 KEY_NUTRITION_AI で、AI を付けない読み取りは
   * 点数を置けたときと「分析できない」のときしかこの鍵に置かない)。
   * ただし今日の完了した食事が無くなって分析できない (analysis: null) ときは、読み込み直したときと同じく分析を消し、帯は AI のアドバイスの
   * ときだけ消す (#2195 V1。活動量・献立の変更の文は分析と関係が無いので残す。#2206 G3)。
   * 取り直しは AI 相談の成功のあとなので同意済み (提案は同意を確かめたあとにしか作られない): 同意が無くて AI を省いた知らせ
   * (aiSkipped が consent_required) は、読み取りの結果によらず消す (上限 daily_limit・同意の状況を読めない check_failed は残す。#2206 G3)。
   * false (ページの読み取り: 開いたとき・ログインの状態の変化・献立の変更の実行 executeNutritionSuggestion のあと・完了の切り替えの巻き戻し) は、
   * アドバイスと提案も読み、帯に何も出ていないときだけアドバイスを置く。ページの読み取りは取り直しに追い越されても AI つきで読む (#2206 G1)
   */
  analysisWithoutAi: boolean;
}

/**
 * 分析 (栄養・パフォーマンス) を読み始める関数 (#2206 G1)。readHomeData が主のデータ (今日の献立・集計) を読んだあとに呼び、待たない
 * (fetchHomeData の Promise は分析を待たない)。today はその読み取りの今日 (読み取りの始めに 1 回読んだ JST の暦日。#2245 K2)
 */
type StartHomeAnalyses = (read: AiConsultationRead, userId: string, today: string) => void;

/** 栄養の分析の API (GET /api/ai/nutrition-analysis) の今日の分析。AI のアドバイスと献立の変更の提案を付ける (開いたとき) */
export const HOME_NUTRITION_ANALYSIS_WITH_AI_URL = '/api/ai/nutrition-analysis?period=today&includeAdvice=true&includeSuggestion=true';
/** 栄養の分析の API の今日の分析。AI を呼ばない (取り直し。点数・課題・栄養素の比べだけ。#2201 U4) */
export const HOME_NUTRITION_ANALYSIS_WITHOUT_AI_URL = '/api/ai/nutrition-analysis?period=today';

/**
 * 今日のアドバイスの帯の文の出所 (#2206 G3)。分析できなくなった取り直し (analysis: null) で消すのは AI のアドバイス ('ai_advice') だけ
 *   - 'ai_advice': 栄養の分析の AI のアドバイス (AI つきの読み取りが、帯に何も出ていないときだけ置く)
 *   - 'activity': 今日の気分・活動量を押したときの文 (updateActivityLevel)
 *   - 'menu_change': 献立の変更の実行の進み具合・結果の文 (executeNutritionSuggestion)
 */
type SuggestionBandSource = 'ai_advice' | 'activity' | 'menu_change';

/** 今日のアドバイスの帯 (文と出所。#2206 G3) */
interface SuggestionBand {
  text: string;
  source: SuggestionBandSource;
}

/** 今日の献立の集計の空の値 (開いたときの値。取り直しで今日の献立が無くなったときもこれに戻す。#2195 V1) */
const EMPTY_DAILY_SUMMARY: DailySummary = {
  totalCalories: 0,
  completedCount: 0,
  totalCount: 0,
  cookCount: 0,
  buyCount: 0,
  outCount: 0,
};

export const useHomeData = () => {
  const [user, setUser] = useState<any>(null);
  const [todayPlan, setTodayPlan] = useState<TodayMealPlan | null>(null);
  // #191/#322: meal toggle debounce — pending mealId set + MEAL_TOGGLE_DEBOUNCE_MS debounce timer
  const pendingToggleRef = useRef<Set<string>>(new Set());
  const toggleDebounceTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [dailySummary, setDailySummary] = useState<DailySummary>(EMPTY_DAILY_SUMMARY);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  // × で閉じたお知らせの id (#2206 G3)。取り直し (AI 相談の成功のたび)・ログインの状態の変化の読み込みで、同じお知らせを置き直さない
  const dismissedAnnouncementIdsRef = useRef<Set<string>>(new Set());
  /**
   * 前回のホームの読み取りが確かめた利用者の id (#2227 H3)。ログインの状態の変化の SIGNED_IN で、同じ利用者なら読み直さないために使う
   * (タブを前に戻したときの SIGNED_IN で AI つきの栄養の分析を読み直さない)。
   * 書くのは place の apply の中だけ (#2235 I2): 主のデータ (今日の献立・集計) を置けたとき (プロフィールも読めたとき) と、
   * 開いたときの読み込みがログインしていないと置いたとき。読み取りが失敗した・止めた・追い越されたときは前の値のまま
   * (覚えるのを読む前にすると、開いたときの読み込みの失敗のあとの同じ人の SIGNED_IN・止めた取り直しのあとの別の人の SIGNED_IN で読み直さない)
   */
  const lastReadAuthUserIdRef = useRef<HomeLastReadAuthUserId>(undefined);
  /**
   * readHomeData が自分で supabase.auth.setSession (syncSessionFromServer) を呼んでいる数 (#2235 I2)。auth-js の setSession は、渡した
   * access token が有効なら戻る前に SIGNED_IN を出す (その読み取りが確かめる利用者の知らせ)。この間の SIGNED_IN は読み直しに数えない
   * (同じ読み取りが続けて読むので、読み直すと AI つきの栄養の分析を 2 回読む)。読み取りが重なりうるので真偽ではなく数で持つ。
   * (今の /api/auth/session-sync は本文にトークンを入れない (#165) ので、setSession はトークンが無くて知らせを出さない。同期がトークンを
   * 返すようになっても 2 回読まないための守り)
   */
  const ownSessionSyncsRef = useRef(0);
  const [activityLevel, setActivityLevel] = useState<string | null>(null);
  /**
   * 出している今日の献立を読んだ読み取りの今日 (JST の暦日。#2245 K2)。まだ置いていなければ null。ホームの見出しの日付は
   * この日に合わせる (0 時をまたいで開いたままの画面の読み直しが新しい今日を読んだら、見出しも同じ日になる)。
   * 週の棒の今日の印・期限までの日数は、それぞれの値を置いた読み取りの今日 (weeklyStatsToday・expiringItemsToday。#2254 M2) と
   * 見出しの今日を比べて home/page.tsx が決める (weeklyBarsToday・expiringDaysToday。#2259 P2)
   */
  const [homeToday, setHomeToday] = useState<string | null>(null);
  // 今日のアドバイスの帯 (文と出所。#2206 G3)
  const [suggestionBand, setSuggestionBand] = useState<SuggestionBand | null>(null);
  const suggestion = suggestionBand?.text ?? null;
  
  // 新規追加
  const [cookingStreak, setCookingStreak] = useState(0);
  const [weeklyStats, setWeeklyStats] = useState<WeeklyStats>({
    days: [],
    avgCookRate: 0,
    totalCookCount: 0,
    totalMealCount: 0,
  });
  const [monthlyStats, setMonthlyStats] = useState<MonthlyStats>({
    cookCount: 0,
    totalMeals: 0,
    cookRate: 0,
  });
  /**
   * 週の集計 (weeklyStats) を読んだ読み取りの今日 (JST の暦日。#2254 M2)。まだ置いていなければ null。週の棒はこの日で終わる 7 日
   * (calendarDaysEndingAt)。棒の今日の印は、この日が見出しの今日 (homeToday) より前でなければこの日に付け、前なら付けない
   * (home/page.tsx の weeklyBarsToday。#2259 P2)。見出しの今日にそのまま合わせると、0 時をまたいだ取り直しで
   * 今日の献立の読み取りだけが失敗したとき、新しい日で終わる 7 日の 6 本目 (前の日) に印が付く
   */
  const [weeklyStatsToday, setWeeklyStatsToday] = useState<string | null>(null);
  const [expiringItems, setExpiringItems] = useState<PantryItem[]>([]);
  /**
   * 期限の近い食材 (expiringItems) を読んだ読み取りの今日 (JST の暦日。#2254 M2)。まだ置いていなければ null。
   * 期限までの日数は、この日と見出しの今日 (homeToday) の遅い方から数える (home/page.tsx の expiringDaysToday・laterCalendarDay。
   * #2259 P2)。見出しの今日は今日の献立を置いた読み取りの今日なので、0 時をまたいだ取り直しで今日の献立の読み取りだけが失敗すると、
   * 見出しは前の日のまま、食材は新しい日で置かれる。見出しの今日だけから数えると、残りの日数が 1 日多くなる
   */
  const [expiringItemsToday, setExpiringItemsToday] = useState<string | null>(null);
  const [shoppingRemaining, setShoppingRemaining] = useState(0);
  const [badgeCount, setBadgeCount] = useState(0);
  const [latestBadge, setLatestBadge] = useState<{ name: string; code: string; obtainedAt: string } | null>(null);
  const [bestMealThisWeek, setBestMealThisWeek] = useState<PlannedMeal | null>(null);

  // 健康記録データ
  const [healthSummary, setHealthSummary] = useState<{
    todayRecord: any | null;
    healthStreak: number;
    weightChange: number | null;
    latestWeight: number | null;
    targetWeight: number | null;
    hasAlert: boolean;
  }>({
    todayRecord: null,
    healthStreak: 0,
    weightChange: null,
    latestWeight: null,
    targetWeight: null,
    hasAlert: false,
  });

  // 栄養分析データ (読み込み中の印は持たない。返すときに receiver.isLoading(KEY_NUTRITION_SCORE) を合わせる。#2206 G1)
  const [nutritionAnalysis, setNutritionAnalysis] = useState<NutritionAnalysisState>(NO_NUTRITION_ANALYSIS);

  // Performance OS v3: パフォーマンス分析データ (読み込み中の印は返すときに receiver.isLoading(KEY_PERFORMANCE) を合わせる。#2206 G1)
  const [performanceAnalysis, setPerformanceAnalysis] = useState<{
    eligible: boolean;
    eligibilityReason: string | null;
    nextAction: { actionType: string; reason: string } | null;
    recommendations: any[];
    todayCheckin: any | null;
  }>({
    eligible: false,
    eligibilityReason: null,
    nextAction: null,
    recommendations: [],
    todayCheckin: null,
  });

  const supabase = createClient();
  // 今日 (JST の暦日) は描画の値に持たない (#2245 K2)。読み取り・書き込みのたびに todayLocal() を 1 回だけ読み、その中では同じ今日を使う
  // (描画の値を使うと、0 時をまたいで開いたままの画面の取り直し・ログインの状態の変化の読み直し・書き込みが前の日を読み書きした)

  const syncSessionFromServer = async () => {
    const syncResponse = await fetch('/api/auth/session-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      cache: 'no-store',
    });

    if (!syncResponse.ok) {
      return null;
    }

    const syncData = await syncResponse.json();
    // setSession が出す SIGNED_IN は、この読み取りの同期の知らせ (読み直さない。#2235 I2)
    ownSessionSyncsRef.current += 1;
    try {
      const synced = await supabase.auth.setSession({
        access_token: syncData.accessToken,
        refresh_token: syncData.refreshToken,
      });
      return synced.data.session?.user ?? null;
    } finally {
      ownSessionSyncsRef.current -= 1;
    }
  };

  const resolveAuthUserOnce = async () => {
    const sessionResult = await supabase.auth.getSession();
    if (sessionResult.data.session?.user) {
      return sessionResult.data.session.user;
    }

    try {
      const syncedUser = await syncSessionFromServer();
      if (syncedUser) {
        return syncedUser;
      }
    } catch (error) {
      console.error('Session sync error:', error);
    }

    const refreshResult = await supabase.auth.refreshSession();
    if (refreshResult.data.session?.user) {
      return refreshResult.data.session.user;
    }

    const userResult = await supabase.auth.getUser();
    return userResult.data.user ?? null;
  };

  const resolveAuthUser = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const user = await resolveAuthUserOnce();
      if (user) {
        return user;
      }

      if (attempt === 0) {
        await wait(300);
      }
    }

    return null;
  };

  /**
   * ホームの主のデータの読み取り (#2206 G1)。ページの読み取り (mode 'mount') と取り直し (mode 'refetch') の両方。
   * 応答は read.place(鍵, apply) の apply の中で置く (順序・番兵・書き込み中・読み込み中の印は place が見る)。
   * 取り直しの読み取りの失敗 (ログインの確かめ・プロフィール・今日の献立の読み取りのエラー) では今の表示を残す (その鍵に置かない)。
   * 主のデータ (今日の献立・集計) を読んだあとに startAnalyses で分析を読み始め、待たない
   */
  const readHomeData = async (read: AiConsultationRead, startAnalyses: StartHomeAnalyses) => {
    // この読み取りの今日 (JST の暦日。#2245 K2)。読み取りの始めに 1 回だけ時計を読み、今日の献立・記録の集計・分析はどれもこの日で読む
    const today = todayLocal();
    // 1. ユーザー情報取得
    const authUser = await resolveAuthUser();
    // 確かめた利用者は、ここでは覚えない (主のデータを置けたときに place の apply の中で覚える。#2227 H3・#2235 I2)
    
    if (authUser) {
      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('nickname, organization_id')
        .eq('id', authUser.id)
        .maybeSingle();

      if (profileError) {
        console.error('Home profile fetch error:', profileError);
      }
      
      // email local part をニックネームとして表示しない (#60)
      // resolveDisplayName に email を渡さず、nickname / user_metadata のみでフォールバック
      // 取り直しでプロフィールを読めなかったときは、今の名前を残す (#2201 U1)
      if (!(read.mode === 'refetch' && profileError)) {
        read.place(KEY_USER, () =>
          setUser({
            ...authUser,
            nickname: resolveDisplayName({
              nickname: profile?.nickname || null,
              email: null,
              userMetadata: authUser.user_metadata ?? null,
            }),
            // 所属している組織 (無ければ null)。組織チャレンジの入り口 (#1132) を、組織に所属している人にだけ出すために使う
            organizationId: profile?.organization_id ?? null,
          }),
        );
      }

      // 2. Activity Log
      const { data: activity, error: activityError } = await supabase
        .from('daily_activity_logs')
        .select('*')
        .eq('user_id', authUser.id)
        .eq('date', today)
        .maybeSingle();

      // 取り直しの応答を待つあいだに気分・活動量を押した (upsert を終えていても): 押す前に読んだ値で楽観的な表示を戻さない。
      // 書き込みが全部終わったあとに 1 回取り直す (#2201 U2。place が書き込みの窓を見る)
      if (activity && !activityError) {
        read.place(KEY_ACTIVITY, () => setActivityLevel(activity.feeling));
      }

      // 3. 今日の献立を取得（日付ベースモデル: user_daily_meals → planned_meals）
      const { data: dailyMealData, error: dailyMealError } = await supabase
        .from('user_daily_meals')
        .select(`
          id,
          day_date,
          planned_meals(*)
        `)
        .eq('day_date', today)
        .eq('user_id', authUser.id)
        .maybeSingle();

      // 取り直しの応答を待つあいだに完了の切り替え (楽観的な更新) を始めた (終えていても)・チェックインの欄を開いた:
      // 切り替えの前に読んだ今日の献立で楽観的な表示を戻さない。切り替えが全部終わった・欄を閉じたあとに 1 回取り直す (#2201 U1 + U2。
      // place が番兵と書き込みの窓を見る)。読み取りの失敗では今の表示を残す (置かない)
      if (!dailyMealError) {
        read.place(KEY_TODAY_PLAN, () => {
          // 置いた今日の献立の日 (見出しの日付はこの日に合わせる。#2245 K2。週の棒の今日の印・期限までの日数は、それぞれを置いた読み取りの今日と
          // この日を比べて home/page.tsx が決める。#2254 M2・#2259 P2)
          setHomeToday(today);
          if (dailyMealData && dailyMealData.planned_meals) {
            const mealsData = dailyMealData.planned_meals;
            const meals: PlannedMeal[] = mealsData.map((m: any) => toPlannedMeal(m));

            setTodayPlan({
              dayId: dailyMealData.id,
              dayDate: dailyMealData.day_date,
              meals,
            });

            // サマリー計算
            const summary: DailySummary = {
              totalCalories: meals.reduce((sum, m) => sum + (m.caloriesKcal || 0), 0),
              completedCount: meals.filter(m => m.isCompleted).length,
              totalCount: meals.length,
              cookCount: meals.filter(m => m.mode === 'cook' || m.mode === 'quick').length,
              buyCount: meals.filter(m => m.mode === 'buy').length,
              outCount: meals.filter(m => m.mode === 'out').length,
            };
            setDailySummary(summary);
          } else {
            // 今日の献立が無い: 前の献立を残さない (取り直しのとき。読み込み直したときと同じ。#2195 V1)
            setTodayPlan(null);
            setDailySummary(EMPTY_DAILY_SUMMARY);
          }
          // 主のデータを置けた: 読んだ利用者を覚える (#2227 H3・#2235 I2)。プロフィールを読めなかったときは覚えない
          // (開いたときは名前を代わりの値で置いている。同じ人の SIGNED_IN で読み直す側に寄せる)
          if (!profileError) lastReadAuthUserIdRef.current = authUser.id;
        });
      }

      // ========== 拡張データを並列取得（高速化） ==========
      // どれも応答は自分の鍵に read.place で置く (#2206 G1)。取り直し (mode が 'refetch') の読み取りの失敗では
      // 今の表示を残す (空・0 で上書きしない。#2201 U1)
      await Promise.all([
        fetchCookingStreak(authUser.id, read, today),
        fetchWeeklyStats(authUser.id, read, today),
        fetchMonthlyStats(authUser.id, read, today),
        fetchExpiringItems(authUser.id, read, today),
        fetchShoppingRemaining(authUser.id, read),
        fetchBadgeInfo(authUser.id, read),
        fetchBestMealThisWeek(authUser.id, read, today),
        fetchHealthSummary(authUser.id, read, today),
      ]);

      // 栄養の分析とパフォーマンスの分析を読み始める (待たない)。取り直しに追い越されたページの読み取りも自分で読む
      // (分析は鍵が分かれているので、古い応答は place が置かない。#2206 G1)
      startAnalyses(read, authUser.id, today);
    } else if (read.mode === 'mount') {
      // 取り直しでログインを確かめられなかったときは、今の表示を残す (#2201 U1。ログアウトはログインの状態の変化の読み込みが反映する)。
      // ログインしていないと置けたときに覚える (#2227 H3・#2235 I2。追い越されたときは前の値のまま。取り直しでログインを確かめられなかったときは覚えた値を変えない)
      read.place(KEY_USER, () => {
        setUser(null);
        lastReadAuthUserIdRef.current = null;
      });
    }

    // 11. Announcements (ログインを確かめられなくても読む)
    await fetchAnnouncement(read);

    // 取り直しは主のデータを読み終えたら全画面の読み込み中の表示を下ろす (開いたときの読み込みの応答待ちに始まった取り直しが先に終われば、
    // その時点で下りる)。投げた・止めた取り直しは下ろさず、立てたページの読み取りの終わりで下りる (§6.4)
    if (read.mode === 'refetch') read.place(KEY_HOME_LOADING, () => undefined);
  };

  /** お知らせ (#2206 G3 の閉じたお知らせの id を見るのも apply の中) */
  const fetchAnnouncement = async (read: AiConsultationRead) => {
    try {
      const annRes = await fetch('/api/announcements?mode=public');
      if (!annRes.ok) return;
      const annData = await annRes.json();
      if (!(annData.announcements && annData.announcements.length > 0)) return;
      const nextAnnouncement = toAnnouncement(annData.announcements[0]);
      read.place(KEY_ANNOUNCEMENT, () => {
        // × で閉じたお知らせは置き直さない (#2206 G3。取り直しは AI 相談の成功のたびに来る)
        if (!dismissedAnnouncementIdsRef.current.has(nextAnnouncement.id)) setAnnouncement(nextAnnouncement);
      });
    } catch (e) {
      console.error("Announcement fetch error", e);
    }
  };

  // 連続自炊ストリーク（完了した自炊のみカウント）
  // read は呼んだ読み取り (readHomeData)。応答は自分の鍵に read.place で置く。下の記録の集計の取得も同じ (#2206 G1。古い応答を置かない)
  const fetchCookingStreak = async (userId: string, read: AiConsultationRead, today: string) => {
    try {
      // 過去30日分のデータを取得（日付ベースモデル）。JST の今日 (today) から暦の計算だけでずらす (#2235 I3。時計を読み直さない)
      const thirtyDaysAgo = addDaysToDate(today, -COOKING_STREAK_LOOKBACK_DAYS);
      
      const { data: daysData } = await supabase
        .from('user_daily_meals')
        .select(`
          day_date,
          planned_meals(mode, is_completed)
        `)
        .eq('user_id', userId)
        .gte('day_date', thirtyDaysAgo)
        .lte('day_date', today)
        .order('day_date', { ascending: false });

      type DayWithStreakMeals = { day_date: string; planned_meals: Pick<Tables<"planned_meals">, "mode" | "is_completed">[] };
      // 記録の無い期間も 0 を置く (取り直しで前の連続の日数を残さない。読み込み直したときと同じ。#2195 V1)
      if (daysData) {
        let streak = 0;
        const sortedDays = (daysData as DayWithStreakMeals[]).sort((a, b) =>
          new Date(b.day_date).getTime() - new Date(a.day_date).getTime()
        );

        for (const day of sortedDays) {
          const meals = day.planned_meals || [];
          // 完了した自炊のみカウント
          const hasCompletedCookMeal = meals.some((m) =>
            (m.mode === 'cook' || m.mode === 'quick' || !m.mode) && m.is_completed
          );
          
          if (hasCompletedCookMeal) {
            streak++;
          } else if (day.day_date < today) {
            // 今日以前で完了した自炊がない日があったらストリーク終了
            break;
          }
        }
        read.place(KEY_COOKING_STREAK, () => setCookingStreak(streak));
      }
    } catch (e) {
      console.error('Streak fetch error:', e);
    }
  };

  // 週間統計（日付ベースモデル）
  const fetchWeeklyStats = async (userId: string, read: AiConsultationRead, today: string) => {
    try {
      // 今日を含む過去 7 日 (#2235 I3)。JST の今日 (today) から暦の計算だけで並べる。日ごとに new Date() を読むと、
      // 0 時をまたぐ瞬間に日が飛ぶか重なり、端末のローカル時刻で日をずらすと夏時間の切り替えの日に 1 時間ずれる
      const weekCells = calendarDaysEndingAt(today, WEEKLY_STATS_DAYS);
      
      const { data: daysData } = await supabase
        .from('user_daily_meals')
        .select(`
          day_date,
          planned_meals(mode, is_completed, calories_kcal)
        `)
        .eq('user_id', userId)
        .gte('day_date', weekCells[0].date)
        .lte('day_date', today)
        .order('day_date');

      if (daysData) {
        const days: WeeklyStats['days'] = [];
        let totalCook = 0;
        let totalMeals = 0;

        // 7日分のデータを作成（データがない日も含む）
        for (const cell of weekCells) {
          const dateStr = cell.date;
          
          type DayWithMeals = { day_date: string; planned_meals: Pick<Tables<"planned_meals">, "mode" | "is_completed" | "calories_kcal">[] };
          const dayData = (daysData as DayWithMeals[]).find((dd) => dd.day_date === dateStr);
          const meals = dayData?.planned_meals || [];
          const completedMeals = meals.filter((m) => m.is_completed);
          const cookMeals = completedMeals.filter((m) => m.mode === 'cook' || m.mode === 'quick');
          
          const mealCount = completedMeals.length;
          const cookRate = mealCount > 0 ? Math.round((cookMeals.length / mealCount) * 100) : 0;
          const totalCalories = meals.reduce((sum: number, m) => sum + (m.calories_kcal || 0), 0);
          
          days.push({
            date: dateStr,
            // 曜日は暦の計算で読む (#2235 I3。new Date(dateStr).getDay() は UTC の 0 時を端末のローカル時刻で読むので、UTC より西では前の日の曜日になる)
            dayOfWeek: WEEKDAY_LABELS_JA[cell.dayOfWeek],
            cookRate,
            totalCalories,
            mealCount,
          });
          
          totalCook += cookMeals.length;
          totalMeals += mealCount;
        }

        const weekly: WeeklyStats = {
          days,
          avgCookRate: totalMeals > 0 ? Math.round((totalCook / totalMeals) * 100) : 0,
          totalCookCount: totalCook,
          totalMealCount: totalMeals,
        };
        read.place(KEY_WEEKLY_STATS, () => {
          setWeeklyStats(weekly);
          // 7 日を終えた今日 (棒の今日の印は、この日が見出しの今日より前でなければこの日に付け、前なら付けない。
          // home/page.tsx の weeklyBarsToday。#2254 M2・#2259 P2)
          setWeeklyStatsToday(today);
        });
      }
    } catch (e) {
      console.error('Weekly stats fetch error:', e);
    }
  };

  // 月間統計（日付ベースモデル、完了した自炊のみカウント）
  const fetchMonthlyStats = async (userId: string, read: AiConsultationRead, today: string) => {
    try {
      // JST の今日 (today) の月の 1 日 (#2235 I3)。端末のローカル時刻の月で 1 日にすると、端末のタイムゾーンが日本でないときに
      // 月の変わり目の前後で別の月・別の日になる
      const [thisYear, thisMonth] = today.split('-');
      const firstOfMonth = `${thisYear}-${thisMonth}-01`;
      
      const { data: daysData } = await supabase
        .from('user_daily_meals')
        .select(`
          day_date,
          planned_meals(mode, is_completed)
        `)
        .eq('user_id', userId)
        .gte('day_date', firstOfMonth)
        .lte('day_date', today);

      if (daysData) {
        let cookCount = 0;
        let totalMeals = 0;

        type DayWithMonthlyMeals = { day_date: string; planned_meals: Pick<Tables<"planned_meals">, "mode" | "is_completed">[] };
        (daysData as DayWithMonthlyMeals[]).forEach((day) => {
          const meals = day.planned_meals || [];
          // 完了した食事のみカウント
          const completedMeals = meals.filter((m) => m.is_completed);
          totalMeals += completedMeals.length;
          // 完了した自炊（mode='cook', 'quick', またはnull）をカウント
          const completedCookMeals = completedMeals.filter((m) =>
            m.mode === 'cook' || m.mode === 'quick' || !m.mode
          );
          cookCount += completedCookMeals.length;
        });

        const monthly: MonthlyStats = {
          cookCount,
          totalMeals,
          cookRate: totalMeals > 0 ? Math.round((cookCount / totalMeals) * 100) : 0,
        };
        read.place(KEY_MONTHLY_STATS, () => setMonthlyStats(monthly));
      }
    } catch (e) {
      console.error('Monthly stats fetch error:', e);
    }
  };

  // 冷蔵庫の期限切れ間近 (今日から PANTRY_EXPIRING_SOON_DAYS 日後の期限まで。全画面共通の範囲 #1602)
  const fetchExpiringItems = async (userId: string, read: AiConsultationRead, today: string) => {
    try {
      const { data } = await orderListBy(
        supabase
          .from('pantry_items')
          .select('*')
          .eq('user_id', userId)
          .lte('expiration_date', pantryExpiringSoonUntil(today))
          .gte('expiration_date', today),
        LIST_ORDERS.pantryItemsByExpiration,
      );

      if (data) {
        const items: PantryItem[] = data.map((item: any) => ({
          id: item.id,
          userId: item.user_id,
          name: item.name,
          amount: item.amount,
          category: item.category,
          expirationDate: item.expiration_date,
          addedAt: item.added_at,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
        }));
        read.place(KEY_EXPIRING_ITEMS, () => {
          setExpiringItems(items);
          // 食材を絞った今日 (期限までの日数は、この日と見出しの今日の遅い方から数える。home/page.tsx の expiringDaysToday。#2254 M2・#2259 P2)
          setExpiringItemsToday(today);
        });
      }
    } catch (e) {
      console.error('Expiring items fetch error:', e);
    }
  };

  // 買い物リスト残数（日付ベースモデル）
  // read.mode が 'refetch' (AI 相談の成功の取り直し) なら、残りの数を読めなかったときは今の数を残す (#2201 U1)。下のバッジ・今週のベスト料理・
  // 健康記録サマリーも同じ (開いたときの読み取りの失敗はこれまでどおり)
  const fetchShoppingRemaining = async (userId: string, read: AiConsultationRead) => {
    try {
      // アクティブな買い物リストを取得
      const { data: shoppingList, error: shoppingListError } = await supabase
        .from('shopping_lists')
        .select('id')
        .eq('user_id', userId)
        .eq('status', 'active')
        .maybeSingle();

      if (shoppingList) {
        const { count, error: countError } = await supabase
          .from('shopping_list_items')
          .select('*', { count: 'exact', head: true })
          .eq('shopping_list_id', shoppingList.id)
          .eq('is_checked', false);

        if (!(read.mode === 'refetch' && countError)) read.place(KEY_SHOPPING_REMAINING, () => setShoppingRemaining(count || 0));
      } else if (!shoppingListError) {
        // 使っている買い物リストが無い: 前の残りの数を残さない (取り直しのとき。読み込み直したときと同じ。#2195 V1)。
        // 読み取りの失敗では今の表示を残す
        read.place(KEY_SHOPPING_REMAINING, () => setShoppingRemaining(0));
      }
    } catch (e) {
      console.error('Shopping remaining fetch error:', e);
    }
  };

  // バッジ情報
  // バッジの数と最新のバッジは 1 つの鍵 (KEY_BADGE_INFO) に、両方を読んでから 1 回で置く (#2206 G1。§6.2)
  const fetchBadgeInfo = async (userId: string, read: AiConsultationRead) => {
    try {
      // バッジ総数
      const { count, error: countError } = await supabase
        .from('user_badges')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);

      // 最新バッジ (読めなかったときは data が null で、最新のバッジは置かない)
      const { data: latestData, error: latestError } = await orderListBy(
        supabase
          .from('user_badges')
          .select(`
          obtained_at,
          badges(name, code)
        `)
          .eq('user_id', userId),
        LIST_ORDERS.homeLatestBadge,
      )
        .limit(1)
        .maybeSingle();

      // 取り直しでどちらかを読めなかったときは、今の数と最新のバッジを残す (「0個獲得」に落とさない。#2201 U1)。
      // 一部だけを置くと、先に始めた開いたときの読み取りの応答をこの鍵で古くする (#2206 G1。§6.2)
      if (read.mode === 'refetch' && (countError || latestError)) return;

      type LatestBadgeRow = { obtained_at: string | null; badges: Pick<Tables<"badges">, "name" | "code"> | Pick<Tables<"badges">, "name" | "code">[] | null };
      const badgesRaw = latestData ? (latestData as unknown as LatestBadgeRow).badges : null;
      const badge = badgesRaw ? (Array.isArray(badgesRaw) ? badgesRaw[0] : badgesRaw) : null;
      read.place(KEY_BADGE_INFO, () => {
        setBadgeCount(count || 0);
        // 最新のバッジは読めたときだけ置く (無いときは今の表示を残す。今までどおり)
        if (latestData && badge) {
          setLatestBadge({
            name: badge.name,
            code: badge.code,
            obtainedAt: latestData.obtained_at,
          });
        }
      });
    } catch (e) {
      console.error('Badge info fetch error:', e);
    }
  };

  // 今週のベスト料理（日付ベースモデル）
  const fetchBestMealThisWeek = async (userId: string, read: AiConsultationRead, today: string) => {
    try {
      // 今日を含む過去 7 日の最初の日 (#2235 I3。JST の今日 (today) から暦の計算だけでずらす)
      const sevenDaysAgo = addDaysToDate(today, -(WEEKLY_STATS_DAYS - 1));
      
      const bestMealQuery = supabase
        .from('planned_meals')
        .select(`
          *,
          user_daily_meals!inner(
            day_date,
            user_id
          )
        `)
        .eq('user_daily_meals.user_id', userId)
        .gte('user_daily_meals.day_date', sevenDaysAgo)
        .eq('is_completed', true)
        .not('image_url', 'is', null)
        // 行は toPlannedMeal (引数は any) に渡すだけなので、結果の型を行の形に置き換える。select の結合の型のまま
        // orderListBy に渡すと、型の展開が深くなりすぎて tsc が止まる (TS2589)
        .returns<Record<string, unknown>[]>();
      const { data, error } = await orderListBy<typeof bestMealQuery>(bestMealQuery, LIST_ORDERS.homeBestVegMeal).limit(1);

      // 当てはまる食事が無くなった (AI 相談で消した・完了を外した) ときは消す。取り直し (refetch。AI 相談の成功のあと) で
      // 前の食事を残さない (#2195 V1)。ただし取り直しで読めなかったときは、今の食事を残す (#2201 U1)
      if (!(read.mode === 'refetch' && error)) {
        const bestMeal = data && data.length > 0 ? toPlannedMeal(data[0]) : null;
        read.place(KEY_BEST_MEAL, () => setBestMealThisWeek(bestMeal));
      }
    } catch (e) {
      console.error('Best meal fetch error:', e);
    }
  };

  // 健康記録サマリー
  const fetchHealthSummary = async (userId: string, read: AiConsultationRead, today: string) => {
    try {
      // 今日の記録
      const { data: todayRecord, error: todayRecordError } = await supabase
        .from('health_records')
        .select('*')
        .eq('user_id', userId)
        .eq('record_date', today)
        .maybeSingle();

      // 連続記録
      const { data: streak, error: streakError } = await supabase
        .from('health_streaks')
        .select('current_streak')
        .eq('user_id', userId)
        .eq('streak_type', 'daily_record')
        .maybeSingle();

      // 最新の体重と昨日の体重
      const { data: recentWeights, error: recentWeightsError } = await supabase
        .from('health_records')
        .select('weight, record_date')
        .eq('user_id', userId)
        .not('weight', 'is', null)
        .order('record_date', { ascending: false })
        .limit(2);

      let weightChange = null;
      let latestWeight = null;
      if (recentWeights && recentWeights.length > 0) {
        latestWeight = recentWeights[0].weight;
        if (recentWeights.length > 1) {
          weightChange = parseFloat((recentWeights[0].weight - recentWeights[1].weight).toFixed(2));
        }
      }

      // 目標体重
      const { data: weightGoal, error: weightGoalError } = await supabase
        .from('health_goals')
        .select('target_value')
        .eq('user_id', userId)
        .eq('goal_type', 'weight')
        .eq('status', 'active')
        .maybeSingle();

      // アラートがあるか確認
      const { count: alertCount, error: alertCountError } = await supabase
        .from('health_insights')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('is_alert', true)
        .eq('is_dismissed', false);

      // 取り直しでどれかを読めなかったときは、今のまとめを残す (#2201 U1。一部だけを空・0 にして、「今日の記録をつけよう」の帯や
      // 体重の「-」を出さない)
      if (read.mode === 'refetch' && (todayRecordError || streakError || recentWeightsError || weightGoalError || alertCountError)) return;
      read.place(KEY_HEALTH_SUMMARY, () =>
        setHealthSummary({
          todayRecord,
          healthStreak: streak?.current_streak || 0,
          weightChange,
          latestWeight,
          targetWeight: weightGoal?.target_value || null,
          hasAlert: (alertCount || 0) > 0,
        }),
      );
    } catch (e) {
      console.error('Health summary fetch error:', e);
    }
  };

  // 栄養分析（ページの読み取りは AI のアドバイス付き。取り直しは AI を呼ばずに点数・課題だけ。#2201 U4）
  // 応答は鍵ごとに read.place で置く (#2206 G1。古い読み取りの応答は place が置かない):
  //   - 点数の部分 (点数・課題・栄養素の比べ) は KEY_NUTRITION_SCORE (栄養の分析の読み込み中の鍵)
  //   - AI の部分 (アドバイス・提案・aiSkipped) と今日のアドバイスの帯は KEY_NUTRITION_AI。AI つきの読み取りが置き、AI を付けない読み取りは
  //     「分析できない」で点数を置けたときだけ消す (AI を付けない取り直しを AI つきの読み取りの応答待ちに始めても、AI つきの読み取りの
  //     AI の部分は置ける)
  // 読み取りの失敗・使えない結果では何も置かない (今の分析を残す。読み込み中の印は、立てたページの読み取りの終わりで hook が下ろす)
  const fetchNutritionAnalysis = async (read: AiConsultationRead, { analysisWithoutAi }: HomeFetchOptions) => {
    try {
      const response = await fetch(analysisWithoutAi ? HOME_NUTRITION_ANALYSIS_WITHOUT_AI_URL : HOME_NUTRITION_ANALYSIS_WITH_AI_URL);
      // 点数の鍵に置かないので、先に始めた読み取り (開いたとき) の応答は置ける (S-28)
      if (!response.ok) return;
      const data = await response.json();

      if (data.success && data.analysis) {
        read.place(KEY_NUTRITION_SCORE, () =>
          setNutritionAnalysis(prev => ({
            ...prev,
            score: data.analysis.score || 0,
            issues: data.analysis.issues || [],
            comparison: data.analysis.comparison || {},
          })),
        );
        // AI の部分は AI つきの読み取りだけが置く。取り直し (AI を付けない) は、アドバイス・提案・aiSkipped と今日のアドバイスの帯の
        // 前の値を残す (AI を呼んでいないので、応答の advice / suggestion は空。#2201 U4)
        if (!analysisWithoutAi) {
          read.place(KEY_NUTRITION_AI, () => {
            setNutritionAnalysis(prev => ({
              ...prev,
              advice: data.advice || null,
              suggestion: data.suggestion || null,
              aiSkipped: aiSkippedReasonOf(data),
            }));
            // AIアドバイスをsuggestに設定 (帯に何も出ていないときだけ。置く時点の帯を見る。#2206 G3)
            if (data.advice) {
              const advice: string = data.advice;
              setSuggestionBand(prev => prev ?? { text: advice, source: 'ai_advice' });
            }
          });
        }
      } else if (data.success) {
        // 今日の完了した食事が無くて分析できない (analysis: null)。前の分析 (点数・課題・アドバイス) を残さない
        // (AI 相談で今日の食事を消した・完了を外したあとの取り直し。読み込み直したときと同じ。#2195 V1)
        const scorePlaced = read.place(KEY_NUTRITION_SCORE, () => {
          setNutritionAnalysis(prev => ({ ...prev, ...NO_NUTRITION_ANALYSIS_SCORE_PARTS }));
          if (analysisWithoutAi) {
            // 取り直しでは帯の AI のアドバイスも消す (分析する食事が無いので、読み込み直しても AI のアドバイスは出ない)。
            // 活動量・献立の変更の文は分析と関係が無いので残す (#2206 G3)
            setSuggestionBand(prev => (prev?.source === 'ai_advice' ? null : prev));
          }
        });
        // AI の部分を消すのは、点数を置けた ('placed') ときか、AI つきの読み取りのとき (自分の AI の鍵の順序で) だけ。取り直しの点数が
        // 新しい読み取りに追い越されて置けなかったのに AI の部分だけを消すと、新しい点数の横でアドバイスだけが消える (#2206 G1)。
        // 消すのは同じ読み取りの世代としてなので、それより前に始めた AI つきの読み取りの応答 (まだ分析できたときのアドバイス・提案) は
        // あとから届いても置かれない
        if (scorePlaced === 'placed' || !analysisWithoutAi) {
          read.place(KEY_NUTRITION_AI, () => setNutritionAnalysis(prev => ({ ...prev, ...NO_NUTRITION_ANALYSIS_AI_PARTS })));
        }
      }
    } catch (e) {
      console.error('Nutrition analysis fetch error:', e);
    } finally {
      // 取り直し (AI を付けない) は AI 相談の成功のあとで同意済み: 読み取りの結果によらず、同意が無くて AI を省いた知らせ
      // (consent_required) だけを消す (残すと読み込み直すまで「同意すると表示されます」が出たまま。上限 daily_limit・同意の状況を
      // 読めない check_failed は残す。#2206 G3)。点数の鍵と読み込み中の印に触れない専用の鍵に置く (§6.2。取り直しの失敗が、
      // 先に始めた開いたときの分析の応答を 'superseded' にしない)
      if (analysisWithoutAi) {
        read.place(KEY_NUTRITION_CONSENT_NOTICE, () =>
          setNutritionAnalysis(prev => (prev.aiSkipped === 'consent_required' ? { ...prev, aiSkipped: null } : prev)),
        );
      }
    }
  };

  // Performance OS v3: パフォーマンス分析を取得
  // ホームのデータの取得 (readHomeData) とチェックインの保存のあとに読む。今日のチェックイン (KEY_TODAY_CHECKIN) と 7 日の分析
  // (KEY_PERFORMANCE) を別の鍵に置く (#2206 G1。§6.2・S-28)。分析の応答 (ok・非 ok) が届いたあとにチェックインを置き、
  // 分析の読み取りが投げたときはどちらも置かない。分析が非 ok のときは分析の鍵に置かない (今の分析を残してチェックインだけ置く)。
  // 取り直しで今日のチェックインを読めなかったときは、今のチェックインを残す (#2201 U1。チェックイン済みの表示を未記入に戻さない)
  const fetchPerformanceAnalysis = async (userId: string, read: AiConsultationRead, today: string) => {
    try {
      // 今日のチェックインを取得
      const { data: todayCheckin, error: todayCheckinError } = await supabase
        .from('user_performance_checkins')
        .select('*')
        .eq('user_id', userId)
        .eq('checkin_date', today)
        .maybeSingle();

      // 7日分析を取得
      const response = await fetch(`/api/performance/analyze?date=${today}`);

      if (response.ok) {
        const data = await response.json();

        read.place(KEY_PERFORMANCE, () =>
          setPerformanceAnalysis(prev => ({
            ...prev,
            eligible: data.eligible || false,
            eligibilityReason: data.eligibilityReason || null,
            nextAction: data.analysis?.nextAction || null,
            recommendations: data.analysis?.recommendations || [],
          })),
        );
      }
      if (!(read.mode === 'refetch' && todayCheckinError)) {
        read.place(KEY_TODAY_CHECKIN, () => setPerformanceAnalysis(prev => ({ ...prev, todayCheckin })));
      }
    } catch (e) {
      console.error('Performance analysis fetch error:', e);
    }
  };

  /**
   * AI 相談の成功の取り直し (#2195 V1・#2201 U1 + U4・#2206 G1)。読み込み直したときと同じ表示にする。ただし栄養の分析は AI を呼ばずに
   * 点数・課題だけ読み直し、今日のアドバイスの帯は残す (成功のたびの LLM の費用と安全弁の消費をやめる)。分析は同じ取り直しの読み取りで
   * 読み始める。読み込み中の印は立てず、読み取りの失敗では今の表示を残す。体調のチェックインの欄が開いている間 (入力の部品がある間)・
   * 書き込みの窓 (食事の完了の切り替え・今日の気分・活動量・チェックインの保存・献立の変更の実行) の間に届いた応答は置かず、閉じた・
   * 終わったあとに 1 回取り直す (place が見る)
   */
  const refetchHome = (read: AiConsultationRead) =>
    readHomeData(read, (refetchRead, userId, today) => {
      void fetchNutritionAnalysis(refetchRead, { analysisWithoutAi: true });
      void fetchPerformanceAnalysis(userId, refetchRead, today);
    });
  // 最初の描画から全画面の読み込み中 (今の loading の初期値 true。分析の 2 つは今も初期値 false なので入れない)
  const receiver = useAiConsultationReceiver(refetchHome, { initialLoadingKeys: [KEY_HOME_LOADING] });
  const loading = receiver.isLoading(KEY_HOME_LOADING);

  /**
   * ページの読み取り: 開いたとき・ログインの状態の変化 (HOME_REFETCH_AUTH_EVENTS の 3 つだけ。#2206 G3。SIGNED_IN は
   * shouldRefetchHomeOnAuthChange の条件で読み直す: 自分で setSession している間は数えない・前回読んだ利用者がまだ無い・
   * セッションに利用者が無い・前回と違う。#2227 H3・#2235 I2)・完了の切り替えの巻き戻し・
   * 献立の変更の実行のあと。全画面の読み込み中の表示を主のデータの読み取りの終わりまで出す。
   * 分析は分析ごとに別のページの読み取りで始める (AI つき。読み込み中の印は分析の鍵で、分析を置くか分析の読み取りが終わるまで)。
   * 返す Promise は分析を待たない
   */
  const fetchHomeData = () =>
    receiver.read({ loadingKeys: [KEY_HOME_LOADING] }, (read) =>
      readHomeData(read, (_mainRead, userId, today) => {
        void receiver.read({ loadingKeys: [KEY_NUTRITION_SCORE] }, (analysisRead) =>
          fetchNutritionAnalysis(analysisRead, { analysisWithoutAi: false }),
        );
        void receiver.read({ loadingKeys: [KEY_PERFORMANCE] }, (analysisRead) => fetchPerformanceAnalysis(userId, analysisRead, today));
      }),
    );
  /**
   * 最新の描画の fetchHomeData (#2245 K2)。ログインの状態の変化の購読 (下の useEffect([])) は最初の描画で 1 回だけ作るので、
   * 関数を直に呼ぶと最初の描画の閉包を呼び続ける。購読からはこの ref を通して呼ぶ
   */
  const fetchHomeDataRef = useRef(fetchHomeData);
  fetchHomeDataRef.current = fetchHomeData;

  // Performance OS v3: 30秒チェックインを保存
  const submitPerformanceCheckin = async (checkinData: {
    sleepHours?: number;
    sleepQuality?: number;
    fatigue?: number;
    focus?: number;
    hunger?: number;
    trainingLoadRpe?: number;
    trainingMinutes?: number;
    weight?: number;
    note?: string;
  }) => {
    // このチェックインの今日 (JST の暦日。#2245 K2)。保存・健康記録への同期・保存のあとの分析の読み直しは、どれもこの日で行う
    const today = todayLocal();
    try {
      const { data: { user: authUser } } = await supabase.auth.getUser();
      if (!authUser) return { success: false, error: 'Not authenticated' };

      // 書き込みの窓 (#2206 G1。チェックインの upsert と健康記録への同期の POST の間)。この間に来た AI 相談の成功では取り直さず、
      // 終わったら 1 回取り直す。モバイルの読み込み直しも止まる (html[data-ai-consultation-writes])
      const endWrite = receiver.beginWrite();
      try {
        const { data, error } = await supabase
          .from('user_performance_checkins')
          .upsert({
            user_id: authUser.id,
            checkin_date: today,
            sleep_hours: checkinData.sleepHours,
            sleep_quality: checkinData.sleepQuality,
            fatigue: checkinData.fatigue,
            focus: checkinData.focus,
            hunger: checkinData.hunger,
            training_load_rpe: checkinData.trainingLoadRpe,
            training_minutes: checkinData.trainingMinutes,
            weight: checkinData.weight,
            note: checkinData.note,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'user_id,checkin_date' })
          .select()
          .single();

        if (error) {
          console.error('Checkin save error:', error);
          return { success: false, error: error.message };
        }

        // 30秒チェックインの睡眠データを health_records に明示的にマッピングして同期する。
        // マッピング仕様:
        //   sleepHours   → health_records.sleep_hours  (睡眠時間)
        //   sleepQuality → health_records.sleep_quality (睡眠の質 1-5)
        //   fatigue / focus / hunger は health_records には書き込まない
        //     (疲労度・集中力・空腹感は user_performance_checkins 専用の指標であり、
        //      health_records.mood_score / overall_condition とは別概念のため誤マッピングを防止)
        const hasSleepData =
          checkinData.sleepHours !== undefined ||
          checkinData.sleepQuality !== undefined;
        if (hasSleepData) {
          try {
            await fetch('/api/health/records/quick', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                record_date: today,
                ...(checkinData.sleepHours !== undefined && { sleep_hours: checkinData.sleepHours }),
                ...(checkinData.sleepQuality !== undefined && { sleep_quality: checkinData.sleepQuality }),
                // mood_score は意図的に送信しない (sleep_quality が mood に誤マッピングされるのを防ぐ)
              }),
            });
          } catch (syncErr) {
            // 健康記録への同期失敗はチェックイン自体の成否には影響させない
            console.warn('Health record sync after checkin failed:', syncErr);
          }
        }

        // チェックイン後に分析を再取得（非同期で実行し、フィードバック表示をブロックしない。ページの読み取り。#2206 G1）
        void receiver.read({ loadingKeys: [KEY_PERFORMANCE] }, (read) => fetchPerformanceAnalysis(authUser.id, read, today));

        return { success: true, data };
      } finally {
        endWrite();
      }
    } catch (e) {
      console.error('Checkin submit error:', e);
      return { success: false, error: 'Unknown error' };
    }
  };

  // AIが提案した献立変更を実行
  const executeNutritionSuggestion = async () => {
    // suggestionがなくても、issuesがあれば献立変更を提案
    const suggestion = nutritionAnalysis.suggestion;
    const issues = nutritionAnalysis.issues || [];
    
    if (!suggestion && issues.length === 0) {
      setSuggestionBand({ text: '現在提案できる献立変更はありません。', source: 'menu_change' });
      return;
    }
    
    try {
      // suggestionがある場合はそれを使用、なければissuesから生成。日付の無い提案は、押したときの今日 (JST の暦日を 1 回だけ読む。#2245 K2)
      const today = todayLocal();
      let targetDate = today;
      let targetMealType = 'dinner';
      let prompt = '';
      
      if (suggestion) {
        targetDate = suggestion.targetDate || today;
        targetMealType = suggestion.targetMeal || 'dinner';
        const dishes = suggestion.suggestedDishes || [];
        const dishNames = dishes.map((d: any) => d.name).join('、');
        prompt = suggestion.currentIssue 
          ? `${suggestion.currentIssue}を解決するために${dishNames ? `、${dishNames}を含めた` : ''}バランスの良い献立に変更してください。`
          : `栄養バランスを改善する献立に変更してください。`;
      } else {
        // issuesから自動生成
        prompt = `${issues[0]}。この問題を解決するバランスの良い献立に変更してください。`;
      }
      
      setSuggestionBand({ text: '献立を変更中...', source: 'menu_change' });

      // 書き込みの窓 (#2206 G1。献立の変更の POST の送信の間)。この間に来た AI 相談の成功では取り直さず、終わったら 1 回取り直す。
      // モバイルの読み込み直しも止まる (html[data-ai-consultation-writes])。変更のあとの読み直し (fetchHomeData) はページの読み取り
      let response: Response;
      const endWrite = receiver.beginWrite();
      try {
        response = await aiFetch('/api/ai/nutrition-analysis', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetDate,
            targetMealType,
            prompt,
          }),
        });
      } finally {
        endWrite();
      }
      
      // 同意が必要で止められた (T15 / #1154): 同意画面 (AiConsentRequiredHost) が案内するので、失敗の表示は出さない
      if (await isAiConsentRequiredResponse(response)) {
        setSuggestionBand(null);
        return;
      }

      if (response.ok) {
        // 成功したらデータを再取得
        await fetchHomeData();
        setSuggestionBand({ text: '🎉 献立を変更しました！', source: 'menu_change' });
      } else {
        const errorData = await response.json().catch(() => ({}));
        setSuggestionBand({ text: `変更に失敗しました: ${errorData.error || 'エラーが発生しました'}`, source: 'menu_change' });
      }
    } catch (e) {
      console.error('Execute nutrition suggestion error:', e);
      setSuggestionBand({ text: '変更に失敗しました。もう一度お試しください。', source: 'menu_change' });
    }
  };

  // 食事完了をトグル (Bug-10: 楽観的UI更新 + 失敗時ロールバック, #191/#322: debounce MEAL_TOGGLE_DEBOUNCE_MS)
  const toggleMealCompletion = async (mealId: string, currentStatus: boolean) => {
    // #322: MEAL_TOGGLE_DEBOUNCE_MS debounce — 既存タイマーをキャンセルして再スケジュール
    const existingTimer = toggleDebounceTimerRef.current.get(mealId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      toggleDebounceTimerRef.current.delete(mealId);
    }

    // #191: 同一 mealId の PATCH が進行中なら無視（連打対策）
    if (pendingToggleRef.current.has(mealId)) return;

    // debounce: MEAL_TOGGLE_DEBOUNCE_MS 後に実際の処理を実行
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        toggleDebounceTimerRef.current.delete(mealId);
        resolve();
      }, MEAL_TOGGLE_DEBOUNCE_MS);
      toggleDebounceTimerRef.current.set(mealId, timer);
    });

    // debounce 待機後、再度 pending チェック（待機中に別のリクエストが始まった可能性）
    if (pendingToggleRef.current.has(mealId)) return;
    pendingToggleRef.current.add(mealId);
    // 書き込みの窓 (#2201 U2・#2206 G1。楽観的な更新から RPC の応答まで)
    const endWrite = receiver.beginWrite();
    try {
      const newStatus = !currentStatus;

      // 楽観的UI更新
      setTodayPlan(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          meals: prev.meals.map(m =>
            m.id === mealId
              ? { ...m, isCompleted: newStatus, completedAt: newStatus ? new Date().toISOString() : null }
              : m
          ),
        };
      });

      // サマリー更新（completedCount を即時反映 → 進捗 % が即更新）
      setDailySummary(prev => ({
        ...prev,
        completedCount: newStatus
          ? Math.min(prev.completedCount + 1, prev.totalCount)
          : Math.max(prev.completedCount - 1, 0),
      }));

      // DB更新 (完了は RPC。completed_at は DB が決める。#2025)
      const { error } = await supabase.rpc(PLANNED_MEALS_SET_COMPLETED_RPC, plannedMealsSetCompletedArgs(mealId, newStatus));

      if (error) {
        console.error('Toggle completion error:', error);
        // ロールバック: 楽観的更新を元に戻す
        setTodayPlan(prev => {
          if (!prev) return prev;
          return {
            ...prev,
            meals: prev.meals.map(m =>
              m.id === mealId
                ? { ...m, isCompleted: currentStatus, completedAt: currentStatus ? m.completedAt : null }
                : m
            ),
          };
        });
        setDailySummary(prev => ({
          ...prev,
          completedCount: newStatus
            ? Math.max(prev.completedCount - 1, 0)
            : Math.min(prev.completedCount + 1, prev.totalCount),
        }));
        // 念のためリフェッチでサーバー真値に同期
        void fetchHomeData();
      }
    } finally {
      // #191: PATCH 完了後に pending を解除
      pendingToggleRef.current.delete(mealId);
      // 書き込みの間に止めた AI 相談の成功を 1 回取り直す (#2201 U2。全部の切り替えが終わったとき。RPC が投げても印を下ろす)
      endWrite();
    }
  };

  // #322: debounce timer cleanup on unmount (メモリリーク防止)
  useEffect(() => {
    const timers = toggleDebounceTimerRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  useEffect(() => {
    void fetchHomeData();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      // SIGNED_IN・SIGNED_OUT・USER_UPDATED (HOME_REFETCH_AUTH_EVENTS) で読み直す (INITIAL_SESSION・TOKEN_REFRESHED では読まない。#2206 G3)。SIGNED_OUT・USER_UPDATED は毎回。
      // SIGNED_IN はタブを前に戻したときにも同じ人で来ることがあるので、shouldRefetchHomeOnAuthChange の条件で読み直す (#2227 H3):
      // ホームの読み取りが自分で setSession している間の SIGNED_IN は、その読み取りの同期の知らせなので数えない (#2235 I2)。
      // それ以外は、前回読んだ利用者がまだ無い・セッションに利用者が無い・前回と違うときに読み直す
      if (shouldRefetchHomeOnAuthChange(event, session?.user.id, lastReadAuthUserIdRef.current, ownSessionSyncsRef.current > 0)) {
        void fetchHomeDataRef.current();
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const updateActivityLevel = async (level: string) => {
    if (!user) return;
    // 今日の気分・活動量の書き込みの窓 (楽観的な更新から upsert の応答まで。#2201 U2・#2206 G1):
    // この間に来た AI 相談の成功では取り直さず、終わったら 1 回取り直す。取り直しの応答を待つあいだに押したときも、その応答
    // (押す前に読んだ気分・活動量) を置かない (readHomeData は気分・活動量を read.place で置き、place が書き込みの窓を見る)
    // 押したときの今日 (JST の暦日を 1 回だけ読む。#2245 K2)
    const today = todayLocal();
    const endWrite = receiver.beginWrite();
    try {
      setActivityLevel(level);

      await supabase
        .from('daily_activity_logs')
        .upsert({
          user_id: user.id,
          date: today,
          feeling: level,
        }, { onConflict: 'user_id, date' });
    } finally {
      // upsert が投げても印を下ろす
      endWrite();
    }

    // AIサジェスト生成
    if (level === 'rest') {
      setSuggestionBand({ text: "今日は運動量が少なめです。夕食の炭水化物を半分にして調整しましょう。", source: 'activity' });
    } else if (level === 'active') {
      setSuggestionBand({ text: "ナイスワークアウト！夕食でタンパク質を多めに摂り、筋肉の回復を促しましょう。", source: 'activity' });
    } else if (level === 'stressed') {
      setSuggestionBand({ text: "ストレスを感じているときは、ビタミンB群を含む食材がおすすめです。", source: 'activity' });
    } else {
      setSuggestionBand(null);
    }
  };

  // お知らせの × (#2206 G3)。閉じたお知らせの id を覚え、取り直しで置き直さない
  const dismissAnnouncement = () => {
    if (announcement) dismissedAnnouncementIdsRef.current.add(announcement.id);
    setAnnouncement(null);
  };

  // 今日のアドバイスの帯の ×
  const dismissSuggestion = () => setSuggestionBand(null);

  return {
    user,
    // 出している今日の献立を読んだ今日 (JST の暦日。まだ置いていなければ null。#2245 K2)
    today: homeToday,
    todayPlan,
    loading,
    dailySummary,
    announcement,
    activityLevel,
    suggestion,
    // 新規追加
    cookingStreak,
    weeklyStats,
    // 週の集計を読んだ今日 (週の棒の 7 日はこの日で終わる。棒の今日の印は、この日が見出しの今日より前でなければこの日に付け、前なら付けない
    // (home/page.tsx の weeklyBarsToday。#2259 P2)。まだ置いていなければ null。#2254 M2)
    weeklyStatsToday,
    monthlyStats,
    expiringItems,
    // 期限の近い食材を読んだ今日 (期限までの日数は、この日と見出しの今日の遅い方から数える (home/page.tsx の expiringDaysToday。#2259 P2)。
    // まだ置いていなければ null。#2254 M2)
    expiringItemsToday,
    shoppingRemaining,
    badgeCount,
    latestBadge,
    bestMealThisWeek,
    healthSummary,
    // 読み込み中の印は鍵ごとに hook が持つ (#2206 G1。分析を置くか、立てたページの読み取りが終わるまで)
    nutritionAnalysis: { ...nutritionAnalysis, loading: receiver.isLoading(KEY_NUTRITION_SCORE) },
    // Performance OS v3
    performanceAnalysis: { ...performanceAnalysis, loading: receiver.isLoading(KEY_PERFORMANCE) },
    // 関数
    toggleMealCompletion,
    updateActivityLevel,
    dismissAnnouncement,
    dismissSuggestion,
    executeNutritionSuggestion,
    submitPerformanceCheckin,
  };
};
