/**
 * 管理の画面の書き込みの操作が、失敗の応答を黙って捨てないことのテスト
 * (クーポンの停止・再開と機能パッケージの廃止 (tests/super-admin-status-change-errors.test.tsx) と同じ型を、ほかの管理の画面で探したもの)
 *
 *   - サポートの利用者の詳細 (/support/users) のメモの追加: 以前は `if (res.ok) { ... }` だけで、失敗しても何も出さず
 *     入力欄もそのままだった (追加できたか分からない)
 *   - 組織の部署 (/org/departments) の追加・更新・削除: 以前は `if (res.ok) { ... }` だけで、名前の誤り (400)・
 *     参照されている部署の削除 (409 DEPARTMENT_IN_USE)・500 のとき何も出さなかった
 *   - 組織の招待 (/org/invites) の取消: 失敗の本文が JSON でない・通信エラーのときに console に書くだけだった
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '33333333-3333-4333-8333-333333333333';

vi.mock('next/navigation', () => ({
  // サポートの利用者の画面は ?id= の利用者の詳細を開いた状態で始める
  useSearchParams: () => new URLSearchParams(`id=${USER_ID}`),
}));

// アニメーションは本題ではないので、motion.* は同じタグの素の要素、AnimatePresence は子をそのまま返す
vi.mock('framer-motion', () => {
  const MOTION_ONLY_PROPS = ['initial', 'animate', 'exit'];
  const cache = new Map<string, unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        if (!cache.has(tag)) {
          cache.set(tag, (props: Record<string, unknown>) =>
            createElement(
              tag,
              Object.fromEntries(Object.entries(props).filter(([key]) => key !== 'children' && !MOTION_ONLY_PROPS.includes(key))),
              props.children as React.ReactNode,
            ),
          );
        }
        return cache.get(tag);
      },
    },
  );
  return { motion, AnimatePresence: (props: { children?: React.ReactNode }) => props.children ?? null };
});

const { default: SupportUsersPage } = await import('@/app/(support)/support/users/page');
const { default: OrgDepartmentsPage } = await import('@/app/(org)/org/departments/page');
const { default: OrgInvitesPage } = await import('@/app/(org)/org/invites/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 本文が JSON でない応答 (プロキシの 502 など) */
function htmlResponse(status: number) {
  return new Response('<html>Bad Gateway</html>', { status, headers: { 'content-type': 'text/html' } });
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let alertSpy: ReturnType<typeof vi.fn>;

type Handler = (method: string, url: URL, body: unknown) => Response | Promise<Response>;

function mockFetch(handler: Handler) {
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    return handler(method, url, body);
  });
  vi.stubGlobal('fetch', fetchMock);
}

const callsOf = (method: string, pathname: string) =>
  fetchMock.mock.calls.filter(([input, init]) => {
    const m = ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
    return m === method && new URL(String(input), 'http://localhost').pathname === pathname;
  });

const text = () => container.textContent ?? '';
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPage(component: () => React.ReactNode) {
  await act(async () => {
    root.render(createElement(component));
  });
  await settle();
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
}

async function click(element: HTMLElement | undefined, what: string) {
  expect(element, `${what}が見つからない`).toBeDefined();
  await act(async () => {
    element!.click();
  });
  await settle();
}

