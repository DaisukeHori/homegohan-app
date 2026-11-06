// @vitest-environment node
/**
 * #2283 V2 AI 相談 (ai_consultation_sessions) の状態の制約 ai_consultation_sessions_status_check と、コードが書く・読む状態をそろえる
 * (DB を使わない静的な検査)。
 *
 * 問題 (修正前):
 *   - 「相談を終了」(src/app/api/ai/consultation/sessions/[sessionId]/close/route.ts) は status = 'closed' を書くが、
 *     状態の制約は 'active'・'completed'・'archived' しか許さなかった。書き換えが 23514 で失敗し、閉じる route は 500 を返していた
 *   - 閉じた相談の要約の引き継ぎ (.eq('status', 'closed') の読み取り) も、closed の行が無いので常に空だった
 *
 * ここで確かめること:
 *   - M-1 制約を作り直す migration はちょうど 1 本。見出しと「戻し方」の参照が対になり、戻し口が実在して対の migration を指す
 *   - M-2 新しい一覧 = 前の一覧 (ベースライン) + closed。DROP IF EXISTS → NOT VALID → VALIDATE の形・lock_timeout がある。
 *         戻し口の一覧 = 前の一覧で、NOT VALID (既存の closed の行を確かめない)・行を消さない・書き換えない・権限を付け直さない
 *   - M-3 migration を番号順に流したあとの制約は、コードが書く状態 (閉じる route の 'closed'・列の既定値の 'active') と、
 *         コードが読む状態 (要約の引き継ぎの .eq('status', 'closed')・閉じる route の比較) を全部含む。
 *         修正前の制約 (ベースライン) には closed が無かった (この検査が修正前の形で赤になることの番兵)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const ROLLBACKS_DIR = path.join(ROOT, 'supabase', 'rollbacks');
const BASELINE_MIGRATION = '20251126124224_create_meal_planner_tables.sql';

/** 状態の制約の名前 */
const STATUS_CHECK = 'ai_consultation_sessions_status_check';
/** closed を制約に足した migration の名前 (版の番号を除く) */
const MIGRATION_NAME = 'ai_consultation_sessions_status_closed';
/** 修正で足した状態 */
const ADDED_STATUS = 'closed';
/** 列の既定値 (ベースラインの CREATE TABLE の "status" "text" DEFAULT '…') */
const STATUS_COLUMN_DEFAULT = /CREATE TABLE IF NOT EXISTS "public"\."ai_consultation_sessions" \([\s\S]*?"status" "text" DEFAULT '([a-z_]+)'::"text"/;

const CONSULTATION_API_DIR = path.join(ROOT, 'src', 'app', 'api', 'ai', 'consultation', 'sessions');
/** 状態を書く・比べる route (閉じる route) */
const CLOSE_ROUTE_FILE = path.join(CONSULTATION_API_DIR, '[sessionId]', 'close', 'route.ts');
/** 閉じた相談の要約を読む route (.eq('status', '…')) */
const SUMMARY_READER_FILES = [
  path.join(CONSULTATION_API_DIR, 'route.ts'),
  path.join(CONSULTATION_API_DIR, '[sessionId]', 'messages', 'route.ts'),
] as const;

/** update のオブジェクトの status: '…' (数の status: 401 は拾わない) */
const STATUS_WRITE_LITERAL = /\bstatus:\s*'([a-z_]+)'/g;
/** session.status === '…' / !== '…' */
const STATUS_COMPARE_LITERAL = /\.status\s*[!=]==\s*'([a-z_]+)'/g;
/** .eq('status', '…') */
const STATUS_EQ_LITERAL = /\.eq\(\s*'status'\s*,\s*'([a-z_]+)'\s*\)/g;

const CHECK_STATUS_LITERAL = /'([a-z_]+)'::text/g;
const BASELINE_STATUS_LITERAL = /'([a-z_]+)'::"text"/g;
const SQL_LINE_COMMENT = /--[^\n]*/g;
/** ADD CONSTRAINT ai_consultation_sessions_status_check の文 (終わりの ; まで) */
const ADD_CHECK_STATEMENT = new RegExp(`ADD\\s+CONSTRAINT\\s+"?${STATUS_CHECK}"?\\s+CHECK\\s*\\(([\\s\\S]*?)\\)\\s*(?:NOT\\s+VALID\\s*)?;`, 'gi');
/** ベースラインの CREATE TABLE の中の制約の書き出し */
const BASELINE_CHECK_HEAD = `CONSTRAINT "${STATUS_CHECK}" CHECK`;
/** ベースラインの制約の終わり (CHECK ((… ANY (ARRAY[…]))) の閉じ) */
const BASELINE_CHECK_END = ')))';

function matchAll(text: string, pattern: RegExp): string[] {
  return Array.from(text.matchAll(pattern), (m) => m[1]);
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function readSql(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(SQL_LINE_COMMENT, '');
}

/** ベースライン (CREATE TABLE の中の制約) の一覧。見つからなければ例外 */
function baselineStatuses(): string[] {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, BASELINE_MIGRATION), 'utf8');
  const start = sql.indexOf(BASELINE_CHECK_HEAD);
  if (start < 0) throw new Error(`${BASELINE_MIGRATION} に ${STATUS_CHECK} が無い`);
  return matchAll(sql.slice(start, sql.indexOf(BASELINE_CHECK_END, start)), BASELINE_STATUS_LITERAL);
}

