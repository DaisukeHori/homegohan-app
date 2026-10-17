/**
 * legal-consent.test.ts — src/lib/legal-consent.ts (#1442 設計書 cross/13b §6.6.8。T-ML1〜T-ML10)
 *
 * 純粋な関数と定数だけのモジュール。403 LEGAL_CONSENT_REQUIRED の見分け、Provider への知らせ、対象外のパス、
 * 同意の状態の決め方、同意画面の route の扱いと取り除く操作を止めるか (usePreventRemove)、ルートの Stack を同意画面 1 つに畳む
 * 完全な state の RESET の action (T-ML11・T-ML12。実物の expo-router 58 の StackRouter に通す) を確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';

import { StackRouter, isActionHandled } from 'expo-router/build/react-navigation/routers/index';

import { LEGAL_CONSENT_REQUIRED_CODE, LEGAL_CONSENT_REQUIRED_MESSAGE } from '@homegohan/shared';

import {
  ENTRY_SCREEN_PATH,
  LEGAL_CONSENT_ACCEPTED_MESSAGE_TYPE,
  LEGAL_CONSENT_SCREEN_PATH,
  LEGAL_CONSENT_SCREEN_ROUTE_NAME,
  LegalConsentRequiredError,
  MOBILE_LEGAL_CONSENT_EXEMPT_PATHS,
  collapseStackAction,
  collapsedStackState,
  findNavigatorOwningRoute,
  isLegalConsentRequiredError,
  isMobileLegalConsentExemptPath,
  isNavigationHeldForLegalConsent,
  legalConsentEntryAfterEvent,
  legalConsentEntryAfterFailure,
  legalConsentRequiredErrorOf,
  legalConsentScreenModeOf,
  legalConsentScreenPreventsRemoval,
  legalConsentScreenSawRequired,
  legalConsentStateOf,
  notifyLegalConsentAccepted,
  notifyLegalConsentRequired,
  parseLegalConsentMessage,
  resetLegalConsentListenersForTests,
  routeNameOf,
  subscribeLegalConsentEvents,
  type LegalConsentEntry,
  type LegalConsentEvent,
  type NavigatorStateLike,
} from '../../src/lib/legal-consent';

const CONSENT_BODY = JSON.stringify({ error: LEGAL_CONSENT_REQUIRED_MESSAGE, code: LEGAL_CONSENT_REQUIRED_CODE });

function recordEvents(): LegalConsentEvent[] {
  const events: LegalConsentEvent[] = [];
  subscribeLegalConsentEvents((event) => events.push(event));
  return events;
}

afterEach(() => {
  resetLegalConsentListenersForTests();
});

describe('legalConsentRequiredErrorOf (T-ML1 / T-ML2)', () => {
  it.each([
    ['getApi() のエラー (statusText あり)', `HTTP 403 Forbidden: ${CONSENT_BODY}`],
    ['HTTP/2 で statusText が空', `HTTP 403 : ${CONSENT_BODY}`],
    ['生の fetch', `HTTP 403: ${CONSENT_BODY}`],
  ])('%s を見分け、LegalConsentRequiredError (固定の文) を返し、購読者に required を知らせる', (_label, message) => {
    const events = recordEvents();

    const error = legalConsentRequiredErrorOf(new Error(message));

    expect(error).toBeInstanceOf(LegalConsentRequiredError);
    expect(error?.message).toBe(LEGAL_CONSENT_REQUIRED_MESSAGE);
    expect(error?.name).toBe('LegalConsentRequiredError');
    expect(events).toEqual(['required']);
  });

  it('入れ子の本文 { error: { code } } も見分ける', () => {
    const events = recordEvents();
    const nested = JSON.stringify({ error: { code: LEGAL_CONSENT_REQUIRED_CODE } });
    expect(legalConsentRequiredErrorOf(new Error(`HTTP 403: ${nested}`))).toBeInstanceOf(LegalConsentRequiredError);
    expect(events).toEqual(['required']);
  });

  it('すでに LegalConsentRequiredError ならそのまま返し、重ねて知らせない', () => {
    const events = recordEvents();
    const original = new LegalConsentRequiredError();
    expect(legalConsentRequiredErrorOf(original)).toBe(original);
    expect(isLegalConsentRequiredError(original)).toBe(true);
    expect(isLegalConsentRequiredError(new Error('x'))).toBe(false);
    expect(events).toEqual([]);
  });

  it.each([
    ['AI 同意の 403', `HTTP 403 Forbidden: ${JSON.stringify({ error: 'x', code: 'AI_CONSENT_REQUIRED' })}`],
    ['503', `HTTP 503 Service Unavailable: ${CONSENT_BODY}`],
    ['401', `HTTP 401: ${CONSENT_BODY}`],
    ['通信エラー', '通信できません。電波の良い場所でもう一度お試しください。'],
    ['JSON でない本文', 'HTTP 403: forbidden'],
    ['本文が空', 'HTTP 403: '],
  ])('%s は見分けず、知らせない', (_label, message) => {
    const events = recordEvents();
    expect(legalConsentRequiredErrorOf(new Error(message))).toBeNull();
    expect(events).toEqual([]);
  });

  it('文字列でない message・Error でない値・null・undefined は見分けず、例外も投げない', () => {
    const events = recordEvents();
    expect(legalConsentRequiredErrorOf({ message: 403 })).toBeNull();
    expect(legalConsentRequiredErrorOf('HTTP 403: {}')).toBeNull();
    expect(legalConsentRequiredErrorOf(null)).toBeNull();
    expect(legalConsentRequiredErrorOf(undefined)).toBeNull();
    expect(events).toEqual([]);
  });
});

describe('MOBILE_LEGAL_CONSENT_EXEMPT_PATHS (T-ML3)', () => {
  const APP_DIR = path.resolve(__dirname, '../../app');

  /** apps/mobile/app/<group> の画面ファイル (layout を除く) から、画面のパスを作る */
  function screenPathsOf(group: string): string[] {
    const root = path.join(APP_DIR, group);
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.tsx$/.test(entry.name) && entry.name !== '_layout.tsx') {
          const relative = path.relative(root, full).replace(/\.tsx$/, '').split(path.sep).join('/');
          out.push(`/${relative}`);
        }
      }
    };
    walk(root);
    return out.sort();
  }

  it('apps/mobile/app の (auth) と (public) の画面のパスと同意画面 (/legal-consent) に一致する', () => {
    const screens = [...screenPathsOf('(auth)'), ...screenPathsOf('(public)')];
    expect(screens.length).toBeGreaterThan(0);
    // 画面のパスはどれも対象外の一覧のどれかの配下
    for (const screen of screens) {
      expect(isMobileLegalConsentExemptPath(screen)).toBe(true);
    }
    // 一覧の各項目は、画面のパスのどれかの前方 (または同意画面そのもの)
    for (const exempt of MOBILE_LEGAL_CONSENT_EXEMPT_PATHS) {
      if (exempt === LEGAL_CONSENT_SCREEN_PATH) continue;
      expect(screens.some((screen) => screen === exempt || screen.startsWith(`${exempt}/`))).toBe(true);
    }
    expect(MOBILE_LEGAL_CONSENT_EXEMPT_PATHS).toContain(LEGAL_CONSENT_SCREEN_PATH);
    expect(MOBILE_LEGAL_CONSENT_EXEMPT_PATHS).toHaveLength(7);
    // 同意画面の route のファイルが在る
    expect(fs.existsSync(path.join(APP_DIR, `${LEGAL_CONSENT_SCREEN_ROUTE_NAME}.tsx`))).toBe(true);
  });

  it.each(['/login', '/signup', '/auth/reset-password', '/auth/verify', '/about', '/privacy', '/terms', '/legal-consent'])(
    '%s は対象外',
    (pathname) => {
      expect(isMobileLegalConsentExemptPath(pathname)).toBe(true);
    },
  );

  it.each(['/', '/home', '/onboarding/welcome', '/health/blood-tests', '/handson-tour/photo', '/settings', '/loginx', '/authx', '/legal-consentx', '/privacyx'])(
    '似た名前や対象の画面 %s は対象外にしない',
    (pathname) => {
      expect(isMobileLegalConsentExemptPath(pathname)).toBe(false);
    },
  );
});

