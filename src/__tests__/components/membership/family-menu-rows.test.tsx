/**
 * 週間献立の「家族の表示」の部品 FamilyMenuMealRows / FamilyMenuDayNotes のテスト
 * (#1584 の 1・設計書 docs/design/family/10-family-menu-view.md §16.2・§19.4)。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 * 末尾の describe は、page.tsx と同じ配線 (useFamilyView → visibleOtherMemberIdsOf → useFamilyMenu → partitionFamilyMenuMembers →
 * 部品) を小さな画面で組み、切り替えの適用で家族の共有の献立が実際に出ること (#1584 の 1 の症状) を確かめる。
 */
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MealType } from '@homegohan/shared';
import type { FamilyMember } from '@/schemas/membership';
import type { FamilyMenuData, FamilyMenuMeal } from '@/schemas/membership/family-menu';
import {
  FamilyMenuDayNotes,
  FamilyMenuMealRows,
  type FamilyMenuDayNotesProps,
  type FamilyMenuMealRowsProps,
} from '@/components/membership/FamilyMenuRows';
import { FamilyViewSwitcher } from '@/components/membership/FamilyViewSwitcher';
import {
  FAMILY_MENU_API_PATH,
  FAMILY_MENU_NOTE_TEXT,
  partitionFamilyMenuMembers,
  visibleOtherMemberIdsOf,
  type FamilyMenuPartition,
} from '@/lib/membership/family-menu';
import { FAMILY_MEMBER_NAME_FALLBACK, applyFamilyMemberNames } from '@/lib/membership/family-member-names';
import { useFamilyView } from '@/hooks/useFamilyView';
import { useFamilyMenu } from '@/hooks/useFamilyMenu';

// React に「テスト環境 (act で包む)」であることを伝える
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME_USER = 'a0000000-0000-4000-8000-000000000001';
const HUSBAND_USER = 'a0000000-0000-4000-8000-000000000002';
const GRANDMA_USER = 'a0000000-0000-4000-8000-000000000003';

const M_ME = 'b0000000-0000-4000-8000-000000000001';
const M_HUSBAND = 'b0000000-0000-4000-8000-000000000002';
const M_GRANDMA = 'b0000000-0000-4000-8000-000000000003';
const M_CHILD = 'b0000000-0000-4000-8000-000000000004';

const MEAL_H1 = 'c0000000-0000-4000-8000-000000000001';
const MEAL_H2 = 'c0000000-0000-4000-8000-000000000002';
const MEAL_G1 = 'c0000000-0000-4000-8000-000000000003';
const MEAL_H_LUNCH = 'c0000000-0000-4000-8000-000000000004';

const FAMILY_ID = 'd0000000-0000-4000-8000-000000000001';
const DAY = '2026-10-16';
const OTHER_DAY = '2026-10-17';
const WEEK_START = '2026-10-12';
const WEEK_END = '2026-10-18';
const JOINED_AT = '2026-10-01T00:00:00.000Z';

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
  member({ id: M_HUSBAND, user_id: HUSBAND_USER, role: 'adult', display_name: '父' }),
  member({ id: M_GRANDMA, user_id: GRANDMA_USER, role: 'adult', display_name: '祖母' }),
  member({ id: M_CHILD, user_id: null, role: 'child', display_name: '花子' }),
];

function meal(overrides: Partial<FamilyMenuMeal> & Pick<FamilyMenuMeal, 'id' | 'meal_type' | 'dish_name'>): FamilyMenuMeal {
  return {
    dish_names: [overrides.dish_name],
    is_simple: true,
    calories_kcal: null,
    cooking_time_minutes: null,
    display_order: 0,
    is_completed: false,
    ...overrides,
  };
}

