/**
 * legal-consent.test.ts — src/lib/legal-consent.ts (#1442 設計書 cross/13b §6.6.8。T-ML1〜T-ML10)
 *
 * 純粋な関数と定数だけのモジュール。403 LEGAL_CONSENT_REQUIRED の見分け、Provider への知らせ、対象外のパス、
 * 同意の状態の決め方、同意画面の route の扱いと取り除く操作の決定を確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';

import { LEGAL_CONSENT_REQUIRED_CODE, LEGAL_CONSENT_REQUIRED_MESSAGE } from '@homegohan/shared';

import {
  ENTRY_SCREEN_PATH,
  LEGAL_CONSENT_ACCEPTED_MESSAGE_TYPE,
  LEGAL_CONSENT_SCREEN_PATH,
  LEGAL_CONSENT_SCREEN_ROUTE_NAME,
  LegalConsentRequiredError,
  MOBILE_LEGAL_CONSENT_EXEMPT_PATHS,
  isLegalConsentRequiredError,
  isMobileLegalConsentExemptPath,
  isNavigationHeldForLegalConsent,
  legalConsentEntryAfterEvent,
  legalConsentEntryAfterFailure,
  legalConsentRequiredErrorOf,
  legalConsentScreenModeOf,
  legalConsentScreenRemovalDecision,
  legalConsentScreenSawRequired,
  legalConsentStateOf,
  notifyLegalConsentAccepted,
  notifyLegalConsentRequired,
  parseLegalConsentMessage,
  resetLegalConsentListenersForTests,
  subscribeLegalConsentEvents,
  type LegalConsentEntry,
  type LegalConsentEvent,
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

describe('legalConsentScreenRemovalDecision (T-ML6)', () => {
  it('awaiting-consent は RESET だけ allow、GO_BACK・POP・POP_TO_TOP・REPLACE・NAVIGATE は block', () => {
    expect(legalConsentScreenRemovalDecision('awaiting-consent', 'RESET')).toBe('allow');
    for (const type of ['GO_BACK', 'POP', 'POP_TO_TOP', 'REPLACE', 'NAVIGATE', 'PUSH']) {
      expect(legalConsentScreenRemovalDecision('awaiting-consent', type)).toBe('block');
    }
  });

  it('signed-out-notice は RESET を含めて全部 block', () => {
    for (const type of ['RESET', 'GO_BACK', 'POP', 'POP_TO_TOP', 'REPLACE', 'NAVIGATE']) {
      expect(legalConsentScreenRemovalDecision('signed-out-notice', type)).toBe('block');
    }
  });

  it('free は全部 allow', () => {
    for (const type of ['RESET', 'GO_BACK', 'POP', 'POP_TO_TOP', 'REPLACE', 'NAVIGATE']) {
      expect(legalConsentScreenRemovalDecision('free', type)).toBe('allow');
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
