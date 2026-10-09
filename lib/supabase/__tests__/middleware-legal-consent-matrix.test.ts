/**
 * #1174 規約の同意ゲートの「2 つのフラグの組み合わせ表」を、middleware (lib/supabase/middleware.ts) を通して固定する。
 *
 * 軸:
 *   LEGAL_CONSENT_NOTICE  (未設定 / off / on)   お知らせを出すか
 *   LEGAL_CONSENT_ENFORCE (off / on)            同意画面へ回すか
 *   同意の状態            (未同意 / 旧版に同意 / 最新に同意)
 *   画面                  (ログイン後の通常画面 / 同意画面 / 公開ページ (規約・プライバシー・ログイン・新規登録))
 * 各セルの期待 = お知らせを出すか・同意画面へ移動させるか。
 *
 * お知らせを描くのは (main) の layout (src/app/(main)/layout.tsx → MainLayout) だけ。middleware がヘッダーを付けても、
 * (main) の外の画面 (ログイン・新規登録は (auth)) には描かれない。そのため「お知らせを出すか」は
 * 「middleware がヘッダーを付ける」かつ「その画面が (main) の下にある」で決まる。後者は下の静的な検査で確かめる。
 *
 * 期待は下の EXPECTED に、セルごとに書き下す (実装の判定関数から作らない)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { LEGAL_DOCUMENTS } from '@homegohan/shared';

const mockGetSession = vi.fn();
const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getSession: mockGetSession, getUser: mockGetUser },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }) }),
  }),
}));

import { updateSession } from '../middleware';

const PENDING_HEADER = 'x-legal-consent-pending';
const forwardedPending = (res: Response) => res.headers.get(`x-middleware-request-${PENDING_HEADER}`);

/** 画面の種類と、確かめる代表のパス。inMainLayout = (main) の layout の下にあり、お知らせが描かれうる画面か */
const SCREENS = {
  main: { label: 'ログイン後の通常画面', paths: ['/home', '/menus/weekly'], inMainLayout: true },
  consent: { label: '同意画面', paths: ['/legal-consent'], inMainLayout: false },
  policy: { label: '公開ページ (規約・プライバシー)', paths: ['/terms', '/privacy'], inMainLayout: false },
  auth: { label: '公開ページ (ログイン・新規登録)', paths: ['/login', '/signup'], inMainLayout: false },
} as const;
type ScreenKind = keyof typeof SCREENS;

/** 画面のパスと、それを描くページのファイル (お知らせが (main) の下でだけ描かれることの根拠) */
const PAGE_FILES: Record<string, string> = {
  '/home': 'src/app/(main)/home/page.tsx',
  '/menus/weekly': 'src/app/(main)/menus/weekly/page.tsx',
  '/legal-consent': 'src/app/legal-consent/page.tsx',
  '/terms': 'src/app/terms/page.tsx',
  '/privacy': 'src/app/privacy/page.tsx',
  '/login': 'src/app/(auth)/login/page.tsx',
  '/signup': 'src/app/(auth)/signup/page.tsx',
};

const NOTICE_VALUES = { unset: undefined, off: 'off', on: 'on' } as const;
const ENFORCE_VALUES = { off: 'off', on: 'on' } as const;
type NoticeKey = keyof typeof NOTICE_VALUES;
type EnforceKey = keyof typeof ENFORCE_VALUES;

const CURRENT = {
  terms_version_accepted: LEGAL_DOCUMENTS.terms_of_service.version,
  privacy_version_accepted: LEGAL_DOCUMENTS.privacy_policy.version,
};
const STATES = {
  notAccepted: { label: '未同意', accepted: { terms_version_accepted: null, privacy_version_accepted: null } },
  oldVersion: { label: '旧版に同意', accepted: { terms_version_accepted: 'v0-old', privacy_version_accepted: 'v0-old' } },
  current: { label: '最新に同意', accepted: CURRENT },
} as const;
type StateKey = keyof typeof STATES;

/** セルの期待: banner = お知らせを出す / redirect = 同意画面へ移動させる / none = どちらもしない */
type Outcome = 'banner' | 'redirect' | 'none';

/**
 * 未同意・旧版に同意の人の期待 (同じ表)。最新に同意している人は、全セル none (下で別に確かめる)。
 * 行 = NOTICE × ENFORCE、列 = 画面。
 */
const EXPECTED_NOT_CURRENT: Record<NoticeKey, Record<EnforceKey, Record<ScreenKind, Outcome>>> = {
  unset: {
    off: { main: 'none', consent: 'none', policy: 'none', auth: 'none' },
    on: { main: 'redirect', consent: 'none', policy: 'none', auth: 'redirect' },
  },
  off: {
    off: { main: 'none', consent: 'none', policy: 'none', auth: 'none' },
    on: { main: 'redirect', consent: 'none', policy: 'none', auth: 'redirect' },
  },
  on: {
    off: { main: 'banner', consent: 'none', policy: 'none', auth: 'none' },
    on: { main: 'redirect', consent: 'none', policy: 'none', auth: 'redirect' },
  },
};