/** migration を番号順に流したあとの制約が許す状態 (最後に制約を作った migration の一覧)。見つからなければ例外 */
function latestStatusCheck(): { migration: string; statuses: string[] } {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();
  let latest: { migration: string; statuses: string[] } | null = null;
  for (const file of files) {
    const sql = readSql(path.join(MIGRATIONS_DIR, file));
    const statements = matchAll(sql, ADD_CHECK_STATEMENT);
    if (statements.length > 0) {
      latest = { migration: file, statuses: matchAll(statements[statements.length - 1], CHECK_STATUS_LITERAL) };
    } else if (sql.includes(BASELINE_CHECK_HEAD)) {
      latest = { migration: file, statuses: baselineStatuses() };
    }
  }
  if (!latest) throw new Error(`${STATUS_CHECK} を作る migration が見つからない`);
  return latest;
}

/** コードが書く状態 (閉じる route の update と、列の既定値) */
function writtenStatuses(): string[] {
  const written = matchAll(fs.readFileSync(CLOSE_ROUTE_FILE, 'utf8'), STATUS_WRITE_LITERAL);
  const baseline = fs.readFileSync(path.join(MIGRATIONS_DIR, BASELINE_MIGRATION), 'utf8');
  const columnDefault = baseline.match(STATUS_COLUMN_DEFAULT);
  if (!columnDefault) throw new Error('ai_consultation_sessions.status の既定値が見つからない');
  return [...written, columnDefault[1]];
}

/** コードが読む・比べる状態 (要約の引き継ぎの .eq と、閉じる route の比較) */
function readStatuses(): string[] {
  const fromEq = SUMMARY_READER_FILES.flatMap((file) => matchAll(fs.readFileSync(file, 'utf8'), STATUS_EQ_LITERAL));
  const fromCompare = matchAll(fs.readFileSync(CLOSE_ROUTE_FILE, 'utf8'), STATUS_COMPARE_LITERAL);
  return [...fromEq, ...fromCompare];
}

const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(`_${MIGRATION_NAME}.sql`));

describe('M-1 制約を作り直す migration と戻し口の対 (#2283 V2)', () => {
  it('migration はちょうど 1 本。見出しと「戻し方」が対になり、戻し口が実在して対の migration を指す', () => {
    expect(migrationFiles).toHaveLength(1);
    const name = migrationFiles[0];
    const lines = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8').split('\n');
    expect(lines[0]).toBe(`-- migration: ${name}`);
    const rollbackName = name.replace(/\.sql$/, '.down.sql');
    expect(lines[1]).toBe(`-- 戻し方: supabase/rollbacks/${rollbackName}`);
    const rollback = fs.readFileSync(path.join(ROLLBACKS_DIR, rollbackName), 'utf8');
    expect(rollback.split('\n')[0]).toBe(`-- rollback: ${name}`);
  });
});

