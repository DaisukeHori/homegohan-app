/**
 * #2195 V1 献立表 (/menus/weekly) が AI 相談の成功で取り直すもの (ページを描画して確かめる)
 *
 * 問題 (直す前):
 *   - AI 相談が始めた献立の生成 (generate_week_menu など) は、依頼を受けた時点 (status: processing) で成功を知らせる。
 *     献立表は表示中の週を 1 回取り直すだけで、生成中の依頼を確かめない (生成中の依頼の確認は週を開いたときだけ) ので、
 *     生成が終わっても献立表は古い表示のまま (読み込み直すまで) だった
 *   - AI 相談で買い物リストの最後の品目を消すと、取り直しの応答の空のリストを置かず、ヘッダーのバッジに消した品目が数えられたままだった
 *   - AI 相談で食事を消すと、月のカレンダーの献立のある日の印が残った (カレンダーの取得は足すだけで、取り直しもしない)
 *   - AI 相談で家族の人数を変えても、人数の設定の無い人の既定の人数 (人数の設定のモーダルが出す値) が前のままだった
 *     (家族の人数を空にしたときも、前の人数を残していた)
 *
 *   - AI 相談でプロフィールの身長・体重などを入れても、ページの上のプロフィールの帯 (ProfileReminderBanner) が古い
 *     「未入力」の一覧のまま残った (帯は開いたときに 1 回だけ読み、ページの取り直しはその読み取りをしない)
 *   - 家族に入っている人が AI 相談で自分の名前 (user_profiles.nickname) を変えても、家族の切り替え (FamilyViewSwitcher) の
 *     名前が前のまま残った (名前は GET /api/family/members/names が display_name の無いメンバーにプロフィールの名前を当てたもので、
 *     家族の一覧と名前は開いたときと切り替えの適用のときにだけ読んでいた)
 *
 * 直したあと: ページを開いたときに読むもののうち AI 相談で変わりうるもの (表示中の週の献立と買い物リスト・冷蔵庫・
 * 人数の設定・月のカレンダーの献立のある日・表示中の週の生成中の依頼・プロフィールの帯・家族の一覧と名前) を取り直す。
 *
 * 部品を消すモックとログアウトで、受け手の読み取りを隠さない (帯を消すモックとログアウトのせいで、帯の読み取りの抜けが
 * 見えなかった)。ログインした状態で、ページの部品をそのまま描く。消すのは AI が書く表を読まない部品だけ (読み取りのある部品は
 * 理由を AI_CONSULTATION_RENDER_TEST_MOCKED_READERS に書く) で、tests/ai-consultation-refetch-coverage-2195.test.ts がそれを確かめる。
 * 応答の作りでも読み取りを隠さない: 描画の検査 (下の 2 つ目の describe) は家族に入っている人 (自分ともう 1 人) で開き、
 * 前の答えで決まる読み取り (家族の一覧 → 名前の API・家族の献立) も開いたときの読み取りに出す (家族の一覧を空の答えにしていたせいで、
 * 名前の API の読み取りの抜けが見えなかった)。
 * 検査の限界: 生成中の依頼の監視の読み取り (状態の確認・Realtime) は、生成中の依頼の無い状態で比べる。監視は開いたときと同じ関数
 * (checkPendingRequests) を取り直しでも走らせ、生成中の流れは 1 つ目の describe の最初のテストが確かめる。
 *
 * サーバーは表 (server) で真似る。AI 相談の提案の実行は、表を書き換えてから AIChatBubble と同じ形で mealPlanUpdated を投げる。
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDateJa, formatLocalDate } from '@homegohan/shared';

/** 描画のたびに同じものを返す (ページの useEffect の依存に入っても、描画のたびに走り直さないように) */
const navigation = vi.hoisted(() => ({
  router: { push: () => undefined, back: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined },
  searchParams: new URLSearchParams(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/menus/weekly',
  useSearchParams: () => navigation.searchParams,
  useRouter: () => navigation.router,
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
// 画像 (料理の写真) はこの検査に関係しないので描かない
vi.mock('next/image', () => ({ default: () => null }));
// 生成のモーダル・栄養のレーダーチャート (dynamic import) はこの検査に関係しないので描かない。
// レーダーチャートは何も読まない。生成のモーダルは開いたときだけ読み (閉じている間は描かない)、開いている間は
// 取り直しの番兵が止める (モーダル) ので、開いたときと取り直しの読み取りの比べに入らない
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => undefined }));
vi.mock('@/hooks/useAiConsent', () => ({
  useAiConsent: () => ({ ensureAiConsent: async () => 'consented', consentModal: null }),
}));

/** user_profiles の行のうち、このページ (とプロフィールの帯) が読む列 */
type FakeProfileRow = {
  profile_completeness: number | null;
  height: number | null;
  weight: number | null;
  age: number | null;
  fitness_goals: string[] | null;
  health_conditions: string[] | null;
  /** 週の始まりの日 (null = 月曜) */
  week_start_day: string | null;
  family_id: string | null;
};

/**
 * Supabase のモック。ログインしている (週の始まりは月曜)。user_profiles は profile の行、family_members は familyMembers の行
 * (家族の active なメンバー) を返し、ほかの表は空。Realtime のチャンネルは名前だけ記録し、何も届けない
 */
const supabaseMock = vi.hoisted(() => ({
  /** ログインしている人の id (家族のメンバーの行の user_id にも使う) */
  userId: '21950000-0000-4000-8000-0000000000b1',
  channelNames: [] as string[],
  /** ログインしている人の user_profiles の行 (テストごとに置き換える) */
  profile: null as null | Record<string, unknown>,
  /** 家族の active なメンバーの family_members の行 (家族に入っていなければ空) */
  familyMembers: [] as Record<string, unknown>[],
  /**
   * 記録の口があれば、読んだ表 (select を呼んだとき。鍵は tests/helpers/ai-refetch-read-recorder.ts の selectReadKey) と
   * DB の関数 ('rpc:<名前>') を記録する (受け手の読み取りの検査)
   */
  reads: null as null | { record: (key: string | null) => void; recordSelect: (table: string, select: unknown) => void },
  /** true なら user_profiles の読み取りが error を返す (#2201 U1。通信・サーバーの失敗。行が無いのとは別) */
  profileFails: false,
  /** true なら family_members の読み取りが error を返す (#2206 G1。取り直しが家族の一覧を読めない) */
  familyMembersFails: false,
  /**
   * 置いている間に始めた family_members の次の 1 回の読み取りの応答 (答えは読み取りを始めたときのもの) を、この Promise が解けるまで止める
   * (止めたら消す。#2206 G1。開いたときの家族の読み込みの応答待ちに取り直しを流す)
   */
  familyMembersHoldOnce: null as Promise<void> | null,
}));
vi.mock('@/lib/supabase/client', () => {
  const EMPTY_RESULT = { data: null, error: null, count: 0 };
  const USER = { id: supabaseMock.userId, user_metadata: {} };
  /**
   * その表の答え (user_profiles は profile の行。single / maybeSingle なら行、そうでなければ行の配列。
   * family_members は familyMembers の行の配列。ほかの表は空)
   */
  const resultOf = (table: string | null, single: boolean) => {
    if (table === 'family_members') {
      if (supabaseMock.familyMembersFails) return { data: null, error: { code: '08006', message: 'connection failure' }, count: null };
      const rows = supabaseMock.familyMembers;
      return { data: single ? (rows[0] ?? null) : rows, error: null, count: rows.length };
    }
    if (table !== 'user_profiles') return EMPTY_RESULT;
    if (supabaseMock.profileFails) return { data: null, error: { code: '08006', message: 'connection failure' }, count: null };
    const row = supabaseMock.profile;
    if (single) return { data: row, error: null, count: row ? 1 : 0 };
    return { data: row ? [row] : [], error: null, count: row ? 1 : 0 };
  };
  /** どのメソッドを呼んでも自分を返し、await するとその表の答えになる問い合わせ。select を呼んだら読み取りを記録する */
  const query = (table: string | null, single: boolean): unknown =>
    new Proxy(() => undefined, {
      get: (_target, prop) => {
        if (prop === 'then') {
          return (resolve: (value: unknown) => void) => {
            // 答えは読み取りを始めたとき (await したとき) のもの。family_members の 1 回だけを止められる (#2206 G1)
            const result = resultOf(table, single);
            const hold = table === 'family_members' ? supabaseMock.familyMembersHoldOnce : null;
            if (hold === null) {
              resolve(result);
              return;
            }
            supabaseMock.familyMembersHoldOnce = null;
            void hold.then(() => resolve(result));
          };
        }
        return (...args: unknown[]) => {
          if (prop === 'select' && table !== null) supabaseMock.reads?.recordSelect(table, args[0]);
          return query(table, single || prop === 'single' || prop === 'maybeSingle');
        };
      },
    });
  const channel = {
    on: () => channel,
    subscribe: () => channel,
    unsubscribe: async () => 'ok',
  };
  return {
    createClient: () => ({
      auth: {
        getUser: async () => ({ data: { user: USER }, error: null }),
        getSession: async () => ({ data: { session: { user: USER } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      },
      from: (table: string) => query(table, false),
      rpc: (name: string) => {
        supabaseMock.reads?.record(`rpc:${name}`);
        return query(null, false);
      },
      channel: (name: string) => {
        supabaseMock.channelNames.push(name);
        return channel;
      },
      removeChannel: async () => 'ok',
    }),
  };
});

const { default: WeeklyMenuPage } = await import('@/app/(main)/menus/weekly/page');
// 献立表の store (ページは ./_state の index から同じファイルを読む)
const { useShoppingStore } = await import('@/app/(main)/menus/weekly/_state/shoppingStore');
const { usePantryStore } = await import('@/app/(main)/menus/weekly/_state/pantryStore');
const { useServingsConfigStore } = await import('@/app/(main)/menus/weekly/_state/servingsConfigStore');
const { AI_CONSULTATION_DATA_CHANGED_EVENT } = await import('@/lib/ai/consultation-data-refetch');
const { AI_CONSULTATION_WRITTEN_COLUMNS } = await import('@/lib/ai/consultation-refetch-coverage');
const { AI_CONSULTATION_GENERATION_WATCH_INTERVAL_MS } = await import('@/lib/ai/consultation-generation-watch');
const {
  ReadRecorder,
  expectEmptyRefetchMatchesFreshMount,
  expectRefetchReadsCoverMount,
  fetchReadKey,
  screenSignature,
  selectReadKey,
} = await import('./helpers/ai-refetch-read-recorder');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** fetch → res.json() → setState → useEffect → 次の fetch の連鎖を流しきるまでに回すタスクの数 */
const SETTLE_TASKS = 20;
/** 1 週間の日数 */
const DAYS_IN_WEEK = 7;
/** 月の中で、次の週の月曜も同じ月に入る週の始まりの日の上限 (どの月も 28 日はある) */
const LAST_DAY_WITH_NEXT_WEEK_IN_SAME_MONTH = 21;
/** プロフィールの帯を出す完成度 (src/components/ProfileReminderBanner.tsx の COMPLETENESS_THRESHOLD = 50 の未満と以上) */
const INCOMPLETE_PROFILE_COMPLETENESS = 20;
const COMPLETE_PROFILE_COMPLETENESS = 100;
/** プロフィールの帯の見出し */
const PROFILE_BANNER_HEADING = '栄養目標を設定しましょう';
/** 家族に入っている人の家族 (家族の一覧の読み取りを開いたときの読み取りに出す) */
const FAMILY_ID = '21950000-0000-4000-8000-0000000000f1';
/** 家族の中の自分 (display_name が無い = 名前の API がプロフィールの名前を当てる) と、献立を共有するもう 1 人 */
const SELF_MEMBER_ID = '21950000-0000-4000-8000-0000000000c1';
const OTHER_MEMBER_ID = '21950000-0000-4000-8000-0000000000c2';
const OTHER_USER_ID = '21950000-0000-4000-8000-0000000000b2';
/** 自分のプロフィールの名前 (AI 相談の前と後) と、もう 1 人の家族の中の呼び名 (display_name) */
const SELF_NAME_BEFORE = 'ほり';
const SELF_NAME_AFTER = '太郎';
const OTHER_MEMBER_NAME = '花子';

/** 身長・体重が未入力のプロフィール (完成度が帯を出す値) */
function incompleteProfile(): FakeProfileRow {
  return {
    profile_completeness: INCOMPLETE_PROFILE_COMPLETENESS,
    height: null,
    weight: null,
    age: 35,
    fitness_goals: ['健康維持'],
    health_conditions: ['なし'],
    week_start_day: null,
    family_id: null,
  };
}

/** 全部入れたプロフィール (帯を出さない) */
function completeProfile(): FakeProfileRow {
  return { ...incompleteProfile(), profile_completeness: COMPLETE_PROFILE_COMPLETENESS, height: 170, weight: 65 };
}

/** ページと同じ週の始まり (月曜・その日の 0 時。ページの getWeekStart と同じ作り方) */
function displayedWeekStart(): Date {
  const start = new Date();
  const fromMonday = (start.getDay() + DAYS_IN_WEEK - 1) % DAYS_IN_WEEK;
  start.setDate(start.getDate() - fromMonday);
  start.setHours(0, 0, 0, 0);
  return start;
}

/** 週の始まりから offset 日の日付 (ページの weekDates と同じ作り方) */
function dateFromWeekStart(offset: number): string {
  const start = displayedWeekStart();
  const day = new Date(start);
  day.setDate(start.getDate() + offset);
  return formatLocalDate(day);
}

/** 表示中の週の 7 日 */
function displayedWeekDates(): string[] {
  return Array.from({ length: DAYS_IN_WEEK }, (_, i) => dateFromWeekStart(i));
}

/** GET /api/meal-plans の範囲の鍵 (server.mealPlansHoldOnce の鍵) */
function mealPlansRangeKey(startDate: string, endDate: string): string {
  return `${startDate}..${endDate}`;
}

/** 表示中の週の献立の読み込み (週の初日から 7 日。ページの fetchPlan・refreshMealPlan の範囲) の鍵 */
function displayedWeekRangeKey(): string {
  return mealPlansRangeKey(dateFromWeekStart(0), dateFromWeekStart(DAYS_IN_WEEK - 1));
}

/** 表示中の月 (= 週の始まりの月) の、表示中の週の外の日 (次の週か前の週の月曜) */
function otherWeekDateInDisplayedMonth(): string {
  return displayedWeekStart().getDate() <= LAST_DAY_WITH_NEXT_WEEK_IN_SAME_MONTH
    ? dateFromWeekStart(DAYS_IN_WEEK)
    : dateFromWeekStart(-DAYS_IN_WEEK);
}

/** 月のカレンダーの印を読む窓 (ページの weekWindowOf・monthWindowOf の日数と同じ。#2206 G1) */
const CALENDAR_DAYS_BEFORE_WEEK = 14;
const CALENDAR_DAYS_AFTER_WEEK = 28;
const CALENDAR_MONTH_PADDING_DAYS = 7;

/**
 * 取り直しが月のカレンダーの印を読む月の数 (#2206 G1: 印は月ごとに 1 回読む)。表示中の週の窓 (初日の 14 日前〜28 日後) と
 * 表示中の月の窓 (月の初日の 7 日前〜末日の 7 日後) にかかる月 (重なる月は 1 回)
 */
function calendarMonthsReadByRefetch(): number {
  const start = displayedWeekStart();
  const shifted = (base: Date, days: number) => {
    const day = new Date(base);
    day.setDate(day.getDate() + days);
    return day;
  };
  const months = new Set<string>();
  const addMonths = (from: Date, to: Date) => {
    for (const month = new Date(from.getFullYear(), from.getMonth(), 1); month <= to; month.setMonth(month.getMonth() + 1)) {
      months.add(formatLocalDate(month));
    }
  };
  addMonths(shifted(start, -CALENDAR_DAYS_BEFORE_WEEK), shifted(start, CALENDAR_DAYS_AFTER_WEEK));
  const firstOfMonth = new Date(start.getFullYear(), start.getMonth(), 1);
  const lastOfMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  addMonths(shifted(firstOfMonth, -CALENDAR_MONTH_PADDING_DAYS), shifted(lastOfMonth, CALENDAR_MONTH_PADDING_DAYS));
  return months.size;
}

/** 表示中の月 (= 週の始まりの月) の印の読み取り (月の初日〜末日。ページの fetchAndCacheMealDates の範囲) の鍵 */
function displayedMonthRangeKey(): string {
  const start = displayedWeekStart();
  return mealPlansRangeKey(
    formatLocalDate(new Date(start.getFullYear(), start.getMonth(), 1)),
    formatLocalDate(new Date(start.getFullYear(), start.getMonth() + 1, 0)),
  );
}

/** 食事 (mealType を省くと夕食) */
type FakeMeal = { id: string; dishName: string; isCompleted?: boolean; mealType?: string };
type FakeShoppingItem = { id: string; itemName: string; isChecked: boolean };
/** 冷蔵庫の食材 (GET /api/pantry の items の 1 行。ページは中身を見ずに store に置く) */
type FakePantryItem = { id: string; name: string };

/** サーバーの表 (テストごとに作り直す) */
type FakeServer = {
  /** 日付 → その日の食事 (user_daily_meals の行があって食事が 0 の日は空の配列) */
  days: Map<string, FakeMeal[]>;
  /** 使っている買い物リストの品目 */
  shoppingItems: FakeShoppingItem[];
  /** 家族の人数 (人数の設定 servings_config は無い)。null = 空 (AI 相談の update_profile_preferences は null も書ける) */
  familySize: number | null;
  /** 生成中の依頼 (weekly_menu_requests の processing の行)。状態を読まれたら生成を終える */
  pendingRequest: { id: string; startDate: string; generate: () => void } | null;
  /**
   * GET /api/family/members/names の答え (member id → 画面に出す名前。display_name か、display_name の無いメンバーの
   * プロフィールの名前 user_profiles.nickname。null = 決まらない)
   */
  familyMemberNames: { id: string; name: string | null }[];
  /** 置いている間に始めた GET /api/meal-plans の応答を、この Promise が解けるまで止める (#2201 U1) */
  mealPlansHold: Promise<void> | null;
  /** true の間に始めた GET /api/meal-plans は 500 を返す (#2201 U1。読み直しの失敗) */
  mealPlansFail: boolean;
  /**
   * 範囲 (mealPlansRangeKey) → Promise。その範囲の GET /api/meal-plans の次の 1 回の応答 (答えは読み取りを始めたときのもの) を、
   * この Promise が解けるまで止める (止めたら消す。#2201 U1。同じ週の何回かの読み込みのうち、1 回だけを遅らせる)
   */
  mealPlansHoldOnce: Map<string, Promise<void>>;
  /** true なら GET /api/family/members/names が 500 を返す (#2201 U1) */
  namesFail: boolean;
  /** 置いている間に始めた食事の更新 (PATCH /api/meal-plans/meals/<id>) の応答を、この Promise が解けるまで止める (#2201 U2) */
  mealPatchHold: Promise<void> | null;
  /** true の間の食事の更新 (PATCH /api/meal-plans/meals/<id>) は 500 を返し、サーバーの表を変えない (#2201 U2。書き込みの失敗) */
  mealPatchFails: boolean;
  /** 冷蔵庫の食材 (GET /api/pantry の答え) */
  pantryItems: FakePantryItem[];
  /** 置いている間に始めた GET /api/pantry の応答 (答えは読み取りを始めたときのもの) を、この Promise が解けるまで止める (#2201 U1) */
  pantryHold: Promise<void> | null;
  /** 置いている間に始めた GET /api/profile の応答 (答えは読み取りを始めたときのもの) を、この Promise が解けるまで止める (#2201 U1) */
  profileHold: Promise<void> | null;
  /** 範囲 (mealPlansRangeKey) の GET /api/meal-plans の次の 1 回だけを 500 にする (#2206 G1。先読み・前の週の読み込みの失敗) */
  mealPlansFailOnce: Set<string>;
  /**
   * 買い物リストの再生成の依頼 (#2206 G1。GET /api/shopping-list/regenerate/status)。1 回目の確かめ (開き直したときの復元) は処理中を返し、
   * 2 回目から (監視のポーリング) は hold が解けてから完了を返す
   */
  shoppingRegeneration: { requestId: string; statusCalls: number; hold: Promise<void> } | null;
  /** 置いている間に始めた GET /api/shopping-list の応答 (答えは読み取りを始めたときのもの) を、この Promise が解けるまで止める (#2206 G1) */
  shoppingListHold: Promise<void> | null;
};
let server: FakeServer;
let fetchCalls: string[];
/** 受け手の読み取りの記録 (GET の fetch と Supabase の読み取り) */
let recorder: InstanceType<typeof ReadRecorder>;

/** family_members の active な行 (ページの loadFamilyData が読む列)。avatar_color が空なら一覧の順の色 */
function familyMemberRow(id: string, userId: string, role: 'representative' | 'adult', displayName: string | null) {
  return {
    id,
    family_id: FAMILY_ID,
    user_id: userId,
    role,
    display_name: displayName,
    relationship: null,
    tags: [],
    share_meals: true,
    share_health: false,
    share_menu: true,
    child_profile: null,
    avatar_color: '',
    status: 'active',
    joined_at: '2026-10-01T00:00:00.000Z',
    removed_at: null,
  };
}

/**
 * 家族に入っている (自分と、献立を共有するもう 1 人)。プロフィールの family_id は呼ぶ側が置く。
 * selfName は名前の API が display_name の無い自分に当てるプロフィールの名前 (null = 決まらない)
 */
function joinFamily(selfName: string | null) {
  supabaseMock.familyMembers = [
    familyMemberRow(SELF_MEMBER_ID, supabaseMock.userId, 'representative', null),
    familyMemberRow(OTHER_MEMBER_ID, OTHER_USER_ID, 'adult', OTHER_MEMBER_NAME),
  ];
  server.familyMemberNames = [
    { id: SELF_MEMBER_ID, name: selfName },
    { id: OTHER_MEMBER_ID, name: OTHER_MEMBER_NAME },
  ];
}

/** GET /api/family/menu の答えのメンバー (自分以外で献立を共有するメンバー。この検査では献立なし) */
function familyMenuMembersJson() {
  return supabaseMock.familyMembers
    .filter((member) => member.user_id !== supabaseMock.userId && member.share_menu === true)
    .map((member) => ({ member_id: String(member.id), user_id: String(member.user_id), days: [] }));
}

function plannedMealJson(date: string, meal: FakeMeal) {
  return {
    id: meal.id,
    dailyMealId: `day-${date}`,
    mealType: meal.mealType ?? 'dinner',
    dishName: meal.dishName,
    mode: 'cook',
    isCompleted: meal.isCompleted ?? false,
    recipeUrl: null,
    imageUrl: null,
    description: null,
    ingredients: [],
    recipeSteps: null,
    caloriesKcal: null,
    dishes: null,
    displayOrder: 0,
  };
}

function mealPlansJson(startDate: string, endDate: string) {
  const dailyMeals = [...server.days.entries()]
    .filter(([date]) => date >= startDate && date <= endDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, meals]) => ({
      id: `day-${date}`,
      dayDate: date,
      theme: null,
      nutritionalFocus: null,
      isCheatDay: false,
      meals: meals.map((meal) => plannedMealJson(date, meal)),
    }));
  return {
    dailyMeals,
    startDate,
    endDate,
    shoppingList: {
      id: 'shopping-list-1',
      status: 'active',
      items: server.shoppingItems.map((item) => ({
        id: item.id,
        shoppingListId: 'shopping-list-1',
        category: 'その他',
        itemName: item.itemName,
        quantity: null,
        isChecked: item.isChecked,
        source: 'manual',
        normalizedName: null,
        quantityVariants: [],
        selectedVariantIndex: 0,
      })),
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
const NOT_FOUND_STATUS = 404;
/** 食事の更新の道の頭 (PATCH /api/meal-plans/meals/<id>) */
const MEAL_PATCH_PATH_PREFIX = '/api/meal-plans/meals/';
/** 買い物リストの品目の更新の道の頭 (PATCH /api/shopping-list/<id>。チェックの切り替えなど) */
const SHOPPING_ITEM_PATCH_PATH_PREFIX = '/api/shopping-list/';
/** 食事の追加の道 (POST /api/meal-plans/meals) と、追加で作る食事の id (#2206 G1) */
const MEAL_CREATE_PATH = '/api/meal-plans/meals';
const CREATED_MEAL_ID = 'meal-created';
/** 冷蔵庫の写真から足す食材 (#2206 G1) */
const FRIDGE_PHOTO_ITEM = { id: 'pantry-photo', name: '写真のたまご' };
/** 読み取りの失敗 (server.namesFail) のときの status */
const SERVER_ERROR_STATUS = 500;
/** ページの API の相対 URL を解く起点 (fetch のモックの中だけで使う) */
const PAGE_ORIGIN = 'http://localhost';

function installFakeServer() {
  fetchCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: { method?: string; body?: unknown }) => {
    const raw = typeof input === 'string' ? input : input.toString();
    fetchCalls.push(raw);
    recorder.record(fetchReadKey(raw, init));
    const url = new URL(raw, PAGE_ORIGIN);
    // 祝日の一覧 (外の API) は、この検査では祝日なし
    if (url.origin !== PAGE_ORIGIN) return jsonResponse({});
    // 買い物リストの品目の更新 (チェックの切り替え)。サーバーの表に書く (#2201 U2)
    if ((init?.method ?? 'GET').toUpperCase() === 'PATCH' && url.pathname.startsWith(SHOPPING_ITEM_PATCH_PATH_PREFIX)) {
      const id = url.pathname.slice(SHOPPING_ITEM_PATCH_PATH_PREFIX.length);
      const patch = JSON.parse(String(init?.body ?? '{}')) as { isChecked?: boolean };
      server.shoppingItems = server.shoppingItems.map((item) =>
        item.id === id && patch.isChecked !== undefined ? { ...item, isChecked: patch.isChecked } : item,
      );
      return jsonResponse({ success: true });
    }
    // 食事の削除 (#2206 G1)。食事の行だけを消す (その日の user_daily_meals の行は残る)
    if ((init?.method ?? 'GET').toUpperCase() === 'DELETE' && url.pathname.startsWith(MEAL_PATCH_PATH_PREFIX)) {
      const mealId = url.pathname.slice(MEAL_PATCH_PATH_PREFIX.length);
      for (const [date, meals] of server.days) server.days.set(date, meals.filter((meal) => meal.id !== mealId));
      return jsonResponse({ success: true });
    }
    // 食事の追加 (#2206 G1)。その日に食事を 1 つ作り、作った食事の id を返す
    if ((init?.method ?? 'GET').toUpperCase() === 'POST' && url.pathname === MEAL_CREATE_PATH) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { dayDate?: string; dishName?: string };
      const dayDate = body.dayDate ?? '';
      const created: FakeMeal = { id: CREATED_MEAL_ID, dishName: body.dishName ?? '' };
      server.days.set(dayDate, [...(server.days.get(dayDate) ?? []), created]);
      return jsonResponse({ success: true, meal: { id: created.id } });
    }
    // 冷蔵庫の写真の解析 (AI は読むだけ) と、写真から食材を足す保存 (#2206 G1)
    if ((init?.method ?? 'GET').toUpperCase() === 'POST' && url.pathname === '/api/ai/analyze-fridge') {
      return jsonResponse({ detailedIngredients: [{ name: FRIDGE_PHOTO_ITEM.name, quantity: '1個' }] });
    }
    if ((init?.method ?? 'GET').toUpperCase() === 'POST' && url.pathname === '/api/pantry/from-photo') {
      server.pantryItems = [...server.pantryItems, { ...FRIDGE_PHOTO_ITEM }];
      return jsonResponse({ success: true });
    }
    // 食事の更新 (完了の切り替えなど)。止めていれば、止めが解けてから成功を返す。完了はサーバーの表に書く (#2201 U2)
    if ((init?.method ?? 'GET').toUpperCase() === 'PATCH' && url.pathname.startsWith(MEAL_PATCH_PATH_PREFIX)) {
      const hold = server.mealPatchHold;
      if (hold) await hold;
      if (server.mealPatchFails) return jsonResponse({ error: 'down' }, SERVER_ERROR_STATUS);
      const mealId = url.pathname.slice(MEAL_PATCH_PATH_PREFIX.length);
      const patch = JSON.parse(String(init?.body ?? '{}')) as { isCompleted?: boolean };
      if (patch.isCompleted !== undefined) {
        for (const [date, meals] of server.days) {
          server.days.set(date, meals.map((meal) => (meal.id === mealId ? { ...meal, isCompleted: patch.isCompleted } : meal)));
        }
      }
      return jsonResponse({ success: true });
    }
    switch (url.pathname) {
      case '/api/meal-plans': {
        // 答えは読み取りを始めたときのもの。止めていれば、止めが解けてから返す
        const body = mealPlansJson(url.searchParams.get('startDate') ?? '', url.searchParams.get('endDate') ?? '');
        const hold = server.mealPlansHold;
        const fails = server.mealPlansFail;
        const rangeKey = mealPlansRangeKey(url.searchParams.get('startDate') ?? '', url.searchParams.get('endDate') ?? '');
        const holdOnce = server.mealPlansHoldOnce.get(rangeKey);
        server.mealPlansHoldOnce.delete(rangeKey);
        const failsOnce = server.mealPlansFailOnce.delete(rangeKey);
        if (hold) await hold;
        if (holdOnce) await holdOnce;
        if (fails || failsOnce) return jsonResponse({ error: 'down' }, SERVER_ERROR_STATUS);
        return jsonResponse(body);
      }
      case '/api/ai/menu/weekly/pending': {
        const pending = server.pendingRequest;
        if (pending && pending.startDate === url.searchParams.get('date')) {
          return jsonResponse({ hasPending: true, requestId: pending.id, status: 'processing', ultimateMode: false, startDate: pending.startDate });
        }
        return jsonResponse({ hasPending: false });
      }
      case '/api/ai/menu/weekly/status': {
        const pending = server.pendingRequest;
        if (pending && pending.id === url.searchParams.get('requestId')) {
          // 生成が終わった (献立を書いてから completed にする)
          pending.generate();
          server.pendingRequest = null;
        }
        return jsonResponse({ status: 'completed', progress: null });
      }
      case '/api/ai/menu/weekly/cleanup':
        return jsonResponse({ cleaned: 0 });
      case '/api/ai/menu/meal/pending':
        return jsonResponse({ hasPending: false, requests: [] });
      case '/api/pantry': {
        // 答えは読み取りを始めたときのもの。止めていれば、止めが解けてから返す
        const body = { items: server.pantryItems.map((item) => ({ ...item })) };
        const hold = server.pantryHold;
        if (hold) await hold;
        return jsonResponse(body);
      }
      case '/api/profile': {
        // 答えは読み取りを始めたときのもの。止めていれば、止めが解けてから返す
        const body = { family_size: server.familySize, servings_config: null, radar_chart_nutrients: null };
        const hold = server.profileHold;
        if (hold) await hold;
        return jsonResponse(body);
      }
      case '/api/shopping-list/regenerate/status': {
        const regeneration = server.shoppingRegeneration;
        if (!regeneration || regeneration.requestId !== url.searchParams.get('requestId')) return jsonResponse({}, NOT_FOUND_STATUS);
        regeneration.statusCalls += 1;
        if (regeneration.statusCalls === 1) return jsonResponse({ status: 'processing', progress: null });
        await regeneration.hold;
        return jsonResponse({ status: 'completed', progress: null, result: null });
      }
      case '/api/shopping-list': {
        // 答えは読み取りを始めたときのもの。止めていれば、止めが解けてから返す
        const body = { shoppingList: mealPlansJson('', '').shoppingList };
        const hold = server.shoppingListHold;
        if (hold) await hold;
        return jsonResponse(body);
      }
      case '/api/family/members/names':
        if (server.namesFail) return jsonResponse({ error: 'down' }, SERVER_ERROR_STATUS);
        return jsonResponse({ data: { members: server.familyMemberNames } });
      case '/api/family/menu':
        return jsonResponse({
          data: {
            family_id: FAMILY_ID,
            start_date: url.searchParams.get('startDate') ?? '',
            end_date: url.searchParams.get('endDate') ?? '',
            members: familyMenuMembersJson(),
          },
        });
      default:
        return jsonResponse({}, NOT_FOUND_STATUS);
    }
  }));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  server = {
    days: new Map(),
    shoppingItems: [],
    familySize: 2,
    pendingRequest: null,
    familyMemberNames: [],
    mealPlansHold: null,
    mealPlansFail: false,
    mealPlansHoldOnce: new Map(),
    namesFail: false,
    mealPatchHold: null,
    mealPatchFails: false,
    pantryItems: [],
    pantryHold: null,
    profileHold: null,
    mealPlansFailOnce: new Set(),
    shoppingRegeneration: null,
    shoppingListHold: null,
  };
  supabaseMock.profileFails = false;
  supabaseMock.familyMembersFails = false;
  supabaseMock.familyMembersHoldOnce = null;
  // ?date= で開く検査が置いたクエリを、次の検査に残さない
  navigation.searchParams = new URLSearchParams();
  supabaseMock.channelNames.length = 0;
  // 既定は帯を出さないプロフィール (帯の検査は incompleteProfile に置き換える)・家族なし (家族の検査は joinFamily)
  supabaseMock.profile = completeProfile();
  supabaseMock.familyMembers = [];
  recorder = new ReadRecorder();
  supabaseMock.reads = recorder;
  localStorage.clear();
  // 献立表の store はモジュールに 1 つなので、前の検査の値を消す
  useShoppingStore.getState().setShoppingList([]);
  useShoppingStore.getState().setActiveShoppingList(null);
  usePantryStore.getState().setFridgeItems([]);
  useServingsConfigStore.getState().setServingsConfig(null);
  installFakeServer();
  // framer-motion がアニメーションの寸法を測るときに呼ぶ (jsdom には無い)
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  supabaseMock.reads = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < SETTLE_TASKS; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

async function renderWeeklyPage() {
  await act(async () => {
    root.render(<WeeklyMenuPage />);
  });
  await settle();
}

/** AI 相談の提案の実行が成功したことを、AIChatBubble と同じ形で知らせる */
async function notifyAiConsultationSucceeded(actionType: string, result: Record<string, unknown>) {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(AI_CONSULTATION_DATA_CHANGED_EVENT, { detail: { actionType, result } }));
  });
  await settle();
}

