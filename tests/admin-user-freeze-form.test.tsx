/**
 * #1917 運営の凍結の画面 (/admin/users/{id}/freeze) の凍結・凍結解除のフォーム (UserFreezeForm)
 *
 * 以前はサーバーコンポーネントの <form action="/api/admin/users/{id}/freeze" method="POST"> だった。ブラウザは本文を
 * application/x-www-form-urlencoded で送るが、API は JSON (request.json()) だけを受けるため、凍結も解除も
 * 400 INVALID_JSON の JSON がそのまま画面に出て動かなかった。解除の隠し項目 _method=DELETE も route は読まない。
 *
 * 確認すること:
 *   - 凍結は JSON で POST、解除は JSON で DELETE する (_method は送らない)。duration_days は一時 BAN のときだけ数値で送る
 *   - フォームが送った本文を、本物の route (POST / DELETE) がそのまま受けて凍結・解除する (送る形と API の形がずれない)
 *   - 入力の誤り (カテゴリ未選択・詳細が空・期間の範囲外・解除理由が空) は送らずに画面で知らせる
 *   - 成功したら結果を出し、ページを読み直す (router.refresh)
 *   - 409 CONFLICT_STALE_DATA (読んでから書くまでに対象が super_admin になった等) は API の文を出し、ページを読み直す。
 *     同じ 409 でも別の code や、403 などは文を出すだけ (読み直さない)
 *   - 永久 BAN の選択肢は super_admin だけ。送信中は二重に送れない
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する
 * (tests/admin-moderation-review-form.test.tsx と同じ方法)。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDb, type SchemaDb } from './helpers/schema-checked-db';
import { profileRow, uuid } from './helpers/route-world';

const refreshMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const mockRequireRole = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

/** service_role の client が見る DB (利用者の行) */
let serviceDb: SchemaDb;
/** 運営本人のセッションの client が見る DB (監査ログ) */
let sessionDb: SchemaDb;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({ from: (table: string) => sessionDb.from(table) }),
  getSupabaseAdmin: () => ({ from: (table: string) => serviceDb.from(table) }),
}));

const { default: UserFreezeForm, freezeEndpoint } = await import('@/components/admin/UserFreezeForm');
const route = await import('@/app/api/admin/users/[id]/freeze/route');
const { FreezeBodySchema, UnfreezeBodySchema, FREEZE_DURATION_DAYS_MAX } = await import('@/lib/admin/users-schemas');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FREEZE_BUTTON = '凍結する';
const UNFREEZE_BUTTON = '凍結解除する';
const TARGET_ID = uuid(50);
const ACTOR = { id: uuid(1), email: 'admin@example.com', roles: ['admin'], organization_id: null };
const STALE_MESSAGE = '対象のユーザーの権限が変わったため、凍結しませんでした。画面を読み込み直して、もう一度確認してください';

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function allText() {
  return document.body.textContent ?? '';
}

function buttonByText(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
}

function fieldById<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  expect(el, `#${id} が見つからない`).not.toBeNull();
  return el as T;
}

async function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function selectCategory(value: string) {
  const select = fieldById<HTMLSelectElement>('reason_category');
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function clickRadio(value: string) {
  const radio = document.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`);
  expect(radio, `${value} の選択肢が見つからない`).not.toBeNull();
  await act(async () => {
    radio!.click();
  });
}

async function clickButton(label: string) {
  const button = buttonByText(label);
  expect(button, `${label} のボタンが見つからない`).toBeDefined();
  await act(async () => {
    button!.click();
  });
}

/** 直近の fetch 呼び出しの [URL, init, 送った JSON] */
function lastCall(): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) as Record<string, unknown> };
}

async function renderForm(props: Partial<React.ComponentProps<typeof UserFreezeForm>> = {}) {
  await act(async () => {
    root.render(<UserFreezeForm userId={TARGET_ID} isBanned={false} isSuperAdmin={false} {...props} />);
  });
}

async function fillFreeze(category = 'spam', detail = '大量のスパム投稿') {
  await selectCategory(category);
  await typeInto(fieldById<HTMLTextAreaElement>('reason_detail'), detail);
}

/** fetch を本物の route (POST / DELETE) へつなぐ。本文はフォームが送ったものをそのまま渡す */
function wireFetchToRoute() {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    const handler = init.method === 'DELETE' ? route.DELETE : route.POST;
    return handler(new Request(`http://localhost${url}`, init), { params: Promise.resolve({ id: TARGET_ID }) });
  });
}

