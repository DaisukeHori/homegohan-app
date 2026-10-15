/**
 * #1562 削除の実行記録 (gdpr_deletion_requests) と、招待の監査 (membership_audit) の招待先アドレスのハッシュ化 (実 DB)
 *
 * migration 20261015190000_deletion_record_and_invite_email_hash.sql が入れたものを確かめる:
 *   A. ハッシュ: pii_hmac_hex は Vault の鍵 pii_hmac_key を使う HMAC-SHA256 (16 進 64 文字)。同じ入力は同じ値、用途 (domain) が違えば別の値。
 *      membership_invite_email_hash は大文字小文字と前後の空白を揃えてからハッシュにする。空・NULL は NULL
 *   B. membership_audit: metadata に生のアドレス (email) を書いても、保存されるのは email_hash だけ (INSERT / UPDATE とも)。
 *      email の無い行はそのまま。文字列でない email は取り除くだけ。表のどの行にも email のキーが残っていない (既存の行の置き換え)
 *   C. gdpr_deletion_requests: 利用者向けのポリシーが無く、anon / authenticated は読めない・書けない (service_role だけ)
 *   D. begin_account_deletion_record / complete_account_deletion_record:
 *      - 記録は利用者の id を持たず (user_id は NULL)、subject_hash = pii_hmac_hex('account_deletion_subject', id)
 *      - 1 人に 1 行: 済んでいない記録は使い直し、済んだ記録はそのまま返す。complete は何度呼んでも同じ
 *      - 実行者と運営者の組み合わせの検査 (self に運営者を付けない・operator には運営者が要る)。理由はコードだけ (自由な文は CHECK で断る)
 *      - 旧設計の行 (user_id が本人) は、本人との紐づけを外す (外部キーを外したので、SET NULL の代わり)
 *   E. 権限: ハッシュの関数・記録の関数は service_role だけが実行できる (anon / authenticated は 42501)
 *
 * 退会の流れ (deleteAccount) を通した記録は tests/integration/security/account-deletion.test.ts の G、
 * 上限の判定 (同じ宛先へ 3) がハッシュ同士で変わらず効くことは membership-daily-cap.test.ts が確かめる。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/deletion-record-and-invite-email-hash.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

const srAdmin = client(serviceKey);
const anon = () => client(anonKey);

/** ローカルスタックの postgres-meta で SQL を実行する (確認と後片付けにだけ使う) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

/** SQL の文字列リテラル (テストが作る値だけを渡す) */
const q = (value: string) => `'${value.replace(/'/g, "''")}'`;

const RUN = randomBytes(4).toString('hex');
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const HEX64 = /^[0-9a-f]{64}$/;
/** 権限が無いときの SQLSTATE */
const INSUFFICIENT_PRIVILEGE = '42501';
/** 引数の誤りの SQLSTATE */
const INVALID_PARAMETER = '22023';
/** CHECK 制約違反の SQLSTATE */
const CHECK_VIOLATION = '23514';
/** 記録が見つからないときの SQLSTATE (complete_account_deletion_record) */
const NO_DATA_FOUND = 'P0002';

const createdUserIds: string[] = [];
const auditScopeId = randomUUID();
const legacyRowIds: string[] = [];
/** テストで記録を作った利用者の id (後片付けで subject_hash から消す) */
const subjects: string[] = [];

interface TestUser {
  id: string;
  email: string;
  jwt: string;
}

