/**
 * account-frozen.test.ts — src/lib/account-frozen.ts (#1861)
 *
 * 403 AUTH_ACCOUNT_FROZEN を見分けて固定の文の例外にし、Provider へ知らせること・凍結の状態を決める純粋な関数・
 * ゲートの対象外のパス・getApi (withFriendlyErrors) と生の fetch (errorOfFailedResponse) の両方が通ること・
 * 凍結の画面のパス (/frozen と /frozen/account) が WebView の initialPath の検証と認証ブリッジの next を通ることを確かめる。
 */
import fs from 'fs';
import path from 'path';

import {
  ACCOUNT_FROZEN_CODE,
  ACCOUNT_FROZEN_MESSAGE,
  LEGAL_CONSENT_REQUIRED_CODE,
  LEGAL_CONSENT_REQUIRED_MESSAGE,
  LEGAL_CONSENT_STATUS_API_PATH,
  accountFrozenBody,
} from '@homegohan/shared';

jest.mock('../../src/lib/supabase', () => ({ supabase: { auth: { getSession: jest.fn() } } }));

import {
  AccountFrozenError,
  FROZEN_PROBE_API_PATH,
  FROZEN_SCREEN_PATH,
  FROZEN_SCREEN_ROUTE_NAME,
  MOBILE_FROZEN_EXEMPT_PATHS,
  accountFrozenEntryAfterProbe,
  accountFrozenErrorOf,
  accountFrozenStateOf,
  isAccountFrozenError,
  isMobileFrozenExemptPath,
  isNavigationHeldForAccountFrozen,
  resetAccountFrozenListenersForTests,
  subscribeAccountFrozen,
  type AccountFrozenEntry,
} from '../../src/lib/account-frozen';
import { withFriendlyErrors } from '../../src/lib/api';
import { errorOfFailedResponse, isStoppedByServerError, stoppedByServerAlertTitleOf } from '../../src/lib/failed-response';
import { LegalConsentRequiredError, resetLegalConsentListenersForTests } from '../../src/lib/legal-consent';
import { SERVICE_UNAVAILABLE_ALERT_TITLE } from '../../src/lib/service-unavailable';

/** middleware が返す本文 (入れ子) */
const FROZEN_BODY = JSON.stringify(accountFrozenBody());
/** route の平たい形 (本人向けの請求の API の ForbiddenError。cross/15) */
const FROZEN_FLAT_BODY = JSON.stringify({ error: ACCOUNT_FROZEN_MESSAGE, code: ACCOUNT_FROZEN_CODE });

function countNotifications(): () => number {
  let count = 0;
  subscribeAccountFrozen(() => {
    count += 1;
  });
  return () => count;
}

afterEach(() => {
  resetAccountFrozenListenersForTests();
  resetLegalConsentListenersForTests();
});

describe('accountFrozenErrorOf', () => {
  it.each([
    ['createHttpClient の形 (statusText あり)', `HTTP 403 Forbidden: ${FROZEN_BODY}`],
    ['HTTP/2 で statusText が空', `HTTP 403 : ${FROZEN_BODY}`],
    ['生の fetch の形', `HTTP 403: ${FROZEN_BODY}`],
    ['平たい本文', `HTTP 403: ${FROZEN_FLAT_BODY}`],
  ])('%s: AccountFrozenError (固定の文) を返し、1 回だけ知らせる', (_label, message) => {
    const notified = countNotifications();

    const error = accountFrozenErrorOf(new Error(message));

    expect(error).toBeInstanceOf(AccountFrozenError);
    expect(error?.message).toBe(ACCOUNT_FROZEN_MESSAGE);
    expect(error?.message).toBe('アカウントが凍結されています');
    expect(notified()).toBe(1);
  });

  it('すでに AccountFrozenError なら同じものを返し、知らせ直さない', () => {
    const notified = countNotifications();
    const original = new AccountFrozenError();

    expect(accountFrozenErrorOf(original)).toBe(original);
    expect(notified()).toBe(0);
  });

  it.each([
    ['規約の同意の 403', `HTTP 403 Forbidden: ${JSON.stringify({ error: LEGAL_CONSENT_REQUIRED_MESSAGE, code: LEGAL_CONSENT_REQUIRED_CODE })}`],
    ['AI 同意の 403', `HTTP 403 Forbidden: ${JSON.stringify({ error: 'x', code: 'AI_CONSENT_REQUIRED' })}`],
    ['凍結の本文だが 401', `HTTP 401 Unauthorized: ${FROZEN_BODY}`],
    ['凍結の本文だが 500', `HTTP 500: ${FROZEN_BODY}`],
    ['JSON でない本文', 'HTTP 403 Forbidden: <html>forbidden</html>'],
    ['形の違う message', 'Network request failed'],
  ])('%s は null で、知らせない', (_label, message) => {
    const notified = countNotifications();

    expect(accountFrozenErrorOf(new Error(message))).toBeNull();
    expect(notified()).toBe(0);
  });

  it.each([null, undefined, 'text', 42, {}])('Error でない値 (%p) は null', (value) => {
    expect(accountFrozenErrorOf(value)).toBeNull();
  });

  it('isAccountFrozenError は AccountFrozenError だけを true にする', () => {
    expect(isAccountFrozenError(new AccountFrozenError())).toBe(true);
    expect(isAccountFrozenError(new Error(ACCOUNT_FROZEN_MESSAGE))).toBe(false);
  });

  it('購読を外したら、知らせが届かない', () => {
    let count = 0;
    const unsubscribe = subscribeAccountFrozen(() => {
      count += 1;
    });
    unsubscribe();

    accountFrozenErrorOf(new Error(`HTTP 403: ${FROZEN_BODY}`));

    expect(count).toBe(0);
  });
});

