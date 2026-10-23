/**
 * 移行の値 (supabase/migrations の subscription_plans の行) のうち、public な個人・家族のプラン (plan_type が personal / family で
 * status が 'public'。free を除く) が、公開の文の正本 PLAN_CATALOG (packages/shared/src/billing-plans.ts) にすべて含まれることの見張り (#1912)。
 *
 * PLAN_CATALOG に無い有料の key は、利用者の画面で汎用の名前 (PAID_PLAN_GENERIC_DISPLAY_NAME「有料プラン」) になり、説明の箇条書きも出ない。
 * migration で public な個人・家族のプランを足す (または private の行を public にする) ときは、同じ PR で PLAN_CATALOG にも足す。
 * 読み方は tests/billing-plan-catalog.test.ts と同じく migration の SQL の文を読む (DB は使わない)。
 * 行の状態は、migration をファイル名の順に読み、INSERT で行を作り、status / plan_type / plan_key を変える UPDATE と DELETE を当てて作る。
 * 読めない形 (plan_key = '<値>' で行を決めない UPDATE / DELETE・リテラルでない値の INSERT) が来たら、黙って飛ばさずに赤にする。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAID_PLAN_KEYS, isCatalogPlanKey } from '@homegohan/shared';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');

/** subscription_plans の表の名前 (public.subscription_plans / "public"."subscription_plans") */
const TABLE = String.raw`(?:public|"public")\.(?:subscription_plans|"subscription_plans")`;
/** 行の状態を変える列 (この列を SET する UPDATE だけを当てる。価格などの UPDATE は見ない) */
const STATE_COLUMNS = ['status', 'plan_type', 'plan_key'] as const;
type StateColumn = (typeof STATE_COLUMNS)[number];
type PlanRowState = Record<StateColumn, string>;

/** 見張る行: status が public で、plan_type が個人か家族 */
const PUBLIC_STATUS = 'public';
const WATCHED_PLAN_TYPES: readonly string[] = ['personal', 'family'];
/** 無料のプランの plan_key (PLAN_CATALOG の外にあってよい唯一の key) */
const FREE_PLAN_KEY = 'free';

/** 一致の位置 at が、その行の -- のコメントの中か */
function isInLineComment(sql: string, at: number): boolean {
  const lineStart = sql.lastIndexOf('\n', at) + 1;
  return sql.slice(lineStart, at).includes('--');
}

/** 値の組の 1 つの値: 文字列 (一重引用符) を含めば quoted で、value はその中身。含まなければ value は前後の空白を除いた生の字 (NULL・数・true など) */
type SqlCell = { value: string; quoted: boolean };

/**
 * VALUES の後ろから、文の終わり (引用符の外の ;) までの値の組を読む。一重引用符の文字列 ('' は ' の 1 字) の中の , ( ) ; -- では切らず、
 * 引用符の外の -- から行末はコメントとして飛ばす。戻り値の rest は、最後の組の後ろから文の終わりまでの字 (ON CONFLICT など)
 */
function readValueTuples(sql: string, from: number): { tuples: SqlCell[][]; rest: string } {
  const tuples: SqlCell[][] = [];
  let depth = 0;
  let current: SqlCell[] = [];
  let raw = '';
  let quotedText = '';
  let quoted = false;
  let restStart = from;
  let i = from;
  const pushCell = () => {
    current.push(quoted ? { value: quotedText, quoted: true } : { value: raw.trim(), quoted: false });
    raw = '';
    quotedText = '';
    quoted = false;
  };
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      // 文字列の中身を読む ('' は ' の 1 字)
      let j = i + 1;
      let text = '';
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          text += "'";
          j += 2;
        } else if (sql[j] === "'") {
          break;
        } else {
          text += sql[j];
          j += 1;
        }
      }
      if (depth >= 1) {
        quotedText += text;
        quoted = true;
      }
      i = j + 1;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const newline = sql.indexOf('\n', i);
      i = newline === -1 ? sql.length : newline;
      continue;
    }
    if (ch === ';' && depth === 0) return { tuples, rest: sql.slice(restStart, i) };
    if (ch === '(') {
      depth += 1;
      if (depth === 1) {
        current = [];
        raw = '';
        quotedText = '';
        quoted = false;
        i += 1;
        continue;
      }
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        pushCell();
        tuples.push(current);
        restStart = i + 1;
        i += 1;
        continue;
      }
    } else if (ch === ',' && depth === 1) {
      pushCell();
      i += 1;
      continue;
    }
    if (depth >= 1) raw += ch;
    i += 1;
  }
  return { tuples, rest: sql.slice(restStart) };
}

