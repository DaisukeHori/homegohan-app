/**
 * #1163 DB の 24 時間上限 (enforce_membership_daily_cap) のソース走査 contract テスト (DB には接続しない)
 *
 * 招待・子供メンバーの昇格リクエスト・譲渡提案を作る RPC 5 本は、認可の後・最初の書き込みの前に
 * enforce_membership_daily_cap を PERFORM して、直近 24 時間の上限を DB で確かめる (migration 20261008100000)。
 * 後の migration がこの RPC を CREATE OR REPLACE し直すとき (例: 本番スキーマの本文をそのままコピーするとき) に
 * PERFORM を落とすと、DB の上限が黙って外れる。次を確かめて、そうした退行を CI で止める。
 *
 *   1. 各 RPC の「最新の定義」(supabase/migrations を version 順に見て、最後に CREATE OR REPLACE したもの) が、
 *      正しい種類で helper を PERFORM していて、最初の書き込み (INSERT / UPDATE / DELETE) より前に呼んでいる
 *   2. helper は SECURITY DEFINER・search_path = ''・VOLATILE で、EXECUTE は authenticated にだけ付けている
 *      (VOLATILE でないと、アドバイザリロックを取る前のスナップショットで数えてしまい、同時実行で上限を超えて通る)
 *   3. DB の上限値が、アプリ層の日次上限 (src/lib/rate-limit.ts) と同じ
 *
 * RPC の本文を意図して変えるときは、PERFORM の行を残したまま変更すること。上限の数値を変えるときは、
 * アプリ層 (src/lib/rate-limit.ts) と DB (helper) の両方をそろえて変えること。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const HELPER = 'enforce_membership_daily_cap';

const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8') }));

interface FunctionDefinition {
  file: string;
  /** CREATE OR REPLACE FUNCTION ... AS $$ の手前まで (属性: SECURITY DEFINER・SET search_path・STABLE など) */
  header: string;
  body: string;
}

/** 関数 name の定義 (CREATE OR REPLACE FUNCTION) を、migration の version 順・出現順にすべて返す */
function definitionsOf(name: string): FunctionDefinition[] {
  const found: FunctionDefinition[] = [];
  const pattern = new RegExp(`CREATE OR REPLACE FUNCTION\\s+(?:"?public"?\\.)?"?${name}"?\\s*\\(`, 'g');
  for (const { file, sql } of migrations) {
    pattern.lastIndex = 0;
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
  }
  return found;
}

const latestOf = (name: string): FunctionDefinition => {
  const all = definitionsOf(name);
  expect(all.length, `${name} の定義が migration に見つからない`).toBeGreaterThan(0);
  return all[all.length - 1];
};

