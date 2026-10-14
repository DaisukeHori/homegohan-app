import fs from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// #1306 awardBadge の単体テスト。
//
// 修正前は badges から存在しない列 icon_url を select していた (実列は icon)。PostgREST は 42703 を返し、
// supabase-js は { data: null, error } を返すが、error を見ていなかったため「バッジが無い」と区別できず、
// planner バッジが常に付与されなかった。Supabase を単純にモックするとこの種のずれは見えないので、
// ここでは本番スキーマ (supabase/baseline/prod_schema.sql) の実列を読み、存在しない列を select / insert
// したら 42703 を返すフェイクを使う。修正前のコードはこのフェイクの上で awarded: true にならない。

// 構造化ログのモック (想定外のエラーは createLogger('award-badge').withUser(userId).error(...) で記録される)
const mockLogError = vi.fn();
const mockLogWarn = vi.fn();
const mockWithUser = vi.fn(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: mockLogWarn,
  error: mockLogError,
}));
const mockCreateLogger = vi.fn((_name: string) => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  withUser: mockWithUser,
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: (name: string) => mockCreateLogger(name),
  generateRequestId: vi.fn(() => 'req_test'),
}));

const { awardBadge } = await import('@/lib/badges/awardBadge');

type Row = Record<string, unknown>;
interface QueryError {
  code: string;
  message: string;
}

/** 本番スキーマ (supabase/baseline/prod_schema.sql) から、public テーブルの実列を取り出す */
function loadColumns(table: string): string[] {
  const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/baseline/prod_schema.sql'), 'utf8');
  const match = new RegExp(`CREATE TABLE IF NOT EXISTS "public"\\."${table}" \\(\\n([\\s\\S]*?)\\n\\);`).exec(sql);
  if (!match) throw new Error(`prod_schema.sql に public.${table} の定義が見つかりません`);
  return [...match[1].matchAll(/^\s+"([A-Za-z0-9_]+)"/gm)].map((m) => m[1]);
}

const SCHEMA: Record<string, string[]> = {
  badges: loadColumns('badges'),
  user_badges: loadColumns('user_badges'),
};

// user_badges の主キー (user_badges_pkey)。重複して insert すると 23505
const USER_BADGES_PK = ['user_id', 'badge_id'];

type InjectedOperation = 'badges.select' | 'user_badges.select' | 'user_badges.insert';

interface FakeDbOptions {
  badges?: Row[];
  user_badges?: Row[];
  /** 操作ごとにエラーを返させる (PostgREST が返すエラーの再現) */
  errors?: Partial<Record<InjectedOperation, QueryError>>;
}

/**
 * PostgREST を模した最小のフェイク。
 * - select / insert / eq に実スキーマに無い列が出たら 42703 を返す
 * - single は 0 件でも 2 件以上でも PGRST116、maybeSingle は 0 件なら { data: null, error: null } (2 件以上は PGRST116)
 * - user_badges の主キー重複は 23505
 */
function createFakeDb(options: FakeDbOptions = {}) {
  const tables: Record<string, Row[]> = {
    badges: [...(options.badges ?? [])],
    user_badges: [...(options.user_badges ?? [])],
  };
  const selects: Array<{ table: string; columns: string[] }> = [];
  const inserts: Array<{ table: string; row: Row }> = [];

  const from = (table: string) => {
    const known = SCHEMA[table];
    if (!known) throw new Error(`想定外のテーブル: ${table}`);

    let selected: string[] | null = null;
    let inserted: Row | null = null;
    const filters: Array<[string, unknown]> = [];

    const missingColumn = (names: string[]) => names.find((name) => name !== '*' && !known.includes(name));
    const columnError = (name: string): QueryError => ({
      code: '42703',
      message: `column ${table}.${name} does not exist`,
    });

    const execute = (mode: 'many' | 'single' | 'maybeSingle') => {
      const injected = options.errors?.[`${table}.${inserted ? 'insert' : 'select'}` as InjectedOperation];
      if (injected) return { data: null, error: injected };

      if (inserted) {
        const missing = missingColumn(Object.keys(inserted));
        if (missing) return { data: null, error: columnError(missing) };
        const duplicated = tables[table].some((row) => USER_BADGES_PK.every((column) => row[column] === inserted![column]));
        if (duplicated) {
          return {
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint "user_badges_pkey"' },
          };
        }
        tables[table].push(inserted);
        return { data: null, error: null };
      }

      const columns = selected ?? ['*'];
      const missing = missingColumn([...columns, ...filters.map(([column]) => column)]);
      if (missing) return { data: null, error: columnError(missing) };

      const matched = tables[table].filter((row) => filters.every(([column, value]) => row[column] === value));
      const project = (row: Row) =>
        columns.includes('*') ? { ...row } : Object.fromEntries(columns.map((column) => [column, row[column] ?? null]));
      if (mode === 'many') return { data: matched.map(project), error: null };
      if (matched.length === 0 && mode === 'maybeSingle') return { data: null, error: null };
      if (matched.length !== 1) {
        return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      }
      return { data: project(matched[0]), error: null };
    };

    const builder = {
      select(columns: string) {
        selected = columns.split(',').map((column) => column.trim());
        selects.push({ table, columns: selected });
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return builder;
      },
      insert(row: Row) {
        inserted = row;
        inserts.push({ table, row });
        return builder;
      },
      single: () => Promise.resolve(execute('single')),
      maybeSingle: () => Promise.resolve(execute('maybeSingle')),
      // insert は await で直接結果を受け取る
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(execute('many')).then(onFulfilled, onRejected),
    };
    return builder;
  };

  return { client: { from } as unknown as SupabaseClient, tables, selects, inserts };
}

