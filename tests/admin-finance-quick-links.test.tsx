/**
 * #1311 財務ダッシュボード (/admin/finance) のクイックリンク
 *
 * NPS / CSAT のページと NPS の書き出しは、admin / super_admin だけが使える (財務ロール finance は外した)。
 * クイックリンクの「NPS / CSAT」は、使えない人には出さない。確認すること:
 *   - 書き出せる種別 (GET /api/admin/finance/exports) に nps がある人 (admin / super_admin) には、5 つのリンクを元の並びで出す。
 *   - nps が無い人 (財務ロール finance だけ) には、NPS / CSAT 以外の 4 つのリンクだけを出す。
 *   - 種別が分かるまでは並びを出さない (NPS / CSAT のリンクが後から割り込んで、ほかのリンクが動かないように)。
 *   - 種別が取れなかった (通信失敗・エラー応答・想定外の形) ときは、NPS / CSAT だけ隠す。
 *   - 財務ダッシュボードのページが、このクイックリンクを使っている (ページに NPS / CSAT のリンクを直接書かない)。
 *   - 本物の GET /api/admin/finance/exports の応答と組み合わせても、finance には出ず、admin / super_admin には出る。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する
 * (tests/admin-finance-refund-dialog.test.tsx と同じ方法)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '../src/lib/auth/errors';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// 本物の GET /api/admin/finance/exports を通す確認用
vi.mock('@/lib/auth/helpers', () => ({
  requireRole: mocks.requireRole,
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ from: () => ({}) }),
}));

const { default: FinanceQuickLinks } = await import('@/components/operator/finance/FinanceQuickLinks');
const { GET: exportsGet } = await import('../src/app/api/admin/finance/exports/route');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NPS_HREF = '/admin/finance/nps';

/** NPS / CSAT 以外のリンク (出す順) */
const OTHER_LINKS = [
  ['収益推移グラフ', '/admin/finance/revenue'],
  ['請求書一覧', '/admin/finance/invoices'],
  ['Stripe 整合チェック', '/admin/finance/reconciliation'],
  ['CSV エクスポート', '/admin/finance/exports'],
] as const;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/** GET /api/admin/finance/exports の応答 */
function typesResponse(types: string[]) {
  return jsonResponse(200, { data: { available_types: types } });
}

const ADMIN_TYPES = ['revenue', 'invoices', 'subscriptions', 'nps'];
const FINANCE_TYPES = ['revenue', 'invoices', 'subscriptions'];

/** 描画されているリンクの [表示名, href] を出た順に返す (リンクは アイコン + 表示名 の 2 つの span) */
function renderedLinks(): Array<[string, string]> {
  return Array.from(container.querySelectorAll('a')).map((a) => {
    const spans = a.querySelectorAll('span');
    return [spans[spans.length - 1]?.textContent ?? '', a.getAttribute('href') ?? ''];
  });
}

function hrefs(): string[] {
  return renderedLinks().map(([, href]) => href);
}

