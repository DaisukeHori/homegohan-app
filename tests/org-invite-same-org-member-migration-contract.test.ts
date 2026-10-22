/**
 * #1799 組織の招待で、同じ組織の在籍者の org_role が招待の役割で上書きされないことのソース走査 contract テスト (DB には接続しない)
 *
 * migration 20261017160000_org_invite_same_org_member.sql が入れた守りを、後の migration が accept_org_invite /
 * create_org_invite を CREATE OR REPLACE し直すとき (例: 古い本文をそのままコピーするとき) に落とさないよう、
 * 各関数の「最新の定義」(supabase/migrations を version 順に見て、最後に CREATE OR REPLACE したもの) で確かめる。
 *
 *   1. accept_org_invite: 所属の列が空でない人を (宛先の組織によらず) ALREADY_IN_ORG で断る。招待の組織の持ち主本人も断る。
 *      所属を書く INSERT ... ON CONFLICT DO UPDATE は「所属が空の行だけ」を書き換え、書けなければ ALREADY_IN_ORG
 *   2. create_org_invite: 認可 (NOT_ORG_ADMIN) の後・最初の書き込みと席数・24 時間の上限より前に、宛先の判定の helper を PERFORM する
 *   3. helper: SECURITY DEFINER・search_path = ''・EXECUTE は authenticated だけ。所属組織の owner / admin を自分でも確かめる
 *   4. 戻し口が実在し、helper より先に 2 つの RPC を戻している
 * 実際の挙動は tests/integration/security/org-invite-same-org-member.test.ts (実 DB) が確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261017160000_org_invite_same_org_member';
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);
const HELPER = 'assert_org_invite_recipient_not_in_org';

const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8') }));

interface FunctionDefinition {
  file: string;
  /** CREATE OR REPLACE FUNCTION ... AS $$ の手前まで (属性: SECURITY DEFINER・SET search_path など) */
  header: string;
  body: string;
}

/** SQL の行コメント (-- ...) を取り除く (コメントの中の語に反応しないため) */
const stripLineComments = (sql: string): string => sql.replace(/--.*$/gm, '');

/** 関数 name の定義 (CREATE OR REPLACE FUNCTION) を、与えた SQL の出現順にすべて返す */
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

/** 最初の書き込み文の位置 (FOR UPDATE の行ロックは書き込みと見なさない) */
function firstWriteIndex(body: string): number {
  const write = /\b(?:INSERT\s+INTO|DELETE\s+FROM)\b|(?<!FOR\s)\bUPDATE\s+[A-Za-z_."]+\s+SET\b/i.exec(body);
  return write ? write.index : Infinity;
}

describe('#1799 accept_org_invite の最新の定義', () => {
  const { file, header, body: rawBody } = latestOf('accept_org_invite');
  const body = stripLineComments(rawBody);

  it('SECURITY DEFINER・search_path = public のまま (CREATE OR REPLACE で属性を変えない)', () => {
    expect(header, file).toMatch(/SECURITY\s+DEFINER/i);
    expect(header, file).toMatch(/SET\s+search_path\s*(?:=|TO)\s*'?public'?/i);
  });

  it('所属の列が空でない人は、宛先の組織が同じでも ALREADY_IN_ORG で断る (別の組織のときだけの条件に戻さない)', () => {
    expect(body, file).toMatch(
      /IF\s+v_user_profile\.organization_id\s+IS\s+NOT\s+NULL\s+THEN\s+RAISE\s+EXCEPTION\s+'ALREADY_IN_ORG'/i,
    );
    // 修正前の「別の組織のときだけ」の条件 (organization_id <> v_invite.organization_id) が残っていない
    expect(body, file).not.toMatch(/v_user_profile\.organization_id\s*<>\s*v_invite\.organization_id/i);
  });

  it('招待の組織の持ち主本人も ALREADY_IN_ORG で断る (所属の列が空でも持ち主の役割を書かない)', () => {
    expect(body, file).toMatch(
      /IF\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+organizations\s+WHERE\s+owner_id\s*=\s*auth\.uid\(\)\s+AND\s+id\s*=\s*v_invite\.organization_id\s*\)\s*THEN\s+RAISE\s+EXCEPTION\s+'ALREADY_IN_ORG'/i,
    );
  });

  it('所属を書く ON CONFLICT DO UPDATE は所属が空の行だけを書き換え、書けなければ ALREADY_IN_ORG', () => {
    expect(body, file).toMatch(
      /ON\s+CONFLICT\s*\(\s*id\s*\)\s+DO\s+UPDATE\s+SET[\s\S]*?WHERE\s+user_profiles\.organization_id\s+IS\s+NULL\s+RETURNING\s+\*\s+INTO\s+v_user_profile\s*;\s*IF\s+NOT\s+FOUND\s+THEN\s+RAISE\s+EXCEPTION\s+'ALREADY_IN_ORG'/i,
    );
  });

  it('在籍の判定は、所属を書く前 (最初の書き込みより前) にある', () => {
    const checkAt = body.search(/IF\s+v_user_profile\.organization_id\s+IS\s+NOT\s+NULL/i);
    const upsertAt = body.search(/INSERT\s+INTO\s+user_profiles/i);
    expect(checkAt, file).toBeGreaterThanOrEqual(0);
    expect(upsertAt, file).toBeGreaterThan(checkAt);
  });
});