describe('M-2 新しい一覧と戻し口の一覧 (#2283 V2)', () => {
  it('ベースラインの一覧を読み取れている (番兵: active・completed・archived があり、closed が無い)', () => {
    const previous = baselineStatuses();
    expect(sorted(previous)).toEqual(sorted(['active', 'completed', 'archived']));
    expect(previous).not.toContain(ADDED_STATUS);
  });

  it('新しい一覧 = 前の一覧 + closed。DROP IF EXISTS → NOT VALID → VALIDATE の形で、lock_timeout がある', () => {
    const previous = baselineStatuses();
    const sql = readSql(path.join(MIGRATIONS_DIR, migrationFiles[0]));
    const statements = matchAll(sql, ADD_CHECK_STATEMENT);
    expect(statements).toHaveLength(1);
    const next = matchAll(statements[0], CHECK_STATUS_LITERAL);
    expect(new Set(next).size).toBe(next.length);
    expect(sorted(next)).toEqual(sorted([...previous, ADDED_STATUS]));
    expect(sql).toMatch(/SET LOCAL lock_timeout = '10s';/);
    expect(sql).toMatch(new RegExp(`DROP CONSTRAINT IF EXISTS ${STATUS_CHECK};`));
    expect(sql).toMatch(/NOT VALID;/);
    expect(sql).toMatch(new RegExp(`VALIDATE CONSTRAINT ${STATUS_CHECK};`));
    // 制約だけを作り直す (行・既定値・権限・ポリシーには触れない)
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|INSERT|GRANT|REVOKE)\b|\bPOLICY\b|SET DEFAULT/i);
  });

  it('戻し口の一覧 = 前の一覧で、NOT VALID (既存の closed の行を確かめない)。行を消さない・書き換えない・権限を付け直さない', () => {
    const previous = baselineStatuses();
    const rollback = readSql(path.join(ROLLBACKS_DIR, migrationFiles[0].replace(/\.sql$/, '.down.sql')));
    const statements = matchAll(rollback, ADD_CHECK_STATEMENT);
    expect(statements).toHaveLength(1);
    expect(sorted(matchAll(statements[0], CHECK_STATUS_LITERAL))).toEqual(sorted(previous));
    expect(rollback).toMatch(/SET LOCAL lock_timeout = '10s';/);
    expect(rollback).toMatch(new RegExp(`DROP CONSTRAINT IF EXISTS ${STATUS_CHECK};`));
    expect(rollback).toMatch(/NOT VALID;/);
    expect(rollback).not.toMatch(/VALIDATE CONSTRAINT/);
    expect(rollback).not.toMatch(/\b(UPDATE|DELETE|GRANT)\b/i);
  });
});

describe('M-3 制約とコードが書く・読む状態 (#2283 V2)', () => {
  it('コードが書く状態を読み取れている (番兵: 閉じる route の closed と、列の既定値の active)', () => {
    const written = writtenStatuses();
    expect(written).toContain(ADDED_STATUS);
    expect(written).toContain('active');
  });

  it('コードが読む状態を読み取れている (番兵: 要約の引き継ぎの 2 つの route と閉じる route がどれも closed を読む)', () => {
    for (const file of SUMMARY_READER_FILES) {
      expect(matchAll(fs.readFileSync(file, 'utf8'), STATUS_EQ_LITERAL)).toContain(ADDED_STATUS);
    }
    expect(matchAll(fs.readFileSync(CLOSE_ROUTE_FILE, 'utf8'), STATUS_COMPARE_LITERAL)).toContain(ADDED_STATUS);
  });

  it('migration を番号順に流したあとの制約は、コードが書く・読む状態を全部含む (最後に作るのは #2283 V2 の migration)', () => {
    const { migration, statuses } = latestStatusCheck();
    expect(migration).toBe(migrationFiles[0]);
    const missing = sorted([...writtenStatuses(), ...readStatuses()]).filter((status) => !statuses.includes(status));
    expect(missing).toEqual([]);
  });

  it('修正前の制約 (ベースライン) には、コードが書く closed が無かった (この検査が修正前の形で赤になることの番兵)', () => {
    const previous = baselineStatuses();
    expect(sorted(writtenStatuses()).filter((status) => !previous.includes(status))).toEqual([ADDED_STATUS]);
  });
});
