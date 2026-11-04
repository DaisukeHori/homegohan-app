/**
 * #2235 I2: /home (useHomeData) のログインの状態の変化での読み直しの回帰テスト。
 *
 * 問題 1 (直す前): 前回読んだ利用者 (lastReadAuthUserIdRef) を、ログインを確かめた直後 (プロフィール・今日の献立を読む前) に覚えていた。
 *   - 開いたときの読み込みがプロフィール・今日の献立の読み取りで失敗しても覚えるので、同じ人の SIGNED_IN (タブを前に戻したとき) で読み直さない
 *   - 取り直しの読み取りの置き方が番兵で止められても、別の人を覚えるので、そのあと来たその人の SIGNED_IN で読み直さない
 *     (別のタブで SIGNED_OUT を挟まずに別の人へ切り替わり、同時に取り直しが走るとき)
 * 直したあと: 主のデータ (今日の献立・集計) を place で置けたときに覚える (失敗・止めた・追い越されたときは前の値のまま)。
 *
 * 問題 2 (直す前): getSession に利用者がいないと、開いたときの読み込みが syncSessionFromServer の setSession を呼ぶ。auth-js の
 * setSession は戻る前に SIGNED_IN を出す (@supabase/auth-js 2.118 の _setSession: access token が有効なら _notifyAllSubscribers('SIGNED_IN'))。
 * このとき前回読んだ利用者はまだ無い (undefined) ので「まだ確かめていないときは読み直す」に当たり、AI つきの栄養の分析を 2 回読んでいた。
 * 直したあと: ホームの読み取りが自分で setSession している間の SIGNED_IN は読み直しに数えない。
 * (今の /api/auth/session-sync は本文にトークンを入れない (#165) ので、本番の setSession はトークンが無くて SIGNED_IN を出さない。
 * この検査は、同期がトークンを返して setSession が SIGNED_IN を出すときに 2 回読まないことを守る)
 *
 * 判定の純関数は tests/home-auth-refetch-2227.test.ts。このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** onAuthStateChange の第 2 引数 (session) のうち、ホームが見る欄だけ */
type AuthSessionArg = { user: { id: string } } | null;

/**
 * Supabase のモック。ログインしている利用者は currentUserId (sessionPresent が false なら getSession は利用者を返さない)。
 * 表ごとの問い合わせの答えは tableResults (無い表は空。error のある答えは読み取りの失敗)。
 * tableHold が null でない間に始めた表の読み取りは、その Promise が解けるまで応答を止める
 */
const authMock = vi.hoisted(() => ({
  currentUserId: 'user-a',
  /** getSession がセッション (利用者) を返すか。false なら開いたときの読み込みがセッションを同期する (syncSessionFromServer) */
  sessionPresent: true,
  tableResults: {} as Record<string, { data: unknown; error: unknown }>,
  tableHold: null as null | Promise<void>,
  /** ページが auth.onAuthStateChange に渡した関数 */
  authStateListener: null as null | ((event: string, session: AuthSessionArg) => void),
  /** auth.getSession を呼んだ数 (ホームのデータの読み取りは 1 回の読み取りで 1 回ログインを確かめる) */
  sessionReads: 0,
  /** auth.setSession を呼んだ数 (セッションの同期の道を通ったか) */
  setSessionCalls: 0,
}));

