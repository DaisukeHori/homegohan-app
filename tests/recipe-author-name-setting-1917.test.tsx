/**
 * cross/21 (#1917 の続き): 公開レシピの作者名を出すかの切り替え (user_profiles.show_recipe_author_name) の単体テスト
 * (docs/design/cross/21-recipe-author-display-name.md §7.6・§7.7・§12)
 *
 *   P-1 toUserProfile: show_recipe_author_name が無い行は showRecipeAuthorName が true (列の既定と同じ。null も true)
 *   P-2 fromUserProfile: showRecipeAuthorName を show_recipe_author_name に写す。undefined なら書かない
 *   P-3 プロフィールの編集の基本情報タブに、ニックネームの下の切り替えがラベルと注記つきで出て、外して保存すると
 *       PUT /api/profile の本文に showRecipeAuthorName: false が入る
 *
 * Supabase には接続しない (createClient をモック)。このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromUserProfile, toUserProfile } from '@/lib/converter';
import { RECIPE_AUTHOR_NAME_SETTING_LABEL, RECIPE_AUTHOR_NAME_SETTING_NOTE } from '@/lib/recipes/author-name';
import type { DbUserProfile } from '@/types/database';

const h = React.createElement;

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const USER_ID = '30000000-0000-4000-8000-000000000001';
const NICKNAME = 'ほり';
/** 切り替えの input の id (src/app/(main)/profile/page.tsx) */
const SETTING_INPUT_ID = 'profile-show-recipe-author-name';

const mocks = vi.hoisted(() => ({
  /** 画面が最初に読む user_profiles の行 (show_recipe_author_name の列を持たない = 列がまだ無い環境の行) */
  profileRow: {} as Record<string, unknown>,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useNativeAppMode', () => ({ useNativeAppMode: () => false }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }),
      signOut: async () => ({ error: null }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: mocks.profileRow, error: null }),
          maybeSingle: async () => ({ data: mocks.profileRow, error: null }),
        }),
      }),
      update: () => ({ eq: async () => ({}) }),
    }),
  }),
}));
vi.mock('@/components/icons', () => ({ Icons: new Proxy({}, { get: () => () => null }) }));
vi.mock('framer-motion', async () => {
  const react = await import('react');
  const motion = new Proxy(
    {},
    {
      get:
        (_target, tag: string) =>
        ({ children, className, onClick, role }: Record<string, unknown>) =>
          react.createElement(tag, { className, onClick, role }, children as React.ReactNode),
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => react.createElement(react.Fragment, null, children),
  };
});

const { default: ProfilePage } = await import('@/app/(main)/profile/page');

/** 型の上では全部の列を持つ行。テストでは使う列だけを入れる (足りない列は toUserProfile が既定を補う) */
function dbRow(fields: Partial<DbUserProfile>): DbUserProfile {
  return { id: USER_ID, nickname: NICKNAME, ...fields } as DbUserProfile;
}

describe('設定の列の変換 (lib/converter.ts)', () => {
  it('P-1: toUserProfile: show_recipe_author_name が無い行は showRecipeAuthorName が true', () => {
    expect(toUserProfile(dbRow({})).showRecipeAuthorName).toBe(true);
    expect(toUserProfile(dbRow({ show_recipe_author_name: null })).showRecipeAuthorName).toBe(true);
    expect(toUserProfile(dbRow({ show_recipe_author_name: false })).showRecipeAuthorName).toBe(false);
    expect(toUserProfile(dbRow({ show_recipe_author_name: true })).showRecipeAuthorName).toBe(true);
  });

  it('P-2: fromUserProfile: showRecipeAuthorName を show_recipe_author_name に写す。undefined なら書かない', () => {
    expect(fromUserProfile({ showRecipeAuthorName: false })).toEqual({ show_recipe_author_name: false });
    expect(fromUserProfile({ showRecipeAuthorName: true })).toEqual({ show_recipe_author_name: true });
    expect(fromUserProfile({ nickname: NICKNAME })).not.toHaveProperty('show_recipe_author_name');
  });
});

describe('プロフィールの編集画面 (src/app/(main)/profile/page.tsx)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mocks.profileRow = { id: USER_ID, nickname: NICKNAME };
    fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/profile' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ id: USER_ID, nickname: NICKNAME, show_recipe_author_name: body.showRecipeAuthorName }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // 起動時のほかの取得 (バッジ・栄養目標) はこの画面の関心事ではないので失敗扱いにする
      return new Response('{}', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  const buttonByText = (text: string): HTMLButtonElement | undefined =>
    [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text));

  it('P-3: 基本情報タブのニックネームの下に切り替えがラベルと注記つきで出て、外して保存すると PUT /api/profile の本文に showRecipeAuthorName: false が入る', async () => {
    act(() => {
      root = createRoot(container);
    });
    act(() => {
      root.render(h(ProfilePage));
    });
    // 描画のあとの useEffect (初期の読み込み) を流す
    await act(async () => {});

    const openBasic = buttonByText('基本情報');
    expect(openBasic, '「基本情報」の入口').toBeDefined();
    act(() => {
      openBasic!.click();
    });

    const checkbox = container.querySelector<HTMLInputElement>(`#${SETTING_INPUT_ID}`);
    expect(checkbox, '切り替えがある').not.toBeNull();
    expect(checkbox!.type).toBe('checkbox');
    // 列の無い行でも既定 (出す) で表示する
    expect(checkbox!.checked).toBe(true);
    const label = container.querySelector(`label[for="${SETTING_INPUT_ID}"]`);
    expect(label?.textContent).toBe(RECIPE_AUTHOR_NAME_SETTING_LABEL);
    const block = checkbox!.closest('div')?.parentElement;
    expect(block?.textContent).toContain(RECIPE_AUTHOR_NAME_SETTING_NOTE);

    // ニックネームの欄のすぐ下に置く (ニックネームの欄と同じ親の、すぐ次の要素)
    const nicknameLabel = [...container.querySelectorAll('label')].find((l) => l.textContent === 'ニックネーム');
    expect(nicknameLabel, 'ニックネームの欄').toBeDefined();
    expect(nicknameLabel!.parentElement?.nextElementSibling).toBe(block);

    act(() => {
      checkbox!.click();
    });
    expect(checkbox!.checked).toBe(false);

    const save = buttonByText('変更を保存');
    expect(save, '保存のボタン').toBeDefined();
    await act(async () => {
      save!.click();
    });

    const putCalls = fetchMock.mock.calls.filter(([input, init]) => input === '/api/profile' && init?.method === 'PUT');
    expect(putCalls).toHaveLength(1);
    const sent = JSON.parse(String(putCalls[0][1]?.body)) as Record<string, unknown>;
    expect(sent.showRecipeAuthorName).toBe(false);
  });
});