/** 父は今日の夕食 2 食と昼食 1 食、祖母は今日の夕食 1 食 */
const MENU: FamilyMenuData = {
  family_id: FAMILY_ID,
  start_date: WEEK_START,
  end_date: WEEK_END,
  members: [
    {
      member_id: M_HUSBAND,
      user_id: HUSBAND_USER,
      days: [
        {
          day_date: DAY,
          meals: [
            meal({ id: MEAL_H_LUNCH, meal_type: 'lunch', dish_name: '父の昼のうどん' }),
            meal({
              id: MEAL_H1,
              meal_type: 'dinner',
              dish_name: '父の肉じゃが',
              dish_names: ['父の肉じゃが', '味噌汁', 'ごはん'],
              is_simple: false,
              calories_kcal: 650,
              cooking_time_minutes: 30,
              is_completed: true,
            }),
            meal({ id: MEAL_H2, meal_type: 'dinner', dish_name: '父のサラダ', display_order: 1 }),
          ],
        },
      ],
    },
    {
      member_id: M_GRANDMA,
      user_id: GRANDMA_USER,
      days: [{ day_date: DAY, meals: [meal({ id: MEAL_G1, meal_type: 'dinner', dish_name: '祖母の焼き魚' })] }],
    },
  ],
};

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try {
    localStorage.clear();
  } catch {
    // jsdom の localStorage が使えないときは何もしない
  }
});

function renderRows(props: FamilyMenuMealRowsProps): void {
  act(() => root.render(<FamilyMenuMealRows {...props} />));
}

function renderNotes(props: FamilyMenuDayNotesProps): void {
  act(() => root.render(<FamilyMenuDayNotes {...props} />));
}

function rows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="family-menu-row"]')];
}

function noteTexts(): string[] {
  return [...container.querySelectorAll('[data-testid="family-menu-note"]')].map((el) => el.textContent ?? '');
}

const dinnerRowsProps = (overrides: Partial<FamilyMenuMealRowsProps> = {}): FamilyMenuMealRowsProps => ({
  mealType: 'dinner' satisfies MealType,
  dayDate: DAY,
  members: MEMBERS,
  shownIds: [M_GRANDMA, M_HUSBAND],
  menu: MENU,
  ...overrides,
});

