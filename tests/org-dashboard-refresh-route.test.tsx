/**
 * #1167 組織ダッシュボードの「Refresh Data」は、Edge Function を直接呼ばず API ルートを呼ぶ
 *
 * 以前は supabase.functions.invoke('aggregate-org-stats') でブラウザから Edge Function を直接呼んでいた。
 * この関数はバッチ専用 (service role / CRON_SECRET の認証) で、利用者の JWT では 401 になるため常に失敗していた。
 * ブラウザから呼べるように CORS を開けるのは危険なので、権限の確認と呼び出しをサーバー側の
 * POST /api/org/stats/refresh に移した。ボタンを実際に押して、次を確かめる。
 *   - Edge Function (functions.invoke) を呼ばない
 *   - POST /api/org/stats/refresh を呼び、成功したら統計を取り直して成功を知らせる
 *   - 失敗したら統計を取り直さず、失敗を知らせる
 *
 * 集計する日付 (#1210: JST の今日) もブラウザは送らない。以前は todayLocal() を送っていたが、
 * 今は Edge Function の既定 (todayJst()) に任せる。ブラウザの時計で集計日が変わらない。
 * 既定が JST の今日になること自体は tests/aggregate-org-stats-jst-date.test.ts が確かめる。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  statsRead: vi.fn(),
}));

// ブラウザ用 Supabase クライアントの偽物。ログイン済みの組織管理者 (組織 org-1) が見ている想定。
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'admin-1' } }, error: null }) },
    from: (table: string) => {
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'order', 'limit']) {
        query[method] = () => query;
      }
      query.single = async () => {
        if (table === 'org_daily_stats') {
          mocks.statsRead();
          return { data: null, error: { message: 'no rows' } };
        }
        return { data: { organization_id: 'org-1' }, error: null };
      };
      return query;
    },
    functions: { invoke: mocks.invoke },
  }),
}));

const { default: OrgDashboardPage } = await import('@/app/(org)/org/dashboard/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let alertSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue({ data: { success: true }, error: null });
  mocks.statsRead.mockReset();

  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
  vi.stubGlobal('fetch', fetchMock);
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  alertSpy.mockRestore();
  vi.unstubAllGlobals();
});

/** 条件が満たされるまで待つ (非同期の読み込み・更新が終わるのを待つ) */
async function until(condition: () => boolean, what: string) {
  const startedAt = performance.now();
  while (!condition()) {
    if (performance.now() - startedAt > 3000) throw new Error(`待ちきれませんでした: ${what}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderDashboard() {
  await act(async () => {
    root.render(<OrgDashboardPage />);
  });
  // 初回の統計の読み込みが終わるまで待つ
  await until(() => mocks.statsRead.mock.calls.length === 1, '初回の統計の読み込み');
}

async function clickRefresh() {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Refresh Data'));
  expect(button, '「Refresh Data」ボタンが見つかりません').toBeTruthy();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await until(() => alertSpy.mock.calls.length > 0, '更新の結果の通知 (alert)');
}

describe('組織ダッシュボード: Refresh Data (#1167)', () => {
  it('DR-1: Edge Function を直接呼ばず、POST /api/org/stats/refresh を呼ぶ。組織 ID や集計日 (#1210) はブラウザから送らない', async () => {
    await renderDashboard();

    await clickRefresh();

    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/org/stats/refresh', { method: 'POST' });
  });

  it('DR-2: 成功したら統計を取り直し、成功を知らせる', async () => {
    await renderDashboard();

    await clickRefresh();

    expect(mocks.statsRead).toHaveBeenCalledTimes(2); // 初回 + 更新後
    expect(alertSpy).toHaveBeenCalledWith('最新データに更新しました');
  });

  it.each([
    ['権限が無い (403)', { ok: false, status: 403 }],
    ['集計に失敗した (502)', { ok: false, status: 502 }],
  ])('DR-3: %s ときは統計を取り直さず、失敗を知らせる', async (_label, response) => {
    fetchMock.mockResolvedValue({ ...response, json: () => Promise.resolve({ error: { code: 'X' } }) });
    await renderDashboard();

    await clickRefresh();

    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.statsRead).toHaveBeenCalledTimes(1); // 初回だけ
    expect(alertSpy).toHaveBeenCalledWith('更新に失敗しました');
  });

  it('DR-4: 通信自体が失敗しても、失敗を知らせてボタンを押せる状態に戻す', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await renderDashboard();

    await clickRefresh();

    expect(alertSpy).toHaveBeenCalledWith('更新に失敗しました');
    await until(
      () =>
        Array.from(container.querySelectorAll('button')).some(
          (b) => b.textContent?.includes('Refresh Data') && !b.disabled,
        ),
      'ボタンが押せる状態に戻る',
    );
  });
});
