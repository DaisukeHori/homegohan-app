// @vitest-environment node
/**
 * #2166 X2: 運営の画面のプラン・機能パッケージの鍵の呼び名を、欄名とエラー文で揃える
 *
 * 問題:
 *   運営の画面の欄名は「プランの鍵」「パッケージの鍵」(#2163) なのに、作成で鍵が重複したときの 409 の文は
 *   『パッケージのキー (package_key) は既に存在します』『プランのキー (plan_key) は既に存在します』で、
 *   プランの作成の検証の文 (PERSONAL_FAMILY_PLAN_KEY_MESSAGE・ORG_PLAN_KEY_PREFIX_MESSAGE) も「プランのキー (plan_key)」だった。
 *   新規作成の画面は欄名「パッケージの鍵 *」の下にこの文をそのまま出すので、運営には同じ欄に 2 つの名前が見えた。
 *
 * このテストが確かめること:
 *   1. 作成の route が一意の違反 (23505) で返す 409 の文が、名前付きの定数 (欄名と同じ呼び名) である
 *   2. 文の呼び名は、運営の画面の欄名 (ソースにある文字) と同じで、英字の項目名を括弧で添える
 *   3. 運営の route・lib・画面のコード (コメントを除く) に、古い呼び名「…のキー (plan_key)」「…のキー (package_key)」が残っていない
 * 限界: 3 は運営の配下 (src/app/api/super-admin・src/lib/super-admin・src/app/super-admin) だけを見る
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ORG_PLAN_KEY_PREFIX_MESSAGE,
  PERSONAL_FAMILY_PLAN_KEY_MESSAGE,
  PLAN_KEY_DUPLICATE_MESSAGE,
} from '@/lib/super-admin/plans-schemas';
import { PACKAGE_KEY_DUPLICATE_MESSAGE } from '@/lib/super-admin/feature-packages-schemas';
import { stripComments } from './helpers/ai-reach';

const mockRequireRole = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

vi.mock('@/lib/admin/audit', () => ({
  recordAdminAudit: vi.fn(async () => undefined),
}));

vi.mock('@/lib/db-logger', () => {
  const logger = { error: () => undefined, warn: () => undefined, info: () => undefined, withUser: () => logger };
  return { createLogger: () => logger, generateRequestId: () => 'req-2166' };
});

/** insert().select().single() が返す結果 */
let insertResult: { data: unknown; error: { code: string; message: string } | null } = { data: null, error: null };
const inserts: string[] = [];

function insertChain(table: string) {
  return {
    insert: () => {
      inserts.push(table);
      return { select: () => ({ single: () => Promise.resolve(insertResult) }) };
    },
  };
}

const fakeClient = { from: (table: string) => insertChain(table) };

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(fakeClient),
  getSupabaseAdmin: () => fakeClient,
}));

const plansRoute = await import('@/app/api/super-admin/plans/route');
const featurePackagesRoute = await import('@/app/api/super-admin/feature-packages/route');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

/** 409 Conflict (作成で鍵が既にある) */
const HTTP_CONFLICT = 409;
/** 一意の制約の違反 (PostgreSQL の SQLSTATE) */
const UNIQUE_VIOLATION = '23505';

const actor = { id: 'sa-2166', email: 'sa@example.com', roles: ['super_admin'], organization_id: null };

function postRequest(url: string, body: unknown): never {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}

type DuplicateCase = {
  name: string;
  post: (request: never) => Promise<Response>;
  url: string;
  body: Record<string, unknown>;
  table: string;
  code: string;
  message: string;
  expectedMessage: string;
};

const DUPLICATE_CASES: readonly DuplicateCase[] = [
  {
    name: 'プランの作成',
    post: (request) => plansRoute.POST(request),
    url: 'http://localhost/api/super-admin/plans',
    body: { plan_key: 'dup_plan_2166', display_name: '重複するプラン', plan_type: 'personal' },
    table: 'subscription_plans',
    code: 'OP_PLAN_KEY_DUPLICATE',
    message: PLAN_KEY_DUPLICATE_MESSAGE,
    expectedMessage: '同じプランの鍵 (plan_key) がすでにあります',
  },
  {
    name: '機能パッケージの作成',
    post: (request) => featurePackagesRoute.POST(request),
    url: 'http://localhost/api/super-admin/feature-packages',
    body: { package_key: 'dup_package_2166', display_name: '重複するパッケージ', feature_flags: ['flag_2166'] },
    table: 'feature_packages',
    code: 'OP_PACKAGE_KEY_DUPLICATE',
    message: PACKAGE_KEY_DUPLICATE_MESSAGE,
    expectedMessage: '同じパッケージの鍵 (package_key) がすでにあります',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  inserts.length = 0;
  mockRequireRole.mockResolvedValue(actor);
});

