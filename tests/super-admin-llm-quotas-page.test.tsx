/**
 * #1149 (T40): 運営画面の AI の利用上限 (/super-admin/llm/quotas) を描画して、保存の操作を確かめる
 *
 *   - 一覧 (GET /api/super-admin/llm/quotas) の行ごとに、いまの上限 (自分の行が無いプランは「free の値」) を出す
 *   - 新しい上限と理由を入れて「保存」を押すと、PATCH に { plan_key, daily_limit, reason } を送り、一覧を読み直す
 *   - 空欄で保存すると無制限 (daily_limit: null)
 *   - 0 以上の整数でない・上限を超える・理由が空のときは送らずに、行に案内を出す
 *   - 保存に失敗したら、API の文 (error.message) を行に出す
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_DAILY_LIMIT_MAX, LLM_QUOTAS_ENFORCED_NOTE } from '@/lib/super-admin/llm-schemas';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { default: LLMQuotasPage } = await import('@/app/super-admin/llm/quotas/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let patchStatus = 200;

const LIST = {
  data: [
    { plan_key: 'free', display_name: 'Free', plan_type: 'personal', daily_limit: 10, configured: true, effective_daily_limit: 10, updated_at: '2026-10-11T00:00:00Z' },
    { plan_key: 'pro', display_name: 'Pro', plan_type: 'personal', daily_limit: null, configured: false, effective_daily_limit: 10, updated_at: null },
    { plan_key: 'org_enterprise', display_name: 'Org Enterprise', plan_type: 'org', daily_limit: null, configured: true, effective_daily_limit: null, updated_at: '2026-10-11T00:00:00Z' },
  ],
  default_plan_key: 'free',
  enforced: true,
  note: LLM_QUOTAS_ENFORCED_NOTE,
};

beforeEach(() => {
  patchStatus = 200;
  fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      return patchStatus === 200
        ? { ok: true, status: 200, json: async () => ({ data: { plan_key: 'pro', daily_limit: 20 } }) }
        : { ok: false, status: patchStatus, json: async () => ({ error: { code: 'PLAN_NOT_FOUND', message: '指定したプランはありません' } }) };
    }
    return { ok: true, status: 200, json: async () => LIST };
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

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render() {
  await act(async () => {
    root.render(<LLMQuotasPage />);
  });
  await flush();
}

const row = (planKey: string) => container.querySelector(`[data-testid="quota-row-${planKey}"]`) as HTMLElement;

/** React の制御された input に値を入れる */
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function save(planKey: string, limit: string, reason: string) {
  const [limitInput, reasonInput] = Array.from(row(planKey).querySelectorAll('input'));
  await type(limitInput, limit);
  await type(reasonInput, reason);
  await act(async () => {
    (row(planKey).querySelector('button') as HTMLButtonElement).click();
  });
  await flush();
}

const patchBodies = () =>
  fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH').map(([, init]) => JSON.parse(String((init as RequestInit).body)));

describe('/super-admin/llm/quotas (AI の利用上限)', () => {
  it('一覧を出す: 行ごとのいまの上限。自分の行が無いプランは free の値と分かる。無制限は「無制限」', async () => {
    await render();

    expect(fetchMock).toHaveBeenCalledWith('/api/super-admin/llm/quotas');
    expect(container.textContent).toContain(LLM_QUOTAS_ENFORCED_NOTE);
    expect(row('free').textContent).toContain('10 回');
    expect(row('pro').textContent).toContain('10 回');
    expect(row('pro').textContent).toContain('free の値');
    expect(row('free').textContent).not.toContain('free の値');
    expect(row('org_enterprise').textContent).toContain('無制限');
  });

  it('保存: PATCH に plan_key・daily_limit・理由を送り、一覧を読み直す', async () => {
    await render();
    await save('pro', '20', '有料の検証');

    expect(patchBodies()).toEqual([{ plan_key: 'pro', daily_limit: 20, reason: '有料の検証' }]);
    // 保存のあとに一覧を読み直す (初回 + 保存後)
    expect(fetchMock.mock.calls.filter(([, init]) => !(init as RequestInit | undefined)?.method).length).toBe(2);
    expect(row('pro').textContent).toContain('保存しました（20 回）');
  });

  it('空欄で保存すると無制限 (daily_limit: null) を送る', async () => {
    await render();
    await save('free', '', '一時的に外す');

    expect(patchBodies()).toEqual([{ plan_key: 'free', daily_limit: null, reason: '一時的に外す' }]);
  });

  it.each([
    ['数字でない', 'abc'],
    ['負の数', '-1'],
    ['小数', '1.5'],
    ['上限を超える', String(AI_DAILY_LIMIT_MAX + 1)],
  ])('上限の入力が正しくない (%s) ときは送らずに、行に案内を出す', async (_label, value) => {
    await render();
    await save('free', value, '理由');

    expect(patchBodies()).toEqual([]);
    expect(row('free').textContent).toContain('の整数で入力してください');
  });

  it('理由が空のときは送らずに、行に案内を出す', async () => {
    await render();
    await save('free', '5', '   ');

    expect(patchBodies()).toEqual([]);
    expect(row('free').textContent).toContain('変更の理由を入力してください');
  });

  it('保存に失敗したら、API の文を行に出す', async () => {
    patchStatus = 404;
    await render();
    await save('pro', '20', '理由');

    expect(row('pro').textContent).toContain('指定したプランはありません');
  });
});