async function createUser(label: string): Promise<TestUser> {
  const email = `t1562-${label}-${RUN}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const signedIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signedIn.error || !signedIn.data.session) throw new Error(`signIn ${label}: ${signedIn.error?.message}`);
  return { id: data.user.id, email, jwt: signedIn.data.session.access_token };
}

async function hmac(domain: string, value: string): Promise<string> {
  const { data, error } = await srAdmin.rpc('pii_hmac_hex', { p_domain: domain, p_value: value });
  if (error || typeof data !== 'string') throw new Error(`pii_hmac_hex: ${error?.message ?? 'no value'}`);
  return data;
}

async function inviteEmailHash(email: string | null): Promise<string | null> {
  const { data, error } = await srAdmin.rpc('membership_invite_email_hash', { p_email: email });
  if (error) throw new Error(`membership_invite_email_hash: ${error.message}`);
  return data as string | null;
}

async function begin(args: {
  userId: string;
  executorType: string;
  reason?: string;
  requestId?: string;
  operatorId?: string | null;
}) {
  return srAdmin.rpc('begin_account_deletion_record', {
    p_user_id: args.userId,
    p_executor_type: args.executorType,
    p_reason: args.reason ?? 'user_request',
    p_request_id: args.requestId ?? `req_t1562_${RUN}`,
    p_operator_id: args.operatorId ?? null,
  });
}

async function recordById(recordId: string): Promise<Record<string, unknown> | undefined> {
  return (await pgQuery(`select * from public.gdpr_deletion_requests where id = ${q(recordId)}`))[0];
}

let member: TestUser;
let operator: TestUser;

beforeAll(async () => {
  member = await createUser('member');
  operator = await createUser('operator');
}, 60_000);

afterAll(async () => {
  await pgQuery(`delete from public.membership_audit where scope_id = ${q(auditScopeId)}`).catch(() => undefined);
  for (const rowId of legacyRowIds) {
    await pgQuery(`delete from public.gdpr_deletion_requests where id = ${q(rowId)}`).catch(() => undefined);
  }
  for (const subject of subjects) {
    await pgQuery(
      `delete from public.gdpr_deletion_requests where subject_hash = public.pii_hmac_hex('account_deletion_subject', ${q(subject)})`,
    ).catch(() => undefined);
  }
  for (const userId of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(userId).catch(() => undefined);
  }
}, 60_000);

describe('#1562 A. ハッシュの関数', () => {
  it('Vault に鍵 pii_hmac_key がある (値はここでは読まない)', async () => {
    const rows = await pgQuery<{ n: number }>(`select count(*)::int as n from vault.secrets where name = 'pii_hmac_key'`);
    expect(rows[0].n).toBe(1);
  });

  it('pii_hmac_hex: 16 進 64 文字。同じ入力は同じ値・用途が違えば別の値・入力が違えば別の値。NULL は NULL', async () => {
    const a1 = await hmac('account_deletion_subject', 'value-1');
    const a2 = await hmac('account_deletion_subject', 'value-1');
    const otherDomain = await hmac('membership_invite_email', 'value-1');
    const otherValue = await hmac('account_deletion_subject', 'value-2');
    expect(a1).toMatch(HEX64);
    expect(a2).toBe(a1);
    expect(otherDomain).not.toBe(a1);
    expect(otherValue).not.toBe(a1);

    const { data, error } = await srAdmin.rpc('pii_hmac_hex', { p_domain: 'account_deletion_subject', p_value: null });
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it('pii_hmac_hex: 鍵の無いただの SHA-256 ではない (鍵を知らないと同じ値を作れない)', async () => {
    const value = `value-${RUN}`;
    const rows = await pgQuery<{ plain: string }>(
      `select pg_catalog.encode(pg_catalog.sha256(convert_to(${q(`account_deletion_subject:${value}`)}, 'UTF8')), 'hex') as plain`,
    );
    expect(await hmac('account_deletion_subject', value)).not.toBe(rows[0].plain);
  });

  it('pii_hmac_hex: 用途 (domain) が空なら 22023', async () => {
    const { error } = await srAdmin.rpc('pii_hmac_hex', { p_domain: '', p_value: 'x' });
    expect(error?.code).toBe(INVALID_PARAMETER);
  });

  it('membership_invite_email_hash: 大文字小文字と前後の空白を揃える。空・NULL は NULL', async () => {
    const base = await inviteEmailHash(`taro-${RUN}@example.com`);
    expect(base).toMatch(HEX64);
    expect(await inviteEmailHash(`  Taro-${RUN}@Example.COM `)).toBe(base);
    expect(await inviteEmailHash(`jiro-${RUN}@example.com`)).not.toBe(base);
    expect(base).toBe(await hmac('membership_invite_email', `taro-${RUN}@example.com`));
    expect(await inviteEmailHash('   ')).toBeNull();
    expect(await inviteEmailHash(null)).toBeNull();
  });
});

describe('#1562 B. membership_audit に生の招待先アドレスを残さない', () => {
  const insertAudit = async (metadata: Record<string, unknown>) => {
    const { data, error } = await srAdmin
      .from('membership_audit')
      .insert({ scope: 'family', scope_id: auditScopeId, action: 'invite_created', actor_id: null, metadata })
      .select('id, metadata')
      .single();
    if (error) throw new Error(`insert membership_audit: ${error.message}`);
    return data as { id: string; metadata: Record<string, unknown> };
  };

  it('INSERT: email は email_hash に置き換わり、ほかのキーは残る', async () => {
    const email = `Hanako-${RUN}@Example.com`;
    const row = await insertAudit({ invite_id: 'inv-1', email });
    expect(row.metadata).toEqual({ invite_id: 'inv-1', email_hash: await inviteEmailHash(email) });
    expect(JSON.stringify(row.metadata).toLowerCase()).not.toContain(email.toLowerCase());
  });

  it('UPDATE で email を書き戻しても、email_hash に置き換わる', async () => {
    const row = await insertAudit({ invite_id: 'inv-2' });
    const email = `update-${RUN}@example.com`;
    const { data, error } = await srAdmin
      .from('membership_audit')
      .update({ metadata: { invite_id: 'inv-2', email } })
      .eq('id', row.id)
      .select('metadata')
      .single();
    expect(error).toBeNull();
    expect((data as { metadata: Record<string, unknown> }).metadata).toEqual({
      invite_id: 'inv-2',
      email_hash: await inviteEmailHash(email),
    });
  });

  it('email の無い行はそのまま。文字列でない email・空の email は取り除くだけ (ハッシュを入れない)', async () => {
    expect((await insertAudit({ role: 'member' })).metadata).toEqual({ role: 'member' });
    expect((await insertAudit({ n: 1, email: 12345 })).metadata).toEqual({ n: 1 });
    expect((await insertAudit({ n: 2, email: '  ' })).metadata).toEqual({ n: 2 });
  });

  it('置き換えの関数 (既存の行の置き換えにも使う) は、トリガーと同じ結果を返す', async () => {
    const email = `fn-${RUN}@example.com`;
    const rows = await pgQuery<{ result: Record<string, unknown> }>(
      `select public.membership_audit_hash_email_in_metadata(jsonb_build_object('x', 1, 'email', ${q(` ${email.toUpperCase()} `)})) as result`,
    );
    expect(rows[0].result).toEqual({ x: 1, email_hash: await inviteEmailHash(email) });
  });

  it('表のどの行にも email のキーが残っていない (既存の行も置き換え済み)', async () => {
    const rows = await pgQuery<{ n: number }>(`select count(*)::int as n from public.membership_audit where metadata ? 'email'`);
    expect(rows[0].n).toBe(0);
  });
});

describe('#1562 C. gdpr_deletion_requests は service_role だけが読み書きする', () => {
  it('利用者向けのポリシーが無い。RLS は有効', async () => {
    const policies = await pgQuery<{ policyname: string }>(
      `select policyname from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'gdpr_deletion_requests'`,
    );
    expect(policies).toEqual([]);
    const rls = await pgQuery<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_catalog.pg_class where oid = 'public.gdpr_deletion_requests'::regclass`,
    );
    expect(rls[0].relrowsecurity).toBe(true);
  });

  it('anon / authenticated は表の権限が無い (読み・書きとも 42501)。service_role は読める', async () => {
    for (const c of [anon(), client(anonKey, member.jwt)]) {
      const read = await c.from('gdpr_deletion_requests').select('id').limit(1);
      expect(read.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
      const write = await c.from('gdpr_deletion_requests').insert({ user_id: member.id });
      expect(write.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    }
    const asService = await srAdmin.from('gdpr_deletion_requests').select('id').limit(1);
    expect(asService.error).toBeNull();
  });
});