const callsTo = (pathname: string) => fetchCalls.filter((raw) => new URL(raw, PAGE_ORIGIN).pathname === pathname).length;

/** 冷蔵庫の食材 (AI 相談の前と後。#2201 U1 の応答の順序の検査) と、家族の人数 (人数の設定の無い人の既定の人数) */
const PANTRY_ITEM_BEFORE: FakePantryItem = { id: 'pantry-before', name: '前のにんじん' };
const PANTRY_ITEM_AFTER: FakePantryItem = { id: 'pantry-after', name: '新しいたまねぎ' };
const FAMILY_SIZE_BEFORE = 2;
const FAMILY_SIZE_AFTER = 4;

/** 献立表の store に置いた冷蔵庫の食材の名前 */
const fridgeItemNames = () => usePantryStore.getState().fridgeItems.map((item) => item.name);

/** 応答を止める Promise (server の …Hold に置く) と、それを解く関数 */
function heldResponse(): { hold: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { hold, release };
}

/** 週の読み込み中の表示 (画面全体のスピナー。週を送るボタンも出ない) を出しているか */
function weeklyPageIsLoading(): boolean {
  return container.querySelector('button[aria-label="翌週"]') === null && container.querySelector('.animate-spin') !== null;
}

/** 食事の完了の切り替えの待ち (ページの toggleMealCompletion の setTimeout の ms) */
const TOGGLE_DEBOUNCE_MS = 250;

