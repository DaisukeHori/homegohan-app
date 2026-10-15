/**
 * #1735 組織の設定 (/org/settings): 画面が送るキーを route が全部受け取り、保存した値が GET で返ること
 *
 * 以前は、画面が業種・従業員数・連絡先を camelCase のキー (industry / employeeCount / contactEmail / contactName) で送り、
 * route のスキーマ (name / plan だけ) がそれを捨てたまま 200 を返し、画面は「設定を保存しました」と出していた。
 * GET も { data } を返すのに画面は organization を読んでいたので、保存されている値も画面に出なかった。
 *
 * 確かめること:
 *  1. route のスキーマのキーは「画面が保存する項目 (ORG_SETTINGS_FORM_KEYS) + plan」と一致する
 *     (どちらかのキーが増減・改名されると赤になる)。
 *  2. 画面の本文を作る関数 (buildOrgSettingsUpdateBody) の出力のキーは ORG_SETTINGS_FORM_KEYS と一致し、
 *     route のスキーマを通しても 1 つも落ちない。
 *  3. PUT で保存した値が organizations の列に書かれ、GET で返る。空欄は null で消える。送らなかったキーは変わらない。
 *  4. Web の画面 (src/app/(org)/org/settings/page.tsx) を描画し、入力 → 保存 → 読み込み直し で値が残る
 *     (画面の fetch を route の handler につなぐ)。route が失敗を返したときは「保存しました」を出さない。
 * モバイルの画面が送るキーは apps/mobile/__tests__/app/org/settings-screen.test.tsx が ORG_SETTINGS_FORM_KEYS と突き合わせる。
 *
 * DB のモックは tests/helpers/schema-checked-db.ts (存在しない列への読み書きは本物の PostgREST と同じエラーになる)。
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ORG_CONTACT_EMAIL_MAX_LENGTH,
  ORG_CONTACT_NAME_MAX_LENGTH,
  ORG_EMPLOYEE_COUNT_MAX,
  ORG_EMPLOYEE_COUNT_MIN,
  ORG_INDUSTRY_MAX_LENGTH,
  ORG_SETTINGS_NAME_MAX_LENGTH,
  ORG_SETTINGS_EMPLOYEE_COUNT_MESSAGE,
  ORG_SETTINGS_FORM_KEYS,
  buildOrgSettingsUpdateBody,
  orgSettingsFormValuesOf,
  type OrgSettingsData,
} from '@homegohan/shared';
import { createSchemaDb, type Row, type SchemaDb } from './helpers/schema-checked-db';
import { jsonRequest, makeClient, profileRow, uuid, type FakeUser } from './helpers/route-world';

// ─────────────────────────────────────────────────────────────────────────────
// モック
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withUser: vi.fn() }),
  generateRequestId: () => 'req_test',
}));

let sessionUser: FakeUser | null = null;
let sessionDb: SchemaDb;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => makeClient(sessionDb, sessionUser),
  getSupabaseAdmin: () => makeClient(sessionDb, null),
}));

const settings = await import('@/app/api/org/settings/route');
const { OrgSettingsUpdateFieldsSchema, OrgSettingsUpdateSchema, toOrgSettingsUpdateRow } = await import(
  '@/lib/org-settings-api'
);
const { default: OrgSettingsPage } = await import('@/app/(org)/org/settings/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─────────────────────────────────────────────────────────────────────────────
// テストデータ
// ─────────────────────────────────────────────────────────────────────────────

const ORG_A = uuid(100);
const ORG_B = uuid(200);
const OWNER_A = uuid(1);

/** route のスキーマが受け取るキーのうち、画面が送らないもの (プランは画面では表示だけ) */
const ROUTE_ONLY_KEYS = ['plan'] as const;

/** 画面の入力欄に入れる値と、保存されるはずの値 */
const FILLED_FORM = {
  name: '  ほげ株式会社  ',
  industry: '製造',
  employeeCount: '120',
  contactEmail: 'hr@example.com',
  contactName: '人事 太郎',
};
const SAVED = {
  name: 'ほげ株式会社',
  industry: '製造',
  employee_count: 120,
  contact_email: 'hr@example.com',
  contact_name: '人事 太郎',
};