describe('#1562 D. 削除の実行記録を書く関数', () => {
  it('本人の退会: user_id も executed_by も空で、subject_hash は利用者の id の HMAC。1 人に 1 行', async () => {
    const subject = randomUUID();
    subjects.push(subject);
    const first = await begin({ userId: subject, executorType: 'self', requestId: `req_a_${RUN}` });
    expect(first.error).toBeNull();
    const recordId = first.data as string;

    const record = await recordById(recordId);
    expect(record).toMatchObject({
      user_id: null,
      executed_by: null,
      executor_type: 'self',
      reason: 'user_request',
      request_id: `req_a_${RUN}`,
      executed_at: null,
      cancelled_at: null,
      subject_hash: await hmac('account_deletion_subject', subject),
    });
    expect(record?.cooling_until).toBe(record?.requested_at);
    expect(JSON.stringify(record)).not.toContain(subject);

    // 途中で止まったやり直し: 同じ行を使い直し、request_id を今回のものにする (始めた日時は前回のまま)
    const retry = await begin({ userId: subject, executorType: 'self', requestId: `req_b_${RUN}` });
    expect(retry.data).toBe(recordId);
    const afterRetry = await recordById(recordId);
    expect(afterRetry).toMatchObject({ request_id: `req_b_${RUN}`, requested_at: record?.requested_at, executed_at: null });

    // 済んだ印は 1 回目で入り、2 回目は何も変えない
    expect((await srAdmin.rpc('complete_account_deletion_record', { p_record_id: recordId })).error).toBeNull();
    const executed = await recordById(recordId);
    expect(executed?.executed_at).not.toBeNull();
    expect((await srAdmin.rpc('complete_account_deletion_record', { p_record_id: recordId })).error).toBeNull();
    expect((await recordById(recordId))?.executed_at).toBe(executed?.executed_at);

    // 済んだあとのやり直し: 同じ行をそのまま返し、書き換えない
    const afterDone = await begin({ userId: subject, executorType: 'self', requestId: `req_c_${RUN}` });
    expect(afterDone.data).toBe(recordId);
    expect((await recordById(recordId))?.request_id).toBe(`req_b_${RUN}`);

    const rows = await pgQuery<{ n: number }>(
      `select count(*)::int as n from public.gdpr_deletion_requests where subject_hash = public.pii_hmac_hex('account_deletion_subject', ${q(subject)})`,
    );
    expect(rows[0].n).toBe(1);
  });

  it('運営の削除: executor は operator、executed_by に運営者、理由は渡したコード', async () => {
    const subject = randomUUID();
    subjects.push(subject);
    const result = await begin({ userId: subject, executorType: 'operator', reason: 'operator_action', operatorId: operator.id });
    expect(result.error).toBeNull();
    expect(await recordById(result.data as string)).toMatchObject({
      user_id: null,
      executor_type: 'operator',
      executed_by: operator.id,
      reason: 'operator_action',
    });
  });

  it('引数の検査: 実行者の種類・運営者の有無・利用者の id (22023)。理由は自由な文を断る (23514)', async () => {
    const subject = randomUUID();
    subjects.push(subject);
    expect((await begin({ userId: subject, executorType: 'admin' })).error?.code).toBe(INVALID_PARAMETER);
    expect((await begin({ userId: subject, executorType: 'operator' })).error?.code).toBe(INVALID_PARAMETER);
    expect((await begin({ userId: subject, executorType: 'self', operatorId: operator.id })).error?.code).toBe(INVALID_PARAMETER);
    const noUser = await srAdmin.rpc('begin_account_deletion_record', {
      p_user_id: null,
      p_executor_type: 'self',
      p_reason: 'user_request',
      p_request_id: 'x',
    });
    expect(noUser.error?.code).toBe(INVALID_PARAMETER);
    expect((await begin({ userId: subject, executorType: 'self', reason: '本人が メールで依頼 (taro@example.com)' })).error?.code).toBe(
      CHECK_VIOLATION,
    );
    // 断った呼び出しは行を残さない
    const rows = await pgQuery<{ n: number }>(
      `select count(*)::int as n from public.gdpr_deletion_requests where subject_hash = public.pii_hmac_hex('account_deletion_subject', ${q(subject)})`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('complete: 無い記録の id は P0002', async () => {
    const { error } = await srAdmin.rpc('complete_account_deletion_record', { p_record_id: randomUUID() });
    expect(error?.code).toBe(NO_DATA_FOUND);
  });

  it('旧設計の行 (user_id が本人) は、本人との紐づけを外す。他人の行は変わらない', async () => {
    const subject = randomUUID();
    const other = randomUUID();
    subjects.push(subject);
    const ownRow = randomUUID();
    const otherRow = randomUUID();
    legacyRowIds.push(ownRow, otherRow);
    // user_id の外部キーは外してあるので、auth.users に無い id でも入る
    await pgQuery(`
      insert into public.gdpr_deletion_requests (id, user_id) values (${q(ownRow)}, ${q(subject)}), (${q(otherRow)}, ${q(other)});
    `);
    expect((await begin({ userId: subject, executorType: 'self' })).error).toBeNull();
    expect((await recordById(ownRow))?.user_id).toBeNull();
    expect((await recordById(otherRow))?.user_id).toBe(other);
  });
});

describe('#1562 E. 権限', () => {
  const FUNCTIONS = [
    'public.pii_hmac_hex(text, text)',
    'public.membership_invite_email_hash(text)',
    'public.begin_account_deletion_record(uuid, text, text, text, uuid)',
    'public.complete_account_deletion_record(uuid)',
  ];

  for (const signature of FUNCTIONS) {
    it(`${signature}: service_role だけが実行できる。SECURITY DEFINER で search_path は空`, async () => {
      const rows = await pgQuery<{ anon: boolean; authenticated: boolean; service_role: boolean; public: boolean; definer: boolean; config: string[] | null }>(`
        select has_function_privilege('anon', ${q(signature)}, 'EXECUTE') as anon,
               has_function_privilege('authenticated', ${q(signature)}, 'EXECUTE') as authenticated,
               has_function_privilege('service_role', ${q(signature)}, 'EXECUTE') as service_role,
               exists (select 1 from pg_catalog.pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                        where p.oid = ${q(signature)}::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') as public,
               (select prosecdef from pg_catalog.pg_proc where oid = ${q(signature)}::regprocedure) as definer,
               (select proconfig from pg_catalog.pg_proc where oid = ${q(signature)}::regprocedure) as config
      `);
      expect(rows[0]).toMatchObject({ anon: false, authenticated: false, service_role: true, public: false, definer: true });
      expect(rows[0].config).toContain('search_path=""');
    });
  }

  it('置き換えの関数とトリガー関数は、誰にも EXECUTE を付けない', async () => {
    for (const signature of ['public.membership_audit_hash_email_in_metadata(jsonb)', 'public.membership_audit_hash_invite_email()']) {
      const rows = await pgQuery<{ anon: boolean; authenticated: boolean; service_role: boolean }>(`
        select has_function_privilege('anon', ${q(signature)}, 'EXECUTE') as anon,
               has_function_privilege('authenticated', ${q(signature)}, 'EXECUTE') as authenticated,
               has_function_privilege('service_role', ${q(signature)}, 'EXECUTE') as service_role
      `);
      expect(rows[0], signature).toEqual({ anon: false, authenticated: false, service_role: false });
    }
  });

  it('ログインユーザーは、ハッシュの関数も記録の関数も PostgREST から呼べない (42501)', async () => {
    const asMember = client(anonKey, member.jwt);
    expect((await asMember.rpc('pii_hmac_hex', { p_domain: 'membership_invite_email', p_value: 'x' })).error?.code).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect((await asMember.rpc('membership_invite_email_hash', { p_email: member.email })).error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    const beginAsMember = await asMember.rpc('begin_account_deletion_record', {
      p_user_id: member.id,
      p_executor_type: 'self',
      p_reason: 'user_request',
      p_request_id: 'x',
    });
    expect(beginAsMember.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});
