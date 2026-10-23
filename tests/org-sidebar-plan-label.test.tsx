/**
 * #1912 組織の管理画面のサイドバーが、組織のプランに関係なく固定の英語「Enterprise」を出していた
 *
 * サイドバー (src/app/(org)/layout.tsx) は user_profiles から organizations(name, plan) を結合で読み、organizations.plan を
 * src/lib/org-plans.ts の orgPlanLabel (日本語の名前・表に無い値は「-」) で出す (組織の設定の画面 /org/settings のプランの表示と同じ)。
 * あわせて、組織の管理画面の招待の一覧 (src/app/(org)/org/invites/page.tsx) の状態の札が、表に無い状態のとき内部の値をそのまま
 * 出していたのを「-」にする (同じ型: 状態を内部の値で出す箇所)。
 *
 * 確かめること:
 *  1. readOrgSidebarInfo: 各プランの値 → 日本語の名前 / 表に無い値・null・欠けた列 → 「-」 / 結合が配列で返る形も読む /
 *     名前が空・無いときは「組織」(以前は固定の英語「Organization」)
 *  2. サイドバーを描画すると、プランの欄に組織のプランの日本語の名前が出て、固定の英語「Enterprise」や内部の値は出ない
 *     (standard の組織でスタンダード)。organizations の結合で plan を読んでいる
 *  3. 招待の一覧: 表に無い状態は「-」で、内部の値を出さない。既知の状態は従来どおりの日本語
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する (tests/org-plan-labels.test.tsx と同じ)。
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_PLAN_LABELS, ORG_PLAN_VALUES, ORG_UNKNOWN_VALUE_LABEL } from '@/lib/org-plans';
import { ORG_SIDEBAR_NAME_FALLBACK, readOrgSidebarInfo } from '@/lib/org-sidebar';

const routerStub = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };

vi.mock('next/navigation', () => ({
  useRouter: () => routerStub,
  usePathname: () => '/org/dashboard',
}));

/** サイドバーの描画で返す user_profiles の行と、select に渡された列 (テストごとに差し替える) */
const profileState: { row: Record<string, unknown> | null; selected: string[] } = { row: null, selected: [] };

/** 同じオブジェクトを返す (layout の useEffect は supabase を依存に持つので、描画ごとに別物だと読み直しが続く) */
const supabaseStub = {
  auth: {
    getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
    signOut: async () => ({ error: null }),
  },
  from: (table: string) => {
    expect(table).toBe('user_profiles');
    const query = {
      select: (columns: string) => {
        profileState.selected.push(columns);
        return query;
      },
      eq: () => query,
      single: async () => ({ data: profileState.row, error: null }),
    };
    return query;
  },
};

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => supabaseStub,
}));

