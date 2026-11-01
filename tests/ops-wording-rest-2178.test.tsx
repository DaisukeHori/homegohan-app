/**
 * #2178 Y2 運営・サポートの画面の呼び名の残り
 *
 * Y2-a 利用者の凍結の状態の呼び名を「凍結」の系に揃える
 *   以前: サポートの利用者の一覧の印は「利用停止」、同じ画面の詳細パネルは「このユーザーはBANされています」、
 *   運営の一覧の状態の表示名は「BAN 済み」、運営の詳細のボタンは「凍結 (BAN)」、凍結の画面の見出しは「ユーザー凍結 (BAN)」だった。
 *   「利用停止」は個人情報の請求の種類 (開示・訂正・利用停止・消去) の語でもあり、運営の請求の画面は
 *   「凍結は利用停止の手段に使わない」と書き分けているので、語が重なっていた。
 *   直したあと: 一覧の印・状態の表示名は「凍結中」、詳細パネルは「このユーザーは凍結中です」、
 *   運営の詳細のボタンは「凍結」、凍結の画面の見出しは「ユーザー凍結」。請求の種類の「利用停止」は変えない。
 *   (サポートの一覧の印と詳細パネルは tests/support-users-list-1717.test.tsx が描画して見る)
 *
 * Y2-b AI の日次上限の画面で保存できない行の案内の呼び名
 *   以前: 「このキーはプランの表にも組織のプランにも無いため、保存できません」。運営の画面の欄名「プランの鍵」(#2166 X2) と違った。
 *   直したあと: 「このプランの鍵はプランの表にも組織のプランにも無いため、保存できません」。
 *
 * 画面 (async の Server Component) は renderToStaticMarkup で描く (tests/admin-users-load-failure-2093.test.tsx と同じ形)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stripComments } from './helpers/ai-reach';

const requireRoleForPage = vi.hoisted(() => vi.fn());
const adminFetch = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => router,
}));
vi.mock('@/lib/auth/page-guard', () => ({ requireRoleForPage }));
vi.mock('@/lib/admin/fetch', () => ({ adminFetch }));

const { default: AdminUserDetailPage } = await import('@/app/admin/users/[id]/page');
const { default: AdminUserFreezePage } = await import('@/app/admin/users/[id]/freeze/page');
const { USER_LIST_STATUS_LABELS } = await import('@/lib/admin/users-schemas');
const { AI_DAILY_LIMIT_READ_ONLY_NOTES } = await import('@/lib/super-admin/ai-daily-limits');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

const USER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const adminActor = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', roles: ['admin'], email: 'admin@example.com' };

const HTTP_OK = 200;

/** 凍結の状態の呼び名 (Y2-a) */
const FROZEN_STATUS_LABEL = '凍結中';
const FREEZE_BUTTON_LABEL = '凍結';
const UNFREEZE_LABEL = '凍結解除';
const FREEZE_HEADING = 'ユーザー凍結';
/** 個人情報の請求の種類の語。凍結の呼び名には使わない */
const DATA_REQUEST_SUSPENSION_WORD = '利用停止';

/** 保存できない行 (プランの表にも組織のプランにも無い鍵) の案内 (Y2-b) */
const UNKNOWN_PLAN_KEY_NOTE = 'このプランの鍵はプランの表にも組織のプランにも無いため、保存できません';

function jsonResponse(body: unknown) {
  return { ok: true, status: HTTP_OK, json: () => Promise.resolve(body) };
}

function detailProfile(isBanned: boolean) {
  return {
    id: USER_ID,
    email: 'target@example.com',
    nickname: '対象さん',
    roles: ['user'],
    plan_key: 'free',
    is_banned: isBanned,
    frozen_at: isBanned ? '2026-10-06T03:00:00.000Z' : null,
    frozen_reason: isBanned ? '規約違反' : null,
    last_login_at: null,
    registered_at: '2026-01-01T00:00:00+00:00',
    active_subscription: null,
    ban_history: [],
  };
}

function mockDetail(isBanned: boolean) {
  adminFetch.mockImplementation(async (apiPath: string) =>
    apiPath.endsWith('/login-history') ? jsonResponse({ data: { entries: [] } }) : jsonResponse({ data: detailProfile(isBanned) }),
  );
}

function hostOf(markup: string): HTMLDivElement {
  const host = document.createElement('div');
  host.innerHTML = markup;
  return host;
}

async function renderUserDetail(): Promise<HTMLDivElement> {
  return hostOf(renderToStaticMarkup(await AdminUserDetailPage({ params: Promise.resolve({ id: USER_ID }) })));
}

