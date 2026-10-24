/**
 * #1917 の続き: 退会が deleteUser の前に止まったら、その場で退会の印を消す修正
 * (supabase/migrations/20261024120000_account_deletion_guard_release.sql・src/lib/account-deletion.ts) を、ファイルどうしの
 * 突き合わせで確かめる (DB には接続しない)。後の migration が同じ関数を作り直して判定を落とさないよう、関数は「最新の定義」で見る。
 *
 *   1. end_account_deletion_guard: SECURITY DEFINER・search_path ''。NULL の検査 → 印を付けるときと同じキーの advisory lock →
 *      本人の印だけを消す。EXECUTE は service_role だけ
 *   2. 印を読み書きする 4 か所 (付ける・消す・組織の作成のトリガー・家族の代表者のトリガー) の advisory lock のキーが同じ
 *   3. 退会の本体: deleteUser を呼ぶ直前に「呼んだ」を立て、それより前のどの return (409・失敗) も印を消す道を通る。成功の return は通らない
 *   4. 戻し口が実在し、足した関数を外す
 * 実際の挙動 (409 のあとに家族の作成・承諾・組織の作成が通る・deleteUser のあとは止め続ける・直列化) は
 * tests/integration/security/account-deletion-guard-release.test.ts (実 DB)、止まり方ごとの呼び出しは tests/account-deletion.test.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261024120000_account_deletion_guard_release';
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`);
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);
const ACCOUNT_DELETION = 'src/lib/account-deletion.ts';

const TABLE = 'account_deletion_guards';
const END_FN = 'end_account_deletion_guard';
/** 印を読み書きする関数と、advisory lock のキーにする人の id の式 */
const GUARD_LOCK_HOLDERS: ReadonlyArray<[fn: string, idExpression: string]> = [
  ['begin_account_deletion_guard', 'p_user_id'],
  [END_FN, 'p_user_id'],
  ['organizations_owner_not_deleting', 'NEW.owner_id'],
  ['family_groups_representative_not_deleting', 'NEW.representative_id'],
];
const ADVISORY_KEY_PREFIX = "'account_deletion_guard:'";

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf-8');

const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8') }));

/** SQL の行コメント (-- ...) を取り除く (コメントの中の語に反応しないため) */
const stripLineComments = (sql: string): string => sql.replace(/--.*$/gm, '');
/** TS の行コメント・ブロックコメントを取り除く (コメントの中の語に反応しないため。ここで読むファイルは文字列の中に // を書いていない行だけを見る) */
const stripTsComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** 空白をまとめる (字下げ・改行の違いを無視して比べるため) */
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

const migrationSql = squash(stripLineComments(fs.readFileSync(MIGRATION_PATH, 'utf-8')));

interface FunctionDefinition {
  file: string;
  header: string;
  body: string;
}

function definitionsIn(file: string, sql: string, name: string): FunctionDefinition[] {
  const found: FunctionDefinition[] = [];
  const pattern = new RegExp(`CREATE OR REPLACE FUNCTION\\s+(?:"?public"?\\.)?"?${name}"?\\s*\\(`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql))) {
    const rest = sql.slice(match.index);
    const opener = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(rest);
    if (!opener) continue;
    const bodyStart = opener.index + opener[0].length;
    const bodyEnd = rest.indexOf(opener[1], bodyStart);
    if (bodyEnd < 0) continue;
    found.push({ file, header: rest.slice(0, opener.index), body: rest.slice(bodyStart, bodyEnd) });
  }
  return found;
}

function latestOf(name: string): FunctionDefinition {
  const all = migrations.flatMap(({ file, sql }) => definitionsIn(file, sql, name));
  expect(all.length, `${name} の定義が migration に見つからない`).toBeGreaterThan(0);
  return all[all.length - 1];
}

/** 本文の中で、パターンが最初に現れる位置 (無ければ失敗) */
function indexIn(body: string, pattern: RegExp, label: string): number {
  const match = pattern.exec(body);
  expect(match, `${label} が見つからない`).not.toBeNull();
  return match!.index;
}

/** advisory lock を取る文 (印のキー・人の id の式) */
const advisoryLockPattern = (idExpression: string): RegExp =>
  new RegExp(
    String.raw`PERFORM pg_catalog\.pg_advisory_xact_lock\( pg_catalog\.hashtextextended\(${ADVISORY_KEY_PREFIX} \|\| ${idExpression.replace('.', '\\.')}::pg_catalog\.text, 0\)\);`,
  );