const USER_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const NOW = '2026-10-08T03:00:00.000Z';

// 本番の badges マスタの planner 行 (supabase/baseline/prod_reference_data.sql)。icon は絵文字
const PLANNER: Row = {
  id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
  code: 'planner',
  name: '計画上手',
  description: '1週間の献立を作成しました。計画的な食生活の始まりです。',
  icon: '📋',
  priority: 40,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('前提: 本番スキーマとフェイク', () => {
  it('badges の実列は icon で、icon_url という列は無い', () => {
    expect(SCHEMA.badges).toEqual(expect.arrayContaining(['id', 'code', 'name', 'icon']));
    expect(SCHEMA.badges).not.toContain('icon_url');
  });

  it('フェイクは実スキーマに無い列の select を 42703 で拒否する (修正前の select icon_url は失敗する)', async () => {
    const db = createFakeDb({ badges: [PLANNER] });

    const legacy = await db.client.from('badges').select('id, name, icon_url').eq('code', 'planner').single();
    expect(legacy.data).toBeNull();
    expect(legacy.error).toMatchObject({ code: '42703' });

    // 実列 icon なら同じ行が読める
    const fixed = await db.client.from('badges').select('id, name, icon').eq('code', 'planner').single();
    expect(fixed.error).toBeNull();
    expect(fixed.data).toEqual({ id: PLANNER.id, name: '計画上手', icon: '📋' });
  });
});

describe('awardBadge: 選択する列とレスポンスの対応 (#1306)', () => {
  it('badges からは実在する列 (id, name, icon) だけを select する', async () => {
    const db = createFakeDb({ badges: [PLANNER] });

    await awardBadge(db.client, USER_ID, 'planner');

    expect(db.selects[0]).toEqual({ table: 'badges', columns: ['id', 'name', 'icon'] });
    // どの select も実スキーマに存在する列だけを読む
    for (const { table, columns } of db.selects) {
      for (const column of columns) {
        expect(SCHEMA[table], `${table}.${column}`).toContain(column);
      }
    }
  });

  it('付与できたとき awarded: true を返し、badges.icon の値を icon_url として返す', async () => {
    const db = createFakeDb({ badges: [PLANNER] });

    const result = await awardBadge(db.client, USER_ID, 'planner');

    expect(result).toEqual({
      awarded: true,
      badge_id: PLANNER.id,
      obtained_at: NOW,
      name: '計画上手',
      icon_url: '📋',
    });
    expect(db.inserts).toEqual([
      { table: 'user_badges', row: { user_id: USER_ID, badge_id: PLANNER.id, obtained_at: NOW } },
    ]);
    expect(mockLogError).not.toHaveBeenCalled();
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('badges.icon が null のバッジは icon_url: null で返す (キーは必ず含める)', async () => {
    const db = createFakeDb({ badges: [{ ...PLANNER, icon: null }] });

    const result = await awardBadge(db.client, USER_ID, 'planner');

    expect(result.awarded).toBe(true);
    expect(result).toHaveProperty('icon_url', null);
  });

  it('獲得済みなら重複して付与せず、既存の obtained_at と icon_url を返す', async () => {
    const obtainedAt = '2026-10-01T00:00:00.000Z';
    const db = createFakeDb({
      badges: [PLANNER],
      user_badges: [{ user_id: USER_ID, badge_id: PLANNER.id, obtained_at: obtainedAt }],
    });

    const result = await awardBadge(db.client, USER_ID, 'planner');

    expect(result).toEqual({
      awarded: false,
      badge_id: PLANNER.id,
      obtained_at: obtainedAt,
      name: '計画上手',
      icon_url: '📋',
    });
    expect(db.inserts).toEqual([]);
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('確認と保存の間に別リクエストが先に保存した (23505) 場合は付与済みとみなし、エラーにしない', async () => {
    const db = createFakeDb({
      badges: [PLANNER],
      errors: {
        'user_badges.insert': { code: '23505', message: 'duplicate key value violates unique constraint "user_badges_pkey"' },
      },
    });

    const result = await awardBadge(db.client, USER_ID, 'planner');

    expect(result).toEqual({
      awarded: false,
      badge_id: PLANNER.id,
      obtained_at: null,
      name: '計画上手',
      icon_url: '📋',
    });
    expect(mockLogError).not.toHaveBeenCalled();
  });
});

describe('awardBadge: マスターに無い code', () => {
  it('例外にせず awarded: false を返し、付与せずに警告を残す', async () => {
    const db = createFakeDb({ badges: [PLANNER] });

    const result = await awardBadge(db.client, USER_ID, 'no_such_badge');

    expect(result).toEqual({ awarded: false, badge_id: null, obtained_at: null, name: null, icon_url: null });
    expect(db.inserts).toEqual([]);
    expect(db.selects.map((s) => s.table)).toEqual(['badges']);
    expect(mockWithUser).toHaveBeenCalledWith(USER_ID);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(mockLogWarn.mock.calls[0][1]).toEqual({ badge_code: 'no_such_badge' });
    // これはエラーではないので error ログにはしない
    expect(mockLogError).not.toHaveBeenCalled();
  });
});

describe('awardBadge: DB エラーは握りつぶさず、構造化ログに残して例外にする', () => {
  it('badges の取得が失敗したら (42703 など) 例外を投げ、error ログに code と badge_code を残す', async () => {
    // 修正前: error を見ずに「バッジが無い」と同じ awarded: false を返し、ログも残らなかった
    const error = { code: '42703', message: 'column badges.icon_url does not exist' };
    const db = createFakeDb({ badges: [PLANNER], errors: { 'badges.select': error } });

    await expect(awardBadge(db.client, USER_ID, 'planner')).rejects.toMatchObject({ code: '42703' });

    expect(mockCreateLogger).toHaveBeenCalledWith('award-badge');
    expect(mockWithUser).toHaveBeenCalledWith(USER_ID);
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockLogError.mock.calls[0][1]).toBe(error);
    expect(mockLogError.mock.calls[0][2]).toEqual({ badge_code: 'planner', error_code: '42703' });
    // 取得に失敗したら、以降の確認・保存には進まない
    expect(db.selects.map((s) => s.table)).toEqual(['badges']);
    expect(db.inserts).toEqual([]);
  });

  it('獲得済みかどうかの確認が失敗したら、保存せずに例外を投げてログに残す', async () => {
    const error = { code: '42501', message: 'permission denied for table user_badges' };
    const db = createFakeDb({ badges: [PLANNER], errors: { 'user_badges.select': error } });

    await expect(awardBadge(db.client, USER_ID, 'planner')).rejects.toMatchObject({ code: '42501' });

    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockLogError.mock.calls[0][1]).toBe(error);
    expect(mockLogError.mock.calls[0][2]).toEqual({
      badge_code: 'planner',
      badge_id: PLANNER.id,
      error_code: '42501',
    });
    expect(db.inserts).toEqual([]);
  });

  it('保存が想定外のエラー (RLS 違反 42501 など) で失敗したら、例外を投げてログに残す', async () => {
    const error = { code: '42501', message: 'new row violates row-level security policy for table "user_badges"' };
    const db = createFakeDb({ badges: [PLANNER], errors: { 'user_badges.insert': error } });

    await expect(awardBadge(db.client, USER_ID, 'planner')).rejects.toMatchObject({ code: '42501' });

    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockLogError.mock.calls[0][1]).toBe(error);
    expect(mockLogError.mock.calls[0][2]).toEqual({
      badge_code: 'planner',
      badge_id: PLANNER.id,
      error_code: '42501',
    });
  });
});
