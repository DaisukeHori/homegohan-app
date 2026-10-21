/**
 * billing/04 (ストアの購読の定期の取り直し) 段 A: migration *_billing_iap_reconcile.sql とロールバックの SQL の文面の契約テスト (DB は使わない)
 *
 * DB の上での振る舞い (候補の述語・順番・印の書き方・権限) は tests/integration/rls/billing-iap-reconcile-candidates-rpc.test.ts が確かめる。
 * ここでは、番号の付け直しや後の migration の上書きで崩れやすい所を、ファイルの文面だけで確かめる
 * (設計: docs/design/billing/04-iap-reconcile.md §6・§12.2 の 31〜37)。段 A のテストなので、段 B の src/lib/billing/iap-reconcile-*.ts を import しない。
 *   31. migration とロールバックが 1 本ずつ対になり、1 行目の見出しが互いを指す
 *   32. 文の種類 (印の表・索引・関数 2 本だけ。ほかの表・トリガー・cron に触れない) と、書き込みの置き場所
 *   33. 権限 (印の表は RLS + service_role の SELECT だけ・関数は SECURITY DEFINER + search_path 空 + EXECUTE は service_role だけ)
 *   34. c_max_users と 22023 の入口の検査
 *   35. 候補の述語・順番・印の書き方・索引の述語が逐語
 *   36. ロールバックが消すもの
 *   37. 判断の帰属を書かない
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const STEM_SUFFIX = '_billing_iap_reconcile';

/** migration のファイル名 (version 14 桁 + `_` + 名前 + `.sql`) */
const MIGRATION_FILE = /^(\d{14})_.+\.sql$/;

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** `--` から行末までのコメントを除く (この 2 ファイルは文字列の中に `--` を書いていない) */
const stripLineComments = (sql: string): string => sql.replace(/--[^\n]*/g, '');
/** 空白を 1 つに詰める */
const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

const migrationFiles = fs
  .readdirSync(path.join(ROOT, MIGRATIONS_DIR))
  .filter((name) => MIGRATION_FILE.test(name))
  .sort();
const ours = migrationFiles.filter((name) => name.endsWith(`${STEM_SUFFIX}.sql`));
const ourVersion = ours[0]?.slice(0, 14) ?? '';
const MIGRATION = `${MIGRATIONS_DIR}/${ours[0]}`;
const ROLLBACK = `${ROLLBACKS_DIR}/${ourVersion}${STEM_SUFFIX}.down.sql`;

const migrationRaw = read(MIGRATION);
const rollbackRaw = read(ROLLBACK);
const migration = stripLineComments(migrationRaw);
const rollback = stripLineComments(rollbackRaw);

/** ドル引用の本体 ($$ … $$) を空にした SQL (本体の外の文だけを見るため) */
const withoutBodies = (sql: string): string => sql.replace(/\$\$[\s\S]*?\$\$/g, '$$$$');

/** 文 (`;` 区切り) の一覧。本体は空にしてから切る */
const statementsOutsideBodies = (sql: string): string[] =>
  withoutBodies(sql)
    .split(';')
    .map((s) => squash(s))
    .filter((s) => s.length > 0);