/**
 * この関数の中で始まった完了の切り替えの待ち (setTimeout の TOGGLE_DEBOUNCE_MS) を止め、待ちを終わらせる関数を返す
 * (時間に頼らずに、待ちのあいだに取り直しの応答を置く。#2201 U2)。ほかの setTimeout はそのまま。
 * 切り替えは押した時点で (同じ呼び出しの中で) 待ちを始めるので、押す操作を start に渡す
 */
async function holdToggleDebounce(start: () => void): Promise<() => Promise<void>> {
  const realSetTimeout = globalThis.setTimeout;
  let heldCallback: (() => void) | null = null;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) => {
    if (heldCallback === null && ms === TOGGLE_DEBOUNCE_MS) {
      heldCallback = callback;
      return realSetTimeout(() => undefined, 0);
    }
    return realSetTimeout(callback, ms);
  }) as typeof globalThis.setTimeout);
  try {
    await act(async () => {
      start();
    });
  } finally {
    spy.mockRestore();
  }
  const held = heldCallback;
  if (held === null) throw new Error('完了の切り替えの待ちが始まっていない (検査が空振りしている)');
  return async () => {
    await act(async () => {
      held();
    });
    await settle();
  };
}

/** ヘッダーの買い物リストのボタン (バッジの数字はこの中に出る) */
function shoppingListButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="買い物リストを開く"]');
  if (!button) throw new Error('買い物リストのボタンが無い');
  return button;
}

/** プロフィールの帯 (無ければ null) */
function profileBanner(): HTMLElement | null {
  const heading = [...container.querySelectorAll('h3')].find((el) => el.textContent === PROFILE_BANNER_HEADING);
  return heading?.closest<HTMLElement>('div.rounded-2xl') ?? null;
}

/** プロフィールの帯に出ている未入力の欄の名前 */
function profileBannerMissingLabels(): string[] {
  const banner = profileBanner();
  if (!banner) throw new Error('プロフィールの帯が無い');
  return [...banner.querySelectorAll('span.rounded-full')].map((el) => (el.textContent ?? '').trim());
}

/** 家族の切り替え (FamilyViewSwitcher) のチップに出ているメンバーの名前 (チップの title。一覧の順) */
function familySwitcherNames(): string[] {
  const bar = container.querySelector('[aria-label="ビューを切替"]');
  if (!bar) throw new Error('家族の切り替えが無い');
  return [...bar.querySelectorAll('span[title]')].map((el) => el.getAttribute('title') ?? '');
}

/** 月のカレンダーを開き、日付のマスに出ている献立のある日の印の数を返す */
async function calendarMealDotCount(): Promise<number> {
  const CALENDAR_DOT = '.w-1.h-1.rounded-full';
  const monthBar = [...container.querySelectorAll<HTMLElement>('div.cursor-pointer')].find((el) => /\d+年\d+月/.test(el.textContent ?? ''));
  if (!monthBar) throw new Error('月のカレンダーを開く帯が無い');
  if (container.querySelector('.gap-y-0\\.5') === null) {
    await act(async () => {
      monthBar.click();
    });
  }
  const grid = container.querySelector('.gap-y-0\\.5');
  if (!grid) throw new Error('月のカレンダーが開かない');
  return grid.querySelectorAll(CALENDAR_DOT).length;
}

