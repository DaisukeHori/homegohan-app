// src/__tests__/app/settings/membership-self-dissolve.test.ts
// #1917 メンバーシップ設定の、代表者・オーナーの譲渡と解散 (docs/design/family/11-self-dissolve.md §15.1・§21.3)。
// 実際にレンダリングし、解散の区画 (SelfDissolveSection) と解散の API (fetch) まで本物の配線で通す。
// Supabase のクライアントはモックにし、所属の状態 (profile・家族の自分の行・家族・組織) をテストごとに差し替える。
// NOTE: tsconfig の jsx: "preserve" の都合で、拡張子 .ts + React.createElement で書く (membership-no-org-guidance.test.ts と同じ)。

import React, { act } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { FAMILY_PLAN_CONTINUES_AFTER_DISSOLVE } from '@/lib/membership/self-dissolve';

const pushMock = vi.hoisted(() => vi.fn());

interface FakeState {
  profile: { family_id: string | null; organization_id: string | null; org_role: string | null; nickname: string };
  familyMember: { id: string; role: string; share_meals: boolean; share_health: boolean; share_menu: boolean } | null;
  familyGroup: { id: string; name: string } | null;
  org: { id: string; name: string } | null;
  getUserCalls: number;
  profileReads: number;
  /** 読み直し (2 回目以降の getUser) で例外を投げる */
  failOnRefresh: boolean;
}

const fake = vi.hoisted(() => {
  const holder: { current: FakeState | null } = { current: null };
  return {
    holder,
    /** 今のテストの状態 (setState の前に読むと例外) */
    get state(): FakeState {
      if (!holder.current) throw new Error('setState を先に呼んでください');
      return holder.current;
    },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, back: vi.fn() }),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => {
        fake.state.getUserCalls += 1;
        if (fake.state.failOnRefresh && fake.state.getUserCalls > 1) throw new Error('network down');
        return { data: { user: { id: 'user-1' } } };
      },
    },
    from: (table: string) => {
      const query: Record<string, unknown> = {};
      query.select = () => query;
      query.eq = () => query;
      query.single = async () => {
        if (table === 'user_profiles') {
          fake.state.profileReads += 1;
          return { data: { ...fake.state.profile } };
        }
        return { data: null };
      };
      query.maybeSingle = async () => {
        if (table === 'family_members') return { data: fake.state.familyMember };
        if (table === 'family_groups') return { data: fake.state.familyGroup };
        if (table === 'organizations') return { data: fake.state.org };
        return { data: null };
      };
      return query;
    },
  }),
}));

import MembershipSettingsPage from '@/app/(main)/settings/membership/page';

const h = React.createElement;

const FAMILY_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
const ORG_ID = 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55';
const DISSOLVED_AT = '2026-10-19T05:00:00.123456+00:00';

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();