describe('#1799 create_org_invite の最新の定義', () => {
  const { file, header, body: rawBody } = latestOf('create_org_invite');
  const body = stripLineComments(rawBody);
  const performAt = body.search(new RegExp(`PERFORM\\s+public\\.${HELPER}\\(\\s*p_organization_id\\s*,\\s*p_email\\s*\\)`));

  it('SECURITY DEFINER・search_path = public (#1917: 20261022180000 で利用者の招待の INSERT / UPDATE の権限を外し、DEFINER にした。監査行は従来どおりトリガーが書く)', () => {
    expect(header, file).toMatch(/SECURITY\s+DEFINER/i);
    expect(header, file).toMatch(/SET\s+search_path\s*(?:=|TO)\s*'?public'?/i);
  });

  it(`宛先の判定 (${HELPER}) を 1 回だけ PERFORM する`, () => {
    expect(performAt, `${file} の create_org_invite が ${HELPER} を呼んでいない`).toBeGreaterThanOrEqual(0);
    expect(body.match(new RegExp(`${HELPER}\\(`, 'g')) ?? [], file).toHaveLength(1);
  });

  it('判定は認可 (NOT_ORG_ADMIN) の後、席数・24 時間の上限・最初の書き込みより前', () => {
    const authAt = body.search(/RAISE\s+EXCEPTION\s+'NOT_ORG_ADMIN'/i);
    const seatAt = body.search(/RAISE\s+EXCEPTION\s+'SEAT_LIMIT_EXCEEDED'/i);
    const capAt = body.search(/PERFORM\s+public\.enforce_membership_daily_cap\(/i);
    expect(authAt, file).toBeGreaterThanOrEqual(0);
    expect(performAt, file).toBeGreaterThan(authAt);
    expect(performAt, file).toBeLessThan(seatAt);
    expect(performAt, file).toBeLessThan(capAt);
    expect(performAt, file).toBeLessThan(firstWriteIndex(body));
  });
});

describe(`#1799 helper (${HELPER}) の属性と権限`, () => {
  const { file, header, body: rawBody } = latestOf(HELPER);
  const body = stripLineComments(rawBody);

  it("SECURITY DEFINER・search_path = ''・RETURNS void", () => {
    expect(header, file).toMatch(/SECURITY\s+DEFINER/i);
    expect(header, file).toMatch(/SET\s+search_path\s*(?:=|TO)\s*''/i);
    expect(header, file).toMatch(/RETURNS\s+void/i);
  });

  it('所属組織の owner / admin でなければ NOT_ORG_ADMIN (在籍の判定より前)', () => {
    const authAt = body.search(
      /up\.organization_id\s*=\s*p_organization_id\s+AND\s+up\.org_role\s+IN\s*\(\s*'owner'\s*,\s*'admin'\s*\)\s*\)\s*THEN\s+RAISE\s+EXCEPTION\s+'NOT_ORG_ADMIN'/i,
    );
    const firstAlreadyAt = body.search(/'ALREADY_IN_ORG'/);
    expect(authAt, file).toBeGreaterThanOrEqual(0);
    expect(firstAlreadyAt, file).toBeGreaterThan(authAt);
  });

  it('在籍者 (所属の列がこの組織) と持ち主 (owner_id) の両方を、大文字・小文字を区別せずアドレスで見る', () => {
    expect(body, file).toMatch(/up\.organization_id\s*=\s*p_organization_id\s+AND\s+pg_catalog\.lower\(u\.email\)\s*=\s*pg_catalog\.lower\(p_email\)/i);
    expect(body, file).toMatch(/JOIN\s+auth\.users\s+u\s+ON\s+u\.id\s*=\s*o\.owner_id/i);
    expect(body.match(/RAISE\s+EXCEPTION\s+'ALREADY_IN_ORG'/gi) ?? [], file).toHaveLength(2);
  });

  it('EXECUTE は authenticated にだけ付ける (完全形で REVOKE してから GRANT)', () => {
    const statements = migrations.flatMap(({ file: f, sql }) =>
      [
        ...stripLineComments(sql).matchAll(
          new RegExp(`\\b(GRANT|REVOKE)\\b[^;]*?ON\\s+FUNCTION\\s+public\\.${HELPER}\\b[^;]*;`, 'gi'),
        ),
      ].map((m) => ({ file: f, text: m[0].replace(/\s+/g, ' ') })),
    );
    const revokes = statements.filter((s) => /^REVOKE/i.test(s.text));
    const grants = statements.filter((s) => /^GRANT/i.test(s.text));
    expect(revokes.length, '権限を外す文が無い').toBeGreaterThan(0);
    for (const role of ['PUBLIC', 'anon', 'authenticated', 'service_role']) {
      expect(revokes[0].text, `${revokes[0].file}: ${role} から外す`).toContain(role);
    }
    expect(grants.length, '権限を付ける文が無い').toBeGreaterThan(0);
    for (const { file: f, text } of grants) {
      expect(text, f).toMatch(/\bTO\s+authenticated\s*;$/i);
    }
  });
});