async function typeInto(element: HTMLInputElement | null, value: string) {
  expect(element, '入力欄が見つからない').not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(element, value);
    element!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submitForm() {
  const form = container.querySelector('form');
  expect(form, 'フォームが見つからない').not.toBeNull();
  await act(async () => {
    form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  alertSpy = vi.fn();
  vi.stubGlobal('alert', alertSpy);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// サポートの利用者の詳細: メモの追加
// ─────────────────────────────────────────────────────────────────────────────

describe('サポートの利用者の詳細: メモの追加の失敗を画面に出す', () => {
  const NOTES_PATH = `/api/support/users/${USER_ID}/notes`;

  function userDetail(notes: Array<{ id: string; note: string }> = []) {
    return {
      user: {
        id: USER_ID,
        nickname: 'サポート対象さん',
        ageGroup: '30s',
        gender: 'female',
        roles: ['user'],
        organizationId: null,
        isBanned: false,
        bannedAt: null,
        bannedReason: null,
        lastLoginAt: null,
        loginCount: 1,
        profileCompleteness: 50,
        createdAt: '2026-10-01T03:00:00.000Z',
      },
      stats: { mealCount: 0, aiSessionCount: 0 },
      inquiries: [],
      notes: notes.map((n) => ({ ...n, created_at: '2026-10-01T03:00:00.000Z', admin_id: 'admin-1' })),
    };
  }

  /** 一覧・詳細は読める。メモの追加 (POST) は post() の応答を返す */
  function mockSupportApi(post: () => Response | Promise<Response>) {
    const notes: Array<{ id: string; note: string }> = [];
    mockFetch((method, url, body) => {
      if (method === 'GET' && url.pathname === '/api/admin/users') {
        return jsonResponse(200, { data: [], meta: { total: 0, page: 1, per_page: 50 } });
      }
      if (method === 'GET' && url.pathname === `/api/support/users/${USER_ID}`) return jsonResponse(200, userDetail(notes));
      if (method === 'POST' && url.pathname === NOTES_PATH) {
        return Promise.resolve(post()).then((res) => {
          if (res.ok) notes.push({ id: `note-${notes.length + 1}`, note: (body as { note: string }).note });
          return res;
        });
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
  }

  const noteInput = () => container.querySelector<HTMLInputElement>('input[placeholder="メモを追加..."]');

  async function addNote(value: string) {
    await renderPage(SupportUsersPage);
    await vi.waitFor(() => expect(text()).toContain('サポート対象さん'));
    await typeInto(noteInput(), value);
    await click(findButton('追加'), '「追加」ボタン');
  }

  it.each([
    ['500', () => jsonResponse(500, { error: 'サーバーエラーが発生しました' }), 'サーバーエラーが発生しました'],
    ['404', () => jsonResponse(404, { error: 'ユーザーが見つかりません' }), 'ユーザーが見つかりません'],
    ['403 (二段階認証の確認が要る)', () => jsonResponse(403, { error: '二段階認証の確認が必要です' }), '二段階認証の確認が必要です'],
    ['本文が JSON でない 502', () => htmlResponse(502), 'HTTP 502'],
  ])('メモの追加が %s で断られたら理由を出し、入力したメモは残す', async (_label, post, reason) => {
    mockSupportApi(post);
    await addNote('電話で折り返し済み');

    expect(callsOf('POST', NOTES_PATH)).toHaveLength(1);
    expect(byTestId('note-add-error')).toContain('メモを追加できませんでした');
    expect(byTestId('note-add-error')).toContain(reason);
    expect(noteInput()!.value).toBe('電話で折り返し済み');
  });

  it('403 の本文の文が理由の文でなければ「権限がありません」を出す', async () => {
    mockSupportApi(() => jsonResponse(403, { error: 'Forbidden' }));
    await addNote('メモ');

    expect(byTestId('note-add-error')).toContain('権限がありません');
    expect(byTestId('note-add-error')).not.toContain('Forbidden');
  });

  it('通信エラーでも理由を出し、入力したメモは残す', async () => {
    mockSupportApi(() => Promise.reject(new TypeError('Failed to fetch')));
    await addNote('電話で折り返し済み');

    expect(byTestId('note-add-error')).toContain('通信エラー');
    expect(noteInput()!.value).toBe('電話で折り返し済み');
  });

  it('成功したら入力欄を空にしてメモを読み直し、前の失敗の文を消す', async () => {
    let attempt = 0;
    mockSupportApi(() => {
      attempt += 1;
      return attempt === 1 ? jsonResponse(500, { error: 'サーバーエラーが発生しました' }) : jsonResponse(201, { note: {} });
    });
    await addNote('電話で折り返し済み');
    expect(byTestId('note-add-error')).not.toBeNull();

    await click(findButton('追加'), '「追加」ボタン');

    await vi.waitFor(() => expect(text()).toContain('電話で折り返し済み'));
    expect(byTestId('note-add-error')).toBeNull();
    expect(noteInput()!.value).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 組織の部署: 追加・更新・削除
// ─────────────────────────────────────────────────────────────────────────────

describe('組織の部署: 追加・更新・削除の失敗を画面に出す', () => {
  const DEPARTMENT = {
    id: 'dept-1',
    name: '営業部',
    parentId: null,
    managerId: null,
    displayOrder: 0,
    memberCount: 2,
    createdAt: '2026-10-01T03:00:00.000Z',
  };

  type DeptApi = {
    post?: () => Response | Promise<Response>;
    put?: () => Response | Promise<Response>;
    del?: () => Response | Promise<Response>;
  };

  function mockDepartmentsApi(api: DeptApi) {
    mockFetch((method, url) => {
      if (url.pathname !== '/api/org/departments') throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
      if (method === 'GET') return jsonResponse(200, { departments: [DEPARTMENT] });
      if (method === 'POST' && api.post) return api.post();
      if (method === 'PUT' && api.put) return api.put();
      if (method === 'DELETE' && api.del) return api.del();
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
  }

  const nameInput = () => container.querySelector<HTMLInputElement>('input[placeholder="例: 営業部"]');
  const deptError = () => byTestId('department-error');

  it('追加が 400 で断られたら理由を出し、フォームと入力した名前は残す', async () => {
    mockDepartmentsApi({
      post: () => jsonResponse(400, { error: { code: 'VALIDATION_ERROR', message: '部署の名前を入力してください (100 文字以内)' } }),
    });
    await renderPage(OrgDepartmentsPage);
    await click(findButton('+ 部署を追加'), '「+ 部署を追加」ボタン');
    await typeInto(nameInput(), '開発部');

    await submitForm();

    expect(callsOf('POST', '/api/org/departments')).toHaveLength(1);
    expect(deptError()).toContain('部署を追加できませんでした');
    expect(deptError()).toContain('部署の名前を入力してください');
    expect(nameInput()!.value).toBe('開発部');
    expect(callsOf('GET', '/api/org/departments')).toHaveLength(1);
  });

  it('更新が 404 で断られたら理由を出し、フォームは残す', async () => {
    mockDepartmentsApi({ put: () => jsonResponse(404, { error: { code: 'NOT_FOUND', message: '部署が見つかりません' } }) });
    await renderPage(OrgDepartmentsPage);
    await click(findButton('✏️'), '編集ボタン');
    await typeInto(nameInput(), '第一営業部');

    await submitForm();

    expect(callsOf('PUT', '/api/org/departments')).toHaveLength(1);
    expect(deptError()).toContain('部署を更新できませんでした');
    expect(deptError()).toContain('部署が見つかりません');
    expect(nameInput()!.value).toBe('第一営業部');
  });

  it('追加が通信エラーでも理由を出す', async () => {
    mockDepartmentsApi({ post: () => Promise.reject(new TypeError('Failed to fetch')) });
    await renderPage(OrgDepartmentsPage);
    await click(findButton('+ 部署を追加'), '「+ 部署を追加」ボタン');
    await typeInto(nameInput(), '開発部');

    await submitForm();

    expect(deptError()).toContain('部署を追加できませんでした');
    expect(deptError()).toContain('通信エラー');
  });

  it('参照されている部署の削除 (409 DEPARTMENT_IN_USE) は理由を出し、一覧から消さない', async () => {
    mockDepartmentsApi({
      del: () =>
        jsonResponse(409, {
          error: { code: 'DEPARTMENT_IN_USE', message: 'チャレンジ・招待・子部署から参照されているため削除できません' },
        }),
    });
    await renderPage(OrgDepartmentsPage);

    await click(findButton('🗑'), '削除ボタン');

    expect(callsOf('DELETE', '/api/org/departments')).toHaveLength(1);
    expect(deptError()).toContain('部署を削除できませんでした');
    expect(deptError()).toContain('参照されているため削除できません');
    expect(text()).toContain('営業部');
  });

  it.each([
    ['本文が JSON でない 502', () => htmlResponse(502), 'HTTP 502'],
    ['通信エラー', () => Promise.reject(new TypeError('Failed to fetch')), '通信エラー'],
  ])('削除が %s でも理由を出す', async (_label, del, reason) => {
    mockDepartmentsApi({ del });
    await renderPage(OrgDepartmentsPage);

    await click(findButton('🗑'), '削除ボタン');

    expect(deptError()).toContain('部署を削除できませんでした');
    expect(deptError()).toContain(reason);
  });

  it('失敗のあとに成功したら、失敗の文を消してフォームを閉じる', async () => {
    let attempt = 0;
    mockDepartmentsApi({
      post: () => {
        attempt += 1;
        return attempt === 1
          ? jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'サーバーエラーが発生しました' } })
          : jsonResponse(201, { department: { ...DEPARTMENT, id: 'dept-2', name: '開発部' } });
      },
    });
    await renderPage(OrgDepartmentsPage);
    await click(findButton('+ 部署を追加'), '「+ 部署を追加」ボタン');
    await typeInto(nameInput(), '開発部');
    await submitForm();
    expect(deptError()).not.toBeNull();

    await submitForm();

    expect(deptError()).toBeNull();
    expect(nameInput()).toBeNull();
    expect(callsOf('GET', '/api/org/departments')).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 組織の招待: 取消
// ─────────────────────────────────────────────────────────────────────────────

describe('組織の招待: 取消の失敗を黙って捨てない', () => {
  const INVITE = {
    id: 'inv-1',
    email: 'invitee@example.com',
    role: 'member',
    token: 'tok',
    status: 'pending',
    isExpired: false,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };

  function mockInvitesApi(revoke: () => Response | Promise<Response>) {
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === '/api/org/invites') return jsonResponse(200, { invites: [INVITE] });
      if (method === 'POST' && url.pathname === `/api/org/invites/${INVITE.id}/revoke`) return revoke();
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
  }

  it.each([
    ['本文が JSON でない 502', () => htmlResponse(502)],
    ['通信エラー', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('取消が %s でも、取り消せなかったことを知らせる', async (_label, revoke) => {
    mockInvitesApi(revoke);
    await renderPage(OrgInvitesPage);

    await click(findButton('取消'), '「取消」ボタン');

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(String(alertSpy.mock.calls[0][0])).toContain('招待の取り消しに失敗しました');
  });

  it('取消が本文つきで断られたら、これまでどおり本文の文を知らせる', async () => {
    mockInvitesApi(() => jsonResponse(409, { error: { code: 'INVITE_NOT_PENDING', message: 'この招待はすでに使われています' } }));
    await renderPage(OrgInvitesPage);

    await click(findButton('取消'), '「取消」ボタン');

    expect(alertSpy).toHaveBeenCalledWith('この招待はすでに使われています');
  });
});
