/**
 * #1562 migration 20261016190000_deletion_record_and_invite_email_hash.sql (と、そのロールバック) と、退会の本体の
 * ソース走査 contract テスト (DB は使わない)
 *
 * 本物の DB での振る舞いは tests/integration/security/deletion-record-and-invite-email-hash.test.ts・account-deletion.test.ts・
 * membership-daily-cap.test.ts が確かめる。ここでは、書き方の決まりごとが崩れていないかを文面だけで確かめる。
 *   1. 鍵の値を migration に書かない (Vault に乱数で作る。16 進の長い文字列のリテラルが無い)
 *   2. 上限の判定 (enforce_membership_daily_cap) の最新の定義は、宛先を email_hash で比べ、生の email を読まない。
 *      上限の数・ロックのキーは 20261008100000 の定義から変えていない
 *   3. membership_audit のトリガーは BEFORE INSERT OR UPDATE で、metadata の email を置き換える
 *   4. 新しい関数は SECURITY DEFINER + SET search_path = ''、REVOKE は PUBLIC, anon, authenticated, service_role の完全形
 *   5. gdpr_deletion_requests の user_id の外部キーを外し、新しく auth.users を指す外部キーを足さない。利用者向けのポリシーを外す
 *   6. 退会の本体は、削除の実行記録を始めてから deleteUser を呼び、その後に済んだ印を入れる
 *   7. ロールバックは、足した関数・トリガー・列を消し、上限の判定を生の email の比較に戻す
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');
const MIGRATION_NAME = '20261016190000_deletion_record_and_invite_email_hash.sql';
const CAP_MIGRATION_NAME = '20261008100000_membership_daily_send_cap.sql';
const ROLLBACK = 'supabase/rollbacks/20261016190000_deletion_record_and_invite_email_hash.down.sql';
const ACCOUNT_DELETION = 'src/lib/account-deletion.ts';

/** `--` から行末までのコメントを除く (この migration では、文字列リテラルの中に `--` は出てこない) */
function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const migration = stripLineComments(read(`supabase/migrations/${MIGRATION_NAME}`));
const rollback = stripLineComments(read(ROLLBACK));

/** CREATE OR REPLACE FUNCTION public.<name>( ... から、次の `$tag$;` までの定義 (最後に出てきたもの) */
function functionDefinition(sql: string, name: string): string | undefined {
  const pattern = new RegExp(
    String.raw`CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.${name}\s*\([\s\S]*?(\$[A-Za-z_]*\$)[\s\S]*?\1\s*;`,
    'gi',
  );
  const matches = [...sql.matchAll(pattern)];
  return matches.length > 0 ? matches[matches.length - 1][0] : undefined;
}

