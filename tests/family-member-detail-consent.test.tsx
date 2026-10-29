/**
 * メンバーの詳細画面 (/family/members/[id]) の保護者の同意カード (#1173 / 設計書 docs/design/cross/14-parental-consent.md §6.5.6 の 10・T-MD1〜T-MD3)
 *
 * 子供の行なら生年月日 (YYYY年M月D日 と満年齢) と、parental_consents の最新の 1 行から同意カードを出す。
 *   - 同意 active → recordedHeading + 署名者・日時・版・全文リンク・withdrawNote
 *   - revoked → revokedHeading + 取り消し日時
 *   - 同意の行が無く 18 歳以上 → notRequiredNote
 * このリポジトリには @testing-library/react が無いため、react-dom/client + act で描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PARENTAL_CONSENT_COPY, PARENTAL_CONSENT_DOCUMENT_PATH } from '@homegohan/shared';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const ids = vi.hoisted(() => ({
  ME: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  FAMILY: 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66',
  CHILD: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
}));

const state = vi.hoisted(() => ({
  member: null as Record<string, unknown> | null,
  consent: null as Record<string, unknown> | null,
  consentFilters: [] as Array<[string, unknown]>,
}));

// 本物の useRouter は同じ参照を返す (毎回作ると useEffect の依存が変わって読み込みが 2 回走る)
const router = vi.hoisted(() => ({ push: () => undefined, replace: () => undefined, back: () => undefined }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: ids.CHILD }),
  useRouter: () => router,
}));

vi.mock('@/lib/membership/family-member-names', () => ({
  fetchFamilyMemberNames: async () => [],
  applyFamilyMemberNames: <T,>(members: T[]) => members,
}));

function query(table: string) {
  let columns = '';
  const chain = {
    select(selected: string) {
      columns = selected;
      return chain;
    },
    eq(column: string, value: unknown) {
      if (table === 'parental_consents') state.consentFilters.push([column, value]);
      return chain;
    },
    order() {
      return chain;
    },
    limit() {
      return chain;
    },
    single: async () => {
      if (table === 'user_profiles') return { data: { family_id: ids.FAMILY }, error: null };
      if (table === 'family_members' && columns === 'role') return { data: { role: 'representative' }, error: null };
      return { data: state.member, error: null };
    },
    maybeSingle: async () => {
      // 自分の役割は自分の active な行から .maybeSingle() で読む (#2080 U2)
      if (table === 'family_members' && columns === 'role') return { data: { role: 'representative' }, error: null };
      return { data: state.consent, error: null };
    },
  };
  return chain;
}

const client = {
  auth: { getUser: async () => ({ data: { user: { id: ids.ME } } }) },
  from: (table: string) => query(table),
};

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => client,
}));

const { default: FamilyMemberDetailPage } = await import('@/app/(main)/family/members/[id]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** JST 2026-10-16 12:00 に固定する (満年齢を固定するため) */
const FIXED_NOW = new Date('2026-10-16T03:00:00.000Z');

function childRow(birthDate: string) {
  return {
    id: ids.CHILD,
    role: 'child',
    display_name: 'たろう',
    user_id: null,
    child_profile: {},
    birth_date: birthDate,
    share_meals: true,
    share_health: false,
    share_menu: true,
    joined_at: '2026-10-01T00:00:00.000Z',
  };
}

let container: HTMLDivElement;
let root: Root;

async function renderPage() {
  await act(async () => {
    root.render(<FamilyMemberDetailPage />);
  });
  // 非同期の読み込み (useEffect の中の await) を流し切る
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_NOW);
  state.member = null;
  state.consent = null;
  state.consentFilters = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

describe('メンバーの詳細画面の保護者の同意カード (#1173)', () => {
  it('T-MD1: 子供で同意 active → 生年月日 (年齢)・署名者・日時・版・全文リンク・withdrawNote', async () => {
    state.member = childRow('2018-04-01');
    state.consent = {
      id: 'consent-1',
      signed_name: '山田 花子',
      consent_version: 'v2026.1',
      signed_at: '2026-10-15T01:00:00.000Z',
      revoked_at: null,
      revoked_reason: null,
    };

    await renderPage();

    const text = container.textContent ?? '';
    expect(text).toContain('2018年4月1日');
    expect(text).toContain('(8歳)');
    const card = container.querySelector('[data-testid="parental-consent-card"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain(PARENTAL_CONSENT_COPY.recordedHeading);
    expect(card!.textContent).toContain('山田 花子');
    expect(card!.textContent).toContain('v2026.1');
    expect(card!.textContent).toContain('2026/10/15 10:00:00');
    expect(card!.textContent).toContain(PARENTAL_CONSENT_COPY.withdrawNote);
    expect(card!.querySelector(`a[href="${PARENTAL_CONSENT_DOCUMENT_PATH}"]`)).not.toBeNull();
    // 同意の行は、この子供の行 (family_member_id) で引く
    expect(state.consentFilters).toEqual([['family_member_id', ids.CHILD]]);
  });

  it('T-MD2: 18 歳以上の子供の行で同意の行が無い → notRequiredNote', async () => {
    state.member = childRow('1956-01-01');
    state.consent = null;

    await renderPage();

    expect(container.querySelector('[data-testid="parental-consent-card"]')).toBeNull();
    expect(container.textContent).toContain(PARENTAL_CONSENT_COPY.notRequiredNote);
  });

  it('T-MD3: revoked → revokedHeading と取り消し日時 (S13)', async () => {
    state.member = childRow('2018-04-01');
    state.consent = {
      id: 'consent-1',
      signed_name: '山田 花子',
      consent_version: 'v2026.1',
      signed_at: '2026-10-15T01:00:00.000Z',
      revoked_at: '2026-10-16T02:00:00.000Z',
      revoked_reason: 'member_removed',
    };

    await renderPage();

    const card = container.querySelector('[data-testid="parental-consent-card"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain(PARENTAL_CONSENT_COPY.revokedHeading);
    expect(card!.textContent).toContain('2026/10/16 11:00:00');
    expect(card!.textContent).not.toContain(PARENTAL_CONSENT_COPY.recordedHeading);
  });

  it('18 歳未満で同意の行が無い (本冊の不変条件では起きない) ときはカードも注記も出さない', async () => {
    state.member = childRow('2018-04-01');
    state.consent = null;

    await renderPage();

    expect(container.querySelector('[data-testid="parental-consent-card"]')).toBeNull();
    expect(container.textContent).not.toContain(PARENTAL_CONSENT_COPY.notRequiredNote);
  });
});