describe(`${MIGRATION}: ${END_FN} (退会の印を消す)`, () => {
  const definition = latestOf(END_FN);
  const body = squash(stripLineComments(definition.body));

  it(`最新の定義はこの migration で、RETURNS void・SECURITY DEFINER・SET search_path = ''`, () => {
    expect(definition.file).toBe(`${MIGRATION}.sql`);
    expect(squash(definition.header)).toMatch(/RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''$/);
  });

  it('p_user_id が NULL なら 22023 → 印のキーの advisory lock → 本人の印だけを消す (この順)', () => {
    const nullCheck = indexIn(body, /IF p_user_id IS NULL THEN RAISE EXCEPTION '[^']+' USING ERRCODE = '22023'; END IF;/, 'NULL の検査');
    const lock = indexIn(body, advisoryLockPattern('p_user_id'), 'advisory lock');
    const remove = indexIn(body, new RegExp(String.raw`DELETE FROM public\.${TABLE} AS g WHERE g\.user_id = p_user_id;`), '印の DELETE');
    expect(nullCheck).toBeLessThan(lock);
    expect(lock).toBeLessThan(remove);
    // 消すほかには何も書かない (印を付け直さない・ほかの表に触れない)
    expect(body.match(/\b(?:INSERT|UPDATE|DELETE)\b/g)).toEqual(['DELETE']);
  });

  it('EXECUTE は service_role だけ (PUBLIC・anon・authenticated から外す)', () => {
    expect(migrationSql).toContain(`REVOKE ALL ON FUNCTION public.${END_FN}(uuid) FROM PUBLIC, anon, authenticated, service_role;`);
    const grants = [...migrationSql.matchAll(new RegExp(String.raw`GRANT EXECUTE ON FUNCTION public\.${END_FN}\(uuid\) TO ([^;]+);`, 'g'))];
    expect(grants.map((m) => m[1])).toEqual(['service_role']);
  });

  it('関数を足すだけ (表・トリガー・ほかの関数を作り直さない・消さない)', () => {
    const created = [...migrationSql.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(/g)].map((m) => m[1]);
    expect(created).toEqual([END_FN]);
    expect(migrationSql).not.toMatch(/\b(?:DROP|ALTER TABLE|CREATE TABLE|CREATE (?:OR REPLACE )?TRIGGER|TRUNCATE)\b/);
  });
});

describe('印を読み書きする 4 か所の advisory lock のキーが同じ (付ける・消す・2 つのトリガー)', () => {
  it.each(GUARD_LOCK_HOLDERS)('%s は印のキーで %s の advisory lock を取る', (fn, idExpression) => {
    const body = squash(stripLineComments(latestOf(fn).body));
    indexIn(body, advisoryLockPattern(idExpression), `${fn} の advisory lock`);
  });
});

describe(`${MIGRATION}: 退会の本体 (${ACCOUNT_DELETION})`, () => {
  const source = squash(stripTsComments(read(ACCOUNT_DELETION)));
  const deleteAccountStart = source.indexOf('export async function deleteAccount(');
  const deleteAccountEnd = source.indexOf('export type AccountDeletionBillingPhase');
  const body = source.slice(deleteAccountStart, deleteAccountEnd);

  it('読めている (読み取りが壊れて素通りしない)', () => {
    expect(deleteAccountStart).toBeGreaterThan(0);
    expect(deleteAccountEnd).toBeGreaterThan(deleteAccountStart);
  });

  it(`印を消す関数は ${END_FN} を本人の id で呼び、失敗を投げずにログに残す (応答を変えない)`, () => {
    const helperStart = source.indexOf('async function endDeletionGuard(');
    expect(helperStart).toBeGreaterThan(0);
    const helper = source.slice(helperStart, source.indexOf('async function findBlocker('));
    expect(helper).toMatch(
      new RegExp(String.raw`try \{ const \{ error \} = await admin\.rpc\('${END_FN}', \{ p_user_id: userId \}\); if \(error\) throw error; \} catch \(error\) \{ userLog\.error\(`),
    );
    expect(helper).not.toMatch(/\bthrow\b(?! error; \} catch)/);
  });

  it('deleteUser を呼ぶ直前に「呼んだ」を立てる (呼んだあとに止まっても印を消さない)', () => {
    expect(body).toContain('deleteUserCalled = true; const { error: deleteError } = await admin.auth.admin.deleteUser(userId);');
    expect(body.split('deleteUserCalled = true;')).toHaveLength(2);
    expect(body).toContain('if (!deleteUserCalled) await endDeletionGuard(admin, userId, userLog, requestId, step);');
  });

  it('成功のほかのどの return も、印を消す道 (stopBeforeDeletion) を通る (409・失敗)', () => {
    const returns = [...body.matchAll(/\breturn ([^;]+);/g)].map((m) => m[1]);
    // stopBeforeDeletion の中の return result と、成功の return { ok: true } のほかは、すべて stopBeforeDeletion を通す
    const others = returns.filter((expression) => expression !== 'result' && expression !== '{ ok: true }');
    expect(others.length).toBeGreaterThanOrEqual(3);
    for (const expression of others) expect(expression).toMatch(/^await stopBeforeDeletion\(/);
    expect(body).toContain('return await stopBeforeDeletion(accountDeletionFailure(requestId, step));');
    expect(returns.filter((expression) => expression === '{ ok: true }')).toHaveLength(1);
  });
});

describe(`${MIGRATION}: 戻し口`, () => {
  it('実在し、足した関数を外す (印の表・印を付ける関数・トリガーは外さない)', () => {
    expect(fs.existsSync(ROLLBACK_PATH)).toBe(true);
    const rollback = squash(stripLineComments(fs.readFileSync(ROLLBACK_PATH, 'utf-8')));
    expect(rollback).toContain(`DROP FUNCTION IF EXISTS public.${END_FN}(uuid);`);
    expect(rollback).not.toMatch(/DROP (?:TABLE|TRIGGER)\b/);
    expect(rollback).not.toContain('begin_account_deletion_guard');
  });
});