describe('FamilyMenuMealRows', () => {
  it('見てよいメンバーの、その区分の食事を切り替えの順に描く', () => {
    renderRows(dinnerRowsProps());
    // 切り替えの順 (祖母 → 父)、同じ人の中は display_order の順。昼食 (別の区分) は描かない
    expect(rows().map((row) => row.getAttribute('data-meal-id'))).toEqual([MEAL_G1, MEAL_H1, MEAL_H2]);
    expect(rows().map((row) => row.getAttribute('data-member-id'))).toEqual([M_GRANDMA, M_HUSBAND, M_HUSBAND]);
    const first = rows()[1];
    expect(first.textContent).toContain('父');
    expect(first.textContent).toContain('父の肉じゃが (全 3 品)');
    expect(first.textContent).toContain('650 kcal');
    expect(first.textContent).toContain('30 分');
    expect(first.textContent).toContain('済');
    expect(container.textContent).not.toContain('父の昼のうどん');

    // shownIds に居ない人 (選ばなかった人・共有していない人) の献立は描かない
    renderRows(dinnerRowsProps({ shownIds: [M_HUSBAND] }));
    expect(rows().map((row) => row.getAttribute('data-meal-id'))).toEqual([MEAL_H1, MEAL_H2]);
  });

  it('行に編集・削除・並べ替え・完了のボタンが無い', () => {
    renderRows(dinnerRowsProps());
    const buttons = [...container.querySelectorAll('button')];
    // ボタンは行ごとの開閉の 1 つだけ
    expect(buttons).toHaveLength(rows().length);
    for (const button of buttons) {
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(button.textContent).not.toMatch(/編集|削除|並べ替え|完了/);
      expect(button.getAttribute('aria-label') ?? '').not.toMatch(/編集|削除|並べ替え|完了/);
    }
  });

  it('押すと料理の名前 (dish_names) の箇条書きだけが開き (img の要素は無く、fetch を呼ばない)、もう一度押すと閉じる', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    renderRows(dinnerRowsProps({ shownIds: [M_HUSBAND] }));
    const button = rows()[0].querySelector('button');
    expect(button).not.toBeNull();
    expect(rows()[0].querySelector('li')).toBeNull();

    act(() => button!.click());
    expect(button!.getAttribute('aria-expanded')).toBe('true');
    expect([...rows()[0].querySelectorAll('li')].map((li) => li.textContent)).toEqual(['父の肉じゃが', '味噌汁', 'ごはん']);
    expect(container.querySelector('img')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    act(() => button!.click());
    expect(button!.getAttribute('aria-expanded')).toBe('false');
    expect(rows()[0].querySelector('li')).toBeNull();
  });

  it('名前が無いメンバーは「名前未設定」', () => {
    const nameless = MEMBERS.map((m) => (m.id === M_GRANDMA ? { ...m, display_name: null } : m));
    renderRows(dinnerRowsProps({ members: nameless, shownIds: [M_GRANDMA] }));
    expect(FAMILY_MEMBER_NAME_FALLBACK).toBe('名前未設定');
    expect(rows()[0].textContent).toContain('名前未設定');
  });

  it('display_name が NULL のメンバーに applyFamilyMemberNames でプロフィールの名前「太郎」を当てた一覧を渡すと、行に「太郎」', () => {
    const nameless = MEMBERS.map((m) => (m.id === M_GRANDMA ? { ...m, display_name: null } : m));
    const named = applyFamilyMemberNames(nameless, new Map([[M_GRANDMA, '太郎']]));
    renderRows(dinnerRowsProps({ members: named, shownIds: [M_GRANDMA] }));
    expect(rows()[0].textContent).toContain('太郎');
    expect(rows()[0].textContent).not.toContain(FAMILY_MEMBER_NAME_FALLBACK);
  });

  it('1 行も無ければ何も描かない', () => {
    renderRows(dinnerRowsProps({ menu: null }));
    expect(container.innerHTML).toBe('');
    renderRows(dinnerRowsProps({ shownIds: [] }));
    expect(container.innerHTML).toBe('');
    renderRows(dinnerRowsProps({ dayDate: OTHER_DAY }));
    expect(container.innerHTML).toBe('');
    renderRows(dinnerRowsProps({ mealType: 'breakfast' }));
    expect(container.innerHTML).toBe('');
  });
});

/** 注記の props (既定は ready で、祖母は shown・父は notSharing・花子は noAccount) */
function notesProps(overrides: Partial<FamilyMenuDayNotesProps> = {}): FamilyMenuDayNotesProps {
  const partition: FamilyMenuPartition = { shown: [M_GRANDMA], notSharing: [M_HUSBAND], noAccount: [M_CHILD] };
  return {
    dayDate: DAY,
    members: MEMBERS,
    partition,
    menu: MENU,
    status: 'ready',
    onReload: () => {},
    ...overrides,
  };
}