/** WHERE の節が plan_key = '<値>' だけなら、その値。ほかの形は null */
function planKeyOfWhere(where: string): string | null {
  return /^\s*"?plan_key"?\s*=\s*'([^']*)'\s*$/.exec(where)?.[1] ?? null;
}

/** SET の節のうち、行の状態の列に入れる値 (リテラルの文字列だけ。リテラルでなければ投げる) */
function stateAssignmentsOf(set: string, label: string): Partial<PlanRowState> {
  const out: Partial<PlanRowState> = {};
  for (const column of STATE_COLUMNS) {
    const assignment = new RegExp(String.raw`(?:^|[\s,])"?${column}"?\s*=\s*([^,]+)`).exec(set);
    if (assignment === null) continue;
    const literal = /^\s*'([^']*)'(?:::[\w" ]+)?\s*$/.exec(assignment[1]);
    if (literal === null) throw new Error(`${label}: subscription_plans の ${column} をリテラルでない値で変えている (${assignment[1].trim()})。この見張りを直す`);
    out[column] = literal[1];
  }
  return out;
}

/** migration をファイル名の順に読み、subscription_plans の行の状態 (plan_key → status・plan_type) を作る */
function subscriptionPlanRowsFromMigrations(): Map<string, PlanRowState> {
  const rows = new Map<string, PlanRowState>();
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{14}_.+\.sql$/.test(name) && !name.endsWith('.down.sql'))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    if (!/subscription_plans/.test(sql)) continue;
    type Op = { at: number; apply: () => void };
    const ops: Op[] = [];

    // INSERT は (列の並び) VALUES の形だけを読む。ほかの形 (列の並びの無いもの・INSERT ... SELECT) は読めないので赤にする
    const insertAts = [...sql.matchAll(new RegExp(String.raw`INSERT\s+INTO\s+${TABLE}`, 'gi'))]
      .map((match) => match.index ?? 0)
      .filter((at) => !isInLineComment(sql, at));
    const valuesInsertAts = new Set<number>();
    for (const match of sql.matchAll(new RegExp(String.raw`INSERT\s+INTO\s+${TABLE}\s*\(([^)]*)\)\s*VALUES`, 'gi'))) {
      const at = match.index ?? 0;
      if (isInLineComment(sql, at)) continue;
      valuesInsertAts.add(at);
      const columns = match[1].split(',').map((column) => column.trim().replace(/"/g, ''));
      const { tuples, rest } = readValueTuples(sql, at + match[0].length);
      const label = `${file} の INSERT`;
      if (tuples.length === 0) throw new Error(`${label}: 値の組を読めない。この見張りを直す`);
      if (/DO\s+UPDATE/i.test(rest) && STATE_COLUMNS.some((column) => new RegExp(String.raw`\b${column}\s*=`).test(rest))) {
        throw new Error(`${label}: ON CONFLICT DO UPDATE で行の状態の列を変えている。この見張りを直す`);
      }
      ops.push({
        at,
        apply: () => {
          for (const tuple of tuples) {
            if (tuple.length !== columns.length) throw new Error(`${label}: 列の数 ${columns.length} と値の数 ${tuple.length} が違う`);
            const valueOf = (column: StateColumn): string => {
              const index = columns.indexOf(column);
              const cell = index === -1 ? undefined : tuple[index];
              if (cell === undefined || !cell.quoted) throw new Error(`${label}: ${column} がリテラルの文字列でない。この見張りを直す`);
              return cell.value;
            };
            rows.set(valueOf('plan_key'), { plan_key: valueOf('plan_key'), plan_type: valueOf('plan_type'), status: valueOf('status') });
          }
        },
      });
    }

    const unreadInserts = insertAts.filter((at) => !valuesInsertAts.has(at));
    if (unreadInserts.length > 0) throw new Error(`${file}: subscription_plans への INSERT を (列の並び) VALUES の形で読めない。この見張りを直す`);

    for (const match of sql.matchAll(new RegExp(String.raw`UPDATE\s+(?:ONLY\s+)?${TABLE}(?:\s+(?:AS\s+)?(?!SET\b)\w+)?\s+SET\s+([\s\S]*?)\s+WHERE\s+([^;]*);`, 'gi'))) {
      const at = match.index ?? 0;
      if (isInLineComment(sql, at)) continue;
      const label = `${file} の UPDATE`;
      const assignments = stateAssignmentsOf(match[1], label);
      if (Object.keys(assignments).length === 0) continue;
      const planKey = planKeyOfWhere(match[2]);
      if (planKey === null) throw new Error(`${label}: 行の状態の列を plan_key = '<値>' 以外の条件で変えている。この見張りを直す`);
      ops.push({
        at,
        apply: () => {
          const row = rows.get(planKey);
          if (row === undefined) return;
          const next = { ...row, ...assignments };
          rows.delete(planKey);
          rows.set(next.plan_key, next);
        },
      });
    }

    for (const match of sql.matchAll(new RegExp(String.raw`DELETE\s+FROM\s+${TABLE}([^;]*);`, 'gi'))) {
      const at = match.index ?? 0;
      if (isInLineComment(sql, at)) continue;
      const where = /^\s*(?:AS\s+\w+\s+)?WHERE\s+([\s\S]*)$/i.exec(match[1])?.[1];
      const planKey = where === undefined ? null : planKeyOfWhere(where);
      if (planKey === null) throw new Error(`${file} の DELETE: plan_key = '<値>' 以外の条件で行を消している。この見張りを直す`);
      ops.push({ at, apply: () => rows.delete(planKey) });
    }

    for (const op of ops.sort((a, b) => a.at - b.at)) op.apply();
  }
  return rows;
}

