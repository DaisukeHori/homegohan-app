/**
 * /admin/users/{id} のログイン履歴の節 (#1720 段 D。docs/design/cross/16-auth-history-sessions.md §17・§20.4)
 *
 * tests/admin-preparing-pages.test.tsx と同じ形: 入口 (requireRoleForPage) と adminFetch を mock し、
 * async の Server Component を renderToStaticMarkup で HTML にして確かめる。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LOGIN_HISTORY_PAGE_SIZE } from '@/lib/auth/sessions/constants';

const requireRoleForPage = vi.hoisted(() => vi.fn());
const adminFetch = vi.hoisted(() => vi.fn());
const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
);

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound, useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/auth/page-guard', () => ({ requireRoleForPage }));
vi.mock('@/lib/admin/fetch', () => ({ adminFetch }));

const { default: AdminUserDetailPage } = await import('@/app/admin/users/[id]/page');

const TARGET_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DETAIL_PATH = `/api/admin/users/${TARGET_ID}`;
const LOGIN_HISTORY_PATH = `/api/admin/users/${TARGET_ID}/login-history`;
const SECTION_HEADING = `ログイン履歴 (直近 ${LOGIN_HISTORY_PAGE_SIZE} 回)`;
const LOAD_ERROR = 'ログイン履歴を読み込めませんでした';
/** §17 の逐語 (左から 7 つ) */
const EXPECTED_COLUMNS = ['日時', '端末', 'IP', '国', '印', '通知メールを送信待ちに登録した日時', '終了'];

const adminActor = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', roles: ['admin'], email: 'admin@example.com' };
const superAdminActor = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', roles: ['super_admin'], email: 'sa@example.com' };
const supportActor = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', roles: ['support'], email: 'support@example.com' };

const profile = {
  id: TARGET_ID,
  email: 'target@example.com',
  nickname: '対象さん',
  roles: ['user'],
  plan_key: 'free',
  is_banned: false,
  frozen_at: null,
  frozen_reason: null,
  last_login_at: null,
  registered_at: '2026-01-01T00:00:00+00:00',
  active_subscription: null,
  ban_history: [],
};

