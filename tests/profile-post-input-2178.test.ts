// @vitest-environment node
/**
 * #2178 Y1-a: POST /api/profile が本文に無い欄を仮置きの値で上書きし、値の型も検査していなかった欠陥の回帰テスト
 *
 * 以前の欠陥:
 *   route は本文の欄を列に写したあと、nickname が無ければ 'Guest'・gender / age_group が無ければ 'unspecified' を補い、
 *   user_profiles に upsert していた。upsert は既存の行の該当の列も書き換えるので、週間献立の画面が
 *   { servingsConfig } か { radarChartNutrients } だけを送ると、既存の nickname・gender・age_group が仮置きの値に上書きされた。
 *   本文の値の型も見ずに写していたため、配列の列に文字列などは DB に拒まれ 500 になった。
 *
 * 直したあとの不変条件 (src/app/api/profile/route.ts・src/lib/profile-update-schema.ts の USER_PROFILE_POST_FIELDS):
 *   - 行があるときは本文の欄だけを update する。仮置きの値は行が無いときの insert にだけ入れる
 *   - 欄の値が写す先の列の型に合わないときは 400 { error: API_INVALID_JSON_MESSAGE }。DB に触れない
 *   - 欄と列・型の対応は DDL (baseline と migration) の列と一致する
 *
 * Supabase には接続しない (createClient をモック)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API_INVALID_JSON_MESSAGE } from '@/lib/api/error-responses';
import {
  PG_INTEGER_MAX,
  USER_PROFILE_POST_FIELDS,
  UserProfilePostBodySchema,
  type UserProfileColumnKind,
} from '@/lib/profile-update-schema';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// route を丸ごと読み込むので、負荷の高い機械で既定の時間切れを超えうる (#1605 の同じ型)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

const USER_ID = '40000000-0000-4000-8000-000000000002';
/** 既にある行 (利用者が登録した名前・性別・年代) */
const EXISTING_ROW = { id: USER_ID, nickname: '花子', gender: 'female', age_group: '30s' };
const UNIQUE_VIOLATION = { code: '23505', message: 'duplicate key value violates unique constraint' };

type Op = 'select' | 'update' | 'insert' | 'upsert';
type QueryResult = { data: unknown; error: unknown };
type ProfileWrite = { op: Exclude<Op, 'select'>; values: Record<string, unknown>; eq: [string, unknown][] };

const h = vi.hoisted(() => ({
  /** from(table) の呼び出しの記録 (DB に触れたか) */
  fromCalls: [] as string[],
  /** user_profiles への書き込み (update / insert / upsert) の記録 */
  profileWrites: [] as ProfileWrite[],
  /** 行の有無を読んだときに行があるか */
  rowExists: true,
  /** insert の結果のエラー (同時の insert の負けをまねる) */
  insertError: null as unknown,
}));