const targetNow = () => serviceDb.rows('user_profiles').find((row) => row.id === TARGET_ID);
const auditActions = () => sessionDb.rows('admin_audit_logs').map((row) => row.action_type);

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(ACTOR);
  serviceDb = createSchemaDb({ tables: { user_profiles: [profileRow(TARGET_ID, { roles: ['user'] })] } });
  sessionDb = createSchemaDb({ tables: { admin_audit_logs: [] } });
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

describe('UserFreezeForm: ブラウザのフォームの送信をしない', () => {
  it('凍結のフォームは action / method を持たず、隠し項目 _method も無い (urlencoded で API へ飛ばない)', async () => {
    await renderForm();
    const form = document.querySelector('form');
    expect(form).not.toBeNull();
    expect(form!.getAttribute('action')).toBeNull();
    expect(form!.getAttribute('method')).toBeNull();
    expect(document.querySelector('input[name="_method"]')).toBeNull();
  });

  it('解除のフォームも action / method を持たず、隠し項目 _method も無い', async () => {
    await renderForm({ isBanned: true });
    const form = document.querySelector('form');
    expect(form).not.toBeNull();
    expect(form!.getAttribute('action')).toBeNull();
    expect(form!.getAttribute('method')).toBeNull();
    expect(document.querySelector('input[name="_method"]')).toBeNull();
    expect(allText()).not.toContain('直接呼び出してください');
  });
});

describe('UserFreezeForm: 送る内容', () => {
  it('凍結: JSON で POST する。一時 BAN は duration_days を数値で送り、本文は API の FreezeBodySchema に通る', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { ban_id: 'b', unban_at: null } }));
    await renderForm();

    await fillFreeze('policy_violation', '  規約違反の投稿  ');
    await typeInto(fieldById<HTMLInputElement>('duration_days'), '14');
    await clickButton(FREEZE_BUTTON);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init, body } = lastCall();
    expect(url).toBe(`/api/admin/users/${TARGET_ID}/freeze`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(body).toEqual({
      ban_type: 'temporary',
      reason_category: 'policy_violation',
      reason_detail: '規約違反の投稿',
      duration_days: 14,
    });
    expect(FreezeBodySchema.safeParse(body).success).toBe(true);
  });

  it('凍結: 期間を変えなければ 7 日で送る', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { ban_id: 'b', unban_at: null } }));
    await renderForm();
    await fillFreeze();
    await clickButton(FREEZE_BUTTON);
    expect(lastCall().body.duration_days).toBe(7);
  });

  it('永久 BAN (super_admin): duration_days を送らず、期間の入力欄も出さない', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { ban_id: 'b', unban_at: null } }));
    await renderForm({ isSuperAdmin: true });

    await fillFreeze('abuse', '不正な決済');
    await clickRadio('permanent');
    expect(document.getElementById('duration_days')).toBeNull();
    await clickButton(FREEZE_BUTTON);

    expect(lastCall().body).toEqual({ ban_type: 'permanent', reason_category: 'abuse', reason_detail: '不正な決済' });
    expect(allText()).toContain('永久 BAN で凍結しました');
  });

  it('super_admin でなければ永久 BAN の選択肢を出さない', async () => {
    await renderForm({ isSuperAdmin: false });
    expect(document.querySelector('input[type="radio"][value="permanent"]')).toBeNull();
    expect(document.querySelector('input[type="radio"][value="temporary"]')).not.toBeNull();
  });

  it('解除: JSON で DELETE する。本文は { reason } だけで、API の UnfreezeBodySchema に通る', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { success: true } }));
    await renderForm({ isBanned: true });

    await typeInto(fieldById<HTMLTextAreaElement>('reason'), '  誤検知だった  ');
    await clickButton(UNFREEZE_BUTTON);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init, body } = lastCall();
    expect(url).toBe(`/api/admin/users/${TARGET_ID}/freeze`);
    expect(init.method).toBe('DELETE');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(body).toEqual({ reason: '誤検知だった' });
    expect(UnfreezeBodySchema.safeParse(body).success).toBe(true);
  });

  it('利用者の ID は URL に安全に埋め込む', () => {
    expect(freezeEndpoint('a/b c')).toBe('/api/admin/users/a%2Fb%20c/freeze');
  });
});