describe('献立表 (/menus/weekly) が AI 相談の成功で取り直すもの (#2195 V1)', () => {
  it('AI 相談が始めた表示中の週の献立の生成を見つけて監視し、終わったら作った献立を出す', async () => {
    const week = displayedWeekDates();
    const GENERATED_DISH = 'AI が作った肉じゃが';
    const REQUEST_ID = 'req-ai-week-1';
    await renderWeeklyPage();
    expect(container.textContent).not.toContain(GENERATED_DISH);
    const pendingChecksBefore = fetchCalls.filter((raw) => raw === `/api/ai/menu/weekly/pending?date=${week[0]}`).length;

    // AI 相談の generate_week_menu: 依頼の行 (processing) を作った時点で成功を知らせる。献立はまだ無い
    server.pendingRequest = {
      id: REQUEST_ID,
      startDate: week[0],
      generate: () => {
        for (const date of week) server.days.set(date, [{ id: `meal-${date}`, dishName: GENERATED_DISH }]);
      },
    };
    await notifyAiConsultationSucceeded('generate_week_menu', { startDate: week[0], requestId: REQUEST_ID, status: 'processing' });

    // 表示中の週の生成中の依頼をもう一度確かめ (週を開いたときの確認とは別に)、見つけた依頼を監視する (Realtime の購読と状態の確認)
    expect(fetchCalls.filter((raw) => raw === `/api/ai/menu/weekly/pending?date=${week[0]}`).length).toBeGreaterThan(pendingChecksBefore);
    expect(supabaseMock.channelNames).toContain(`menu-request-${REQUEST_ID}`);
    expect(fetchCalls).toContain(`/api/ai/menu/weekly/status?requestId=${REQUEST_ID}`);
    // 生成が終わったら、監視の側が献立を取り直して出す (読み込み直さなくてよい)
    expect(container.textContent).toContain(GENERATED_DISH);
  });

  it('AI 相談で買い物リストの最後の品目を消したら、バッジから消える (空のリストも置く)', async () => {
    const week = displayedWeekDates();
    server.days.set(week[0], [{ id: 'meal-1', dishName: '鮭の塩焼き' }]);
    server.shoppingItems = [{ id: 'item-1', itemName: 'にんじん', isChecked: false }];
    await renderWeeklyPage();
    expect(shoppingListButton().textContent).toBe('1');

    // AI 相談の delete_shopping_item
    server.shoppingItems = [];
    await notifyAiConsultationSucceeded('delete_shopping_item', { itemId: 'item-1', deleted: true });

    expect(shoppingListButton().textContent).toBe('');
    expect(useShoppingStore.getState().shoppingList).toEqual([]);
  });

  it('献立の無い週を出していても、AI 相談で買い物リストが変わったら置く', async () => {
    server.shoppingItems = [{ id: 'item-1', itemName: 'にんじん', isChecked: false }];
    await renderWeeklyPage();

    // AI 相談の add_to_shopping_list
    server.shoppingItems = [
      { id: 'item-1', itemName: 'にんじん', isChecked: false },
      { id: 'item-2', itemName: 'たまねぎ', isChecked: false },
    ];
    await notifyAiConsultationSucceeded('add_to_shopping_list', { added: 1 });

    expect(shoppingListButton().textContent).toBe('2');
  });

  it('AI 相談で食事を消して献立が無くなった日は、月のカレンダーの印が消える', async () => {
    const week = displayedWeekDates();
    server.days.set(week[0], [{ id: 'meal-1', dishName: '鮭の塩焼き' }]);
    server.days.set(week[1], [{ id: 'meal-2', dishName: '豚の生姜焼き' }]);
    await renderWeeklyPage();
    expect(await calendarMealDotCount()).toBe(2);

    // AI 相談の delete_meal: 食事の行だけを消す (その日の user_daily_meals の行は残る)
    server.days.set(week[1], []);
    await notifyAiConsultationSucceeded('delete_meal', { mealId: 'meal-2', deleted: true });

    expect(await calendarMealDotCount()).toBe(1);
  });

  it('AI 相談で表示中の月の別の週に献立を作ったら、月のカレンダーに印が出る (取得済みの月も読み直す)', async () => {
    await renderWeeklyPage();
    expect(await calendarMealDotCount()).toBe(0);
    const mealPlansCallsBefore = callsTo('/api/meal-plans');

    // AI 相談の generate_single_meal (表示中の週の外。月のカレンダーの範囲にだけ入る日) と update_meal (表示中の週) のあと
    server.days.set(otherWeekDateInDisplayedMonth(), [{ id: 'meal-other-week', dishName: 'カレー' }]);
    server.days.set(dateFromWeekStart(2), [{ id: 'meal-3', dishName: '親子丼' }]);
    await notifyAiConsultationSucceeded('update_meal', { mealId: 'meal-3' });

    // 表示中の週 + カレンダーの印の月 (表示中の週の前後・表示中の月にかかる月を、月ごとに 1 回。#2206 G1) を読み直す
    expect(callsTo('/api/meal-plans') - mealPlansCallsBefore).toBe(1 + calendarMonthsReadByRefetch());
    expect(await calendarMealDotCount()).toBe(2);
  });

  it('AI 相談で家族の人数が変わったら、人数の設定の無い人の既定の人数を取り直す', async () => {
    server.familySize = 2;
    await renderWeeklyPage();
    expect(useServingsConfigStore.getState().servingsConfig?.default).toBe(2);

    // AI 相談の update_profile_preferences (family_size)
    server.familySize = 4;
    await notifyAiConsultationSucceeded('update_profile_preferences', { updated: true, fields: ['family_size'] });

    expect(useServingsConfigStore.getState().servingsConfig?.default).toBe(4);
  });

  it('AI 相談で家族の人数を空にしたら (人数の設定も無い)、前の既定の人数を残さない', async () => {
    server.familySize = 2;
    await renderWeeklyPage();
    expect(useServingsConfigStore.getState().servingsConfig?.default).toBe(2);

    server.familySize = null;
    await notifyAiConsultationSucceeded('update_profile_preferences', { updated: true, fields: ['family_size'] });

    expect(useServingsConfigStore.getState().servingsConfig).toBeNull();
  });

  it('AI 相談でプロフィールの身長・体重を入れたら、プロフィールの帯の未入力の一覧から消える', async () => {
    supabaseMock.profile = incompleteProfile();
    await renderWeeklyPage();
    expect(profileBannerMissingLabels()).toEqual(['身長', '体重']);

    // AI 相談の update_profile_preferences (height・weight)。完成度 (profile_completeness) は AI 相談が書かないので変わらない
    supabaseMock.profile = { ...incompleteProfile(), height: 170, weight: 65 };
    await notifyAiConsultationSucceeded('update_profile_preferences', { updated: true, fields: ['height', 'weight'] });

    expect(profileBanner()).not.toBeNull();
    expect(profileBannerMissingLabels()).toEqual([]);
  });

  it('AI 相談のあとプロフィールの完成度が帯を出す値を超えていたら、帯を消す (前の帯を残さない)', async () => {
    supabaseMock.profile = incompleteProfile();
    await renderWeeklyPage();
    expect(profileBanner()).not.toBeNull();

    supabaseMock.profile = completeProfile();
    await notifyAiConsultationSucceeded('update_profile_preferences', { updated: true, fields: ['height', 'weight'] });

    expect(profileBanner()).toBeNull();
  });

  it('プロフィールの帯を閉じたあとは、AI 相談の取り直しでも帯を出さない', async () => {
    supabaseMock.profile = incompleteProfile();
    await renderWeeklyPage();
    const closeButton = profileBanner()?.querySelector<HTMLButtonElement>('button');
    if (!closeButton) throw new Error('プロフィールの帯の閉じるボタンが無い');
    await act(async () => {
      closeButton.click();
    });
    await settle();
    expect(profileBanner()).toBeNull();

    supabaseMock.profile = { ...incompleteProfile(), height: 170 };
    await notifyAiConsultationSucceeded('update_profile_preferences', { updated: true, fields: ['height'] });

    expect(profileBanner()).toBeNull();
  });

  it('家族に入っている人が AI 相談で自分の名前を変えたら、家族の切り替えの名前も取り直す (#2195 V1 R2)', async () => {
    supabaseMock.profile = { ...completeProfile(), family_id: FAMILY_ID };
    joinFamily(SELF_NAME_BEFORE);
    await renderWeeklyPage();
    expect(familySwitcherNames()).toEqual([SELF_NAME_BEFORE, OTHER_MEMBER_NAME]);

    // AI 相談の update_profile_preferences (nickname)。自分の family_members の行に display_name は無いので、
    // 名前の API は自分にプロフィールの今の名前を当てる
    server.familyMemberNames = [
      { id: SELF_MEMBER_ID, name: SELF_NAME_AFTER },
      { id: OTHER_MEMBER_ID, name: OTHER_MEMBER_NAME },
    ];
    await notifyAiConsultationSucceeded('update_profile_preferences', { updated: true, fields: ['nickname'] });

    expect(familySwitcherNames()).toEqual([SELF_NAME_AFTER, OTHER_MEMBER_NAME]);
  });
});