function entry(index: number, overrides: Record<string, unknown> = {}) {
  return {
    session_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    created_at: '2026-10-15T01:00:00Z',
    last_active_at: '2026-10-15T02:00:00Z',
    device_label: 'iPhone・iPad の Safari',
    device_name: null,
    ip_address: '203.0.113.7',
    country_code: 'JP',
    ended_at: null,
    ended_reason: null,
    is_new_device: false,
    is_new_ip: false,
    is_new_country: false,
    alert_sent_at: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/** path ごとに応答を返す adminFetch の偽物。login-history の応答 (または例外) を差し替えられる */
function routeAdminFetch(loginHistory: { body: unknown; status?: number } | Error) {
  adminFetch.mockImplementation(async (path: string) => {
    if (path === DETAIL_PATH) return jsonResponse({ data: profile });
    if (path === LOGIN_HISTORY_PATH) {
      if (loginHistory instanceof Error) throw loginHistory;
      return jsonResponse(loginHistory.body, loginHistory.status ?? 200);
    }
    throw new Error(`unexpected adminFetch(${path})`);
  });
}

async function render(): Promise<HTMLDivElement> {
  const markup = renderToStaticMarkup(await AdminUserDetailPage({ params: Promise.resolve({ id: TARGET_ID }) }));
  const host = document.createElement('div');
  host.innerHTML = markup;
  return host;
}

function section(host: HTMLElement): HTMLElement | null {
  return host.querySelector('[data-testid="admin-user-login-history"]');
}

function calledPaths(): string[] {
  return adminFetch.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleForPage.mockResolvedValue(adminActor);
});

describe('/admin/users/{id} のログイン履歴の節 (cross/16 §17)', () => {
  it('admin は /api/admin/users/{id}/login-history を呼び、日時 (日本時間)・端末・IP・国・印・送信待ちに登録した日時・終了の理由を、§17 の 7 つの列見出しで出す', async () => {
    routeAdminFetch({
      body: {
        data: {
          entries: [
            entry(1, {
              device_name: 'iPhone 15 Pro (iOS 18.0)',
              is_new_device: true,
              is_new_ip: true,
              is_new_country: true,
              alert_sent_at: '2026-10-15T01:01:00Z',
            }),
            entry(2, {
              created_at: '2026-10-14T23:30:00Z',
              device_label: 'Mac の Chrome',
              ip_address: '198.51.100.9',
              country_code: 'US',
              ended_at: '2026-10-15T00:00:00Z',
              ended_reason: 'signed_out',
            }),
            entry(3, { ended_at: '2026-10-15T00:00:00Z', ended_reason: 'idle_expired' }),
            entry(4, { ended_at: '2026-10-15T00:00:00Z', ended_reason: 'revoked_by_user' }),
          ],
        },
      },
    });
    const host = await render();

    expect(calledPaths()).toContain(LOGIN_HISTORY_PATH);
    const node = section(host);
    expect(node).not.toBeNull();
    expect(node!.querySelector('h2')!.textContent).toBe(SECTION_HEADING);

    // 列見出しは左から 7 つ (「通知メール」だけの見出しを通さない)
    const headers = Array.from(node!.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).toEqual(EXPECTED_COLUMNS);

    const rows = Array.from(node!.querySelectorAll('tbody tr')).map((tr) =>
      Array.from(tr.querySelectorAll('td')).map((td) => td.textContent),
    );
    expect(rows).toHaveLength(4);
    // 2026-10-15T01:00:00Z は日本時間の 10:00
    expect(rows[0]).toEqual([
      '2026/10/15 10:00:00',
      'iPhone・iPad の Safari (端末名: iPhone 15 Pro (iOS 18.0))',
      '203.0.113.7',
      'JP',
      '新しい端末・新しい接続元・新しい地域',
      '2026/10/15 10:01:00',
      '-',
    ]);
    // 端末名が無ければ添えない・印が無ければ「-」・送信待ちに登録していなければ「なし」・終了は理由と日本時間の日時
    expect(rows[1]).toEqual([
      '2026/10/15 8:30:00',
      'Mac の Chrome',
      '198.51.100.9',
      'US',
      '-',
      'なし',
      'ログアウト (2026/10/15 9:00:00)',
    ]);
    expect(rows[2][6]).toBe('使われずに期限切れ (2026/10/15 9:00:00)');
    expect(rows[3][6]).toBe('本人が端末の一覧から解除 (2026/10/15 9:00:00)');
  });

  it('super_admin も節を出す', async () => {
    requireRoleForPage.mockResolvedValue(superAdminActor);
    routeAdminFetch({ body: { data: { entries: [entry(1)] } } });
    const host = await render();
    expect(calledPaths()).toContain(LOGIN_HISTORY_PATH);
    expect(section(host)!.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('support は login-history を呼ばず (adminFetch の呼び出しに login-history が無い)、節を出さない', async () => {
    requireRoleForPage.mockResolvedValue(supportActor);
    routeAdminFetch({ body: { data: { entries: [entry(1)] } } });
    const host = await render();
    expect(calledPaths()).toEqual([DETAIL_PATH]);
    expect(calledPaths().some((p) => p.includes('login-history'))).toBe(false);
    expect(section(host)).toBeNull();
    expect(host.textContent).not.toContain('ログイン履歴');
    // ページの他の節は出る
    expect(host.textContent).toContain('基本情報');
  });

  it('0 件は「記録なし」(表を出さない)', async () => {
    routeAdminFetch({ body: { data: { entries: [] } } });
    const host = await render();
    const node = section(host)!;
    expect(node.textContent).toContain('記録なし');
    expect(node.querySelector('table')).toBeNull();
  });

  it.each([403, 500])('login-history の応答が %i なら節に「ログイン履歴を読み込めませんでした」を出し、利用者詳細の他の節は出る', async (status) => {
    routeAdminFetch({ body: { error: { code: 'X', message: 'x' } }, status });
    const host = await render();
    const node = section(host)!;
    expect(node.textContent).toContain(LOAD_ERROR);
    expect(node.querySelector('table')).toBeNull();
    expect(notFound).not.toHaveBeenCalled();
    expect(host.textContent).toContain('基本情報');
    expect(host.textContent).toContain('対象さん');
  });

  it('通信の失敗 (adminFetch の例外) と、形の違う応答も「読み込めませんでした」で、ページは描く', async () => {
    routeAdminFetch(new Error('fetch failed'));
    let host = await render();
    expect(section(host)!.textContent).toContain(LOAD_ERROR);
    expect(host.textContent).toContain('基本情報');

    routeAdminFetch({ body: { data: { entries: [{ session_id: 'x' }] } } });
    host = await render();
    expect(section(host)!.textContent).toContain(LOAD_ERROR);
  });
});
