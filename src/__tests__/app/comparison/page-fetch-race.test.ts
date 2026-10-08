// src/__tests__/app/comparison/page-fetch-race.test.ts
// #1228 回帰防止: 比較ページで期間 (週間 / 月間) を切り替えたとき、先に発行した古い fetch の
// 応答が後から届いて、新しい期間の表示を上書きしてしまう競合を検証する。
//
// 旧実装は useEffect 内の fetch に signal も世代管理も無く、完了時に無条件で
// setData(result) / setLoading(false) していたため、次の不整合が起きていた。
//   1. 「月間」タブなのに、遅れて届いた週間データが表示される
//   2. 古い応答の finally で setLoading(false) され、新しい取得の途中なのにスピナーが消える
//   3. 取得失敗時に直前の期間のデータが残り、別期間の内容が現在のタブの下に表示される
//
// このテストは comparison/page.tsx を実際に DOM へ描画し、fetch を手動で解決できる
// モックに差し替えて「応答が届く順番」を意図的に入れ替えることで検証する。
//
// NOTE: このリポジトリの vitest 設定は tsconfig の jsx:"preserve" と非互換のため、
// 既存の FavoriteRecipeModal.test.ts に倣い、拡張子 .ts + React.createElement で JSX 構文を回避する。

import React, { act } from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import ComparisonPage from '@/app/(main)/comparison/page';
import type { ComparisonResponse } from '@/types/comparison';

const h = React.createElement;

const WEEKLY_URL = '/api/comparison/rankings?periodType=weekly';
const MONTHLY_URL = '/api/comparison/rankings?periodType=monthly';
const LOADING_TEXT = '読み込み中...';
const ERROR_TEXT = 'データの取得に失敗しました';

let container: HTMLDivElement;
let root: Root;

// fetch のモック。呼び出しごとに 1 件の「未解決リクエスト」を記録し、テスト側が任意の順番で応答を返せる。
type PendingRequest = {
  url: string;
  signal: AbortSignal | null | undefined;
  /** 200 OK + JSON で応答する */
  respond: (body: ComparisonResponse) => void;
  /** HTTP エラー (res.ok=false) で応答する */
  respondWithStatus: (status: number) => void;
  /** ネットワークエラー等で reject する */
  reject: (reason: unknown) => void;
};

/**
 * @param honorAbort true: 本物の fetch と同様に、signal が abort されたら AbortError で reject する。
 *                   false: signal を無視して後から解決する fetch (古い応答が後勝ちする最悪ケース)。
 */