describe('献立表 (/menus/weekly) の取り直しの順序と失敗 (#2201 U1)', () => {
  it('取り直しの応答を待つあいだに週を移ったら、前の週の献立を新しい週の見出しの下に出さない', async () => {
    const THIS_WEEK_DISH = '今週の肉じゃが';
    const NEXT_WEEK_DISH = '翌週のカレーライス';
    for (let i = 0; i < DAYS_IN_WEEK; i += 1) {
      server.days.set(dateFromWeekStart(i), [{ id: `meal-this-${i}`, dishName: THIS_WEEK_DISH }]);
      server.days.set(dateFromWeekStart(DAYS_IN_WEEK + i), [{ id: `meal-next-${i}`, dishName: NEXT_WEEK_DISH }]);
    }
    await renderWeeklyPage();
    expect(container.textContent).toContain(THIS_WEEK_DISH);

    // AI 相談の成功の取り直し (表示中の週の献立) の応答が遅れる
    let release: () => void = () => undefined;
    server.mealPlansHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await notifyAiConsultationSucceeded('update_meal', { updated: true });
    server.mealPlansHold = null;

    // 応答を待つあいだに翌週へ移る
    const nextWeek = container.querySelector<HTMLButtonElement>('button[aria-label="翌週"]');
    expect(nextWeek, '「翌週」のボタンが無い').not.toBeNull();
    await act(async () => {
      nextWeek!.click();
    });
    await settle();
    expect(container.textContent).toContain(NEXT_WEEK_DISH);

    // 前の週の取り直しの応答が後から届いても、翌週の献立のまま
    await act(async () => {
      release();
    });
    await settle();
    expect(container.textContent).toContain(NEXT_WEEK_DISH);
    expect(container.textContent).not.toContain(THIS_WEEK_DISH);
  });

  it('翌週から戻った週の読み込みを待つあいだに、前にその週を開いたときの古い読み込みの応答が届いても、翌週の献立を読み込み中の表示なしで出さない', async () => {
    const THIS_WEEK_DISH = '今週のぶり大根';
    const NEXT_WEEK_DISH = '翌週の麻婆豆腐';
    for (let i = 0; i < DAYS_IN_WEEK; i += 1) {
      server.days.set(dateFromWeekStart(i), [{ id: `meal-this-${i}`, dishName: THIS_WEEK_DISH }]);
      server.days.set(dateFromWeekStart(DAYS_IN_WEEK + i), [{ id: `meal-next-${i}`, dishName: NEXT_WEEK_DISH }]);
    }
    // ?date= に表示中の週の日を渡して開く: 週の始まりの日を読んだあと、表示中の週の読み込みが 2 回走る (?date= の週に合わせ直すため)。
    // 1 回目の応答だけを遅らせる (2 回目の応答で週が出る)
    navigation.searchParams = new URLSearchParams({ date: dateFromWeekStart(0) });
    const firstLoad = heldResponse();
    server.mealPlansHoldOnce.set(displayedWeekRangeKey(), firstLoad.hold);
    await renderWeeklyPage();
    expect(server.mealPlansHoldOnce.size, '表示中の週の読み込みを止めていない (検査の前提が崩れた)').toBe(0);
    expect(container.textContent, '表示中の週の 2 回目の読み込みで週を出していない (検査の前提が崩れた)').toContain(THIS_WEEK_DISH);

    // 翌週へ移る
    const nextWeek = container.querySelector<HTMLButtonElement>('button[aria-label="翌週"]');
    expect(nextWeek, '「翌週」のボタンが無い').not.toBeNull();
    await act(async () => {
      nextWeek!.click();
    });
    await settle();
    expect(container.textContent).toContain(NEXT_WEEK_DISH);

    // 翌週を出している間に AI 相談が成功する: 週のキャッシュを捨てる (前の週に戻ると、その週を読み込む)
    await notifyAiConsultationSucceeded('update_meal', { updated: true });

    // 前の週に戻る: その週の読み込みの応答が遅れる (読み込み中の表示)
    const reload = heldResponse();
    server.mealPlansHoldOnce.set(displayedWeekRangeKey(), reload.hold);
    const previousWeek = container.querySelector<HTMLButtonElement>('button[aria-label="前の週"]');
    expect(previousWeek, '「前の週」のボタンが無い').not.toBeNull();
    await act(async () => {
      previousWeek!.click();
    });
    await settle();
    expect(weeklyPageIsLoading(), '戻った週の読み込み中の表示を出していない (検査の前提が崩れた)').toBe(true);

    // 最初に開いたときの 1 回目の読み込みの応答が届く: その週のもっと新しい応答 (2 回目) を前に置いたので置かない。
    // 献立はそのあとに翌週のものを置いたので、読み込み中の表示も下ろさない (下ろすと、戻った週の見出しの下に翌週の献立が出る)
    await act(async () => {
      firstLoad.release();
    });
    await settle();
    expect(
      weeklyPageIsLoading() || (container.textContent ?? '').includes(THIS_WEEK_DISH),
      '戻った週の見出しの下に、翌週の献立を読み込み中の表示なしで出した',
    ).toBe(true);

    await act(async () => {
      reload.release();
    });
    await settle();
    expect(weeklyPageIsLoading()).toBe(false);
    expect(container.textContent).toContain(THIS_WEEK_DISH);
    expect(container.textContent).not.toContain(NEXT_WEEK_DISH);
  });

  it('開いたときの週の読み込みの応答を待つあいだに取り直しの献立が先に届いたら、読み込み中の表示を下ろし、あとから届いた週の読み込みの応答で古い献立に戻さない', async () => {
    const BEFORE_DISH = '前の鮭の塩焼き';
    const AI_DISH = 'AI が変えた親子丼';
    for (let i = 0; i < DAYS_IN_WEEK; i += 1) server.days.set(dateFromWeekStart(i), [{ id: `meal-${i}`, dishName: BEFORE_DISH }]);
    // 開いたときの表示中の週の読み込みの応答を止める (読み込み中の表示のまま)
    const firstLoad = heldResponse();
    server.mealPlansHoldOnce.set(displayedWeekRangeKey(), firstLoad.hold);
    await renderWeeklyPage();
    expect(server.mealPlansHoldOnce.size, '表示中の週の読み込みを止めていない (検査の前提が崩れた)').toBe(0);
    expect(weeklyPageIsLoading(), '週の読み込み中の表示を出していない (検査の前提が崩れた)').toBe(true);

    // その間に AI 相談が成功し、取り直しの献立 (AI の変えた献立) が先に届く。この週の献立を置いたので、読み込み中の表示を下ろす
    // (週の読み込みの応答はこれより前に始めたので置かず、読み込み中の表示にも触れない。下ろすのは取り直しだけ)
    for (let i = 0; i < DAYS_IN_WEEK; i += 1) server.days.set(dateFromWeekStart(i), [{ id: `meal-${i}`, dishName: AI_DISH }]);
    await notifyAiConsultationSucceeded('update_meal', { updated: true });
    expect(weeklyPageIsLoading(), '取り直しの献立を置いたのに、読み込み中の表示のまま').toBe(false);
    expect(container.textContent).toContain(AI_DISH);

    // 先に始めた週の読み込みの応答 (AI 相談の前の献立) が後から届く
    await act(async () => {
      firstLoad.release();
    });
    await settle();
    expect(weeklyPageIsLoading()).toBe(false);
    expect(container.textContent, '先に始めた週の読み込みの古い応答で、取り直しの献立を戻した').toContain(AI_DISH);
    expect(container.textContent).not.toContain(BEFORE_DISH);
  });

  it('開いたときの週の読み込みの応答が取り直しより後に届いても、その古い応答を週のキャッシュに書かない (翌週から戻っても取り直しの献立のまま)', async () => {
    const BEFORE_DISH = '前の鮭の塩焼き';
    const AI_DISH = 'AI が変えた親子丼';
    const NEXT_WEEK_DISH = '翌週のけんちん汁';
    for (let i = 0; i < DAYS_IN_WEEK; i += 1) {
      server.days.set(dateFromWeekStart(i), [{ id: `meal-${i}`, dishName: BEFORE_DISH }]);
      server.days.set(dateFromWeekStart(DAYS_IN_WEEK + i), [{ id: `meal-next-${i}`, dishName: NEXT_WEEK_DISH }]);
    }
    // 開いたときの表示中の週の読み込みの応答を止める
    const firstLoad = heldResponse();
    server.mealPlansHoldOnce.set(displayedWeekRangeKey(), firstLoad.hold);
    await renderWeeklyPage();
    expect(server.mealPlansHoldOnce.size, '表示中の週の読み込みを止めていない (検査の前提が崩れた)').toBe(0);

    // その間に AI 相談が成功し、取り直しの献立 (AI の変えた献立) が先に届く (週のキャッシュも取り直しの献立にする)
    for (let i = 0; i < DAYS_IN_WEEK; i += 1) server.days.set(dateFromWeekStart(i), [{ id: `meal-${i}`, dishName: AI_DISH }]);
    await notifyAiConsultationSucceeded('update_meal', { updated: true });
    expect(container.textContent).toContain(AI_DISH);

    // 先に始めた週の読み込みの応答 (AI 相談の前の献立) が後から届く: 画面にも週のキャッシュにも置かない
    await act(async () => {
      firstLoad.release();
    });
    await settle();
    expect(container.textContent).toContain(AI_DISH);

    // 翌週へ移って戻る (戻った週はキャッシュの有効期限の中)
    const nextWeek = container.querySelector<HTMLButtonElement>('button[aria-label="翌週"]');
    expect(nextWeek, '「翌週」のボタンが無い').not.toBeNull();
    await act(async () => {
      nextWeek!.click();
    });
    await settle();
    expect(container.textContent, '翌週へ移っていない (検査の前提が崩れた)').toContain(NEXT_WEEK_DISH);
    const previousWeek = container.querySelector<HTMLButtonElement>('button[aria-label="前の週"]');
    expect(previousWeek, '「前の週」のボタンが無い').not.toBeNull();
    await act(async () => {
      previousWeek!.click();
    });
    await settle();
    expect(container.textContent, '古い週の読み込みの応答を週のキャッシュに書き、戻った週に AI 相談の前の献立を出した').toContain(AI_DISH);
    expect(container.textContent).not.toContain(BEFORE_DISH);
  });

  it('取り直しの前に始めた翌週の先読みの応答が取り直しのあとに届いても、週のキャッシュに書かない (翌週へ移ったら AI 相談の後の献立を出す)', async () => {
    const THIS_WEEK_DISH = '今週の鯖の味噌煮';
    const NEXT_WEEK_BEFORE_DISH = '翌週の前のハンバーグ';
    const NEXT_WEEK_AI_DISH = '翌週の AI が変えた豆腐ハンバーグ';
    /** 翌週の献立の読み込み (翌週の初日から 7 日。先読み・翌週へ移ったときの読み込みの範囲) の鍵 */
    const nextWeekRangeKey = mealPlansRangeKey(dateFromWeekStart(DAYS_IN_WEEK), dateFromWeekStart(DAYS_IN_WEEK * 2 - 1));
    for (let i = 0; i < DAYS_IN_WEEK; i += 1) {
      server.days.set(dateFromWeekStart(i), [{ id: `meal-this-${i}`, dishName: THIS_WEEK_DISH }]);
      server.days.set(dateFromWeekStart(DAYS_IN_WEEK + i), [{ id: `meal-next-${i}`, dishName: NEXT_WEEK_BEFORE_DISH }]);
    }
    // 開いたあとの翌週の先読みの応答を止める
    const prefetch = heldResponse();
    server.mealPlansHoldOnce.set(nextWeekRangeKey, prefetch.hold);
    await renderWeeklyPage();
    expect(server.mealPlansHoldOnce.size, '翌週の先読みを止めていない (検査の前提が崩れた)').toBe(0);
    expect(container.textContent).toContain(THIS_WEEK_DISH);

    // AI 相談が翌週の献立を変える: 取り直しは週のキャッシュを捨てる
    for (let i = 0; i < DAYS_IN_WEEK; i += 1) {
      server.days.set(dateFromWeekStart(DAYS_IN_WEEK + i), [{ id: `meal-next-${i}`, dishName: NEXT_WEEK_AI_DISH }]);
    }
    await notifyAiConsultationSucceeded('update_meal', { updated: true });

    // 捨てる前に始めた先読みの応答 (AI 相談の前の翌週の献立) が後から届く
    await act(async () => {
      prefetch.release();
    });
    await settle();

    const nextWeek = container.querySelector<HTMLButtonElement>('button[aria-label="翌週"]');
    expect(nextWeek, '「翌週」のボタンが無い').not.toBeNull();
    await act(async () => {
      nextWeek!.click();
    });
    await settle();
    expect(container.textContent, '捨てる前に始めた先読みの応答を週のキャッシュに書き、AI 相談の前の翌週の献立を出した').toContain(NEXT_WEEK_AI_DISH);
    expect(container.textContent).not.toContain(NEXT_WEEK_BEFORE_DISH);
  });

  it('週を移った直後 (週の読み込みの応答待ち) に来た成功の取り直しが失敗しても、前の週の献立を新しい週の見出しの下に残さない', async () => {
    const THIS_WEEK_DISH = '今週の筑前煮';
    const NEXT_WEEK_DISH = '翌週の豚汁';
    for (let i = 0; i < DAYS_IN_WEEK; i += 1) {
      server.days.set(dateFromWeekStart(i), [{ id: `meal-this-${i}`, dishName: THIS_WEEK_DISH }]);
      server.days.set(dateFromWeekStart(DAYS_IN_WEEK + i), [{ id: `meal-next-${i}`, dishName: NEXT_WEEK_DISH }]);
    }
    await renderWeeklyPage();
    expect(container.textContent).toContain(THIS_WEEK_DISH);
    // 取り直しは週のキャッシュを捨てる: 翌週へ移ると、翌週の献立を読みに行く (先読みのキャッシュで済ませない)
    await notifyAiConsultationSucceeded('update_meal', { updated: true });

    // 翌週の読み込みの応答が遅れる
    let release: () => void = () => undefined;
    server.mealPlansHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nextWeek = container.querySelector<HTMLButtonElement>('button[aria-label="翌週"]');
    expect(nextWeek, '「翌週」のボタンが無い').not.toBeNull();
    await act(async () => {
      nextWeek!.click();
    });
    await settle();
    server.mealPlansHold = null;

    // 応答を待つあいだに成功が来て、その取り直し (翌週の献立) が失敗する
    server.mealPlansFail = true;
    await notifyAiConsultationSucceeded('update_meal', { updated: true });
    server.mealPlansFail = false;

    // 先に始めた翌週の読み込みの応答 (読めた) が届いたら、翌週の献立を出す
    await act(async () => {
      release();
    });
    await settle();
    expect(container.textContent, '取り直しの失敗で、翌週の読み込みの応答まで捨てた').toContain(NEXT_WEEK_DISH);
    expect(container.textContent).not.toContain(THIS_WEEK_DISH);
  });

  it('続けて来た成功の、先の取り直しの応答が後から届いても、あとの取り直しの献立とカレンダーの印を古い答えで上書きしない', async () => {
    const OLD_DISH = '前の親子丼';
    const NEW_DISH = '新しい親子丼';
    for (let i = 0; i < DAYS_IN_WEEK; i += 1) server.days.set(dateFromWeekStart(i), [{ id: `meal-${i}`, dishName: OLD_DISH }]);
    await renderWeeklyPage();
    expect(container.textContent).toContain(OLD_DISH);
    expect(await calendarMealDotCount()).toBe(DAYS_IN_WEEK);

    // 1 回目の成功の取り直し (表示中の週・月のカレンダーの範囲) は、前の答えを読んで応答が遅れる
    let release: () => void = () => undefined;
    server.mealPlansHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await notifyAiConsultationSucceeded('update_meal', { updated: true });
    server.mealPlansHold = null;

    // 2 回目の成功 (AI 相談が表示中の週の献立を変え、表示中の月の別の週に献立を足した) の取り直しは先に届く
    for (let i = 0; i < DAYS_IN_WEEK; i += 1) server.days.set(dateFromWeekStart(i), [{ id: `meal-${i}`, dishName: NEW_DISH }]);
    server.days.set(otherWeekDateInDisplayedMonth(), [{ id: 'meal-other-week', dishName: 'カレー' }]);
    await notifyAiConsultationSucceeded('update_meal', { updated: true });
    expect(container.textContent).toContain(NEW_DISH);
    expect(await calendarMealDotCount()).toBe(DAYS_IN_WEEK + 1);

    await act(async () => {
      release();
    });
    await settle();
    expect(container.textContent).toContain(NEW_DISH);
    expect(container.textContent).not.toContain(OLD_DISH);
    expect(await calendarMealDotCount(), '古い応答が、あとから足した日の印を消した').toBe(DAYS_IN_WEEK + 1);
  });

  it('続けて来た成功の、先の取り直しの冷蔵庫と人数の設定の応答が後から届いても、あとの取り直しの答えを古い答えで上書きしない', async () => {
    server.pantryItems = [PANTRY_ITEM_BEFORE];
    server.familySize = FAMILY_SIZE_BEFORE;
    await renderWeeklyPage();
    expect(fridgeItemNames()).toEqual([PANTRY_ITEM_BEFORE.name]);
    expect(useServingsConfigStore.getState().servingsConfig?.default).toBe(FAMILY_SIZE_BEFORE);

    // 1 回目の成功の取り直しは、前の答え (冷蔵庫・家族の人数) を読んで応答が遅れる
    const first = heldResponse();
    server.pantryHold = first.hold;
    server.profileHold = first.hold;
    await notifyAiConsultationSucceeded('add_pantry_item', { success: true });
    server.pantryHold = null;
    server.profileHold = null;

    // 2 回目の成功 (AI 相談が冷蔵庫と家族の人数を変えた) の取り直しは先に届く
    server.pantryItems = [PANTRY_ITEM_AFTER];
    server.familySize = FAMILY_SIZE_AFTER;
    await notifyAiConsultationSucceeded('update_profile_preferences', { updated: true, fields: ['family_size'] });
    expect(fridgeItemNames()).toEqual([PANTRY_ITEM_AFTER.name]);
    expect(useServingsConfigStore.getState().servingsConfig?.default).toBe(FAMILY_SIZE_AFTER);

    await act(async () => {
      first.release();
    });
    await settle();
    expect(fridgeItemNames(), '先の取り直しの古い応答が、冷蔵庫の一覧を戻した').toEqual([PANTRY_ITEM_AFTER.name]);
    expect(useServingsConfigStore.getState().servingsConfig?.default, '先の取り直しの古い応答が、人数を戻した').toBe(FAMILY_SIZE_AFTER);
  });

  it('開いたときの冷蔵庫と人数の設定の読み込みの応答が取り直しの応答より後に届いても、取り直しの答えを古い答えで上書きしない', async () => {
    server.pantryItems = [PANTRY_ITEM_BEFORE];
    server.familySize = FAMILY_SIZE_BEFORE;
    // 開いたときの冷蔵庫と人数の設定の読み込みは、前の答えを読んで応答が遅れる
    const mount = heldResponse();
    server.pantryHold = mount.hold;
    server.profileHold = mount.hold;
    await renderWeeklyPage();
    server.pantryHold = null;
    server.profileHold = null;
    expect(callsTo('/api/pantry'), '開いたときに冷蔵庫を読んでいない (検査が空振りしている)').toBe(1);

    // 応答を待つあいだに成功が来て (AI 相談が冷蔵庫と家族の人数を変えた)、その取り直しが先に届く
    server.pantryItems = [PANTRY_ITEM_AFTER];
    server.familySize = FAMILY_SIZE_AFTER;
    await notifyAiConsultationSucceeded('add_pantry_item', { success: true });
    expect(fridgeItemNames()).toEqual([PANTRY_ITEM_AFTER.name]);
    expect(useServingsConfigStore.getState().servingsConfig?.default).toBe(FAMILY_SIZE_AFTER);

    await act(async () => {
      mount.release();
    });
    await settle();
    expect(fridgeItemNames(), '開いたときの古い応答が、取り直しの冷蔵庫の一覧を戻した').toEqual([PANTRY_ITEM_AFTER.name]);
    expect(useServingsConfigStore.getState().servingsConfig?.default, '開いたときの古い応答が、取り直しの人数を戻した').toBe(FAMILY_SIZE_AFTER);
  });

  it('人数の設定の読み込み中の印は、人数を置いたら下ろす (先に届いた応答を置き、あとの応答で置き換える)', async () => {
    // 開いたときの人数の設定の読み込みの応答を止める (読み込み中の印が立つ)
    server.familySize = FAMILY_SIZE_BEFORE;
    const first = heldResponse();
    server.profileHold = first.hold;
    await renderWeeklyPage();
    server.profileHold = null;
    expect(useServingsConfigStore.getState().isLoadingServingsConfig, '開いたときの読み込み中の印が立っていない (検査の前提が崩れた)').toBe(true);

    // その間に AI 相談が家族の人数を変える。取り直しの応答も止める (取り直しは読み込み中の印を立てない・引き継がない。#2206 G1)
    server.familySize = FAMILY_SIZE_AFTER;
    const second = heldResponse();
    server.profileHold = second.hold;
    await notifyAiConsultationSucceeded('update_profile_preferences', { updated: true, fields: ['family_size'] });
    server.profileHold = null;
    expect(useServingsConfigStore.getState().isLoadingServingsConfig).toBe(true);

    // 先に始めた開いたときの読み込みの応答が先に届く: 人数を置いて読み込み中の印を下ろす
    await act(async () => {
      first.release();
    });
    await settle();
    expect(useServingsConfigStore.getState().servingsConfig?.default).toBe(FAMILY_SIZE_BEFORE);
    expect(useServingsConfigStore.getState().isLoadingServingsConfig, '人数を置いたのに読み込み中の印を下ろしていない').toBe(false);

    // あとに始めた取り直しの応答が届く: 新しい人数で置き換え、読み込み中の印は下りたまま
    await act(async () => {
      second.release();
    });
    await settle();
    expect(useServingsConfigStore.getState().servingsConfig?.default).toBe(FAMILY_SIZE_AFTER);
    expect(useServingsConfigStore.getState().isLoadingServingsConfig).toBe(false);
  });

  it('食事の完了の切り替えの応答を待つあいだに来た成功では取り直さず (#2201 U2)、終わったら 1 回取り直す', async () => {
    /** 完了の切り替えの待ち (ページの toggleMealCompletion の 250ms) より長い待ち */
    const TOGGLE_DEBOUNCE_WAIT_MS = 300;
    const today = formatLocalDate(new Date());
    server.days.set(today, [{ id: 'meal-today', dishName: '鮭の塩焼き' }]);
    await renderWeeklyPage();
    const toggle = container.querySelector<HTMLButtonElement>('button.w-7.h-7.rounded-full');
    expect(toggle, '今日の食事の完了の切り替えが無い').not.toBeNull();

    let release: () => void = () => undefined;
    server.mealPatchHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await act(async () => {
      toggle!.click();
      await new Promise((resolve) => setTimeout(resolve, TOGGLE_DEBOUNCE_WAIT_MS));
    });
    expect(fetchCalls.some((raw) => raw.startsWith(MEAL_PATCH_PATH_PREFIX)), '完了の切り替えを送っていない (検査が空振りしている)').toBe(true);

    const mealPlansCallsBefore = callsTo('/api/meal-plans');
    await notifyAiConsultationSucceeded('update_meal', { updated: true });
    await notifyAiConsultationSucceeded('update_meal', { updated: true });
    expect(callsTo('/api/meal-plans') - mealPlansCallsBefore, '書き込みの応答を待つあいだに取り直した').toBe(0);

    await act(async () => {
      release();
    });
    await settle();
    // 止めた成功のぶん 1 回 (表示中の週 + 月のカレンダーの印の月。#2206 G1)
    expect(callsTo('/api/meal-plans') - mealPlansCallsBefore, '書き込みが終わっても、止めた成功を 1 回取り直さない').toBe(
      1 + calendarMonthsReadByRefetch(),
    );
  });

  it('取り直しの応答を待つあいだに買い物リストの品目をチェックしたら、チェックの前に読んだ応答でチェックを外さない (#2201 U2)', async () => {
    const ITEM = { id: 'item-1', itemName: 'にんじん', isChecked: false };
    server.days.set(displayedWeekDates()[0], [{ id: 'meal-1', dishName: '鮭の塩焼き' }]);
    server.shoppingItems = [ITEM];
    await renderWeeklyPage();
    const shoppingItemChecked = () => useShoppingStore.getState().shoppingList.find((item) => item.id === ITEM.id)?.isChecked;
    expect(shoppingItemChecked(), '買い物リストの品目が出ていない (検査が空振りしている)').toBe(false);

    // 取り直しの献立と買い物リストの読み取り (GET /api/meal-plans) の応答を止める (応答は読み取りを始めたときの答え = チェックの前)
    let release: () => void = () => undefined;
    server.mealPlansHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mealPlansCallsBefore = callsTo('/api/meal-plans');
    await notifyAiConsultationSucceeded('update_meal', { updated: true });
    server.mealPlansHold = null;
    expect(callsTo('/api/meal-plans') - mealPlansCallsBefore, '取り直しが献立と買い物リストを読んでいない (検査が空振りしている)').toBeGreaterThan(0);

    // 応答を待つあいだに買い物リストを開いて品目をチェックする (書き込みが終わる)
    await act(async () => {
      shoppingListButton().click();
    });
    const check = container.querySelector<HTMLButtonElement>(`button[aria-label="${ITEM.itemName}を購入済みにする"]`);
    if (!check) throw new Error('買い物リストの品目のチェックのボタンが無い');
    await act(async () => {
      check.click();
    });
    await settle();
    expect(server.shoppingItems[0].isChecked, 'チェックを送っていない (検査が空振りしている)').toBe(true);
    expect(shoppingItemChecked()).toBe(true);

    await act(async () => {
      release();
    });
    await settle();
    expect(shoppingItemChecked(), 'チェックの前に読んだ取り直しの応答が、チェックを外した').toBe(true);
  });

  it('取り直しの応答を待つあいだに食事の完了を切り替えて終えていても、切り替えの前に読んだ応答で完了を戻さず、読み直す (#2201 U2)', async () => {
    /** 完了の切り替えの待ち (ページの toggleMealCompletion の 250ms) より長い待ち */
    const TOGGLE_DEBOUNCE_WAIT_MS = 300;
    const today = formatLocalDate(new Date());
    server.days.set(today, [{ id: 'meal-today', dishName: '鮭の塩焼き' }]);
    await renderWeeklyPage();
    const toggle = () => container.querySelector<HTMLButtonElement>('button.w-7.h-7.rounded-full');
    expect(toggle(), '今日の食事の完了の切り替えが無い').not.toBeNull();
    /** 完了の印 (チェックの絵) が出ているか */
    const shownCompleted = () => toggle()!.querySelector('svg') !== null;
    expect(shownCompleted()).toBe(false);

    // 取り直しの献立の読み取りの応答を止める (応答は読み取りを始めたときの答え = 未完了)
    let release: () => void = () => undefined;
    server.mealPlansHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await notifyAiConsultationSucceeded('update_meal', { updated: true });
    server.mealPlansHold = null;

    // 応答を待つあいだに完了にし、書き込みが終わる (サーバーも完了になる)
    await act(async () => {
      toggle()!.click();
      await new Promise((resolve) => setTimeout(resolve, TOGGLE_DEBOUNCE_WAIT_MS));
    });
    await settle();
    expect(server.days.get(today)?.[0].isCompleted, '完了の切り替えを送っていない (検査が空振りしている)').toBe(true);
    expect(shownCompleted()).toBe(true);

    const displayedWeekReadsBeforeRelease = mealPlansCallsFor(displayedWeekRangeKey());
    await act(async () => {
      release();
    });
    await settle();
    expect(shownCompleted(), '切り替えの前に読んだ取り直しの応答が、完了を戻した').toBe(true);
    // 置かなかった応答のぶん 1 回読み直す (表示中の週をもう 1 回読む。#2206 G1: 月のカレンダーの印は月ごとに順に読むので、止めていた
    // 取り直しの残りの月も解いたあとに読む。読み直しの回数は表示中の週の読み取りで数える)
    expect(mealPlansCallsFor(displayedWeekRangeKey()) - displayedWeekReadsBeforeRelease, '置かなかった応答のぶん読み直していない').toBe(1);
  });

  it('食事の完了の切り替えの待ち (250ms) のあいだに取り直しが置いた献立を、切り替えの楽観的な更新で古い献立に戻さない (#2201 U2)', async () => {
    const BEFORE_DISH = '鮭の塩焼き';
    const AI_DISH = 'AI が変えた親子丼';
    const today = formatLocalDate(new Date());
    server.days.set(today, [{ id: 'meal-today', dishName: BEFORE_DISH }]);
    await renderWeeklyPage();
    const toggle = () => container.querySelector<HTMLButtonElement>('button.w-7.h-7.rounded-full');
    expect(toggle(), '今日の食事の完了の切り替えが無い').not.toBeNull();
    /** 完了の印 (チェックの絵) が出ているか */
    const shownCompleted = () => toggle()!.querySelector('svg') !== null;
    expect(shownCompleted()).toBe(false);

    // 完了を押す: 250ms 待ってから楽観的な更新と書き込みをする (待ちを止める)
    const finishToggleWait = await holdToggleDebounce(() => toggle()!.click());

    // 待ちのあいだに AI 相談が成功し、取り直しが AI の変えた献立を置く
    server.days.set(today, [{ id: 'meal-today', dishName: AI_DISH }]);
    await notifyAiConsultationSucceeded('update_meal', { updated: true });
    expect(container.textContent, '取り直しが AI の変えた献立を置いていない (検査が空振りしている)').toContain(AI_DISH);
    expect(fetchCalls.some((raw) => raw.startsWith(MEAL_PATCH_PATH_PREFIX)), '切り替えの待ちが終わっている (検査の前提が崩れた)').toBe(false);

    // 待ちが終わる: 楽観的な更新と書き込み (成功)。書き込みの間に来た成功は無いので、このあと取り直さない
    const mealPlansCallsBefore = callsTo('/api/meal-plans');
    await finishToggleWait();
    expect(fetchCalls.some((raw) => raw.startsWith(MEAL_PATCH_PATH_PREFIX)), '完了の切り替えを送っていない (検査が空振りしている)').toBe(true);
    expect(server.days.get(today)?.[0].isCompleted).toBe(true);
    expect(callsTo('/api/meal-plans') - mealPlansCallsBefore).toBe(0);
    expect(shownCompleted()).toBe(true);
    expect(container.textContent, '切り替えの楽観的な更新が、待ちのあいだに取り直しが置いた献立を古い献立で戻した').toContain(AI_DISH);
    expect(container.textContent).not.toContain(BEFORE_DISH);
  });

  it('食事の完了の切り替えの書き込みが失敗したら、その食事の完了だけを戻し、待ちのあいだに取り直しが置いた献立は残す (#2201 U2)', async () => {
    const BEFORE_DISH = '鮭の塩焼き';
    const AI_DISH = 'AI が変えた親子丼';
    const today = formatLocalDate(new Date());
    server.days.set(today, [{ id: 'meal-today', dishName: BEFORE_DISH }]);
    await renderWeeklyPage();
    const toggle = () => container.querySelector<HTMLButtonElement>('button.w-7.h-7.rounded-full');
    const shownCompleted = () => toggle()!.querySelector('svg') !== null;
    expect(shownCompleted()).toBe(false);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const finishToggleWait = await holdToggleDebounce(() => toggle()!.click());
    server.days.set(today, [{ id: 'meal-today', dishName: AI_DISH }]);
    await notifyAiConsultationSucceeded('update_meal', { updated: true });
    expect(container.textContent, '取り直しが AI の変えた献立を置いていない (検査が空振りしている)').toContain(AI_DISH);

    // 書き込みが失敗する
    server.mealPatchFails = true;
    await finishToggleWait();
    expect(alertSpy, '書き込みの失敗を出していない (検査が空振りしている)').toHaveBeenCalled();
    expect(shownCompleted(), '失敗した完了の切り替えを戻していない').toBe(false);
    expect(container.textContent, '失敗の巻き戻しが、待ちのあいだに取り直しが置いた献立を古い献立で戻した').toContain(AI_DISH);
    expect(container.textContent).not.toContain(BEFORE_DISH);
  });

  it('取り直しで名前の API を読めなかったら、家族の切り替えの名前を残す', async () => {
    supabaseMock.profile = { ...completeProfile(), family_id: FAMILY_ID };
    joinFamily(SELF_NAME_BEFORE);
    await renderWeeklyPage();
    expect(familySwitcherNames()).toEqual([SELF_NAME_BEFORE, OTHER_MEMBER_NAME]);

    server.namesFail = true;
    await notifyAiConsultationSucceeded('update_profile_preferences', { updated: true, fields: ['nickname'] });
    expect(familySwitcherNames()).toEqual([SELF_NAME_BEFORE, OTHER_MEMBER_NAME]);
  });

  it('取り直しで自分のプロフィールを読めなかったら、家族の切り替えを消さない', async () => {
    supabaseMock.profile = { ...completeProfile(), family_id: FAMILY_ID };
    joinFamily(SELF_NAME_BEFORE);
    await renderWeeklyPage();
    expect(familySwitcherNames()).toEqual([SELF_NAME_BEFORE, OTHER_MEMBER_NAME]);

    supabaseMock.profileFails = true;
    await notifyAiConsultationSucceeded('update_profile_preferences', { updated: true, fields: ['nickname'] });
    expect(familySwitcherNames()).toEqual([SELF_NAME_BEFORE, OTHER_MEMBER_NAME]);
  });
});

