/**
 * #1126 #1149 #1180: super_admin の画面で、まだ動いていない機能を「準備中」「未接続」と明示する
 *
 * 以前の画面は、動いていない機能を動いているように、あるいは問題が無いように見せていた。
 *   - データエクスポート: 依頼フォームがあり、受け付けるが、ファイルは作られない (一覧は本人の GDPR 削除要求の表を代用)
 *   - LLM 使用量: 「クォータ設定 →」のリンク先 (/super-admin/llm/quotas) は存在せず、プロバイダー別の詳細画面に
 *     解決されて「不明なプロバイダー」になる。クォータは AI の呼び出しにも適用されていない
 *   - インフラ監視: アラート・メトリクスを書き込む処理が無いのに、空の一覧で「✅ 未解決のアラートはありません」と出る。
 *     Sentry / Better Stack の「接続状態」は環境変数の有無だけで、実際にはつながっていない
 * ここでは、ページを実際に描画して、次を確かめる。
 *   - エクスポート: 「準備中（未対応）」だけが出る。依頼フォーム・ボタン・通信が無い
 *   - LLM 使用量: 「クォータ設定（準備中）」がリンクではなく文字で出る
 *   - インフラ監視: 空のとき「未接続: 監視データの収集は設定されていません」と Vercel / Supabase のダッシュボードへの
 *     リンクが出る。「問題なし」に見える表示と、Sentry / Better Stack の接続状態は出ない
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { default: ExportsPage } = await import('@/app/super-admin/exports/page');
const { default: NewExportPage } = await import('@/app/super-admin/exports/new/page');
const { default: LLMUsagePage } = await import('@/app/super-admin/llm/page');
const { default: InfraPage } = await import('@/app/super-admin/infra/page');
const { default: InfraMetricsPage } = await import('@/app/super-admin/infra/metrics/page');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOT_CONNECTED = '未接続: 監視データの収集は設定されていません';

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
/** URL の前方一致で返す応答 */
let responses: Array<[prefix: string, body: unknown]>;

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

