// @vitest-environment node
/**
 * #2086 V5 (triage-1029c) のテスト: メンバーシップの監査ログの操作 (membership_audit.action) と対象 (scope) の表示名の表
 * (src/lib/membership/audit-labels.ts) が、DB が持てる値・書く値の全数をそろえていること。
 *
 * 表に無い値は画面に「不明な操作」「不明な対象」と出るので、DB に値を足して表を足し忘れると、運営に読めない行が出る。
 * そのため、表のキーを次と突き合わせる:
 *  1. 操作: membership_audit_action_check (最後に定義した migration の CHECK の配列) の値と、表のキーが同じ集合
 *  2. 操作: migration の INSERT INTO membership_audit が書く action の値 (git grep の代わりに全 migration を読んで列挙) が、どれも表にある。
 *     action を文字列の定数でなく式で書く INSERT が入ったら、値を列挙できないので失敗にする (表との突き合わせを黙って抜けない)
 *  3. 対象: membership_audit_scope_check の値と、表のキーが同じ集合
 *  4. アプリ (src) は membership_audit に書かない (書くのは DB の関数だけ。書くなら 2 の列挙にアプリも足す)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MEMBERSHIP_AUDIT_ACTION_LABELS,
  MEMBERSHIP_AUDIT_ACTION_UNKNOWN_LABEL,
  MEMBERSHIP_AUDIT_SCOPE_LABELS,
  MEMBERSHIP_AUDIT_SCOPE_UNKNOWN_LABEL,
  membershipAuditActionLabel,
  membershipAuditScopeLabel,
} from '@/lib/membership/audit-labels';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');
const SRC_DIR = path.join(ROOT, 'src');

/** 元に戻す migration (.down.sql) を除いた migration (ファイル名の順 = 適用の順) */
function upMigrations(): { name: string; sql: string }[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
}

/** SQL の行コメント (-- から行末) を除く */
function stripLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/** CHECK (... = ANY (ARRAY[...])) の配列の文字列の値 */
function arrayLiterals(arrayBody: string): string[] {
  return Array.from(arrayBody.matchAll(/'([^']*)'/g), (m) => m[1]);
}

/**
 * 制約 (membership_audit_action_check など) を最後に定義した migration の、許す値の配列。
 * 定義の形は「CONSTRAINT "<name>" CHECK (... ARRAY[...])」(初期のスキーマ) と「ADD CONSTRAINT <name> CHECK (... ARRAY[...])」(後の変更) の 2 つ
 */
function latestCheckValues(constraint: string): { migration: string; values: string[] } {
  const pattern = new RegExp(`CONSTRAINT\\s+"?${constraint}"?\\s+CHECK\\s*\\(([\\s\\S]*?ARRAY\\s*\\[[\\s\\S]*?\\])`, 'g');
  let latest: { migration: string; values: string[] } | null = null;
  for (const { name, sql } of upMigrations()) {
    for (const match of stripLineComments(sql).matchAll(pattern)) {
      latest = { migration: name, values: arrayLiterals(match[1].slice(match[1].indexOf('['))) };
    }
  }
  if (!latest) throw new Error(`${constraint} の定義が migration に無い`);
  return latest;
}