describe('献立表 (/menus/weekly) を描画して、AI 相談の成功の取り直しを確かめる (#2195 V1)', () => {
  /**
   * AI が書く表に中身のある答え (表示中の週と別の週の献立・買い物リスト・家族の人数・プロフィールの未入力の欄・自分の名前)。
   * 家族に入っている (自分ともう 1 人): 家族の一覧の答えで決まる読み取り (名前の API・家族の献立) を開いたときの読み取りに出す
   */
  function fillServer() {
    supabaseMock.profile = { ...incompleteProfile(), family_id: FAMILY_ID };
    joinFamily(SELF_NAME_BEFORE);
    const week = displayedWeekDates();
    server.days.set(week[0], [{ id: 'meal-1', dishName: '鮭の塩焼き' }]);
    server.days.set(otherWeekDateInDisplayedMonth(), [{ id: 'meal-other', dishName: 'カレー' }]);
    server.shoppingItems = [{ id: 'item-1', itemName: 'にんじん', isChecked: false }];
    server.familySize = 3;
  }
  /**
   * AI 相談で消した・空にしたあと (プロフィールは未入力の欄が無くなり、帯を出さない。自分の名前は決まらない)。
   * 家族の所属と一覧は AI 相談が書かないので変えない
   */
  function emptyServer() {
    supabaseMock.profile = { ...completeProfile(), family_id: FAMILY_ID };
    joinFamily(null);
    server.days = new Map();
    server.shoppingItems = [];
    server.familySize = null;
  }

  it('開いたとき・月のカレンダーのパネル・プロフィールの帯・家族の切り替えが読むもの全部を、取り直しも読む', async () => {
    fillServer();
    recorder.take();
    await renderWeeklyPage();
    await calendarMealDotCount();
    await settle();
    // 帯が出ている (帯の読み取りが開いたときの読み取りに入っている)
    expect(profileBanner()).not.toBeNull();
    const mountReads = recorder.take();
    await notifyAiConsultationSucceeded('update_meal', { mealId: 'meal-1' });
    const refetchReads = recorder.take();
    // 前後の週の先読み (表の mountReadsNotRefetched の adjacentWeekPrefetch)
    const weekRangeKey = (from: number) =>
      fetchReadKey(`/api/meal-plans?startDate=${dateFromWeekStart(from)}&endDate=${dateFromWeekStart(from + DAYS_IN_WEEK - 1)}`) ?? '';
    // 週の始まりの日 (表の mountReadsNotRefetched の weekStartDay)。AI 相談が書かない列
    const WEEK_START_DAY_COLUMN = 'week_start_day';
    expect(AI_CONSULTATION_WRITTEN_COLUMNS.user_profiles).not.toContain(WEEK_START_DAY_COLUMN);
    // 家族の献立 (表の mountReadsNotRefetched の familyMenu。自分以外のメンバーの献立)
    const familyMenuKey =
      fetchReadKey(`/api/family/menu?startDate=${dateFromWeekStart(0)}&endDate=${dateFromWeekStart(DAYS_IN_WEEK - 1)}`) ?? '';
    // 家族の一覧の答えで決まる読み取りが、開いたときの読み取りに出ている (応答の作りで隠れていない)。
    // 家族の所属・一覧・名前の API は取り直しも読む (名前の API はプロフィールの名前 = AI 相談が書く nickname を当てる)
    const familyReads = [
      selectReadKey('user_profiles', 'family_id'),
      selectReadKey('family_members', '*'),
      fetchReadKey('/api/family/members/names') ?? '',
    ];
    expect([...mountReads]).toEqual(expect.arrayContaining([...familyReads, familyMenuKey]));
    expect([...refetchReads]).toEqual(expect.arrayContaining(familyReads));
    expectRefetchReadsCoverMount('/menus/weekly', mountReads, refetchReads, {
      adjacentWeekPrefetch: [weekRangeKey(-DAYS_IN_WEEK), weekRangeKey(DAYS_IN_WEEK)],
      weekStartDay: [selectReadKey('user_profiles', WEEK_START_DAY_COLUMN)],
      familyMenu: [familyMenuKey],
    });
  });

  it('AI が書く表の答えが空になった取り直しは、空の答えで開いたときと同じ画面 (前の値を残さない)', async () => {
    fillServer();
    await renderWeeklyPage();
    await calendarMealDotCount();
    const full = screenSignature(container);

    emptyServer();
    await notifyAiConsultationSucceeded('delete_meal', { mealId: 'meal-1', deleted: true });
    const refetchedToEmpty = screenSignature(container);

    await act(async () => {
      root.unmount();
    });
    // 献立表の store はモジュールに 1 つなので、読み込み直したとき (新しいページ) と同じく空に戻してから開く
    useShoppingStore.getState().setShoppingList([]);
    usePantryStore.getState().setFridgeItems([]);
    useServingsConfigStore.getState().setServingsConfig(null);
    root = createRoot(container);
    await renderWeeklyPage();
    await calendarMealDotCount();
    const freshEmpty = screenSignature(container);
    expectEmptyRefetchMatchesFreshMount('/menus/weekly', { full, refetchedToEmpty, freshEmpty });
  });
});