const { default: OrgLayout } = await import('@/app/(org)/layout');
const { default: OrgInvitesPage } = await import('@/app/(org)/org/invites/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 期待する表示名 (組織の設定の画面と同じ日本語の名前) */
const EXPECTED_PLAN_LABELS: Record<string, string> = {
  standard: 'スタンダード',
  premium: 'プレミアム',
  enterprise: 'エンタープライズ',
};

/** 表に無い値 (内部の値が画面に出てはいけないもの) */
const UNKNOWN_PLAN_VALUES = ['free', 'Enterprise', 'org_premium', 'secret_internal_plan', ''];

/** ラテン文字が含まれるか (プランの欄は日本語の名前か「-」だけで、英字を含まない) */
const LATIN = /[A-Za-z]/;

describe('readOrgSidebarInfo', () => {
  it('期待する表示名の表は ORG_PLAN_VALUES と一致する', () => {
    expect(Object.keys(EXPECTED_PLAN_LABELS).sort()).toEqual([...ORG_PLAN_VALUES].sort());
  });

  it.each(ORG_PLAN_VALUES.map((value) => [value]))('プラン %s は日本語の名前', (value) => {
    const info = readOrgSidebarInfo({ org_role: 'admin', organizations: { name: 'A 株式会社', plan: value } });
    expect(info.planLabel).toBe(EXPECTED_PLAN_LABELS[value]);
    expect(info.planLabel).toBe(ORG_PLAN_LABELS[value]);
    expect(info.name).toBe('A 株式会社');
  });

  it.each(UNKNOWN_PLAN_VALUES.map((value) => [value]))('表に無いプラン %j は「-」', (value) => {
    expect(readOrgSidebarInfo({ organizations: { name: 'A', plan: value } }).planLabel).toBe(ORG_UNKNOWN_VALUE_LABEL);
    expect(ORG_UNKNOWN_VALUE_LABEL).toBe('-');
  });

  it('plan が null・欠けている・文字列でないときは「-」', () => {
    expect(readOrgSidebarInfo({ organizations: { name: 'A', plan: null } }).planLabel).toBe('-');
    expect(readOrgSidebarInfo({ organizations: { name: 'A' } }).planLabel).toBe('-');
    expect(readOrgSidebarInfo({ organizations: { name: 'A', plan: 1 } }).planLabel).toBe('-');
  });

  it('結合が配列で返る形も 1 行目を読む', () => {
    expect(readOrgSidebarInfo({ organizations: [{ name: 'B 社', plan: 'premium' }] })).toEqual({
      name: 'B 社',
      planLabel: 'プレミアム',
    });
    expect(readOrgSidebarInfo({ organizations: [] })).toEqual({ name: ORG_SIDEBAR_NAME_FALLBACK, planLabel: '-' });
  });

  it('組織が読めない・名前が空のときは名前を「組織」・プランを「-」にする (固定の英語「Organization」は出さない)', () => {
    expect(ORG_SIDEBAR_NAME_FALLBACK).toBe('組織');
    for (const profile of [null, undefined, 'x', {}, { organizations: null }, { organizations: { name: '', plan: null } }]) {
      expect(readOrgSidebarInfo(profile)).toEqual({ name: ORG_SIDEBAR_NAME_FALLBACK, planLabel: '-' });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 画面の描画
// ─────────────────────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root | null = null;

/**
 * 認証 → user_profiles の読み込み → 描画の更新まで待つための、マクロタスクの回数
 * (getUser・single の await を数回挟む。1 回では描画まで届かない)
 */
const FLUSH_TICKS = 5;

async function flush() {
  await act(async () => {
    for (let i = 0; i < FLUSH_TICKS; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(node: ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  await flush();
}

async function renderSidebar(plan: string | null) {
  profileState.row = {
    org_role: 'admin',
    organization_id: '00000000-0000-4000-8000-000000000100',
    organizations: { name: 'A 株式会社', plan },
  };
  await mount(
    <OrgLayout>
      <div>本文</div>
    </OrgLayout>,
  );
}

function sidebarPlanText(): string {
  const el = container.querySelector('[data-testid="org-sidebar-plan"]');
  expect(el, 'サイドバーのプランの欄が無い').not.toBeNull();
  return el!.textContent ?? '';
}

function sidebarText(): string {
  const aside = container.querySelector('aside');
  expect(aside, 'サイドバーが無い').not.toBeNull();
  return aside!.textContent ?? '';
}

beforeEach(() => {
  vi.restoreAllMocks();
  profileState.row = null;
  profileState.selected = [];
  routerStub.push.mockClear();
});

afterEach(() => {
  if (root) {
    const mounted = root;
    act(() => mounted.unmount());
    container.remove();
    root = null;
  }
  vi.unstubAllGlobals();
});

describe('組織の管理画面のサイドバー (src/app/(org)/layout.tsx)', () => {
  it('standard の組織ではプランの欄にスタンダードと出て、固定の英語「Enterprise」は出ない', async () => {
    await renderSidebar('standard');
    expect(routerStub.push).not.toHaveBeenCalled();
    expect(sidebarPlanText()).toBe('スタンダード');
    expect(sidebarText()).toContain('A 株式会社');
    expect(sidebarText()).not.toContain('Enterprise');
    expect(sidebarText()).not.toMatch(/standard/i);
  });

  it.each(ORG_PLAN_VALUES.map((value) => [value]))('プラン %s の組織は日本語の名前で、英字を出さない', async (value) => {
    await renderSidebar(value);
    expect(sidebarPlanText()).toBe(EXPECTED_PLAN_LABELS[value]);
    expect(sidebarPlanText()).not.toMatch(LATIN);
    expect(sidebarText()).not.toContain('Enterprise');
    expect(sidebarText()).not.toContain(value);
  });

  it.each([...UNKNOWN_PLAN_VALUES.map((value) => [value] as [string | null]), [null]])(
    '表に無いプラン %j は「-」で、内部の値も固定の英語も出さない',
    async (value) => {
      await renderSidebar(value);
      expect(sidebarPlanText()).toBe(ORG_UNKNOWN_VALUE_LABEL);
      expect(sidebarText()).not.toContain('Enterprise');
      if (value) expect(sidebarText()).not.toContain(value);
    },
  );

  it('ログアウトのボタンは日本語の「ログアウト」で、固定の英語「Sign Out」は出さない', async () => {
    await renderSidebar('standard');
    const buttons = [...container.querySelectorAll('aside button')].map((el) => el.textContent ?? '');
    expect(buttons.some((label) => label.includes('ログアウト'))).toBe(true);
    expect(sidebarText()).not.toMatch(/sign\s*out/i);
  });

  it('組織の名前が読めないときは「組織」と出て、固定の英語「Organization」は出さない', async () => {
    profileState.row = {
      org_role: 'admin',
      organization_id: '00000000-0000-4000-8000-000000000100',
      organizations: { name: '', plan: 'standard' },
    };
    await mount(
      <OrgLayout>
        <div>本文</div>
      </OrgLayout>,
    );
    expect(routerStub.push).not.toHaveBeenCalled();
    const nameEl = container.querySelector('[data-testid="org-sidebar-plan"]')?.nextElementSibling;
    expect(nameEl?.textContent).toBe('組織');
    expect(sidebarText()).not.toContain('Organization');
  });

  it('user_profiles の読み込みで organizations の plan を結合して読む', async () => {
    await renderSidebar('premium');
    expect(profileState.selected.length).toBeGreaterThan(0);
    for (const columns of profileState.selected) {
      expect(columns).toMatch(/organizations\(\s*name\s*,\s*plan\s*\)/);
    }
  });
});

describe('組織の管理画面の招待の一覧 (src/app/(org)/org/invites/page.tsx) の状態の札', () => {
  async function renderInvites(invites: Record<string, unknown>[]) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ invites }), { status: 200 })));
    await mount(<OrgInvitesPage />);
  }

  function invite(id: string, email: string, status: string) {
    return { id, email, role: 'member', token: '', status, expires_at: '2026-12-31T00:00:00Z' };
  }

  it('表に無い状態は「-」で、内部の値を出さない', async () => {
    await renderInvites([invite('i-1', 'a@example.com', 'secret_internal_status')]);
    const text = container.textContent ?? '';
    expect(text).toContain('a@example.com');
    expect(text).not.toContain('secret_internal_status');
    const badges = [...container.querySelectorAll('span.rounded-full')].map((el) => el.textContent);
    expect(badges).toContain(ORG_UNKNOWN_VALUE_LABEL);
  });

  it.each([
    ['pending', '保留中'],
    ['accepted', '承諾済'],
    ['rejected', '拒否済'],
    ['expired', '期限切れ'],
    ['revoked', '取消済'],
  ])('既知の状態 %s は %s', async (status, label) => {
    await renderInvites([invite('i-1', 'a@example.com', status)]);
    const badges = [...container.querySelectorAll('span.rounded-full')].map((el) => el.textContent);
    expect(badges).toContain(label);
    expect(badges).not.toContain(ORG_UNKNOWN_VALUE_LABEL);
  });
});