function expected(notice: NoticeKey, enforce: EnforceKey, state: StateKey, screen: ScreenKind): Outcome {
  if (state === 'current') return 'none';
  return EXPECTED_NOT_CURRENT[notice][enforce][screen];
}

function profile(accepted: Record<string, string | null>) {
  return {
    data: {
      roles: [],
      onboarding_started_at: '2026-03-01T00:00:00.000Z',
      onboarding_completed_at: '2026-03-01T01:00:00.000Z',
      frozen_at: null,
      unban_at: null,
      ...accepted,
    },
    error: null,
  };
}

function setFlags(notice: NoticeKey, enforce: EnforceKey) {
  vi.unstubAllEnvs();
  delete process.env.LEGAL_CONSENT_NOTICE;
  delete process.env.LEGAL_CONSENT_ENFORCE;
  const noticeValue = NOTICE_VALUES[notice];
  if (noticeValue !== undefined) vi.stubEnv('LEGAL_CONSENT_NOTICE', noticeValue);
  vi.stubEnv('LEGAL_CONSENT_ENFORCE', ENFORCE_VALUES[enforce]);
}

/** middleware を通した結果を、セルの期待と同じ形にする (お知らせは (main) の下でだけ描かれる) */
async function observe(pathname: string, inMainLayout: boolean): Promise<Outcome> {
  const res = await updateSession(new NextRequest(new URL(`http://localhost${pathname}`)));
  const location = res.headers.get('location');
  if (location !== null) {
    expect(res.status).toBe(307);
    expect(location).toBe(`http://localhost/legal-consent?next=${encodeURIComponent(pathname)}`);
    expect(forwardedPending(res)).toBeNull();
    return 'redirect';
  }
  expect(res.status).toBe(200);
  const pending = forwardedPending(res) === '1';
  return pending && inMainLayout ? 'banner' : 'none';
}

const NOTICE_KEYS = Object.keys(NOTICE_VALUES) as NoticeKey[];
const ENFORCE_KEYS = Object.keys(ENFORCE_VALUES) as EnforceKey[];
const STATE_KEYS = Object.keys(STATES) as StateKey[];
const SCREEN_KEYS = Object.keys(SCREENS) as ScreenKind[];

describe('同意ゲートの組み合わせ表 (#1174): NOTICE × ENFORCE × 同意の状態 × 画面', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  });
  afterEach(() => vi.unstubAllEnvs());

  for (const notice of NOTICE_KEYS) {
    for (const enforce of ENFORCE_KEYS) {
      describe(`NOTICE=${notice} / ENFORCE=${enforce}`, () => {
        for (const state of STATE_KEYS) {
          for (const screen of SCREEN_KEYS) {
            const outcome = expected(notice, enforce, state, screen);
            it.each(SCREENS[screen].paths)(
              `${STATES[state].label} × ${SCREENS[screen].label} (%s) → ${outcome}`,
              async (pathname) => {
                setFlags(notice, enforce);
                mockMaybeSingle.mockResolvedValue(profile(STATES[state].accepted));

                expect(await observe(pathname, SCREENS[screen].inMainLayout)).toBe(outcome);
              },
            );
          }
        }
      });
    }
  }

  it('表は全セルを埋めている (3 × 2 × 3 × 4 = 72 セル)', () => {
    const cells = NOTICE_KEYS.flatMap((n) =>
      ENFORCE_KEYS.flatMap((e) => STATE_KEYS.flatMap((st) => SCREEN_KEYS.map((sc) => expected(n, e, st, sc)))),
    );
    expect(cells).toHaveLength(72);
    expect(cells.every((c) => c === 'banner' || c === 'redirect' || c === 'none')).toBe(true);
    // お知らせが出るのは「NOTICE=on・ENFORCE=off・未同意 / 旧版・通常画面」の 2 セルだけ
    expect(cells.filter((c) => c === 'banner')).toHaveLength(2);
  });
});

describe('お知らせが描かれる画面 (inMainLayout) の根拠', () => {
  const ROOT = process.cwd();

  it.each(Object.entries(PAGE_FILES))('%s のページは %s にある', (_pathname, file) => {
    expect(fs.existsSync(path.join(ROOT, file))).toBe(true);
  });

  it.each(SCREEN_KEYS)('%s の画面が (main) の下にあるかは、表の inMainLayout と一致する', (screen) => {
    for (const pathname of SCREENS[screen].paths) {
      expect(PAGE_FILES[pathname].startsWith('src/app/(main)/')).toBe(SCREENS[screen].inMainLayout);
    }
  });

  it('お知らせ (LegalConsentBanner) を描くのは (main) の MainLayout だけ', () => {
    const renderers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && fs.readFileSync(full, 'utf8').includes('<LegalConsentBanner')) {
          renderers.push(path.relative(ROOT, full));
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    expect(renderers).toEqual([path.join('src', 'app', '(main)', 'MainLayout.tsx')]);
  });
});