describe('#1799 戻し口', () => {
  it('戻し口が実在し、2 つの RPC を戻してから helper を消す (先に消すと create_org_invite が実行時に失敗する)', () => {
    expect(fs.existsSync(ROLLBACK_PATH), ROLLBACK_PATH).toBe(true);
    const sql = stripLineComments(fs.readFileSync(ROLLBACK_PATH, 'utf-8'));
    const createAt = sql.search(/CREATE OR REPLACE FUNCTION public\.create_org_invite\(/);
    const acceptAt = sql.search(/CREATE OR REPLACE FUNCTION public\.accept_org_invite\(/);
    const dropAt = sql.search(new RegExp(`DROP FUNCTION IF EXISTS public\\.${HELPER}\\(UUID, TEXT\\)`));
    expect(createAt).toBeGreaterThanOrEqual(0);
    expect(acceptAt).toBeGreaterThanOrEqual(0);
    expect(dropAt).toBeGreaterThan(createAt);
    expect(dropAt).toBeGreaterThan(acceptAt);
    // 戻した create_org_invite は helper を呼ばない (helper を消したあとに実行時に失敗しない)
    const restored = definitionsIn(ROLLBACK_PATH, sql, 'create_org_invite');
    expect(restored).toHaveLength(1);
    expect(restored[0].body).not.toContain(HELPER);
  });
});
