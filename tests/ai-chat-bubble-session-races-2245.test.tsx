/**
 * #2245 K1 Web の AI 相談 (src/components/AIChatBubble.tsx) の回帰テスト。モバイルの AIAdvisorSheet は
 * apps/mobile/__tests__/ai/advisor-sheet-session-races-2245.test.tsx が同じ決まりを確かめる。
 *
 * 直す前:
 *   1. 会話の読み込み (fetchMessages) は await のあと、今出している相談の応答かを確かめずに画面の会話を置き換えた。
 *      (a) 相談を A→B と切り替えたあとに遅れて返った A の会話が、B の画面に出た
 *      (b) 切り替えの直後に『相談を終了』を押すと、閉じたあとの新しい相談の画面に、遅れて返った閉じた相談の会話が出た
 *      (c) 閉じる応答待ちの間にチャットを閉じて開き直すと、開き直しの読み込み (openChat) が閉じる応答待ちを見ずに走り、
 *          遅れて返った閉じた相談の会話が、閉じたあとの新しい相談の画面に出た
 *   2. 閉じる応答待ちの間も『1日献立変更』を押せ (disabled も入口も閉じる応答待ちを見なかった)、チャットに足した
 *      『○月○日の献立を作成中...』が閉じる側の新しい相談の画面の置き換えで消えた
 *   3. 『相談を終了』の失敗の応答 (400 など) と通信の失敗で、何も知らせなかった
 *   4. 1 日分の献立の日付の欄を空にして作成を押すと『NaN月NaN日の献立を作成中...』を出し、date '' で依頼した
 *   5. (L1) 1 日分の献立の既定の日は週の画面の表示の日 (window.__weeklyCurrentDate) をそのまま使い、その日が欄の範囲 (今日〜14 日後)
 *      の外 (過去の週・15 日以上先・0 時をまたいだ前日) だと、K1 で止めた「作成する」が開いた直後から押せず、理由の文も出なかった。
 *      手で範囲の外・空を選んだときも、ボタンが薄くなるだけで理由が見えなかった
 *   6. (#2254 M1) 1日献立の作成の最中・提案の実行の応答待ちの最中も『相談を終了』を押せ (入口も disabled も見なかった)、閉じたあとの
 *      新しい相談の画面の置き換えで『○月○日の献立を作成中...』が消え、完了・結果の一文だけが新しい相談の画面に出た
 *   7. (#2254 M1) 遅れて返った一覧・会話の読み込みが、あとの操作の画面を上書きした (どれも表示だけ。送り先は画面の相談のまま)
 *      (a) 開く (openChat) は一覧を待つ間の操作を見ず、閉包の古い currentSessionId で、始めた新しい相談を一覧の相談で上書きし、
 *          開き直しでは切り替える前の相談の会話を読み直した。新しい相談の作成 (createNewSession) も、作成を待つ間に選んだ相談を上書きした
 *      (b) 一覧 (fetchSessions) は応答の順に置き、閉じる前に始めた一覧が閉じる側の読み直しより後に返ると、閉じた相談が終了でない一覧が出た
 *      (c) 前の相談の遅れた会話の読み込みが終わると、今の読み込みの最中の印 (読み込み中の輪) を早く消した
 *   8. (#2254 M1 の同じ型) 6 の止めが閉じていなかった
 *      (a) 提案の実行の止めが真偽の値 1 つで、2 枚のカードの実行が重なると、先に終わった実行がもう一方の応答待ちの止め (と実行中の印)
 *          を外し、まだ応答待ちなのに『相談を終了』を押せた
 *      (b) 作成の最中・実行の応答待ちの最中も『新しい相談を始める』・相談の切り替えを押せ、会話の置き換えで作成中の一文が消え、
 *          完了・結果の一文が新しい相談・切り替えた先の相談の画面に出た
 *      (c) 作成の最中・実行の応答待ちの最中にチャットを閉じて開き直す (一覧を待つ間に作成・実行を始めたときも) と、開く側が会話を
 *          読み直して作成中・結果の一文を消した。会話の読み込みの最中にも『1日献立変更』を押せ、足した作成中の一文が読み込んだ会話で消えた
 *   9. (#2254 M1 の続き) 作成の最中の止めは Realtime の完了・失敗の通知でしか下りず、通知を取りこぼす (タブを裏に回した・通信が
 *      途切れた) と、読み込み直すまで『相談を終了』・新しい相談・相談の切り替え・開き直しの読み直しがずっと止まった。いまは依頼の状態を
 *      読み直して (チャットを開いたとき・タブが前に戻ったとき・DAY_MENU_STATUS_RECHECK_INTERVAL_MS ごと) 終わりを見つける。
 *      また、作成・実行が開き直しの一覧を待つ間に終わると、一覧のあとに会話を読み直して作成中・完了・結果の一文を消した
 *  10. (#2254 M1 の同じ型: 送信ほか) 7 と 8 (c) の直しが送信・1日献立のモーダル・作成と実行の入口に届いていなかった
 *      (a) 送信は画面の操作でなく、開き直しの一覧を待つ間に送ると、一覧のあとの会話の読み直しが送った文と返答の仮のメッセージを写しで
 *          置き換え、流れてきた返答と最後の置き換えが当たる行を失って、返答が次の読み込みまで画面に出なかった
 *      (b) 会話の読み込み (相談の切り替え・開き直し・新しい相談の作成) の最中も送信欄・送信ボタンが止まらず (入口も見なかった)、
 *          送った文と返答があとから返った読み込みの置き換えで消えた (新しい相談の作成の最中なら前の相談へ送られた)
 *      (c) 同じ相談の会話の読み込みが 2 つ重なると、あとの読み込みが先に終わって送れるようになったあとに、遅れて返った前の読み込みの
 *          写しが送った文と返答を消した
 *      (d) 1日献立のモーダルはチャットの下に重なるので、モーダルを開いたまま相談を切り替えられ、会話の読み込みの最中もモーダルの
 *          「作成する」を押せた (8 (c) で止めたのは『1日献立変更』だけ)。作成・提案の実行の入口も読み込みの最中か (同じ描画のうち・
 *          同意の確認を待つ間に始めた読み込み) を見ず、足した作成中・結果の一文が読み込みの置き換えで消えた
 *  11. (#2254 M1 の同じ型: 閉じるの失敗・送信の最中と終わり・遅れて出す一文) 7・8 (c)・10 (a) の直しが届いていなかった
 *      (a) 『相談を終了』の失敗の一文 (500・通信の失敗・400 すでに終了) は画面の操作でなく、開き直しの一覧を待つ間に閉じるが失敗すると、
 *          一覧のあとの会話の読み直しで『終了できませんでした』が消え、何も起きなかったように見えた (#2245 K1 が直す前に戻った)。
 *          新しい相談の作成を待つ間に閉じるが失敗しても、作成のあとの画面の置き換えで消えた
 *      (b) 会話の読み込みの最中も『相談を終了』は押せる (#2245 K1。切り替えの直後に閉じる) が、読み込みを待つ間に閉じるが失敗すると、
 *          失敗の一文が読み込み中の輪の下で足され、あとから返った読み込みの会話の置き換えで一度も出ずに消えた
 *      (c) 開く (openChat) は送信の最中かを見ず、送った文への返答を待つ間にチャットを閉じて開き直すと、一覧のあとの会話の読み直しが送った文と
 *          返答の仮のメッセージを写しで置き換え、返答が次の読み込みまで画面に出なかった
 *      (d) 開く (openChat) は、一覧を待つ間に画面の会話が変わったか (送信の失敗の文・返答のあとに遅れて出す自動実行の結果の一文) を
 *          見ず、一覧のあとの会話の読み直しでその一文を消した (足す側が画面の操作の番号を進める決まりだけで、進めない経路があった)
 *  12. (#2259 P1) 1日献立の依頼の失敗・止めの逃げ道・読み込みの印・低頻度の競合
 *      (1) 1日献立の依頼の POST が同意以外で失敗する (500・通信の失敗) と、フック (useV4MenuGeneration) の作成中の印が真のまま残り、
 *          『1日献立変更』と『作成する』がページを読み込み直すまで押せなかった。依頼の応答に requestId が無いときも同じ
 *      (2) 止め (『相談を終了』・新しい相談・切り替え・送信) が、応答や状態の確認が返らない間は下りなかった: 提案の実行・1日献立の依頼・
 *          『相談を終了』・会話の読み込み・新しい相談の作成・閉じたあとの一覧の読み直しに時間の上限が無かった。状態の確認が読めない・
 *          順番待ちのままだと、読み直しは黙って戻るだけだった
 *      (3) 相談を出していない (初めて開いたときの一覧を待つ間) のに『1日献立変更』を押せた。会話の読み込み k を待つ間に新しい相談の
 *          作成が失敗すると、k の最中なのに読み込み中の印が下りて送れた
 *      (4) 同じカードの「実行する」を同じ描画のうちに 2 回押すと 2 回とも実行に入った。同意の確認を待つ間に切り替えた相談の画面に
 *          実行・作成の一文が出えた。あとに始めた読み込みが失敗すると先に成功した写しも捨てた。読み込みの最中に足した『相談を終了』の
 *          失敗の一文が、同じ相談を選び直すと一度も出ずに消えた。閉じるは入口で画面の操作を進めず、先に始めた新しい相談の作成の
 *          結果が閉じた相談の失敗の一文の前に画面を置き換えた
 *  13. (#2265 Q2) 読み込みの時間切れの一文・相談が無いときの 1日献立の理由の一文・まれな縁
 *      (1) 一覧・会話の読み込みと新しい相談の作成が時間切れ (AI_CHAT_LOAD_TIMEOUT_MS)・非 ok のとき、console.error だけで何も出さず、
 *          初めて開いたときの会話の読み込みが返らないと履歴の無い画面のまま、新しい相談の作成が返らないと相談の無い画面のまま
 *          送信も『相談を終了』も押せなかった (サーバーには相談ができていて、次の一覧の読み込みでやっと出た)
 *      (2) 相談を出していない画面 (新しい相談の作成が緊急停止 (503) など) の 1日献立のモーダルで、「作成する」が理由も出ずに押せなかった
 *      (3) 『相談を終了』を受け付けた (ok) あとに本文の読み取りが時間切れ・JSON でないと、一覧の読み直しも新しい相談の作成もせず、
 *          サーバーで閉じた相談の画面が残った
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_CHAT_DISABLED_CODE,
  AI_CHAT_DISABLED_MESSAGE,
  LEGAL_CONSENT_REQUIRED_CODE,
  LEGAL_CONSENT_REQUIRED_MESSAGE,
  MAINTENANCE_API_CODE,
  MAINTENANCE_MESSAGE,
} from '@homegohan/shared';
import { AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE } from '@/lib/ai/ai-api-messages';
import { CONSULTATION_CLOSE_FAILED_MESSAGE, consultationCloseFailureOf } from '@/lib/ai/consultation-close-failure';
import { AI_CHAT_REPLY_FAILED_MESSAGE } from '@/lib/ai/consultation-reply-reload';
import { pollUntil, sleepRealTime } from './helpers/act-wait';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// 文が出るまでの待ち (tests/helpers/act-wait.ts) は最大 10 秒まで伸びうるので、1 件のテストの時間切れを延ばす
applyHeavyUnitTestTimeout();

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: async () => ({ data: [], error: null }),
      }),
    }),
  }),
}));
/** 同意の確認を待たせる門 (同意の確認を待つ間に閉じ始める縁を確かめるテストだけ置く。beforeEach で外す) */
const consent = vi.hoisted(() => ({ gate: null as Promise<void> | null }));
vi.mock('@/hooks/useAiConsent', () => ({
  useAiConsent: () => ({
    ensureAiConsent: async () => {
      if (consent.gate) await consent.gate;
      return 'consented';
    },
    consentModal: null,
  }),
}));
/**
 * 献立の生成の依頼 (beforeEach で呼ばれた記録を消す)。options は部品がフックに渡した最新の callbacks (完了・失敗を起こすテストが呼ぶ。
 * #2254 M1)
 */
const v4 = vi.hoisted(() => ({
  generate: vi.fn(),
  options: null as { onGenerationComplete?: () => void; onError?: (error: string) => void } | null,
  /** 進捗の購読 (呼ばれても完了・失敗の通知は起こさない = Realtime の通知を取りこぼした形。通知はテストが options で起こす) */
  subscribeToProgress: vi.fn(),
  /** 購読の解除 (subscribeToProgress が返す) */
  unsubscribe: vi.fn(),
  /** フックの作成中の印を下ろす (状態の読み直しで終わりを見つけたときに部品が呼ぶ) */
  cancelGeneration: vi.fn(),
  /**
   * 本物のフックを使うか (#2259 P1。依頼の POST の失敗でフックの作成中の印が残るかを確かめるテストだけ立てる。描く前に決め、
   * beforeEach で戻す)。本物のフックは fetch (このファイルの handlers) で依頼する
   */
  useRealHook: false,
}));
vi.mock('@/hooks/useV4MenuGeneration', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useV4MenuGeneration')>('@/hooks/useV4MenuGeneration');
  return {
    useV4MenuGeneration: (options: { onGenerationComplete?: () => void; onError?: (error: string) => void }) => {
      v4.options = options;
      if (v4.useRealHook) return actual.useV4MenuGeneration(options);
      return {
        isGenerating: false,
        generate: v4.generate,
        subscribeToProgress: v4.subscribeToProgress,
        cancelGeneration: v4.cancelGeneration,
      };
    },
  };
});
vi.mock('@/hooks/useNativeAppMode', () => ({ useNativeAppMode: () => false }));
vi.mock('@/lib/local-notification', () => ({ notifyMenuGenerated: vi.fn() }));
vi.mock('framer-motion', () => {
  const MOTION_ONLY_PROPS = ['initial', 'animate', 'exit', 'whileHover', 'whileTap', 'transition'];
  const cache = new Map<string, unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        if (!cache.has(tag)) {
          cache.set(tag, (props: Record<string, unknown>) =>
            createElement(
              tag,
              Object.fromEntries(Object.entries(props).filter(([key]) => key !== 'children' && !MOTION_ONLY_PROPS.includes(key))),
              props.children as React.ReactNode,
            ),
          );
        }
        return cache.get(tag);
      },
    },
  );
  return { motion, AnimatePresence: (props: { children?: React.ReactNode }) => props.children ?? null };
});

const {
  default: AIChatBubble,
  AUTO_ACTION_OUTCOME_MESSAGE_DELAY_MS,
  DAY_MENU_DATE_UNSELECTABLE_MESSAGE,
  DAY_MENU_STATUS_RECHECK_INTERVAL_MS,
  DAY_MENU_STATUS_RECHECK_TIMEOUT_MS,
  DAY_MENU_REQUEST_GIVE_UP_MS,
  DAY_MENU_REQUEST_TIMEOUT_MESSAGE,
  DAY_MENU_REQUEST_UNCONFIRMED_MESSAGE,
  ACTION_REQUEST_TIMEOUT_MESSAGE,
  CLOSE_SESSION_TIMEOUT_MESSAGE,
  AI_CHAT_LOAD_TIMEOUT_MS,
  SESSIONS_LOAD_TIMEOUT_MESSAGE,
  SESSIONS_LOAD_FAILED_MESSAGE,
  MESSAGES_LOAD_TIMEOUT_MESSAGE,
  MESSAGES_LOAD_FAILED_MESSAGE,
  SESSION_CREATE_TIMEOUT_MESSAGE,
  SESSION_CREATE_FAILED_MESSAGE,
  DAY_MENU_NO_SESSION_MESSAGE,
} = await import('@/components/AIChatBubble');
const { AI_CHAT_REQUEST_TIME_LIMIT_MS } = await import('@/lib/ai/consultation-request-time-limit');

const SESSION_ID = 'session-1';
const OTHER_SESSION_ID = 'session-2';
const NEW_SESSION_ID = 'session-new';
const MAIN_SESSION_TITLE = 'いつもの相談';
const OTHER_SESSION_TITLE = '別の相談';
const SESSIONS_KEY = 'GET /api/ai/consultation/sessions?status=all';
const CREATE_SESSION_KEY = 'POST /api/ai/consultation/sessions';
const messagesKey = (sessionId: string) => `GET /api/ai/consultation/sessions/${sessionId}/messages`;
const closeKey = (sessionId: string) => `POST /api/ai/consultation/sessions/${sessionId}/close`;
const dayMenuStatusKey = (requestId: string) => `GET /api/ai/menu/weekly/status?requestId=${requestId}`;
/** 1日献立の作成の依頼の id (v4.generate の応答。#2254 M1) */
const DAY_MENU_REQUEST_ID = 'req-day-menu';