describe('FamilyMenuDayNotes', () => {
  it('共有していない・子供・この日は献立が無い の注記を名前つきで出す', () => {
    renderNotes(notesProps({ dayDate: OTHER_DAY }));
    expect(noteTexts()).toEqual([
      '父 は献立を共有していません',
      '花子 (子供) の献立は、アカウントを持つまで出ません',
      '祖母 の献立はこの日はありません',
    ]);
    // 文言は FAMILY_MENU_NOTE_TEXT から作る
    expect(noteTexts()[0]).toBe(FAMILY_MENU_NOTE_TEXT.notSharing.replace('{name}', '父'));
  });

  it('shown のメンバーがその日に献立を持たなければ「{name} の献立はこの日はありません」を出し、献立のある日は出さない', () => {
    const partition: FamilyMenuPartition = { shown: [M_GRANDMA, M_HUSBAND], notSharing: [], noAccount: [] };
    renderNotes(notesProps({ partition, dayDate: DAY }));
    expect(container.innerHTML).toBe('');
    renderNotes(notesProps({ partition, dayDate: OTHER_DAY }));
    expect(noteTexts()).toEqual(['祖母 の献立はこの日はありません', '父 の献立はこの日はありません']);
  });

  it('applyFamilyMemberNames で「太郎」を当てたメンバーの注記は「太郎 は献立を共有していません」', () => {
    const nameless = MEMBERS.map((m) => (m.id === M_HUSBAND ? { ...m, display_name: null } : m));
    const named = applyFamilyMemberNames(nameless, new Map([[M_HUSBAND, '太郎']]));
    renderNotes(notesProps({ members: named, partition: { shown: [], notSharing: [M_HUSBAND], noAccount: [] } }));
    expect(noteTexts()).toEqual(['太郎 は献立を共有していません']);
  });

  it('error のときは読み込めなかった注記と [もう一度] だけを出し、押すと onReload が呼ばれる', () => {
    const onReload = vi.fn();
    renderNotes(notesProps({ status: 'error', onReload, dayDate: OTHER_DAY }));
    expect(noteTexts()).toEqual([FAMILY_MENU_NOTE_TEXT.loadFailed]);
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['もう一度']);
    act(() => buttons[0].click());
    expect(onReload).toHaveBeenCalledTimes(1);

    // 応答が無いまま失敗しても同じ
    renderNotes(notesProps({ status: 'error', onReload, menu: null }));
    expect(noteTexts()).toEqual([FAMILY_MENU_NOTE_TEXT.loadFailed]);
  });

  it('loading で menu が null なら「家族の献立を読み込んでいます」の 1 行だけ', () => {
    renderNotes(notesProps({ status: 'loading', menu: null }));
    expect(noteTexts()).toEqual([FAMILY_MENU_NOTE_TEXT.loading]);
    expect(container.querySelector('button')).toBeNull();
  });

  it('loading で前の応答 (menu) があり、その日に献立の無い shown のメンバーと notSharing のメンバーが居ても、出すのは「家族の献立を読み込んでいます」の 1 行だけ (「この日はありません」「共有していません」を出さない)', () => {
    renderNotes(notesProps({ status: 'loading', menu: MENU, dayDate: OTHER_DAY }));
    expect(noteTexts()).toEqual([FAMILY_MENU_NOTE_TEXT.loading]);
  });

  it('ready で menu が null (週を移った直後の 1 回の描画) なら「家族の献立を読み込んでいます」の 1 行だけ', () => {
    renderNotes(notesProps({ status: 'ready', menu: null, dayDate: OTHER_DAY }));
    expect(noteTexts()).toEqual([FAMILY_MENU_NOTE_TEXT.loading]);
  });

  it('idle では何も描かない', () => {
    renderNotes(notesProps({ status: 'idle', dayDate: OTHER_DAY }));
    expect(container.innerHTML).toBe('');
    renderNotes(notesProps({ status: 'idle', menu: null }));
    expect(container.innerHTML).toBe('');
  });
});

/**
 * page.tsx と同じ配線を小さな画面で組む (状態は useFamilyView と useFamilyMenu の中。page.tsx の §16.1 の導出と同じ式)。
 * 週間献立の画面そのもの (6,000 行を超えるクライアントの画面) は jsdom で描かないので、配線の式は
 * src/__tests__/app/menus/weekly/family-menu-wiring.test.ts が page.tsx の source で、ここは同じ式の動きを見る。
 */