/** PostgREST のクエリの組み立てのまね。user_profiles の読み書きを記録し、await・single・maybeSingle で結果を返す */
function queryBuilder(table: string): PromiseLike<QueryResult> {
  let write: ProfileWrite | null = null;
  const settle = (): Promise<QueryResult> => {
    if (table !== 'user_profiles') return Promise.resolve({ data: null, error: null });
    if (!write) return Promise.resolve({ data: h.rowExists ? { id: USER_ID } : null, error: null });
    if (write.op === 'insert' && h.insertError) return Promise.resolve({ data: null, error: h.insertError });
    const base = write.op === 'insert' ? {} : EXISTING_ROW;
    return Promise.resolve({ data: { ...base, ...write.values }, error: null });
  };
  const builder: PromiseLike<QueryResult> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (onFulfilled: (value: QueryResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
            settle().then(onFulfilled, onRejected);
        }
        if (prop === 'single' || prop === 'maybeSingle') return settle;
        if (table === 'user_profiles' && (prop === 'update' || prop === 'insert' || prop === 'upsert')) {
          return (values: Record<string, unknown>) => {
            write = { op: prop, values, eq: [] };
            h.profileWrites.push(write);
            return builder;
          };
        }
        if (prop === 'eq') {
          return (column: string, value: unknown) => {
            write?.eq.push([column, value]);
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

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/profile', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function post(body: unknown) {
  const { POST } = await import('@/app/api/profile/route');
  return POST(postRequest(body));
}

/** 週間献立の画面が送る人数設定 (src/app/(main)/menus/weekly/page.tsx の ServingsModal) */
const SERVINGS_CONFIG = { default: 3, byDayMeal: { monday: { dinner: 4 } } };
/** 週間献立の画面が送るレーダーの栄養素 */
const RADAR_NUTRIENTS = ['caloriesKcal', 'proteinG', 'fatG'];

/** 種類ごとの、列が受ける値 (空でない値。空の値は今までどおり書かないため) */
const VALID_SAMPLE: Record<UserProfileColumnKind, unknown> = {
  text: 'テキスト',
  date: '2026-11-01',
  time: '07:30',
  integer: 42,
  numeric: 62.5,
  boolean: true,
  textArray: ['a', 'b'],
  integerArray: [3, 7],
  jsonb: { nested: [1, 'x'] },
};

/** 種類ごとの、列が拒む (以前は DB の書き込みで 500 になった) 値。以前の parseInt / parseFloat が受けていた数の文字列も拒む */
const INVALID_SAMPLES: Record<Exclude<UserProfileColumnKind, 'jsonb'>, readonly unknown[]> = {
  text: [123, true, ['a'], { a: 1 }],
  date: ['2026-02-30', 'abc', 20261101],
  time: ['25:00', 730],
  integer: ['42', 42.5, true, PG_INTEGER_MAX + 1],
  numeric: ['abc', '62.5', true, [1]],
  boolean: ['true', 1],
  textArray: ['caloriesKcal', [1], { a: 'b' }],
  integerArray: [3, ['3'], [3.5]],
};

const FIELD_ENTRIES = Object.entries(USER_PROFILE_POST_FIELDS);

function writesOf(op: ProfileWrite['op']): ProfileWrite[] {
  return h.profileWrites.filter((write) => write.op === op);
}

beforeEach(() => {
  h.fromCalls.length = 0;
  h.profileWrites.length = 0;
  h.rowExists = true;
  h.insertError = null;
});

describe('POST /api/profile: 既存の行は本文の欄だけを書く (#2178 Y1-a)', () => {
  it('既存の行に { servingsConfig } を送っても nickname・gender・age_group を書かない (以前は Guest / unspecified に上書きした)', async () => {
    const res = await post({ servingsConfig: SERVINGS_CONFIG });
    expect(res.status).toBe(200);
    expect(writesOf('upsert')).toEqual([]);
    expect(writesOf('insert')).toEqual([]);
    const updates = writesOf('update');
    expect(updates).toHaveLength(1);
    expect(updates[0].values).toEqual({ servings_config: SERVINGS_CONFIG, updated_at: expect.any(String) });
    expect(updates[0].eq).toEqual([['id', USER_ID]]);
    // 返る行は既存の名前・性別・年代のまま
    expect(await res.json()).toMatchObject({ nickname: EXISTING_ROW.nickname, gender: EXISTING_ROW.gender, age_group: EXISTING_ROW.age_group });
  });

  it('既存の行に { radarChartNutrients } を送っても nickname・gender・age_group を書かない', async () => {
    const res = await post({ radarChartNutrients: RADAR_NUTRIENTS });
    expect(res.status).toBe(200);
    const updates = writesOf('update');
    expect(updates).toHaveLength(1);
    expect(updates[0].values).toEqual({ radar_chart_nutrients: RADAR_NUTRIENTS, updated_at: expect.any(String) });
    expect(updates[0].values).not.toHaveProperty('nickname');
    expect(updates[0].values).not.toHaveProperty('gender');
    expect(updates[0].values).not.toHaveProperty('age_group');
  });

  it('本文の id は無視し、本人の行だけを書く', async () => {
    const res = await post({ id: '40000000-0000-4000-8000-000000000099', servingsConfig: SERVINGS_CONFIG });
    expect(res.status).toBe(200);
    const updates = writesOf('update');
    expect(updates[0].values).not.toHaveProperty('id');
    expect(updates[0].eq).toEqual([['id', USER_ID]]);
  });

  it('age を送ると age と年代 (age_group) を書く', async () => {
    const res = await post({ age: 37 });
    expect(res.status).toBe(200);
    expect(writesOf('update')[0].values).toMatchObject({ age: 37, age_group: '30s' });
  });

  it('空の値 (null・空文字・0・false の欄) は今までどおり書かない', async () => {
    const res = await post({ nickname: '', familySize: 0, healthConditions: null, servingsConfig: SERVINGS_CONFIG });
    expect(res.status).toBe(200);
    expect(writesOf('update')[0].values).toEqual({ servings_config: SERVINGS_CONFIG, updated_at: expect.any(String) });
  });
});

describe('POST /api/profile: 行が無いときだけ仮置きの値を入れて insert する', () => {
  it('行が無いときは nickname: Guest・gender / age_group: unspecified を補って insert する', async () => {
    h.rowExists = false;
    const res = await post({ servingsConfig: SERVINGS_CONFIG });
    expect(res.status).toBe(200);
    expect(writesOf('update')).toEqual([]);
    const inserts = writesOf('insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toEqual({
      id: USER_ID,
      nickname: 'Guest',
      gender: 'unspecified',
      age_group: 'unspecified',
      servings_config: SERVINGS_CONFIG,
      updated_at: expect.any(String),
    });
  });

  it('行が無くても本文の nickname・gender・age は仮置きの値より優先する', async () => {
    h.rowExists = false;
    const res = await post({ nickname: '太郎', gender: 'male', age: 25 });
    expect(res.status).toBe(200);
    expect(writesOf('insert')[0].values).toMatchObject({ id: USER_ID, nickname: '太郎', gender: 'male', age: 25, age_group: '20s' });
  });

  it('insert が一意の制約の違反 (同時に行が作られた) のときは update に回し、仮置きの値で上書きしない', async () => {
    h.rowExists = false;
    h.insertError = UNIQUE_VIOLATION;
    const res = await post({ servingsConfig: SERVINGS_CONFIG });
    expect(res.status).toBe(200);
    expect(writesOf('insert')).toHaveLength(1);
    const updates = writesOf('update');
    expect(updates).toHaveLength(1);
    expect(updates[0].values).toEqual({ servings_config: SERVINGS_CONFIG, updated_at: expect.any(String) });
  });
});

describe('POST /api/profile: 列の型に合わない値は 400 (#2178 Y1-a)', () => {
  it('radarChartNutrients (text[] の列) に文字列を送ると 400。DB に触れない (以前は DB の型の失敗で 500)', async () => {
    const res = await post({ radarChartNutrients: 'caloriesKcal' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: API_INVALID_JSON_MESSAGE });
    expect(h.fromCalls).toEqual([]);
  });

  const invalidCases = FIELD_ENTRIES.flatMap(([field, { spec }]) =>
    spec.kind === 'jsonb' ? [] : INVALID_SAMPLES[spec.kind].map((value) => [field, spec.kind, value] as const),
  );
  it.each(invalidCases)('欄 %s (%s の列) に %j を送ると 400', async (field, _kind, value) => {
    const res = await post({ [field]: value });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: API_INVALID_JSON_MESSAGE });
    expect(h.fromCalls).toEqual([]);
  });

  const notNullFields = FIELD_ENTRIES.filter(([, { spec }]) => !spec.nullable).map(([field]) => field);
  it.each(notNullFields)('NOT NULL の列の欄 %s に null を送ると 400', async (field) => {
    const res = await post({ [field]: null });
    expect(res.status).toBe(400);
    expect(h.fromCalls).toEqual([]);
  });

  it('型の合う欄と合わない欄が混ざった本文も 400 (一部だけ書かない)', async () => {
    const res = await post({ servingsConfig: SERVINGS_CONFIG, familySize: '4' });
    expect(res.status).toBe(400);
    expect(h.profileWrites).toEqual([]);
  });
});

describe('POST /api/profile: 型の合う本文は欄ごとに列へ写す', () => {
  it('全部の欄に列が受ける値を入れた本文は 200 で、各欄を USER_PROFILE_POST_FIELDS の列に書く', async () => {
    const body = Object.fromEntries(FIELD_ENTRIES.map(([field, { spec }]) => [field, VALID_SAMPLE[spec.kind]]));
    const res = await post(body);
    expect(res.status).toBe(200);
    const expected = Object.fromEntries(FIELD_ENTRIES.map(([field, { column }]) => [column, body[field]]));
    expect(writesOf('update')[0].values).toMatchObject(expected);
  });
});

describe('POST の欄と DDL の突き合わせ', () => {
  it('スキーマの shape の欄は USER_PROFILE_POST_FIELDS と同じ', () => {
    expect(Object.keys(UserProfilePostBodySchema.shape).sort()).toEqual(Object.keys(USER_PROFILE_POST_FIELDS).sort());
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
    for (const [field, { column, spec }] of FIELD_ENTRIES) {
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