function setState(options: { familyRole?: string | null; orgRole?: string | null }) {
  const { familyRole = null, orgRole = null } = options;
  fake.holder.current = {
    profile: {
      family_id: familyRole ? FAMILY_ID : null,
      organization_id: orgRole ? ORG_ID : null,
      org_role: orgRole,
      nickname: 'テスト',
    },
    familyMember: familyRole ? { id: 'm-1', role: familyRole, share_meals: true, share_health: false, share_menu: true } : null,
    familyGroup: familyRole ? { id: FAMILY_ID, name: '山田家' } : null,
    org: orgRole ? { id: ORG_ID, name: '株式会社テスト' } : null,
    getUserCalls: 0,
    profileReads: 0,
    failOnRefresh: false,
  };
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  pushMock.mockClear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: string) => {
    if (input === '/api/family/dissolve') {
      return new Response(JSON.stringify({ data: { family_id: FAMILY_ID, dissolved_at: DISSOLVED_AT } }), { status: 200 });
    }
    if (input === '/api/org/dissolve') {
      return new Response(JSON.stringify({ data: { organization_id: ORG_ID, dissolved_at: DISSOLVED_AT } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
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
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPage() {
  await act(async () => {
    root.render(h(MembershipSettingsPage));
  });
  await flush();
}

function findSection(heading: string): HTMLElement {
  const section = Array.from(container.querySelectorAll('section')).find((s) => s.querySelector('h2')?.textContent === heading);
  if (!section) throw new Error(`「${heading}」のセクションが見つかりません`);
  return section;
}

function buttonTexts(element: Element): string[] {
  return Array.from(element.querySelectorAll('button')).map((b) => b.textContent ?? '');
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!button) throw new Error(`「${text}」のボタンが見つかりません`);
  return button;
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
  });
}

async function dissolve(scope: 'family' | 'organization') {
  const input = container.querySelector<HTMLInputElement>(`[data-testid="self-dissolve-${scope}-keyword"]`);
  if (!input) throw new Error('解散の区画が出ていません');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, '解散します');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const submit = container.querySelector<HTMLButtonElement>(`[data-testid="self-dissolve-${scope}-submit"]`);
  await click(submit!);
  await flush();
}

function statusText(): string | null {
  return container.querySelector('[role="status"]')?.textContent ?? null;
}

describe('メンバーシップ設定: 代表者・オーナーの譲渡と解散 (#1917)', () => {
  it('代表者には「代表者を譲渡」「家族グループを解散」が出て、「家族から脱退」は出ない', async () => {
    setState({ familyRole: 'representative' });
    await renderPage();
    const texts = buttonTexts(findSection('所属家族'));
    expect(texts).toEqual(expect.arrayContaining(['家族を表示', '代表者を譲渡', '家族グループを解散']));
    expect(texts).not.toContain('家族から脱退');

    await click(buttonByText('代表者を譲渡'));
    expect(pushMock).toHaveBeenCalledWith('/family/representative-transfer');
  });

  it('大人には今までどおり「家族から脱退」が出て、解散のボタンは出ない', async () => {
    setState({ familyRole: 'adult' });
    await renderPage();
    const texts = buttonTexts(findSection('所属家族'));
    expect(texts).toContain('家族から脱退');
    expect(texts).not.toContain('家族グループを解散');
    expect(texts).not.toContain('代表者を譲渡');
  });

  it('オーナーには「オーナーを譲渡」「組織を解散」が出て、「組織から脱退」は出ない', async () => {
    setState({ orgRole: 'owner' });
    await renderPage();
    const texts = buttonTexts(findSection('所属組織'));
    expect(texts).toEqual(expect.arrayContaining(['オーナーを譲渡', '組織を解散']));
    expect(texts).not.toContain('組織から脱退');

    await click(buttonByText('オーナーを譲渡'));
    expect(pushMock).toHaveBeenCalledWith('/org/settings/owner-transfer');
  });

  it('member には今までどおり「組織から脱退」', async () => {
    setState({ orgRole: 'member' });
    await renderPage();
    const texts = buttonTexts(findSection('所属組織'));
    expect(texts).toContain('組織から脱退');
    expect(texts).not.toContain('組織を解散');
  });

  it('「家族グループを解散」を押すと SelfDissolveSection (家族名つき) が出る。「キャンセル」で閉じる', async () => {
    setState({ familyRole: 'representative' });
    await renderPage();

    await click(buttonByText('家族グループを解散'));
    expect(container.textContent).toContain('「山田家」を解散する');
    expect(container.querySelector('[data-testid="self-dissolve-family-submit"]')).not.toBeNull();
    // 家族プランの解約の案内は、設定画面の利用者が開ける「プランとお支払い」(/account/billing) を名指す
    expect(Array.from(container.querySelectorAll('li')).map((li) => li.textContent)).toContain(
      FAMILY_PLAN_CONTINUES_AFTER_DISSOLVE.settings,
    );

    await click(buttonByText('キャンセル'));
    expect(container.querySelector('[data-testid="self-dissolve-family-submit"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('家族の解散が済む (onDissolved) と、区画が閉じ、role=status に「家族グループを解散しました。」が出て、所属家族は「所属していません」・「家族を表示」と共有設定の区画が消える。所属組織は読み直した値のまま出る', async () => {
    setState({ familyRole: 'representative', orgRole: 'member' });
    await renderPage();
    await click(buttonByText('家族グループを解散'));

    // 読み直しでは家族の所属が外れている (組織はそのまま)
    fake.state.profile.family_id = null;
    fake.state.familyMember = null;
    await dissolve('family');

    expect(fetchMock).toHaveBeenCalledWith('/api/family/dissolve', expect.objectContaining({ method: 'POST' }));
    expect(container.querySelector('[data-testid="self-dissolve-family-submit"]')).toBeNull();
    expect(statusText()).toBe('家族グループを解散しました。');
    expect(findSection('所属家族').textContent).toContain('所属していません');
    expect(buttonTexts(container)).not.toContain('家族を表示');
    expect(container.textContent).not.toContain('家族への共有設定');
    expect(findSection('所属組織').textContent).toContain('株式会社テスト');
  });

  it('組織の解散が済むと、所属組織は「所属していません」になり「組織を解散しました。」が出る。所属家族は読み直した値のまま出る', async () => {
    setState({ familyRole: 'adult', orgRole: 'owner' });
    await renderPage();
    await click(buttonByText('組織を解散'));

    fake.state.profile.organization_id = null;
    fake.state.profile.org_role = null;
    fake.state.org = null;
    await dissolve('organization');

    expect(fetchMock).toHaveBeenCalledWith('/api/org/dissolve', expect.objectContaining({ method: 'POST' }));
    expect(statusText()).toBe('組織を解散しました。');
    expect(findSection('所属組織').textContent).toContain('所属していません');
    expect(findSection('所属家族').textContent).toContain('山田家');
  });

  it('解散のあとの読み直しで profile の family_id / organization_id が null なら、familyInfo / orgInfo は null になる (読み直しの問い合わせが 2 回目の getUser と user_profiles を呼ぶ)', async () => {
    setState({ familyRole: 'representative', orgRole: 'member' });
    await renderPage();
    expect(fake.state.getUserCalls).toBe(1);
    expect(fake.state.profileReads).toBe(1);
    await click(buttonByText('家族グループを解散'));

    // 読み直しでは、組織の所属も (ほかの理由で) 外れている
    fake.state.profile.family_id = null;
    fake.state.profile.organization_id = null;
    fake.state.profile.org_role = null;
    await dissolve('family');

    expect(fake.state.getUserCalls).toBe(2);
    expect(fake.state.profileReads).toBe(2);
    expect(findSection('所属家族').textContent).toContain('所属していません');
    expect(findSection('所属組織').textContent).toContain('所属していません');
  });

  it('解散のあとの読み直しが失敗 (例外) しても、解散した所属は「所属していません」のまま (画面全体は読み込み中に戻らない)', async () => {
    setState({ familyRole: 'representative' });
    await renderPage();
    await click(buttonByText('家族グループを解散'));
    fake.state.failOnRefresh = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await dissolve('family');

    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(statusText()).toBe('家族グループを解散しました。');
    expect(findSection('所属家族').textContent).toContain('所属していません');
    consoleError.mockRestore();
  });
});