describe('parseLegalConsentMessage (T-ML4)', () => {
  it("{ type: 'legal-consent-accepted' } だけを受ける", () => {
    expect(parseLegalConsentMessage({ type: 'legal-consent-accepted' })).toEqual({ type: 'legal-consent-accepted' });
    expect(parseLegalConsentMessage({ type: LEGAL_CONSENT_ACCEPTED_MESSAGE_TYPE, extra: 1 })).toEqual({
      type: 'legal-consent-accepted',
    });
  });

  it.each([
    ['ほかの type', { type: 'sign-out' }],
    ['type が無い', {}],
    ['文字列', 'legal-consent-accepted'],
    ['null', null],
    ['undefined', undefined],
    ['数値', 1],
  ])('%s は null', (_label, data) => {
    expect(parseLegalConsentMessage(data)).toBeNull();
  });
});

describe('subscribeLegalConsentEvents (T-ML5)', () => {
  it('required / accepted を購読者に配り、解除した購読者には配らない', () => {
    const first: LegalConsentEvent[] = [];
    const second: LegalConsentEvent[] = [];
    const unsubscribeFirst = subscribeLegalConsentEvents((event) => first.push(event));
    subscribeLegalConsentEvents((event) => second.push(event));

    notifyLegalConsentRequired();
    notifyLegalConsentAccepted();
    expect(first).toEqual(['required', 'accepted']);
    expect(second).toEqual(['required', 'accepted']);

    unsubscribeFirst();
    notifyLegalConsentRequired();
    expect(first).toEqual(['required', 'accepted']);
    expect(second).toEqual(['required', 'accepted', 'required']);
  });

  it('resetLegalConsentListenersForTests で全部外れる。購読者が居なくても例外にしない', () => {
    const events = recordEvents();
    resetLegalConsentListenersForTests();
    expect(() => notifyLegalConsentRequired()).not.toThrow();
    expect(() => notifyLegalConsentAccepted()).not.toThrow();
    expect(events).toEqual([]);
  });
});

