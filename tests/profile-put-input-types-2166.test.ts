// @vitest-environment node
/**
 * #2166 X7: PUT /api/profile が本文の値の型を検査せず、列の型に合わない値で 500 になっていた欠陥の回帰テスト
 *
 * 以前の欠陥:
 *   route は本文を fromUserProfile (lib/converter.ts) で snake_case にしてそのまま user_profiles に update し、
 *   DB の型の失敗 (boolean の列に文字列・integer の列に小数・NOT NULL の列に null など) を internalError の 500 にしていた。
 *
 * 直したあとの不変条件 (src/lib/profile-update-schema.ts):
 *   - 更新できる欄 (fromUserProfile が読む欄) の値が写す先の列の型に合わないときは 400 { error: API_INVALID_JSON_MESSAGE }。DB に触れない
 *   - 型の合う値・null を受ける列の null は今までどおり書く。一覧に無い欄・サーバーが上書きする欄は今までどおり検査しない
 *   - スキーマの欄は fromUserProfile が読む欄と過不足なく、型と null の可否は DDL (baseline と migration) の列と一致する
 *
 * Supabase には接続しない (createClient をモック)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API_INVALID_JSON_MESSAGE } from '@/lib/api/error-responses';
import { fromUserProfile } from '@/lib/converter';
import {
  PG_INTEGER_MAX,
  PG_INTEGER_MIN,
  USER_PROFILE_SERVER_MANAGED_FIELDS,
  USER_PROFILE_UPDATE_FIELDS,
  UserProfileUpdateBodySchema,
  type UserProfileColumnKind,
} from '@/lib/profile-update-schema';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// route を丸ごと読み込むので、負荷の高い機械で既定の時間切れを超えうる (#1605 の同じ型)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

const USER_ID = '40000000-0000-4000-8000-000000000001';
const UPDATED_ROW = { id: USER_ID, nickname: 'テスト', show_recipe_author_name: true };

const h = vi.hoisted(() => ({
  /** from(table) の呼び出しの記録 (DB に触れたか) */
  fromCalls: [] as string[],
  /** user_profiles への update の値 */
  profileUpdates: [] as unknown[],
}));

type QueryResult = { data: unknown; error: unknown };

/** PostgREST のクエリの組み立てのまね。update の値を記録し、await・single・maybeSingle で 1 行を返す */
function queryBuilder(table: string): PromiseLike<QueryResult> {
  const settle = () => Promise.resolve({ data: table === 'user_profiles' ? UPDATED_ROW : null, error: null });
  const builder: PromiseLike<QueryResult> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (onFulfilled: (value: QueryResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
            settle().then(onFulfilled, onRejected);
        }
        if (prop === 'single' || prop === 'maybeSingle') return settle;
        if (prop === 'update' && table === 'user_profiles') {
          return (values: unknown) => {
            h.profileUpdates.push(values);
            return builder;
          };
        }
        return () => builder;
      },
    },
  ) as PromiseLike<QueryResult>;
  return builder;
}

const client = {
  auth: { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) },
  from: (table: string) => {
    h.fromCalls.push(table);
    return queryBuilder(table);
  },
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => client,
}));

vi.mock('@/lib/db-logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    createLogger: vi.fn(() => ({ ...logger, withUser: vi.fn(() => logger) })),
    generateRequestId: vi.fn(() => 'req_test'),
  };
});

function putRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/profile', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function put(body: unknown) {
  const { PUT } = await import('@/app/api/profile/route');
  return PUT(putRequest(body));
}

/** 種類ごとの、列が受ける値 (null 以外) */
const VALID_SAMPLE: Record<UserProfileColumnKind, unknown> = {
  text: 'テキスト',
  date: '2026-11-01',
  time: '07:30',
  integer: 42,
  numeric: 62.5,
  boolean: false,
  textArray: ['a', 'b'],
  integerArray: [3, 7],
  jsonb: { nested: [1, 'x'] },
};

/** 種類ごとの、列が拒む (以前は DB の書き込みで 500 になった) 値 */
const INVALID_SAMPLES: Record<Exclude<UserProfileColumnKind, 'jsonb'>, readonly unknown[]> = {
  text: [123, true, ['a'], { a: 1 }],
  date: [20261101, false],
  time: [730, true],
  integer: ['42', 42.5, true, PG_INTEGER_MAX + 1, PG_INTEGER_MIN - 1],
  numeric: ['abc', '62.5', true, [1]],
  boolean: ['true', 'false', 0, 1, 'yes'],
  textArray: ['a', [1], [true], { a: 'b' }],
  integerArray: [3, ['3'], [3.5], [PG_INTEGER_MAX + 1]],
};

const FIELD_ENTRIES = Object.entries(USER_PROFILE_UPDATE_FIELDS);

beforeEach(() => {
  h.fromCalls.length = 0;
  h.profileUpdates.length = 0;
});