function worldTables(): Record<string, Row[]> {
  return {
    user_profiles: [profileRow(OWNER_A, { organization_id: ORG_A, org_role: 'owner', roles: ['user'] })],
    organizations: [
      {
        id: ORG_A,
        name: 'A 株式会社',
        plan: 'standard',
        industry: 'IT',
        employee_count: 30,
        contact_email: 'old@example.com',
        contact_name: '前の担当',
        subscription_status: 'active',
        subscription_expires_at: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: ORG_B,
        name: 'B 株式会社',
        plan: 'premium',
        industry: '小売',
        employee_count: 5,
        contact_email: null,
        contact_name: null,
        subscription_status: 'active',
        subscription_expires_at: null,
        created_at: '2026-01-02T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
      },
    ],
  };
}

const orgRow = (id: string) => sessionDb.rows('organizations').find((o) => o.id === id);
const url = (path: string) => `http://localhost${path}`;

beforeEach(() => {
  sessionUser = { id: OWNER_A, email: 'owner@example.com' };
  sessionDb = createSchemaDb({ tables: worldTables() });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. 2. キーの一致
// ─────────────────────────────────────────────────────────────────────────────

describe('画面が送るキーと route のスキーマが受けるキー', () => {
  it('route のスキーマのキー = 画面が保存する項目 + plan', () => {
    expect(Object.keys(OrgSettingsUpdateFieldsSchema.shape).sort()).toEqual(
      [...ORG_SETTINGS_FORM_KEYS, ...ROUTE_ONLY_KEYS].sort(),
    );
  });

  it('画面の本文のキーは ORG_SETTINGS_FORM_KEYS と一致し、route のスキーマを通しても 1 つも落ちない', () => {
    const built = buildOrgSettingsUpdateBody(FILLED_FORM);
    if (!built.ok) throw new Error(built.message);
    expect(Object.keys(built.body).sort()).toEqual([...ORG_SETTINGS_FORM_KEYS].sort());

    const parsed = OrgSettingsUpdateSchema.safeParse(built.body);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    const row = toOrgSettingsUpdateRow(parsed.data);
    expect(row).toEqual(SAVED);
  });

  it('空欄は null として送られ、route も null のまま受け取る (保存されている値を消す)', () => {
    const built = buildOrgSettingsUpdateBody({ ...FILLED_FORM, industry: ' ', employeeCount: '', contactEmail: '', contactName: '' });
    if (!built.ok) throw new Error(built.message);
    expect(built.body).toEqual({ name: SAVED.name, industry: null, employee_count: null, contact_email: null, contact_name: null });

    const parsed = OrgSettingsUpdateSchema.safeParse(built.body);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    expect(toOrgSettingsUpdateRow(parsed.data)).toEqual(built.body);
  });

  it.each([
    ['小数', '1.5'],
    ['0', '0'],
    ['上限を超える', String(ORG_EMPLOYEE_COUNT_MAX + 1)],
    ['数字でない', 'abc'],
  ])('従業員数が %s のときは本文を作らない (NaN が JSON の null になり、保存されている値を黙って消さない)', (_label, value) => {
    expect(buildOrgSettingsUpdateBody({ ...FILLED_FORM, employeeCount: value })).toEqual({
      ok: false,
      message: ORG_SETTINGS_EMPLOYEE_COUNT_MESSAGE,
    });
  });

  it('従業員数は下限・上限ちょうどなら送る。理由の文は範囲を 3 桁区切りで出す', () => {
    for (const value of [ORG_EMPLOYEE_COUNT_MIN, ORG_EMPLOYEE_COUNT_MAX]) {
      const built = buildOrgSettingsUpdateBody({ ...FILLED_FORM, employeeCount: String(value) });
      expect(built).toMatchObject({ ok: true, body: { employee_count: value } });
    }
    expect(ORG_SETTINGS_EMPLOYEE_COUNT_MESSAGE).toBe('従業員数は 1 から 1,000,000 までの整数で入力してください');
  });

  it('組織名が空白だけなら本文を作らない', () => {
    expect(buildOrgSettingsUpdateBody({ ...FILLED_FORM, name: '   ' }).ok).toBe(false);
  });

  it.each([
    ['組織名', 'name', ORG_SETTINGS_NAME_MAX_LENGTH],
    ['業種', 'industry', ORG_INDUSTRY_MAX_LENGTH],
    ['担当者名', 'contact_name', ORG_CONTACT_NAME_MAX_LENGTH],
  ])('%s は上限の文字数まで受け、1 文字超えると拒む', (_label, key, max) => {
    expect(OrgSettingsUpdateSchema.safeParse({ [key]: 'あ'.repeat(max) }).success).toBe(true);
    expect(OrgSettingsUpdateSchema.safeParse({ [key]: 'あ'.repeat(max + 1) }).success).toBe(false);
  });

  it('連絡先メールは上限の文字数まで受け、1 文字超えると拒む', () => {
    const domain = '@example.com';
    const local = (n: number) => 'a'.repeat(n - domain.length);
    expect(OrgSettingsUpdateSchema.safeParse({ contact_email: local(ORG_CONTACT_EMAIL_MAX_LENGTH) + domain }).success).toBe(true);
    expect(OrgSettingsUpdateSchema.safeParse({ contact_email: local(ORG_CONTACT_EMAIL_MAX_LENGTH + 1) + domain }).success).toBe(false);
  });

  it('従業員数は route でも下限・上限ちょうどを受け、外を拒む', () => {
    expect(OrgSettingsUpdateSchema.safeParse({ employee_count: ORG_EMPLOYEE_COUNT_MIN }).success).toBe(true);
    expect(OrgSettingsUpdateSchema.safeParse({ employee_count: ORG_EMPLOYEE_COUNT_MAX }).success).toBe(true);
    expect(OrgSettingsUpdateSchema.safeParse({ employee_count: ORG_EMPLOYEE_COUNT_MIN - 1 }).success).toBe(false);
    expect(OrgSettingsUpdateSchema.safeParse({ employee_count: ORG_EMPLOYEE_COUNT_MAX + 1 }).success).toBe(false);
  });

  it('plan は従来どおり受け取り、行に入れる (画面は送らない)', () => {
    const parsed = OrgSettingsUpdateSchema.safeParse({ plan: 'premium' });
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    expect(toOrgSettingsUpdateRow(parsed.data)).toEqual({ plan: 'premium' });
    expect(OrgSettingsUpdateSchema.safeParse({ plan: 'free' }).success).toBe(false);
  });

  it('GET の data から入力欄の初期値を作る (null は空欄)', () => {
    const data = { ...worldTables().organizations[0], contact_name: null, employee_count: null } as OrgSettingsData;
    expect(orgSettingsFormValuesOf(data)).toEqual({
      name: 'A 株式会社',
      industry: 'IT',
      employeeCount: '',
      contactEmail: 'old@example.com',
      contactName: '',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. route: 保存した値が GET で返る
// ─────────────────────────────────────────────────────────────────────────────

describe('PUT /api/org/settings → GET /api/org/settings', () => {
  it('画面が送る本文で保存した値が organizations に書かれ、GET で返る。他組織は変わらない', async () => {
    const built = buildOrgSettingsUpdateBody(FILLED_FORM);
    if (!built.ok) throw new Error(built.message);

    const put = await settings.PUT(jsonRequest(url('/api/org/settings'), 'PUT', built.body));
    expect(put.status).toBe(200);
    expect((await put.json()).data).toMatchObject({ id: ORG_A, ...SAVED });
    expect(orgRow(ORG_A)).toMatchObject(SAVED);

    const got = await settings.GET();
    expect(got.status).toBe(200);
    expect((await got.json()).data).toMatchObject({ id: ORG_A, plan: 'standard', subscription_status: 'active', ...SAVED });

    expect(orgRow(ORG_B)).toMatchObject({ name: 'B 株式会社', industry: '小売', employee_count: 5 });
  });

  it('空文字・null は null で消える。送らなかったキーは変わらない', async () => {
    const put = await settings.PUT(
      jsonRequest(url('/api/org/settings'), 'PUT', { industry: '', contact_email: '', contact_name: null }),
    );
    expect(put.status).toBe(200);
    expect(orgRow(ORG_A)).toMatchObject({
      name: 'A 株式会社',
      employee_count: 30,
      industry: null,
      contact_email: null,
      contact_name: null,
    });
    expect((await (await settings.GET()).json()).data).toMatchObject({ industry: null, contact_email: null, employee_count: 30 });
  });

  it.each([
    ['従業員数が 0', { employee_count: 0 }],
    ['従業員数が小数', { employee_count: 1.5 }],
    ['従業員数が文字列', { employee_count: '120' }],
    ['連絡先メールが形でない', { contact_email: 'not-an-email' }],
  ])('%s は 400 で、何も書かない', async (_label, body) => {
    const before = { ...orgRow(ORG_A) };
    const put = await settings.PUT(jsonRequest(url('/api/org/settings'), 'PUT', body));
    expect(put.status).toBe(400);
    expect((await put.json()).error.code).toBe('VALIDATION_ERROR');
    expect(orgRow(ORG_A)).toEqual(before);
  });

  it('知っているキーが 1 つも無い本文は 400 (更新する項目なし)', async () => {
    const put = await settings.PUT(jsonRequest(url('/api/org/settings'), 'PUT', { employeeCount: 120 }));
    expect(put.status).toBe(400);
    expect((await put.json()).error.code).toBe('VALIDATION_ERROR');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Web の画面
// ─────────────────────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
/** 画面が PUT で送った本文 */
const sentBodies: unknown[] = [];

/** 画面の fetch を route の handler につなぐ */
function routeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  expect(path).toBe('/api/org/settings');
  const method = init?.method ?? 'GET';
  if (method === 'GET') return settings.GET();
  sentBodies.push(JSON.parse(String(init?.body)));
  return settings.PUT(new Request(url(path), { method, headers: init?.headers, body: init?.body }));
}

/**
 * 画面の fetch → route の handler → 描画の更新まで待つための、マクロタスクの回数
 * (route は認可・DB の読み書きで数回 await する。1 回では描画まで届かない)
 */
const FLUSH_TICKS = 10;

async function flush() {
  await act(async () => {
    for (let i = 0; i < FLUSH_TICKS; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPage() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<OrgSettingsPage />);
  });
  await flush();
}

function input(id: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(`#${id}`);
  if (!el) throw new Error(`input #${id} が無い`);
  return el;
}

async function type(id: string, value: string) {
  const el = input(id);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit() {
  const form = container.querySelector('form');
  if (!form) throw new Error('form が無い');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
}

const FIELD_IDS = {
  name: 'org-settings-name',
  industry: 'org-settings-industry',
  employeeCount: 'org-settings-employee-count',
  contactEmail: 'org-settings-contact-email',
  contactName: 'org-settings-contact-name',
} as const;

function fieldValues() {
  return {
    name: input(FIELD_IDS.name).value,
    industry: input(FIELD_IDS.industry).value,
    employeeCount: input(FIELD_IDS.employeeCount).value,
    contactEmail: input(FIELD_IDS.contactEmail).value,
    contactName: input(FIELD_IDS.contactName).value,
  };
}

describe('Web の組織の設定の画面', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(routeFetch);
    sentBodies.length = 0;
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('保存されている値を入力欄に出す (GET の data を読む)', async () => {
    await renderPage();
    expect(fieldValues()).toEqual({
      name: 'A 株式会社',
      industry: 'IT',
      employeeCount: '30',
      contactEmail: 'old@example.com',
      contactName: '前の担当',
    });
  });

  it('入力 → 保存で、送ったキーは route のスキーマが全部受け取り、読み込み直しても値が残る', async () => {
    await renderPage();
    for (const [key, id] of Object.entries(FIELD_IDS)) {
      await type(id, FILLED_FORM[key as keyof typeof FILLED_FORM]);
    }
    await submit();

    expect(sentBodies).toHaveLength(1);
    const sent = sentBodies[0] as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual([...ORG_SETTINGS_FORM_KEYS].sort());
    const schemaKeys = Object.keys(OrgSettingsUpdateFieldsSchema.shape);
    expect(Object.keys(sent).filter((k) => !schemaKeys.includes(k))).toEqual([]);

    expect(container.querySelector('[role="status"]')?.textContent).toBe('設定を保存しました');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(orgRow(ORG_A)).toMatchObject(SAVED);
    // 保存の直後も、route が返した保存後の値 (前後の空白を除いた組織名) を出す
    expect(fieldValues()).toEqual({ ...FILLED_FORM, name: SAVED.name });

    // 読み込み直す
    act(() => root.unmount());
    container.remove();
    await renderPage();
    expect(fieldValues()).toEqual({ ...FILLED_FORM, name: SAVED.name });
  });

  it('route が 400 を返したときは「保存しました」を出さず、理由を出す', async () => {
    await renderPage();
    // 入力欄の type="email" の検査は submit イベントを直接送ると効かないので、route の検査まで届く
    await type(FIELD_IDS.contactEmail, 'not-an-email');
    await submit();

    expect(sentBodies).toHaveLength(1);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('入力内容を確認してください');
    expect(orgRow(ORG_A)).toMatchObject({ contact_email: 'old@example.com' });
  });

  it('従業員数が整数でないときは送らず、理由を出す', async () => {
    await renderPage();
    await type(FIELD_IDS.employeeCount, '1.5');
    await submit();

    expect(sentBodies).toHaveLength(0);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(ORG_SETTINGS_EMPLOYEE_COUNT_MESSAGE);
    expect(orgRow(ORG_A)).toMatchObject({ employee_count: 30 });
  });
});
