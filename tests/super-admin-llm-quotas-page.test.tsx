/**
 * #1149 (T40): 運営画面の AI の利用上限 (/super-admin/llm/quotas) を描画して、保存の操作を確かめる
 *
 *   - 一覧 (GET /api/super-admin/llm/quotas) の行ごとに、いまの上限 (自分の行が無いプランは「free の値」) を出す
 *   - 新しい上限と理由を入れて「保存」を押すと、PATCH に { plan_key, daily_limit, reason } を送り、一覧を読み直す
 *   - 空欄で保存すると無制限 (daily_limit: null)
 *   - 0 以上の整数でない・上限を超える・理由が空のときは送らずに、行に案内を出す
 *   - 保存に失敗したら、API の文 (error.message) を行に出す
 *   - #1912: 組織のプランの値の行 (plan_source: 'org_plan') は表示名「<値>（組織のプラン）」で出て、保存できる。
 *     どちらにも無いキーの行 (plan_source: 'unknown') は、入力欄と保存のボタンを止めて案内を出す (PATCH が 404 で断るため)
 *   - #1912: subscription_plans の組織のプランの行 (plan_type: 'org' の org_*) も、入力欄と保存のボタンを止め、
 *     「組織の上限は standard / premium / enterprise の行で決まります」と案内する (PATCH が 409 PLAN_READ_ONLY で断るため)
 *   - #1917: 保存が 409 CONFLICT_STALE_DATA (別の運営が先に同じプランの上限を変えた) で断られたら、一覧を読み直していまの上限を出し、
 *     行に画面の文を出す。書きかけの行 (新しい上限・理由) は残し、書きかけの無い行は読み直した値にする。409 PLAN_READ_ONLY は読み直さない
 *   - #1917: 表を出したあとの読み直し (保存のあと・409 のあと) は表を外さずに行い (入力欄の要素もフォーカスも入れ替えない)、
 *     失敗しても表と書きかけを残して、表の上に文と「再試行」を出す。409 のあとの読み直しに失敗したら行の文も「読み込み直せなかった」にし、
 *     どの経路の読み直し (「再試行」・ほかの行の保存のあとの読み直し) でも、読み直せたら「読み込み直した」文に変える。
 *     409 の文の出ている行 (「入力した値と理由は残しています」と伝えている行) の書きかけは、ほかの行の保存のあとの読み直しでも消さない
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_DAILY_LIMIT_MAX, LLM_QUOTAS_ENFORCED_NOTE } from '@/lib/super-admin/llm-schemas';
import { AI_DAILY_LIMIT_READ_ONLY_NOTES } from '@/lib/super-admin/ai-daily-limits';

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
    { plan_key: 'free', plan_source: 'subscription_plan', display_name: 'Free', plan_type: 'personal', daily_limit: 10, configured: true, effective_daily_limit: 10, updated_at: '2026-10-11T00:00:00Z' },
    { plan_key: 'pro', plan_source: 'subscription_plan', display_name: 'Pro', plan_type: 'personal', daily_limit: null, configured: false, effective_daily_limit: 10, updated_at: null },
    { plan_key: 'org_enterprise', plan_source: 'subscription_plan', display_name: 'Org Enterprise', plan_type: 'org', daily_limit: null, configured: true, effective_daily_limit: null, updated_at: '2026-10-11T00:00:00Z' },
    { plan_key: 'premium', plan_source: 'org_plan', display_name: 'premium（組織のプラン）', plan_type: null, daily_limit: 10, configured: true, effective_daily_limit: 10, updated_at: '2026-10-21T00:00:00Z' },
    { plan_key: 'legacy_plan', plan_source: 'unknown', display_name: null, plan_type: null, daily_limit: 3, configured: true, effective_daily_limit: 3, updated_at: '2026-10-11T00:00:00Z' },
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

  it('#1912: 組織のプランの値の行は「<値>（組織のプラン）」と key を出し、保存すると PATCH にその値を送る', async () => {
    await render();
    expect(row('premium').textContent).toContain('premium（組織のプラン）');
    expect(row('premium').querySelector('.font-mono')?.textContent).toBe('premium');
    expect(row('premium').querySelector('[data-testid="quota-not-editable-premium"]')).toBeNull();

    await save('premium', '30', '組織の上限を上げる');

    expect(patchBodies()).toEqual([{ plan_key: 'premium', daily_limit: 30, reason: '組織の上限を上げる' }]);
  });

  it('#1912: どちらにも無いキーの行は、入力欄と保存のボタンを止めて案内を出す (押しても送らない)', async () => {
    await render();
    const inputs = Array.from(row('legacy_plan').querySelectorAll('input'));
    const button = row('legacy_plan').querySelector('button') as HTMLButtonElement;

    expect(inputs.map((input) => input.disabled)).toEqual([true, true]);
    expect(button.disabled).toBe(true);
    expect(row('legacy_plan').querySelector('[data-testid="quota-not-editable-legacy_plan"]')?.textContent).toContain('保存できません');
    // 保存できる行は止めない
    expect((row('pro').querySelector('button') as HTMLButtonElement).disabled).toBe(false);
    expect(Array.from(row('pro').querySelectorAll('input')).map((input) => input.disabled)).toEqual([false, false]);

    await save('legacy_plan', '5', '理由');
    expect(patchBodies()).toEqual([]);
  });

  it('#1912: subscription_plans の組織のプランの行 (org_*) は読み取りだけ: 入力欄と保存を止め、組織の上限の行を案内する (押しても送らない)', async () => {
    await render();
    const inputs = Array.from(row('org_enterprise').querySelectorAll('input'));
    const button = row('org_enterprise').querySelector('button') as HTMLButtonElement;

    expect(inputs.map((input) => input.disabled)).toEqual([true, true]);
    expect(button.disabled).toBe(true);
    const note = row('org_enterprise').querySelector('[data-testid="quota-not-editable-org_enterprise"]')?.textContent;
    expect(note).toBe(AI_DAILY_LIMIT_READ_ONLY_NOTES.org_subscription_plan);
    expect(note).toContain('組織の上限は standard / premium / enterprise の行で決まります');
    // いまの上限は読めるまま出す
    expect(row('org_enterprise').textContent).toContain('無制限');
    // 組織のプランの値の行と個人のプランの行は止めない・案内も出さない
    for (const planKey of ['premium', 'pro']) {
      expect((row(planKey).querySelector('button') as HTMLButtonElement).disabled).toBe(false);
      expect(Array.from(row(planKey).querySelectorAll('input')).map((input) => input.disabled)).toEqual([false, false]);
      expect(row(planKey).querySelector(`[data-testid="quota-not-editable-${planKey}"]`)).toBeNull();
    }

    await save('org_enterprise', '5', '理由');
    expect(patchBodies()).toEqual([]);
  });

  it('#1912: どちらにも無いキーの行の案内と、org_* の行の案内は別の文', async () => {
    await render();
    expect(row('legacy_plan').querySelector('[data-testid="quota-not-editable-legacy_plan"]')?.textContent).toBe(
      AI_DAILY_LIMIT_READ_ONLY_NOTES.unknown_key,
    );
    expect(AI_DAILY_LIMIT_READ_ONLY_NOTES.unknown_key).not.toBe(AI_DAILY_LIMIT_READ_ONLY_NOTES.org_subscription_plan);
  });

  it('#1917: 初めの読み込みに失敗したら、エラーと「再試行」を出す。「再試行」で読めたら表を出す', async () => {
    let gets = 0;
    fetchMock.mockImplementation(async () => {
      gets += 1;
      return gets === 1
        ? { ok: false, status: 500, json: async () => ({ error: { code: 'INTERNAL_ERROR', message: '上限を取得できませんでした' } }) }
        : { ok: true, status: 200, json: async () => LIST };
    });
    await render();
    expect(row('pro')).toBeNull();
    const alert = container.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('上限を取得できませんでした');

    await act(async () => {
      (alert.querySelector('button') as HTMLButtonElement).click();
    });
    await flush();
    expect(gets).toBe(2);
    expect(row('pro')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('#1917: 保存のあとの読み直しに失敗しても、表とほかの行の書きかけを残し、表の上に文と「再試行」を出す', async () => {
    let gets = 0;
    fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'PATCH') return { ok: true, status: 200, json: async () => ({ data: { plan_key: 'pro', daily_limit: 20 } }) };
      gets += 1;
      return gets === 2
        ? { ok: false, status: 500, json: async () => ({ error: { code: 'INTERNAL_ERROR', message: '上限を取得できませんでした' } }) }
        : { ok: true, status: 200, json: async () => LIST };
    });
    await render();
    const premiumReason = Array.from(row('premium').querySelectorAll('input'))[1] as HTMLInputElement;
    await type(premiumReason, '書きかけの理由');
    await save('pro', '20', '理由');

    expect(row('pro').textContent).toContain('保存しました（20 回）');
    expect(row('free')).not.toBeNull();
    expect((Array.from(row('premium').querySelectorAll('input'))[1] as HTMLInputElement).value).toBe('書きかけの理由');
    const reloadError = container.querySelector('[data-testid="quota-reload-error"]') as HTMLElement;
    expect(reloadError.textContent).toContain('最新の上限を読み込めませんでした');

    await act(async () => {
      (reloadError.querySelector('button') as HTMLButtonElement).click();
    });
    await flush();
    expect(gets).toBe(3);
    expect(container.querySelector('[data-testid="quota-reload-error"]')).toBeNull();
  });

  it('保存に失敗したら、API の文を行に出す', async () => {
    patchStatus = 404;
    await render();
    await save('pro', '20', '理由');

    expect(row('pro').textContent).toContain('指定したプランはありません');
  });

  describe('保存が 409 CONFLICT_STALE_DATA で断られたとき (#1917)', () => {
    const SERVER_STALE_MESSAGE = '別の運営が先にこのプランの上限を変えました。画面を読み込み直して、もう一度確認してください';
    type ListRow = (typeof LIST.data)[number];
    const listWith = (overrides: Record<string, Partial<ListRow>>) => ({
      ...LIST,
      data: LIST.data.map((r) => ({ ...r, ...(overrides[r.plan_key] ?? {}) })),
    });
    const getCalls = () => fetchMock.mock.calls.filter(([, init]) => !(init as RequestInit | undefined)?.method).length;
    const inputsOf = (planKey: string) => Array.from(row(planKey).querySelectorAll('input')) as HTMLInputElement[];

    /** PATCH が 1 回目は 409 (code は引数) を返し、その時点で別の運営の変更 (pro = 50 回・free = 7 回) が入ったことにする */
    function mockStale(code: string, message: string) {
      let changed = false;
      let patches = 0;
      fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          patches += 1;
          if (patches > 1) return { ok: true, status: 200, json: async () => ({ data: { plan_key: 'pro', daily_limit: 20 } }) };
          if (code === 'CONFLICT_STALE_DATA') changed = true;
          return { ok: false, status: 409, json: async () => ({ error: { code, message } }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () =>
            changed
              ? listWith({
                  pro: { daily_limit: 50, configured: true, effective_daily_limit: 50 },
                  free: { daily_limit: 7, effective_daily_limit: 7 },
                })
              : LIST,
        };
      });
    }

    it('一覧を読み直していまの上限を出し、行に画面の文を出す (サーバーの「読み込み直して」は出さない)', async () => {
      mockStale('CONFLICT_STALE_DATA', SERVER_STALE_MESSAGE);
      await render();
      await save('pro', '20', '有料の検証');

      expect(patchBodies()).toEqual([{ plan_key: 'pro', daily_limit: 20, reason: '有料の検証' }]);
      expect(getCalls()).toBe(2); // 初回 + 読み直し
      expect(row('pro').textContent).toContain('50 回');
      expect(row('pro').textContent).not.toContain('free の値');
      expect(row('pro').textContent).toContain('別の運営が先にこのプランの上限を変えていました');
      expect(row('pro').textContent).toContain('一覧を読み込み直した');
      expect(row('pro').textContent).not.toContain('画面を読み込み直して');
      expect(row('pro').textContent).not.toContain('保存しました');
      // 保存のボタンは押せる状態に戻る
      expect((row('pro').querySelector('button') as HTMLButtonElement).disabled).toBe(false);
    });

    it('書きかけの行 (新しい上限・理由) は読み直しで消さず、書きかけの無い行は読み直した値にする。もう一度保存すると書きかけの値を送る', async () => {
      mockStale('CONFLICT_STALE_DATA', SERVER_STALE_MESSAGE);
      await render();
      await type(inputsOf('premium')[1], '書きかけの理由');
      await save('pro', '20', '有料の検証');

      expect(inputsOf('pro').map((input) => input.value)).toEqual(['20', '有料の検証']);
      expect(inputsOf('premium').map((input) => input.value)).toEqual(['10', '書きかけの理由']);
      // free は書きかけが無いので、読み直した値 (7) にする
      expect(inputsOf('free').map((input) => input.value)).toEqual(['7', '']);

      await act(async () => {
        (row('pro').querySelector('button') as HTMLButtonElement).click();
      });
      await flush();
      expect(patchBodies()).toEqual([
        { plan_key: 'pro', daily_limit: 20, reason: '有料の検証' },
        { plan_key: 'pro', daily_limit: 20, reason: '有料の検証' },
      ]);
      expect(row('pro').textContent).toContain('保存しました（20 回）');
    });

    /**
     * PATCH は 1 回目が 409 CONFLICT_STALE_DATA。その時点で別の運営の変更 (pro = 50 回) が入る。
     * GET は failGets 回目 (1 始まり) の呼び出しを 500 で失敗させる
     */
    function mockStaleWithFailingReload(failGets: number[]) {
      let changed = false;
      let patches = 0;
      let gets = 0;
      fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          patches += 1;
          if (patches > 1) return { ok: true, status: 200, json: async () => ({ data: { plan_key: 'pro', daily_limit: 20 } }) };
          changed = true;
          return { ok: false, status: 409, json: async () => ({ error: { code: 'CONFLICT_STALE_DATA', message: SERVER_STALE_MESSAGE } }) };
        }
        gets += 1;
        if (failGets.includes(gets)) {
          return { ok: false, status: 500, json: async () => ({ error: { code: 'INTERNAL_ERROR', message: '上限を取得できませんでした' } }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => (changed ? listWith({ pro: { daily_limit: 50, configured: true, effective_daily_limit: 50 } }) : LIST),
        };
      });
    }

    const reloadError = () => container.querySelector('[data-testid="quota-reload-error"]');

    it('読み直しに失敗しても表と書きかけを残し、表の上に文と「再試行」を出す。行の文は「読み込み直せなかった」にする', async () => {
      mockStaleWithFailingReload([2]);
      await render();
      await type(inputsOf('premium')[1], '書きかけの理由');
      await save('pro', '20', '有料の検証');

      expect(getCalls()).toBe(2);
      // 表は残る (エラーに置き換えない)
      expect(row('pro')).not.toBeNull();
      expect(row('free')).not.toBeNull();
      expect(inputsOf('pro').map((input) => input.value)).toEqual(['20', '有料の検証']);
      expect(inputsOf('premium').map((input) => input.value)).toEqual(['10', '書きかけの理由']);
      // 表の上に文と「再試行」
      expect(reloadError()?.textContent).toContain('最新の上限を読み込めませんでした');
      expect(reloadError()?.textContent).toContain('上限を取得できませんでした');
      expect(reloadError()?.querySelector('button')?.textContent).toBe('再試行');
      // 行の文は、読み直せていないので「読み込み直した」とは言わない
      expect(row('pro').textContent).toContain('別の運営が先にこのプランの上限を変えていました');
      expect(row('pro').textContent).toContain('読み込み直せなかった');
      expect(row('pro').textContent).not.toContain('一覧を読み込み直したので');
      // 表の値は 409 の前のまま (読み直せていない)
      expect(row('pro').textContent).toContain('free の値');
    });

    it('「再試行」で読み直せたら、いまの上限を出し、表の上の文を消して、行の文を「読み込み直した」文にする。書きかけは残す', async () => {
      mockStaleWithFailingReload([2]);
      await render();
      await type(inputsOf('premium')[1], '書きかけの理由');
      await save('pro', '20', '有料の検証');
      expect(reloadError()).not.toBeNull();

      await act(async () => {
        (reloadError()!.querySelector('button') as HTMLButtonElement).click();
      });
      await flush();

      expect(getCalls()).toBe(3);
      expect(reloadError()).toBeNull();
      expect(row('pro').textContent).toContain('50 回');
      expect(row('pro').textContent).toContain('一覧を読み込み直した');
      expect(row('pro').textContent).not.toContain('読み込み直せなかった');
      expect(inputsOf('pro').map((input) => input.value)).toEqual(['20', '有料の検証']);
      expect(inputsOf('premium').map((input) => input.value)).toEqual(['10', '書きかけの理由']);
    });

    it('「再試行」でなく、ほかの行の保存のあとの読み直しで読み直せたときも、行の文を「読み込み直した」文にする。409 の行の書きかけは残す', async () => {
      // GET: 1 = 初回・2 = 409 のあとの読み直し (失敗)・3 = premium の保存のあとの読み直し (成功)
      mockStaleWithFailingReload([2]);
      await render();
      await save('pro', '20', '有料の検証');
      expect(row('pro').textContent).toContain('読み込み直せなかった');
      expect(reloadError()).not.toBeNull();

      await save('premium', '12', '組織の理由');

      expect(getCalls()).toBe(3);
      expect(row('premium').textContent).toContain('保存しました（12 回）');
      // 表の上の文と「再試行」は消える。pro の行の文も、もう「読み込み直せなかった」「再試行」とは言わない
      expect(reloadError()).toBeNull();
      expect(row('pro').textContent).toContain('50 回');
      expect(row('pro').textContent).toContain('一覧を読み込み直したので');
      expect(row('pro').textContent).not.toContain('読み込み直せなかった');
      expect(row('pro').textContent).not.toContain('「再試行」');
      // 文が「入力した値と理由は残しています」と伝えているので、pro の書きかけは残す。保存した premium は読み直した値にする
      expect(row('pro').textContent).toContain('入力した値と理由は残しています');
      expect(inputsOf('pro').map((input) => input.value)).toEqual(['20', '有料の検証']);
      expect(inputsOf('premium').map((input) => input.value)).toEqual(['10', '']);
    });

    it('409 のあとに読み直せた行の書きかけは、ほかの行の保存のあとの読み直しでも消さない (文の「残しています」のとおり)', async () => {
      mockStaleWithFailingReload([]);
      await render();
      await type(inputsOf('free')[1], '書きかけの理由');
      await save('pro', '20', '有料の検証');
      expect(row('pro').textContent).toContain('一覧を読み込み直したので');

      await save('premium', '12', '組織の理由');

      expect(getCalls()).toBe(3);
      expect(row('pro').textContent).toContain('一覧を読み込み直したので');
      expect(row('pro').textContent).toContain('入力した値と理由は残しています');
      expect(inputsOf('pro').map((input) => input.value)).toEqual(['20', '有料の検証']);
      // 409 の文の無い行は、これまでどおり保存のあとの読み直しで読んだ値にする
      expect(inputsOf('free').map((input) => input.value)).toEqual(['10', '']);
      expect(inputsOf('premium').map((input) => input.value)).toEqual(['10', '']);

      // 409 の行をもう一度保存して通れば、その行も読んだ値に戻す (もう残すと伝えていない)
      await act(async () => {
        (row('pro').querySelector('button') as HTMLButtonElement).click();
      });
      await flush();
      expect(row('pro').textContent).toContain('保存しました（20 回）');
      expect(inputsOf('pro').map((input) => input.value)).toEqual(['50', '']);
    });

    it('409 のあとに読み直せた行の文は、そのあとのほかの行の保存のあとの読み直しに失敗しても「読み込み直せなかった」にしない', async () => {
      // GET: 1 = 初回・2 = 409 のあとの読み直し (成功)・3 = premium の保存のあとの読み直し (失敗)
      mockStaleWithFailingReload([3]);
      await render();
      await save('pro', '20', '有料の検証');
      expect(row('pro').textContent).toContain('一覧を読み込み直したので');

      await save('premium', '12', '組織の理由');

      expect(getCalls()).toBe(3);
      expect(reloadError()?.textContent).toContain('最新の上限を読み込めませんでした');
      expect(row('pro').textContent).toContain('一覧を読み込み直したので');
      expect(row('pro').textContent).not.toContain('読み込み直せなかった');
    });

    it('読み直しの最中も表 (入力欄の要素) を外さず、保存のボタンは止める', async () => {
      let releaseReload!: () => void;
      const reloadGate = new Promise<void>((resolve) => {
        releaseReload = resolve;
      });
      let gets = 0;
      fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          return { ok: false, status: 409, json: async () => ({ error: { code: 'CONFLICT_STALE_DATA', message: SERVER_STALE_MESSAGE } }) };
        }
        gets += 1;
        if (gets > 1) await reloadGate;
        return { ok: true, status: 200, json: async () => LIST };
      });
      await render();
      const proLimitInput = inputsOf('pro')[0];
      await type(proLimitInput, '20');
      await type(inputsOf('pro')[1], '理由');
      await act(async () => {
        (row('pro').querySelector('button') as HTMLButtonElement).click();
      });
      await flush();

      // 読み直しの応答待ち: 表はそのまま (同じ入力欄の要素)。保存のボタンは押せない。行の文は「読み込み直している」
      // (結果が出る前に「読み込み直した」とも「読み込み直せなかった」とも言わない)
      expect(gets).toBe(2);
      expect(row('pro').textContent).toContain('一覧を読み込み直しています');
      expect(row('pro').textContent).not.toContain('一覧を読み込み直したので');
      expect(row('pro').textContent).not.toContain('読み込み直せなかった');
      expect(inputsOf('pro')[0]).toBe(proLimitInput);
      expect(container.querySelector('.animate-spin')).toBeNull();
      expect((row('free').querySelector('button') as HTMLButtonElement).disabled).toBe(true);

      await act(async () => {
        releaseReload();
      });
      await flush();
      expect(inputsOf('pro')[0]).toBe(proLimitInput);
      expect((row('free').querySelector('button') as HTMLButtonElement).disabled).toBe(false);
      expect(row('pro').textContent).toContain('一覧を読み込み直したので');
    });

    it('同じ 409 でも PLAN_READ_ONLY は読み直さず、API の文を出す', async () => {
      mockStale('PLAN_READ_ONLY', '組織の上限は standard / premium / enterprise の行で決まります');
      await render();
      await save('pro', '20', '理由');

      expect(getCalls()).toBe(1);
      expect(row('pro').textContent).toContain('組織の上限は standard / premium / enterprise の行で決まります');
      expect(row('pro').textContent).not.toContain('別の運営が先に');
      expect(inputsOf('pro').map((input) => input.value)).toEqual(['20', '理由']);
    });
  });
});