describe('PUT /api/profile: 列の型に合わない値は 400 (#2166 X7)', () => {
  it('showRecipeAuthorName に文字列を送ると 400。DB に触れない (以前は DB の型の失敗で 500)', async () => {
    const res = await put({ showRecipeAuthorName: 'false' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: API_INVALID_JSON_MESSAGE });
    expect(h.fromCalls).toEqual([]);
  });

  it('showRecipeAuthorName は NOT NULL の列なので null も 400', async () => {
    const res = await put({ showRecipeAuthorName: null });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: API_INVALID_JSON_MESSAGE });
    expect(h.fromCalls).toEqual([]);
  });

  const booleanFields = FIELD_ENTRIES.filter(([, spec]) => spec.kind === 'boolean').map(([field]) => field);
  it.each(booleanFields)('boolean の列の欄 %s に文字列 "true" を送ると 400', async (field) => {
    const res = await put({ [field]: 'true' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: API_INVALID_JSON_MESSAGE });
    expect(h.fromCalls).toEqual([]);
  });

  const invalidCases = FIELD_ENTRIES.flatMap(([field, spec]) =>
    spec.kind === 'jsonb' ? [] : INVALID_SAMPLES[spec.kind].map((value) => [field, spec.kind, value] as const),
  );
  it.each(invalidCases)('欄 %s (%s の列) に %j を送ると 400', async (field, _kind, value) => {
    const res = await put({ [field]: value });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: API_INVALID_JSON_MESSAGE });
    expect(h.fromCalls).toEqual([]);
  });

  const notNullFields = FIELD_ENTRIES.filter(([, spec]) => !spec.nullable).map(([field]) => field);
  it.each(notNullFields)('NOT NULL の列の欄 %s に null を送ると 400', async (field) => {
    const res = await put({ [field]: null });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: API_INVALID_JSON_MESSAGE });
    expect(h.fromCalls).toEqual([]);
  });

  it('型の合う欄と合わない欄が混ざった本文も 400 (一部だけ書かない)', async () => {
    const res = await put({ nickname: '花子', showRecipeAuthorName: 'no' });
    expect(res.status).toBe(400);
    expect(h.profileUpdates).toEqual([]);
  });
});