/** 番号順で最後に enforce_membership_daily_cap を定義した migration と、その定義 */
function latestCapDefinition(): { file: string; body: string } {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();
  let latest: { file: string; body: string } | undefined;
  for (const file of files) {
    const body = functionDefinition(stripLineComments(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')), 'enforce_membership_daily_cap');
    if (body) latest = { file, body };
  }
  if (!latest) throw new Error('enforce_membership_daily_cap の定義が見つからない');
  return latest;
}

const NEW_FUNCTIONS = [
  { name: 'pii_hmac_hex', signature: 'public.pii_hmac_hex(text, text)', grantToServiceRole: true },
  { name: 'membership_invite_email_hash', signature: 'public.membership_invite_email_hash(text)', grantToServiceRole: true },
  { name: 'membership_audit_hash_email_in_metadata', signature: 'public.membership_audit_hash_email_in_metadata(jsonb)', grantToServiceRole: false },
  { name: 'membership_audit_hash_invite_email', signature: 'public.membership_audit_hash_invite_email()', grantToServiceRole: false },
  {
    name: 'begin_account_deletion_record',
    signature: 'public.begin_account_deletion_record(uuid, text, text, text, uuid)',
    grantToServiceRole: true,
  },
  { name: 'complete_account_deletion_record', signature: 'public.complete_account_deletion_record(uuid)', grantToServiceRole: true },
] as const;

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('#1562 migration: 鍵', () => {
  it('鍵は Vault に乱数で作る。値 (16 進 32 文字以上のリテラル) を migration に書かない。あれば作り直さない', () => {
    expect(migration).toMatch(/vault\.create_secret\s*\(/);
    expect(migration).toMatch(/IF\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+vault\.secrets[\s\S]*?'pii_hmac_key'/i);
    expect(migration).not.toMatch(/'[0-9a-f]{32,}'/i);
  });
});

describe('#1562 migration: 上限の判定 (enforce_membership_daily_cap)', () => {
  const latest = latestCapDefinition();
  const previous = functionDefinition(stripLineComments(read(`supabase/migrations/${CAP_MIGRATION_NAME}`)), 'enforce_membership_daily_cap');

  it('最新の定義はこの migration にある', () => {
    expect(latest.file).toBe(MIGRATION_NAME);
  });

  it('宛先は email_hash で比べ、生の email を読まない (3 種の「同じ宛先へ」の判定すべて)', () => {
    expect(latest.body).not.toMatch(/->>\s*'email'\s*\)/);
    expect([...latest.body.matchAll(/\(a\.metadata\s*->>\s*'email_hash'\)\s*=\s*v_email_hash/g)]).toHaveLength(3);
    expect([...latest.body.matchAll(/v_email_hash\s*:=\s*public\.membership_invite_email_hash\(p_email\)/g)]).toHaveLength(3);
  });

  it('上限の数・ロックのキー・上限名は 20261008100000 の定義と同じ', () => {
    expect(previous).toBeDefined();
    const numbers = (body: string) => [...body.matchAll(/v_count\s*>=\s*(\d+)/g)].map((match) => match[1]);
    const locks = (body: string) => [...body.matchAll(/'membership_daily_cap:[a-z_:]+'/g)].map((match) => match[0]);
    const rules = (body: string) => [...body.matchAll(/v_rule\s*:=\s*'([a-z_:]+)'/g)].map((match) => match[1]);
    expect(numbers(latest.body)).toEqual(numbers(previous!));
    expect(locks(latest.body)).toEqual(locks(previous!));
    expect(rules(latest.body)).toEqual(rules(previous!));
    expect(numbers(latest.body).length).toBeGreaterThan(0);
  });

  it('権限は 20261008100000 と同じ (完全形で REVOKE し、authenticated にだけ GRANT)', () => {
    expect(migration).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.enforce_membership_daily_cap\(TEXT,\s*UUID,\s*TEXT\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated,\s*service_role;/i,
    );
    expect(migration).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.enforce_membership_daily_cap\(TEXT,\s*UUID,\s*TEXT\)\s+TO\s+authenticated;/i);
  });
});

describe('#1562 migration: membership_audit のトリガー', () => {
  it('BEFORE INSERT OR UPDATE OF metadata で、email のある行だけに効く', () => {
    expect(migration).toMatch(
      /CREATE\s+TRIGGER\s+trg_membership_audit_hash_invite_email\s+BEFORE\s+INSERT\s+OR\s+UPDATE\s+OF\s+metadata\s+ON\s+public\.membership_audit\s+FOR\s+EACH\s+ROW\s+WHEN\s*\(\s*NEW\.metadata\s*\?\s*'email'\s*\)\s+EXECUTE\s+FUNCTION\s+public\.membership_audit_hash_invite_email\(\)/i,
    );
  });

  it('既存の行は、トリガーと同じ置き換えの関数で置き換える', () => {
    expect(migration).toMatch(
      /UPDATE\s+public\.membership_audit\s+AS\s+a\s+SET\s+metadata\s*=\s*public\.membership_audit_hash_email_in_metadata\(a\.metadata\)\s+WHERE\s+a\.metadata\s*\?\s*'email'/i,
    );
  });
});

describe('#1562 migration: 新しい関数の権限', () => {
  for (const fn of NEW_FUNCTIONS) {
    it(`${fn.name}: SECURITY DEFINER + search_path 空。REVOKE は完全形。${fn.grantToServiceRole ? 'service_role にだけ GRANT' : '誰にも GRANT しない'}`, () => {
      const body = functionDefinition(migration, fn.name);
      expect(body, fn.name).toBeDefined();
      expect(body).toMatch(/SECURITY\s+DEFINER/i);
      expect(body).toMatch(/SET\s+search_path\s*=\s*''/i);
      const sig = escape(fn.signature).replace(/,\\? /g, ',\\s*');
      expect(migration).toMatch(new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${sig}\\s+FROM\\s+PUBLIC,\\s*anon,\\s*authenticated,\\s*service_role;`, 'i'));
      const grants = [...migration.matchAll(new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+${sig}\\s+TO\\s+(\\w+)`, 'gi'))].map((m) => m[1]);
      expect(grants).toEqual(fn.grantToServiceRole ? ['service_role'] : []);
    });
  }

  it('HMAC は pgcrypto を完全修飾で呼ぶ (search_path に頼らない)', () => {
    expect(functionDefinition(migration, 'pii_hmac_hex')).toMatch(/extensions\.hmac\(/);
  });
});

