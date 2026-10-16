/**
 * 家族の表示の切り替え FamilyViewSwitcher の名前と「(献立は非公開)」の印のテスト
 * (#1584 の 1・設計書 docs/design/family/10-family-menu-view.md §16.3・§19.4)。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FamilyMember } from '@/schemas/membership';
import type { FamilyViewState } from '@/hooks/useFamilyView';
import { FamilyViewSwitcher } from '@/components/membership/FamilyViewSwitcher';
import { FAMILY_MEMBER_NAME_FALLBACK, applyFamilyMemberNames } from '@/lib/membership/family-member-names';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME_USER = 'a0000000-0000-4000-8000-000000000001';
const HUSBAND_USER = 'a0000000-0000-4000-8000-000000000002';
const GRANDMA_USER = 'a0000000-0000-4000-8000-000000000003';

const M_ME = 'b0000000-0000-4000-8000-000000000001';
const M_HUSBAND = 'b0000000-0000-4000-8000-000000000002';
const M_GRANDMA = 'b0000000-0000-4000-8000-000000000003';
const M_CHILD = 'b0000000-0000-4000-8000-000000000004';

const FAMILY_ID = 'd0000000-0000-4000-8000-000000000001';
const JOINED_AT = '2026-10-01T00:00:00.000Z';
const PRIVATE_MENU_MARK = '(献立は非公開)';

function member(overrides: Partial<FamilyMember> & Pick<FamilyMember, 'id' | 'user_id' | 'role'>): FamilyMember {
  return {
    family_id: FAMILY_ID,
    display_name: null,
    relationship: null,
    tags: [],
    share_meals: true,
    share_health: false,
    share_menu: true,
    child_profile: null,
    avatar_color: '',
    status: 'active',
    joined_at: JOINED_AT,
    removed_at: null,
    ...overrides,
  };
}

const MEMBERS: FamilyMember[] = [
  member({ id: M_ME, user_id: ME_USER, role: 'representative', display_name: '母' }),
  member({ id: M_CHILD, user_id: null, role: 'child', display_name: '花子' }),
  member({ id: M_HUSBAND, user_id: HUSBAND_USER, role: 'adult', display_name: '父' }),
  member({ id: M_GRANDMA, user_id: GRANDMA_USER, role: 'adult', display_name: '祖母' }),
];

const ALL: FamilyViewState = { preset: 'all', visible_member_ids: [] };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(members: FamilyMember[], onChange: (next: FamilyViewState) => void = () => {}): void {
  act(() =>
    root.render(<FamilyViewSwitcher familyMembers={members} currentUserId={ME_USER} value={ALL} onChange={onChange} />),
  );
}

function chip(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[aria-label="ビューを切替"]');
  expect(el).not.toBeNull();
  return el!;
}

function openSheet(): HTMLElement {
  act(() => chip().click());
  const sheet = container.querySelector<HTMLElement>('[role="dialog"][aria-label="表示するメンバーを選択"]');
  expect(sheet).not.toBeNull();
  return sheet!;
}

function closeSheet(): void {
  const close = container.querySelector<HTMLElement>('[aria-label="閉じる"]');
  expect(close).not.toBeNull();
  act(() => close!.click());
}

/** シートの「メンバー個別選択」の行 (id の順は members の順) */
function memberRowTexts(sheet: HTMLElement): string[] {
  const heading = [...sheet.querySelectorAll('p')].find((p) => p.textContent === 'メンバー個別選択');
  expect(heading).toBeDefined();
  return [...heading!.parentElement!.querySelectorAll('button')].map((b) => b.textContent ?? '');
}

function chipTitles(): string[] {
  return [...chip().querySelectorAll('span[title]')].map((el) => el.getAttribute('title') ?? '');
}

describe('FamilyViewSwitcher の名前と印 (#1584 の 1)', () => {
  it('display_name が無ければ「名前未設定」', () => {
    render(MEMBERS.map((m) => (m.id === M_GRANDMA ? { ...m, display_name: null } : m)));
    expect(FAMILY_MEMBER_NAME_FALLBACK).toBe('名前未設定');
    expect(chipTitles()).toContain('名前未設定');
    expect(chipTitles()).not.toContain('メンバー');
    const rows = memberRowTexts(openSheet());
    expect(rows[3]).toContain('名前未設定');
  });

  it('display_name が NULL のメンバーに applyFamilyMemberNames でプロフィールの名前「太郎」を当てた一覧を渡すと、チップとシートに「太郎」', () => {
    const nameless = MEMBERS.map((m) => (m.id === M_HUSBAND ? { ...m, display_name: null } : m));
    render(applyFamilyMemberNames(nameless, new Map([[M_HUSBAND, '太郎']])));
    expect(chipTitles()).toEqual(['母', '花子', '太郎', '祖母']);
    const rows = memberRowTexts(openSheet());
    expect(rows[2]).toContain('太郎');
    expect(rows.join('\n')).not.toContain(FAMILY_MEMBER_NAME_FALLBACK);
  });

  it('share_menu が false のメンバーに「(献立は非公開)」', () => {
    render(MEMBERS.map((m) => (m.id === M_GRANDMA ? { ...m, share_menu: false } : m)));
    const rows = memberRowTexts(openSheet());
    expect(rows[3]).toContain(PRIVATE_MENU_MARK);
    // 共有している人・子供・自分には出ない
    expect(rows.slice(0, 3).some((text) => text.includes(PRIVATE_MENU_MARK))).toBe(false);
  });

  it('share_menu が true の members で描いたあと、同じメンバーが false の members (適用で読み直した一覧) で描き直すと、シートに「(献立は非公開)」が出る', () => {
    render(MEMBERS);
    expect(memberRowTexts(openSheet()).join('\n')).not.toContain(PRIVATE_MENU_MARK);
    closeSheet();

    render(MEMBERS.map((m) => (m.id === M_HUSBAND ? { ...m, share_menu: false } : m)));
    const rows = memberRowTexts(openSheet());
    expect(rows[2]).toContain('父');
    expect(rows[2]).toContain(PRIVATE_MENU_MARK);
  });

  it('プリセットの計算は変わらない (self_partner は自分 + 子供でない 1 人)', () => {
    const onChange = vi.fn();
    render(MEMBERS, onChange);
    const sheet = openSheet();
    const preset = [...sheet.querySelectorAll('button')].find((b) => b.textContent === '自分 + 配偶者');
    expect(preset).toBeDefined();
    act(() => preset!.click());
    const apply = [...sheet.querySelectorAll('button')].find((b) => b.textContent === '適用する');
    expect(apply).toBeDefined();
    act(() => apply!.click());
    // 子供 (花子) を飛ばして、最初の子供でない人 (父) を選ぶ
    expect(onChange).toHaveBeenCalledWith({ preset: 'self_partner', visible_member_ids: [M_ME, M_HUSBAND] });
  });
});