/** 相談 A (SESSION_ID) の会話の返答の文 */
const MAIN_REPLY_TEXT = '野菜を足しましょう';
const MAIN_MESSAGES = [
  { id: 'old-user', role: 'user', content: '夕飯の相談です', createdAt: '2026-11-01T00:00:00.000Z' },
  { id: 'old-ai', role: 'assistant', content: MAIN_REPLY_TEXT, createdAt: '2026-11-01T00:00:01.000Z' },
];
/** 相談 B (OTHER_SESSION_ID) の会話の返答の文 */
const OTHER_REPLY_TEXT = '別の相談の返答です';
const OTHER_MESSAGES = [
  { id: 'other-ai', role: 'assistant', content: OTHER_REPLY_TEXT, createdAt: '2026-10-30T00:00:01.000Z' },
];
/** 新しい相談のようこその一文の書き出し (部品の文が変わったらこのテストも直す) */
const WELCOME_TEXT = 'ほめゴハンのAIアドバイザーです';
const DAY_MENU_STARTED_TEXT = 'の献立を作成中...';

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;
let handlers: Record<string, FetchHandler>;
/** 部品が出した fetch の `METHOD url` (順に) */
let requests: string[];
const originalSetPointerCapture = HTMLElement.prototype.setPointerCapture;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.cookie = 'aiChatBubblePosition=; max-age=0; path=/';
  localStorage.clear();
  HTMLElement.prototype.setPointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('alert', vi.fn());
  vi.spyOn(console, 'error').mockImplementation(() => {});
  delete window.__weeklyCurrentDate;
  consent.gate = null;
  v4.generate.mockReset();
  v4.options = null;
  v4.unsubscribe.mockReset();
  v4.subscribeToProgress.mockReset();
  v4.subscribeToProgress.mockReturnValue(v4.unsubscribe);
  v4.cancelGeneration.mockReset();
  v4.useRealHook = false;
  requests = [];
  handlers = {
    [SESSIONS_KEY]: async () =>
      json(200, {
        sessions: [
          { id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2 },
          { id: OTHER_SESSION_ID, title: OTHER_SESSION_TITLE, messageCount: 1 },
        ],
      }),
    [messagesKey(SESSION_ID)]: async () => json(200, { messages: MAIN_MESSAGES }),
    [messagesKey(OTHER_SESSION_ID)]: async () => json(200, { messages: OTHER_MESSAGES }),
    [CREATE_SESSION_KEY]: async () => json(200, { session: { id: NEW_SESSION_ID } }),
    [closeKey(SESSION_ID)]: async () => json(200, { summary: null }),
    [closeKey(OTHER_SESSION_ID)]: async () => json(200, { summary: null }),
    // 1日献立の作成の依頼の状態の読み直し (#2254 M1)。既定はまだ作成中 (終わりは Realtime の通知を待つ)
    [dayMenuStatusKey(DAY_MENU_REQUEST_ID)]: async () => json(200, { status: 'processing', errorMessage: null }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${(init?.method ?? 'GET').toUpperCase()} ${url}`;
      requests.push(key);
      const handler = handlers[key];
      if (!handler) throw new Error(`想定していない fetch: ${key}`);
      return handler(url, init);
    }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  HTMLElement.prototype.setPointerCapture = originalSetPointerCapture;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function text(): string {
  return container.textContent ?? '';
}

/** 条件が真になるまで待つ (実時間。1 回の待ちと上限は tests/helpers/act-wait.ts) */
async function waitFor(condition: () => boolean) {
  await pollUntil(condition);
  expect(condition()).toBe(true);
}

/**
 * 押下・応答のあとに何も起きないことを確かめるときに待つ実時間 (ミリ秒)。続き (fetch は mock) はマイクロタスクで進むので、
 * 待ちの 1 回 (tests/helpers/act-wait.ts の ACT_WAIT_POLL_MS = 20) より少し長く取る
 */
const SETTLE_MS = 50;

async function settle() {
  await act(async () => {
    await sleepRealTime(SETTLE_MS);
  });
}

function requestCount(key: string): number {
  return requests.filter((r) => r === key).length;
}

function hold(key: string): Deferred<Response> {
  const pending = deferred<Response>();
  handlers[key] = () => pending.promise;
  return pending;
}

function fab(): HTMLElement {
  const button = container.querySelector<HTMLElement>('[data-testid="ai-chat-floating-button"]');
  expect(button).not.toBeNull();
  return button!;
}

/** 浮かんでいるボタンを押してチャットを開く (開いたあとの読み込みは待たない) */
async function pressFab() {
  await act(async () => {
    fab().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
    fab().dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 0, clientY: 0 }));
  });
}

async function render() {
  await act(async () => {
    root.render(createElement(AIChatBubble));
  });
}

/** チャットを開き、shownText (会話の文) が出るまで待つ */
async function openChat(shownText = MAIN_REPLY_TEXT) {
  await render();
  await pressFab();
  await waitFor(() => text().includes(shownText));
}

/** チャットを閉じる (×)。開閉の連続クリック防止 (CHAT_OPEN_TOGGLE_LOCK_MS) は × が下ろす */
async function closeChatWindow() {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="AIチャットを閉じる"]');
  expect(button).not.toBeNull();
  await act(async () => {
    button!.click();
  });
  await waitFor(() => container.querySelector('[data-testid="ai-chat-floating-button"]') !== null);
}

function closeButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[title="相談を終了して要約を保存"]');
  expect(button).not.toBeNull();
  return button!;
}

function buttonWithText(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => (b.textContent ?? '').includes(label));
}

function dayMenuButton(): HTMLButtonElement {
  const button = buttonWithText('1日献立変更');
  expect(button).toBeDefined();
  return button!;
}

function createDayMenuButton(): HTMLButtonElement {
  const button = buttonWithText('作成する');
  expect(button).toBeDefined();
  return button!;
}

async function openSessionList() {
  const toggle = container.querySelector('svg.lucide-chevron-down')?.closest('button');
  expect(toggle).toBeTruthy();
  await act(async () => {
    toggle!.click();
  });
  await waitFor(() => buttonWithText('新しい相談を始める') !== undefined);
}

async function pressSessionRow(title: string) {
  const row = buttonWithText(title);
  expect(row).toBeDefined();
  await act(async () => {
    row!.click();
  });
}

async function clickClose(sessionId = SESSION_ID) {
  const before = requestCount(closeKey(sessionId));
  await act(async () => {
    closeButton().click();
  });
  await waitFor(() => requestCount(closeKey(sessionId)) === before + 1);
}

describe('#2245 K1 1 会話の読み込みは、返ったときに今出している相談のものだけを画面に置く', () => {
  it('(a) A→B と切り替えたあとに遅れて返った A の会話を、B の画面に出さない', async () => {
    const mainLoad = hold(messagesKey(SESSION_ID));
    await render();
    await pressFab();
    await waitFor(() => requestCount(messagesKey(SESSION_ID)) === 1);

    await openSessionList();
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => text().includes(OTHER_REPLY_TEXT));

    await act(async () => {
      mainLoad.resolve(json(200, { messages: MAIN_MESSAGES }));
    });
    await settle();

    expect(text()).toContain(OTHER_REPLY_TEXT);
    expect(text()).not.toContain(MAIN_REPLY_TEXT);
  });

  it('(b) 切り替えの直後に『相談を終了』を押すと、閉じたあとの新しい相談の画面に、遅れて返った閉じた相談の会話を出さない', async () => {
    await openChat();
    const otherLoad = hold(messagesKey(OTHER_SESSION_ID));
    await openSessionList();
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => requestCount(messagesKey(OTHER_SESSION_ID)) === 1);

    await clickClose(OTHER_SESSION_ID);
    await waitFor(() => requestCount(CREATE_SESSION_KEY) === 1 && text().includes(WELCOME_TEXT));

    await act(async () => {
      otherLoad.resolve(json(200, { messages: OTHER_MESSAGES }));
    });
    await settle();

    expect(text()).toContain(WELCOME_TEXT);
    expect(text()).not.toContain(OTHER_REPLY_TEXT);
  });

  it('(c) 閉じる応答待ちの間にチャットを閉じて開き直しても、開き直しは読み込まず、閉じたあとの新しい相談の画面のまま', async () => {
    await openChat();
    const close = hold(closeKey(SESSION_ID));
    await clickClose();
    // 開き直しの読み込みが走っても (直す前)、その会話は閉じる応答のあとまで返らないようにする
    const reopenLoad = hold(messagesKey(SESSION_ID));
    const sessionsBefore = requestCount(SESSIONS_KEY);
    const messagesBefore = requestCount(messagesKey(SESSION_ID));

    await closeChatWindow();
    await pressFab();
    await settle();
    expect(requestCount(SESSIONS_KEY)).toBe(sessionsBefore);
    expect(requestCount(messagesKey(SESSION_ID))).toBe(messagesBefore);

    await act(async () => {
      close.resolve(json(200, { summary: null }));
    });
    await waitFor(() => text().includes(WELCOME_TEXT));
    await act(async () => {
      reopenLoad.resolve(json(200, { messages: MAIN_MESSAGES }));
    });
    await settle();

    expect(text()).toContain(WELCOME_TEXT);
    expect(text()).not.toContain(MAIN_REPLY_TEXT);
  });

  it('(c) 開き直しの一覧を待つ間に『相談を終了』を押したら、一覧のあとも会話を読み込まない (閉じる側に任せる)', async () => {
    await openChat();
    await closeChatWindow();
    const sessionsLoad = hold(SESSIONS_KEY);
    await pressFab();
    await waitFor(() => requestCount(SESSIONS_KEY) === 2);
    const messagesBefore = requestCount(messagesKey(SESSION_ID));

    const close = hold(closeKey(SESSION_ID));
    await clickClose();
    await act(async () => {
      sessionsLoad.resolve(
        json(200, { sessions: [{ id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2 }] }),
      );
    });
    await settle();
    expect(requestCount(messagesKey(SESSION_ID))).toBe(messagesBefore);

    handlers[SESSIONS_KEY] = async () => json(200, { sessions: [] });
    await act(async () => {
      close.resolve(json(200, { summary: null }));
    });
    await waitFor(() => text().includes(WELCOME_TEXT));
    expect(requestCount(messagesKey(SESSION_ID))).toBe(messagesBefore);
  });

  it('対照: 切り替えた相談の会話は、その相談を出している間に返れば画面に出る', async () => {
    await openChat();
    const otherLoad = hold(messagesKey(OTHER_SESSION_ID));
    await openSessionList();
    await pressSessionRow(OTHER_SESSION_TITLE);
    await act(async () => {
      otherLoad.resolve(json(200, { messages: OTHER_MESSAGES }));
    });
    await waitFor(() => text().includes(OTHER_REPLY_TEXT));
    expect(text()).not.toContain(MAIN_REPLY_TEXT);
  });
});

describe('#2245 K1 2 相談を閉じる応答待ちの間は『1日献立変更』を止める', () => {
  it('描画の側: 閉じる応答待ちの間はボタンが止まり、応答のあとまた押せる', async () => {
    await openChat();
    expect(dayMenuButton().disabled).toBe(false);
    const close = hold(closeKey(SESSION_ID));
    await clickClose();

    expect(dayMenuButton().disabled).toBe(true);

    await act(async () => {
      close.resolve(json(200, { summary: null }));
    });
    await waitFor(() => text().includes(WELCOME_TEXT));
    await waitFor(() => !dayMenuButton().disabled);
  });

  it('描画の側: 開いたモーダルの「作成する」も、閉じる応答待ちの間は止まる', async () => {
    await openChat();
    await act(async () => {
      dayMenuButton().click();
    });
    expect(createDayMenuButton().disabled).toBe(false);
    const close = hold(closeKey(SESSION_ID));
    await clickClose();

    expect(createDayMenuButton().disabled).toBe(true);

    await act(async () => {
      close.resolve(json(200, { summary: null }));
    });
    await waitFor(() => !createDayMenuButton().disabled);
  });

  it('入口の側: 閉じると同じ描画のうちにモーダルの「作成する」を押しても作らない (作成中の一文も出さない)', async () => {
    await openChat();
    await act(async () => {
      dayMenuButton().click();
    });
    const close = hold(closeKey(SESSION_ID));
    await act(async () => {
      closeButton().click();
      createDayMenuButton().click();
    });
    await waitFor(() => requestCount(closeKey(SESSION_ID)) === 1);
    await settle();

    expect(v4.generate).not.toHaveBeenCalled();
    expect(text()).not.toContain(DAY_MENU_STARTED_TEXT);

    await act(async () => {
      close.resolve(json(200, { summary: null }));
    });
    await waitFor(() => text().includes(WELCOME_TEXT));
    expect(v4.generate).not.toHaveBeenCalled();
  });

  it('入口の側: 同意の確認を待つ間に閉じ始めたら、確認のあとも作らない', async () => {
    await openChat();
    await act(async () => {
      dayMenuButton().click();
    });
    const consentAnswer = deferred<void>();
    consent.gate = consentAnswer.promise;
    await act(async () => {
      createDayMenuButton().click();
    });
    const close = hold(closeKey(SESSION_ID));
    await clickClose();
    await act(async () => {
      consentAnswer.resolve();
    });
    await settle();

    expect(v4.generate).not.toHaveBeenCalled();
    expect(text()).not.toContain(DAY_MENU_STARTED_TEXT);

    await act(async () => {
      close.resolve(json(200, { summary: null }));
    });
    await waitFor(() => text().includes(WELCOME_TEXT));
    expect(v4.generate).not.toHaveBeenCalled();
  });
});

describe('#2245 K1 2 同じ型: 相談を閉じる応答待ちの間は、提案の「実行する」も止める', () => {
  const PROPOSAL_MESSAGE_ID = 'proposal-1';
  const executeKey = `POST /api/ai/consultation/actions/${PROPOSAL_MESSAGE_ID}/execute`;
  const PROPOSAL_MESSAGES = [
    {
      id: PROPOSAL_MESSAGE_ID,
      role: 'assistant',
      content: MAIN_REPLY_TEXT,
      proposedActions: { type: 'add_pantry_item', params: { name: '卵' } },
      createdAt: '2026-11-01T00:00:00.000Z',
    },
  ];

  function executeButton(): HTMLButtonElement {
    const button = buttonWithText('実行する');
    expect(button).toBeDefined();
    return button!;
  }

  beforeEach(() => {
    handlers[messagesKey(SESSION_ID)] = async () => json(200, { messages: PROPOSAL_MESSAGES });
    handlers[executeKey] = async () => json(200, { success: true, actionType: 'add_pantry_item', result: {} });
  });

  it('描画の側: 閉じる応答待ちの間はボタンが止まる', async () => {
    await openChat();
    expect(executeButton().disabled).toBe(false);
    hold(closeKey(SESSION_ID));
    await clickClose();

    expect(executeButton().disabled).toBe(true);
  });

  it('入口の側: 閉じると同じ描画のうちに押しても、実行の API を呼ばない', async () => {
    await openChat();
    const close = hold(closeKey(SESSION_ID));
    await act(async () => {
      closeButton().click();
      executeButton().click();
    });
    await waitFor(() => requestCount(closeKey(SESSION_ID)) === 1);
    await settle();
    expect(requestCount(executeKey)).toBe(0);

    await act(async () => {
      close.resolve(json(200, { summary: null }));
    });
    await waitFor(() => text().includes(WELCOME_TEXT));
    expect(requestCount(executeKey)).toBe(0);
  });

  it('入口の側: 同意の確認を待つ間に閉じ始めたら、確認のあとも実行の API を呼ばない', async () => {
    await openChat();
    const consentAnswer = deferred<void>();
    consent.gate = consentAnswer.promise;
    await act(async () => {
      executeButton().click();
    });
    const close = hold(closeKey(SESSION_ID));
    await clickClose();
    await act(async () => {
      consentAnswer.resolve();
    });
    await settle();
    expect(requestCount(executeKey)).toBe(0);

    await act(async () => {
      close.resolve(json(200, { summary: null }));
    });
    await waitFor(() => text().includes(WELCOME_TEXT));
    expect(requestCount(executeKey)).toBe(0);
  });

  it('対照: 閉じていない間は実行する', async () => {
    await openChat();
    await act(async () => {
      executeButton().click();
    });
    await waitFor(() => requestCount(executeKey) === 1);
  });
});

describe('#2245 K1 3 『相談を終了』の失敗を知らせる', () => {
  async function closeWith(response: () => Promise<Response>) {
    await openChat();
    handlers[closeKey(SESSION_ID)] = response;
    await clickClose();
    await waitFor(() => !closeButton().disabled);
  }

  it('400 (すでに終了している): 一覧を読み直し、『すでに終了しています』を出す', async () => {
    await openChat();
    const sessionsBefore = requestCount(SESSIONS_KEY);
    handlers[closeKey(SESSION_ID)] = async () => json(400, { error: AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE });
    await clickClose();
    await waitFor(() => text().includes(AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE));

    expect(requestCount(SESSIONS_KEY)).toBe(sessionsBefore + 1);
    // 閉じていないので、新しい相談は作らない
    expect(requestCount(CREATE_SESSION_KEY)).toBe(0);
  });

  it.each([
    ['403 規約の同意が必要', 403, { error: LEGAL_CONSENT_REQUIRED_MESSAGE, code: LEGAL_CONSENT_REQUIRED_CODE }, LEGAL_CONSENT_REQUIRED_MESSAGE],
    ['503 AI 相談の緊急停止', 503, { error: 'x', code: AI_CHAT_DISABLED_CODE }, AI_CHAT_DISABLED_MESSAGE],
    ['503 メンテナンス中', 503, { error: 'x', code: MAINTENANCE_API_CODE }, MAINTENANCE_MESSAGE],
    ['500', 500, { error: 'internal' }, CONSULTATION_CLOSE_FAILED_MESSAGE],
    ['429 回数の上限', 429, { error: 'rate limited' }, CONSULTATION_CLOSE_FAILED_MESSAGE],
  ])('%s: 固定の文を出し、一覧は読み直さない', async (_label, status, body, expected) => {
    await openChat();
    const sessionsBefore = requestCount(SESSIONS_KEY);
    handlers[closeKey(SESSION_ID)] = async () => json(status, body);
    await clickClose();
    await waitFor(() => text().includes(expected));

    expect(requestCount(SESSIONS_KEY)).toBe(sessionsBefore);
    expect(requestCount(CREATE_SESSION_KEY)).toBe(0);
    // 会話は消さない
    expect(text()).toContain(MAIN_REPLY_TEXT);
  });

  it('通信の失敗 (fetch が投げる): 固定の失敗の文を出す', async () => {
    await closeWith(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(text()).toContain(CONSULTATION_CLOSE_FAILED_MESSAGE);
  });

  it('対照: 成功のときは失敗の文を出さない', async () => {
    await openChat();
    await clickClose();
    await waitFor(() => text().includes(WELCOME_TEXT));
    expect(text()).not.toContain(CONSULTATION_CLOSE_FAILED_MESSAGE);
    expect(text()).not.toContain(AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE);
  });
});

describe('#2245 K1 3 consultationCloseFailureOf の出し分け', () => {
  it.each<[string, number, unknown, ReturnType<typeof consultationCloseFailureOf>]>([
    ['400', 400, { error: AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE }, { kind: 'already-closed', message: AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE }],
    ['403 同意', 403, { code: LEGAL_CONSENT_REQUIRED_CODE }, { kind: 'failed', message: LEGAL_CONSENT_REQUIRED_MESSAGE }],
    ['403 同意でない', 403, { code: 'AUTH_ACCOUNT_FROZEN' }, { kind: 'failed', message: CONSULTATION_CLOSE_FAILED_MESSAGE }],
    ['403 本文なし', 403, null, { kind: 'failed', message: CONSULTATION_CLOSE_FAILED_MESSAGE }],
    ['503 緊急停止', 503, { code: AI_CHAT_DISABLED_CODE }, { kind: 'failed', message: AI_CHAT_DISABLED_MESSAGE }],
    ['503 code なし', 503, {}, { kind: 'failed', message: CONSULTATION_CLOSE_FAILED_MESSAGE }],
    ['404', 404, { error: 'not found' }, { kind: 'failed', message: CONSULTATION_CLOSE_FAILED_MESSAGE }],
  ])('%s', (_label, status, body, expected) => {
    expect(consultationCloseFailureOf(status, body)).toEqual(expected);
  });
});

/** JST の 2026-11-05 10:00 (UTC の 01:00) */
const JST_NOV_5_MORNING = new Date('2026-11-05T01:00:00.000Z');

/** 時刻 now にチャットを開いて「1日献立変更」を開き、日付の欄を返す */
async function openDayMenuAt(now: Date): Promise<HTMLInputElement> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  await openChat();
  await act(async () => {
    dayMenuButton().click();
  });
  const input = container.querySelector<HTMLInputElement>('input[type="date"]');
  expect(input).not.toBeNull();
  return input!;
}

/** 日付の欄の値を変える (利用者が欄を消した・選び直したとき) */
async function setDateField(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('#2245 K1 4 1 日分の献立は、日付が実在する暦日で欄の範囲の中のときだけ作る', () => {
  it('日付の欄を空にすると「作成する」が止まり、押しても NaN の一文を出さず、依頼もしない', async () => {
    const input = await openDayMenuAt(JST_NOV_5_MORNING);
    await setDateField(input, '');
    expect(input.value).toBe('');

    expect(createDayMenuButton().disabled).toBe(true);
    await act(async () => {
      createDayMenuButton().click();
    });
    await settle();

    expect(text()).not.toContain('NaN');
    expect(text()).not.toContain(DAY_MENU_STARTED_TEXT);
    expect(v4.generate).not.toHaveBeenCalled();
  });

  it.each([
    ['下限 (今日) の前の日', '2026-11-04'],
    ['上限 (14 日後) の次の日', '2026-11-20'],
  ])('%s (%s) は「作成する」が止まり、依頼しない', async (_label, value) => {
    const input = await openDayMenuAt(JST_NOV_5_MORNING);
    await setDateField(input, value);
    expect(input.value).toBe(value);

    expect(createDayMenuButton().disabled).toBe(true);
    await act(async () => {
      createDayMenuButton().click();
    });
    await settle();
    expect(v4.generate).not.toHaveBeenCalled();
  });

  it.each([
    ['下限 (今日)', '2026-11-05', '11月5日'],
    ['上限 (14 日後)', '2026-11-19', '11月19日'],
  ])('対照: %s (%s) は作れる', async (_label, value, monthDay) => {
    const input = await openDayMenuAt(JST_NOV_5_MORNING);
    await setDateField(input, value);

    expect(createDayMenuButton().disabled).toBe(false);
    await act(async () => {
      createDayMenuButton().click();
    });
    await waitFor(() => v4.generate.mock.calls.length === 1);
    expect(text()).toContain(`🍳 ${monthDay}${DAY_MENU_STARTED_TEXT}`);
    const [request] = v4.generate.mock.calls[0] as [{ targetSlots: Array<{ date: string }> }];
    expect(request.targetSlots.map((slot) => slot.date)).toEqual([value, value, value]);
  });
});

/** 日付の欄の下に出る、作成できない理由の一文 (無ければ null) */
function unselectableReason(): string | null {
  return container.querySelector('[data-testid="day-menu-date-unselectable"]')?.textContent ?? null;
}

/** 「作成する」を押し、依頼が 1 回出るまで待って、依頼した日付 (朝・昼・夕) を返す */
async function createAndRequestedDates(): Promise<string[]> {
  await act(async () => {
    createDayMenuButton().click();
  });
  await waitFor(() => v4.generate.mock.calls.length === 1);
  const [request] = v4.generate.mock.calls[0] as [{ targetSlots: Array<{ date: string }> }];
  return request.targetSlots.map((slot) => slot.date);
}

describe('#2245 L1 1 日分の献立の既定の日: 週の画面の表示の日が欄の範囲の外なら明日 (開いた直後から作れる)', () => {
  // JST の今日は 2026-11-05。欄の範囲は 2026-11-05〜2026-11-19、明日は 2026-11-06
  it.each([
    ['過去の週の日', '2026-11-01', '2026-11-06'],
    ['0 時をまたいだ前日 (昨日)', '2026-11-04', '2026-11-06'],
    ['15 日後 (上限の次の日)', '2026-11-20', '2026-11-06'],
    ['ずっと先の日', '2026-12-25', '2026-11-06'],
    ['今日 (今日を黙って作り直さない)', '2026-11-05', '2026-11-06'],
    ['実在しない暦日', '2026-02-30', '2026-11-06'],
    ['範囲の中 (表示の日のまま)', '2026-11-10', '2026-11-10'],
    ['上限 (14 日後。表示の日のまま)', '2026-11-19', '2026-11-19'],
    ['明日 (表示の日のまま)', '2026-11-06', '2026-11-06'],
  ])('表示の日が%s (%s) なら既定の日は %s で、理由の文を出さずにそのまま作れる', async (_label, weeklyDate, expected) => {
    window.__weeklyCurrentDate = weeklyDate;
    const input = await openDayMenuAt(JST_NOV_5_MORNING);

    expect(input.value).toBe(expected);
    expect(unselectableReason()).toBeNull();
    expect(createDayMenuButton().disabled).toBe(false);
    expect(await createAndRequestedDates()).toEqual([expected, expected, expected]);
  });

  it('表示の日が無いときは明日 (対照)', async () => {
    const input = await openDayMenuAt(JST_NOV_5_MORNING);
    expect(input.value).toBe('2026-11-06');
    expect(createDayMenuButton().disabled).toBe(false);
  });

  it('開くたびに表示の日を読み直す: 範囲の中の日のあとに範囲の外の日を表示して開き直すと明日', async () => {
    window.__weeklyCurrentDate = '2026-11-10';
    const input = await openDayMenuAt(JST_NOV_5_MORNING);
    expect(input.value).toBe('2026-11-10');
    const cancel = buttonWithText('キャンセル');
    expect(cancel).toBeDefined();
    await act(async () => {
      cancel!.click();
    });
    expect(container.querySelector('input[type="date"]')).toBeNull();

    window.__weeklyCurrentDate = '2026-10-29';
    await act(async () => {
      dayMenuButton().click();
    });
    const reopened = container.querySelector<HTMLInputElement>('input[type="date"]');
    expect(reopened).not.toBeNull();
    expect(reopened!.value).toBe('2026-11-06');
    expect(createDayMenuButton().disabled).toBe(false);
  });
});

describe('#2245 L1 1 日分の献立の日付の欄を範囲の外・空にしたら、「作成する」を止めたうえで欄の下に理由の一文を出す', () => {
  it.each([
    ['空', ''],
    ['下限 (今日) の前の日', '2026-11-04'],
    ['上限 (14 日後) の次の日', '2026-11-20'],
  ])('%s (%s): 理由の文が出て、作成できない', async (_label, value) => {
    const input = await openDayMenuAt(JST_NOV_5_MORNING);
    expect(unselectableReason()).toBeNull();

    await setDateField(input, value);
    expect(input.value).toBe(value);
    expect(unselectableReason()).toBe(DAY_MENU_DATE_UNSELECTABLE_MESSAGE);
    expect(createDayMenuButton().disabled).toBe(true);
    await act(async () => {
      createDayMenuButton().click();
    });
    await settle();
    expect(v4.generate).not.toHaveBeenCalled();
    expect(text()).not.toContain(DAY_MENU_STARTED_TEXT);
  });

  it('選び直して範囲の中にすると、理由の文が消えて作れる', async () => {
    const input = await openDayMenuAt(JST_NOV_5_MORNING);
    await setDateField(input, '2026-11-20');
    expect(unselectableReason()).toBe(DAY_MENU_DATE_UNSELECTABLE_MESSAGE);

    await setDateField(input, '2026-11-12');
    expect(unselectableReason()).toBeNull();
    expect(createDayMenuButton().disabled).toBe(false);
    expect(await createAndRequestedDates()).toEqual(['2026-11-12', '2026-11-12', '2026-11-12']);
  });

  it('理由の文は、欄の下の案内 (今日から2週間先まで選択できます) と別の一文', () => {
    expect(DAY_MENU_DATE_UNSELECTABLE_MESSAGE).not.toContain('選択できます');
  });
});

/**
 * act の中でマイクロタスクを流す回数の上限 (描画は act を抜けるまで流れないので、ボタンを止める描画の前の押下を作れる)。
 * 同意の確認 (mock の async 関数) と aiFetch・献立の依頼の await を抜けるのに足りる数 (数回で済む。多めに取る)
 */
const MICROTASK_FLUSH_LIMIT = 50;

/** act の中で、condition が真になるまでマイクロタスクを流す (上限 MICROTASK_FLUSH_LIMIT 回) */
async function flushMicrotasksUntil(condition: () => boolean) {
  for (let i = 0; i < MICROTASK_FLUSH_LIMIT && !condition(); i += 1) {
    await Promise.resolve();
  }
  expect(condition()).toBe(true);
}

const DAY_MENU_DONE_TEXT = '献立の作成が完了しました';

/** 「1日献立変更」を開いて「作成する」を押し、依頼が出るまで待つ (完了・失敗はテストが v4.options で起こす) */
async function startDayMenu() {
  await act(async () => {
    dayMenuButton().click();
  });
  await act(async () => {
    createDayMenuButton().click();
  });
  await waitFor(() => v4.generate.mock.calls.length === 1);
}

describe('#2254 M1 1 1日献立の作成の最中は『相談を終了』を止める (作成中の一文を消さない)', () => {
  beforeEach(() => {
    v4.generate.mockResolvedValue({ requestId: DAY_MENU_REQUEST_ID });
  });

  it('描画の側: 作成の最中はボタンが止まり、押しても閉じず、作成中の一文が残る。完了の一文のあとまた押せる', async () => {
    await openChat();
    await startDayMenu();
    await waitFor(() => closeButton().disabled);

    await act(async () => {
      closeButton().click();
    });
    await settle();
    expect(requestCount(closeKey(SESSION_ID))).toBe(0);
    expect(text()).toContain(DAY_MENU_STARTED_TEXT);

    await act(async () => {
      v4.options?.onGenerationComplete?.();
    });
    await waitFor(() => !closeButton().disabled);
    expect(text()).toContain(DAY_MENU_STARTED_TEXT);
    expect(text()).toContain(DAY_MENU_DONE_TEXT);
  });

  it('描画の側: 作成が失敗した (onError) あとはまた押せる (ずっと止めない)', async () => {
    await openChat();
    await startDayMenu();
    await waitFor(() => closeButton().disabled);

    await act(async () => {
      v4.options?.onError?.('生成に失敗しました');
    });
    await waitFor(() => !closeButton().disabled);
    await clickClose();
    await waitFor(() => text().includes(WELCOME_TEXT));
  });

  it('依頼が失敗した (generate が投げた) ときは、作成は始まっていないので止めない', async () => {
    v4.generate.mockRejectedValue(new Error('生成リクエストに失敗しました'));
    await openChat();
    await startDayMenu();
    await settle();

    expect(closeButton().disabled).toBe(false);
    await clickClose();
    await waitFor(() => text().includes(WELCOME_TEXT));
  });

  it('進捗を追えない (依頼の応答に requestId が無い) ときは止めない (完了・失敗が届かない)', async () => {
    v4.generate.mockResolvedValue({});
    await openChat();
    await startDayMenu();
    await settle();

    expect(closeButton().disabled).toBe(false);
  });

  it('入口の側: 作成を始めたのと同じ描画のうちに (止める描画の前に) 押しても閉じない', async () => {
    await openChat();
    await act(async () => {
      dayMenuButton().click();
    });
    await act(async () => {
      createDayMenuButton().click();
      await flushMicrotasksUntil(() => v4.generate.mock.calls.length === 1);
      // まだ止める描画の前 (ボタンは押せる) に押す
      expect(closeButton().disabled).toBe(false);
      closeButton().click();
    });
    await settle();

    expect(requestCount(closeKey(SESSION_ID))).toBe(0);
    expect(text()).toContain(DAY_MENU_STARTED_TEXT);
  });

  it('対照: 作成を始めていない間は閉じられる', async () => {
    await openChat();
    expect(closeButton().disabled).toBe(false);
    await clickClose();
    await waitFor(() => text().includes(WELCOME_TEXT));
  });
});

describe('#2254 M1 1 同じ型: 提案の実行の応答待ちの最中は『相談を終了』を止める (結果の一文を新しい相談の画面に出さない)', () => {
  const PROPOSAL_MESSAGE_ID = 'proposal-m1';
  const executeKey = `POST /api/ai/consultation/actions/${PROPOSAL_MESSAGE_ID}/execute`;
  const PROPOSAL_MESSAGES = [
    {
      id: PROPOSAL_MESSAGE_ID,
      role: 'assistant',
      content: MAIN_REPLY_TEXT,
      proposedActions: { type: 'add_pantry_item', params: { name: '卵' } },
      createdAt: '2026-11-01T00:00:00.000Z',
    },
  ];
  const EXECUTED_RESPONSE = { success: true, actionType: 'add_pantry_item', result: {} };

  beforeEach(() => {
    handlers[messagesKey(SESSION_ID)] = async () => json(200, { messages: PROPOSAL_MESSAGES });
  });

  function executeButton(): HTMLButtonElement {
    const button = buttonWithText('実行する');
    expect(button).toBeDefined();
    return button!;
  }

  it('描画の側: 実行の応答待ちの間はボタンが止まり、押しても閉じない。結果のあとまた押せる', async () => {
    await openChat();
    const execute = hold(executeKey);
    await act(async () => {
      executeButton().click();
    });
    await waitFor(() => requestCount(executeKey) === 1);
    await waitFor(() => closeButton().disabled);

    await act(async () => {
      closeButton().click();
    });
    await settle();
    expect(requestCount(closeKey(SESSION_ID))).toBe(0);

    await act(async () => {
      execute.resolve(json(200, EXECUTED_RESPONSE));
    });
    await waitFor(() => !closeButton().disabled);
    expect(requestCount(closeKey(SESSION_ID))).toBe(0);
  });

  it('描画の側: 実行が失敗した (通信の失敗) あともまた押せる', async () => {
    await openChat();
    const execute = hold(executeKey);
    await act(async () => {
      executeButton().click();
    });
    await waitFor(() => closeButton().disabled);

    await act(async () => {
      execute.reject(new TypeError('Failed to fetch'));
    });
    await waitFor(() => !closeButton().disabled);
  });

  it('入口の側: 実行の API を呼んだのと同じ描画のうちに (止める描画の前に) 押しても閉じない', async () => {
    await openChat();
    const execute = hold(executeKey);
    await act(async () => {
      executeButton().click();
      await flushMicrotasksUntil(() => requestCount(executeKey) === 1);
      expect(closeButton().disabled).toBe(false);
      closeButton().click();
    });
    await settle();
    expect(requestCount(closeKey(SESSION_ID))).toBe(0);

    await act(async () => {
      execute.resolve(json(200, EXECUTED_RESPONSE));
    });
    await waitFor(() => !closeButton().disabled);
    expect(requestCount(closeKey(SESSION_ID))).toBe(0);
  });
});

/** 会話の場所の読み込み中の輪 (読み込み中の印) が出ているか */
function loadingSpinnerShown(): boolean {
  return container.querySelector('.animate-spin') !== null;
}

describe('#2254 M1 2 遅れて返った一覧・会話の読み込みは、あとの操作の画面を上書きしない (最後の操作が勝つ)', () => {
  it('(a) 初めて開いた一覧を待つ間に『新しい相談』を始めたら、一覧のあとも新しい相談のまま (一覧の相談で上書きしない)', async () => {
    const sessionsLoad = hold(SESSIONS_KEY);
    await render();
    await pressFab();
    await waitFor(() => requestCount(SESSIONS_KEY) === 1);

    await openSessionList();
    const newSession = buttonWithText('新しい相談を始める');
    await act(async () => {
      newSession!.click();
    });
    await waitFor(() => text().includes(WELCOME_TEXT));

    await act(async () => {
      sessionsLoad.resolve(
        json(200, { sessions: [{ id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2 }] }),
      );
    });
    await settle();

    expect(requestCount(messagesKey(SESSION_ID))).toBe(0);
    expect(text()).toContain(WELCOME_TEXT);
    expect(text()).not.toContain(MAIN_REPLY_TEXT);
  });

  it('(a) 開き直しの一覧を待つ間に相談を切り替えたら、一覧のあとも切り替えた相談のまま (前の相談を読み直さない)', async () => {
    await openChat();
    await closeChatWindow();
    const sessionsLoad = hold(SESSIONS_KEY);
    await pressFab();
    await waitFor(() => requestCount(SESSIONS_KEY) === 2);

    await openSessionList();
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => text().includes(OTHER_REPLY_TEXT));
    const mainLoadsBefore = requestCount(messagesKey(SESSION_ID));

    await act(async () => {
      sessionsLoad.resolve(
        json(200, {
          sessions: [
            { id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2 },
            { id: OTHER_SESSION_ID, title: OTHER_SESSION_TITLE, messageCount: 1 },
          ],
        }),
      );
    });
    await settle();

    expect(requestCount(messagesKey(SESSION_ID))).toBe(mainLoadsBefore);
    expect(text()).toContain(OTHER_REPLY_TEXT);
    expect(text()).not.toContain(MAIN_REPLY_TEXT);
  });

  it('(a) 同じ型: 新しい相談の作成を待つ間に相談を切り替えたら、作成のあとも切り替えた相談のまま', async () => {
    await openChat();
    await openSessionList();
    const create = hold(CREATE_SESSION_KEY);
    const newSession = buttonWithText('新しい相談を始める');
    await act(async () => {
      newSession!.click();
    });
    await waitFor(() => requestCount(CREATE_SESSION_KEY) === 1);

    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => text().includes(OTHER_REPLY_TEXT));

    await act(async () => {
      create.resolve(json(200, { session: { id: NEW_SESSION_ID } }));
    });
    await settle();

    expect(text()).toContain(OTHER_REPLY_TEXT);
    expect(text()).not.toContain(WELCOME_TEXT);
  });

  it('(b) 閉じる前に始めた一覧が、閉じる側の読み直しより後に返っても、閉じた相談を終了の一覧で出す', async () => {
    await openChat();
    await closeChatWindow();
    const reopenSessions = hold(SESSIONS_KEY);
    await pressFab();
    await waitFor(() => requestCount(SESSIONS_KEY) === 2);

    // 閉じる側の読み直しの一覧 (閉じた相談は終了)
    handlers[SESSIONS_KEY] = async () =>
      json(200, {
        sessions: [
          { id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2, status: 'closed' },
          { id: OTHER_SESSION_ID, title: OTHER_SESSION_TITLE, messageCount: 1, status: 'active' },
        ],
      });
    await clickClose();
    await waitFor(() => text().includes(WELCOME_TEXT) && requestCount(SESSIONS_KEY) === 3);

    // 閉じる前に始めた開き直しの一覧 (閉じた相談がまだ終了でない) が後から返る
    await act(async () => {
      reopenSessions.resolve(
        json(200, {
          sessions: [
            { id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2, status: 'active' },
            { id: OTHER_SESSION_ID, title: OTHER_SESSION_TITLE, messageCount: 1, status: 'active' },
          ],
        }),
      );
    });
    await settle();

    await openSessionList();
    const closedRow = buttonWithText(MAIN_SESSION_TITLE);
    expect(closedRow).toBeDefined();
    expect(closedRow!.textContent).toContain('終了');
    expect(text()).toContain(WELCOME_TEXT);
  });

  it('(c) 前の相談の遅れた会話の読み込みが終わっても、今の読み込みの最中の印を消さない', async () => {
    const mainLoad = hold(messagesKey(SESSION_ID));
    await render();
    await pressFab();
    await waitFor(() => requestCount(messagesKey(SESSION_ID)) === 1);

    const otherLoad = hold(messagesKey(OTHER_SESSION_ID));
    await openSessionList();
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => requestCount(messagesKey(OTHER_SESSION_ID)) === 1);
    expect(loadingSpinnerShown()).toBe(true);

    await act(async () => {
      mainLoad.resolve(json(200, { messages: MAIN_MESSAGES }));
    });
    await settle();
    expect(loadingSpinnerShown()).toBe(true);
    expect(text()).not.toContain(MAIN_REPLY_TEXT);

    await act(async () => {
      otherLoad.resolve(json(200, { messages: OTHER_MESSAGES }));
    });
    await waitFor(() => text().includes(OTHER_REPLY_TEXT));
    expect(loadingSpinnerShown()).toBe(false);
  });

  it('対照: 一覧を待つ間に何もしなければ、一覧の相談を出して会話を読む', async () => {
    const sessionsLoad = hold(SESSIONS_KEY);
    await render();
    await pressFab();
    await waitFor(() => requestCount(SESSIONS_KEY) === 1);
    await act(async () => {
      sessionsLoad.resolve(
        json(200, { sessions: [{ id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2 }] }),
      );
    });
    await waitFor(() => text().includes(MAIN_REPLY_TEXT));
    expect(requestCount(CREATE_SESSION_KEY)).toBe(0);
  });
});

describe('#2254 M1 同じ型: 作成の最中・実行の応答待ちの止めは、重なり・新しい相談・相談の切り替え・開き直しでも外れない', () => {
  const PROPOSAL_A_ID = 'proposal-a';
  const PROPOSAL_B_ID = 'proposal-b';
  const executeKeyOf = (messageId: string) => `POST /api/ai/consultation/actions/${messageId}/execute`;
  const proposalMessage = (id: string, createdAt: string) => ({
    id,
    role: 'assistant',
    content: MAIN_REPLY_TEXT,
    proposedActions: { type: 'add_pantry_item', params: { name: '卵' } },
    createdAt,
  });
  const EXECUTED_RESPONSE = { success: true, actionType: 'add_pantry_item', result: {} };
  const EXECUTED_TEXT = '実行しました';

  beforeEach(() => {
    v4.generate.mockResolvedValue({ requestId: DAY_MENU_REQUEST_ID });
  });

  function executeButtons(): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter((b) =>
      (b.textContent ?? '').includes('実行する'),
    );
  }

  /** 提案のカードを 2 枚 (A・B の順) 出す */
  function withTwoProposals() {
    handlers[messagesKey(SESSION_ID)] = async () =>
      json(200, {
        messages: [
          proposalMessage(PROPOSAL_A_ID, '2026-11-01T00:00:00.000Z'),
          proposalMessage(PROPOSAL_B_ID, '2026-11-01T00:00:01.000Z'),
        ],
      });
  }

  /** 提案のカードを 1 枚 (A) 出す */
  function withOneProposal() {
    handlers[messagesKey(SESSION_ID)] = async () =>
      json(200, { messages: [proposalMessage(PROPOSAL_A_ID, '2026-11-01T00:00:00.000Z')] });
  }

  function newSessionButton(): HTMLButtonElement {
    const button = buttonWithText('新しい相談を始める');
    expect(button).toBeDefined();
    return button!;
  }

  function sessionRow(title: string): HTMLButtonElement {
    const row = buttonWithText(title);
    expect(row).toBeDefined();
    return row!;
  }

  it('(a) 2 枚のカードの実行が重なり、先の 1 件だけ応答が返っても『相談を終了』は止まったまま (押しても閉じない)。残りの実行中の印も残る', async () => {
    withTwoProposals();
    await openChat();
    const executeA = hold(executeKeyOf(PROPOSAL_A_ID));
    const executeB = hold(executeKeyOf(PROPOSAL_B_ID));
    expect(executeButtons()).toHaveLength(2);
    await act(async () => {
      executeButtons()[0].click();
    });
    await act(async () => {
      executeButtons()[1].click();
    });
    await waitFor(() => requestCount(executeKeyOf(PROPOSAL_A_ID)) === 1 && requestCount(executeKeyOf(PROPOSAL_B_ID)) === 1);
    await waitFor(() => closeButton().disabled);

    // 先に A の応答だけ返る (A のカードは実行済みで消え、B のカードだけ残る)
    await act(async () => {
      executeA.resolve(json(200, EXECUTED_RESPONSE));
    });
    await waitFor(() => executeButtons().length === 1);
    await settle();
    expect(closeButton().disabled).toBe(true);
    // B はまだ応答待ち: B の「実行する」も止まったまま (重ねて実行させない)
    expect(executeButtons()[0].disabled).toBe(true);
    await act(async () => {
      closeButton().click();
    });
    await settle();
    expect(requestCount(closeKey(SESSION_ID))).toBe(0);

    await act(async () => {
      executeB.resolve(json(200, EXECUTED_RESPONSE));
    });
    await waitFor(() => !closeButton().disabled);
    expect(requestCount(closeKey(SESSION_ID))).toBe(0);
  });

  it('(b) 作成の最中は『新しい相談を始める』・相談の行が止まり、押しても会話を置き換えず、作成中の一文が残る。完了のあとまた押せる', async () => {
    await openChat();
    await openSessionList();
    await startDayMenu();
    await waitFor(() => newSessionButton().disabled);
    expect(sessionRow(OTHER_SESSION_TITLE).disabled).toBe(true);

    await act(async () => {
      newSessionButton().click();
    });
    await pressSessionRow(OTHER_SESSION_TITLE);
    await settle();
    expect(requestCount(CREATE_SESSION_KEY)).toBe(0);
    expect(requestCount(messagesKey(OTHER_SESSION_ID))).toBe(0);
    expect(text()).toContain(DAY_MENU_STARTED_TEXT);

    await act(async () => {
      v4.options?.onGenerationComplete?.();
    });
    await waitFor(() => !newSessionButton().disabled);
    expect(sessionRow(OTHER_SESSION_TITLE).disabled).toBe(false);
    expect(text()).toContain(DAY_MENU_STARTED_TEXT);
    expect(text()).toContain(DAY_MENU_DONE_TEXT);
  });

  it('(b) 入口の側: 作成を始めたのと同じ描画のうちに (止める描画の前に) 新しい相談・相談の切り替えを押しても置き換えない', async () => {
    await openChat();
    await openSessionList();
    await act(async () => {
      dayMenuButton().click();
    });
    await act(async () => {
      createDayMenuButton().click();
      await flushMicrotasksUntil(() => v4.generate.mock.calls.length === 1);
      // まだ止める描画の前 (ボタンは押せる) に押す
      expect(newSessionButton().disabled).toBe(false);
      newSessionButton().click();
      sessionRow(OTHER_SESSION_TITLE).click();
    });
    await settle();

    expect(requestCount(CREATE_SESSION_KEY)).toBe(0);
    expect(requestCount(messagesKey(OTHER_SESSION_ID))).toBe(0);
    expect(text()).toContain(DAY_MENU_STARTED_TEXT);
  });

  it('(b) 実行の応答待ちの最中も『新しい相談を始める』・相談の行が止まり、結果の一文は今の相談の画面に出る。結果のあとまた押せる', async () => {
    withOneProposal();
    await openChat();
    await openSessionList();
    const execute = hold(executeKeyOf(PROPOSAL_A_ID));
    await act(async () => {
      executeButtons()[0].click();
    });
    await waitFor(() => newSessionButton().disabled);
    expect(sessionRow(OTHER_SESSION_TITLE).disabled).toBe(true);

    await act(async () => {
      newSessionButton().click();
    });
    await pressSessionRow(OTHER_SESSION_TITLE);
    await settle();
    expect(requestCount(CREATE_SESSION_KEY)).toBe(0);
    expect(requestCount(messagesKey(OTHER_SESSION_ID))).toBe(0);

    await act(async () => {
      execute.resolve(json(200, EXECUTED_RESPONSE));
    });
    await waitFor(() => !newSessionButton().disabled);
    expect(text()).toContain(EXECUTED_TEXT);
    expect(text()).toContain(MAIN_REPLY_TEXT);
    expect(text()).not.toContain(WELCOME_TEXT);
  });

  it('(b) 入口の側: 実行の API を呼んだのと同じ描画のうちに新しい相談・相談の切り替えを押しても置き換えない', async () => {
    withOneProposal();
    await openChat();
    await openSessionList();
    const execute = hold(executeKeyOf(PROPOSAL_A_ID));
    await act(async () => {
      executeButtons()[0].click();
      await flushMicrotasksUntil(() => requestCount(executeKeyOf(PROPOSAL_A_ID)) === 1);
      expect(newSessionButton().disabled).toBe(false);
      newSessionButton().click();
      sessionRow(OTHER_SESSION_TITLE).click();
    });
    await settle();
    expect(requestCount(CREATE_SESSION_KEY)).toBe(0);
    expect(requestCount(messagesKey(OTHER_SESSION_ID))).toBe(0);

    await act(async () => {
      execute.resolve(json(200, EXECUTED_RESPONSE));
    });
    await waitFor(() => text().includes(EXECUTED_TEXT));
    expect(text()).not.toContain(WELCOME_TEXT);
  });

  it('(c) 作成の最中にチャットを閉じて開き直しても、会話を読み直さず作成中の一文が残る', async () => {
    await openChat();
    await startDayMenu();
    await waitFor(() => closeButton().disabled);
    await closeChatWindow();
    const loadsBefore = requestCount(messagesKey(SESSION_ID));
    const sessionsBefore = requestCount(SESSIONS_KEY);

    await pressFab();
    await waitFor(() => requestCount(SESSIONS_KEY) === sessionsBefore + 1);
    await settle();
    expect(requestCount(messagesKey(SESSION_ID))).toBe(loadsBefore);
    expect(text()).toContain(DAY_MENU_STARTED_TEXT);
  });

  it('(c) 実行の応答待ちの最中にチャットを閉じて開き直しても、会話を読み直さず結果の一文が今の画面に出る', async () => {
    withOneProposal();
    await openChat();
    const execute = hold(executeKeyOf(PROPOSAL_A_ID));
    await act(async () => {
      executeButtons()[0].click();
    });
    await waitFor(() => closeButton().disabled);
    await closeChatWindow();
    const loadsBefore = requestCount(messagesKey(SESSION_ID));
    const sessionsBefore = requestCount(SESSIONS_KEY);

    await pressFab();
    await waitFor(() => requestCount(SESSIONS_KEY) === sessionsBefore + 1);
    await settle();
    expect(requestCount(messagesKey(SESSION_ID))).toBe(loadsBefore);

    await act(async () => {
      execute.resolve(json(200, EXECUTED_RESPONSE));
    });
    await waitFor(() => text().includes(EXECUTED_TEXT));
  });

  it('(c) 開き直しの一覧を待つ間に作成を始めて終えても、一覧のあとに会話を読み直さず作成中・完了の一文が残る', async () => {
    await openChat();
    await closeChatWindow();
    const sessionsLoad = hold(SESSIONS_KEY);
    await pressFab();
    await waitFor(() => requestCount(SESSIONS_KEY) === 2);
    const loadsBefore = requestCount(messagesKey(SESSION_ID));

    await startDayMenu();
    await act(async () => {
      v4.options?.onGenerationComplete?.();
    });
    await waitFor(() => text().includes(DAY_MENU_DONE_TEXT));

    await act(async () => {
      sessionsLoad.resolve(
        json(200, { sessions: [{ id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2 }] }),
      );
    });
    await settle();
    expect(requestCount(messagesKey(SESSION_ID))).toBe(loadsBefore);
    expect(text()).toContain(DAY_MENU_STARTED_TEXT);
    expect(text()).toContain(DAY_MENU_DONE_TEXT);
  });

  it('(c) 開き直しの一覧を待つ間に実行して結果が返っても、一覧のあとに会話を読み直さず結果の一文が残る', async () => {
    withOneProposal();
    await openChat();
    await closeChatWindow();
    const sessionsLoad = hold(SESSIONS_KEY);
    await pressFab();
    await waitFor(() => requestCount(SESSIONS_KEY) === 2);
    const loadsBefore = requestCount(messagesKey(SESSION_ID));

    handlers[executeKeyOf(PROPOSAL_A_ID)] = async () => json(200, EXECUTED_RESPONSE);
    await act(async () => {
      executeButtons()[0].click();
    });
    await waitFor(() => text().includes(EXECUTED_TEXT));

    await act(async () => {
      sessionsLoad.resolve(
        json(200, { sessions: [{ id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2 }] }),
      );
    });
    await settle();
    expect(requestCount(messagesKey(SESSION_ID))).toBe(loadsBefore);
    expect(text()).toContain(EXECUTED_TEXT);
  });

  it('(c) 会話の読み込みの最中は『1日献立変更』が止まる (足した作成中の一文が、読み込んだ会話で消える)。読み込みのあとまた押せる', async () => {
    await openChat();
    await openSessionList();
    const otherLoad = hold(messagesKey(OTHER_SESSION_ID));
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => requestCount(messagesKey(OTHER_SESSION_ID)) === 1);
    expect(dayMenuButton().disabled).toBe(true);

    await act(async () => {
      otherLoad.resolve(json(200, { messages: OTHER_MESSAGES }));
    });
    await waitFor(() => text().includes(OTHER_REPLY_TEXT));
    expect(dayMenuButton().disabled).toBe(false);
  });

  it('対照: 作成・実行をしていない間は『新しい相談を始める』・相談の切り替えができ、開き直しで会話を読み直す', async () => {
    await openChat();
    await openSessionList();
    expect(newSessionButton().disabled).toBe(false);
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => text().includes(OTHER_REPLY_TEXT));

    await closeChatWindow();
    const loadsBefore = requestCount(messagesKey(OTHER_SESSION_ID));
    await pressFab();
    await waitFor(() => requestCount(messagesKey(OTHER_SESSION_ID)) === loadsBefore + 1);
  });
});

describe('#2254 M1 Realtime の完了・失敗の通知を取りこぼしても、作成の最中の止めは依頼の状態の読み直しで下りる (ずっと止めない)', () => {
  const DAY_MENU_FAILED_TEXT = '献立の作成に失敗しました';
  const STATUS_KEY = dayMenuStatusKey(DAY_MENU_REQUEST_ID);

  beforeEach(() => {
    v4.generate.mockResolvedValue({ requestId: DAY_MENU_REQUEST_ID });
  });

  function newSessionButton(): HTMLButtonElement {
    const button = buttonWithText('新しい相談を始める');
    expect(button).toBeDefined();
    return button!;
  }

  function countOf(needle: string): number {
    return text().split(needle).length - 1;
  }

  /** 作成を始め (進捗の購読まで)、止めが立つまで待つ。完了・失敗の通知は起こさない (Realtime の通知を取りこぼした形) */
  async function startDayMenuWithoutNotice() {
    await startDayMenu();
    await waitFor(() => v4.subscribeToProgress.mock.calls.length === 1);
    expect(v4.subscribeToProgress.mock.calls[0][0]).toBe(DAY_MENU_REQUEST_ID);
    await waitFor(() => closeButton().disabled);
  }

  /** タブの見え方を変えて visibilitychange を起こす */
  async function fireVisibility(state: DocumentVisibilityState) {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }

  it('通知が届かないまま閉じて開き直すと、依頼の状態 (completed) を読み、止めが下りて完了の一文が出る。相談の操作もまた押せる', async () => {
    await openChat();
    await startDayMenuWithoutNotice();
    // 通知が届かない限り、止めはそのまま (読み直しの前)
    await settle();
    expect(closeButton().disabled).toBe(true);
    expect(requestCount(STATUS_KEY)).toBe(0);

    handlers[STATUS_KEY] = async () => json(200, { status: 'completed', errorMessage: null });
    await closeChatWindow();
    const loadsBefore = requestCount(messagesKey(SESSION_ID));
    await pressFab();
    await waitFor(() => requestCount(STATUS_KEY) === 1);
    await waitFor(() => !closeButton().disabled);
    expect(text()).toContain(DAY_MENU_STARTED_TEXT);
    expect(text()).toContain(DAY_MENU_DONE_TEXT);
    // フックの作成中の印も下ろし (『1日献立変更』もまた押せる)、進捗の購読を外す
    expect(v4.cancelGeneration).toHaveBeenCalledTimes(1);
    expect(v4.unsubscribe).toHaveBeenCalledTimes(1);
    // 終わるのも画面の操作: 開き直しの一覧のあとに会話を読み直して、作成中・完了の一文を消さない
    await settle();
    expect(requestCount(messagesKey(SESSION_ID))).toBe(loadsBefore);
    expect(text()).toContain(DAY_MENU_DONE_TEXT);
    // 新しい相談・相談の切り替えもまた押せる
    await openSessionList();
    expect(newSessionButton().disabled).toBe(false);
    expect(buttonWithText(OTHER_SESSION_TITLE)?.disabled).toBe(false);
    // 閉じられる
    await clickClose();
    await waitFor(() => text().includes(WELCOME_TEXT));
  });

  it('読み直した状態が failed なら、止めが下りて失敗の一文 (行の文) が出る', async () => {
    const STORED_ERROR = '献立の作成に時間がかかりすぎたため中断しました';
    handlers[STATUS_KEY] = async () => json(200, { status: 'failed', errorMessage: STORED_ERROR });
    await openChat();
    await startDayMenuWithoutNotice();

    await closeChatWindow();
    await pressFab();
    await waitFor(() => !closeButton().disabled);
    expect(text()).toContain(`${DAY_MENU_FAILED_TEXT}: ${STORED_ERROR}`);
    expect(text()).not.toContain(DAY_MENU_DONE_TEXT);
    expect(v4.cancelGeneration).toHaveBeenCalledTimes(1);
  });

  it('依頼の行が無い (not_found)・失敗の文が無いときも止めが下り、既定の失敗の文を出す', async () => {
    handlers[STATUS_KEY] = async () => json(200, { status: 'not_found', requestId: DAY_MENU_REQUEST_ID });
    await openChat();
    await startDayMenuWithoutNotice();

    await closeChatWindow();
    await pressFab();
    await waitFor(() => !closeButton().disabled);
    expect(text()).toContain(`${DAY_MENU_FAILED_TEXT}: 生成に失敗しました`);
  });

  it('読み直してもまだ作成中 (processing) なら止めたまま (開き直しの読み直しもしない)', async () => {
    await openChat();
    await startDayMenuWithoutNotice();

    await closeChatWindow();
    const loadsBefore = requestCount(messagesKey(SESSION_ID));
    await pressFab();
    await waitFor(() => requestCount(STATUS_KEY) === 1);
    await settle();
    expect(closeButton().disabled).toBe(true);
    expect(requestCount(messagesKey(SESSION_ID))).toBe(loadsBefore);
    expect(text()).toContain(DAY_MENU_STARTED_TEXT);
    expect(v4.cancelGeneration).not.toHaveBeenCalled();
  });

  it('状態を読めなかった (500) ときは止めたまま (次の読み直しに任せる。本文に状態らしい値があっても読まない)', async () => {
    handlers[STATUS_KEY] = async () => json(500, { error: 'internal', status: 'failed' });
    await openChat();
    await startDayMenuWithoutNotice();

    await closeChatWindow();
    await pressFab();
    await waitFor(() => requestCount(STATUS_KEY) === 1);
    await settle();
    expect(closeButton().disabled).toBe(true);
    expect(v4.cancelGeneration).not.toHaveBeenCalled();
  });

  it('タブが前に戻ったとき (visibilitychange で visible) にも読み直し、終わっていれば止めが下りる。裏に回ったときは読まない', async () => {
    handlers[STATUS_KEY] = async () => json(200, { status: 'completed', errorMessage: null });
    await openChat();
    await startDayMenuWithoutNotice();

    await fireVisibility('hidden');
    await settle();
    expect(requestCount(STATUS_KEY)).toBe(0);
    expect(closeButton().disabled).toBe(true);

    await fireVisibility('visible');
    await waitFor(() => requestCount(STATUS_KEY) === 1);
    await waitFor(() => !closeButton().disabled);
    expect(text()).toContain(DAY_MENU_DONE_TEXT);
  });

  it('作成の最中は DAY_MENU_STATUS_RECHECK_INTERVAL_MS ごとに読み直し、終わっていれば止めが下りる (終わったあとは読まない)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await openChat();
    await startDayMenuWithoutNotice();

    // 間隔の手前では読まない
    await act(async () => {
      vi.advanceTimersByTime(DAY_MENU_STATUS_RECHECK_INTERVAL_MS - 1);
    });
    await settle();
    expect(requestCount(STATUS_KEY)).toBe(0);
    // 1 回目 (まだ作成中): 止めたまま
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await waitFor(() => requestCount(STATUS_KEY) === 1);
    await settle();
    expect(closeButton().disabled).toBe(true);
    // 2 回目 (終わっていた): 止めが下りる
    handlers[STATUS_KEY] = async () => json(200, { status: 'completed', errorMessage: null });
    await act(async () => {
      vi.advanceTimersByTime(DAY_MENU_STATUS_RECHECK_INTERVAL_MS);
    });
    await waitFor(() => requestCount(STATUS_KEY) === 2);
    await waitFor(() => !closeButton().disabled);
    expect(text()).toContain(DAY_MENU_DONE_TEXT);
    // 終わったあとは予約を取り消す (読み直さない)
    await act(async () => {
      vi.advanceTimersByTime(DAY_MENU_STATUS_RECHECK_INTERVAL_MS);
    });
    await settle();
    expect(requestCount(STATUS_KEY)).toBe(2);
  });

  it('読み直しで終わりを見つけたあとに遅れた通知が届いても、完了の一文を 2 度足さない', async () => {
    handlers[STATUS_KEY] = async () => json(200, { status: 'completed', errorMessage: null });
    await openChat();
    await startDayMenuWithoutNotice();
    await closeChatWindow();
    await pressFab();
    await waitFor(() => text().includes(DAY_MENU_DONE_TEXT));

    await act(async () => {
      v4.options?.onGenerationComplete?.();
      v4.options?.onError?.('生成に失敗しました');
    });
    await settle();
    expect(countOf(DAY_MENU_DONE_TEXT)).toBe(1);
    expect(text()).not.toContain(DAY_MENU_FAILED_TEXT);
  });

  it('通知が先に届いたら、読み直しの応答が遅れて返っても一文を 2 度足さない', async () => {
    await openChat();
    await startDayMenuWithoutNotice();
    const status = hold(STATUS_KEY);
    await closeChatWindow();
    await pressFab();
    await waitFor(() => requestCount(STATUS_KEY) === 1);

    await act(async () => {
      v4.options?.onGenerationComplete?.();
    });
    await waitFor(() => !closeButton().disabled);
    await act(async () => {
      status.resolve(json(200, { status: 'completed', errorMessage: null }));
    });
    await settle();
    expect(countOf(DAY_MENU_DONE_TEXT)).toBe(1);
    // 通知の経路で終わったので、フックの印はフックが自分で下ろす (部品は下ろし直さない)
    expect(v4.cancelGeneration).not.toHaveBeenCalled();
  });
});

describe('#2254 M1 同じ型: 作成・実行が開き直しの一覧を待つ間に終わっても、一覧のあとに会話を読み直さない (終わるのも画面の操作)', () => {
  const PROPOSAL_ID = 'proposal-end';
  const executeKey = `POST /api/ai/consultation/actions/${PROPOSAL_ID}/execute`;
  const EXECUTED_RESPONSE = { success: true, actionType: 'add_pantry_item', result: {} };
  const EXECUTED_TEXT = '実行しました';

  beforeEach(() => {
    v4.generate.mockResolvedValue({ requestId: DAY_MENU_REQUEST_ID });
  });

  it('作成の最中に開き直し、一覧を待つ間に完了の通知が届いても、一覧のあとに会話を読み直さず作成中・完了の一文が残る', async () => {
    await openChat();
    await startDayMenu();
    await waitFor(() => closeButton().disabled);
    await closeChatWindow();
    const sessionsLoad = hold(SESSIONS_KEY);
    const sessionsBefore = requestCount(SESSIONS_KEY);
    await pressFab();
    await waitFor(() => requestCount(SESSIONS_KEY) === sessionsBefore + 1);
    const loadsBefore = requestCount(messagesKey(SESSION_ID));

    await act(async () => {
      v4.options?.onGenerationComplete?.();
    });
    await waitFor(() => text().includes(DAY_MENU_DONE_TEXT));
    await act(async () => {
      sessionsLoad.resolve(
        json(200, { sessions: [{ id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2 }] }),
      );
    });
    await settle();
    expect(requestCount(messagesKey(SESSION_ID))).toBe(loadsBefore);
    expect(text()).toContain(DAY_MENU_STARTED_TEXT);
    expect(text()).toContain(DAY_MENU_DONE_TEXT);
  });

  it('実行の応答待ちの最中に開き直し、一覧を待つ間に結果が返っても、一覧のあとに会話を読み直さず結果の一文が残る', async () => {
    handlers[messagesKey(SESSION_ID)] = async () =>
      json(200, {
        messages: [
          {
            id: PROPOSAL_ID,
            role: 'assistant',
            content: MAIN_REPLY_TEXT,
            proposedActions: { type: 'add_pantry_item', params: { name: '卵' } },
            createdAt: '2026-11-01T00:00:00.000Z',
          },
        ],
      });
    await openChat();
    const execute = hold(executeKey);
    await act(async () => {
      buttonWithText('実行する')!.click();
    });
    await waitFor(() => closeButton().disabled);
    await closeChatWindow();
    const sessionsLoad = hold(SESSIONS_KEY);
    const sessionsBefore = requestCount(SESSIONS_KEY);
    await pressFab();
    await waitFor(() => requestCount(SESSIONS_KEY) === sessionsBefore + 1);
    const loadsBefore = requestCount(messagesKey(SESSION_ID));

    await act(async () => {
      execute.resolve(json(200, EXECUTED_RESPONSE));
    });
    await waitFor(() => text().includes(EXECUTED_TEXT));
    await act(async () => {
      sessionsLoad.resolve(
        json(200, { sessions: [{ id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2 }] }),
      );
    });
    await settle();
    expect(requestCount(messagesKey(SESSION_ID))).toBe(loadsBefore);
    expect(text()).toContain(EXECUTED_TEXT);
  });
});

describe('#2254 M1 同じ型: 送信も画面の操作。会話の読み込みの最中は送らず、遅れて返った読み込みで送った文と返答を消さない', () => {
  const SENT_TEXT = '鶏むね肉で何か作れますか';
  const SENT_REPLY_TEXT = '照り焼きはいかがでしょう';
  const sendKeyOf = (sessionId: string) => `POST /api/ai/consultation/sessions/${sessionId}/messages?stream=true`;

  function sse(payload: unknown): string {
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  /**
   * 送った文への返答を流し、最後のデータ (finalData) まで返す応答。actionResult を渡すと、返答の提案をサーバーが自動で実行した結果も
   * 返す (部品は AUTO_ACTION_OUTCOME_MESSAGE_DELAY_MS 待ってから結果の一文を足す)
   */
  function replyResponse(actionResult: { success: boolean; actionType: string; result: unknown } | null = null): Response {
    const body =
      sse({ choices: [{ delta: { content: SENT_REPLY_TEXT } }] }) +
      sse({
        userMessage: { id: 'sent-user', content: SENT_TEXT, isImportant: false, createdAt: '2026-11-05T00:00:00.000Z' },
        aiMessage: { id: 'sent-ai', content: SENT_REPLY_TEXT, proposedActions: null, createdAt: '2026-11-05T00:00:01.000Z' },
        actionExecuted: actionResult !== null,
        actionResult,
      }) +
      'data: [DONE]\n\n';
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  function inputElement(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>('input[type="text"]');
    expect(input).not.toBeNull();
    return input!;
  }

  function sendButton(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="メッセージを送信"]');
    expect(button).not.toBeNull();
    return button!;
  }

  /** 送信欄に文を入れる (止まっていない間に入れる) */
  async function typeMessage() {
    const input = inputElement();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(input, SENT_TEXT);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(inputElement().value).toBe(SENT_TEXT);
  }

  async function pressSend() {
    await act(async () => {
      sendButton().click();
    });
  }

  /** 送信欄で Enter を押す (送信欄が止まっていても keydown は届く。入口の側の止めを確かめる) */
  async function pressEnter() {
    await act(async () => {
      inputElement().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
  }

  /** どの相談へも送っていない */
  function sentNothing(): boolean {
    return !requests.some((r) => r.endsWith('/messages?stream=true'));
  }

  it('開き直しの一覧を待つ間に送ったら、一覧のあとに会話を読み直さず、送った文と返答が残る', async () => {
    await openChat();
    await closeChatWindow();
    const sessionsLoad = hold(SESSIONS_KEY);
    await pressFab();
    await waitFor(() => requestCount(SESSIONS_KEY) === 2);
    const loadsBefore = requestCount(messagesKey(SESSION_ID));

    // 送信の応答を待つ間に一覧が返る
    const send = hold(sendKeyOf(SESSION_ID));
    await typeMessage();
    await pressSend();
    await waitFor(() => requestCount(sendKeyOf(SESSION_ID)) === 1);
    await act(async () => {
      sessionsLoad.resolve(
        json(200, { sessions: [{ id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2 }] }),
      );
    });
    await settle();
    expect(requestCount(messagesKey(SESSION_ID))).toBe(loadsBefore);
    expect(text()).toContain(SENT_TEXT);

    // 返答は送った文の下に出る (仮のメッセージが残っているので、流れてきた返答と最後の置き換えが当たる)
    await act(async () => {
      send.resolve(replyResponse());
    });
    await waitFor(() => text().includes(SENT_REPLY_TEXT));
    expect(text()).toContain(SENT_TEXT);
    expect(text()).toContain(MAIN_REPLY_TEXT);
    expect(requestCount(messagesKey(SESSION_ID))).toBe(loadsBefore);
  });

  interface HeldLoad {
    /** 読み込みのあとに出る相談 (送り先) */
    sessionId: string;
    /** 読み込みのあとに出る文 */
    shownText: string;
    release: () => void;
  }

  const LOAD_ROUTES: Array<{ route: string; start: () => Promise<HeldLoad> }> = [
    {
      route: '相談の切り替えの会話の読み込み',
      start: async () => {
        await openChat();
        await typeMessage();
        await openSessionList();
        const load = hold(messagesKey(OTHER_SESSION_ID));
        await pressSessionRow(OTHER_SESSION_TITLE);
        await waitFor(() => requestCount(messagesKey(OTHER_SESSION_ID)) === 1);
        return {
          sessionId: OTHER_SESSION_ID,
          shownText: OTHER_REPLY_TEXT,
          release: () => load.resolve(json(200, { messages: OTHER_MESSAGES })),
        };
      },
    },
    {
      route: 'チャットを開き直したときの会話の読み込み',
      start: async () => {
        await openChat();
        await typeMessage();
        await closeChatWindow();
        const loadsBefore = requestCount(messagesKey(SESSION_ID));
        const load = hold(messagesKey(SESSION_ID));
        await pressFab();
        await waitFor(() => requestCount(messagesKey(SESSION_ID)) === loadsBefore + 1);
        return {
          sessionId: SESSION_ID,
          shownText: MAIN_REPLY_TEXT,
          release: () => load.resolve(json(200, { messages: MAIN_MESSAGES })),
        };
      },
    },
    {
      route: '新しい相談の作成',
      start: async () => {
        await openChat();
        await typeMessage();
        await openSessionList();
        const create = hold(CREATE_SESSION_KEY);
        await act(async () => {
          buttonWithText('新しい相談を始める')!.click();
        });
        await waitFor(() => requestCount(CREATE_SESSION_KEY) === 1);
        return {
          sessionId: NEW_SESSION_ID,
          shownText: WELCOME_TEXT,
          release: () => create.resolve(json(200, { session: { id: NEW_SESSION_ID } })),
        };
      },
    },
  ];

  it.each(LOAD_ROUTES)(
    '$route の最中は送信欄・送信ボタンが止まり、押しても Enter でも送らない。読み込みのあとに送ると、送った文と返答が残る',
    async ({ start }) => {
      const load = await start();
      expect(loadingSpinnerShown()).toBe(true);
      expect(sendButton().disabled).toBe(true);
      expect(inputElement().disabled).toBe(true);

      await pressSend();
      await pressEnter();
      await settle();
      expect(sentNothing()).toBe(true);
      // 送らなかったので、入れた文は送信欄に残る
      expect(inputElement().value).toBe(SENT_TEXT);

      await act(async () => {
        load.release();
      });
      await waitFor(() => text().includes(load.shownText) && !loadingSpinnerShown());
      expect(sendButton().disabled).toBe(false);
      const readsBefore = requestCount(messagesKey(load.sessionId));

      handlers[sendKeyOf(load.sessionId)] = async () => replyResponse();
      await pressSend();
      await waitFor(() => text().includes(SENT_REPLY_TEXT));
      await settle();
      expect(requestCount(sendKeyOf(load.sessionId))).toBe(1);
      expect(text()).toContain(SENT_TEXT);
      expect(text()).toContain(load.shownText);
      expect(requestCount(messagesKey(load.sessionId))).toBe(readsBefore);
    },
  );

  it('入口の側: 相談の行を押したのと同じ描画のうちに (止める描画の前に) 送っても送らない (前の相談へも送らない)', async () => {
    await openChat();
    await typeMessage();
    await openSessionList();
    const load = hold(messagesKey(OTHER_SESSION_ID));
    await act(async () => {
      buttonWithText(OTHER_SESSION_TITLE)!.click();
      // まだ止める描画の前 (送信ボタンは押せる) に押す
      expect(sendButton().disabled).toBe(false);
      sendButton().click();
    });
    await settle();
    expect(sentNothing()).toBe(true);
    expect(inputElement().value).toBe(SENT_TEXT);

    await act(async () => {
      load.resolve(json(200, { messages: OTHER_MESSAGES }));
    });
    await waitFor(() => text().includes(OTHER_REPLY_TEXT) && !loadingSpinnerShown());
    expect(text()).not.toContain(MAIN_REPLY_TEXT);
    expect(inputElement().value).toBe(SENT_TEXT);
  });

  it('同じ相談の会話の読み込みが重なり、あとの読み込みのあとに送っても、遅れて返った前の読み込みで送った文と返答を消さない', async () => {
    await openChat();
    await closeChatWindow();
    const loadsBefore = requestCount(messagesKey(SESSION_ID));
    const firstLoad = hold(messagesKey(SESSION_ID));
    await pressFab();
    await waitFor(() => requestCount(messagesKey(SESSION_ID)) === loadsBefore + 1);

    // 開き直しの読み込みを待つ間に同じ相談を選び直す (あとの読み込みはすぐ返る)
    handlers[messagesKey(SESSION_ID)] = async () => json(200, { messages: MAIN_MESSAGES });
    await openSessionList();
    await pressSessionRow(MAIN_SESSION_TITLE);
    await waitFor(() => requestCount(messagesKey(SESSION_ID)) === loadsBefore + 2);
    await waitFor(() => text().includes(MAIN_REPLY_TEXT) && !loadingSpinnerShown());

    handlers[sendKeyOf(SESSION_ID)] = async () => replyResponse();
    await typeMessage();
    await pressSend();
    await waitFor(() => text().includes(SENT_REPLY_TEXT));

    // 前の読み込み (送る前の写し) が遅れて返る
    await act(async () => {
      firstLoad.resolve(json(200, { messages: MAIN_MESSAGES }));
    });
    await settle();
    expect(text()).toContain(SENT_TEXT);
    expect(text()).toContain(SENT_REPLY_TEXT);
    expect(text()).toContain(MAIN_REPLY_TEXT);
  });

  it('対照: 読み込みの最中でなければ送れ、返答が出る (開き直しの一覧のあとに会話を読む)', async () => {
    await openChat();
    await closeChatWindow();
    const loadsBefore = requestCount(messagesKey(SESSION_ID));
    await pressFab();
    await waitFor(() => requestCount(messagesKey(SESSION_ID)) === loadsBefore + 1);
    await waitFor(() => !loadingSpinnerShown());

    handlers[sendKeyOf(SESSION_ID)] = async () => replyResponse();
    await typeMessage();
    await pressSend();
    await waitFor(() => text().includes(SENT_REPLY_TEXT));
    expect(text()).toContain(SENT_TEXT);
  });

  /** 送って、送信の応答を待たせる (応答を返す関数を返す) */
  async function sendWithHeldReply(): Promise<Deferred<Response>> {
    const send = hold(sendKeyOf(SESSION_ID));
    await typeMessage();
    await pressSend();
    await waitFor(() => requestCount(sendKeyOf(SESSION_ID)) === 1);
    return send;
  }

  // 応答を受け取れずに会話を取り直している最中の開き直しは今までどおり読み直す (#2235 I1。tests/ai-chat-reload-edges-2227.test.tsx の
  // 『チャットを閉じて開き直す: 開き直しの GET を待つ間に取り直しが積んだ送信は…』が確かめる)
  it('送った文への返答を待つ間にチャットを閉じて開き直しても、一覧のあとに会話を読み直さず、送った文と返答が残る', async () => {
    await openChat();
    const send = await sendWithHeldReply();
    await closeChatWindow();
    const loadsBefore = requestCount(messagesKey(SESSION_ID));
    const sessionsBefore = requestCount(SESSIONS_KEY);

    await pressFab();
    await waitFor(() => requestCount(SESSIONS_KEY) === sessionsBefore + 1);
    await settle();
    expect(requestCount(messagesKey(SESSION_ID))).toBe(loadsBefore);
    expect(text()).toContain(SENT_TEXT);

    await act(async () => {
      send.resolve(replyResponse());
    });
    await waitFor(() => text().includes(SENT_REPLY_TEXT));
    expect(text()).toContain(SENT_TEXT);
    expect(requestCount(messagesKey(SESSION_ID))).toBe(loadsBefore);
  });

  it('送信の応答を待つ間に開き直し、一覧を待つ間に送信が失敗しても、一覧のあとに会話を読み直さず、失敗の文が残る (送信の終わり)', async () => {
    await openChat();
    const send = await sendWithHeldReply();
    await closeChatWindow();
    const sessionsLoad = hold(SESSIONS_KEY);
    const sessionsBefore = requestCount(SESSIONS_KEY);
    await pressFab();
    await waitFor(() => requestCount(SESSIONS_KEY) === sessionsBefore + 1);
    const loadsBefore = requestCount(messagesKey(SESSION_ID));

    await act(async () => {
      send.resolve(json(500, { error: 'internal' }));
    });
    // 送信が終わった (送信欄がまた使える) あとに一覧が返る
    await waitFor(() => text().includes(AI_CHAT_REPLY_FAILED_MESSAGE) && !inputElement().disabled);
    await act(async () => {
      sessionsLoad.resolve(
        json(200, { sessions: [{ id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2 }] }),
      );
    });
    await settle();
    expect(requestCount(messagesKey(SESSION_ID))).toBe(loadsBefore);
    expect(text()).toContain(AI_CHAT_REPLY_FAILED_MESSAGE);
    expect(text()).toContain(SENT_TEXT);
  });

  it('返答のあとに遅れて出す自動実行の結果の一文が、開き直しの一覧を待つ間に出ても、一覧のあとに会話を読み直さず一文が残る', async () => {
    const AUTO_ACTION_EXECUTED_TEXT = '実行しました';
    // 結果の一文の予約 (AUTO_ACTION_OUTCOME_MESSAGE_DELAY_MS) を、開き直して一覧を待たせてから進める
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await openChat();
    handlers[sendKeyOf(SESSION_ID)] = async () =>
      replyResponse({ success: true, actionType: 'add_pantry_item', result: {} });
    await typeMessage();
    await pressSend();
    // 送信が終わった (送信欄がまた使える。結果の一文はまだ出ていない)
    await waitFor(() => text().includes(SENT_REPLY_TEXT) && !inputElement().disabled);
    expect(text()).not.toContain(AUTO_ACTION_EXECUTED_TEXT);

    await closeChatWindow();
    const sessionsLoad = hold(SESSIONS_KEY);
    const sessionsBefore = requestCount(SESSIONS_KEY);
    await pressFab();
    await waitFor(() => requestCount(SESSIONS_KEY) === sessionsBefore + 1);
    const loadsBefore = requestCount(messagesKey(SESSION_ID));

    await act(async () => {
      vi.advanceTimersByTime(AUTO_ACTION_OUTCOME_MESSAGE_DELAY_MS);
    });
    await waitFor(() => text().includes(AUTO_ACTION_EXECUTED_TEXT));
    await act(async () => {
      sessionsLoad.resolve(
        json(200, { sessions: [{ id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2 }] }),
      );
    });
    await settle();
    expect(requestCount(messagesKey(SESSION_ID))).toBe(loadsBefore);
    expect(text()).toContain(AUTO_ACTION_EXECUTED_TEXT);
    expect(text()).toContain(SENT_REPLY_TEXT);
  });
});

describe('#2254 M1 同じ型: 会話の読み込みの最中は、1日献立の「作成する」・提案の実行もしない (足した一文が読み込みの置き換えで消える)', () => {
  const PROPOSAL_ID = 'proposal-load';
  const executeKey = `POST /api/ai/consultation/actions/${PROPOSAL_ID}/execute`;
  const PROPOSAL_MESSAGES = [
    {
      id: PROPOSAL_ID,
      role: 'assistant',
      content: MAIN_REPLY_TEXT,
      proposedActions: { type: 'add_pantry_item', params: { name: '卵' } },
      createdAt: '2026-11-01T00:00:00.000Z',
    },
  ];

  beforeEach(() => {
    v4.generate.mockResolvedValue({ requestId: DAY_MENU_REQUEST_ID });
    handlers[executeKey] = async () => json(200, { success: true, actionType: 'add_pantry_item', result: {} });
  });

  /** 相談の一覧を開き、別の相談の会話の読み込みを止めたまま切り替える (読み込みを返す関数を返す) */
  async function switchWithHeldLoad(): Promise<() => Promise<void>> {
    await openSessionList();
    const load = hold(messagesKey(OTHER_SESSION_ID));
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => requestCount(messagesKey(OTHER_SESSION_ID)) === 1);
    return async () => {
      await act(async () => {
        load.resolve(json(200, { messages: OTHER_MESSAGES }));
      });
      await waitFor(() => text().includes(OTHER_REPLY_TEXT) && !loadingSpinnerShown());
    };
  }

  it('1日献立のモーダルを開いたまま相談を切り替えると、読み込みの最中は「作成する」が止まり、押しても作らない。読み込みのあとに作ると作成中の一文が残る', async () => {
    await openChat();
    await act(async () => {
      dayMenuButton().click();
    });
    expect(createDayMenuButton().disabled).toBe(false);
    const release = await switchWithHeldLoad();
    expect(createDayMenuButton().disabled).toBe(true);

    await act(async () => {
      createDayMenuButton().click();
    });
    await settle();
    expect(v4.generate).not.toHaveBeenCalled();

    await release();
    expect(createDayMenuButton().disabled).toBe(false);
    await act(async () => {
      createDayMenuButton().click();
    });
    await waitFor(() => v4.generate.mock.calls.length === 1);
    await settle();
    expect(text()).toContain(DAY_MENU_STARTED_TEXT);
    expect(text()).toContain(OTHER_REPLY_TEXT);
  });

  it('入口の側: 相談の行を押したのと同じ描画のうちに (止める描画の前に) モーダルの「作成する」を押しても作らない', async () => {
    await openChat();
    await act(async () => {
      dayMenuButton().click();
    });
    await openSessionList();
    const load = hold(messagesKey(OTHER_SESSION_ID));
    await act(async () => {
      buttonWithText(OTHER_SESSION_TITLE)!.click();
      // まだ止める描画の前 (「作成する」は押せる) に押す
      expect(createDayMenuButton().disabled).toBe(false);
      createDayMenuButton().click();
    });
    await settle();
    expect(v4.generate).not.toHaveBeenCalled();

    await act(async () => {
      load.resolve(json(200, { messages: OTHER_MESSAGES }));
    });
    await waitFor(() => text().includes(OTHER_REPLY_TEXT) && !loadingSpinnerShown());
    expect(v4.generate).not.toHaveBeenCalled();
    expect(text()).not.toContain(DAY_MENU_STARTED_TEXT);
  });

  it('入口の側: 「作成する」の同意の確認を待つ間に相談を切り替え、読み込みの最中なら、確認のあとも作らない', async () => {
    await openChat();
    await act(async () => {
      dayMenuButton().click();
    });
    const consentAnswer = deferred<void>();
    consent.gate = consentAnswer.promise;
    await act(async () => {
      createDayMenuButton().click();
    });
    const release = await switchWithHeldLoad();
    await act(async () => {
      consentAnswer.resolve();
    });
    await settle();
    expect(v4.generate).not.toHaveBeenCalled();

    await release();
    expect(v4.generate).not.toHaveBeenCalled();
    expect(text()).not.toContain(DAY_MENU_STARTED_TEXT);
  });

  it('入口の側: 相談の行を押したのと同じ描画のうちに (止める描画の前に) 提案の「実行する」を押しても実行の API を呼ばない', async () => {
    handlers[messagesKey(SESSION_ID)] = async () => json(200, { messages: PROPOSAL_MESSAGES });
    await openChat();
    await openSessionList();
    const load = hold(messagesKey(OTHER_SESSION_ID));
    await act(async () => {
      buttonWithText(OTHER_SESSION_TITLE)!.click();
      // まだ読み込み中の輪を出す描画の前 (カードが見えている) に押す
      buttonWithText('実行する')!.click();
    });
    await settle();
    expect(requestCount(executeKey)).toBe(0);

    await act(async () => {
      load.resolve(json(200, { messages: OTHER_MESSAGES }));
    });
    await waitFor(() => text().includes(OTHER_REPLY_TEXT) && !loadingSpinnerShown());
    expect(requestCount(executeKey)).toBe(0);
  });

  it('入口の側: 提案の「実行する」の同意の確認を待つ間に相談を切り替え、読み込みの最中なら、確認のあとも実行の API を呼ばない', async () => {
    handlers[messagesKey(SESSION_ID)] = async () => json(200, { messages: PROPOSAL_MESSAGES });
    await openChat();
    const consentAnswer = deferred<void>();
    consent.gate = consentAnswer.promise;
    await act(async () => {
      buttonWithText('実行する')!.click();
    });
    const release = await switchWithHeldLoad();
    await act(async () => {
      consentAnswer.resolve();
    });
    await settle();
    expect(requestCount(executeKey)).toBe(0);

    await release();
    expect(requestCount(executeKey)).toBe(0);
  });

  it('対照: 読み込みの最中でなければ、モーダルの「作成する」で作り、提案の「実行する」で実行の API を呼ぶ', async () => {
    handlers[messagesKey(SESSION_ID)] = async () => json(200, { messages: PROPOSAL_MESSAGES });
    await openChat();
    await act(async () => {
      buttonWithText('実行する')!.click();
    });
    await waitFor(() => requestCount(executeKey) === 1);
    await act(async () => {
      dayMenuButton().click();
    });
    await act(async () => {
      createDayMenuButton().click();
    });
    await waitFor(() => v4.generate.mock.calls.length === 1);
  });
});

describe('#2254 M1 同じ型: 『相談を終了』の失敗の一文も画面の操作。一覧・会話の読み込み・新しい相談の作成を待つ間に閉じるが失敗しても、失敗の一文を消さない', () => {
  /** 閉じるの失敗の応答と、出る文 (400 は一覧を読み直してから出す。#2245 K1) */
  const CLOSE_FAILURES: Array<{ failure: string; respond: FetchHandler; expected: string }> = [
    { failure: '500', respond: async () => json(500, { error: 'internal' }), expected: CONSULTATION_CLOSE_FAILED_MESSAGE },
    {
      failure: '通信の失敗 (fetch が投げる)',
      respond: async () => {
        throw new TypeError('Failed to fetch');
      },
      expected: CONSULTATION_CLOSE_FAILED_MESSAGE,
    },
    {
      failure: '400 すでに終了している',
      respond: async () => json(400, { error: AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE }),
      expected: AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE,
    },
  ];
  const ONE_SESSION_LIST = { sessions: [{ id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2 }] };

  it.each(CLOSE_FAILURES)(
    '開き直しの一覧を待つ間に閉じるが失敗 ($failure) しても、一覧のあとに会話を読み直さず、失敗の文が残る',
    async ({ respond, expected }) => {
      await openChat();
      await closeChatWindow();
      const sessionsLoad = hold(SESSIONS_KEY);
      await pressFab();
      await waitFor(() => requestCount(SESSIONS_KEY) === 2);
      const loadsBefore = requestCount(messagesKey(SESSION_ID));
      // 待たせるのは開き直しの一覧だけ (400 のときの閉じる側の一覧の読み直しはすぐ返す)
      handlers[SESSIONS_KEY] = async () => json(200, ONE_SESSION_LIST);
      handlers[closeKey(SESSION_ID)] = respond;
      await clickClose();
      await waitFor(() => text().includes(expected) && !closeButton().disabled);

      await act(async () => {
        sessionsLoad.resolve(json(200, ONE_SESSION_LIST));
      });
      await settle();
      expect(requestCount(messagesKey(SESSION_ID))).toBe(loadsBefore);
      expect(text()).toContain(expected);
      expect(text()).toContain(MAIN_REPLY_TEXT);
      // 閉じていないので、新しい相談は作らない
      expect(requestCount(CREATE_SESSION_KEY)).toBe(0);
    },
  );

  /** 応答を待たせたまま閉じを押す画面 */
  interface HeldScreen {
    /** 閉じる相談 (押したときに出している相談) */
    closedSessionId: string;
    /** 待たせた応答を返したあとに出る文 */
    shownText: string;
    /** 待たせた応答を返したあとに出ない文 (無ければ null) */
    hiddenText: string | null;
    /** 待たせた応答を返す */
    release: () => void;
  }

  const PENDING_ROUTES: Array<{ route: string; start: () => Promise<HeldScreen> }> = [
    {
      route: '相談の切り替えの会話の読み込み (切り替えの直後に閉じる。#2245 K1)',
      start: async () => {
        await openChat();
        await openSessionList();
        const load = hold(messagesKey(OTHER_SESSION_ID));
        await pressSessionRow(OTHER_SESSION_TITLE);
        await waitFor(() => requestCount(messagesKey(OTHER_SESSION_ID)) === 1);
        return {
          closedSessionId: OTHER_SESSION_ID,
          shownText: OTHER_REPLY_TEXT,
          hiddenText: MAIN_REPLY_TEXT,
          release: () => load.resolve(json(200, { messages: OTHER_MESSAGES })),
        };
      },
    },
    {
      route: 'チャットを開き直したときの会話の読み込み',
      start: async () => {
        await openChat();
        await closeChatWindow();
        const loadsBefore = requestCount(messagesKey(SESSION_ID));
        const load = hold(messagesKey(SESSION_ID));
        await pressFab();
        await waitFor(() => requestCount(messagesKey(SESSION_ID)) === loadsBefore + 1);
        return {
          closedSessionId: SESSION_ID,
          shownText: MAIN_REPLY_TEXT,
          hiddenText: null,
          release: () => load.resolve(json(200, { messages: MAIN_MESSAGES })),
        };
      },
    },
    {
      route: '新しい相談の作成 (閉じるがあとの操作なので、作った相談の画面に変えない)',
      start: async () => {
        await openChat();
        await openSessionList();
        const create = hold(CREATE_SESSION_KEY);
        await act(async () => {
          buttonWithText('新しい相談を始める')!.click();
        });
        await waitFor(() => requestCount(CREATE_SESSION_KEY) === 1);
        return {
          closedSessionId: SESSION_ID,
          shownText: MAIN_REPLY_TEXT,
          hiddenText: WELCOME_TEXT,
          release: () => create.resolve(json(200, { session: { id: NEW_SESSION_ID } })),
        };
      },
    },
  ];

  const PENDING_CASES = PENDING_ROUTES.flatMap((route) => CLOSE_FAILURES.map((failure) => ({ ...route, ...failure })));

  it.each(PENDING_CASES)(
    '$route を待つ間に閉じるが失敗 ($failure) しても、待っていた応答のあとも失敗の文が残る',
    async ({ start, respond, expected }) => {
      const held = await start();
      handlers[closeKey(held.closedSessionId)] = respond;
      await clickClose(held.closedSessionId);
      // 閉じるの応答待ちが終わる (失敗の一文は、読み込み中の輪の下で足される)
      await waitFor(() => !closeButton().disabled);
      expect(loadingSpinnerShown()).toBe(true);

      await act(async () => {
        held.release();
      });
      await waitFor(() => text().includes(held.shownText) && !loadingSpinnerShown());
      expect(text()).toContain(expected);
      if (held.hiddenText !== null) expect(text()).not.toContain(held.hiddenText);
    },
  );

  it('(#2259 P1 4) 前の読み込みの最中に閉じるが失敗し、そのあとに同じ相談を選び直しても、選び直しの読み込みは失敗の一文を残す (一度も出ずに消さない)', async () => {
    await openChat();
    await openSessionList();
    const firstLoad = hold(messagesKey(OTHER_SESSION_ID));
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => requestCount(messagesKey(OTHER_SESSION_ID)) === 1);
    handlers[closeKey(OTHER_SESSION_ID)] = async () => json(500, { error: 'internal' });
    await clickClose(OTHER_SESSION_ID);
    await waitFor(() => !closeButton().disabled);

    // 失敗のあとに同じ相談を選び直す (あとの読み込みはすぐ返る)。前の読み込みはそのあとに遅れて返る
    handlers[messagesKey(OTHER_SESSION_ID)] = async () => json(200, { messages: OTHER_MESSAGES });
    await openSessionList();
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => requestCount(messagesKey(OTHER_SESSION_ID)) === 2);
    await act(async () => {
      firstLoad.resolve(json(200, { messages: OTHER_MESSAGES }));
    });
    await waitFor(() => text().includes(OTHER_REPLY_TEXT) && !loadingSpinnerShown());
    await settle();
    // 直す前 (#2254 M1 の決め): 選び直しの読み込み (失敗より後に始めた読み込み) は失敗の一文を残さず、一文は読み込み中の輪の下で
    // 足されたまま一度も出ずに消えた
    expect(text()).toContain(CONSULTATION_CLOSE_FAILED_MESSAGE);
    expect(text().split(CONSULTATION_CLOSE_FAILED_MESSAGE).length - 1).toBe(1);
  });

  it('対照: 相談の行を押したのと同じ描画のうちに閉じるを押して失敗したら、閉じた相談の失敗の一文を切り替えた先の相談の画面に残さない (#2245 K1。画面と違う相談の一文を出さない)', async () => {
    await openChat();
    await openSessionList();
    const load = hold(messagesKey(OTHER_SESSION_ID));
    handlers[closeKey(SESSION_ID)] = async () => json(500, { error: 'internal' });
    await act(async () => {
      buttonWithText(OTHER_SESSION_TITLE)!.click();
      // まだ切り替えの描画の前 (閉じるの押下は、前の相談を閉じる)
      closeButton().click();
    });
    await waitFor(() => requestCount(closeKey(SESSION_ID)) === 1 && !closeButton().disabled);

    await act(async () => {
      load.resolve(json(200, { messages: OTHER_MESSAGES }));
    });
    await waitFor(() => text().includes(OTHER_REPLY_TEXT) && !loadingSpinnerShown());
    await settle();
    expect(text()).not.toContain(CONSULTATION_CLOSE_FAILED_MESSAGE);
    expect(text()).not.toContain(MAIN_REPLY_TEXT);
  });
});

/** 1日献立の作成の依頼の POST (本物のフック useV4MenuGeneration が出す。#2259 P1) */
const GENERATE_KEY = 'POST /api/ai/menu/v4/generate';
const DAY_MENU_FAILED_PREFIX = '献立の作成に失敗しました';

/** 送信欄 (#2259 P1 の確かめで使う。止めが下りたかを見る) */
function chatInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="text"]');
  expect(input).not.toBeNull();
  return input!;
}

/** 偽の時刻を ms 進め、進めた先で動いた続き (fetch の打ち切りのあとの処理) を流す */
async function advanceFakeTime(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** 「1日献立変更」を開いて「作成する」を押し、本物のフックの依頼の POST が出るまで待つ */
async function startRealDayMenu() {
  const before = requestCount(GENERATE_KEY);
  await act(async () => {
    dayMenuButton().click();
  });
  await act(async () => {
    createDayMenuButton().click();
  });
  await waitFor(() => requestCount(GENERATE_KEY) === before + 1);
}

describe('#2259 P1 1 1日献立の依頼の POST が同意以外で失敗しても、『1日献立変更』と『作成する』がまた押せる (フックの作成中の印を下ろす)', () => {
  beforeEach(() => {
    v4.useRealHook = true;
  });

  const GENERATE_FAILURES: Array<{ failure: string; respond: FetchHandler; reason: string }> = [
    { failure: '500', respond: async () => json(500, { error: 'internal' }), reason: 'internal' },
    {
      failure: '通信の失敗 (fetch が投げる)',
      respond: async () => {
        throw new TypeError('Failed to fetch');
      },
      reason: 'Failed to fetch',
    },
  ];

  it.each(GENERATE_FAILURES)('依頼が失敗 ($failure) したら、失敗の一文のあと読み込み直さずにまた作成できる', async ({ respond, reason }) => {
    handlers[GENERATE_KEY] = respond;
    await openChat();
    await startRealDayMenu();
    await waitFor(() => text().includes(`${DAY_MENU_FAILED_PREFIX}: ${reason}`));

    // 直す前: フックの作成中の印が真のまま残り、ここで『1日献立変更』が止まったままだった
    await waitFor(() => !dayMenuButton().disabled);
    expect(closeButton().disabled).toBe(false);
    await act(async () => {
      dayMenuButton().click();
    });
    expect(createDayMenuButton().disabled).toBe(false);
    handlers[GENERATE_KEY] = async () => json(200, { requestId: DAY_MENU_REQUEST_ID, totalSlots: 3 });
    await act(async () => {
      createDayMenuButton().click();
    });
    await waitFor(() => requestCount(GENERATE_KEY) === 2);
  });

  it('依頼の応答が上限 (AI_CHAT_REQUEST_TIME_LIMIT_MS) までに返らないと、打ち切って止めを下ろし、献立表で確かめる一文を出す (失敗と言い切らない)', async () => {
    let requestSignal: AbortSignal | null = null;
    // ブラウザの fetch と同じく、打ち切られたら AbortError で失敗する
    handlers[GENERATE_KEY] = (_url, init) => {
      requestSignal = init?.signal ?? null;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The user aborted a request.', 'AbortError')));
      });
    };
    await openChat();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await startRealDayMenu();
    await waitFor(() => closeButton().disabled);

    await advanceFakeTime(AI_CHAT_REQUEST_TIME_LIMIT_MS - 1);
    await settle();
    expect(closeButton().disabled).toBe(true);
    expect(text()).not.toContain(DAY_MENU_REQUEST_TIMEOUT_MESSAGE);

    await advanceFakeTime(1);
    await waitFor(() => text().includes(DAY_MENU_REQUEST_TIMEOUT_MESSAGE));
    expect(requestSignal).not.toBeNull();
    expect(requestSignal!.aborted).toBe(true);
    await waitFor(() => !closeButton().disabled && !dayMenuButton().disabled);
    expect(text()).not.toContain(DAY_MENU_FAILED_PREFIX);
  });

  it('依頼の応答に requestId が無い (進捗を追えない) ときも、フックの作成中の印を下ろす', async () => {
    v4.useRealHook = false;
    v4.generate.mockResolvedValue({});
    await openChat();
    await startDayMenu();
    await settle();

    // 直す前: 部品の止めは下ろしたが、フックの印 (Realtime の通知でしか下りない) は残った
    expect(v4.cancelGeneration).toHaveBeenCalledTimes(1);
    expect(closeButton().disabled).toBe(false);
  });
});

describe('#2259 P1 2 止め (『相談を終了』・新しい相談・切り替え・送信) は、応答や状態の確認が返らなくても上限で下りる (逃げ道)', () => {
  const PROPOSAL_MESSAGE_ID = 'proposal-p1';
  const executeKey = `POST /api/ai/consultation/actions/${PROPOSAL_MESSAGE_ID}/execute`;
  const PROPOSAL_MESSAGES = [
    {
      id: PROPOSAL_MESSAGE_ID,
      role: 'assistant',
      content: MAIN_REPLY_TEXT,
      proposedActions: { type: 'add_pantry_item', params: { name: '卵' } },
      createdAt: '2026-11-01T00:00:00.000Z',
    },
  ];
  const STATUS_KEY = dayMenuStatusKey(DAY_MENU_REQUEST_ID);
  /** 作成を始めた時刻 (偽の Date。順番待ち・読めないまま DAY_MENU_REQUEST_GIVE_UP_MS が過ぎたかを見る) */
  const DAY_MENU_STARTED_AT = new Date('2026-11-05T03:00:00.000Z');

  /** 応答を返さない (打ち切りの signal を記録する。ブラウザの fetch と同じく、打ち切られたら AbortError で失敗する) */
  function never(signals: AbortSignal[]): FetchHandler {
    return (_url, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The user aborted a request.', 'AbortError')));
      });
    };
  }

  it('提案の実行の応答が上限までに返らないと、打ち切って止めを下ろし、確かめてもらう一文を出す (カードは「実行する」を出さない)', async () => {
    handlers[messagesKey(SESSION_ID)] = async () => json(200, { messages: PROPOSAL_MESSAGES });
    const signals: AbortSignal[] = [];
    handlers[executeKey] = never(signals);
    await openChat();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => {
      buttonWithText('実行する')!.click();
    });
    await waitFor(() => requestCount(executeKey) === 1 && closeButton().disabled);

    await advanceFakeTime(AI_CHAT_REQUEST_TIME_LIMIT_MS - 1);
    await settle();
    expect(closeButton().disabled).toBe(true);

    await advanceFakeTime(1);
    await waitFor(() => text().includes(ACTION_REQUEST_TIMEOUT_MESSAGE));
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
    await waitFor(() => !closeButton().disabled);
    // 押し直すと二重に実行しうるので、「実行する」は出さない
    expect(buttonWithText('実行する')).toBeUndefined();
    await openSessionList();
    expect(buttonWithText('新しい相談を始める')!.disabled).toBe(false);
  });

  it('『相談を終了』の応答が上限までに返らないと、閉じる応答待ちを終え、一覧で確かめてもらう一文を出す (送信・新しい相談がまた使える)', async () => {
    const signals: AbortSignal[] = [];
    handlers[closeKey(SESSION_ID)] = never(signals);
    await openChat();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await clickClose();
    await waitFor(() => closeButton().disabled && chatInput().disabled);

    await advanceFakeTime(AI_CHAT_REQUEST_TIME_LIMIT_MS);
    await waitFor(() => text().includes(CLOSE_SESSION_TIMEOUT_MESSAGE));
    expect(signals[0].aborted).toBe(true);
    await waitFor(() => !closeButton().disabled && !chatInput().disabled);
    expect(text()).not.toContain(CONSULTATION_CLOSE_FAILED_MESSAGE);
    expect(requestCount(CREATE_SESSION_KEY)).toBe(0);
  });

  it('閉じたあとの一覧の読み直しが返らなくても、上限 (AI_CHAT_LOAD_TIMEOUT_MS) で新しい相談の作成へ進む (閉じる応答待ちのまま止めない)', async () => {
    await openChat();
    const signals: AbortSignal[] = [];
    handlers[SESSIONS_KEY] = never(signals);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await clickClose();
    await waitFor(() => requestCount(SESSIONS_KEY) === 2);
    await settle();
    expect(closeButton().disabled).toBe(true);

    await advanceFakeTime(AI_CHAT_LOAD_TIMEOUT_MS);
    await waitFor(() => requestCount(CREATE_SESSION_KEY) === 1 && text().includes(WELCOME_TEXT));
    expect(signals[0].aborted).toBe(true);
    await waitFor(() => !chatInput().disabled);
  });

  it('相談の切り替えの会話の読み込みが返らなくても、上限 (AI_CHAT_LOAD_TIMEOUT_MS) で読み込み中の印が下り、送信欄がまた使える', async () => {
    await openChat();
    await openSessionList();
    const signals: AbortSignal[] = [];
    handlers[messagesKey(OTHER_SESSION_ID)] = never(signals);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => loadingSpinnerShown() && chatInput().disabled);

    await advanceFakeTime(AI_CHAT_LOAD_TIMEOUT_MS - 1);
    await settle();
    expect(loadingSpinnerShown()).toBe(true);

    await advanceFakeTime(1);
    await waitFor(() => !loadingSpinnerShown() && !chatInput().disabled);
    expect(signals[0].aborted).toBe(true);
  });

  it('新しい相談の作成が返らなくても、上限 (AI_CHAT_LOAD_TIMEOUT_MS) で読み込み中の印が下り、送信欄がまた使える (前の相談の画面のまま)', async () => {
    await openChat();
    await openSessionList();
    const signals: AbortSignal[] = [];
    handlers[CREATE_SESSION_KEY] = never(signals);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => {
      buttonWithText('新しい相談を始める')!.click();
    });
    await waitFor(() => loadingSpinnerShown() && chatInput().disabled);

    await advanceFakeTime(AI_CHAT_LOAD_TIMEOUT_MS);
    await waitFor(() => !loadingSpinnerShown() && !chatInput().disabled);
    expect(signals[0].aborted).toBe(true);
    expect(text()).toContain(MAIN_REPLY_TEXT);
    expect(text()).not.toContain(WELCOME_TEXT);
  });

  describe('1日献立の作成の状態が順番待ち・読めないまま DAY_MENU_REQUEST_GIVE_UP_MS が過ぎたら、終わり扱いにして止めを下ろす', () => {
    beforeEach(() => {
      v4.generate.mockResolvedValue({ requestId: DAY_MENU_REQUEST_ID });
    });

    /** 偽の Date の下で作成を始め (通知は起こさない)、止めが立つまで待つ */
    async function startDayMenuAt(startedAt: Date) {
      vi.useFakeTimers({ toFake: ['Date'], now: startedAt });
      await openChat();
      await startDayMenu();
      await waitFor(() => v4.subscribeToProgress.mock.calls.length === 1 && closeButton().disabled);
    }

    /** チャットを閉じて開き直し (開くと依頼の状態を読み直す)、読み直しが n 回目まで出るのを待つ */
    async function reopenAndRecheck(times: number) {
      await closeChatWindow();
      await pressFab();
      await waitFor(() => requestCount(STATUS_KEY) === times);
      await settle();
    }

    const UNSETTLED_STATUSES: Array<{ state: string; respond: FetchHandler }> = [
      { state: '順番待ち (queued)', respond: async () => json(200, { status: 'queued', errorMessage: null }) },
      { state: '読めない (500)', respond: async () => json(500, { error: 'internal' }) },
      { state: '読めない (401)', respond: async () => json(401, { error: 'unauthorized' }) },
      {
        state: '読めない (通信の失敗)',
        respond: async () => {
          throw new TypeError('Failed to fetch');
        },
      },
      { state: '知らない状態', respond: async () => json(200, { status: 'paused', errorMessage: null }) },
    ];

    it.each(UNSETTLED_STATUSES)('$state: 過ぎる前は止めたまま、過ぎたら止めが下り、献立表で確かめる一文を出す', async ({ respond }) => {
      handlers[STATUS_KEY] = respond;
      await startDayMenuAt(DAY_MENU_STARTED_AT);

      vi.setSystemTime(DAY_MENU_STARTED_AT.getTime() + DAY_MENU_REQUEST_GIVE_UP_MS - 1);
      await reopenAndRecheck(1);
      expect(closeButton().disabled).toBe(true);
      expect(text()).not.toContain(DAY_MENU_REQUEST_UNCONFIRMED_MESSAGE);

      vi.setSystemTime(DAY_MENU_STARTED_AT.getTime() + DAY_MENU_REQUEST_GIVE_UP_MS);
      await reopenAndRecheck(2);
      await waitFor(() => text().includes(DAY_MENU_REQUEST_UNCONFIRMED_MESSAGE) && !closeButton().disabled);
      // フックの作成中の印も下ろし (『1日献立変更』もまた押せる)、進捗の購読を外す
      expect(v4.cancelGeneration).toHaveBeenCalledTimes(1);
      expect(v4.unsubscribe).toHaveBeenCalledTimes(1);
      expect(text()).not.toContain(DAY_MENU_DONE_TEXT);
      expect(text()).not.toContain(DAY_MENU_FAILED_PREFIX);
    });

    it('対照: 作成が続いている (processing) 間は、過ぎても止めたまま (状態の確認が進まなくなった依頼を失敗にする)', async () => {
      await startDayMenuAt(DAY_MENU_STARTED_AT);
      vi.setSystemTime(DAY_MENU_STARTED_AT.getTime() + DAY_MENU_REQUEST_GIVE_UP_MS * 2);
      await reopenAndRecheck(1);
      expect(closeButton().disabled).toBe(true);
      expect(v4.cancelGeneration).not.toHaveBeenCalled();
      expect(text()).not.toContain(DAY_MENU_REQUEST_UNCONFIRMED_MESSAGE);
    });

    it('状態の確認が返らないときは DAY_MENU_STATUS_RECHECK_TIMEOUT_MS で打ち切り、読めなかったとして扱う (過ぎていれば止めが下りる)', async () => {
      const signals: AbortSignal[] = [];
      handlers[STATUS_KEY] = never(signals);
      await startDayMenuAt(DAY_MENU_STARTED_AT);
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: DAY_MENU_STARTED_AT.getTime() + DAY_MENU_REQUEST_GIVE_UP_MS });
      await reopenAndRecheck(1);
      expect(closeButton().disabled).toBe(true);

      await advanceFakeTime(DAY_MENU_STATUS_RECHECK_TIMEOUT_MS);
      await waitFor(() => text().includes(DAY_MENU_REQUEST_UNCONFIRMED_MESSAGE) && !closeButton().disabled);
      expect(signals[0].aborted).toBe(true);
    });
  });
});

describe('#2259 P1 3 相談を出していない画面で 1日献立を始めない・読み込み中の印は結果を置きうる読み込みが残る間は下ろさない', () => {
  it('1日献立のモーダルを開いたまま新しい相談の作成が緊急停止 (503) で相談の無い画面になったら、「作成する」を止める (作らない)', async () => {
    v4.generate.mockResolvedValue({ requestId: DAY_MENU_REQUEST_ID });
    handlers[CREATE_SESSION_KEY] = async () => json(503, { error: AI_CHAT_DISABLED_MESSAGE, code: AI_CHAT_DISABLED_CODE });
    await openChat();
    await act(async () => {
      dayMenuButton().click();
    });
    expect(createDayMenuButton().disabled).toBe(false);
    await openSessionList();
    await act(async () => {
      buttonWithText('新しい相談を始める')!.click();
    });
    await waitFor(() => text().includes(AI_CHAT_DISABLED_MESSAGE) && !loadingSpinnerShown());

    // 直す前: 相談が無いのに「作成する」を押せ、作成の最中は新しい相談も止まって、相談の無い画面のまま送れなかった
    expect(createDayMenuButton().disabled).toBe(true);
    await act(async () => {
      createDayMenuButton().click();
    });
    await settle();
    expect(v4.generate).not.toHaveBeenCalled();
    expect(text()).not.toContain(DAY_MENU_STARTED_TEXT);
  });

  const CREATE_FAILURES: Array<{ failure: string; respond: FetchHandler }> = [
    { failure: '500', respond: async () => json(500, { error: 'internal' }) },
    {
      failure: '通信の失敗 (fetch が投げる)',
      respond: async () => {
        throw new TypeError('Failed to fetch');
      },
    },
  ];

  it.each(CREATE_FAILURES)(
    '相談の行を押して会話の読み込みを待つ間に新しい相談の作成が失敗 ($failure) しても、読み込みが終わるまで印を下ろさない (送れない)',
    async ({ respond }) => {
      await openChat();
      await openSessionList();
      const load = hold(messagesKey(OTHER_SESSION_ID));
      await pressSessionRow(OTHER_SESSION_TITLE);
      await waitFor(() => requestCount(messagesKey(OTHER_SESSION_ID)) === 1);
      handlers[CREATE_SESSION_KEY] = respond;
      await openSessionList();
      await act(async () => {
        buttonWithText('新しい相談を始める')!.click();
      });
      await waitFor(() => requestCount(CREATE_SESSION_KEY) === 1);
      await settle();

      // 直す前: 作成 (最後に始めた読み込み) が終わったところで印が下り、切り替えの読み込みの最中なのに送れた
      expect(loadingSpinnerShown()).toBe(true);
      expect(chatInput().disabled).toBe(true);

      await act(async () => {
        load.resolve(json(200, { messages: OTHER_MESSAGES }));
      });
      await waitFor(() => text().includes(OTHER_REPLY_TEXT) && !loadingSpinnerShown());
      expect(chatInput().disabled).toBe(false);
      expect(text()).not.toContain(MAIN_REPLY_TEXT);
    },
  );
});

describe('#2259 P1 4 低頻度の競合 (以前からある型)', () => {
  const PROPOSAL_MESSAGE_ID = 'proposal-p1-race';
  const executeKey = `POST /api/ai/consultation/actions/${PROPOSAL_MESSAGE_ID}/execute`;
  const PROPOSAL_MESSAGES = [
    {
      id: PROPOSAL_MESSAGE_ID,
      role: 'assistant',
      content: MAIN_REPLY_TEXT,
      proposedActions: { type: 'add_pantry_item', params: { name: '卵' } },
      createdAt: '2026-11-01T00:00:00.000Z',
    },
  ];
  const EXECUTED_RESPONSE = { success: true, actionType: 'add_pantry_item', result: {} };

  it('(1) 同じカードの「実行する」を同じ描画のうちに 2 回押しても、実行は 1 回だけ', async () => {
    handlers[messagesKey(SESSION_ID)] = async () => json(200, { messages: PROPOSAL_MESSAGES });
    const execute = hold(executeKey);
    await openChat();
    await act(async () => {
      const button = buttonWithText('実行する')!;
      button.click();
      button.click();
    });
    await waitFor(() => requestCount(executeKey) >= 1);
    await settle();
    expect(requestCount(executeKey)).toBe(1);

    await act(async () => {
      execute.resolve(json(200, EXECUTED_RESPONSE));
    });
    await waitFor(() => !closeButton().disabled);
    expect(requestCount(executeKey)).toBe(1);
  });

  it('(2) 提案の実行: 同意の確認を待つ間に相談を切り替えたら、実行しない (切り替えた先の相談の画面に結果の一文を出さない)', async () => {
    handlers[messagesKey(SESSION_ID)] = async () => json(200, { messages: PROPOSAL_MESSAGES });
    const gate = deferred<void>();
    consent.gate = gate.promise;
    await openChat();
    await act(async () => {
      buttonWithText('実行する')!.click();
    });
    await openSessionList();
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => text().includes(OTHER_REPLY_TEXT) && !loadingSpinnerShown());

    await act(async () => {
      gate.resolve();
    });
    await settle();
    expect(requestCount(executeKey)).toBe(0);
    expect(closeButton().disabled).toBe(false);
  });

  it('(2) 1日献立: 同意の確認を待つ間に相談を切り替えたら、作らない (切り替えた先の相談の画面に作成中の一文を出さない)', async () => {
    v4.generate.mockResolvedValue({ requestId: DAY_MENU_REQUEST_ID });
    const gate = deferred<void>();
    consent.gate = gate.promise;
    await openChat();
    await act(async () => {
      dayMenuButton().click();
    });
    await act(async () => {
      createDayMenuButton().click();
    });
    await openSessionList();
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => text().includes(OTHER_REPLY_TEXT) && !loadingSpinnerShown());

    await act(async () => {
      gate.resolve();
    });
    await settle();
    expect(v4.generate).not.toHaveBeenCalled();
    expect(text()).not.toContain(DAY_MENU_STARTED_TEXT);
    expect(closeButton().disabled).toBe(false);
  });

  it('(3) 同じ相談の会話の読み込みが 2 つ重なり、あとの読み込みが失敗しても、先の読み込みの会話は置く (前の会話のまま残さない)', async () => {
    await openChat();
    await openSessionList();
    const first = hold(messagesKey(OTHER_SESSION_ID));
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => requestCount(messagesKey(OTHER_SESSION_ID)) === 1);
    handlers[messagesKey(OTHER_SESSION_ID)] = async () => json(500, { error: 'internal' });
    await openSessionList();
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => requestCount(messagesKey(OTHER_SESSION_ID)) === 2);
    await settle();
    // 先の読み込みがまだ会話を置きうるので、印は下ろさない (送れない)
    expect(loadingSpinnerShown()).toBe(true);

    await act(async () => {
      first.resolve(json(200, { messages: OTHER_MESSAGES }));
    });
    await waitFor(() => !loadingSpinnerShown());
    // 直す前: あとの読み込み (最後に始めた読み込み) が失敗すると、先の読み込みの会話も捨て、前の相談の会話のまま出していた
    expect(text()).toContain(OTHER_REPLY_TEXT);
    expect(text()).not.toContain(MAIN_REPLY_TEXT);
  });

  it('(3) 一覧の読み込みが 2 つ重なり、あとの読み込みが失敗しても、先の読み込みの一覧は置く', async () => {
    const ADDED_SESSION_TITLE = 'あとから増えた相談';
    await openChat();
    await closeChatWindow();
    const firstList = hold(SESSIONS_KEY);
    await pressFab();
    await waitFor(() => requestCount(SESSIONS_KEY) === 2);
    await closeChatWindow();
    handlers[SESSIONS_KEY] = async () => json(500, { error: 'internal' });
    await pressFab();
    await waitFor(() => requestCount(SESSIONS_KEY) === 3);
    await settle();

    await act(async () => {
      firstList.resolve(
        json(200, {
          sessions: [
            { id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2 },
            { id: OTHER_SESSION_ID, title: OTHER_SESSION_TITLE, messageCount: 1 },
            { id: 'session-added', title: ADDED_SESSION_TITLE, messageCount: 1 },
          ],
        }),
      );
    });
    await settle();
    await openSessionList();
    // 直す前: あとの読み込み (最後に始めた読み込み) が失敗すると、先の読み込みの一覧も捨てていた
    expect(buttonWithText(ADDED_SESSION_TITLE)).toBeDefined();
  });

  it('(5) 新しい相談の作成を待つ間に『相談を終了』を押したら、作成の結果で画面を置き換えない (閉じるの失敗の一文は閉じた相談の画面に出る)', async () => {
    await openChat();
    await openSessionList();
    const create = hold(CREATE_SESSION_KEY);
    await act(async () => {
      buttonWithText('新しい相談を始める')!.click();
    });
    await waitFor(() => requestCount(CREATE_SESSION_KEY) === 1);
    const close = hold(closeKey(SESSION_ID));
    await clickClose();

    // 作成が閉じるの応答より先に返る
    await act(async () => {
      create.resolve(json(200, { session: { id: NEW_SESSION_ID } }));
    });
    await settle();
    await act(async () => {
      close.resolve(json(500, { error: 'internal' }));
    });
    await waitFor(() => text().includes(CONSULTATION_CLOSE_FAILED_MESSAGE) && !loadingSpinnerShown());
    // 直す前: 閉じるが画面の操作を進めず、作成の結果が新しい相談の画面に置き換え、そこに閉じた相談の失敗の一文が足された
    expect(text()).not.toContain(WELCOME_TEXT);
    expect(text()).toContain(MAIN_REPLY_TEXT);
  });
});

describe('#2265 Q2 (1) 一覧・会話の読み込みと新しい相談の作成が時間切れ・失敗でも、理由と次の手の一文を出し、送信できる画面に戻す', () => {
  /** 応答を返さない (打ち切りの signal を記録する。ブラウザの fetch と同じく、打ち切られたら AbortError で失敗する) */
  function neverResponds(signals: AbortSignal[]): FetchHandler {
    return (_url, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The user aborted a request.', 'AbortError')));
      });
    };
  }

  /** 画面の文に needle が出ている回数 (同じ一文を二重に出していないかを見る) */
  function occurrences(needle: string): number {
    return text().split(needle).length - 1;
  }

  /** 作成の応答が返らなかったあとの一覧の読み直しで見える、サーバーで作れていた相談 (メッセージは無い) */
  const CREATED_ON_SERVER = { id: NEW_SESSION_ID, title: 'AI相談', messageCount: 0, status: 'active' };

  it('初めて開いたときの一覧の読み込みが返らないと、上限で一覧の一文を出す。開き直すと会話が出て送れる (一文は残らない)', async () => {
    const signals: AbortSignal[] = [];
    const listed = handlers[SESSIONS_KEY];
    handlers[SESSIONS_KEY] = neverResponds(signals);
    await render();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await pressFab();
    await waitFor(() => requestCount(SESSIONS_KEY) === 1);

    await advanceFakeTime(AI_CHAT_LOAD_TIMEOUT_MS - 1);
    await settle();
    expect(text()).not.toContain(SESSIONS_LOAD_TIMEOUT_MESSAGE);

    await advanceFakeTime(1);
    // 直す前: console.error だけで何も出ず、相談の無い画面のまま送れなかった
    await waitFor(() => text().includes(SESSIONS_LOAD_TIMEOUT_MESSAGE));
    expect(signals[0].aborted).toBe(true);
    expect(occurrences(SESSIONS_LOAD_TIMEOUT_MESSAGE)).toBe(1);

    handlers[SESSIONS_KEY] = listed;
    await closeChatWindow();
    await pressFab();
    await waitFor(() => text().includes(MAIN_REPLY_TEXT) && !chatInput().disabled);
    expect(text()).not.toContain(SESSIONS_LOAD_TIMEOUT_MESSAGE);
  });

  it('一覧の読み込みが失敗の応答 (500) なら、失敗の一文 (時間切れの一文ではない) を出す', async () => {
    handlers[SESSIONS_KEY] = async () => json(500, { error: 'internal' });
    await render();
    await pressFab();
    await waitFor(() => text().includes(SESSIONS_LOAD_FAILED_MESSAGE));
    expect(text()).not.toContain(SESSIONS_LOAD_TIMEOUT_MESSAGE);
  });

  it('対照: 一覧の読み込みが未認証 (401) なら、一覧の一文を出さない (ログインの案内のまま)', async () => {
    handlers[SESSIONS_KEY] = async () => json(401, { error: 'unauthorized' });
    await render();
    await pressFab();
    await settle();
    expect(requestCount(SESSIONS_KEY)).toBe(1);
    expect(text()).not.toContain(SESSIONS_LOAD_FAILED_MESSAGE);
    expect(text()).not.toContain(SESSIONS_LOAD_TIMEOUT_MESSAGE);
  });

  it('初めて開いたときの会話の読み込みが返らないと、上限で会話の一文を出し、送信欄と『相談を終了』が使える', async () => {
    const signals: AbortSignal[] = [];
    handlers[messagesKey(SESSION_ID)] = neverResponds(signals);
    await render();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await pressFab();
    await waitFor(() => requestCount(messagesKey(SESSION_ID)) === 1 && loadingSpinnerShown());

    await advanceFakeTime(AI_CHAT_LOAD_TIMEOUT_MS);
    // 直す前: 相談は選ばれたまま、何も出ずに履歴の無い画面だった
    await waitFor(() => text().includes(MESSAGES_LOAD_TIMEOUT_MESSAGE) && !loadingSpinnerShown());
    expect(signals[0].aborted).toBe(true);
    expect(chatInput().disabled).toBe(false);
    expect(closeButton().disabled).toBe(false);
    expect(text()).not.toContain(MESSAGES_LOAD_FAILED_MESSAGE);
  });

  it('同じ相談の会話の読み込みが 2 回続けて失敗 (500) しても、会話の一文は 1 つだけ。あとで読めたら一文は消える', async () => {
    await openChat();
    handlers[messagesKey(OTHER_SESSION_ID)] = async () => json(500, { error: 'internal' });
    await openSessionList();
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => text().includes(MESSAGES_LOAD_FAILED_MESSAGE) && !loadingSpinnerShown());
    await openSessionList();
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => requestCount(messagesKey(OTHER_SESSION_ID)) === 2 && !loadingSpinnerShown());
    await settle();
    expect(occurrences(MESSAGES_LOAD_FAILED_MESSAGE)).toBe(1);
    expect(chatInput().disabled).toBe(false);

    handlers[messagesKey(OTHER_SESSION_ID)] = async () => json(200, { messages: OTHER_MESSAGES });
    await openSessionList();
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => text().includes(OTHER_REPLY_TEXT) && !loadingSpinnerShown());
    expect(text()).not.toContain(MESSAGES_LOAD_FAILED_MESSAGE);
  });

  it('切り替える前の相談の会話の読み込みが遅れて時間切れになっても、切り替えた先の相談の画面に一文を出さない', async () => {
    await openChat();
    const signals: AbortSignal[] = [];
    handlers[messagesKey(OTHER_SESSION_ID)] = neverResponds(signals);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await openSessionList();
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => requestCount(messagesKey(OTHER_SESSION_ID)) === 1);
    await openSessionList();
    await pressSessionRow(MAIN_SESSION_TITLE);
    await waitFor(() => requestCount(messagesKey(SESSION_ID)) === 2 && text().includes(MAIN_REPLY_TEXT) && !loadingSpinnerShown());

    await advanceFakeTime(AI_CHAT_LOAD_TIMEOUT_MS);
    await settle();
    expect(signals[0].aborted).toBe(true);
    expect(text()).not.toContain(MESSAGES_LOAD_TIMEOUT_MESSAGE);
    expect(text()).toContain(MAIN_REPLY_TEXT);
  });

  it('初めて開いて相談が無いときの新しい相談の作成が返らなくても、一覧を読み直して作れていた相談を選び、送れる画面にする', async () => {
    const signals: AbortSignal[] = [];
    let sessionsOnServer: unknown[] = [];
    handlers[SESSIONS_KEY] = async () => json(200, { sessions: sessionsOnServer });
    handlers[CREATE_SESSION_KEY] = (url, init) => {
      // 作成はサーバーで済んだが、応答が届かない
      sessionsOnServer = [CREATED_ON_SERVER];
      return neverResponds(signals)(url, init);
    };
    await render();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await pressFab();
    await waitFor(() => requestCount(CREATE_SESSION_KEY) === 1 && loadingSpinnerShown());
    expect(chatInput().disabled).toBe(true);

    await advanceFakeTime(AI_CHAT_LOAD_TIMEOUT_MS);
    // 直す前: 相談の無い画面のまま、送信も『相談を終了』も押せなかった (作れていた相談は次の一覧の読み込みでやっと出た)
    await waitFor(() => text().includes(WELCOME_TEXT) && !loadingSpinnerShown());
    expect(signals[0].aborted).toBe(true);
    expect(requestCount(SESSIONS_KEY)).toBe(2);
    expect(requestCount(CREATE_SESSION_KEY)).toBe(1);
    expect(chatInput().disabled).toBe(false);
    expect(closeButton().disabled).toBe(false);
    expect(text()).not.toContain(SESSION_CREATE_TIMEOUT_MESSAGE);

    // 選んだのは作れていた相談 (『相談を終了』はその相談を閉じる。閉じた先は確かめないので失敗の応答にしておく)
    handlers[closeKey(NEW_SESSION_ID)] = async () => json(500, { error: 'internal' });
    await clickClose(NEW_SESSION_ID);
  });

  it('作成の応答が返らず、読み直した一覧にも作れた相談が無ければ、作成の一文を 1 つだけ出し、前の相談の画面で送れる', async () => {
    await openChat();
    const signals: AbortSignal[] = [];
    handlers[CREATE_SESSION_KEY] = neverResponds(signals);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await openSessionList();
    await act(async () => {
      buttonWithText('新しい相談を始める')!.click();
    });
    await waitFor(() => requestCount(CREATE_SESSION_KEY) === 1 && loadingSpinnerShown());

    await advanceFakeTime(AI_CHAT_LOAD_TIMEOUT_MS);
    await waitFor(() => text().includes(SESSION_CREATE_TIMEOUT_MESSAGE) && !loadingSpinnerShown());
    expect(requestCount(SESSIONS_KEY)).toBe(2);
    expect(occurrences(SESSION_CREATE_TIMEOUT_MESSAGE)).toBe(1);
    expect(text()).toContain(MAIN_REPLY_TEXT);
    expect(text()).not.toContain(WELCOME_TEXT);
    expect(chatInput().disabled).toBe(false);
  });

  it('作成の応答もそのあとの一覧の読み直しも返らないときは、作成の一文だけを出す (一覧の一文と二重に出さない)', async () => {
    await openChat();
    const signals: AbortSignal[] = [];
    handlers[CREATE_SESSION_KEY] = neverResponds(signals);
    handlers[SESSIONS_KEY] = neverResponds(signals);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await openSessionList();
    await act(async () => {
      buttonWithText('新しい相談を始める')!.click();
    });
    await waitFor(() => requestCount(CREATE_SESSION_KEY) === 1);

    await advanceFakeTime(AI_CHAT_LOAD_TIMEOUT_MS);
    await waitFor(() => requestCount(SESSIONS_KEY) === 2);
    await settle();
    // 一覧を読み直している間は、読み込み中の印を立てたまま (送れない)
    expect(loadingSpinnerShown()).toBe(true);
    expect(chatInput().disabled).toBe(true);

    await advanceFakeTime(AI_CHAT_LOAD_TIMEOUT_MS);
    await waitFor(() => text().includes(SESSION_CREATE_TIMEOUT_MESSAGE) && !loadingSpinnerShown());
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(text()).not.toContain(SESSIONS_LOAD_TIMEOUT_MESSAGE);
    expect(chatInput().disabled).toBe(false);
  });

  it('新しい相談の作成が失敗の応答 (500) なら、作成の失敗の一文を出す (一覧は読み直さない)', async () => {
    await openChat();
    handlers[CREATE_SESSION_KEY] = async () => json(500, { error: 'internal' });
    await openSessionList();
    await act(async () => {
      buttonWithText('新しい相談を始める')!.click();
    });
    await waitFor(() => text().includes(SESSION_CREATE_FAILED_MESSAGE) && !loadingSpinnerShown());
    expect(requestCount(SESSIONS_KEY)).toBe(1);
    expect(text()).not.toContain(SESSION_CREATE_TIMEOUT_MESSAGE);
    expect(chatInput().disabled).toBe(false);
  });

  it('対照: 新しい相談の作成が緊急停止 (503) なら、サーバーの文面だけを出す (作成の一文は出さない)', async () => {
    await openChat();
    handlers[CREATE_SESSION_KEY] = async () => json(503, { error: AI_CHAT_DISABLED_MESSAGE, code: AI_CHAT_DISABLED_CODE });
    await openSessionList();
    await act(async () => {
      buttonWithText('新しい相談を始める')!.click();
    });
    await waitFor(() => text().includes(AI_CHAT_DISABLED_MESSAGE) && !loadingSpinnerShown());
    expect(text()).not.toContain(SESSION_CREATE_FAILED_MESSAGE);
  });

  it('閉じたあとの一覧の読み直しが失敗 (500) しても新しい相談は出し、その画面に一覧の一文を 1 つ出す', async () => {
    await openChat();
    handlers[SESSIONS_KEY] = async () => json(500, { error: 'internal' });
    await clickClose();
    await waitFor(() => text().includes(WELCOME_TEXT) && text().includes(SESSIONS_LOAD_FAILED_MESSAGE));
    expect(occurrences(SESSIONS_LOAD_FAILED_MESSAGE)).toBe(1);
    expect(requestCount(CREATE_SESSION_KEY)).toBe(1);
  });

  /** 既定の一覧の 2 つの相談 (beforeEach の SESSIONS_KEY と同じ) */
  const LISTED_SESSIONS = [
    { id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2 },
    { id: OTHER_SESSION_ID, title: OTHER_SESSION_TITLE, messageCount: 1 },
  ];

  /**
   * 作成の時間切れのあとに読み直した一覧にあっても、作れた相談と取り違えない相談 (sessionCreatedSince の 3 つの条件のどれか 1 つだけに
   * 外れる)。listedBefore は作成を始める前の一覧にも出ていたか。読み直しの一覧では先頭に置く (条件を 1 つ外すと先頭のこれが選ばれる)
   */
  const NOT_CREATED_SESSIONS = [
    {
      label: '作成を始める前から一覧に出ていた、メッセージの無い相談',
      listedBefore: true,
      session: { id: 'session-known-empty', title: '前からある空の相談', messageCount: 0, status: 'active' },
    },
    {
      label: '終了した、メッセージの無い相談',
      listedBefore: false,
      session: { id: 'session-closed-empty', title: '終了した空の相談', messageCount: 0, status: 'closed' },
    },
    {
      label: 'メッセージのある相談',
      listedBefore: false,
      session: { id: 'session-unknown-with-messages', title: '前に無かった相談', messageCount: 3, status: 'active' },
    },
  ];

  it.each(NOT_CREATED_SESSIONS)(
    '作成の応答が返らず、読み直した一覧にあるのが $label だけなら、それを選ばずに作成の一文を出す',
    async ({ listedBefore, session }) => {
      if (listedBefore) handlers[SESSIONS_KEY] = async () => json(200, { sessions: [session, ...LISTED_SESSIONS] });
      await openChat();
      handlers[SESSIONS_KEY] = async () => json(200, { sessions: [session, ...LISTED_SESSIONS] });
      const signals: AbortSignal[] = [];
      handlers[CREATE_SESSION_KEY] = neverResponds(signals);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await openSessionList();
      await act(async () => {
        buttonWithText('新しい相談を始める')!.click();
      });
      await waitFor(() => requestCount(CREATE_SESSION_KEY) === 1 && loadingSpinnerShown());

      await advanceFakeTime(AI_CHAT_LOAD_TIMEOUT_MS);
      // 条件を 1 つでも外すと、この相談を作れた相談として選び、ようこその一文の画面にする
      await waitFor(() => text().includes(SESSION_CREATE_TIMEOUT_MESSAGE) && !loadingSpinnerShown());
      expect(requestCount(SESSIONS_KEY)).toBe(2);
      expect(text()).toContain(MAIN_REPLY_TEXT);
      expect(text()).not.toContain(WELCOME_TEXT);
    },
  );

  it('作成の応答が返らず、一覧の読み直しを待つ間に相談を切り替えたら、読み直した一覧に作れた相談があっても選ばない (一文も出さない)', async () => {
    await openChat();
    const listAfterTimeout = deferred<Response>();
    const signals: AbortSignal[] = [];
    handlers[CREATE_SESSION_KEY] = neverResponds(signals);
    handlers[SESSIONS_KEY] = () => listAfterTimeout.promise;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await openSessionList();
    await act(async () => {
      buttonWithText('新しい相談を始める')!.click();
    });
    await waitFor(() => requestCount(CREATE_SESSION_KEY) === 1);
    await advanceFakeTime(AI_CHAT_LOAD_TIMEOUT_MS);
    await waitFor(() => requestCount(SESSIONS_KEY) === 2);

    // 一覧の欄は「新しい相談を始める」を押したときから開いたまま (作成が済んでいないので閉じていない)
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => text().includes(OTHER_REPLY_TEXT));
    await act(async () => {
      listAfterTimeout.resolve(json(200, { sessions: [CREATED_ON_SERVER, ...LISTED_SESSIONS] }));
    });
    await settle();

    expect(text()).toContain(OTHER_REPLY_TEXT);
    expect(text()).not.toContain(WELCOME_TEXT);
    expect(text()).not.toContain(SESSION_CREATE_TIMEOUT_MESSAGE);
  });

  it.each([
    ['失敗の応答 (500)', (create: Deferred<Response>) => create.resolve(json(500, { error: 'internal' }))],
    ['通信の失敗 (fetch が投げる)', (create: Deferred<Response>) => create.reject(new TypeError('Failed to fetch'))],
  ])('作成を待つ間に相談を切り替えたら、作成が %s でも切り替えた先の画面に作成の一文を出さない', async (_label, fail) => {
    await openChat();
    await openSessionList();
    const create = hold(CREATE_SESSION_KEY);
    await act(async () => {
      buttonWithText('新しい相談を始める')!.click();
    });
    await waitFor(() => requestCount(CREATE_SESSION_KEY) === 1);
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => text().includes(OTHER_REPLY_TEXT));

    await act(async () => {
      fail(create);
    });
    await settle();

    expect(text()).toContain(OTHER_REPLY_TEXT);
    expect(text()).not.toContain(SESSION_CREATE_FAILED_MESSAGE);
    expect(text()).not.toContain(SESSION_CREATE_TIMEOUT_MESSAGE);
    expect(requestCount(SESSIONS_KEY)).toBe(1);
  });

  it('『相談を終了』がすでに終了 (400) で、そのあとの一覧の読み直しも失敗 (500) したら、終了の一文と一覧の一文を 1 つずつ出す', async () => {
    await openChat();
    handlers[closeKey(SESSION_ID)] = async () => json(400, { error: AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE });
    handlers[SESSIONS_KEY] = async () => json(500, { error: 'internal' });
    await clickClose();
    await waitFor(() => text().includes(AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE) && !closeButton().disabled);
    await settle();

    // 直す前: 読み直しの失敗は黙り、すでに終了した相談が終了でない古い一覧のまま残った
    expect(occurrences(AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE)).toBe(1);
    expect(occurrences(SESSIONS_LOAD_FAILED_MESSAGE)).toBe(1);
    expect(text()).not.toContain(SESSIONS_LOAD_TIMEOUT_MESSAGE);
    expect(requestCount(SESSIONS_KEY)).toBe(2);
    expect(requestCount(CREATE_SESSION_KEY)).toBe(0);
  });

  it('閉じたあとの一覧の読み直しも新しい相談の作成も失敗 (500) したら、作成の一文だけを出す (一覧の一文と二重に出さない)', async () => {
    await openChat();
    handlers[SESSIONS_KEY] = async () => json(500, { error: 'internal' });
    handlers[CREATE_SESSION_KEY] = async () => json(500, { error: 'internal' });
    await clickClose();
    await waitFor(() => text().includes(SESSION_CREATE_FAILED_MESSAGE) && !closeButton().disabled);
    await settle();

    expect(occurrences(SESSION_CREATE_FAILED_MESSAGE)).toBe(1);
    expect(text()).not.toContain(SESSIONS_LOAD_FAILED_MESSAGE);
    expect(requestCount(SESSIONS_KEY)).toBe(2);
    expect(requestCount(CREATE_SESSION_KEY)).toBe(1);
  });

  it('一覧の読み込みが通信の失敗 (fetch が投げる) なら、失敗の一文 (時間切れの一文ではない) を出す', async () => {
    handlers[SESSIONS_KEY] = async () => {
      throw new TypeError('Failed to fetch');
    };
    await render();
    await pressFab();
    await waitFor(() => text().includes(SESSIONS_LOAD_FAILED_MESSAGE));
    expect(text()).not.toContain(SESSIONS_LOAD_TIMEOUT_MESSAGE);
  });

  it('会話の読み込みが通信の失敗 (fetch が投げる) なら、失敗の一文 (時間切れの一文ではない) を出し、送信欄が使える', async () => {
    handlers[messagesKey(SESSION_ID)] = async () => {
      throw new TypeError('Failed to fetch');
    };
    await render();
    await pressFab();
    await waitFor(() => text().includes(MESSAGES_LOAD_FAILED_MESSAGE) && !loadingSpinnerShown());
    expect(text()).not.toContain(MESSAGES_LOAD_TIMEOUT_MESSAGE);
    expect(chatInput().disabled).toBe(false);
  });

  it('新しい相談の作成が通信の失敗 (fetch が投げる) なら、失敗の一文 (時間切れの一文ではない) を出し、一覧は読み直さない', async () => {
    await openChat();
    handlers[CREATE_SESSION_KEY] = async () => {
      throw new TypeError('Failed to fetch');
    };
    await openSessionList();
    await act(async () => {
      buttonWithText('新しい相談を始める')!.click();
    });
    await waitFor(() => text().includes(SESSION_CREATE_FAILED_MESSAGE) && !loadingSpinnerShown());
    expect(text()).not.toContain(SESSION_CREATE_TIMEOUT_MESSAGE);
    expect(requestCount(SESSIONS_KEY)).toBe(1);
    expect(text()).toContain(MAIN_REPLY_TEXT);
    expect(chatInput().disabled).toBe(false);
  });

  it('切り替える前の相談の会話の読み込みが遅れて失敗の応答 (500) で返っても、切り替えた先の相談の画面に一文を出さない', async () => {
    await openChat();
    const otherLoad = hold(messagesKey(OTHER_SESSION_ID));
    await openSessionList();
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => requestCount(messagesKey(OTHER_SESSION_ID)) === 1);
    await openSessionList();
    await pressSessionRow(MAIN_SESSION_TITLE);
    await waitFor(() => requestCount(messagesKey(SESSION_ID)) === 2 && text().includes(MAIN_REPLY_TEXT) && !loadingSpinnerShown());

    await act(async () => {
      otherLoad.resolve(json(500, { error: 'internal' }));
    });
    await settle();
    expect(text()).not.toContain(MESSAGES_LOAD_FAILED_MESSAGE);
    expect(text()).toContain(MAIN_REPLY_TEXT);
  });

  it('開き直しの一覧を待つ間に相談を切り替えたら、一覧が失敗 (500) で返っても一覧の一文を出さない (切り替えた画面が勝つ)', async () => {
    await openChat();
    await closeChatWindow();
    const reopenSessions = hold(SESSIONS_KEY);
    await pressFab();
    await waitFor(() => requestCount(SESSIONS_KEY) === 2);
    await openSessionList();
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => text().includes(OTHER_REPLY_TEXT) && !loadingSpinnerShown());

    await act(async () => {
      reopenSessions.resolve(json(500, { error: 'internal' }));
    });
    await settle();
    expect(text()).not.toContain(SESSIONS_LOAD_FAILED_MESSAGE);
    expect(text()).toContain(OTHER_REPLY_TEXT);
  });

  it('開き直しの一覧を待つ間に『相談を終了』を押したら、一覧が失敗 (500) で返っても一覧の一文を出さない (閉じる側に任せる)', async () => {
    await openChat();
    await closeChatWindow();
    const reopenSessions = hold(SESSIONS_KEY);
    await pressFab();
    await waitFor(() => requestCount(SESSIONS_KEY) === 2);
    const close = hold(closeKey(SESSION_ID));
    await clickClose();

    await act(async () => {
      reopenSessions.resolve(json(500, { error: 'internal' }));
    });
    await settle();
    expect(text()).not.toContain(SESSIONS_LOAD_FAILED_MESSAGE);

    // 閉じるの失敗の応答を返して終える (失敗の応答では一覧を読み直さない)
    await act(async () => {
      close.resolve(json(500, { error: 'internal' }));
    });
    await waitFor(() => text().includes(CONSULTATION_CLOSE_FAILED_MESSAGE) && !closeButton().disabled);
    expect(text()).not.toContain(SESSIONS_LOAD_FAILED_MESSAGE);
    expect(requestCount(SESSIONS_KEY)).toBe(2);
  });

  it('会話の読み込みの最中に開き直しの一覧が失敗 (500) したら、その会話が読めたあとも一覧の一文を残す', async () => {
    const mainLoad = hold(messagesKey(SESSION_ID));
    await render();
    await pressFab();
    await waitFor(() => requestCount(messagesKey(SESSION_ID)) === 1);
    await closeChatWindow();
    handlers[SESSIONS_KEY] = async () => json(500, { error: 'internal' });
    await pressFab();
    // 一覧の一文は足したが、会話の読み込みの最中は読み込み中の輪が会話を隠す
    await waitFor(() => requestCount(SESSIONS_KEY) === 2);
    await settle();

    await act(async () => {
      mainLoad.resolve(json(200, { messages: MAIN_MESSAGES }));
    });
    // 会話の置き換えで一覧の一文を消すと、古い一覧のままなのに開き直しの案内が見えなくなる
    await waitFor(() => text().includes(MAIN_REPLY_TEXT) && !loadingSpinnerShown());
    expect(occurrences(SESSIONS_LOAD_FAILED_MESSAGE)).toBe(1);
  });

  it('同じ相談の会話の読み込みが 2 つ重なり、先の読み込みが失敗 (500) しても、あとの読み込みが会話を読めたら会話の一文は残さない', async () => {
    await openChat();
    const firstLoad = hold(messagesKey(OTHER_SESSION_ID));
    await openSessionList();
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => requestCount(messagesKey(OTHER_SESSION_ID)) === 1);
    await closeChatWindow();
    const secondLoad = hold(messagesKey(OTHER_SESSION_ID));
    await pressFab();
    await waitFor(() => requestCount(messagesKey(OTHER_SESSION_ID)) === 2);

    // 先の読み込みはまだ画面に置きうる (あとの読み込みが置いていない) ので一文を足す (あとの読み込みの最中は読み込み中の輪が会話を隠す)
    await act(async () => {
      firstLoad.resolve(json(500, { error: 'internal' }));
    });
    await settle();

    await act(async () => {
      secondLoad.resolve(json(200, { messages: OTHER_MESSAGES }));
    });
    await waitFor(() => text().includes(OTHER_REPLY_TEXT) && !loadingSpinnerShown());
    expect(text()).not.toContain(MESSAGES_LOAD_FAILED_MESSAGE);
  });
});

describe('#2265 Q2 (2) 相談を出していない画面の 1日献立のモーダルは、「作成する」を止めたうえで理由の一文を出す', () => {
  function noSessionReason(): string | null {
    return container.querySelector('[data-testid="day-menu-no-session"]')?.textContent ?? null;
  }

  it('モーダルを開いたまま新しい相談の作成が緊急停止 (503) で相談の無い画面になったら、ボタンの近くに理由の一文を出す', async () => {
    handlers[CREATE_SESSION_KEY] = async () => json(503, { error: AI_CHAT_DISABLED_MESSAGE, code: AI_CHAT_DISABLED_CODE });
    await openChat();
    await act(async () => {
      dayMenuButton().click();
    });
    // 対照: 相談を出している間は出さない
    expect(noSessionReason()).toBeNull();
    await openSessionList();
    await act(async () => {
      buttonWithText('新しい相談を始める')!.click();
    });
    await waitFor(() => text().includes(AI_CHAT_DISABLED_MESSAGE) && !loadingSpinnerShown());

    // 直す前: 「作成する」が薄くなるだけで、理由が出なかった (止める条件は #2259 P1 のまま)
    expect(createDayMenuButton().disabled).toBe(true);
    expect(noSessionReason()).toBe(DAY_MENU_NO_SESSION_MESSAGE);
    // 理由の一文はモーダルの中 (「作成する」と同じ箱)
    const reason = container.querySelector('[data-testid="day-menu-no-session"]')!;
    expect(reason.parentElement!.contains(createDayMenuButton())).toBe(true);
  });
});

describe('#2265 Q2 (3) 『相談を終了』を受け付けたあとの例外でも、一覧を読み直して新しい相談を出す (失敗の一文は出さない)', () => {
  /** ok の応答だが、本文の読み取りが返らない */
  function okWithStalledBody(): Response {
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'json', { value: () => new Promise<never>(() => {}) });
    return res;
  }

  it('本文の読み取りが上限 (AI_CHAT_REQUEST_TIME_LIMIT_MS) までに終わらなくても、閉じたあとの新しい相談の画面にする', async () => {
    await openChat();
    handlers[closeKey(SESSION_ID)] = async () => okWithStalledBody();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await clickClose();
    await waitFor(() => closeButton().disabled);

    await advanceFakeTime(AI_CHAT_REQUEST_TIME_LIMIT_MS);
    // 直す前: 失敗の一文も出さず、一覧の読み直しも新しい相談の作成もせず、サーバーで閉じた相談の画面が残った
    await waitFor(() => text().includes(WELCOME_TEXT) && !closeButton().disabled);
    expect(requestCount(SESSIONS_KEY)).toBe(2);
    expect(requestCount(CREATE_SESSION_KEY)).toBe(1);
    expect(text()).not.toContain(MAIN_REPLY_TEXT);
    expect(text()).not.toContain(CLOSE_SESSION_TIMEOUT_MESSAGE);
    expect(text()).not.toContain(CONSULTATION_CLOSE_FAILED_MESSAGE);
  });

  it('本文が JSON でなくても、閉じたあとの新しい相談の画面にする', async () => {
    await openChat();
    handlers[closeKey(SESSION_ID)] = async () => new Response('<html>not json</html>', { status: 200 });
    await clickClose();
    await waitFor(() => text().includes(WELCOME_TEXT) && !closeButton().disabled);
    expect(requestCount(SESSIONS_KEY)).toBe(2);
    expect(requestCount(CREATE_SESSION_KEY)).toBe(1);
    expect(text()).not.toContain(CONSULTATION_CLOSE_FAILED_MESSAGE);
  });

  it('新しい相談を出したあとの例外 (本文が null で要約を読めない) では、新しい相談をもう 1 つ作らない', async () => {
    await openChat();
    handlers[closeKey(SESSION_ID)] = async () => json(200, null);
    await clickClose();
    await waitFor(() => text().includes(WELCOME_TEXT) && !closeButton().disabled);
    await settle();
    expect(requestCount(CREATE_SESSION_KEY)).toBe(1);
    expect(requestCount(SESSIONS_KEY)).toBe(2);
    expect(text()).not.toContain(CONSULTATION_CLOSE_FAILED_MESSAGE);
  });
});

describe('#2272 S2 新しい相談の作成の時間切れからの回復のまれな縁・作成の 401', () => {
  /** 応答を返さない (打ち切られたら AbortError で失敗する。#2265 Q2 の同名の関数と同じ) */
  function neverResponds(): FetchHandler {
    return (_url, init) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The user aborted a request.', 'AbortError')));
      });
  }

  /** 既定の一覧の 2 つの相談 (beforeEach の SESSIONS_KEY と同じ) */
  const LISTED_SESSIONS = [
    { id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2 },
    { id: OTHER_SESSION_ID, title: OTHER_SESSION_TITLE, messageCount: 1 },
  ];
  /** サーバーで作れていた、メッセージの無い相談 (一覧の読み直しで見える) */
  const CREATED_ON_SERVER = { id: NEW_SESSION_ID, title: 'AI相談', messageCount: 0, status: 'active' };

  it('(1) 閉じたあとの一覧の読み直しが失敗し、作成が時間切れでも、作成の中の一覧の読み直しが読めて作れていた相談を出せたら、一覧の一文を足さない', async () => {
    await openChat();
    // 閉じたあとの 1 回目の読み直しは失敗 (500)、作成の時間切れのあとの 2 回目は作れていた相談を含む一覧
    let reloads = 0;
    handlers[SESSIONS_KEY] = async () => {
      reloads += 1;
      return reloads === 1
        ? json(500, { error: 'internal' })
        : json(200, { sessions: [CREATED_ON_SERVER, ...LISTED_SESSIONS] });
    };
    handlers[CREATE_SESSION_KEY] = neverResponds();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await clickClose();
    await waitFor(() => requestCount(CREATE_SESSION_KEY) === 1);

    await advanceFakeTime(AI_CHAT_LOAD_TIMEOUT_MS);
    await waitFor(() => text().includes(WELCOME_TEXT) && !loadingSpinnerShown() && !closeButton().disabled);
    await settle();
    expect(reloads).toBe(2);
    // 直す前: 一覧はもう読み直せているのに『相談の一覧を読み込めませんでした』を足した
    expect(text()).not.toContain(SESSIONS_LOAD_FAILED_MESSAGE);
    expect(text()).not.toContain(SESSIONS_LOAD_TIMEOUT_MESSAGE);
    expect(text()).not.toContain(SESSION_CREATE_TIMEOUT_MESSAGE);
    expect(chatInput().disabled).toBe(false);
  });

  it('(1) 対照: 閉じたあとの一覧の読み直しが失敗し、作成がすぐに作れた (作成の中で一覧を読み直していない) ときは、一覧の一文を足す', async () => {
    await openChat();
    handlers[SESSIONS_KEY] = async () => json(500, { error: 'internal' });
    await clickClose();
    await waitFor(() => text().includes(WELCOME_TEXT) && text().includes(SESSIONS_LOAD_FAILED_MESSAGE));
    expect(requestCount(SESSIONS_KEY)).toBe(2);
  });

  it('(2) この画面で前に作った (一覧ではまだ見ていない) 空の相談を、次の作成の時間切れのあとに『作れていた相談』として選ばない', async () => {
    await openChat();
    // 1 つ目の新しい相談は作れる (一覧は読み直さないので、この相談を一覧ではまだ見ていない)
    await openSessionList();
    await act(async () => {
      buttonWithText('新しい相談を始める')!.click();
    });
    await waitFor(() => text().includes(WELCOME_TEXT) && !loadingSpinnerShown());
    expect(requestCount(SESSIONS_KEY)).toBe(1);
    // 別の相談へ切り替える
    await openSessionList();
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => text().includes(OTHER_REPLY_TEXT) && !loadingSpinnerShown());

    // 2 つ目の作成はサーバーに届かずに時間切れ。読み直した一覧には 1 つ目の空の相談だけが新しく出ている
    handlers[CREATE_SESSION_KEY] = neverResponds();
    handlers[SESSIONS_KEY] = async () => json(200, { sessions: [CREATED_ON_SERVER, ...LISTED_SESSIONS] });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await openSessionList();
    await act(async () => {
      buttonWithText('新しい相談を始める')!.click();
    });
    await waitFor(() => requestCount(CREATE_SESSION_KEY) === 2 && loadingSpinnerShown());

    await advanceFakeTime(AI_CHAT_LOAD_TIMEOUT_MS);
    // 直す前: 1 つ目の空の相談を作れていた相談として選び、ようこその一文の画面にした (作成の一文は出なかった)
    await waitFor(() => text().includes(SESSION_CREATE_TIMEOUT_MESSAGE) && !loadingSpinnerShown());
    expect(requestCount(SESSIONS_KEY)).toBe(2);
    expect(text()).toContain(OTHER_REPLY_TEXT);
    expect(text()).not.toContain(WELCOME_TEXT);
    expect(chatInput().disabled).toBe(false);
  });

  it('(3) 新しい相談の作成が未ログイン (401) なら、開く (openChat) と同じく『ログインが必要です』の画面にし、作成の失敗の一文を出さない', async () => {
    await openChat();
    handlers[CREATE_SESSION_KEY] = async () => json(401, { error: 'unauthorized' });
    await openSessionList();
    await act(async () => {
      buttonWithText('新しい相談を始める')!.click();
    });
    await waitFor(() => requestCount(CREATE_SESSION_KEY) === 1 && !loadingSpinnerShown());
    await settle();
    // 直す前: 『少し待ってから、もう一度』の作成の失敗の一文を出した (ログインしないと作れない)
    expect(text()).toContain('ログインが必要です');
    expect(text()).not.toContain(SESSION_CREATE_FAILED_MESSAGE);
    expect(text()).not.toContain(SESSION_CREATE_TIMEOUT_MESSAGE);
    // 一覧は読み直さない (未ログインと分かった)
    expect(requestCount(SESSIONS_KEY)).toBe(1);
  });

  it('(3) 対照: 新しい相談の作成が 401 以外の失敗の応答 (403) なら、作成の失敗の一文を出す (以前のまま)', async () => {
    await openChat();
    handlers[CREATE_SESSION_KEY] = async () => json(403, { error: 'forbidden' });
    await openSessionList();
    await act(async () => {
      buttonWithText('新しい相談を始める')!.click();
    });
    await waitFor(() => text().includes(SESSION_CREATE_FAILED_MESSAGE) && !loadingSpinnerShown());
    expect(text()).not.toContain('ログインが必要です');
  });
});