vi.mock('@/lib/supabase/client', () => {
  const EMPTY_RESULT = { data: null, error: null };
  /** どのメソッドを呼んでも自分を返し、await するとその表の答えになる問い合わせ */
  const query = (table: string): unknown =>
    new Proxy(() => undefined, {
      get: (_target, prop) => {
        if (prop === 'then') {
          const answer = authMock.tableResults[table] ?? EMPTY_RESULT;
          const hold = authMock.tableHold;
          return (resolve: (value: unknown) => void) => {
            if (hold === null) resolve(answer);
            else void hold.then(() => resolve(answer));
          };
        }
        return () => query(table);
      },
    });
  const userOf = () => ({ id: authMock.currentUserId, user_metadata: {} });
  return {
    createClient: () => ({
      auth: {
        getSession: async () => {
          authMock.sessionReads += 1;
          return { data: { session: authMock.sessionPresent ? { user: userOf() } : null }, error: null };
        },
        getUser: async () => ({ data: { user: authMock.sessionPresent ? userOf() : null }, error: null }),
        refreshSession: async () => ({ data: { session: authMock.sessionPresent ? { user: userOf() } : null }, error: null }),
        // auth-js 2.118 の _setSession と同じ順: トークンが無ければ AuthSessionMissingError (知らせは出さない)。あれば保存してから
        // SIGNED_IN を知らせ、知らせ終わってから戻る
        setSession: async (tokens: { access_token?: string; refresh_token?: string }) => {
          authMock.setSessionCalls += 1;
          if (!tokens.access_token || !tokens.refresh_token) {
            return { data: { session: null, user: null }, error: new Error('Auth session missing!') };
          }
          authMock.sessionPresent = true;
          const session = { user: userOf() };
          authMock.authStateListener?.('SIGNED_IN', session);
          return { data: { session, user: session.user }, error: null };
        },
        onAuthStateChange: (listener: (event: string, session: AuthSessionArg) => void) => {
          authMock.authStateListener = listener;
          return { data: { subscription: { unsubscribe: () => undefined } } };
        },
      },
      from: (table: string) => query(table),
      rpc: () => query('rpc'),
      channel: () => {
        const channel = { on: () => channel, subscribe: () => channel, unsubscribe: async () => 'ok' };
        return channel;
      },
      removeChannel: async () => 'ok',
    }),
  };
});

const { useHomeData, HOME_NUTRITION_ANALYSIS_WITH_AI_URL } = await import('@/hooks/useHomeData');
const { AI_CONSULTATION_DATA_CHANGED_EVENT } = await import('@/lib/ai/consultation-data-refetch');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 取得の連鎖 (Promise.all の中の問い合わせ・setState) を流しきるまでに回すタスクの数 */
const SETTLE_TASKS = 20;
const NOT_FOUND_STATUS = 404;
const OK_STATUS = 200;
const SESSION_SYNC_PATH = '/api/auth/session-sync';

const USER_A = 'user-a';
const USER_B = 'user-b';
/** 読み取りの失敗 (supabase-js は通信の失敗でも投げずに { data: null, error } を返す) */
const READ_FAILED = { data: null, error: { message: 'Failed to fetch' } };
/** 今日の献立 (user_daily_meals の行。planned_meals は 1 件) */
const TODAY_DAY_ROW = {
  id: 'day-today',
  day_date: '2026-11-04',
  planned_meals: [{ id: 'meal-1', daily_meal_id: 'day-today', meal_type: 'lunch', dish_name: '親子丼', is_completed: false, mode: 'cook' }],
};

/** 同期の応答がトークンを返すか (問題 2 の検査だけ true) */
let sessionSyncReturnsTokens = false;
let fetchMock: ReturnType<typeof vi.fn>;
let container: HTMLDivElement;
let root: Root;
/** 検査が置いた番兵の要素 (開いているモーダル。取り直しの応答を置かせない) */
let blocker: HTMLElement | null = null;

function HomeAuthProbe() {
  const { user, todayPlan } = useHomeData();
  return (
    <div>
      <p data-testid="user-id">{user?.id ?? ''}</p>
      <p data-testid="today-meals">{todayPlan ? String(todayPlan.meals.length) : 'none'}</p>
    </div>
  );
}