/** 括弧の深さ 0 の , で分ける */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let inString = false;
  for (const ch of text) {
    if (ch === "'") inString = !inString;
    if (!inString && ch === '(') depth += 1;
    if (!inString && ch === ')') depth -= 1;
    if (!inString && ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts;
}

/** 開き括弧の位置から、対応する閉じ括弧の手前までの中身 */
function parenthesized(text: string, open: number): string {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'") inString = !inString;
    if (inString) continue;
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error('括弧が閉じていない');
}

type AuditInsert = { migration: string; actionExpression: string };

/** migration の INSERT INTO membership_audit (...) VALUES (...) / SELECT ... の、action の列に入れる式 */
function auditInserts(): AuditInsert[] {
  const inserts: AuditInsert[] = [];
  const head = /INSERT\s+INTO\s+(?:public\.)?membership_audit\s*\(([^)]*)\)\s*(VALUES|SELECT)/gi;
  for (const { name, sql } of upMigrations()) {
    const body = stripLineComments(sql);
    for (const match of body.matchAll(head)) {
      const columns = match[1].split(',').map((c) => c.trim().replace(/"/g, ''));
      const actionIndex = columns.indexOf('action');
      if (actionIndex < 0) throw new Error(`${name}: action の列の無い INSERT INTO membership_audit`);
      const afterHead = (match.index ?? 0) + match[0].length;
      let values: string[];
      if (match[2].toUpperCase() === 'VALUES') {
        values = splitTopLevel(parenthesized(body, body.indexOf('(', afterHead)));
      } else {
        const selectList = body.slice(afterHead, body.slice(afterHead).search(/\bFROM\b|;/i) + afterHead);
        values = splitTopLevel(selectList);
      }
      inserts.push({ migration: name, actionExpression: values[actionIndex] ?? '' });
    }
  }
  return inserts;
}

describe('#2086 V5 監査ログの操作の表示名の表が、DB の操作の全数をそろえている', () => {
  it('membership_audit_action_check (最後の定義) の値と表のキーが同じ集合', () => {
    const { migration, values } = latestCheckValues('membership_audit_action_check');
    // 20261017030000 (保護者の同意の 2 値) までの 28 値。CHECK を変えたら表も変える
    expect(values.length, `${migration} の CHECK の値`).toBeGreaterThan(0);
    expect(Object.keys(MEMBERSHIP_AUDIT_ACTION_LABELS).sort()).toEqual([...new Set(values)].sort());
  });

  it('migration の INSERT INTO membership_audit が書く action は、どれも文字列の定数で、表にある', () => {
    const inserts = auditInserts();
    expect(inserts.length).toBeGreaterThan(0);
    const notLiteral = inserts.filter((i) => !/^'[a-z_]+'$/.test(i.actionExpression));
    expect(notLiteral.map((i) => `${i.migration}: ${i.actionExpression}`)).toEqual([]);
    const written = new Set(inserts.map((i) => i.actionExpression.slice(1, -1)));
    const missing = [...written].filter((action) => !Object.prototype.hasOwnProperty.call(MEMBERSHIP_AUDIT_ACTION_LABELS, action));
    expect(missing).toEqual([]);
    // 運営の強制操作 (この画面で「運営」の行として出すもの) を列挙できている (列挙の取りこぼしの見張り)
    for (const action of ['operator_force_owner_transfer', 'operator_force_representative_transfer', 'operator_force_dissolve']) {
      expect(written.has(action), action).toBe(true);
    }
  });

  it('membership_audit_scope_check (最後の定義) の値と、対象の表のキーが同じ集合', () => {
    const { values } = latestCheckValues('membership_audit_scope_check');
    expect(Object.keys(MEMBERSHIP_AUDIT_SCOPE_LABELS).sort()).toEqual([...new Set(values)].sort());
  });

  it('アプリ (src) は membership_audit に書かない (読むのは監査ログの API だけ)', () => {
    const readers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && /from\(\s*['"]membership_audit['"]\s*\)/.test(fs.readFileSync(full, 'utf8'))) {
          readers.push(path.relative(ROOT, full).split(path.sep).join('/'));
        }
      }
    };
    walk(SRC_DIR);
    expect(readers).toEqual(['src/app/api/operator/membership/audit/route.ts']);
    const route = fs.readFileSync(path.join(ROOT, readers[0]), 'utf8');
    expect(route).not.toMatch(/\.(insert|upsert|update|delete)\(/);
  });
});

describe('#2086 V5 表示名の関数', () => {
  it('表の値はすべて日本語 (英字だけの名前が無い) で、重なりが無い', () => {
    for (const label of [...Object.values(MEMBERSHIP_AUDIT_ACTION_LABELS), ...Object.values(MEMBERSHIP_AUDIT_SCOPE_LABELS)]) {
      expect(/[぀-ヿ㐀-鿿]/.test(label), label).toBe(true);
      expect(/[A-Za-z]/.test(label), label).toBe(false);
    }
    const actionLabels = Object.values(MEMBERSHIP_AUDIT_ACTION_LABELS);
    expect(new Set(actionLabels).size).toBe(actionLabels.length);
  });

  it('表の値はそのまま返し、表に無い値・null・Object の持つ名前は固定の文', () => {
    expect(membershipAuditActionLabel('operator_force_owner_transfer')).toBe('運営によるオーナーの強制譲渡');
    expect(membershipAuditScopeLabel('organization')).toBe('組織');
    expect(membershipAuditScopeLabel('family')).toBe('家族');
    for (const unknown of ['future_action', '', null, undefined, 'toString', '__proto__', 'constructor']) {
      expect(membershipAuditActionLabel(unknown)).toBe(MEMBERSHIP_AUDIT_ACTION_UNKNOWN_LABEL);
      expect(membershipAuditScopeLabel(unknown)).toBe(MEMBERSHIP_AUDIT_SCOPE_UNKNOWN_LABEL);
    }
    expect(MEMBERSHIP_AUDIT_ACTION_UNKNOWN_LABEL).toBe('不明な操作');
    expect(MEMBERSHIP_AUDIT_SCOPE_UNKNOWN_LABEL).toBe('不明な対象');
  });
});