function installFetchMock({ honorAbort }: { honorAbort: boolean }) {
  const requests: PendingRequest[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (honorAbort && signal) {
        const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      requests.push({
        url: String(input),
        signal,
        respond: (body) => resolve({ ok: true, status: 200, json: async () => body } as Response),
        respondWithStatus: (status) => resolve({ ok: false, status, json: async () => ({}) } as Response),
        reject,
      });
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, requests };
}

// どのリクエストの応答かが判別できる内容を作る (ハイライトの文言 `${marker}のハイライト` で見分ける)。
// marker 同士は部分文字列として重ならないようにすること (toContain / not.toContain で判定するため)。
function comparison(marker: string): ComparisonResponse {
  return {
    rankings: [],
    highlights: [{ type: 'top_prize', message: `${marker}のハイライト`, metric: 'record_streak', icon: '🏆' }],
    userMetrics: [],
    periodType: 'weekly',
    periodStart: '2026-07-01',
    periodEnd: '2026-07-31',
  };
}

// microtask だけでなく macrotask を 1 周させ、fetch → res.json() → setState の連鎖を最後まで進める。
async function settle(action?: () => void) {
  await act(async () => {
    action?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPage() {
  await settle(() => {
    root.render(h(ComparisonPage));
  });
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
  if (!button) throw new Error(`「${label}」ボタンが見つかりません`);
  return button;
}

async function clickPeriod(label: '週間' | '月間') {
  await settle(() => {
    findButton(label).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

// ページ自身が console.error(e) で記録したエラー (第 1 引数が文字列ではない呼び出し)。
// React 自身の警告は第 1 引数が文字列なので除外される。
function pageLoggedErrors(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter(([first]) => typeof first !== 'string');
}

// act() で更新を包むテスト環境であることを React に伝える (未設定だと act の警告が大量に出る)
const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

beforeAll(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete actEnv.IS_REACT_ACT_ENVIRONMENT;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ComparisonPage: 期間切替時に古い fetch 応答が新しい表示を上書きしない (#1228)', () => {
  it('初回は週間を取得し、「月間」を押すと月間を取得する', async () => {
    const { requests } = installFetchMock({ honorAbort: false });
    await renderPage();
    expect(requests.map((r) => r.url)).toEqual([WEEKLY_URL]);
    expect(container.textContent).toContain(LOADING_TEXT);

    await clickPeriod('月間');
    expect(requests.map((r) => r.url)).toEqual([WEEKLY_URL, MONTHLY_URL]);
  });

  it('週間→月間に切り替えた後、週間の応答が遅れて届いても月間の表示を上書きしない（バグの中心）', async () => {
    const { requests } = installFetchMock({ honorAbort: false });
    await renderPage();
    await clickPeriod('月間');

    // 新しい要求 (月間) が先に応答する
    await settle(() => requests[1].respond(comparison('月間')));
    expect(container.textContent).toContain('月間のハイライト');
    expect(container.textContent).not.toContain(LOADING_TEXT);

    // 古い要求 (週間) が遅れて応答する。旧実装はここで setData(週間) が後勝ちし、
    // 「月間」タブのまま週間の内容が表示されていた
    await settle(() => requests[0].respond(comparison('週間')));
    expect(container.textContent).toContain('月間のハイライト');
    expect(container.textContent).not.toContain('週間のハイライト');
  });

  it('古い応答が先に完了しても、新しい取得が終わるまでスピナーを出し続け、古い内容は出さない', async () => {
    const { requests } = installFetchMock({ honorAbort: false });
    await renderPage();
    await clickPeriod('月間');

    // 週間 (古い要求) が先に完了。旧実装は finally の setLoading(false) でスピナーが消え、週間の内容が見えていた
    await settle(() => requests[0].respond(comparison('週間')));
    expect(container.textContent).toContain(LOADING_TEXT);
    expect(container.textContent).not.toContain('週間のハイライト');

    // 月間 (現在の要求) が完了して初めて月間の内容に切り替わる
    await settle(() => requests[1].respond(comparison('月間')));
    expect(container.textContent).not.toContain(LOADING_TEXT);
    expect(container.textContent).toContain('月間のハイライト');
    expect(container.textContent).not.toContain('週間のハイライト');
  });

  it('週間→月間→週間と素早く往復しても、最後に選んだ期間の応答だけが表示される', async () => {
    const { requests } = installFetchMock({ honorAbort: false });
    await renderPage();
    await clickPeriod('月間');
    await clickPeriod('週間');
    expect(requests.map((r) => r.url)).toEqual([WEEKLY_URL, MONTHLY_URL, WEEKLY_URL]);

    // 現在の要求 (3 本目) → 最初の要求 (1 本目) → 2 本目の順に届く。表示してよいのは 3 本目だけ
    await settle(() => requests[2].respond(comparison('最新の週間')));
    await settle(() => requests[0].respond(comparison('最初の週間')));
    await settle(() => requests[1].respond(comparison('月間')));

    expect(container.textContent).toContain('最新の週間のハイライト');
    expect(container.textContent).not.toContain('最初の週間のハイライト');
    expect(container.textContent).not.toContain('月間のハイライト');
  });
});

describe('ComparisonPage: 古いリクエストの中断 (#1228)', () => {
  it('期間を切り替えると前のリクエストの signal が abort され、現在のリクエストの signal は abort されない', async () => {
    const { requests } = installFetchMock({ honorAbort: false });
    await renderPage();
    expect(requests[0].signal, 'fetch に signal が渡されていません').toBeTruthy();
    expect(requests[0].signal!.aborted).toBe(false);

    await clickPeriod('月間');
    expect(requests[0].signal!.aborted).toBe(true);
    expect(requests[1].signal, 'fetch に signal が渡されていません').toBeTruthy();
    expect(requests[1].signal!.aborted).toBe(false);
  });

  it('アンマウントすると進行中のリクエストを abort する', async () => {
    const { requests } = installFetchMock({ honorAbort: false });
    await renderPage();
    expect(requests[0].signal!.aborted).toBe(false);

    await settle(() => root.unmount());
    expect(requests[0].signal!.aborted).toBe(true);
  });

  it('abort を尊重する fetch が AbortError で reject しても、エラー表示も console.error も出さず、月間の内容が表示される', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { requests } = installFetchMock({ honorAbort: true });
    await renderPage();

    // 週間のリクエストは abort され AbortError で reject される
    await clickPeriod('月間');
    expect(container.textContent).toContain(LOADING_TEXT);
    expect(container.textContent).not.toContain(ERROR_TEXT);

    await settle(() => requests[1].respond(comparison('月間')));
    expect(container.textContent).toContain('月間のハイライト');
    expect(container.textContent).not.toContain(ERROR_TEXT);
    expect(pageLoggedErrors(consoleError)).toEqual([]);
  });
});

const FAILURE_CASES: Array<[string, (request: PendingRequest) => void]> = [
  ['HTTP エラー (res.ok=false)', (request) => request.respondWithStatus(500)],
  ['ネットワークエラー (reject)', (request) => request.reject(new TypeError('Failed to fetch'))],
];

describe('ComparisonPage: 取得失敗時の表示 (#1228)', () => {
  it.each(FAILURE_CASES)('現在の期間の取得が %s で失敗したら、直前の期間のデータを残さずエラー表示にする', async (_name, fail) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { requests } = installFetchMock({ honorAbort: true });
    await renderPage();
    await settle(() => requests[0].respond(comparison('週間')));
    expect(container.textContent).toContain('週間のハイライト');

    // 月間への切替で取得に失敗。旧実装は週間のデータが残ったまま「月間」タブの下に表示されていた
    await clickPeriod('月間');
    await settle(() => fail(requests[1]));

    expect(container.textContent).toContain(ERROR_TEXT);
    expect(container.textContent).not.toContain('週間のハイライト');
    expect(container.textContent).not.toContain(LOADING_TEXT);
    // 本物の失敗は従来どおり console.error に残す
    expect(pageLoggedErrors(consoleError)).toHaveLength(1);
  });

  it('古い（abort 済みの）リクエストが後から失敗しても、現在の表示を壊さず、エラー扱いにもしない', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { requests } = installFetchMock({ honorAbort: false });
    await renderPage();
    await clickPeriod('月間');
    await settle(() => requests[1].respond(comparison('月間')));
    expect(container.textContent).toContain('月間のハイライト');

    await settle(() => requests[0].reject(new TypeError('Failed to fetch')));

    expect(container.textContent).toContain('月間のハイライト');
    expect(container.textContent).not.toContain(ERROR_TEXT);
    expect(pageLoggedErrors(consoleError)).toEqual([]);
  });

  it('古い（abort 済みの）リクエストが HTTP エラーで完了しても、現在の表示を壊さない', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { requests } = installFetchMock({ honorAbort: false });
    await renderPage();
    await clickPeriod('月間');

    // 現在の要求 (月間) がまだ飛行中の間に、古い要求 (週間) が 500 で完了する
    await settle(() => requests[0].respondWithStatus(500));
    expect(container.textContent).toContain(LOADING_TEXT);
    expect(container.textContent).not.toContain(ERROR_TEXT);

    await settle(() => requests[1].respond(comparison('月間')));
    expect(container.textContent).toContain('月間のハイライト');
    expect(container.textContent).not.toContain(ERROR_TEXT);
    expect(pageLoggedErrors(consoleError)).toEqual([]);
  });
});