beforeEach(() => {
  authMock.currentUserId = USER_A;
  authMock.sessionPresent = true;
  authMock.tableResults = {};
  authMock.tableHold = null;
  authMock.authStateListener = null;
  authMock.sessionReads = 0;
  authMock.setSessionCalls = 0;
  sessionSyncReturnsTokens = false;
  fetchMock = vi.fn(async (input: unknown) => {
    if (String(input) === SESSION_SYNC_PATH && sessionSyncReturnsTokens) {
      return { ok: true, status: OK_STATUS, json: async () => ({ accessToken: 'synced-access', refreshToken: 'synced-refresh' }) };
    }
    if (String(input) === SESSION_SYNC_PATH) return { ok: true, status: OK_STATUS, json: async () => ({ ok: true }) };
    return { ok: false, status: NOT_FOUND_STATUS, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  blocker?.remove();
  blocker = null;
  vi.unstubAllGlobals();
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < SETTLE_TASKS; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

async function renderHome() {
  await act(async () => {
    root.render(<HomeAuthProbe />);
  });
  await settle();
}

async function changeAuthState(event: string, session: AuthSessionArg) {
  expect(authMock.authStateListener, 'ログインの状態の変化を受け取る関数が無い (検査の前提が崩れた)').not.toBeNull();
  await act(async () => {
    authMock.authStateListener!(event, session);
  });
  await settle();
}

const textOf = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)?.textContent;
/** AI つきの栄養の分析 (開いたとき・ログインの状態の変化の読み込み) を読んだ数 */
const aiAnalysisReads = () => fetchMock.mock.calls.filter(([input]) => String(input) === HOME_NUTRITION_ANALYSIS_WITH_AI_URL).length;

describe('前回読んだ利用者は、主のデータを置けたときに覚える (#2235 I2)', () => {
  it('対照: 開いたときの読み込みが読めたあとの、同じ人の SIGNED_IN では読み直さない (#2227 H3)', async () => {
    authMock.tableResults.user_daily_meals = { data: TODAY_DAY_ROW, error: null };
    await renderHome();
    expect(textOf('today-meals')).toBe('1');
    expect(aiAnalysisReads()).toBe(1);
    const sessionReadsBefore = authMock.sessionReads;

    await changeAuthState('SIGNED_IN', { user: { id: USER_A } });
    expect(authMock.sessionReads, '読めたあとの同じ人の SIGNED_IN で読み直した').toBe(sessionReadsBefore);
    expect(aiAnalysisReads()).toBe(1);
  });

  it('開いたときの読み込みが今日の献立の読み取りで失敗したら、同じ人の SIGNED_IN で読み直す', async () => {
    authMock.tableResults.user_daily_meals = READ_FAILED;
    await renderHome();
    expect(textOf('user-id'), '開いたときの読み込みがログインを確かめていない (検査の前提が崩れた)').toBe(USER_A);
    expect(textOf('today-meals'), '今日の献立の読み取りの失敗で今日の献立を置いた (検査の前提が崩れた)').toBe('none');
    const sessionReadsBefore = authMock.sessionReads;
    const aiReadsBefore = aiAnalysisReads();

    // 通信が戻ってからタブを前に戻した (同じ人の SIGNED_IN)
    authMock.tableResults.user_daily_meals = { data: TODAY_DAY_ROW, error: null };
    await changeAuthState('SIGNED_IN', { user: { id: USER_A } });
    expect(authMock.sessionReads, '読めなかった開いたときの読み込みのあと、同じ人の SIGNED_IN で読み直していない').toBe(sessionReadsBefore + 1);
    expect(textOf('today-meals')).toBe('1');
    expect(aiAnalysisReads()).toBe(aiReadsBefore + 1);

    // 読めたあとは、同じ人の SIGNED_IN でもう読み直さない (#2227 H3 の絞りは残る)
    await changeAuthState('SIGNED_IN', { user: { id: USER_A } });
    expect(authMock.sessionReads, '読めたあとの同じ人の SIGNED_IN で読み直した').toBe(sessionReadsBefore + 1);
  });

  it('開いたときの読み込みがプロフィールの読み取りで失敗したら、同じ人の SIGNED_IN で読み直す', async () => {
    authMock.tableResults.user_profiles = READ_FAILED;
    authMock.tableResults.user_daily_meals = { data: TODAY_DAY_ROW, error: null };
    await renderHome();
    expect(textOf('user-id')).toBe(USER_A);
    const sessionReadsBefore = authMock.sessionReads;

    authMock.tableResults.user_profiles = { data: { nickname: 'はなこ', organization_id: null }, error: null };
    await changeAuthState('SIGNED_IN', { user: { id: USER_A } });
    expect(authMock.sessionReads, 'プロフィールを読めなかった開いたときの読み込みのあと、同じ人の SIGNED_IN で読み直していない').toBe(
      sessionReadsBefore + 1,
    );

    await changeAuthState('SIGNED_IN', { user: { id: USER_A } });
    expect(authMock.sessionReads, '読めたあとの同じ人の SIGNED_IN で読み直した').toBe(sessionReadsBefore + 1);
  });

  it('番兵で止めた取り直しが別の人を確かめても覚えず、その人の SIGNED_IN で読み直す', async () => {
    await renderHome();
    expect(textOf('user-id')).toBe(USER_A);

    // 別のタブで SIGNED_OUT を挟まずに別の人へ切り替わった。同時に AI 相談の成功の取り直しが走り、その応答を待つ間にモーダルが開いた
    authMock.currentUserId = USER_B;
    let releaseHold!: () => void;
    authMock.tableHold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const sessionReadsBefore = authMock.sessionReads;
    await act(async () => {
      window.dispatchEvent(new CustomEvent(AI_CONSULTATION_DATA_CHANGED_EVENT, { detail: { actionType: 'update_meal', result: {} } }));
    });
    await settle();
    expect(authMock.sessionReads, '取り直しが始まっていない (検査が空振りしている)').toBe(sessionReadsBefore + 1);

    blocker = document.createElement('div');
    blocker.setAttribute('role', 'dialog');
    document.body.appendChild(blocker);
    authMock.tableHold = null;
    await act(async () => {
      releaseHold();
    });
    await settle();
    expect(textOf('user-id'), '番兵が取り直しの応答を止めていない (検査の前提が崩れた)').toBe(USER_A);
    const sessionReadsAfterRefetch = authMock.sessionReads;

    // その人の SIGNED_IN (モーダルは開いたまま。ログインの状態の変化の読み込みはページの読み取りなので番兵を見ずに置く)
    await changeAuthState('SIGNED_IN', { user: { id: USER_B } });
    expect(authMock.sessionReads, '止めた取り直しのあと、別の人の SIGNED_IN で読み直していない').toBe(sessionReadsAfterRefetch + 1);
    expect(textOf('user-id')).toBe(USER_B);
  });
});

describe('ホームの読み取りが自分で同期したセッションの SIGNED_IN では読み直さない (#2235 I2)', () => {
  it('getSession が空 → 同期の setSession が出す SIGNED_IN で、AI つきの栄養の分析を 1 回だけ読む', async () => {
    authMock.sessionPresent = false;
    sessionSyncReturnsTokens = true;
    await renderHome();
    expect(authMock.setSessionCalls, 'セッションの同期の道を通っていない (検査の前提が崩れた)').toBe(1);
    expect(textOf('user-id')).toBe(USER_A);
    expect(aiAnalysisReads(), '同期の SIGNED_IN で AI つきの栄養の分析をもう 1 回読んだ').toBe(1);
    expect(authMock.sessionReads, '同期の SIGNED_IN でホームのデータを読み直した').toBe(1);

    // 同期のあとの、同じ人の SIGNED_IN でも読み直さない。別の人の SIGNED_IN は今までどおり読み直す (絞ったのは同期の間だけ)
    await changeAuthState('SIGNED_IN', { user: { id: USER_A } });
    expect(aiAnalysisReads()).toBe(1);
    authMock.currentUserId = USER_B;
    await changeAuthState('SIGNED_IN', { user: { id: USER_B } });
    expect(aiAnalysisReads(), '同期のあとの別の人の SIGNED_IN で読み直していない').toBe(2);
    expect(textOf('user-id')).toBe(USER_B);
  });
});