describe('#2166 X2: 作成で鍵が重複したときの 409 の文は、欄名と同じ呼び名 (鍵)', () => {
  it.each(DUPLICATE_CASES)('$name: 一意の違反 (23505) は 409 と「$expectedMessage」', async (c) => {
    insertResult = {
      data: null,
      error: { code: UNIQUE_VIOLATION, message: 'duplicate key value violates unique constraint' },
    };
    const res = await c.post(postRequest(c.url, c.body));

    expect(res.status).toBe(HTTP_CONFLICT);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe(c.code);
    expect(body.error.message).toBe(c.message);
    expect(c.message).toBe(c.expectedMessage);
    expect(inserts).toEqual([c.table]);
  });
});

type LabelCase = {
  /** 運営の画面の欄名 */
  label: string;
  /** 英字の項目名 */
  field: string;
  /** その欄名を出す画面のソース */
  screens: readonly string[];
  /** その項目について API が返す文 */
  messages: readonly string[];
};

const LABEL_CASES: readonly LabelCase[] = [
  {
    label: 'プランの鍵',
    field: 'plan_key',
    screens: ['src/app/super-admin/plans/page.tsx', 'src/app/super-admin/plans/[id]/page.tsx', 'src/app/super-admin/plans/new/page.tsx'],
    messages: [PLAN_KEY_DUPLICATE_MESSAGE, PERSONAL_FAMILY_PLAN_KEY_MESSAGE, ORG_PLAN_KEY_PREFIX_MESSAGE],
  },
  {
    label: 'パッケージの鍵',
    field: 'package_key',
    screens: ['src/app/super-admin/feature-packages/new/page.tsx', 'src/app/super-admin/feature-packages/[id]/page.tsx'],
    messages: [PACKAGE_KEY_DUPLICATE_MESSAGE],
  },
];

describe('#2166 X2: API の文の呼び名は、運営の画面の欄名と同じ (英字の項目名は括弧で添える)', () => {
  it.each(LABEL_CASES)('$label ($field)', ({ label, field, screens, messages }) => {
    for (const screen of screens) {
      expect(stripComments(read(screen)).includes(label), `${screen} に欄名「${label}」がある`).toBe(true);
    }
    for (const message of messages) {
      expect(message.includes(`${label} (${field})`), message).toBe(true);
      expect(message.includes(`のキー (${field})`), message).toBe(false);
    }
  });
});

/** 古い呼び名を探す運営の配下 */
const OPERATOR_SOURCE_DIRS = ['src/app/api/super-admin', 'src/lib/super-admin', 'src/app/super-admin'] as const;
/** 古い呼び名 (英字の項目名を添えた「キー」) */
const STALE_KEY_WORDINGS = ['のキー (plan_key)', 'のキー (package_key)'] as const;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

function sourceFilesUnder(relativeDir: string): string[] {
  const absolute = path.join(ROOT, relativeDir);
  return fs
    .readdirSync(absolute, { recursive: true, encoding: 'utf-8' })
    .filter((entry) => SOURCE_EXTENSIONS.has(path.extname(entry)))
    .map((entry) => path.join(relativeDir, entry));
}

describe('#2166 X2: 運営のコードに古い呼び名「…のキー (plan_key / package_key)」が残っていない', () => {
  it('判定はコメントを除いた本文の文字で見る', () => {
    const source = "// プランのキー (plan_key)\nconst m = 'プランの鍵 (plan_key)';";
    const text = stripComments(source);
    expect(STALE_KEY_WORDINGS.some((wording) => text.includes(wording))).toBe(false);
    expect(STALE_KEY_WORDINGS.some((wording) => "const m = 'プランのキー (plan_key)';".includes(wording))).toBe(true);
  });

  it('違反が 0 件', () => {
    const files = OPERATOR_SOURCE_DIRS.flatMap(sourceFilesUnder);
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap((file) => {
      const text = stripComments(read(file));
      return STALE_KEY_WORDINGS.filter((wording) => text.includes(wording)).map((wording) => `${file}「${wording}」`);
    });
    expect(violations).toEqual([]);
  });
});
