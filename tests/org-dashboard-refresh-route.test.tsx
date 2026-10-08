/**
 * #1325 / #1120 組織ダッシュボード: 集計と部署別の表示を止め、「準備中」にする
 *
 * 以前のダッシュボード (#1167) は、次のものを出していた。
 *   - org_daily_stats (組織の日次統計) を直接読む 4 枚のスコアカード (活力スコア・朝食摂取率・深夜食率・活動率)
 *   - 「↻ Refresh Data」ボタン (POST /api/org/stats/refresh で再集計を依頼する)
 *   - 部署ランキング (Sales Team 88 など、コードに直接書いたダミーの数字)
 * オーナー判断 (#1325 / #1120) で、組織の集計は止め、ダミーのランキングは取り除いた。
 * いまのダッシュボードが出すのは、メンバー数 (GET /api/org/stats の member_count) と「準備中」の案内だけ。
 * このテストは、ページを実際に描画して次を確かめる。
 *   - 「準備中」の案内とメンバー数が出る
 *   - 「Refresh Data」ボタンが無い (ボタンは 1 つも無い)
 *   - 通信は GET /api/org/stats だけ。再集計の API・Edge Function は呼ばない
 *   - org_daily_stats を読まない (ブラウザ用 Supabase クライアントを使わない)
 *   - ダミーの部署ランキングやスコアカードが出ない
 *   - メンバー数が取れなくても、案内は出る (失敗は「—」と短い文で伝える)
 * ソースにも、取り除いたものの名前が残っていないことを確かめる。
 *
 * ファイル名は #1167 のときのまま (ボタンから再集計 API を呼ぶテストだった)。
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  from: vi.fn(),
  invoke: vi.fn(),
}));

// ブラウザ用 Supabase クライアントの罠。ダッシュボードがこれを使って org_daily_stats などを読んだら検出する。
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    mocks.createClient();
    return {
      auth: { getUser: async () => ({ data: { user: { id: 'admin-1' } }, error: null }) },
      from: (table: string) => {
        mocks.from(table);
        const query: Record<string, unknown> = {};
        for (const method of ['select', 'eq', 'order', 'limit']) {
          query[method] = () => query;
        }
        query.single = async () => ({ data: null, error: { message: 'no rows' } });
        return query;
      },
      functions: { invoke: mocks.invoke },
    };
  },
}));

const { default: OrgDashboardPage } = await import('@/app/(org)/org/dashboard/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PAGE_SOURCE_PATH = path.resolve(__dirname, '../src/app/(org)/org/dashboard/page.tsx');
const NOTICE = '組織の集計・部署別の表示は準備中です';

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let alertSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

beforeEach(() => {
  mocks.createClient.mockReset();
  mocks.from.mockReset();
  mocks.invoke.mockReset();

  fetchMock = vi.fn(async (input: unknown) => {
    if (input === '/api/org/stats') {
      return jsonResponse({ stats: { member_count: 7, organization_id: 'org-1' } });
    }
    return jsonResponse({ error: { code: 'NOT_FOUND' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

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
  consoleErrorSpy.mockRestore();
  vi.unstubAllGlobals();
});

/** 条件が満たされるまで待つ (非同期の読み込みが終わるのを待つ) */
async function until(condition: () => boolean, what: string) {
  const startedAt = performance.now();
  while (!condition()) {
    if (performance.now() - startedAt > 3000) throw new Error(`待ちきれませんでした: ${what}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** 描画して、メンバー数の取得が終わる (成功か失敗の表示になる) まで待つ */
async function renderDashboard() {
  await act(async () => {
    root.render(<OrgDashboardPage />);
  });
  await until(() => fetchMock.mock.calls.length >= 1, 'メンバー数の取得の開始');
  await until(
    () => /users/.test(container.textContent ?? '') || /取得できませんでした/.test(container.textContent ?? ''),
    'メンバー数の取得の完了',
  );
}

const text = () => container.textContent ?? '';

describe('組織ダッシュボード: 集計を止めて「準備中」にする (#1325 / #1120)', () => {
  it('DR-1: 「準備中」の案内と、GET /api/org/stats のメンバー数が出る', async () => {
    await renderDashboard();

    expect(text()).toContain(NOTICE);
    expect(text()).toContain('Total Members');
    expect(text()).toMatch(/7\s*users/);
  });

  it('DR-2: 「Refresh Data」ボタンが無い。ボタンは 1 つも無く、更新を促す文言も無い', async () => {
    await renderDashboard();

    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(text()).not.toContain('Refresh');
    expect(text()).not.toContain('Updating');
    expect(text()).not.toContain('更新');
  });

  it('DR-3: 通信は GET /api/org/stats の 1 回だけ。再集計の API (/api/org/stats/refresh) も Edge Function も呼ばない', async () => {
    await renderDashboard();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/org/stats');
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.filter((url) => url.includes('refresh') || url.includes('functions/v1'))).toEqual([]);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('DR-4: org_daily_stats を読まない。ブラウザ用 Supabase クライアントを使わない', async () => {
    await renderDashboard();

    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('DR-5: ダミーの部署ランキングも、集計のスコアカードも出ない', async () => {
    await renderDashboard();

    for (const gone of [
      'Department Ranking',
      'Sales Team',
      'Engineering',
      'HR & Admin',
      '活力スコア',
      '脳エネルギー',
      'リズムリスク',
      '活動率',
      '朝食摂取率',
      '深夜食率',
      'Why these metrics',
      'Last updated',
    ]) {
      expect(text(), `「${gone}」が残っている`).not.toContain(gone);
    }
  });

  it.each([
    ['権限が無い (HTTP 403)', () => jsonResponse({ error: { code: 'FORBIDDEN' } }, 403)],
    ['サーバーの失敗 (HTTP 500)', () => jsonResponse({ error: { code: 'INTERNAL_ERROR' } }, 500)],
    ['形式が違う応答 (member_count が無い)', () => jsonResponse({ stats: {} })],
  ])('DR-6: メンバー数が取れない (%s) ときも、案内は出る。数は「—」にして、失敗を短く伝える', async (_label, respond) => {
    fetchMock.mockImplementation(async () => respond());

    await renderDashboard();

    expect(text()).toContain(NOTICE);
    expect(text()).toContain('メンバー数を取得できませんでした');
    expect(text()).not.toMatch(/\d+\s*users/);
    expect(text()).toContain('—');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('DR-7: 通信自体が失敗しても、同じように案内と失敗の表示が出る', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await renderDashboard();

    expect(text()).toContain(NOTICE);
    expect(text()).toContain('メンバー数を取得できませんでした');
  });
});

describe('組織ダッシュボードのソース: 取り除いたものが残っていない (#1325 / #1120)', () => {
  const source = fs.readFileSync(PAGE_SOURCE_PATH, 'utf8');

  it.each([
    'org_daily_stats',
    'toOrgDailyStats',
    'OrgDailyStats',
    'handleRefresh',
    'Refresh Data',
    '/api/org/stats/refresh',
    'aggregate-org-stats',
    'createClient',
    'Sales Team',
    'Engineering',
    'HR & Admin',
    'Department Ranking',
    'ScoreCard',
  ])('DR-8: ソースに「%s」が無い', (banned) => {
    expect(source).not.toContain(banned);
  });

  it('DR-9: 案内の文言と、メンバー数の取得先 (GET /api/org/stats) がソースにある', () => {
    expect(source).toContain(NOTICE);
    expect(source).toContain('"/api/org/stats"');
  });
});