async function renderLinks() {
  await act(async () => {
    root.render(<FinanceQuickLinks />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
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

describe('FinanceQuickLinks — リンクの出し分け', () => {
  it('書き出せる種別に nps がある人 (admin / super_admin) には、NPS / CSAT を含む 5 つのリンクを元の並びで出す', async () => {
    fetchMock.mockResolvedValue(typesResponse(ADMIN_TYPES));
    await renderLinks();

    expect(renderedLinks()).toEqual([
      ['収益推移グラフ', '/admin/finance/revenue'],
      ['請求書一覧', '/admin/finance/invoices'],
      ['Stripe 整合チェック', '/admin/finance/reconciliation'],
      ['NPS / CSAT', NPS_HREF],
      ['CSV エクスポート', '/admin/finance/exports'],
    ]);
  });

  it('nps が無い人 (財務ロール finance だけ) には、NPS / CSAT 以外の 4 つのリンクだけを出す', async () => {
    fetchMock.mockResolvedValue(typesResponse(FINANCE_TYPES));
    await renderLinks();

    expect(renderedLinks()).toEqual(OTHER_LINKS.map(([label, href]) => [label, href]));
    expect(hrefs()).not.toContain(NPS_HREF);
    expect(container.textContent).not.toContain('NPS');
  });

  it('GET /api/admin/finance/exports を 1 回だけ呼ぶ', async () => {
    fetchMock.mockResolvedValue(typesResponse(ADMIN_TYPES));
    await renderLinks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/finance/exports');
    // メソッドを指定しない (= GET)。POST (書き出しの実行) ではない
    expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined();
  });

  it('種別が分かるまでは何も出さない。分かったら並びを一度に出す', async () => {
    let resolve!: (value: ReturnType<typeof typesResponse>) => void;
    fetchMock.mockReturnValue(
      new Promise<ReturnType<typeof typesResponse>>((r) => {
        resolve = r;
      }),
    );
    await renderLinks();

    expect(container.querySelectorAll('a')).toHaveLength(0);

    await act(async () => {
      resolve(typesResponse(FINANCE_TYPES));
    });
    expect(container.querySelectorAll('a')).toHaveLength(4);
    expect(hrefs()).not.toContain(NPS_HREF);
  });
});

describe('FinanceQuickLinks — 種別が取れなかったときは NPS / CSAT だけ隠す', () => {
  it('通信に失敗したとき', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await renderLinks();

    expect(hrefs()).toEqual(OTHER_LINKS.map(([, href]) => href));
  });

  it.each([
    ['403', jsonResponse(403, { error: { code: 'OP_PERMISSION_DENIED', message: 'x' } })],
    ['500', jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'x' } })],
  ])('エラー応答 (%s) のとき', async (_label, response) => {
    fetchMock.mockResolvedValue(response);
    await renderLinks();

    expect(hrefs()).toEqual(OTHER_LINKS.map(([, href]) => href));
  });

  it.each([
    ['null', null],
    ['data が無い', {}],
    ['available_types が配列ではない (文字列)', { data: { available_types: 'nps' } }],
    ['available_types が配列ではない (オブジェクト)', { data: { available_types: { nps: true } } }],
    ['nps が文字列ではない', { data: { available_types: [1, true, null, { type: 'nps' }] } }],
  ])('応答の形が想定と違うとき (%s)', async (_label, body) => {
    fetchMock.mockResolvedValue(jsonResponse(200, body));
    await renderLinks();

    expect(hrefs()).toEqual(OTHER_LINKS.map(([, href]) => href));
  });

  it('JSON として読めない応答のとき', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token <')) });
    await renderLinks();

    expect(hrefs()).toEqual(OTHER_LINKS.map(([, href]) => href));
  });
});

describe('財務ダッシュボードのページ', () => {
  it('クイックリンクを FinanceQuickLinks に任せていて、NPS / CSAT のリンクをページに直接書いていない', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/app/admin/finance/page.tsx'), 'utf-8');

    expect(source).toContain('@/components/operator/finance/FinanceQuickLinks');
    expect(source).toContain('<FinanceQuickLinks />');
    // 出し分けをすり抜ける、固定のリンクを足していない
    expect(source).not.toContain(NPS_HREF);
  });
});

describe('FinanceQuickLinks — 本物の GET /api/admin/finance/exports の応答と組み合わせる', () => {
  /** 本物の requireRole と同じく、route が渡した許可ロールと本人のロールの重なりで判定する */
  function actAs(...roles: string[]) {
    mocks.requireRole.mockImplementation(async (allowedRoles: readonly string[]) => {
      if (!roles.some((role) => allowedRoles.includes(role))) {
        throw new ForbiddenError('PERM_DENIED', `Requires one of: ${allowedRoles.join(', ')}`);
      }
      return { id: 'actor-id', email: 'actor@example.com', roles, organization_id: null };
    });
    // fetch の先を、本物の route にする
    fetchMock.mockImplementation(async () => {
      const res = await exportsGet(new NextRequest('http://localhost/api/admin/finance/exports'));
      return { ok: res.ok, status: res.status, json: () => res.json() };
    });
  }

  it.each([
    ['admin', ['admin']],
    ['super_admin', ['super_admin']],
    ['admin と finance の両方を持つ人', ['admin', 'finance']],
  ])('%s には NPS / CSAT のリンクが出る', async (_label, roles) => {
    actAs(...roles);
    await renderLinks();

    expect(hrefs()).toContain(NPS_HREF);
    expect(hrefs()).toHaveLength(5);
  });

  it('財務ロール (finance) だけの人には NPS / CSAT のリンクが出ない。ほかの 4 つは出る', async () => {
    actAs('finance');
    await renderLinks();

    expect(hrefs()).toEqual(OTHER_LINKS.map(([, href]) => href));
  });
});