/** `CREATE OR REPLACE FUNCTION public.<name>(` から本体の終わり (`$$;`) までを取り出す */
function definition(sql: string, name: string): string {
  const match = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$;`, 'i').exec(sql);
  if (!match) throw new Error(`${name} の定義が無い`);
  return match[0];
}

/** 定義の頭 (本体の前。LANGUAGE / SECURITY / SET の指定がある部分) */
const headerOf = (def: string): string => squash(def.slice(0, def.indexOf('$$')));
/** 定義の本体 ($$ と $$ の間) */
const bodyOf = (def: string): string => def.slice(def.indexOf('$$') + 2, def.lastIndexOf('$$'));

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const TABLE = 'iap_reconcile_attempts';
const INDEX = 'idx_personal_subscriptions_iap_reconcile';
const CANDIDATES = 'billing_iap_reconcile_candidates';
const MARK = 'billing_iap_reconcile_mark_attempted';
const CANDIDATES_SIGNATURE = 'timestamptz, interval, integer';
const MARK_SIGNATURE = 'uuid[], timestamptz';
/** live の 3 値の一覧 (候補の述語と索引の述語。LIVE_STORE_SUBSCRIPTION_STATUSES と同じ集合・同じ順) */
const LIVE_STATUS_LIST = "('trialing', 'active', 'past_due')";

const candidatesDef = definition(migration, CANDIDATES);
const markDef = definition(migration, MARK);
const candidatesBody = squash(bodyOf(candidatesDef));
const markBody = squash(bodyOf(markDef));

describe('billing/04 段 A: migration とロールバックのファイル', () => {
  // 31
  it('exactly one migration ends with _billing_iap_reconcile.sql, the same-numbered rollback exists, and the headers name each other (-- migration: / -- rollback:)', () => {
    expect(ours).toHaveLength(1);
    expect(fs.existsSync(path.join(ROOT, ROLLBACK))).toBe(true);
    expect(migrationRaw.split('\n', 1)[0]).toBe(`-- migration: ${ours[0]}`);
    expect(rollbackRaw.split('\n', 1)[0]).toBe(`-- rollback: ${ours[0]}`);
  });
});

describe('billing/04 段 A: 文の種類と書き込みの置き場所', () => {
  // 32
  it('the migration starts with SET LOCAL lock_timeout; its statements are only CREATE TABLE IF NOT EXISTS iap_reconcile_attempts (user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE, attempted_at timestamptz NOT NULL) with ENABLE ROW LEVEL SECURITY / DROP POLICY IF EXISTS + CREATE POLICY / REVOKE / GRANT / COMMENT on it, CREATE INDEX IF NOT EXISTS idx_personal_subscriptions_iap_reconcile with its COMMENT, and CREATE OR REPLACE FUNCTION billing_iap_reconcile_candidates and billing_iap_reconcile_mark_attempted, each with REVOKE / GRANT / COMMENT; no ALTER TABLE on other tables, no TRIGGER, no cron.schedule, no INSERT / UPDATE / DELETE outside the body of billing_iap_reconcile_mark_attempted, and none inside the body of billing_iap_reconcile_candidates', () => {
    expect(squash(migration).startsWith("SET LOCAL lock_timeout = '10s';")).toBe(true);

    const statements = statementsOutsideBodies(migration);
    // 文の並びは、設計 §6.2 の (1)〜(4) の順 (どの文も下の正規表現のどれか 1 つだけに当たる)
    const ALLOWED: Array<{ name: string; pattern: RegExp }> = [
      { name: 'lock_timeout', pattern: /^SET LOCAL lock_timeout = '10s'$/ },
      {
        name: 'create table',
        pattern: new RegExp(
          `^CREATE TABLE IF NOT EXISTS public\\.${TABLE} \\( user_id uuid PRIMARY KEY REFERENCES auth\\.users \\(id\\) ON DELETE CASCADE, attempted_at timestamptz NOT NULL \\)$`,
        ),
      },
      { name: 'comment on table', pattern: new RegExp(`^COMMENT ON TABLE public\\.${TABLE} IS '[^']*'$`) },
      { name: 'enable rls', pattern: new RegExp(`^ALTER TABLE public\\.${TABLE} ENABLE ROW LEVEL SECURITY$`) },
      { name: 'drop policy', pattern: new RegExp(`^DROP POLICY IF EXISTS ${TABLE}_no_access ON public\\.${TABLE}$`) },
      { name: 'create policy', pattern: new RegExp(`^CREATE POLICY ${TABLE}_no_access ON public\\.${TABLE} USING \\(false\\) WITH CHECK \\(false\\)$`) },
      { name: 'revoke table', pattern: new RegExp(`^REVOKE ALL ON public\\.${TABLE} FROM PUBLIC, anon, authenticated, service_role$`) },
      { name: 'grant table', pattern: new RegExp(`^GRANT SELECT ON public\\.${TABLE} TO service_role$`) },
      { name: 'create index', pattern: new RegExp(`^CREATE INDEX IF NOT EXISTS ${INDEX} ON public\\.personal_subscriptions \\(current_period_end\\) WHERE `) },
      { name: 'comment on index', pattern: new RegExp(`^COMMENT ON INDEX public\\.${INDEX} IS '[^']*'$`) },
      { name: 'create candidates', pattern: new RegExp(`^CREATE OR REPLACE FUNCTION public\\.${CANDIDATES}\\(`) },
      { name: 'create mark', pattern: new RegExp(`^CREATE OR REPLACE FUNCTION public\\.${MARK}\\(`) },
      { name: 'revoke function', pattern: /^REVOKE ALL ON FUNCTION public\.billing_iap_reconcile_\w+\([^)]*\) FROM PUBLIC, anon, authenticated$/ },
      { name: 'grant function', pattern: /^GRANT EXECUTE ON FUNCTION public\.billing_iap_reconcile_\w+\([^)]*\) TO service_role$/ },
      { name: 'comment on function', pattern: /^COMMENT ON FUNCTION public\.billing_iap_reconcile_\w+\([^)]*\) IS '[^']*'$/ },
    ];
    const names = statements.map((statement) => {
      const hits = ALLOWED.filter((allowed) => allowed.pattern.test(statement));
      expect(hits.map((h) => h.name), statement.slice(0, 120)).toHaveLength(1);
      return hits[0].name;
    });
    expect(names).toEqual([
      'lock_timeout',
      'create table',
      'comment on table',
      'enable rls',
      'drop policy',
      'create policy',
      'revoke table',
      'grant table',
      'create index',
      'comment on index',
      'create candidates',
      'revoke function',
      'grant function',
      'comment on function',
      'create mark',
      'revoke function',
      'grant function',
      'comment on function',
    ]);

    const flat = squash(migration);
    // 既存の表の ALTER・トリガー・cron・削除は無い (ALTER TABLE は印の表の RLS だけ)
    expect([...flat.matchAll(/\bALTER\s+TABLE\s+(\S+)/gi)].map((m) => m[1])).toEqual([`public.${TABLE}`]);
    expect(flat).not.toMatch(/\bTRIGGER\b/i);
    expect(flat).not.toMatch(/cron\.schedule|cron\.unschedule/i);
    expect(flat).not.toMatch(/\bDROP\s+(?:TABLE|TRIGGER|INDEX|FUNCTION|COLUMN)\b/i);

    // 本体の外には INSERT / UPDATE / DELETE の文が無い
    expect(statements.filter((s) => /^(UPDATE|DELETE|TRUNCATE|MERGE)\b/i.test(s) || /^INSERT\s+INTO\b/i.test(s))).toEqual([]);
    // 候補を読む関数の本体には書き込みが無い (番兵: 本体を取り出せている)
    expect(candidatesBody).toContain('RETURN QUERY');
    expect(candidatesBody).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/i);
    // 印を書く関数の本体の書き込みは、印の表への INSERT (ON CONFLICT DO UPDATE) の 1 つだけ。personal_subscriptions には書かない
    expect([...markBody.matchAll(/\bINSERT\s+INTO\s+(\S+)/gi)].map((m) => m[1])).toEqual([`public.${TABLE}`]);
    expect(markBody).not.toMatch(/\b(?:DELETE|TRUNCATE|MERGE)\b/i);
    expect(markBody).not.toMatch(/\bUPDATE\s+public\./i);
    expect(markBody).not.toContain('personal_subscriptions');
  });
});