describe('献立表 (/menus/weekly) は、AI 相談が始めた献立の生成が終わったときにも取り直す (#2195 V1 の整合ゲートの是正)', () => {
  /** 表示中の週の初日でない日 (水曜。週の初日から始めた生成だけを見つけるページの生成中の依頼の確認では見つからない日) */
  const NOT_WEEK_START_OFFSET = 2;
  /** 1 食の生成の日 (木曜。週の初日でない日) */
  const SINGLE_MEAL_OFFSET = 3;

  /** 日付のタブを押してその日を出す */
  async function selectDay(date: string) {
    const tab = container.querySelector<HTMLButtonElement>(`button[aria-label^="${formatDateJa(date)} "]`);
    if (!tab) throw new Error(`日付のタブが無い: ${date}`);
    await act(async () => {
      tab.click();
    });
    await settle();
  }

  /** 生成の状態を確かめる間隔だけ時計を進める (setInterval だけ偽の時計) */
  async function advanceGenerationWatch() {
    await act(async () => {
      vi.advanceTimersByTime(AI_CONSULTATION_GENERATION_WATCH_INTERVAL_MS);
    });
    await settle();
  }

  /**
   * AI 相談の生成の受付を知らせ (献立はまだ無い)、生成の状態の確認で終わらせて、作った献立が出るかを返す。
   * 生成中の依頼の確認 (GET /api/ai/menu/weekly/pending) は、開始日が表示中の週の初日の依頼しか返さない (この日では見つからない)
   */
  async function generateAndComplete(params: { actionType: string; date: string; dish: string; result: Record<string, unknown>; requestId: string }) {
    server.pendingRequest = {
      id: params.requestId,
      startDate: params.date,
      generate: () => server.days.set(params.date, [{ id: `meal-${params.date}`, dishName: params.dish }]),
    };
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await notifyAiConsultationSucceeded(params.actionType, params.result);
      // 受付の取り直しでは、献立はまだ無い
      expect(container.textContent).not.toContain(params.dish);
      expect(fetchCalls).not.toContain(`/api/ai/menu/weekly/status?requestId=${params.requestId}`);
      // 生成の状態を確かめると、生成が終わっている (献立を書いてから completed)
      await advanceGenerationWatch();
      expect(fetchCalls).toContain(`/api/ai/menu/weekly/status?requestId=${params.requestId}`);
    } finally {
      vi.useRealTimers();
    }
    await settle();
  }

  it('表示中の週の初日でない日の generate_day_menu は、生成が終わったら作った献立を出す', async () => {
    const date = dateFromWeekStart(NOT_WEEK_START_OFFSET);
    const dish = 'AI が作った水曜の鯖の味噌煮';
    const requestId = '21950000-0000-4000-8000-0000000000d1';
    await renderWeeklyPage();
    await selectDay(date);
    await generateAndComplete({ actionType: 'generate_day_menu', date, dish, requestId, result: { date, requestId, status: 'processing' } });
    expect(container.textContent).toContain(dish);
  });

  it('generate_single_meal (表示中の週の初日でない日の 1 食) は、生成が終わったら作った献立を出す', async () => {
    const date = dateFromWeekStart(SINGLE_MEAL_OFFSET);
    const dish = 'AI が作った木曜の親子丼';
    const requestId = '21950000-0000-4000-8000-0000000000d2';
    await renderWeeklyPage();
    await selectDay(date);
    await generateAndComplete({
      actionType: 'generate_single_meal',
      date,
      dish,
      requestId,
      result: { requestId, status: 'processing', message: '木曜の夕食を作っています' },
    });
    expect(container.textContent).toContain(dish);
  });
});

/** GET /api/meal-plans を、その範囲 (mealPlansRangeKey) で読んだ回数 */
const mealPlansCallsFor = (rangeKey: string) =>
  fetchCalls.filter((raw) => {
    const url = new URL(raw, PAGE_ORIGIN);
    return (
      url.pathname === '/api/meal-plans' &&
      mealPlansRangeKey(url.searchParams.get('startDate') ?? '', url.searchParams.get('endDate') ?? '') === rangeKey
    );
  }).length;

/** 翌週の献立の読み込み (翌週の初日から 7 日。先読み・翌週へ移ったときの読み込みの範囲) の鍵 */
function nextWeekRangeKey(): string {
  return mealPlansRangeKey(dateFromWeekStart(DAYS_IN_WEEK), dateFromWeekStart(DAYS_IN_WEEK * 2 - 1));
}

/** 文字 (textContent) を含むボタン */
function buttonWithText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((el) => (el.textContent ?? '').includes(text));
  if (!button) throw new Error(`「${text}」のボタンが無い`);
  return button;
}

async function clickButton(button: HTMLElement) {
  await act(async () => {
    button.click();
  });
  await settle();
}

/** 買い物リストの再生成の依頼 (開き直したときに復元する依頼の id) */
const SHOPPING_REGENERATION_REQUEST_ID = '22060000-0000-4000-8000-0000000000e1';

/**
 * 買い物リストの再生成の途中で開き直した状態を作る (localStorage の印)。開くと、復元が依頼の状態を確かめ (処理中)、監視のポーリングが
 * 完了を待つ (completion を解くと完了)。描画して監視が始まったところまで進める
 */
async function renderWithShoppingRegenerationInProgress(): Promise<{ complete: () => Promise<void> }> {
  const completion = heldResponse();
  server.shoppingRegeneration = { requestId: SHOPPING_REGENERATION_REQUEST_ID, statusCalls: 0, hold: completion.hold };
  localStorage.setItem('shoppingListRegenerating', JSON.stringify({ requestId: SHOPPING_REGENERATION_REQUEST_ID, timestamp: Date.now() }));
  await renderWeeklyPage();
  /** 復元の確かめ (1 回目) と、監視のポーリングの最初の確かめ (2 回目。完了を待つ) */
  const STATUS_CALLS_WHEN_WATCHING = 2;
  expect(server.shoppingRegeneration.statusCalls, '買い物リストの再生成の監視を始めていない (検査の前提が崩れた)').toBe(STATUS_CALLS_WHEN_WATCHING);
  return {
    complete: async () => {
      await act(async () => {
        completion.release();
      });
      await settle();
    },
  };
}

/** 閉じたモーダルが消える (閉じるアニメーションが終わる) まで待つ上限 (ミリ秒) と、確かめる間 */
const DIALOG_EXIT_WAIT_MAX_MS = 2000;
const DIALOG_EXIT_POLL_MS = 50;

/** 完了の知らせ (成功のモーダル) を閉じ、消えるまで待つ */
async function dismissSuccessDialog() {
  const ok = container.querySelector<HTMLButtonElement>('[role="dialog"] button');
  if (!ok) throw new Error('完了の知らせが出ていない');
  await clickButton(ok);
  for (let waited = 0; document.querySelector('[role="dialog"]') !== null && waited < DIALOG_EXIT_WAIT_MAX_MS; waited += DIALOG_EXIT_POLL_MS) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, DIALOG_EXIT_POLL_MS));
    });
  }
  expect(document.querySelector('[role="dialog"]'), '完了の知らせが閉じていない').toBeNull();
  await settle();
}

const shoppingItemNames = () => useShoppingStore.getState().shoppingList.map((item) => item.itemName);

