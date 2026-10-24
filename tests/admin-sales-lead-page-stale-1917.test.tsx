/**
 * #1917 リード詳細画面 (/admin/sales/[id]) のステージの変更が 409 CONFLICT_STALE_DATA (別の担当者が先にステージを変えた) で
 * 断られたときの文のテスト
 *
 * 以前は 409 のあとにリードを読み直してから、サーバーの文 (「画面を開き直して、もう一度確認してください」) を出していた。
 * 画面は自分で読み直しているのに手で開き直すよう頼み、読み直しに失敗しても読み込みの失敗の文をサーバーの文で上書きしていた。
 * 修正後は次のようになる。
 *   - 409 CONFLICT_STALE_DATA のあとはリードを読み直して今のステージを出し、読み直した旨の画面の文を出す (サーバーの文は出さない)
 *   - 読み直しに失敗したら、「読み込み直した」とは出さず、読み込み直せなかった旨の文を出す
 *   - 409 でも code が CONFLICT_STALE_DATA でなければ読み直さない
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerPush = vi.fn();
// useRouter は毎回同じものを返す (画面は router を useCallback の依存に入れているので、毎回新しいと取得が止まらない。Next.js の useRouter も同じものを返す)
const router = { push: routerPush };
vi.mock('next/navigation', () => ({
  useRouter: () => router,
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { default: LeadDetailPage } = await import('@/app/admin/sales/[id]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEAD_ID = '11111111-2222-4333-8444-555555555555';
const SERVER_STALE_MESSAGE = '別の担当者が先にこのリードのステージを変えました。画面を開き直して、もう一度確認してください';

function lead(stage: string) {
  return {
    id: LEAD_ID,
    company_name: '株式会社テスト',
    industry: null,
    employee_count: null,
    contact_name: null,
    contact_email: null,
    contact_phone: null,
    source: null,
    stage,
    assigned_to: null,
    estimated_acv: null,
    notes: null,
    converted_org_id: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    activities: [],
  };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

/** PATCH は patchResponse を返し、その時点で別の担当者の変更 (ステージ = 提案) が入る。n 回目 (1 始まり) の GET を failGets で失敗させる */
function mockApi(patchResponse: () => Response, failGets: number[] = []) {
  const state = { patched: false, gets: 0 };
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      state.patched = true;
      return patchResponse();
    }
    state.gets += 1;
    if (failGets.includes(state.gets)) return jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: '失敗' } });
    return jsonResponse(200, { data: lead(state.patched ? 'proposal' : 'approach') });
  });
  vi.stubGlobal('fetch', fetchMock);
  return state;
}

const text = () => container.textContent ?? '';

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/**
 * 解決済みの params。React の use() は status が fulfilled の thenable なら止まらずに value を返すので、
 * 描画を Suspense で止めずに済む (毎回の描画で新しい Promise を作ると、解決を待つ間に止まり続けるため)
 */
function fulfilledParams(): Promise<{ id: string }> {
  const value = { id: LEAD_ID };
  return Object.assign(Promise.resolve(value), { status: 'fulfilled' as const, value });
}

async function renderPage() {
  const params = fulfilledParams();
  await act(async () => {
    root.render(
      <Suspense fallback={null}>
        <LeadDetailPage params={params} />
      </Suspense>,
    );
  });
  await settle();
}

/** ステージ変更の欄のボタン */
function stageButton(label: string): HTMLButtonElement {
  const section = Array.from(container.querySelectorAll('h2')).find((h) => h.textContent === 'ステージ変更')!.parentElement!;
  const button = Array.from(section.querySelectorAll('button')).find((b) => b.textContent === label);
  expect(button, `「${label}」ボタンが見つからない`).toBeDefined();
  return button!;
}

async function changeStage(label: string) {
  await act(async () => {
    stageButton(label).click();
  });
  await settle();
}

beforeEach(() => {
  routerPush.mockReset();
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
  vi.restoreAllMocks();
});

describe('リード詳細: ステージの変更が 409 CONFLICT_STALE_DATA で断られたとき (#1917)', () => {
  it('リードを読み直して今のステージを出し、読み直した旨の画面の文を出す (サーバーの「開き直して」は出さない)', async () => {
    const state = mockApi(() => jsonResponse(409, { error: { code: 'CONFLICT_STALE_DATA', message: SERVER_STALE_MESSAGE } }));
    await renderPage();
    expect(stageButton('アプローチ').disabled).toBe(true);

    await changeStage('商談中');

    expect(state.gets).toBe(2);
    expect(stageButton('提案').disabled).toBe(true);
    expect(text()).toContain('別の担当者が先にこのリードのステージを変えていました');
    expect(text()).toContain('読み込み直したので');
    expect(text()).not.toContain('画面を開き直して');
  });

  it('読み直しに失敗したら「読み込み直した」とは出さず、読み込み直せなかった旨の文を出す', async () => {
    const state = mockApi(
      () => jsonResponse(409, { error: { code: 'CONFLICT_STALE_DATA', message: SERVER_STALE_MESSAGE } }),
      [2],
    );
    await renderPage();

    await changeStage('商談中');

    expect(state.gets).toBe(2);
    expect(text()).toContain('読み込み直せなかった');
    expect(text()).not.toContain('読み込み直したので');
    expect(text()).not.toContain('画面を開き直して');
  });

  it('409 でも code が CONFLICT_STALE_DATA でなければ読み直さず、変更の失敗を出す', async () => {
    const state = mockApi(() => jsonResponse(409, { error: { code: 'SOME_OTHER_CONFLICT', message: '別の理由' } }));
    await renderPage();

    await changeStage('商談中');

    expect(state.gets).toBe(1);
    expect(text()).toContain('ステージ変更失敗');
    expect(text()).not.toContain('別の担当者が先に');
  });

  it('変更に成功したら、リードを読み直し、文は出さない', async () => {
    const state = mockApi(() => jsonResponse(200, { data: lead('meeting') }));
    await renderPage();

    await changeStage('商談中');

    expect(state.gets).toBe(2);
    expect(text()).not.toContain('別の担当者が先に');
  });
});