describe('getApi (withFriendlyErrors) と生の fetch (errorOfFailedResponse) の両方が凍結の 403 を置き換える', () => {
  it('withFriendlyErrors: 凍結の 403 を AccountFrozenError に置き換え、知らせる', async () => {
    const notified = countNotifications();

    await expect(withFriendlyErrors(Promise.reject(new Error(`HTTP 403 Forbidden: ${FROZEN_BODY}`)))).rejects.toBeInstanceOf(
      AccountFrozenError,
    );
    expect(notified()).toBe(1);
  });

  it('withFriendlyErrors: 規約の同意の 403 は今までどおり LegalConsentRequiredError (凍結として知らせない)', async () => {
    const notified = countNotifications();
    const consentBody = JSON.stringify({ error: LEGAL_CONSENT_REQUIRED_MESSAGE, code: LEGAL_CONSENT_REQUIRED_CODE });

    await expect(withFriendlyErrors(Promise.reject(new Error(`HTTP 403 Forbidden: ${consentBody}`)))).rejects.toBeInstanceOf(
      LegalConsentRequiredError,
    );
    expect(notified()).toBe(0);
  });

  it('withFriendlyErrors: 成功はそのまま返し、知らせない', async () => {
    const notified = countNotifications();

    await expect(withFriendlyErrors(Promise.resolve({ ok: true }))).resolves.toEqual({ ok: true });
    expect(notified()).toBe(0);
  });

  it('errorOfFailedResponse: 凍結の 403 を AccountFrozenError にし、止められた例外として見出し「ご利用いただけません」で出せる', () => {
    const notified = countNotifications();

    const error = errorOfFailedResponse(403, FROZEN_BODY);

    expect(error).toBeInstanceOf(AccountFrozenError);
    expect(notified()).toBe(1);
    expect(isStoppedByServerError(error)).toBe(true);
    if (!isStoppedByServerError(error)) throw new Error('unreachable');
    expect(stoppedByServerAlertTitleOf(error)).toBe(SERVICE_UNAVAILABLE_ALERT_TITLE);
  });

  it('errorOfFailedResponse: ほかの 403 は今までどおり HTTP の文の Error', () => {
    const error = errorOfFailedResponse(403, JSON.stringify({ error: 'forbidden' }));

    expect(error).not.toBeInstanceOf(AccountFrozenError);
    expect(error.message).toBe('HTTP 403: {"error":"forbidden"}');
  });
});