describe('UserFreezeForm: 本物の route につないで凍結・解除できる', () => {
  it('凍結: フォームの本文で route が 200 を返し、frozen_at が入り、監査 admin.user.ban が残る', async () => {
    wireFetchToRoute();
    await renderForm();
    await fillFreeze();
    await clickButton(FREEZE_BUTTON);

    expect(targetNow()?.frozen_at).toEqual(expect.any(String));
    expect(targetNow()?.unban_at).toEqual(expect.any(String));
    expect(auditActions()).toEqual(['admin.user.ban']);
    expect(allText()).toContain('7 日間の一時 BAN で凍結しました');
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('解除: フォームの本文で route の DELETE が 200 を返し、frozen_at が消え、監査 admin.user.unban が残る (凍結には入らない)', async () => {
    serviceDb = createSchemaDb({
      tables: {
        user_profiles: [
          profileRow(TARGET_ID, { roles: ['user'], frozen_at: '2026-10-20T00:00:00.000Z', frozen_reason: '[spam] x', frozen_by: ACTOR.id }),
        ],
      },
    });
    wireFetchToRoute();
    await renderForm({ isBanned: true });
    await typeInto(fieldById<HTMLTextAreaElement>('reason'), '誤検知だった');
    await clickButton(UNFREEZE_BUTTON);

    expect(targetNow()?.frozen_at).toBeNull();
    expect(auditActions()).toEqual(['admin.user.unban']);
    expect(allText()).toContain('凍結を解除しました');
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('(以前の形) urlencoded の本文は route が 400 INVALID_JSON で断る — フォームはこの形で送らない', async () => {
    const res = await route.POST(
      new Request(`http://localhost/api/admin/users/${TARGET_ID}/freeze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'reason_category=spam&reason_detail=x&ban_type=temporary&duration_days=7',
      }),
      { params: Promise.resolve({ id: TARGET_ID }) },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_JSON');
    expect(targetNow()?.frozen_at ?? null).toBeNull();
  });
});

describe('UserFreezeForm: 入力の誤りは送らずに知らせる', () => {
  it('理由カテゴリが未選択', async () => {
    await renderForm();
    await typeInto(fieldById<HTMLTextAreaElement>('reason_detail'), '詳細');
    await clickButton(FREEZE_BUTTON);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(allText()).toContain('理由カテゴリを選択してください');
  });

  it('詳細理由が空白だけ', async () => {
    await renderForm();
    await fillFreeze('spam', '   ');
    await clickButton(FREEZE_BUTTON);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(allText()).toContain('詳細理由を入力してください');
  });

  it.each(['0', String(FREEZE_DURATION_DAYS_MAX + 1), '1.5', ''])('BAN 期間が範囲の外・整数でない (%j)', async (value) => {
    await renderForm();
    await fillFreeze();
    await typeInto(fieldById<HTMLInputElement>('duration_days'), value);
    await clickButton(FREEZE_BUTTON);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(allText()).toContain(`BAN 期間は 1〜${FREEZE_DURATION_DAYS_MAX} の整数`);
  });

  it('BAN 期間の上限ちょうどは送る', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { ban_id: 'b', unban_at: null } }));
    await renderForm();
    await fillFreeze();
    await typeInto(fieldById<HTMLInputElement>('duration_days'), String(FREEZE_DURATION_DAYS_MAX));
    await clickButton(FREEZE_BUTTON);
    expect(lastCall().body.duration_days).toBe(FREEZE_DURATION_DAYS_MAX);
  });

  it('解除理由が空白だけ', async () => {
    await renderForm({ isBanned: true });
    await typeInto(fieldById<HTMLTextAreaElement>('reason'), '  ');
    await clickButton(UNFREEZE_BUTTON);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(allText()).toContain('解除理由を入力してください');
  });
});

describe('UserFreezeForm: 失敗のとき', () => {
  it('409 CONFLICT_STALE_DATA: API の文を出し、ページを読み直す (フォームは閉じない)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: { code: 'CONFLICT_STALE_DATA', message: STALE_MESSAGE } }));
    await renderForm();
    await fillFreeze();
    await clickButton(FREEZE_BUTTON);

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(STALE_MESSAGE);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(buttonByText(FREEZE_BUTTON)).toBeDefined();
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it('本物の route で、読んでから書くまでに対象が super_admin になった: 409 の文が出て読み直し、凍結されない', async () => {
    wireFetchToRoute();
    // 凍結の UPDATE が DB に届く直前に、別の運営が対象を super_admin にする (tests/user-freeze-super-admin-race.test.ts と同じ割り込み方)
    const realFrom = serviceDb.from;
    let interleaved = false;
    serviceDb.from = vi.fn((table: string) => {
      const query = realFrom(table);
      if (table !== 'user_profiles') return query;
      let isUpdate = false;
      const update = query.update.bind(query);
      query.update = (values) => {
        isUpdate = true;
        return update(values);
      };
      type Result = Awaited<ReturnType<typeof query.maybeSingle>>;
      const maybeSingle = query.maybeSingle.bind(query);
      query.maybeSingle = async (): Promise<Result> => {
        if (isUpdate && !interleaved) {
          interleaved = true;
          await realFrom('user_profiles').update({ roles: ['super_admin'] }).eq('id', TARGET_ID);
        }
        return maybeSingle();
      };
      return query;
    });

    await renderForm();
    await fillFreeze();
    await clickButton(FREEZE_BUTTON);

    expect(interleaved).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(STALE_MESSAGE);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(targetNow()?.frozen_at ?? null).toBeNull();
    expect(auditActions()).toEqual([]);
  });

  it('403 OP_TARGET_PROTECTED: API の文を出すだけで、読み直さない', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, { error: { code: 'OP_TARGET_PROTECTED', message: 'super_admin ユーザーを凍結することはできません' } }),
    );
    await renderForm();
    await fillFreeze();
    await clickButton(FREEZE_BUTTON);

    expect(document.querySelector('[role="alert"]')?.textContent).toBe('super_admin ユーザーを凍結することはできません');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('409 でも code が CONFLICT_STALE_DATA でなければ読み直さない', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: { code: 'OTHER_CONFLICT', message: '別の衝突' } }));
    await renderForm({ isBanned: true });
    await typeInto(fieldById<HTMLTextAreaElement>('reason'), '理由');
    await clickButton(UNFREEZE_BUTTON);

    expect(document.querySelector('[role="alert"]')?.textContent).toBe('別の衝突');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('本文の無い 500: HTTP の番号つきの固定の文を出す', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: () => Promise.reject(new Error('not json')) });
    await renderForm({ isBanned: true });
    await typeInto(fieldById<HTMLTextAreaElement>('reason'), '理由');
    await clickButton(UNFREEZE_BUTTON);

    expect(document.querySelector('[role="alert"]')?.textContent).toBe('凍結解除できませんでした (HTTP 500)。もう一度お試しください');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('401: ログインし直すよう知らせる', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }));
    await renderForm();
    await fillFreeze();
    await clickButton(FREEZE_BUTTON);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('ログインの有効期限が切れました。ログインし直してください');
  });

  it('通信の失敗: 状態を確かめるよう知らせる', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    await renderForm();
    await fillFreeze();
    await clickButton(FREEZE_BUTTON);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('通信に失敗しました');
    expect(buttonByText(FREEZE_BUTTON)).toBeDefined();
  });
});

describe('UserFreezeForm: 二重に送れない', () => {
  it('送信中はボタンが押せず、もう一度押しても fetch は 1 回だけ', async () => {
    let resolve!: (value: ReturnType<typeof jsonResponse>) => void;
    fetchMock.mockReturnValue(
      new Promise<ReturnType<typeof jsonResponse>>((r) => {
        resolve = r;
      }),
    );
    await renderForm();
    await fillFreeze();
    await clickButton(FREEZE_BUTTON);

    const pending = buttonByText('凍結中');
    expect(pending?.disabled).toBe(true);
    await act(async () => {
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve(jsonResponse(200, { data: { ban_id: 'b', unban_at: null } }));
    });
    expect(allText()).toContain('凍結しました');
  });
});