describe('legalConsentScreenPreventsRemoval (T-ML6)', () => {
  it('awaiting-consent と signed-out-notice は止める (true)', () => {
    expect(legalConsentScreenPreventsRemoval('awaiting-consent', false, false)).toBe(true);
    expect(legalConsentScreenPreventsRemoval('signed-out-notice', false, false)).toBe(true);
  });

  it('free は止めない', () => {
    expect(legalConsentScreenPreventsRemoval('free', false, false)).toBe(false);
  });

  it('closing なら扱いに関わらず止めない', () => {
    for (const mode of ['awaiting-consent', 'signed-out-notice', 'free'] as const) {
      expect(legalConsentScreenPreventsRemoval(mode, true, false)).toBe(false);
    }
  });

  it('凍結中 (accountFrozen) なら扱いに関わらず止めない (凍結が先。凍結のゲートの RESET は同意画面の route を取り除く。#1861)', () => {
    for (const mode of ['awaiting-consent', 'signed-out-notice', 'free'] as const) {
      expect(legalConsentScreenPreventsRemoval(mode, false, true)).toBe(false);
      expect(legalConsentScreenPreventsRemoval(mode, true, true)).toBe(false);
    }
  });
});

describe('legalConsentStateOf と記録の関数 (T-ML7)', () => {
  const entryOf = (userId: string, state: LegalConsentEntry['state'], status: LegalConsentEntry['status'] = null): LegalConsentEntry => ({
    userId,
    state,
    status,
  });

  it('未ログインは clear、記録が無い・別の利用者の記録なら loading、今の利用者の記録ならその状態', () => {
    expect(legalConsentStateOf(null, null)).toBe('clear');
    expect(legalConsentStateOf(null, entryOf('u1', 'required'))).toBe('clear');
    expect(legalConsentStateOf('u1', null)).toBe('loading');
    expect(legalConsentStateOf('u2', entryOf('u1', 'clear'))).toBe('loading');
    expect(legalConsentStateOf('u1', entryOf('u1', 'required'))).toBe('required');
    expect(legalConsentStateOf('u1', entryOf('u1', 'clear'))).toBe('clear');
    expect(legalConsentStateOf('u1', entryOf('u1', 'unknown'))).toBe('unknown');
  });

  it('legalConsentEntryAfterFailure は今の利用者の記録を保ち、無ければ (別の利用者の記録でも) unknown', () => {
    const required = entryOf('u1', 'required');
    expect(legalConsentEntryAfterFailure(required, 'u1')).toBe(required);
    expect(legalConsentEntryAfterFailure(null, 'u1')).toEqual({ userId: 'u1', state: 'unknown', status: null });
    expect(legalConsentEntryAfterFailure(required, 'u2')).toEqual({ userId: 'u2', state: 'unknown', status: null });
  });

  it('legalConsentEntryAfterEvent は required / clear にし、status は今の利用者のものだけ残す', () => {
    const status = { required: false } as unknown as NonNullable<LegalConsentEntry['status']>;
    const prev = entryOf('u1', 'clear', status);
    expect(legalConsentEntryAfterEvent(prev, 'u1', 'required')).toEqual({ userId: 'u1', state: 'required', status });
    expect(legalConsentEntryAfterEvent(prev, 'u1', 'accepted')).toEqual({ userId: 'u1', state: 'clear', status });
    expect(legalConsentEntryAfterEvent(prev, 'u2', 'required')).toEqual({ userId: 'u2', state: 'required', status: null });
    expect(legalConsentEntryAfterEvent(null, 'u1', 'accepted')).toEqual({ userId: 'u1', state: 'clear', status: null });
  });
});