beforeEach(() => {
  responses = [];
  fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    const hit = responses.find(([prefix]) => url.startsWith(prefix));
    return hit ? jsonResponse(hit[1]) : jsonResponse({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
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
  vi.unstubAllGlobals();
});

const text = () => container.textContent ?? '';

/** 描画して、非同期の読み込み (fetch → setState) が終わるまで流す */
async function render(element: React.ReactElement) {
  await act(async () => {
    root.render(element);
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('/super-admin/exports (データエクスポート)', () => {
  it('「準備中（未対応）」だけを出す。依頼のボタン・フォーム・リンクと、通信が無い', async () => {
    await render(<ExportsPage />);

    expect(text()).toContain('データエクスポート');
    expect(text()).toContain('準備中（未対応）');
    expect(container.querySelector('button, form, input, select, table')).toBeNull();
    // 依頼の画面への導線を出さない
    expect(container.querySelector('a[href="/super-admin/exports/new"]')).toBeNull();
    // 空の一覧やエクスポートの依頼を促す文言を出さない
    expect(text()).not.toContain('エクスポートリクエストがありません');
    expect(text()).not.toContain('エクスポートを開始する');
    expect(text()).not.toContain('新規エクスポート');
    // API を呼ばない (一覧は 501 になる)
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('/super-admin/exports/new (新規エクスポートリクエスト)', () => {
  it('依頼フォームを取り除き、「準備中（未対応）」を出す。通信が無い', async () => {
    await render(<NewExportPage />);

    expect(text()).toContain('新規エクスポートリクエスト');
    expect(text()).toContain('準備中（未対応）');
    expect(container.querySelector('form, input, select, textarea, button')).toBeNull();
    expect(text()).not.toContain('エクスポート開始');
    expect(text()).not.toContain('PII マスキング');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('一覧へ戻るリンクがある', async () => {
    await render(<NewExportPage />);

    expect(container.querySelector('a[href="/super-admin/exports"]')).not.toBeNull();
  });
});

describe('/super-admin/llm (LLM 使用量)', () => {
  const usage = {
    total_cost_usd: 1.5,
    total_cost_jpy: 225,
    total_requests: 30,
    total_tokens: 4500,
    by_model: [],
    by_function: [],
    top_users: [{ user_id: 'user-1', email: null, requests: 30, cost_usd: 1.5, is_anomaly: false }],
    timeseries: [],
    anomalies: [],
    period: { from: '2026-10-01', to: '2026-10-08' },
  };

  it('「クォータ設定（準備中）」を、リンクではなく文字で出す', async () => {
    responses.push(['/api/super-admin/llm/usage', { data: usage }]);

    await render(<LLMUsagePage />);

    expect(text()).toContain('ユーザー別使用量 Top 50');
    const label = Array.from(container.querySelectorAll('span')).find((el) => el.textContent === 'クォータ設定（準備中）');
    expect(label, '「クォータ設定（準備中）」が文字で出ていない').toBeDefined();
    expect(label!.closest('a')).toBeNull();
    // 存在しない画面 (プロバイダー別の詳細に解決されて「不明なプロバイダー」になる) へのリンクが無い
    expect(container.querySelector('a[href*="quotas"]')).toBeNull();
    expect(text()).not.toContain('クォータ設定 →');
  });

  it('クォータ管理があるように読める説明を出さない。プロバイダー別の画面へのリンクは残る', async () => {
    responses.push(['/api/super-admin/llm/usage', { data: usage }]);

    await render(<LLMUsagePage />);

    expect(text()).not.toContain('クォータ管理');
    expect(container.querySelector('a[href="/super-admin/llm/gemini"]')).not.toBeNull();
  });
});

describe('/super-admin/infra (インフラ監視)', () => {
  /** 監視データを書き込む処理は無いので、本番では常にこの形 (空) になる。external_sources は以前の応答に含まれていた */
  const emptyAlerts = {
    data: [],
    meta: { total: 0, page: 1, per_page: 50 },
    external_sources: [
      { source: 'sentry', available: true },
      { source: 'better_stack', available: true },
    ],
  };

  it('アラートが空のとき、「問題なし」ではなく「未接続」と、Vercel / Supabase のダッシュボードへのリンクを出す', async () => {
    responses.push(['/api/super-admin/infra/alerts', emptyAlerts]);

    await render(<InfraPage />);

    expect(text()).toContain(NOT_CONNECTED);
    const vercel = container.querySelector('a[href="https://vercel.com/dashboard"]');
    const supabase = container.querySelector('a[href="https://supabase.com/dashboard"]');
    expect(vercel?.textContent).toContain('Vercel');
    expect(supabase?.textContent).toContain('Supabase');
    for (const link of [vercel, supabase]) {
      expect(link?.getAttribute('target')).toBe('_blank');
      expect(link?.getAttribute('rel')).toContain('noopener');
    }
    // 空を「問題なし」に見せる表示が無い
    expect(text()).not.toContain('未解決のアラートはありません');
    expect(text()).not.toContain('アラートがありません');
    expect(text()).not.toContain('✅');
    expect(container.querySelector('table')).toBeNull();
  });

  it('「すべて」「解決済み」の表示でも、空なら「未接続」', async () => {
    responses.push(['/api/super-admin/infra/alerts', emptyAlerts]);
    await render(<InfraPage />);

    const buttons = Array.from(container.querySelectorAll('button'));
    await act(async () => {
      buttons.find((b) => b.textContent === 'すべて')!.click();
    });
    await render(<InfraPage />);

    expect(text()).toContain(NOT_CONNECTED);
    expect(text()).not.toContain('アラートがありません');
  });

  it('Sentry / Better Stack の接続状態を出さない (API が返してきても描画しない。未設定でも「未設定」と出さない)', async () => {
    responses.push(['/api/super-admin/infra/alerts', emptyAlerts]);

    await render(<InfraPage />);

    expect(text()).not.toContain('Sentry');
    expect(text()).not.toContain('Better Stack');
    expect(text()).not.toContain('未設定');
  });

  it('「未解決」のボタンに件数 (0) を付けない (0 件が問題なしに見えるのを避ける)', async () => {
    responses.push(['/api/super-admin/infra/alerts', emptyAlerts]);

    await render(<InfraPage />);

    const open = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.startsWith('未解決'));
    expect(open?.textContent).toBe('未解決');
  });

  it('アラートがあるときは一覧を出し、「未接続」の案内は出さない', async () => {
    responses.push([
      '/api/super-admin/infra/alerts',
      {
        data: [
          {
            id: 'alert-1',
            metric_name: 'vercel_error_rate',
            threshold: 5,
            comparison: '>',
            triggered_at: '2026-10-08T00:00:00Z',
            resolved_at: null,
            details: null,
            ack_by: null,
            ack_at: null,
          },
        ],
        meta: { total: 1, page: 1, per_page: 50 },
      },
    ]);

    await render(<InfraPage />);

    expect(text()).toContain('vercel_error_rate');
    expect(text()).not.toContain(NOT_CONNECTED);
  });

  it('取得に失敗したときは、未接続ではなくエラーを出す', async () => {
    // 応答を登録しない (fetch は 404 のエラー本文を返す)
    await render(<InfraPage />);

    expect(text()).toContain('not found');
    expect(text()).not.toContain(NOT_CONNECTED);
  });
});

describe('/super-admin/infra/metrics (インフラメトリクス)', () => {
  it('メトリクスが空のとき、「未接続」と Vercel / Supabase のダッシュボードへのリンクを出す', async () => {
    responses.push(['/api/super-admin/infra/metrics', { data: [], meta: { count: 0 } }]);

    await render(<InfraMetricsPage />);

    expect(text()).toContain(NOT_CONNECTED);
    expect(container.querySelector('a[href="https://vercel.com/dashboard"]')).not.toBeNull();
    expect(container.querySelector('a[href="https://supabase.com/dashboard"]')).not.toBeNull();
    // 以前の案内 (書き込みは cron が担当する) と、空の表示を出さない
    expect(text()).not.toContain('operator-F');
    expect(text()).not.toContain('メトリクスデータがありません');
  });

  it('メトリクスがあるときは一覧を出し、「未接続」の案内は出さない', async () => {
    responses.push([
      '/api/super-admin/infra/metrics',
      {
        data: [
          {
            id: 'metric-1',
            metric_name: 'p95_ms',
            source: 'vercel',
            value: 320,
            unit: 'ms',
            tags: {},
            recorded_at: '2026-10-08T00:00:00Z',
          },
        ],
        meta: { count: 1 },
      },
    ]);

    await render(<InfraMetricsPage />);

    expect(text()).toContain('p95_ms');
    expect(text()).not.toContain(NOT_CONNECTED);
  });
});
