/**
 * リポジトリ内のスキーマ定義から、public テーブルの列・主キー・外部キーを読み出すテスト用ヘルパー。
 *
 * 出発点は本番スキーマのスナップショット (supabase/baseline/prod_schema.sql。pg_dump の出力)。
 * そこに、スナップショットより新しい migration (manifest.json の ledger_max_version より大きい version) の
 * CREATE TABLE / DROP TABLE を重ねる。ローカル / CI の Supabase の組み立て (scripts/supabase-local.sh) と同じ考え方で、
 * 「次に本番に入るスキーマ」の public テーブル一覧になる。
 *
 * DB には接続しない (ファイルを読むだけ)。migration 側の解析はベストエフォート (CREATE TABLE の列と
 * PRIMARY KEY / REFERENCES だけを見る)。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface SchemaForeignKey {
  column: string;
  refSchema: string;
  refTable: string;
}

export interface SchemaTable {
  name: string;
  columns: string[];
  primaryKey: string[] | null;
  foreignKeys: SchemaForeignKey[];
}

const REPO_ROOT = process.cwd();
const BASELINE_DIR = path.join(REPO_ROOT, 'supabase', 'baseline');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');

function identifiers(list: string): string[] {
  return [...list.matchAll(/"?([a-zA-Z0-9_]+)"?/g)].map((m) => m[1]);
}

/** pg_dump 形式 (prod_schema.sql) の public テーブルを読む */
function parseBaseline(sql: string, tables: Map<string, SchemaTable>) {
  for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS "public"\."([a-z0-9_]+)" \(([\s\S]*?)\n\);/g)) {
    const columns: string[] = [];
    for (const line of m[2].split('\n')) {
      const column = line.trim().match(/^"([a-z0-9_]+)" /);
      if (column) columns.push(column[1]);
    }
    tables.set(m[1], { name: m[1], columns, primaryKey: null, foreignKeys: [] });
  }

  for (const m of sql.matchAll(
    /ALTER TABLE ONLY "public"\."([a-z0-9_]+)"\s+ADD CONSTRAINT "[^"]+" PRIMARY KEY \(([^)]*)\)/g,
  )) {
    const table = tables.get(m[1]);
    if (table) table.primaryKey = identifiers(m[2]);
  }

  for (const m of sql.matchAll(
    /ALTER TABLE ONLY "public"\."([a-z0-9_]+)"\s+ADD CONSTRAINT "[^"]+" FOREIGN KEY \(([^)]*)\) REFERENCES "([a-z_]+)"\."([a-z0-9_]+)"/g,
  )) {
    const table = tables.get(m[1]);
    if (!table) continue;
    for (const column of identifiers(m[2])) {
      table.foreignKeys.push({ column, refSchema: m[3], refTable: m[4] });
    }
  }
}

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** text[start] が '(' のとき、対応する ')' の位置を返す */
function findClosingParen(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelCommas(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

const TABLE_CONSTRAINT = /^(constraint|primary\s+key|foreign\s+key|unique|check|like|exclude)\b/i;

const refersTo = (text: string) => text.match(/\breferences\s+(?:"?([a-z_]+)"?\.)?"?([a-z0-9_]+)"?/i);

/** ALTER TABLE の 1 つの操作 (カンマ区切りの 1 要素) を反映する */
function alterTable(tables: Map<string, SchemaTable>, name: string, action: string) {
  const table = tables.get(name);

  const renameTable = action.match(/^rename\s+to\s+"?([a-z0-9_]+)"?/i);
  if (renameTable) {
    if (table) {
      tables.delete(name);
      tables.set(renameTable[1], { ...table, name: renameTable[1] });
    }
    return;
  }
  if (!table) return;

  const addColumn = action.match(/^add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?\s*([\s\S]*)$/i);
  if (addColumn) {
    const [, column, rest] = addColumn;
    if (!table.columns.includes(column)) table.columns.push(column);
    if (/\bprimary\s+key\b/i.test(rest)) table.primaryKey = [column];
    const ref = refersTo(rest);
    if (ref) table.foreignKeys.push({ column, refSchema: ref[1] ?? 'public', refTable: ref[2] });
    return;
  }

  const dropColumn = action.match(/^drop\s+column\s+(?:if\s+exists\s+)?"?([a-z0-9_]+)"?/i);
  if (dropColumn) {
    table.columns = table.columns.filter((c) => c !== dropColumn[1]);
    table.foreignKeys = table.foreignKeys.filter((fk) => fk.column !== dropColumn[1]);
    return;
  }

  const renameColumn = action.match(/^rename\s+(?:column\s+)?"?([a-z0-9_]+)"?\s+to\s+"?([a-z0-9_]+)"?/i);
  if (renameColumn) {
    const [, from, to] = renameColumn;
    const rename = (c: string) => (c === from ? to : c);
    table.columns = table.columns.map(rename);
    table.primaryKey = table.primaryKey?.map(rename) ?? null;
    table.foreignKeys = table.foreignKeys.map((fk) => ({ ...fk, column: rename(fk.column) }));
    return;
  }

  const addConstraint = action.match(
    /^add\s+(?:constraint\s+"?[a-z0-9_]+"?\s+)?(primary\s+key|foreign\s+key)\s*\(([^)]*)\)\s*([\s\S]*)$/i,
  );
  if (addConstraint) {
    const columns = identifiers(addConstraint[2]);
    if (/^primary/i.test(addConstraint[1])) {
      table.primaryKey = columns;
      return;
    }
    const ref = refersTo(addConstraint[3]);
    if (ref) {
      for (const column of columns) table.foreignKeys.push({ column, refSchema: ref[1] ?? 'public', refTable: ref[2] });
    }
  }
}

/** 手書きの migration の CREATE TABLE / ALTER TABLE / DROP TABLE を重ねる (ベストエフォート) */
export function applyMigration(rawSql: string, tables: Map<string, SchemaTable>) {
  const sql = stripSqlComments(rawSql);
  const events: Array<{ index: number; run: () => void }> = [];

  const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-z0-9_]+)"?\s*\(/gi;
  for (const m of sql.matchAll(createRe)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = findClosingParen(sql, open);
    if (close < 0) continue;
    const name = m[1];
    const items = splitTopLevelCommas(sql.slice(open + 1, close));
    events.push({
      index: m.index ?? 0,
      run: () => {
        const table: SchemaTable = { name, columns: [], primaryKey: null, foreignKeys: [] };
        for (const item of items) {
          if (TABLE_CONSTRAINT.test(item)) {
            const pk = item.match(/primary\s+key\s*\(([^)]*)\)/i);
            if (pk) table.primaryKey = identifiers(pk[1]);
            const fk = item.match(/foreign\s+key\s*\(([^)]*)\)\s*references\s+(?:"?([a-z_]+)"?\.)?"?([a-z0-9_]+)"?/i);
            if (fk) {
              for (const column of identifiers(fk[1])) {
                table.foreignKeys.push({ column, refSchema: fk[2] ?? 'public', refTable: fk[3] });
              }
            }
            continue;
          }
          const column = item.match(/^"?([a-z0-9_]+)"?\s/i);
          if (!column) continue;
          table.columns.push(column[1]);
          if (/\bprimary\s+key\b/i.test(item)) table.primaryKey = [column[1]];
          const ref = item.match(/\breferences\s+(?:"?([a-z_]+)"?\.)?"?([a-z0-9_]+)"?/i);
          if (ref) table.foreignKeys.push({ column: column[1], refSchema: ref[1] ?? 'public', refTable: ref[2] });
        }
        tables.set(name, table);
      },
    });
  }

  const alterRe = /alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(?:"?public"?\.)?"?([a-z0-9_]+)"?\s+([^;]*);/gi;
  for (const m of sql.matchAll(alterRe)) {
    const actions = splitTopLevelCommas(m[2]);
    events.push({
      index: m.index ?? 0,
      run: () => actions.forEach((action) => alterTable(tables, m[1], action)),
    });
  }

  const dropRe = /drop\s+table\s+(?:if\s+exists\s+)?(?:"?public"?\.)?"?([a-z0-9_]+)"?/gi;
  for (const m of sql.matchAll(dropRe)) {
    events.push({ index: m.index ?? 0, run: () => void tables.delete(m[1]) });
  }

  // ファイル内の出現順に適用する (DROP のあとの CREATE など)
  events.sort((a, b) => a.index - b.index).forEach((event) => event.run());
}

export function loadSchemaModel(): Map<string, SchemaTable> {
  const tables = new Map<string, SchemaTable>();
  parseBaseline(fs.readFileSync(path.join(BASELINE_DIR, 'prod_schema.sql'), 'utf8'), tables);

  const manifest = JSON.parse(fs.readFileSync(path.join(BASELINE_DIR, 'manifest.json'), 'utf8')) as {
    ledger_max_version: string;
  };
  const newerMigrations = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{14}_.+\.sql$/.test(file) && file.slice(0, 14) > manifest.ledger_max_version)
    .sort();
  for (const file of newerMigrations) {
    applyMigration(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'), tables);
  }
  return tables;
}