describe('凍結の状態の純粋な関数', () => {
  const USER = 'user-1';

  it('accountFrozenStateOf: 未ログインは clear、記録が無い・別の利用者の記録なら loading、今の利用者の記録はその状態', () => {
    expect(accountFrozenStateOf(null, null)).toBe('clear');
    expect(accountFrozenStateOf(null, { userId: USER, state: 'frozen' })).toBe('clear');
    expect(accountFrozenStateOf(USER, null)).toBe('loading');
    expect(accountFrozenStateOf(USER, { userId: 'user-2', state: 'frozen' })).toBe('loading');
    for (const state of ['clear', 'frozen', 'unknown'] as const) {
      expect(accountFrozenStateOf(USER, { userId: USER, state })).toBe(state);
    }
  });

  it('accountFrozenEntryAfterProbe: ok → clear (凍結の後でも戻る) / frozen → frozen / failed → 今の利用者の記録を保つ・無ければ unknown', () => {
    const frozen: AccountFrozenEntry = { userId: USER, state: 'frozen' };
    const clear: AccountFrozenEntry = { userId: USER, state: 'clear' };

    expect(accountFrozenEntryAfterProbe(frozen, USER, 'ok')).toEqual(clear);
    expect(accountFrozenEntryAfterProbe(null, USER, 'ok')).toEqual(clear);
    expect(accountFrozenEntryAfterProbe(clear, USER, 'frozen')).toEqual(frozen);
    expect(accountFrozenEntryAfterProbe(null, USER, 'frozen')).toEqual(frozen);
    // 同じ状態なら同じ記録を返す (描画を増やさない)
    expect(accountFrozenEntryAfterProbe(frozen, USER, 'frozen')).toBe(frozen);
    expect(accountFrozenEntryAfterProbe(clear, USER, 'ok')).toBe(clear);
    expect(accountFrozenEntryAfterProbe({ userId: 'user-2', state: 'frozen' }, USER, 'frozen')).toEqual(frozen);
    expect(accountFrozenEntryAfterProbe(frozen, USER, 'failed')).toBe(frozen);
    expect(accountFrozenEntryAfterProbe(clear, USER, 'failed')).toBe(clear);
    expect(accountFrozenEntryAfterProbe(null, USER, 'failed')).toEqual({ userId: USER, state: 'unknown' });
    // 別の利用者の記録は使わない
    expect(accountFrozenEntryAfterProbe({ userId: 'user-2', state: 'frozen' }, USER, 'failed')).toEqual({
      userId: USER,
      state: 'unknown',
    });
  });

  it('isNavigationHeldForAccountFrozen: loading・frozen・前面が凍結の画面の間は待つ。clear / unknown でほかの画面なら待たない', () => {
    expect(isNavigationHeldForAccountFrozen('loading', '/home')).toBe(true);
    expect(isNavigationHeldForAccountFrozen('frozen', '/home')).toBe(true);
    expect(isNavigationHeldForAccountFrozen('clear', FROZEN_SCREEN_PATH)).toBe(true);
    expect(isNavigationHeldForAccountFrozen('clear', '/home')).toBe(false);
    expect(isNavigationHeldForAccountFrozen('unknown', '/home')).toBe(false);
  });
});

describe('凍結の画面の route と判定の API', () => {
  const APP_DIR = path.resolve(__dirname, '../../app');

  it('FROZEN_SCREEN_PATH は /frozen で、route の名前 (frozen) のファイル app/frozen.tsx がある', () => {
    expect(FROZEN_SCREEN_PATH).toBe('/frozen');
    expect(FROZEN_SCREEN_ROUTE_NAME).toBe('frozen');
    expect(fs.existsSync(path.join(APP_DIR, `${FROZEN_SCREEN_ROUTE_NAME}.tsx`))).toBe(true);
  });

  it('判定の API は、規約の同意の状況の API (GET /api/legal/status)', () => {
    expect(FROZEN_PROBE_API_PATH).toBe(LEGAL_CONSENT_STATUS_API_PATH);
  });
});

describe('MOBILE_FROZEN_EXEMPT_PATHS', () => {
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

  it('apps/mobile/app の (auth) と (public) の画面のパスと凍結の画面 (/frozen) に一致する', () => {
    const screens = [...screenPathsOf('(auth)'), ...screenPathsOf('(public)')];
    expect(screens.length).toBeGreaterThan(0);
    for (const screen of screens) {
      expect(isMobileFrozenExemptPath(screen)).toBe(true);
    }
    for (const exempt of MOBILE_FROZEN_EXEMPT_PATHS) {
      if (exempt === FROZEN_SCREEN_PATH) continue;
      // jest の expect は第 2 引数 (失敗時の文) を取らないので、どのパスかを値に含めて比べる
      const matched = screens.some((screen) => screen === exempt || screen.startsWith(`${exempt}/`));
      expect({ exempt, matched }).toEqual({ exempt, matched: true });
    }
  });

  it('前方一致だけの紛らわしいパス・規約の同意画面・タブは対象 (対象外にしない)', () => {
    for (const pathname of ['/loginx', '/frozenx', '/legal-consent', '/home', '/', '/onboarding/welcome', '/settings']) {
      expect({ pathname, exempt: isMobileFrozenExemptPath(pathname) }).toEqual({ pathname, exempt: false });
    }
    for (const pathname of ['/login', '/auth/verify', '/frozen', '/terms']) {
      expect({ pathname, exempt: isMobileFrozenExemptPath(pathname) }).toEqual({ pathname, exempt: true });
    }
  });
});