describe('billing/04 段 A: 権限', () => {
  // 33
  it('iap_reconcile_attempts has RLS enabled with a USING (false) WITH CHECK (false) policy, revokes PUBLIC / anon / authenticated / service_role and grants only SELECT to service_role; billing_iap_reconcile_candidates is STABLE SECURITY DEFINER with SET search_path = empty and #variable_conflict use_column, billing_iap_reconcile_mark_attempted is VOLATILE SECURITY DEFINER with SET search_path = empty, both reference tables as public.* / auth.users, have no dynamic SQL, revoke PUBLIC / anon / authenticated and grant EXECUTE to service_role only', () => {
    const flat = squash(migration);
    expect(flat).toContain(`ALTER TABLE public.${TABLE} ENABLE ROW LEVEL SECURITY;`);
    expect(flat).toContain(`CREATE POLICY ${TABLE}_no_access ON public.${TABLE} USING (false) WITH CHECK (false);`);
    expect(flat).toContain(`REVOKE ALL ON public.${TABLE} FROM PUBLIC, anon, authenticated, service_role;`);
    expect(flat).toContain(`GRANT SELECT ON public.${TABLE} TO service_role;`);

    const candidatesHeader = headerOf(candidatesDef);
    expect(candidatesHeader).toMatch(/\bLANGUAGE plpgsql\b/);
    expect(candidatesHeader).toMatch(/\bSTABLE\b/);
    expect(candidatesHeader).not.toMatch(/\bVOLATILE\b/);
    expect(candidatesHeader).toMatch(/\bSECURITY DEFINER\b/);
    expect(candidatesHeader).toMatch(/\bSET search_path = ''/);
    expect(bodyOf(candidatesDef)).toMatch(/^\s*#variable_conflict use_column\s*$/m);

    const markHeader = headerOf(markDef);
    expect(markHeader).toMatch(/\bLANGUAGE plpgsql\b/);
    expect(markHeader).toMatch(/\bVOLATILE\b/);
    expect(markHeader).not.toMatch(/\bSTABLE\b/);
    expect(markHeader).toMatch(/\bSECURITY DEFINER\b/);
    expect(markHeader).toMatch(/\bSET search_path = ''/);
    expect(markHeader).toMatch(/\bRETURNS void\b/);

    // 表は public.* / auth.users で書く (search_path が空)。名前に点が無いのは候補の関数の CTE `due` だけ
    for (const [label, body] of [
      [CANDIDATES, candidatesBody],
      [MARK, markBody],
    ] as const) {
      const targets = [...body.matchAll(/\b(?:FROM|JOIN|INTO)\s+([A-Za-z_][\w.]*)/g)].map((m) => m[1]);
      expect(targets.length, label).toBeGreaterThan(0);
      for (const target of targets) {
        expect(target === 'due' || target.startsWith('public.') || target === 'auth.users', `${label}: ${target}`).toBe(true);
      }
      // 動的 SQL は無い
      expect(body, label).not.toMatch(/\bEXECUTE\b|\bformat\s*\(/i);
    }

    // 権限: 関数は PUBLIC / anon / authenticated から外し、EXECUTE は service_role だけ。GRANT は全部で 3 つ (表の SELECT・関数 2 本の EXECUTE)
    for (const [name, signature] of [
      [CANDIDATES, CANDIDATES_SIGNATURE],
      [MARK, MARK_SIGNATURE],
    ] as const) {
      expect(flat, name).toContain(`REVOKE ALL ON FUNCTION public.${name}(${signature}) FROM PUBLIC, anon, authenticated;`);
      expect(flat, name).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(${signature}) TO service_role;`);
    }
    expect([...flat.matchAll(/\bGRANT\s+([A-Z]+)\b[^;]*? TO ([^;]+);/g)].map((m) => [m[1], m[2].trim()])).toEqual([
      ['SELECT', 'service_role'],
      ['EXECUTE', 'service_role'],
      ['EXECUTE', 'service_role'],
    ]);
  });
});

describe('billing/04 段 A: 入口の検査', () => {
  // 34
  it('both functions declare c_max_users as a positive integer CONSTANT; the 22023 guards of billing_iap_reconcile_candidates cover NULL arguments, a non-positive p_recheck_after and p_limit outside 1..c_max_users, and those of billing_iap_reconcile_mark_attempted cover NULL arguments and more than c_max_users ids', () => {
    const limits = [candidatesBody, markBody].map((body) => {
      const match = /\bc_max_users CONSTANT integer := (\d+);/.exec(body);
      expect(match).not.toBeNull();
      return Number(match![1]);
    });
    for (const limit of limits) {
      expect(Number.isInteger(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
    }
    // 2 本の上限は同じ値 (TS の IAP_RECONCILE_BATCH_SIZE_MAX はこれ以下。段 B のテスト 10)
    expect(limits[0]).toBe(limits[1]);

    const guard = (body: string, condition: string): boolean =>
      new RegExp(`IF ${escapeRegExp(condition)} THEN RAISE EXCEPTION [^;]*USING ERRCODE = '22023'; END IF;`).test(body);
    expect(guard(candidatesBody, 'p_now IS NULL OR p_recheck_after IS NULL OR p_limit IS NULL')).toBe(true);
    expect(guard(candidatesBody, "p_recheck_after <= interval '0'")).toBe(true);
    expect(guard(candidatesBody, 'p_limit < 1 OR p_limit > c_max_users')).toBe(true);
    expect(guard(markBody, 'p_user_ids IS NULL OR p_attempted_at IS NULL')).toBe(true);
    expect(guard(markBody, 'cardinality(p_user_ids) > c_max_users')).toBe(true);
    // 22023 以外の ERRCODE は使わない (どの入口の検査も同じ種類のエラー)
    for (const body of [candidatesBody, markBody]) {
      expect([...body.matchAll(/ERRCODE = '(\w+)'/g)].every((m) => m[1] === '22023')).toBe(true);
    }
  });

  // 35
  it('the candidate predicate is verbatim (iap_store IS NOT NULL / status IN trialing, active, past_due / current_period_end IS NOT NULL / current_period_end <= p_now / iap_synced_at IS NULL OR iap_synced_at < current_period_end OR iap_synced_at <= p_now - p_recheck_after) with DISTINCT ON (user_id), the order is ORDER BY a.attempted_at ASC NULLS FIRST, d.due_period_end, d.due_user_id with LIMIT p_limit, billing_iap_reconcile_mark_attempted inserts SELECT u.id, p_attempted_at FROM auth.users AS u WHERE u.id = ANY (p_user_ids) ON CONFLICT ON CONSTRAINT iap_reconcile_attempts_pkey DO UPDATE SET attempted_at = GREATEST(t.attempted_at, EXCLUDED.attempted_at), and the index predicate is iap_store IS NOT NULL AND status IN the same 3 values', () => {
    expect(candidatesBody).toContain(
      `FROM public.personal_subscriptions AS s WHERE s.iap_store IS NOT NULL AND s.status IN ${LIVE_STATUS_LIST} AND s.current_period_end IS NOT NULL AND s.current_period_end <= p_now AND (s.iap_synced_at IS NULL OR s.iap_synced_at < s.current_period_end OR s.iap_synced_at <= p_now - p_recheck_after)`,
    );
    expect(candidatesBody).toContain('SELECT DISTINCT ON (s.user_id) s.user_id AS due_user_id, s.current_period_end AS due_period_end, s.iap_synced_at AS due_synced_at');
    expect(candidatesBody).toContain('ORDER BY s.user_id, s.current_period_end');
    expect(candidatesBody).toContain('LEFT JOIN public.iap_reconcile_attempts AS a ON a.user_id = d.due_user_id');
    expect(candidatesBody).toContain('ORDER BY a.attempted_at ASC NULLS FIRST, d.due_period_end, d.due_user_id LIMIT p_limit;');

    expect(markBody).toContain(
      `INSERT INTO public.${TABLE} AS t (user_id, attempted_at) SELECT u.id, p_attempted_at FROM auth.users AS u WHERE u.id = ANY (p_user_ids) ON CONFLICT ON CONSTRAINT ${TABLE}_pkey DO UPDATE SET attempted_at = GREATEST(t.attempted_at, EXCLUDED.attempted_at);`,
    );

    const index = statementsOutsideBodies(migration).find((s) => s.startsWith(`CREATE INDEX IF NOT EXISTS ${INDEX}`));
    expect(index).toBe(
      `CREATE INDEX IF NOT EXISTS ${INDEX} ON public.personal_subscriptions (current_period_end) WHERE iap_store IS NOT NULL AND status IN ${LIVE_STATUS_LIST}`,
    );
    // live の一覧は、述語と索引で同じ 3 値
    const lists = [...squash(migration).matchAll(/\bstatus IN (\([^)]*\))/g)].map((m) => m[1]);
    expect(lists).toEqual([LIVE_STATUS_LIST, LIVE_STATUS_LIST]);
  });
});

describe('billing/04 段 A: ロールバック', () => {
  // 36
  it('rollback drops both functions with the same signatures, the index and the table iap_reconcile_attempts, and contains no DELETE / UPDATE / TRUNCATE', () => {
    expect(squash(rollback).startsWith("SET LOCAL lock_timeout = '10s';")).toBe(true);
    const statements = statementsOutsideBodies(rollback);
    // 関数 (印を書く側・候補の側) → 索引 → 表の順 (表を最後に消す)
    expect(statements).toEqual([
      "SET LOCAL lock_timeout = '10s'",
      `DROP FUNCTION IF EXISTS public.${MARK}(${MARK_SIGNATURE})`,
      `DROP FUNCTION IF EXISTS public.${CANDIDATES}(${CANDIDATES_SIGNATURE})`,
      `DROP INDEX IF EXISTS public.${INDEX}`,
      `DROP TABLE IF EXISTS public.${TABLE}`,
    ]);
    expect(squash(rollback)).not.toMatch(/\b(?:DELETE|UPDATE|TRUNCATE)\b/i);
  });
});

describe('billing/04 段 A: 帰属', () => {
  // 37
  it('migration and rollback comments do not attribute decisions', () => {
    const ATTRIBUTION = /オーナー(?:の)?(?:判断|選択|指示|決定)|ユーザー(?:の)?(?:判断|指示|決定)|発注者/;
    for (const [file, text] of [
      [MIGRATION, migrationRaw],
      [ROLLBACK, rollbackRaw],
    ] as const) {
      expect(text, file).not.toMatch(ATTRIBUTION);
    }
    // 方針の出どころは設計書として書く
    expect(migrationRaw).toMatch(/billing\/04/);
    expect(rollbackRaw).toMatch(/billing\/0[34]/);
  });
});