describe('PUT /api/profile: 型の合う本文は今までどおり書く', () => {
  it('showRecipeAuthorName: false はそのまま show_recipe_author_name に書く', async () => {
    const res = await put({ showRecipeAuthorName: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(UPDATED_ROW);
    expect(h.profileUpdates).toHaveLength(1);
    expect(h.profileUpdates[0]).toMatchObject({ show_recipe_author_name: false });
  });

  it('全部の欄に列が受ける値を入れた本文は 200 で、fromUserProfile の変換どおりに書く', async () => {
    const body = Object.fromEntries(FIELD_ENTRIES.map(([field, spec]) => [field, VALID_SAMPLE[spec.kind]]));
    const res = await put(body);
    expect(res.status).toBe(200);
    expect(h.profileUpdates).toHaveLength(1);
    expect(h.profileUpdates[0]).toMatchObject(fromUserProfile(body));
  });

  it('null を受ける列の欄は全部 null で送れる (NOT NULL の列は値を入れる)', async () => {
    const body = Object.fromEntries(
      FIELD_ENTRIES.map(([field, spec]) => [field, spec.nullable ? null : VALID_SAMPLE[spec.kind]]),
    );
    const res = await put(body);
    expect(res.status).toBe(200);
    expect(h.profileUpdates[0]).toMatchObject(fromUserProfile(body));
  });

  it('配列の列は要素の null を通す (DB の配列は null の要素を受ける)', async () => {
    const res = await put({ hobbies: ['料理', null], childrenAges: [5, null] });
    expect(res.status).toBe(200);
    expect(h.profileUpdates[0]).toMatchObject({ hobbies: ['料理', null], children_ages: [5, null] });
  });

  it('一覧に無い欄 (GET の行を送り返したときの id・role・createdAt など) は今までどおり検査せずに無視する', async () => {
    const res = await put({ id: 123, role: ['x'], createdAt: false, unknownField: { a: 1 }, nickname: '太郎' });
    expect(res.status).toBe(200);
    const written = h.profileUpdates[0];
    expect(written).toMatchObject({ nickname: '太郎' });
    expect(written).not.toHaveProperty('id');
    expect(written).not.toHaveProperty('role');
    expect(written).not.toHaveProperty('unknownField');
  });

  it('サーバーが上書きする欄 (profileCompleteness・lastProfileUpdate) は型が違っても今までどおり上書きして書く', async () => {
    const res = await put({ profileCompleteness: 'abc', lastProfileUpdate: 12345 });
    expect(res.status).toBe(200);
    const written = h.profileUpdates[0];
    expect(written).toMatchObject({ profile_completeness: expect.any(Number), last_profile_update: expect.any(String) });
    expect(written).not.toMatchObject({ profile_completeness: 'abc' });
  });

  it('age を送り ageGroup を送らないときは今までどおり年代を入れる', async () => {
    const res = await put({ age: 37 });
    expect(res.status).toBe(200);
    expect(h.profileUpdates[0]).toMatchObject({ age: 37, age_group: '30s' });
  });

  it('age と ageGroup の両方を送ったときは ageGroup のまま', async () => {
    const res = await put({ age: 37, ageGroup: 'unspecified' });
    expect(res.status).toBe(200);
    expect(h.profileUpdates[0]).toMatchObject({ age: 37, age_group: 'unspecified' });
  });

  it('age が null・0 のときは年代を入れない', async () => {
    for (const age of [null, 0]) {
      h.profileUpdates.length = 0;
      const res = await put({ age });
      expect(res.status).toBe(200);
      expect(h.profileUpdates[0]).not.toHaveProperty('age_group');
    }
  });
});

describe('スキーマと fromUserProfile・DDL の突き合わせ', () => {
  it('スキーマの欄 + サーバーが上書きする欄 = fromUserProfile が読む欄 (過不足なし)', () => {
    const read = new Set<string>();
    const recorder = new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop === 'string') read.add(prop);
          return undefined;
        },
      },
    );
    fromUserProfile(recorder);
    const expected = [...Object.keys(USER_PROFILE_UPDATE_FIELDS), ...USER_PROFILE_SERVER_MANAGED_FIELDS].sort();
    expect([...read].sort()).toEqual(expected);
  });

  it('スキーマの shape の欄は USER_PROFILE_UPDATE_FIELDS と同じ', () => {
    expect(Object.keys(UserProfileUpdateBodySchema.shape).sort()).toEqual(Object.keys(USER_PROFILE_UPDATE_FIELDS).sort());
  });

  const ROOT = path.resolve(__dirname, '..');
  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** baseline の CREATE TABLE user_profiles の列 → 型の定義 (引用符を外したもの) */
  function baselineColumns(): Map<string, string> {
    const baseline = fs.readFileSync(path.join(ROOT, 'supabase/baseline/prod_schema.sql'), 'utf8');
    const block = baseline.match(/CREATE TABLE IF NOT EXISTS "public"\."user_profiles" \(\n([\s\S]*?)\n\);/);
    if (!block) throw new Error('baseline に user_profiles の CREATE TABLE が無い');
    const columns = new Map<string, string>();
    for (const line of block[1].split('\n')) {
      const m = line.match(/^\s+"(\w+)" (.+?),?$/);
      if (m) columns.set(m[1], m[2].replace(/"/g, ''));
    }
    return columns;
  }

  function migrationsText(): string {
    const dir = path.join(ROOT, 'supabase/migrations');
    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
      .sort()
      .map((file) => fs.readFileSync(path.join(dir, file), 'utf8'))
      .join('\n');
  }

  /** 種類 → 列の型 (DEFAULT・NOT NULL の前まで) */
  const SQL_TYPE_OF_KIND: Record<UserProfileColumnKind, string> = {
    text: 'text',
    date: 'date',
    time: 'time without time zone',
    integer: 'integer',
    numeric: 'numeric',
    boolean: 'boolean',
    textArray: 'text[]',
    integerArray: 'integer[]',
    jsonb: 'jsonb',
  };

  it('各欄の写す先の列の型と null の可否は DDL と一致する (baseline か migration の ADD COLUMN)', () => {
    const baseline = baselineColumns();
    const migrations = migrationsText();
    const mismatches: string[] = [];
    for (const [field, spec] of FIELD_ENTRIES) {
      const columns = Object.keys(fromUserProfile({ [field]: VALID_SAMPLE[spec.kind] }));
      expect(columns, `${field} は 1 つの列に写る`).toHaveLength(1);
      const column = columns[0];
      const added = migrations.match(new RegExp(`ADD COLUMN IF NOT EXISTS ${escapeRegExp(column)}\\s+([^,;\\n]+)`));
      const definition = baseline.get(column) ?? added?.[1];
      if (!definition) {
        mismatches.push(`${field} → ${column}: DDL に列が無い`);
        continue;
      }
      const sqlType = definition.split(/\s+(?:DEFAULT|NOT NULL|NULL)\b/)[0].trim();
      const nullable = !/\bNOT NULL\b/.test(definition);
      if (sqlType !== SQL_TYPE_OF_KIND[spec.kind]) mismatches.push(`${field} → ${column}: 型 ${sqlType} / スキーマ ${spec.kind}`);
      if (nullable !== spec.nullable) mismatches.push(`${field} → ${column}: null の可否 ${nullable} / スキーマ ${spec.nullable}`);
      const altered = new RegExp(
        `ALTER TABLE\\s+(?:public\\.)?"?user_profiles"?[^;]*ALTER COLUMN\\s+"?${escapeRegExp(column)}"?\\s+(?:SET DATA TYPE|TYPE|SET NOT NULL|DROP NOT NULL)`,
        'i',
      );
      if (altered.test(migrations)) mismatches.push(`${field} → ${column}: migration が型か null の可否を変えている`);
    }
    expect(mismatches).toEqual([]);
  });
});