describe('献立表 (/menus/weekly) の受け手の縁 (#2206 G1)', () => {
  it('待ちの間に取り直しが同じ食事の完了を変えたら、新しい値から反転を決める', async () => {
    const today = formatLocalDate(new Date());
    server.days.set(today, [{ id: 'meal-today', dishName: '鮭の塩焼き', isCompleted: false }]);
    await renderWeeklyPage();
    const toggle = () => container.querySelector<HTMLButtonElement>('button.w-7.h-7.rounded-full');
    expect(toggle(), '今日の食事の完了の切り替えが無い').not.toBeNull();
    const shownCompleted = () => toggle()!.querySelector('svg') !== null;
    expect(shownCompleted()).toBe(false);

    // 完了を押す (未完了の描画で押す)。250ms の待ちを止める
    const finishToggleWait = await holdToggleDebounce(() => toggle()!.click());
    // 待ちのあいだに AI 相談 (complete_meal) が同じ食事を完了にし、取り直しがそれを置く
    server.days.set(today, [{ id: 'meal-today', dishName: '鮭の塩焼き', isCompleted: true }]);
    await notifyAiConsultationSucceeded('complete_meal', { mealId: 'meal-today', isCompleted: true });
    expect(shownCompleted(), '取り直しが AI の完了を置いていない (検査が空振りしている)').toBe(true);

    // 待ちが明ける: いまの献立 (完了) から反転して未完了を送る
    await finishToggleWait();
    expect(fetchCalls.some((raw) => raw.startsWith(MEAL_PATCH_PATH_PREFIX)), '完了の切り替えを送っていない (検査が空振りしている)').toBe(true);
    expect(server.days.get(today)?.[0].isCompleted, '押した描画の完了 (未完了) から反転を決めて、完了を送った').toBe(false);
    expect(shownCompleted()).toBe(false);
  });

  it('重なる月の古い応答が後から届いても AI の足した印を消さない', async () => {
    // 開いたときの、表示中の月の印の読み取りの応答を止める
    const oldMonthRead = heldResponse();
    server.mealPlansHoldOnce.set(displayedMonthRangeKey(), oldMonthRead.hold);
    await renderWeeklyPage();
    expect(server.mealPlansHoldOnce.size, '表示中の月の印の読み取りを止めていない (検査の前提が崩れた)').toBe(0);

    // AI 相談が表示中の月の別の週に献立を作る: 取り直しが表示中の月を読み直して印を置く
    server.days.set(otherWeekDateInDisplayedMonth(), [{ id: 'meal-other-week', dishName: 'カレー' }]);
    await notifyAiConsultationSucceeded('update_meal', { mealId: 'meal-other-week' });
    expect(await calendarMealDotCount(), '取り直しが AI の足した印を置いていない (検査が空振りしている)').toBe(1);

    // 開いたときの古い応答 (AI の前の、印の無い月) が後から届く
    await act(async () => {
      oldMonthRead.release();
    });
    await settle();
    expect(await calendarMealDotCount(), '開いたときの古い月の応答が、AI の足した印を消した').toBe(1);
  });

  it('控えに当たった週は読み込み中の表示を出さない', async () => {
    const NEXT_WEEK_DISH = '翌週の焼き魚';
    server.days.set(dateFromWeekStart(0), [{ id: 'meal-this', dishName: '今週の肉じゃが' }]);
    server.days.set(dateFromWeekStart(DAYS_IN_WEEK), [{ id: 'meal-next', dishName: NEXT_WEEK_DISH }]);
    await renderWeeklyPage();
    expect(mealPlansCallsFor(nextWeekRangeKey()), '翌週を先読みしていない (検査の前提が崩れた)').toBe(1);

    const nextWeek = container.querySelector<HTMLButtonElement>('button[aria-label="翌週"]');
    expect(nextWeek, '「翌週」のボタンが無い').not.toBeNull();
    await act(async () => {
      nextWeek!.click();
    });
    expect(weeklyPageIsLoading(), '控えに当たった週で読み込み中の表示を出した').toBe(false);
    expect(container.textContent).toContain(NEXT_WEEK_DISH);
    await settle();
    expect(weeklyPageIsLoading()).toBe(false);
    expect(mealPlansCallsFor(nextWeekRangeKey()), '控えに当たったのに翌週を読み直した (検査が空振りしている)').toBe(1);
  });

  it('先読みの 5xx は控えに書かない', async () => {
    const NEXT_WEEK_DISH = '翌週の焼きそば';
    server.days.set(dateFromWeekStart(0), [{ id: 'meal-this', dishName: '今週の肉じゃが' }]);
    server.days.set(dateFromWeekStart(DAYS_IN_WEEK), [{ id: 'meal-next', dishName: NEXT_WEEK_DISH }]);
    // 翌週の先読みが 500 になる
    server.mealPlansFailOnce.add(nextWeekRangeKey());
    await renderWeeklyPage();
    expect(server.mealPlansFailOnce.size, '翌週の先読みが失敗していない (検査の前提が崩れた)').toBe(0);

    // 翌週へ移る: 失敗した先読みを空の週として控えから出さず、読み直して献立を出す
    await clickButton(container.querySelector<HTMLButtonElement>('button[aria-label="翌週"]')!);
    expect(container.textContent, '先読みの失敗を空の週として控えに書いた').toContain(NEXT_WEEK_DISH);
  });

  it('週の読み込みの応答待ちに別の週へ移ったあと、前の週の読み込みが失敗しても今の週の献立を消さない', async () => {
    const NEXT_WEEK_DISH = '翌週の鶏の照り焼き';
    for (let i = 0; i < DAYS_IN_WEEK; i += 1) {
      server.days.set(dateFromWeekStart(DAYS_IN_WEEK + i), [{ id: `meal-next-${i}`, dishName: NEXT_WEEK_DISH }]);
    }
    // ?date= に翌週の日を渡して開く: 週の始まりの日を読んだあと、今週の読み込みが始まり、?date= の週 (翌週) へ移って翌週を読む。
    // 今週の読み込みの応答を止め、失敗させる
    navigation.searchParams = new URLSearchParams({ date: dateFromWeekStart(DAYS_IN_WEEK) });
    const thisWeekLoad = heldResponse();
    server.mealPlansHoldOnce.set(displayedWeekRangeKey(), thisWeekLoad.hold);
    server.mealPlansFailOnce.add(displayedWeekRangeKey());
    await renderWeeklyPage();
    expect(server.mealPlansHoldOnce.size, '今週の読み込みを止めていない (検査の前提が崩れた)').toBe(0);
    expect(container.textContent, '?date= の週 (翌週) を出していない (検査の前提が崩れた)').toContain(NEXT_WEEK_DISH);

    // 前の週 (今週) の読み込みが失敗で終わる
    await act(async () => {
      thisWeekLoad.release();
    });
    await settle();
    expect(weeklyPageIsLoading()).toBe(false);
    expect(container.textContent, '前の週の読み込みの失敗で、今の週の献立を消した').toContain(NEXT_WEEK_DISH);
  });

  it('買い物リストの品目をチェックしたあと控えにある週へ移っても、控えの古い一覧でチェックを戻さない', async () => {
    const ITEM = { id: 'item-1', itemName: 'にんじん', isChecked: false };
    server.days.set(dateFromWeekStart(0), [{ id: 'meal-this', dishName: '今週の肉じゃが' }]);
    server.days.set(dateFromWeekStart(DAYS_IN_WEEK), [{ id: 'meal-next', dishName: '翌週の焼き魚' }]);
    server.shoppingItems = [ITEM];
    await renderWeeklyPage();
    expect(mealPlansCallsFor(nextWeekRangeKey()), '翌週を先読みしていない (検査の前提が崩れた)').toBe(1);
    const shoppingItemChecked = () => useShoppingStore.getState().shoppingList.find((item) => item.id === ITEM.id)?.isChecked;
    expect(shoppingItemChecked(), '買い物リストの品目が出ていない (検査が空振りしている)').toBe(false);

    // 買い物リストを開いて品目をチェックする
    await act(async () => {
      shoppingListButton().click();
    });
    const check = container.querySelector<HTMLButtonElement>(`button[aria-label="${ITEM.itemName}を購入済みにする"]`);
    if (!check) throw new Error('買い物リストの品目のチェックのボタンが無い');
    await clickButton(check);
    expect(shoppingItemChecked()).toBe(true);

    // 控え (チェックの前の先読みの一覧を持つ) にある翌週へ移る
    await clickButton(container.querySelector<HTMLButtonElement>('button[aria-label="翌週"]')!);
    expect(mealPlansCallsFor(nextWeekRangeKey()), '翌週を控えから出していない (検査の前提が崩れた)').toBe(1);
    expect(shoppingItemChecked(), '控えの古い一覧でチェックを戻した').toBe(true);
  });

  it('自炊の食事を足したら、読み直した週の作った食事で手入力の編集を開く (UX2-32)', async () => {
    await renderWeeklyPage();
    await clickButton(buttonWithText('朝食を追加'));
    await clickButton(buttonWithText('自炊で追加'));
    expect([...server.days.values()].flat().some((meal) => meal.id === CREATED_MEAL_ID), '食事を足していない (検査が空振りしている)').toBe(true);
    expect(container.textContent, '読み直した週の作った食事で手入力の編集を開いていない').toContain('手動で変更');
  });

  it('ある日の最後の 1 食を削除したら、その日の月のカレンダーの印を消す (ほかの日の印は残す)', async () => {
    const today = formatLocalDate(new Date());
    const otherDay = displayedWeekDates().find((date) => date !== today)!;
    // 消せる食事 (基本の 3 食でない間食) を今日に 1 つ。ほかの日の食事は済み (自動で開くのは今日の食事)
    server.days.set(today, [{ id: 'meal-today', dishName: 'ヨーグルト', mealType: 'snack' }]);
    server.days.set(otherDay, [{ id: 'meal-other', dishName: '豚汁', isCompleted: true }]);
    await renderWeeklyPage();
    expect(await calendarMealDotCount()).toBe(2);

    const deleteButton = container.querySelector<HTMLButtonElement>('button[aria-label="食事を削除"]');
    if (!deleteButton) throw new Error('今日の食事の削除のボタンが無い (検査の前提が崩れた)');
    await clickButton(deleteButton);
    await clickButton(buttonWithText('削除する'));
    expect(server.days.get(today), '食事を消していない (検査が空振りしている)').toEqual([]);
    expect(await calendarMealDotCount(), '最後の 1 食を消した日の印が残った (またはほかの日の印が消えた)').toBe(1);
  });

  it('開いたときの家族の読み込みの応答待ちに来た取り直しが家族の一覧を読めなくても、開いたときの家族の切り替えを置く', async () => {
    supabaseMock.profile = { ...completeProfile(), family_id: FAMILY_ID };
    joinFamily(SELF_NAME_BEFORE);
    // 開いたときの家族の一覧の読み取りの応答を止める
    const mountMembers = heldResponse();
    supabaseMock.familyMembersHoldOnce = mountMembers.hold;
    await renderWeeklyPage();
    expect(supabaseMock.familyMembersHoldOnce, '家族の一覧の読み取りを止めていない (検査の前提が崩れた)').toBeNull();
    expect(container.querySelector('[aria-label="ビューを切替"]'), '家族の一覧を読む前に家族の切り替えを出した (検査の前提が崩れた)').toBeNull();

    // その間に AI 相談が成功し、取り直しは家族の一覧を読めない (何も置かない)
    supabaseMock.familyMembersFails = true;
    await notifyAiConsultationSucceeded('update_profile_preferences', { updated: true, fields: ['nickname'] });
    supabaseMock.familyMembersFails = false;

    // 開いたときの読み込みの応答が届く: 家族の切り替えを置く (空のまま残らない)
    await act(async () => {
      mountMembers.release();
    });
    await settle();
    expect(familySwitcherNames(), '取り直しの失敗で、開いたときの家族の読み込みの応答まで捨てた').toEqual([SELF_NAME_BEFORE, OTHER_MEMBER_NAME]);
  });

  it('買い物リストの再生成の完了を待つあいだに始まった取り直しの応答が完了のあとに届いても、再生成した一覧を再生成の前の一覧で戻さない', async () => {
    const BEFORE_ITEM = { id: 'item-before', itemName: '再生成の前のにんじん', isChecked: false };
    const AFTER_ITEM = { id: 'item-after', itemName: '再生成したたまねぎ', isChecked: false };
    server.days.set(dateFromWeekStart(0), [{ id: 'meal-this', dishName: '今週の肉じゃが' }]);
    server.shoppingItems = [BEFORE_ITEM];
    const regeneration = await renderWithShoppingRegenerationInProgress();
    expect(shoppingItemNames()).toEqual([BEFORE_ITEM.itemName]);

    // 完了の前に AI 相談が成功する。取り直しの応答 (再生成の前の一覧) を止める
    const refetch = heldResponse();
    server.mealPlansHold = refetch.hold;
    await notifyAiConsultationSucceeded('update_meal', { updated: true });
    server.mealPlansHold = null;

    // 再生成が終わる: 完了の監視の一覧の読み直し (GET /api/shopping-list) の応答を止める
    server.shoppingItems = [AFTER_ITEM];
    const listRead = heldResponse();
    server.shoppingListHold = listRead.hold;
    await regeneration.complete();
    server.shoppingListHold = null;
    expect(callsTo('/api/shopping-list'), '完了の監視が一覧を読み直していない (検査の前提が崩れた)').toBe(1);

    // 完了の監視が再生成した一覧を置く
    await act(async () => {
      listRead.release();
    });
    await settle();
    expect(shoppingItemNames(), '完了の監視が再生成した一覧を置いていない (検査が空振りしている)').toEqual([AFTER_ITEM.itemName]);
    // 完了の知らせ (モーダル) を閉じる (開いている間は取り直しの応答を置かずに止めるので、閉じてから置き方を見る)
    await dismissSuccessDialog();

    // 再生成を待つあいだに始まった取り直しの応答 (再生成の前の一覧) が、そのあとに届く
    await act(async () => {
      refetch.release();
    });
    await settle();
    expect(shoppingItemNames(), '取り直しの古い応答で、再生成した一覧を再生成の前の一覧に戻した').toEqual([AFTER_ITEM.itemName]);
  });

  it('買い物リストの再生成の完了の読み直しより新しい読み取りが品目を先に置いても、品目の追加の送り先は再生成した一覧にする', async () => {
    const ITEM = { id: 'item-after', itemName: '再生成したたまねぎ', isChecked: false };
    server.days.set(dateFromWeekStart(0), [{ id: 'meal-this', dishName: '今週の肉じゃが' }]);
    server.shoppingItems = [ITEM];
    const regeneration = await renderWithShoppingRegenerationInProgress();
    expect(useShoppingStore.getState().activeShoppingList).toBeNull();

    // 再生成が終わる: 完了の監視の一覧の読み直し (GET /api/shopping-list) の応答を止める
    const listRead = heldResponse();
    server.shoppingListHold = listRead.hold;
    await regeneration.complete();
    server.shoppingListHold = null;
    expect(callsTo('/api/shopping-list'), '完了の監視が一覧を読み直していない (検査の前提が崩れた)').toBe(1);

    // その間に AI 相談が成功し、取り直し (完了の読み直しより新しい読み取り) が品目を先に置く
    await notifyAiConsultationSucceeded('update_meal', { updated: true });
    expect(shoppingItemNames()).toEqual([ITEM.itemName]);

    // 完了の読み直しの応答が届く: 品目は新しい読み取りのまま、送り先 (activeShoppingList) は再生成した一覧
    await act(async () => {
      listRead.release();
    });
    await settle();
    expect(useShoppingStore.getState().activeShoppingList?.id, '品目の追加の送り先を再生成した一覧にしていない').toBe('shopping-list-1');
    expect(shoppingItemNames()).toEqual([ITEM.itemName]);
  });

  it('冷蔵庫の写真から食材を足したあと、保存の前に始まった開いたときの冷蔵庫の読み込みの応答があとから届いても、足した食材を消さない', async () => {
    // 開いたときの冷蔵庫の読み込みの応答 (足す前の空の一覧) を止める
    const mountPantry = heldResponse();
    server.pantryHold = mountPantry.hold;
    await renderWeeklyPage();
    server.pantryHold = null;
    vi.spyOn(window, 'alert').mockImplementation(() => undefined);

    // 冷蔵庫を開き、写真から食材を足す (解析 → 保存 → 一覧の読み直し)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="冷蔵庫を確認"]')!.click();
    });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('冷蔵庫の写真の入力が無い');
    /** 写真 (中身は読まない。解析はサーバーのモック) */
    const photo = { type: 'image/jpeg', arrayBuffer: async () => new ArrayBuffer(0) };
    Object.defineProperty(input, 'files', { value: [photo], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(fridgeItemNames(), '写真から足した食材を置いていない (検査が空振りしている)').toContain(FRIDGE_PHOTO_ITEM.name);

    // 保存の前に始まった開いたときの読み込みの応答 (足す前の一覧) が後から届く
    await act(async () => {
      mountPantry.release();
    });
    await settle();
    expect(fridgeItemNames(), '開いたときの古い一覧で、写真から足した食材を消した').toContain(FRIDGE_PHOTO_ITEM.name);
  });
});
