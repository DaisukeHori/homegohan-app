/* eslint-disable react-hooks/exhaustive-deps */
import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { LIST_ORDERS, orderListBy } from "@/lib/api/list-order";
import { toAnnouncement, toPlannedMeal } from "@/lib/converter";
import { resolveDisplayName } from "@/lib/user-display";
import { formatLocalDate, pantryExpiringSoonUntil, PLANNED_MEALS_SET_COMPLETED_RPC, plannedMealsSetCompletedArgs } from "@homegohan/shared";
import type { Tables } from "@homegohan/shared";
import type { Announcement, PlannedMeal, PantryItem, Badge } from "@/types/domain";
import { aiFetch, isAiConsentRequiredResponse } from "@/lib/ai/consent-required";
import { aiSkippedReasonOf, type AiSkippedReason } from "@/lib/ai/consent-config";
import {
  useAiConsultationFetchStream,
  useAiConsultationLoading,
  useAiConsultationPendingWrites,
  type AiConsultationFetchTicket,
  type AiConsultationStreamTicket,
} from "@/hooks/useAiConsultationDataRefetch";

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

// Helper: 曜日を取得
const getDayOfWeek = (dateStr: string): string => {
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  return days[new Date(dateStr).getDay()];
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** ホームの栄養の分析 (GET /api/ai/nutrition-analysis?period=today の結果) */
interface NutritionAnalysisState {
  score: number;
  issues: string[];
  advice: string | null;
  suggestion: any | null;
  comparison: Record<string, { actual: number; target: number; percentage: number; status: string }>;
  /** 同意が無くて (または同意の状況を読めなくて) サーバーが AI のアドバイスを省いた理由 (応答の aiSkipped。T15 / #1154) */
  aiSkipped: AiSkippedReason | null;
  loading: boolean;
}

/** 栄養の分析が無い (まだ取っていない・今日の完了した食事が無くて分析できない) */
const NO_NUTRITION_ANALYSIS: NutritionAnalysisState = {
  score: 0,
  issues: [],
  advice: null,
  suggestion: null,
  comparison: {},
  aiSkipped: null,
  loading: false,
};

/** ホームのデータの取得 (fetchHomeData) の決まり */
interface HomeFetchOptions {
  /**
   * 栄養の分析を、AI のアドバイス・献立の変更の提案を付けずに読み直す (点数・課題・栄養素の比べだけ。#2201 U4)。
   * 取り直し (refetch。AI 相談の成功のあと) で true: 成功のたびに LLM を 1 回呼び、上限に数えない枠の安全弁
   * ('nutrition_advice_auto'。ai_unmetered_daily_caps) を 1 回使っていたのをやめる。今日のアドバイスの帯 (suggestion) と、
   * 分析のアドバイス・提案・AI を省いた知らせ (aiSkipped) は前の値を残す (安全弁に達した aiSkipped で帯が消える道も無くなる)。
   * ただし今日の完了した食事が無くなって分析できない (analysis: null) ときは、読み込み直したときと同じく分析と帯を消す (#2195 V1)。
   * false (初めの読み込み・ログインの状態の変化・献立の変更の実行 executeNutritionSuggestion のあと・開いたときの読み込みの役を
   * 引き継いだ取り直し (refetchReadMode が 'mount'。#2201 U1)) は、アドバイスと提案も読み、帯に何も出ていないときだけアドバイスを置く
   */
  analysisWithoutAi: boolean;
}

/** 開いたとき・ログインの状態の変化などの読み込み (読み込み中の表示を出す) か、AI 相談の成功の取り直し (出さない・失敗では今の表示を残す) か */
type HomeFetchMode = 'mount' | 'refetch';

/** 栄養の分析の API (GET /api/ai/nutrition-analysis) の今日の分析。AI のアドバイスと献立の変更の提案を付ける (開いたとき) */
export const HOME_NUTRITION_ANALYSIS_WITH_AI_URL = '/api/ai/nutrition-analysis?period=today&includeAdvice=true&includeSuggestion=true';
/** 栄養の分析の API の今日の分析。AI を呼ばない (取り直し。点数・課題・栄養素の比べだけ。#2201 U4) */
export const HOME_NUTRITION_ANALYSIS_WITHOUT_AI_URL = '/api/ai/nutrition-analysis?period=today';

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
  // 開いたとき・ログインの状態の変化などの読み込み中の表示。その読み込み中に始まった AI 相談の成功の取り直しは、その読み込みの役
  // (読み取りの失敗の扱い・読み込み中の表示を下ろす) を引き継ぐ (#2201 U1。useAiConsultationLoading)
  const { loading, setLoading, refetchReadMode } = useAiConsultationLoading();
  // #191/#322: meal toggle debounce — pending mealId set + 250ms debounce timer
  const pendingToggleRef = useRef<Set<string>>(new Set());
  // 食事の完了の切り替えの楽観的な更新から RPC の応答まで (#2201 U2)。ページが AI 相談の取り直しの hook に渡す: この間に来た
  // AI 相談の成功では取り直さず、全部終わったら 1 回取り直す (切り替えの前の献立を読んだ取り直しの応答が楽観的な表示を戻さないため)
  const aiConsultationWrites = useAiConsultationPendingWrites();
  // ホームのデータの取得の流れ (#2201 U1)。今日の献立・利用者・記録の集計 (連続自炊・週と月の統計・期限切れ間近・買い物リストの残り・
  // バッジ・今週のベストごはん・健康の記録)・お知らせの応答を置くのは最後に始めた取得だけ
  // (開いたときの読み込みと取り直し、続けて来た取り直しの応答が逆の順に届いても、古い応答で上書きしない)
  const homeFetchStream = useAiConsultationFetchStream();
  // パフォーマンスの分析の読み取りの流れ (ホームのデータの取得とチェックインの保存のあと。#2201 U1)
  const performanceAnalysisStream = useAiConsultationFetchStream();
  // 栄養の分析の読み取りの流れ (ホームのデータの取得のあと。#2201 U1)。応答を置くのは最後に始めた読み取りだけ
  // (続けて来た取り直し・開いたときの読み込みと取り直しの栄養の分析の応答が逆の順に届いても、古い点数・課題・アドバイスと
  // 今日のアドバイスの帯で上書きしない。読み込み中の印もあとの読み取りが下ろす)
  const nutritionAnalysisStream = useAiConsultationFetchStream();
  const toggleDebounceTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [dailySummary, setDailySummary] = useState<DailySummary>(EMPTY_DAILY_SUMMARY);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [activityLevel, setActivityLevel] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  
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
  const [expiringItems, setExpiringItems] = useState<PantryItem[]>([]);
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

  // 栄養分析データ
  const [nutritionAnalysis, setNutritionAnalysis] = useState<NutritionAnalysisState>(NO_NUTRITION_ANALYSIS);

  // Performance OS v3: パフォーマンス分析データ
  const [performanceAnalysis, setPerformanceAnalysis] = useState<{
    eligible: boolean;
    eligibilityReason: string | null;
    nextAction: { actionType: string; reason: string } | null;
    recommendations: any[];
    todayCheckin: any | null;
    loading: boolean;
  }>({
    eligible: false,
    eligibilityReason: null,
    nextAction: null,
    recommendations: [],
    todayCheckin: null,
    loading: false,
  });

  const supabase = createClient();
  const todayStr = formatLocalDate(new Date());

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
    const synced = await supabase.auth.setSession({
      access_token: syncData.accessToken,
      refresh_token: syncData.refreshToken,
    });

    return synced.data.session?.user ?? null;
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
   * mode が 'refetch' (AI 相談の成功の取り直し。#2201 U1) なら、読み込み中の表示を出さずに読み直し、読み取りの失敗
   * (ログインの確かめ・プロフィール・今日の献立の読み取りのエラー) では今の表示を残す。
   * 応答を置くのは最後に始めた取得 (homeFetchStream) だけ (開いたときの読み込みと取り直しが重なっても古い応答で上書きしない)。
   * refetchTicket は AI 相談の成功の取り直しの札 (useAiConsultationDataRefetch が渡す。#2201 U1 + U2)。取り直しでは応答を待つあいだも
   * 今日の献立 (完了の切り替えのボタン) が出ているので、その間に切り替えを始めていたら (終えていても)・体調のチェックインの欄を
   * 開いていたら、今日の献立を置かない (札の deferIfHeld。切り替えが終わった・欄を閉じたあとに 1 回取り直す)
   */
  const fetchHomeData = async (
    options: HomeFetchOptions = { analysisWithoutAi: false },
    mode: HomeFetchMode = 'mount',
    refetchTicket?: AiConsultationFetchTicket,
  ) => {
    // 取り直しの札は取り直しの扱いの回にだけ渡す (開いたときの読み込みの役を引き継いだ回は、応答を置く時点の番兵を見ずに置く)
    const order = homeFetchStream.begin(mode === 'refetch' ? refetchTicket : null);
    if (mode === 'mount') setLoading(true);
    try {
      await readHomeData(options, mode, order);
    } finally {
      // 最後に始めた取得が終わったら (途中で投げても) 読み込み中の表示を下ろす。開いたときの読み込み中に始まった取り直しが投げると、
      // 開いたときの読み込みは最後でないので下ろさず、読み込み中の表示のまま止まるため
      if (order.isLatest()) setLoading(false);
    }
  };

  /**
   * fetchHomeData の読み取りの中身 (読み込み中の表示は fetchHomeData が決める)。
   * 応答を置く前に、order (取得の流れの札) で最後に始めた取得かを見る (今日の献立は order.place で、応答を置く時点の番兵も見る)
   */
  const readHomeData = async (options: HomeFetchOptions, mode: HomeFetchMode, order: AiConsultationStreamTicket) => {
    const { isLatest } = order;
    // 1. ユーザー情報取得
    const authUser = await resolveAuthUser();
    
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
      if (isLatest() && !(mode === 'refetch' && profileError)) setUser({
        ...authUser,
        nickname: resolveDisplayName({
          nickname: profile?.nickname || null,
          email: null,
          userMetadata: authUser.user_metadata ?? null,
        }),
        // 所属している組織 (無ければ null)。組織チャレンジの入り口 (#1132) を、組織に所属している人にだけ出すために使う
        organizationId: profile?.organization_id ?? null,
      });

      // 2. Activity Log
      const { data: activity } = await supabase
        .from('daily_activity_logs')
        .select('*')
        .eq('user_id', authUser.id)
        .eq('date', todayStr)
        .maybeSingle();

      if (activity && isLatest()) {
        setActivityLevel(activity.feeling);
      }

      // 3. 今日の献立を取得（日付ベースモデル: user_daily_meals → planned_meals）
      const { data: dailyMealData, error: dailyMealError } = await supabase
        .from('user_daily_meals')
        .select(`
          id,
          day_date,
          planned_meals(*)
        `)
        .eq('day_date', todayStr)
        .eq('user_id', authUser.id)
        .maybeSingle();

      // あとから別の取得を始めていたら、今日の献立はそちらの応答を置く (#2201 U1)。
      // 取り直しの応答を待つあいだに完了の切り替え (楽観的な更新) を始めた (終えていても)・チェックインの欄を開いた:
      // 切り替えの前に読んだ今日の献立で楽観的な表示を戻さない。切り替えが全部終わった・欄を閉じたあとに 1 回取り直す (#2201 U1 + U2)
      const todayPlanPlaced = order.place(() => {
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
        } else if (!dailyMealError) {
          // 今日の献立が無い: 前の献立を残さない (取り直しのとき。読み込み直したときと同じ。#2195 V1)。
          // 読み取りの失敗では今の表示を残す
          setTodayPlan(null);
          setDailySummary(EMPTY_DAILY_SUMMARY);
        }
      });
      if (todayPlanPlaced === 'superseded') console.warn('[home] superseded fetch: skip placing today plan');
      if (todayPlanPlaced === 'deferred') console.warn('[home] held while refetching: skip placing today plan');

      // ========== 拡張データを並列取得（高速化） ==========
      // どれも応答を置く前に最後に始めた取得かを見る (isLatest。#2201 U1)
      await Promise.all([
        fetchCookingStreak(authUser.id, isLatest),
        fetchWeeklyStats(authUser.id, isLatest),
        fetchMonthlyStats(authUser.id, isLatest),
        fetchExpiringItems(authUser.id, isLatest),
        fetchShoppingRemaining(authUser.id, isLatest),
        fetchBadgeInfo(authUser.id, isLatest),
        fetchBestMealThisWeek(authUser.id, isLatest),
        fetchHealthSummary(authUser.id, isLatest),
      ]);

      // 栄養分析は重いので非同期で後から取得（UIはloadingなしで先に表示）
      fetchNutritionAnalysis(options);

      // Performance OS v3: パフォーマンス分析も非同期で取得
      fetchPerformanceAnalysis(authUser.id);

    } else if (mode === 'mount' && isLatest()) {
      // 取り直しでログインを確かめられなかったときは、今の表示を残す (#2201 U1。ログアウトはログインの状態の変化の取得が反映する)
      setUser(null);
    }

    // 11. Announcements
    try {
      const annRes = await fetch('/api/announcements?mode=public');
      if (annRes.ok) {
        const annData = await annRes.json();
        if (annData.announcements && annData.announcements.length > 0 && isLatest()) {
          setAnnouncement(toAnnouncement(annData.announcements[0]));
        }
      }
    } catch (e) {
      console.error("Announcement fetch error", e);
    }
  };

  // 連続自炊ストリーク（完了した自炊のみカウント）
  // isLatest は呼んだ取得 (fetchHomeData) が最後に始めた取得か。下の記録の集計の取得も同じ (#2201 U1。古い応答を置かない)
  const fetchCookingStreak = async (userId: string, isLatest: () => boolean) => {
    try {
      // 過去30日分のデータを取得（日付ベースモデル）
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const { data: daysData } = await supabase
        .from('user_daily_meals')
        .select(`
          day_date,
          planned_meals(mode, is_completed)
        `)
        .eq('user_id', userId)
        .gte('day_date', formatLocalDate(thirtyDaysAgo))
        .lte('day_date', todayStr)
        .order('day_date', { ascending: false });

      type DayWithStreakMeals = { day_date: string; planned_meals: Pick<Tables<"planned_meals">, "mode" | "is_completed">[] };
      // 記録の無い期間も 0 を置く (取り直しで前の連続の日数を残さない。読み込み直したときと同じ。#2195 V1)
      if (daysData && isLatest()) {
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
          } else if (day.day_date < todayStr) {
            // 今日以前で完了した自炊がない日があったらストリーク終了
            break;
          }
        }
        setCookingStreak(streak);
      }
    } catch (e) {
      console.error('Streak fetch error:', e);
    }
  };

  // 週間統計（日付ベースモデル）
  const fetchWeeklyStats = async (userId: string, isLatest: () => boolean) => {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
      
      const { data: daysData } = await supabase
        .from('user_daily_meals')
        .select(`
          day_date,
          planned_meals(mode, is_completed, calories_kcal)
        `)
        .eq('user_id', userId)
        .gte('day_date', formatLocalDate(sevenDaysAgo))
        .lte('day_date', todayStr)
        .order('day_date');

      if (daysData && isLatest()) {
        const days: WeeklyStats['days'] = [];
        let totalCook = 0;
        let totalMeals = 0;

        // 7日分のデータを作成（データがない日も含む）
        for (let i = 6; i >= 0; i--) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const dateStr = formatLocalDate(d);
          
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
            dayOfWeek: getDayOfWeek(dateStr),
            cookRate,
            totalCalories,
            mealCount,
          });
          
          totalCook += cookMeals.length;
          totalMeals += mealCount;
        }

        setWeeklyStats({
          days,
          avgCookRate: totalMeals > 0 ? Math.round((totalCook / totalMeals) * 100) : 0,
          totalCookCount: totalCook,
          totalMealCount: totalMeals,
        });
      }
    } catch (e) {
      console.error('Weekly stats fetch error:', e);
    }
  };

  // 月間統計（日付ベースモデル、完了した自炊のみカウント）
  const fetchMonthlyStats = async (userId: string, isLatest: () => boolean) => {
    try {
      const firstOfMonth = new Date();
      firstOfMonth.setDate(1);
      
      const { data: daysData } = await supabase
        .from('user_daily_meals')
        .select(`
          day_date,
          planned_meals(mode, is_completed)
        `)
        .eq('user_id', userId)
        .gte('day_date', formatLocalDate(firstOfMonth))
        .lte('day_date', todayStr);

      if (daysData && isLatest()) {
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

        setMonthlyStats({
          cookCount,
          totalMeals,
          cookRate: totalMeals > 0 ? Math.round((cookCount / totalMeals) * 100) : 0,
        });
      }
    } catch (e) {
      console.error('Monthly stats fetch error:', e);
    }
  };

  // 冷蔵庫の期限切れ間近 (今日から PANTRY_EXPIRING_SOON_DAYS 日後の期限まで。全画面共通の範囲 #1602)
  const fetchExpiringItems = async (userId: string, isLatest: () => boolean) => {
    try {
      const { data } = await orderListBy(
        supabase
          .from('pantry_items')
          .select('*')
          .eq('user_id', userId)
          .lte('expiration_date', pantryExpiringSoonUntil(todayStr))
          .gte('expiration_date', todayStr),
        LIST_ORDERS.pantryItemsByExpiration,
      );

      if (data && isLatest()) {
        setExpiringItems(data.map((item: any) => ({
          id: item.id,
          userId: item.user_id,
          name: item.name,
          amount: item.amount,
          category: item.category,
          expirationDate: item.expiration_date,
          addedAt: item.added_at,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
        })));
      }
    } catch (e) {
      console.error('Expiring items fetch error:', e);
    }
  };

  // 買い物リスト残数（日付ベースモデル）
  const fetchShoppingRemaining = async (userId: string, isLatest: () => boolean) => {
    try {
      // アクティブな買い物リストを取得
      const { data: shoppingList, error: shoppingListError } = await supabase
        .from('shopping_lists')
        .select('id')
        .eq('user_id', userId)
        .eq('status', 'active')
        .maybeSingle();

      if (shoppingList) {
        const { count } = await supabase
          .from('shopping_list_items')
          .select('*', { count: 'exact', head: true })
          .eq('shopping_list_id', shoppingList.id)
          .eq('is_checked', false);

        if (isLatest()) setShoppingRemaining(count || 0);
      } else if (!shoppingListError && isLatest()) {
        // 使っている買い物リストが無い: 前の残りの数を残さない (取り直しのとき。読み込み直したときと同じ。#2195 V1)。
        // 読み取りの失敗では今の表示を残す
        setShoppingRemaining(0);
      }
    } catch (e) {
      console.error('Shopping remaining fetch error:', e);
    }
  };

  // バッジ情報
  const fetchBadgeInfo = async (userId: string, isLatest: () => boolean) => {
    try {
      // バッジ総数
      const { count } = await supabase
        .from('user_badges')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);

      if (isLatest()) setBadgeCount(count || 0);

      // 最新バッジ
      const { data: latestData } = await orderListBy(
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

      type LatestBadgeRow = { obtained_at: string | null; badges: Pick<Tables<"badges">, "name" | "code"> | Pick<Tables<"badges">, "name" | "code">[] | null };
      if (latestData && (latestData as unknown as LatestBadgeRow).badges) {
        const badgesRaw = (latestData as unknown as LatestBadgeRow).badges!;
        const badge = Array.isArray(badgesRaw) ? badgesRaw[0] : badgesRaw;
        if (!badge || !isLatest()) return;
        setLatestBadge({
          name: badge.name,
          code: badge.code,
          obtainedAt: latestData.obtained_at,
        });
      }
    } catch (e) {
      console.error('Badge info fetch error:', e);
    }
  };

  // 今週のベスト料理（日付ベースモデル）
  const fetchBestMealThisWeek = async (userId: string, isLatest: () => boolean) => {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
      
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
        .gte('user_daily_meals.day_date', formatLocalDate(sevenDaysAgo))
        .eq('is_completed', true)
        .not('image_url', 'is', null)
        // 行は toPlannedMeal (引数は any) に渡すだけなので、結果の型を行の形に置き換える。select の結合の型のまま
        // orderListBy に渡すと、型の展開が深くなりすぎて tsc が止まる (TS2589)
        .returns<Record<string, unknown>[]>();
      const { data } = await orderListBy<typeof bestMealQuery>(bestMealQuery, LIST_ORDERS.homeBestVegMeal).limit(1);

      // 当てはまる食事が無くなった (AI 相談で消した・完了を外した) ときは消す。取り直し (refetch。AI 相談の成功のあと) で
      // 前の食事を残さない (#2195 V1)
      if (isLatest()) setBestMealThisWeek(data && data.length > 0 ? toPlannedMeal(data[0]) : null);
    } catch (e) {
      console.error('Best meal fetch error:', e);
    }
  };

  // 健康記録サマリー
  const fetchHealthSummary = async (userId: string, isLatest: () => boolean) => {
    try {
      // 今日の記録
      const { data: todayRecord } = await supabase
        .from('health_records')
        .select('*')
        .eq('user_id', userId)
        .eq('record_date', todayStr)
        .maybeSingle();

      // 連続記録
      const { data: streak } = await supabase
        .from('health_streaks')
        .select('current_streak')
        .eq('user_id', userId)
        .eq('streak_type', 'daily_record')
        .maybeSingle();

      // 最新の体重と昨日の体重
      const { data: recentWeights } = await supabase
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
      const { data: weightGoal } = await supabase
        .from('health_goals')
        .select('target_value')
        .eq('user_id', userId)
        .eq('goal_type', 'weight')
        .eq('status', 'active')
        .maybeSingle();

      // アラートがあるか確認
      const { count: alertCount } = await supabase
        .from('health_insights')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('is_alert', true)
        .eq('is_dismissed', false);

      if (!isLatest()) return;
      setHealthSummary({
        todayRecord,
        healthStreak: streak?.current_streak || 0,
        weightChange,
        latestWeight,
        targetWeight: weightGoal?.target_value || null,
        hasAlert: (alertCount || 0) > 0,
      });
    } catch (e) {
      console.error('Health summary fetch error:', e);
    }
  };

  // 栄養分析（開いたときは AI のアドバイス付き。取り直しは AI を呼ばずに点数・課題だけ。#2201 U4）
  // 応答を置くのは最後に始めた読み取りだけ (nutritionAnalysisStream。#2201 U1): 応答を待つたびに、あとから別の読み取りを
  // 始めていないかを見て、始めていればこの応答 (点数・課題・アドバイス・今日のアドバイスの帯・読み込み中の印) を何も置かない
  const fetchNutritionAnalysis = async ({ analysisWithoutAi }: HomeFetchOptions) => {
    const order = nutritionAnalysisStream.begin();
    try {
      setNutritionAnalysis(prev => ({ ...prev, loading: true }));
      
      const response = await fetch(analysisWithoutAi ? HOME_NUTRITION_ANALYSIS_WITHOUT_AI_URL : HOME_NUTRITION_ANALYSIS_WITH_AI_URL);
      
      if (!order.isLatest()) return;
      if (response.ok) {
        const data = await response.json();
        
        if (!order.isLatest()) return;
        if (data.success && data.analysis) {
          if (analysisWithoutAi) {
            // 取り直し: 点数・課題・栄養素の比べだけを新しくし、アドバイス・提案・aiSkipped と今日のアドバイスの帯は前の値を残す
            // (AI を呼んでいないので、応答の advice / suggestion は空。#2201 U4)
            setNutritionAnalysis(prev => ({
              ...prev,
              score: data.analysis.score || 0,
              issues: data.analysis.issues || [],
              comparison: data.analysis.comparison || {},
              loading: false,
            }));
          } else {
            setNutritionAnalysis({
              score: data.analysis.score || 0,
              issues: data.analysis.issues || [],
              advice: data.advice || null,
              suggestion: data.suggestion || null,
              comparison: data.analysis.comparison || {},
              aiSkipped: aiSkippedReasonOf(data),
              loading: false,
            });
            // AIアドバイスをsuggestに設定 (帯に何も出ていないときだけ)
            if (data.advice && !suggestion) {
              setSuggestion(data.advice);
            }
          }
        } else if (data.success) {
          // 今日の完了した食事が無くて分析できない (analysis: null)。前の分析 (点数・課題・アドバイス) を残さない
          // (AI 相談で今日の食事を消した・完了を外したあとの取り直し。読み込み直したときと同じ。#2195 V1)
          setNutritionAnalysis(NO_NUTRITION_ANALYSIS);
          if (analysisWithoutAi) {
            // 取り直しでは帯も消す (分析する食事が無いので、読み込み直しても帯は出ない)
            setSuggestion(null);
          }
        } else {
          setNutritionAnalysis(prev => ({ ...prev, loading: false }));
        }
      } else {
        setNutritionAnalysis(prev => ({ ...prev, loading: false }));
      }
    } catch (e) {
      console.error('Nutrition analysis fetch error:', e);
      // 失敗では今の分析を残す。読み込み中の印は最後に始めた読み取りが下ろす (古い読み取りの失敗で、あとの読み取りの途中に下ろさない)
      if (order.isLatest()) setNutritionAnalysis(prev => ({ ...prev, loading: false }));
    }
  };

  // Performance OS v3: パフォーマンス分析を取得
  // ホームのデータの取得 (fetchHomeData) とチェックインの保存のあとに読む。応答を置くのは最後に始めた読み取りだけ
  // (performanceAnalysisStream。#2201 U1。古い応答で、あとの読み取りの分析を上書きしない。読み込み中の印もあとの読み取りが下ろす)
  const fetchPerformanceAnalysis = async (userId: string) => {
    const order = performanceAnalysisStream.begin();
    try {
      setPerformanceAnalysis(prev => ({ ...prev, loading: true }));

      // 今日のチェックインを取得
      const { data: todayCheckin } = await supabase
        .from('user_performance_checkins')
        .select('*')
        .eq('user_id', userId)
        .eq('checkin_date', todayStr)
        .maybeSingle();

      // 7日分析を取得
      const response = await fetch(`/api/performance/analyze?date=${todayStr}`);

      if (response.ok) {
        const data = await response.json();

        order.place(() =>
          setPerformanceAnalysis({
            eligible: data.eligible || false,
            eligibilityReason: data.eligibilityReason || null,
            nextAction: data.analysis?.nextAction || null,
            recommendations: data.analysis?.recommendations || [],
            todayCheckin,
            loading: false,
          }),
        );
      } else {
        order.place(() =>
          setPerformanceAnalysis(prev => ({
            ...prev,
            todayCheckin,
            loading: false
          })),
        );
      }
    } catch (e) {
      console.error('Performance analysis fetch error:', e);
      order.place(() => setPerformanceAnalysis(prev => ({ ...prev, loading: false })));
    }
  };

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
    try {
      const { data: { user: authUser } } = await supabase.auth.getUser();
      if (!authUser) return { success: false, error: 'Not authenticated' };

      const { data, error } = await supabase
        .from('user_performance_checkins')
        .upsert({
          user_id: authUser.id,
          checkin_date: todayStr,
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
              record_date: todayStr,
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

      // チェックイン後に分析を再取得（非同期で実行し、フィードバック表示をブロックしない）
      void fetchPerformanceAnalysis(authUser.id);

      return { success: true, data };
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
      setSuggestion('現在提案できる献立変更はありません。');
      return;
    }
    
    try {
      // suggestionがある場合はそれを使用、なければissuesから生成
      let targetDate = todayStr;
      let targetMealType = 'dinner';
      let prompt = '';
      
      if (suggestion) {
        targetDate = suggestion.targetDate || todayStr;
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
      
      setSuggestion('献立を変更中...');
      
      const response = await aiFetch('/api/ai/nutrition-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetDate,
          targetMealType,
          prompt,
        }),
      });
      
      // 同意が必要で止められた (T15 / #1154): 同意画面 (AiConsentRequiredHost) が案内するので、失敗の表示は出さない
      if (await isAiConsentRequiredResponse(response)) {
        setSuggestion(null);
        return;
      }

      if (response.ok) {
        // 成功したらデータを再取得
        await fetchHomeData();
        setSuggestion('🎉 献立を変更しました！');
      } else {
        const errorData = await response.json().catch(() => ({}));
        setSuggestion(`変更に失敗しました: ${errorData.error || 'エラーが発生しました'}`);
      }
    } catch (e) {
      console.error('Execute nutrition suggestion error:', e);
      setSuggestion('変更に失敗しました。もう一度お試しください。');
    }
  };

  // 食事完了をトグル (Bug-10: 楽観的UI更新 + 失敗時ロールバック, #191/#322: debounce 250ms)
  const toggleMealCompletion = async (mealId: string, currentStatus: boolean) => {
    // #322: 250ms debounce — 既存タイマーをキャンセルして再スケジュール
    const existingTimer = toggleDebounceTimerRef.current.get(mealId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      toggleDebounceTimerRef.current.delete(mealId);
    }

    // #191: 同一 mealId の PATCH が進行中なら無視（連打対策）
    if (pendingToggleRef.current.has(mealId)) return;

    // debounce: 250ms 後に実際の処理を実行
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        toggleDebounceTimerRef.current.delete(mealId);
        resolve();
      }, 250);
      toggleDebounceTimerRef.current.set(mealId, timer);
    });

    // debounce 待機後、再度 pending チェック（待機中に別のリクエストが始まった可能性）
    if (pendingToggleRef.current.has(mealId)) return;
    pendingToggleRef.current.add(mealId);
    const endWrite = aiConsultationWrites.begin();
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
    } = supabase.auth.onAuthStateChange(() => {
      void fetchHomeData();
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const updateActivityLevel = async (level: string) => {
    if (!user) return;
    setActivityLevel(level);

    await supabase
      .from('daily_activity_logs')
      .upsert({
        user_id: user.id,
        date: todayStr,
        feeling: level,
      }, { onConflict: 'user_id, date' });

    // AIサジェスト生成
    if (level === 'rest') {
      setSuggestion("今日は運動量が少なめです。夕食の炭水化物を半分にして調整しましょう。");
    } else if (level === 'active') {
      setSuggestion("ナイスワークアウト！夕食でタンパク質を多めに摂り、筋肉の回復を促しましょう。");
    } else if (level === 'stressed') {
      setSuggestion("ストレスを感じているときは、ビタミンB群を含む食材がおすすめです。");
    } else {
      setSuggestion(null);
    }
  };

  return {
    user,
    todayPlan,
    loading,
    dailySummary,
    announcement,
    activityLevel,
    suggestion,
    // 新規追加
    cookingStreak,
    weeklyStats,
    monthlyStats,
    expiringItems,
    shoppingRemaining,
    badgeCount,
    latestBadge,
    bestMealThisWeek,
    healthSummary,
    nutritionAnalysis,
    // Performance OS v3
    performanceAnalysis,
    // 関数
    toggleMealCompletion,
    updateActivityLevel,
    setAnnouncement,
    setSuggestion,
    executeNutritionSuggestion,
    submitPerformanceCheckin,
    // 取り直し (AI 相談の成功のあと)。読み込み直したときと同じ表示にする (#2195 V1)。ただし栄養の分析は AI を呼ばずに
    // 点数・課題だけ読み直し、今日のアドバイスの帯は残す (成功のたびの LLM の費用と安全弁の消費をやめる。#2201 U4)。
    // 読み込み中の表示を出さず、読み取りの失敗では今の表示を残す (#2201 U1)。開いたときの読み込み中に始まった取り直しは、
    // その読み込みの役を引き継ぐ (refetchReadMode が 'mount')。引き継いだ回は栄養の分析も開いたときと同じく AI つきで読む
    // (開いたときの AI つきの読み取りは最後に始めた読み取りでなくなり置かれないので、AI を付けずに読むとアドバイスと帯が出ないまま残る)
    // 札 (useAiConsultationDataRefetch が渡す) があれば、応答を待つあいだに始めた完了の切り替えを今日の献立で上書きしない
    refetch: (ticket?: AiConsultationFetchTicket) => {
      const mode = refetchReadMode();
      return fetchHomeData({ analysisWithoutAi: mode === 'refetch' }, mode, ticket);
    },
    // 食事の完了の切り替えの間の印 (#2201 U2。ページが useAiConsultationDataRefetch の writeInFlightRef に渡す)
    aiConsultationWrites,
  };
};