async function renderUserFreeze(): Promise<HTMLDivElement> {
  return hostOf(renderToStaticMarkup(await AdminUserFreezePage({ params: Promise.resolve({ id: USER_ID }) })));
}

/** 凍結の画面へのリンクの文 */
function freezeLinkTexts(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll(`a[href="/admin/users/${USER_ID}/freeze"]`)).map((a) => (a.textContent ?? '').trim());
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleForPage.mockResolvedValue(adminActor);
});

describe('#2178 Y2-a 運営の画面の凍結の呼び名は「凍結」の系 (英字の BAN を出さない)', () => {
  it('一覧の状態の表示名 (USER_LIST_STATUS_LABELS.banned) は「凍結中」', () => {
    expect(USER_LIST_STATUS_LABELS.banned).toBe(FROZEN_STATUS_LABEL);
  });

  it('ユーザーの詳細: 凍結されていなければ凍結の画面へのボタンは「凍結」', async () => {
    mockDetail(false);
    const page = await renderUserDetail();
    expect(freezeLinkTexts(page)).toEqual([FREEZE_BUTTON_LABEL]);
  });

  it('ユーザーの詳細: 凍結中なら状態は「凍結中」、ボタンは「凍結解除」', async () => {
    mockDetail(true);
    const page = await renderUserDetail();
    expect(freezeLinkTexts(page)).toEqual([UNFREEZE_LABEL]);
    const statusTexts = Array.from(page.querySelectorAll('dd span')).map((el) => (el.textContent ?? '').trim());
    expect(statusTexts).toContain(FROZEN_STATUS_LABEL);
  });

  it('凍結の画面: 凍結されていなければ見出しは「ユーザー凍結」、凍結中なら「凍結解除」', async () => {
    mockDetail(false);
    const notBanned = await renderUserFreeze();
    expect(notBanned.querySelector('h1')?.textContent?.trim()).toBe(FREEZE_HEADING);

    mockDetail(true);
    const banned = await renderUserFreeze();
    expect(banned.querySelector('h1')?.textContent?.trim()).toBe(UNFREEZE_LABEL);
  });

  /** 凍結の状態・操作の呼び名を出す画面のソース */
  const FREEZE_WORDING_SOURCES = [
    'src/app/(support)/support/users/page.tsx',
    'src/app/admin/users/[id]/page.tsx',
    'src/app/admin/users/[id]/freeze/page.tsx',
    'src/lib/admin/users-schemas.ts',
  ] as const;
  /** 古い呼び名 */
  const STALE_FREEZE_WORDINGS = ['BAN 済み', 'BANされています', '凍結 (BAN)', 'ユーザー凍結 (BAN)'] as const;

  it.each(FREEZE_WORDING_SOURCES)('%s のコード (コメントを除く) に古い呼び名が残っていない', (source) => {
    const text = stripComments(read(source));
    for (const stale of STALE_FREEZE_WORDINGS) {
      expect(text.includes(stale), `${source} に「${stale}」`).toBe(false);
    }
  });

  it('サポートの利用者の画面は凍結の呼び名に、個人情報の請求の種類の語「利用停止」を使わない', () => {
    const text = stripComments(read('src/app/(support)/support/users/page.tsx'));
    expect(text).toContain(FROZEN_STATUS_LABEL);
    expect(text).toContain('このユーザーは凍結中です');
    expect(text).not.toContain(DATA_REQUEST_SUSPENSION_WORD);
  });

  it('運営の請求の画面の「凍結は利用停止の手段に使わない」の書き分けは残す (請求の種類の語は変えない)', () => {
    const text = stripComments(read('src/app/admin/data-requests/[id]/page.tsx'));
    expect(text).toContain('凍結は利用停止の手段に使わないでください');
  });
});

describe('#2178 Y2-b AI の日次上限の画面で保存できない行の案内は「プランの鍵」の呼び名', () => {
  it('表に無いプランの行の案内の文', () => {
    expect(AI_DAILY_LIMIT_READ_ONLY_NOTES.unknown_key).toBe(UNKNOWN_PLAN_KEY_NOTE);
  });

  it('呼び名は運営の画面の欄名「プランの鍵」と同じで、旧い「このキー」は出さない', () => {
    expect(AI_DAILY_LIMIT_READ_ONLY_NOTES.unknown_key).toContain('プランの鍵');
    expect(AI_DAILY_LIMIT_READ_ONLY_NOTES.unknown_key).not.toContain('このキー');
    expect(stripComments(read('src/app/super-admin/plans/page.tsx'))).toContain('プランの鍵');
  });
});