describe('#1912 migration の public な個人・家族のプランは PLAN_CATALOG にある', () => {
  it('every subscription_plans row the migrations leave with plan_type personal / family and status public (except free) is a PLAN_CATALOG key, and every PLAN_CATALOG key is such a row', () => {
    const rows = subscriptionPlanRowsFromMigrations();
    // 読めていることの確かめ (読み方が壊れて 0 行になったら、下の一致は空で通ってしまう)
    expect(rows.get(FREE_PLAN_KEY)).toEqual({ plan_key: FREE_PLAN_KEY, plan_type: 'personal', status: PUBLIC_STATUS });
    // private の家族の追加枠は見張りの外 (PLAN_CATALOG に無く、画面では汎用の名前になる)
    expect(rows.get('family_addon')).toEqual({ plan_key: 'family_addon', plan_type: 'family', status: 'private' });
    expect(rows.get('org_standard')?.plan_type).toBe('org');

    const watched = [...rows.values()]
      .filter((row) => row.status === PUBLIC_STATUS && WATCHED_PLAN_TYPES.includes(row.plan_type) && row.plan_key !== FREE_PLAN_KEY)
      .map((row) => row.plan_key);
    const notInCatalog = watched.filter((planKey) => !isCatalogPlanKey(planKey));
    expect(notInCatalog, 'public な個人・家族のプランが PLAN_CATALOG に無い (同じ PR で PLAN_CATALOG に足す)').toEqual([]);
    expect([...watched].sort()).toEqual([...PAID_PLAN_KEYS].sort());
  });
});