describe('isNavigationHeldForLegalConsent (T-ML8)', () => {
  it('loading・required、または pathname が /legal-consent なら true。clear・unknown で同意画面以外なら false', () => {
    expect(isNavigationHeldForLegalConsent('loading', '/home')).toBe(true);
    expect(isNavigationHeldForLegalConsent('required', '/home')).toBe(true);
    expect(isNavigationHeldForLegalConsent('clear', '/legal-consent')).toBe(true);
    expect(isNavigationHeldForLegalConsent('unknown', '/legal-consent')).toBe(true);
    expect(isNavigationHeldForLegalConsent('clear', '/home')).toBe(false);
    expect(isNavigationHeldForLegalConsent('unknown', '/health/blood-tests')).toBe(false);
    // 入口は呼び出し側 (NotificationRouter) が別に見る
    expect(isNavigationHeldForLegalConsent('clear', ENTRY_SCREEN_PATH)).toBe(false);
  });
});

describe('legalConsentScreenSawRequired / legalConsentScreenModeOf と定数 (T-ML10)', () => {
  it('サインイン中の required で立ち awaiting-consent、サインイン中の loading・clear・unknown で外れ free', () => {
    expect(legalConsentScreenSawRequired(false, true, 'required')).toBe(true);
    expect(legalConsentScreenModeOf(true, 'required', true)).toBe('awaiting-consent');
    for (const state of ['loading', 'clear', 'unknown'] as const) {
      expect(legalConsentScreenSawRequired(true, true, state)).toBe(false);
      expect(legalConsentScreenModeOf(true, state, false)).toBe('free');
    }
  });

  it('ログアウトの後は前の値を保ち、立っていれば signed-out-notice、立っていなければ free', () => {
    expect(legalConsentScreenSawRequired(true, false, 'clear')).toBe(true);
    expect(legalConsentScreenSawRequired(false, false, 'required')).toBe(false);
    expect(legalConsentScreenModeOf(false, 'clear', true)).toBe('signed-out-notice');
    expect(legalConsentScreenModeOf(false, 'clear', false)).toBe('free');
  });

  it("ENTRY_SCREEN_PATH は '/'、LEGAL_CONSENT_SCREEN_ROUTE_NAME は 'legal-consent'、パスと合図の type の値", () => {
    expect(ENTRY_SCREEN_PATH).toBe('/');
    expect(LEGAL_CONSENT_SCREEN_ROUTE_NAME).toBe('legal-consent');
    expect(LEGAL_CONSENT_SCREEN_PATH).toBe('/legal-consent');
    expect(LEGAL_CONSENT_ACCEPTED_MESSAGE_TYPE).toBe('legal-consent-accepted');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T-ML11: 持ち主の navigator の探し方と、畳んだ完全な state・RESET の action
// ─────────────────────────────────────────────────────────────────────────────

/** ルートの Stack の形の state (実物の expo-router 58 の StackRouter が受け付ける完全な state)。routes は同意画面を含まない */
const ROOT_ROUTE_NAMES = ['index', '(tabs)', 'legal-consent', 'settings/account'] as const;
const ROOT_STACK_KEY = 'navigator:root';
/** routeKeySeq は「次に付ける route の key の連番」。ここでは 3 つの route に 0〜2 を付け済みで、次は 3 */
const ROOT_ROUTE_KEY_SEQ = 3;
const FOCUSED_INDEX_OF_ROOT = 1;
const CONSENT_ROUTE_KEY = 'legal-consent:3';

function rootStackState(overrides: Partial<NavigatorStateLike> = {}): NavigatorStateLike {
  return {
    key: ROOT_STACK_KEY,
    routeKeySeq: ROOT_ROUTE_KEY_SEQ,
    index: FOCUSED_INDEX_OF_ROOT,
    type: 'stack',
    stale: false,
    routeNames: [...ROOT_ROUTE_NAMES],
    routes: [
      { key: 'index:0', name: 'index' },
      { key: '(tabs):1', name: '(tabs)' },
      { key: 'settings/account:2', name: 'settings/account' },
    ],
    ...overrides,
  };
}

describe('findNavigatorOwningRoute / collapsedStackState / collapseStackAction (T-ML11)', () => {
  it('routeNames に legal-consent を持つ navigator を前面の枝で見つける (ルート直下・1 段下)', () => {
    const root = rootStackState();
    expect(findNavigatorOwningRoute(root, LEGAL_CONSENT_SCREEN_ROUTE_NAME)?.key).toBe(ROOT_STACK_KEY);

    // 1 段下: 前面の route の入れ子の navigator が持ち主 (ルートは legal-consent を routeNames に持たない)
    const nested: NavigatorStateLike = {
      key: 'navigator:nested',
      routeKeySeq: 1,
      index: 0,
      type: 'stack',
      stale: false,
      routeNames: ['legal-consent', 'other'],
      routes: [{ key: 'other:0', name: 'other' }],
    };
    const wrapper = rootStackState({
      routeNames: ['index', '(tabs)'],
      routes: [{ key: 'index:0', name: 'index' }, { key: '(tabs):1', name: '(tabs)', state: nested }],
    });
    expect(findNavigatorOwningRoute(wrapper, LEGAL_CONSENT_SCREEN_ROUTE_NAME)?.key).toBe('navigator:nested');
  });

  it('持ち主が無い・stale・key 無し・routeKeySeq 無し・root が undefined なら null', () => {
    expect(findNavigatorOwningRoute(undefined, LEGAL_CONSENT_SCREEN_ROUTE_NAME)).toBeNull();
    expect(findNavigatorOwningRoute(rootStackState({ routeNames: ['index', '(tabs)'] }), LEGAL_CONSENT_SCREEN_ROUTE_NAME)).toBeNull();
    expect(findNavigatorOwningRoute(rootStackState({ stale: true }), LEGAL_CONSENT_SCREEN_ROUTE_NAME)).toBeNull();
    expect(findNavigatorOwningRoute(rootStackState({ key: undefined }), LEGAL_CONSENT_SCREEN_ROUTE_NAME)).toBeNull();
    expect(findNavigatorOwningRoute(rootStackState({ routeKeySeq: undefined }), LEGAL_CONSENT_SCREEN_ROUTE_NAME)).toBeNull();
  });

  it('同意画面の route があれば key ごと再利用し、無ければ名前だけ。key・type・routeNames・routeKeySeq を写し、stale: false を付ける', () => {
    const withoutConsent = findNavigatorOwningRoute(rootStackState(), LEGAL_CONSENT_SCREEN_ROUTE_NAME);
    if (withoutConsent === null) throw new Error('持ち主が見つからない');
    expect(collapsedStackState(withoutConsent, LEGAL_CONSENT_SCREEN_ROUTE_NAME)).toEqual({
      key: ROOT_STACK_KEY,
      index: 0,
      routeKeySeq: ROOT_ROUTE_KEY_SEQ,
      routeNames: [...ROOT_ROUTE_NAMES],
      type: 'stack',
      stale: false,
      routes: [{ name: LEGAL_CONSENT_SCREEN_ROUTE_NAME }],
    });

    const withConsent = findNavigatorOwningRoute(
      rootStackState({ routes: [{ key: 'index:0', name: 'index' }, { key: CONSENT_ROUTE_KEY, name: LEGAL_CONSENT_SCREEN_ROUTE_NAME }] }),
      LEGAL_CONSENT_SCREEN_ROUTE_NAME,
    );
    if (withConsent === null) throw new Error('持ち主が見つからない');
    expect(collapsedStackState(withConsent, LEGAL_CONSENT_SCREEN_ROUTE_NAME).routes).toEqual([
      { name: LEGAL_CONSENT_SCREEN_ROUTE_NAME, key: CONSENT_ROUTE_KEY },
    ]);

    // type が無い持ち主の state は type を写さない (undefined のキーを作らない)
    const typeless = findNavigatorOwningRoute(rootStackState({ type: undefined }), LEGAL_CONSENT_SCREEN_ROUTE_NAME);
    if (typeless === null) throw new Error('持ち主が見つからない');
    expect('type' in collapsedStackState(typeless, LEGAL_CONSENT_SCREEN_ROUTE_NAME)).toBe(false);
  });

  it('action は type RESET・target は持ち主の key・payload は畳んだ state', () => {
    const owner = findNavigatorOwningRoute(rootStackState(), LEGAL_CONSENT_SCREEN_ROUTE_NAME);
    if (owner === null) throw new Error('持ち主が見つからない');
    const action = collapseStackAction(owner, LEGAL_CONSENT_SCREEN_ROUTE_NAME);
    expect(action.type).toBe('RESET');
    expect(action.target).toBe(ROOT_STACK_KEY);
    expect(action.payload).toEqual(collapsedStackState(owner, LEGAL_CONSENT_SCREEN_ROUTE_NAME));
  });

  it('routeNameOf は route の名前を読み、route が無ければ undefined', () => {
    expect(routeNameOf({ name: 'legal-consent' })).toBe('legal-consent');
    expect(routeNameOf(undefined)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T-ML12: 実物の expo-router 58 の StackRouter に通す (mock だけで緑になることを防ぐ)
// ─────────────────────────────────────────────────────────────────────────────

describe('expo-router 58 の StackRouter に通す (T-ML12)', () => {
  // StackRouter の getStateForAction が第 3 引数に受ける設定 (ルートの Stack の route の名前と、id を決める関数の表)
  const routerConfig = { routeNames: [...ROOT_ROUTE_NAMES], routeParamList: {}, routeGetIdList: {} };

  function stateAfterCollapse(root: NavigatorStateLike) {
    const owner = findNavigatorOwningRoute(root, LEGAL_CONSENT_SCREEN_ROUTE_NAME);
    if (owner === null) throw new Error('持ち主が見つからない');
    const router = StackRouter({});
    // StackRouter の state の型は route の key を必須にする。ここで作る state は key をそろえてある
    return router.getStateForAction(root as never, collapseStackAction(owner, LEGAL_CONSENT_SCREEN_ROUTE_NAME), routerConfig);
  }

  it('同意画面の route が無い state に畳む action を通すと、受け付けて routes が [legal-consent] (key は router が付ける) になる', () => {
    const result = stateAfterCollapse(rootStackState());
    if (!isActionHandled(result)) throw new Error('RESET が受け付けられなかった');
    expect(result.state.routes.map((route) => route.name)).toEqual([LEGAL_CONSENT_SCREEN_ROUTE_NAME]);
    expect(result.state.routes[0]?.key).toBe(CONSENT_ROUTE_KEY);
    expect(result.state.index).toBe(0);
    expect(result.state.routeKeySeq).toBe(ROOT_ROUTE_KEY_SEQ + 1);
  });

  it('同意画面の route がある state に畳む action を通すと、その key のまま routes が [legal-consent] になる', () => {
    const root = rootStackState({
      index: 2,
      routes: [
        { key: 'index:0', name: 'index' },
        { key: '(tabs):1', name: '(tabs)' },
        { key: CONSENT_ROUTE_KEY, name: LEGAL_CONSENT_SCREEN_ROUTE_NAME },
      ],
    });
    const result = stateAfterCollapse(root);
    if (!isActionHandled(result)) throw new Error('RESET が受け付けられなかった');
    expect(result.state.routes.map((route) => ({ name: route.name, key: route.key }))).toEqual([
      { name: LEGAL_CONSENT_SCREEN_ROUTE_NAME, key: CONSENT_ROUTE_KEY },
    ]);
    expect(result.state.routeKeySeq).toBe(ROOT_ROUTE_KEY_SEQ);
  });

  it('stale: false を外した payload は受け付けない (Unhandled。この番兵が実物の router の条件を見ていることの確かめ)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const owner = findNavigatorOwningRoute(rootStackState(), LEGAL_CONSENT_SCREEN_ROUTE_NAME);
      if (owner === null) throw new Error('持ち主が見つからない');
      const { stale: _stale, ...partialPayload } = collapsedStackState(owner, LEGAL_CONSENT_SCREEN_ROUTE_NAME);
      const result = StackRouter({}).getStateForAction(
        rootStackState() as never,
        { type: 'RESET', target: owner.key, payload: partialPayload },
        routerConfig,
      );
      expect(isActionHandled(result)).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