describe('#1562 migration: gdpr_deletion_requests', () => {
  it('user_id の外部キーを外す。auth.users を指す外部キーを新しく足さない', () => {
    expect(migration).toMatch(/DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+gdpr_deletion_requests_user_id_fkey\s*;/i);
    expect(migration).not.toMatch(/REFERENCES\s+auth\.users/i);
  });

  it('利用者向けのポリシー 3 本を外し、anon / authenticated の表の権限を外す', () => {
    for (const policy of ['gdpr_insert_self', 'gdpr_select', 'gdpr_update']) {
      expect(migration).toMatch(new RegExp(`DROP\\s+POLICY\\s+IF\\s+EXISTS\\s+${policy}\\s+ON\\s+public\\.gdpr_deletion_requests`, 'i'));
    }
    expect(migration).not.toMatch(/CREATE\s+POLICY[\s\S]*?ON\s+public\.gdpr_deletion_requests/i);
    expect(migration).toMatch(/REVOKE\s+ALL\s+ON\s+TABLE\s+public\.gdpr_deletion_requests\s+FROM\s+PUBLIC,\s*anon,\s*authenticated\s*;/i);
  });

  it('記録の関数は、利用者の id を user_id に書かない (NULL)。id は pii_hmac_hex を通してから書く', () => {
    const body = functionDefinition(migration, 'begin_account_deletion_record')!;
    expect(body).toMatch(/v_hash\s*:=\s*public\.pii_hmac_hex\('account_deletion_subject',\s*p_user_id::pg_catalog\.text\)/);
    expect(body).toMatch(/VALUES\s*\(\s*NULL,\s*v_hash,/);
  });

  it('足した列の CHECK は NULL を許す (既存の行が必ず通る)', () => {
    const checks = [...migration.matchAll(/ADD\s+CONSTRAINT\s+(\w+)\s+CHECK\s*\(([^;]*?)\)\s*(?:,|;)/gi)];
    expect(checks.map((match) => match[1]).sort()).toEqual([
      'gdpr_deletion_requests_executor_type_check',
      'gdpr_deletion_requests_reason_code',
      'gdpr_deletion_requests_subject_hash_format',
    ]);
    for (const match of checks) expect(match[2], match[1]).toMatch(/^\s*\w+\s+IS\s+NULL\s+OR\b/i);
  });
});

describe('#1562 退会の本体 (src/lib/account-deletion.ts)', () => {
  const source = read(ACCOUNT_DELETION);

  it('記録を始める → deleteUser → 済んだ印 の順に書いてある', () => {
    const begin = source.indexOf('await beginDeletionRecord(');
    const deleteUser = source.indexOf('await admin.auth.admin.deleteUser(');
    const complete = source.indexOf('await completeDeletionRecord(');
    expect(begin).toBeGreaterThan(0);
    expect(deleteUser).toBeGreaterThan(begin);
    expect(complete).toBeGreaterThan(deleteUser);
    expect(source).toContain("rpc('begin_account_deletion_record'");
    expect(source).toContain("rpc('complete_account_deletion_record'");
  });
});

describe('#1562 ロールバック', () => {
  it('足した関数・トリガー・列を消す', () => {
    for (const fn of NEW_FUNCTIONS) {
      expect(rollback).toMatch(new RegExp(`DROP\\s+FUNCTION\\s+IF\\s+EXISTS\\s+public\\.${fn.name}\\(`, 'i'));
    }
    expect(rollback).toMatch(/DROP\s+TRIGGER\s+IF\s+EXISTS\s+trg_membership_audit_hash_invite_email\s+ON\s+public\.membership_audit/i);
    for (const column of ['subject_hash', 'executor_type', 'reason', 'request_id']) {
      expect(rollback).toMatch(new RegExp(`DROP\\s+COLUMN\\s+IF\\s+EXISTS\\s+${column}\\b`, 'i'));
    }
  });

  it('上限の判定を生の email の比較 (20261008100000 の定義) に戻す。外部キーとポリシーを戻す', () => {
    const body = functionDefinition(rollback, 'enforce_membership_daily_cap');
    expect(body).toBeDefined();
    expect([...body!.matchAll(/\(a\.metadata\s*->>\s*'email'\)\s*=\s*v_email/g)]).toHaveLength(3);
    expect(body).not.toMatch(/email_hash/);
    expect(rollback).toMatch(/ADD\s+CONSTRAINT\s+gdpr_deletion_requests_user_id_fkey\s+FOREIGN\s+KEY\s*\(user_id\)\s+REFERENCES\s+auth\.users\s*\(id\)\s+ON\s+DELETE\s+SET\s+NULL/i);
    for (const policy of ['gdpr_insert_self', 'gdpr_select', 'gdpr_update']) {
      expect(rollback).toMatch(new RegExp(`CREATE\\s+POLICY\\s+${policy}\\s+ON\\s+public\\.gdpr_deletion_requests`, 'i'));
    }
  });
});