/** 最初の書き込み文の位置 (FOR UPDATE の行ロックは書き込みと見なさない) */
function firstWriteIndex(body: string): number {
  const write = /\b(?:INSERT\s+INTO|DELETE\s+FROM)\b|(?<!FOR\s)\bUPDATE\s+[A-Za-z_."]+\s+SET\b/i.exec(body);
  return write ? write.index : Infinity;
}

// RPC → helper に渡す種類
const CAPPED_RPCS: Array<[string, string]> = [
  ['create_family_invite', 'family_invite'],
  ['create_org_invite', 'org_invite'],
  ['request_child_promotion', 'child_promotion'],
  ['propose_family_representative_transfer', 'transfer_propose'],
  ['propose_org_owner_transfer', 'transfer_propose'],
];

describe('DB の 24 時間上限 (#1163): 作成 RPC 5 本の最新の定義', () => {
  it.each(CAPPED_RPCS)('%s: 最新の定義が %s の上限を PERFORM している', (name, kind) => {
    const { file, body } = latestOf(name);

    expect(body, `${file} の ${name} が ${HELPER} を呼んでいない (DB の上限が外れる)`).toMatch(
      new RegExp(`PERFORM\\s+public\\.${HELPER}\\(\\s*'${kind}'\\s*,`),
    );
  });

  it.each(CAPPED_RPCS)('%s: 最初の書き込みより前に判定する', (name) => {
    const { file, body } = latestOf(name);
    const performAt = body.search(new RegExp(`PERFORM\\s+public\\.${HELPER}\\(`));

    expect(performAt, `${file} の ${name} に PERFORM が無い`).toBeGreaterThanOrEqual(0);
    expect(
      performAt,
      `${file} の ${name}: 上限の判定は、最初の書き込み (INSERT / UPDATE / DELETE) より前に置く`,
    ).toBeLessThan(firstWriteIndex(body));
  });

  it('作成 RPC は 1 回の呼び出しで helper を 1 回だけ呼ぶ (アドバイザリロックの順序を固定するため)', () => {
    for (const [name] of CAPPED_RPCS) {
      const { file, body } = latestOf(name);
      const calls = body.match(new RegExp(`${HELPER}\\(`, 'g')) ?? [];
      expect(calls.length, `${file} の ${name}`).toBe(1);
    }
  });
});

describe('DB の 24 時間上限 (#1163): helper の属性と権限', () => {
  it('SECURITY DEFINER・SET search_path = ・VOLATILE (STABLE / IMMUTABLE にしない)', () => {
    const { file, header } = latestOf(HELPER);

    expect(header, `${file}`).toMatch(/SECURITY\s+DEFINER/i);
    expect(header, `${file}: search_path は空文字にして、参照はすべてスキーマ付きにする`).toMatch(
      /SET\s+search_path\s*(?:=|TO)\s*''/i,
    );
    // STABLE / IMMUTABLE だと、ロックを取る前のスナップショットで数えてしまい、同時実行で上限を超えて通る
    expect(header, `${file}: VOLATILE のままにする`).not.toMatch(/\b(?:STABLE|IMMUTABLE)\b/i);
  });

  it('EXECUTE は authenticated にだけ付ける (anon・service_role・PUBLIC には付けない)', () => {
    // SQL のコメント (-- ...) 内の語に反応しないよう、行コメントを取り除いてから文を探す
    const statements = migrations.flatMap(({ file, sql }) =>
      [
        ...sql
          .replace(/--.*$/gm, '')
          .matchAll(new RegExp(`\\b(GRANT|REVOKE)\\b[^;]*?ON\\s+FUNCTION\\s+public\\.${HELPER}\\b[^;]*;`, 'gi')),
      ].map((m) => ({ file, text: m[0].replace(/\s+/g, ' ') })),
    );

    const grants = statements.filter((s) => /^GRANT/i.test(s.text));
    expect(grants.length, '権限を付ける文が無い').toBeGreaterThan(0);
    for (const { file, text } of grants) {
      expect(text, `${file}`).toMatch(/\bTO\s+authenticated\s*;$/i);
    }

    const revokes = statements.filter((s) => /^REVOKE/i.test(s.text));
    expect(revokes.length, '権限を外す文が無い (新しい関数には既定で anon / service_role にも付く)').toBeGreaterThan(0);
    for (const role of ['PUBLIC', 'anon', 'authenticated', 'service_role']) {
      expect(revokes[0].text, `${revokes[0].file}: ${role} から外す`).toContain(role);
    }
  });
});

describe('DB の 24 時間上限 (#1163): 上限値はアプリ層の日次上限と同じ', () => {
  // helper の `IF v_count >= N THEN v_rule := '<種類>:<対象>';` から上限値を読む
  const dbLimits = new Map<string, number>();
  for (const m of latestOf(HELPER).body.matchAll(/IF\s+v_count\s*>=\s*(\d+)\s+THEN\s+v_rule\s*:=\s*'([a-z_]+:[a-z_]+)'/g)) {
    dbLimits.set(m[2], Number(m[1]));
  }

  // src/lib/rate-limit.ts の `{ name: '<名前>-daily', max: N, windowSec: DAY_SEC }` から日次の上限値を読む
  const appSource = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'rate-limit.ts'), 'utf-8');
  const appDaily = new Map<string, number>();
  for (const m of appSource.matchAll(/name:\s*'([a-z-]+-daily)',\s*max:\s*(\d+),\s*windowSec:\s*DAY_SEC/g)) {
    appDaily.set(m[1], Number(m[2]));
  }

  // DB の上限名 → アプリ層の日次ルール名 (docs: migration 20261008100000 のヘッダー)
  const PAIRS: Array<[string, string]> = [
    ['family_invite:per_actor', 'family-invite-daily'],
    ['family_invite:per_target', 'invite-target-daily'],
    ['org_invite:per_actor', 'org-invite-daily'],
    ['org_invite:per_org', 'org-invite-scope-daily'],
    ['org_invite:per_target', 'invite-target-daily'],
    ['child_promotion:per_actor', 'child-promotion-daily'],
    ['child_promotion:per_target', 'invite-target-daily'],
    ['transfer_propose:per_actor', 'transfer-propose-daily'],
  ];

  it('helper が持つ上限は 8 種類 (家族の招待 2・組織の招待 3・昇格リクエスト 2・譲渡提案 1)', () => {
    expect([...dbLimits.keys()].sort()).toEqual(PAIRS.map(([rule]) => rule).sort());
  });

  it.each(PAIRS)('%s は、アプリ層の %s と同じ値', (rule, appRule) => {
    expect(appDaily.has(appRule), `${appRule} が src/lib/rate-limit.ts に無い`).toBe(true);
    expect(
      dbLimits.get(rule),
      `DB の ${rule} (${dbLimits.get(rule)}) とアプリ層の ${appRule} (${appDaily.get(appRule)}) をそろえる`,
    ).toBe(appDaily.get(appRule));
  });
});
