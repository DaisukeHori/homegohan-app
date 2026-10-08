/**
 * アプリのコードが select する列・埋め込むリレーションが、実際のスキーマに存在するかの確認
 *
 * 存在しない列を select すると PostgREST は 42703 で失敗し、supabase-js は { data: null, error } を返す。
 * error を見ていない呼び出し元では「行が無い」と区別できず、権限エラーや空表示になる。
 * 例: POST /api/family/invites が user_profiles.display_name (存在しない) を読んでいたため、
 * 家族の代表者を含む全員が 403 になり、本番で家族の招待が作れなかった。
 * 単体テストは Supabase をモックするので列の有無を見ない。この結合テストで、
 * src/ と supabase/functions/ の `.from('<table>').select('<列>')` を、
 * ローカル Supabase (本番スキーマのベースライン + この PR までの migration) のカタログと突き合わせる。
 *
 * 不一致が 1 件でも見つかったら失敗する。例外のリストは持たない。
 * (以前は、このテストを入れた時点ですでにあった 15 か所を KNOWN_MISSING として許していた。
 *  #1306 の PR 群 (#1332 #1339 #1343 #1347 #1368 #1379 #1384) で全部直したので、リストごと削除した。
 *  新しい不一致はコードの方を直すこと)
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/select-columns-exist.test.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { extractSelectRefs, type SelectRef } from '../../helpers/select-columns';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCAN_DIRS = ['src', 'supabase/functions'];

/** ローカルスタックの postgres-meta でカタログを読む (読み取り専用の確認にだけ使う) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

interface Finding {
  key: string;
  detail: string;
}

let columnsByTable: Map<string, Set<string>>;

beforeAll(async () => {
  const rows = await pgQuery<{ table_name: string; column_name: string }>(`
    select c.relname as table_name, a.attname as column_name
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and a.attnum > 0
      and not a.attisdropped
  `);
  columnsByTable = new Map();
  for (const row of rows) {
    if (!columnsByTable.has(row.table_name)) columnsByTable.set(row.table_name, new Set());
    columnsByTable.get(row.table_name)!.add(row.column_name);
  }
}, 30_000);

function check(file: string, ref: SelectRef): Finding | null {
  const columns = columnsByTable.get(ref.table);
  const where = `${file}:${ref.line}`;
  if (!columns) {
    return { key: `${file}|${ref.table}`, detail: `${where} テーブル ${ref.table} が無い` };
  }
  if (ref.kind === 'column') {
    if (columns.has(ref.name)) return null;
    return { key: `${file}|${ref.table}.${ref.name}`, detail: `${where} 列 ${ref.table}.${ref.name} が無い` };
  }
  // 埋め込みはテーブル名か、外部キーの列名で指定できる
  if (columnsByTable.has(ref.name) || columns.has(ref.name)) return null;
  return {
    key: `${file}|${ref.table}.${ref.name}`,
    detail: `${where} ${ref.table} から埋め込むリレーション ${ref.name} が無い`,
  };
}

describe('select する列・リレーションが実際のスキーマに存在する', () => {
  it('src/ と supabase/functions/ に、未知の不一致が無い', () => {
    expect(columnsByTable.size).toBeGreaterThan(50);

    const findings: Finding[] = [];
    let refCount = 0;
    for (const dir of SCAN_DIRS) {
      for (const full of listSourceFiles(path.join(REPO_ROOT, dir))) {
        const file = path.relative(REPO_ROOT, full).split(path.sep).join('/');
        for (const ref of extractSelectRefs(fs.readFileSync(full, 'utf8'))) {
          refCount += 1;
          const finding = check(file, ref);
          if (finding) findings.push(finding);
        }
      }
    }
    // 取り出しが壊れて 0 件になっていないこと
    expect(refCount).toBeGreaterThan(200);

    expect(findings.map((f) => f.detail)).toEqual([]);
  });
});