function MiniWeeklyFamilyView({ members: loadedMembers, day }: { members: FamilyMember[]; day: string }) {
  // page.tsx の loadFamilyData と同じ順: 先に family_id が入り、そのあと家族の一覧が入る
  const [familyId, setFamilyId] = useState<string | null>(null);
  const [members, setMembers] = useState<FamilyMember[]>([]);
  useEffect(() => {
    setFamilyId(FAMILY_ID);
  }, []);
  useEffect(() => {
    if (familyId !== null) setMembers(loadedMembers);
  }, [familyId, loadedMembers]);
  const { viewState, setView } = useFamilyView(familyId);
  const otherIds = visibleOtherMemberIdsOf(viewState, members, ME_USER);
  const familyMenu = useFamilyMenu({
    startDate: WEEK_START,
    endDate: WEEK_END,
    enabled: familyId !== null && otherIds.length > 0,
  });
  const partition = partitionFamilyMenuMembers(otherIds, members, familyMenu.data);
  return (
    <div>
      <FamilyViewSwitcher
        familyMembers={members}
        currentUserId={ME_USER}
        value={viewState}
        onChange={(next) => {
          setView(next);
          familyMenu.reload();
        }}
      />
      <FamilyMenuMealRows mealType="dinner" dayDate={day} members={members} shownIds={partition.shown} menu={familyMenu.data} />
      <FamilyMenuDayNotes
        dayDate={day}
        members={members}
        partition={partition}
        menu={familyMenu.data}
        status={familyMenu.status}
        onReload={familyMenu.reload}
      />
    </div>
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function clickByText(text: string): void {
  const target = [...document.body.querySelectorAll<HTMLElement>('button, [role="button"]')].find(
    (el) => el.textContent?.trim() === text,
  );
  expect(target, `「${text}」の押せる要素が見つかりません`).toBeDefined();
  act(() => target!.click());
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('切り替えの適用で、家族の共有の献立が週間献立に出る (#1584 の 1 の症状)', () => {
  it('「自分だけ」のときは家族の行も注記も無く API を呼ばない。「家族全員」を適用すると、共有している家族の献立が読み取り専用の行で出て、子供の注記が出る', async () => {
    const onlyHusbandShares: FamilyMenuData = { ...MENU, members: MENU.members.filter((m) => m.member_id === M_HUSBAND) };
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL) => jsonResponse({ data: onlyHusbandShares }));
    vi.stubGlobal('fetch', fetchSpy);
    localStorage.setItem(`familyViewState_${FAMILY_ID}`, JSON.stringify({ preset: 'self', visible_member_ids: [M_ME] }));

    const members = MEMBERS.map((m) => (m.id === M_GRANDMA ? { ...m, share_menu: false } : m));
    act(() => root.render(<MiniWeeklyFamilyView members={members} day={DAY} />));
    await flush();
    expect(rows()).toHaveLength(0);
    expect(noteTexts()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();

    // 切り替えのシートで「家族全員」を選んで適用する
    const chip = container.querySelector<HTMLElement>('[aria-label="ビューを切替"]');
    expect(chip).not.toBeNull();
    act(() => chip!.click());
    clickByText('家族全員');
    clickByText('適用する');
    await flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url.startsWith(`${FAMILY_MENU_API_PATH}?`)).toBe(true);
    expect(url).toContain(`startDate=${WEEK_START}`);
    expect(url).toContain(`endDate=${WEEK_END}`);

    // 父 (共有している) の夕食が読み取り専用の行で出る
    expect(rows().map((row) => row.getAttribute('data-meal-id'))).toEqual([MEAL_H1, MEAL_H2]);
    expect(rows()[0].textContent).toContain('父の肉じゃが');
    expect([...container.querySelectorAll('[data-testid="family-menu-row"] button')].map((b) => b.textContent)).not.toContainEqual(
      expect.stringMatching(/編集|削除/),
    );
    // 祖母 (共有していない) と花子 (子供) は注記
    expect(noteTexts()).toEqual(['祖母 は献立を共有していません', '花子 (子供) の献立は、アカウントを持つまで出ません']);
  });
});
