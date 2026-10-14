/**
 * #1174 利用規約・プライバシーポリシーへの明示同意と、同意した版の記録 (accept_legal_documents) の回帰テスト
 *
 * 背景:
 *   サインアップ画面は「続行することで同意したものとみなされます」というみなし同意で、同意した事実も版も残っていなかった。
 *   terms_acceptances (UPDATE / DELETE 禁止の証跡の表) は本番にあるが、誰も書いていなかった。
 *
 * 修正 (20261008200700_legal_documents_acceptance.sql):
 *   - user_profiles に同意済みの版 (terms_version_accepted / privacy_version_accepted) と同意日時 (legal_accepted_at) を足す
 *   - その 3 列は、特権列ガード (guard_user_profiles_privileged と _on_insert) で本人の直接 UPDATE / INSERT を拒否する
 *   - SECURITY DEFINER の accept_legal_documents(p_terms_version, p_privacy_version, p_ip, p_user_agent) だけが書く。
 *     書く行は auth.uid() 本人だけ。プロフィール行が無ければ既定値で作る。terms_acceptances に証跡を 1 文書ずつ足す
 *
 * 確認すること:
 *   1. 新規登録しただけの人 (プロフィール行なし) が呼ぶと、既定値の行ができ、初期設定の導線 (onboarding_*_at) は変わらない
 *   2. 既存のプロフィールは、同意の 3 列以外が変わらない
 *   3. 同じ版を送り直しても証跡は増えず、同意日時も動かない。版が上がったら新しい版の証跡だけ増え、古い証跡は残る
 *   4. ★他人の行は書けない (関数に他人を指す引数が無い。他人の証跡を直接 INSERT するのも RLS が拒否する)
 *   5. ★terms_acceptances は UPDATE / DELETE できない (本人の行も、他人の行も)。他人の行は SELECT でも見えない
 *   6. ★本人が user_profiles の同意の 3 列を直接 UPDATE / INSERT すると 42501 (NULL に戻すのも拒否)。
 *      初期設定の保存 (その 3 列を送らない upsert) は、同意済みの人でも通る。service_role は書ける
 *   7. 不正な版・未ログインは拒否され、何も作られない。権限は authenticated のみ (anon・service_role は呼べない)
 *   8. 端末情報 (IP・user_agent) が証跡に残る。user_agent は 512 文字で切る
 *   9. 同じ人が同時に何回呼んでも、証跡は 2 行のまま
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/legal-documents-acceptance.test.ts
 *
 * 関数定義・権限の確認 (has_function_privilege など) は、ローカルスタックの postgres-meta (/pg/query、
 * service_role キーが必要) で読み取りだけ行う。本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, afterAll } from 'vitest';
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
const asUser = (jwt: string) => client(anonKey, jwt);

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

interface TestUser {
  id: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
let userSeq = 0;

/** 実際の LEGAL_DOCUMENTS とは無関係な、テスト用の版 (DB は版の中身を知らない) */
const V1 = 'test-v1';
const V2 = 'test-v2';
const V3 = 'test-v3';

/** withProfile: false は「新規登録しただけで初期設定 (オンボーディング) 前」の人 (プロフィール行が無い) */
async function createUser(label: string, options: { withProfile?: boolean } = {}): Promise<TestUser> {
  userSeq += 1;
  const email = `sec-legal-${label}-${userSeq}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  if (options.withProfile) {
    const { error: profileError } = await srAdmin
      .from('user_profiles')
      .insert({ id: data.user.id, nickname: `legal-${label}`, age_group: '30s', gender: 'other' });
    if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  }
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

const LEGAL_COLS = 'terms_version_accepted, privacy_version_accepted, legal_accepted_at';

interface LegalColumns {
  terms_version_accepted: string | null;
  privacy_version_accepted: string | null;
  legal_accepted_at: string | null;
}

/** service_role でプロフィール行を読む (行が無ければ null) */
async function profileOf(id: string): Promise<(Record<string, unknown> & LegalColumns) | null> {
  const { data, error } = await srAdmin
    .from('user_profiles')
    .select(
      `nickname, age_group, gender, roles, onboarding_started_at, onboarding_completed_at, is_active_in_org, ${LEGAL_COLS}`,
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`profileOf: ${error.message}`);
  return data as (Record<string, unknown> & LegalColumns) | null;
}

interface AcceptanceRow {
  id: string;
  user_id: string;
  document_type: string;
  document_version: string;
  accepted_at: string;
  ip_address: string | null;
  user_agent: string | null;
}

/** service_role で本人の証跡を読む */
async function acceptancesOf(userId: string): Promise<AcceptanceRow[]> {
  const { data, error } = await srAdmin
    .from('terms_acceptances')
    .select('id, user_id, document_type, document_version, accepted_at, ip_address, user_agent')
    .eq('user_id', userId)
    .order('accepted_at', { ascending: true })
    .order('document_type', { ascending: true });
  if (error) throw new Error(`acceptancesOf: ${error.message}`);
  return data as AcceptanceRow[];
}

function pairs(rows: AcceptanceRow[]): string[] {
  return rows.map((r) => `${r.document_type}:${r.document_version}`).sort();
}

function accept(user: TestUser, terms: string, privacy: string, extra: { ip?: string | null; ua?: string | null } = {}) {
  return asUser(user.jwt).rpc('accept_legal_documents', {
    p_terms_version: terms,
    p_privacy_version: privacy,
    p_ip: extra.ip === undefined ? null : extra.ip,
    p_user_agent: extra.ua === undefined ? null : extra.ua,
  });
}

afterAll(async () => {
  // terms_acceptances・user_profiles は auth.users の削除に連動して消える (ON DELETE CASCADE)
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 60_000);

describe('accept_legal_documents: 同意の記録', () => {
  it('★プロフィール行が無い新規登録者が呼ぶと、既定値の行が作られ、同意の 3 列が入る。初期設定の導線は変わらない', async () => {
    const user = await createUser('no-profile');
    expect(await profileOf(user.id)).toBeNull();

    const { data, error } = await accept(user, V1, V1, { ip: '203.0.113.5', ua: 'vitest-agent/1.0' });
    expect(error).toBeNull();
    expect(data).toMatchObject({ terms_version_accepted: V1, privacy_version_accepted: V1 });
    expect(typeof (data as LegalColumns).legal_accepted_at).toBe('string');

    const profile = await profileOf(user.id);
    expect(profile).toMatchObject({
      nickname: 'Guest',
      age_group: 'unspecified',
      gender: 'unspecified',
      roles: ['user'],
      is_active_in_org: false,
      // 初期設定の日時は入れない = 初期設定の導線 (/onboarding/welcome) は変わらない
      onboarding_started_at: null,
      onboarding_completed_at: null,
      terms_version_accepted: V1,
      privacy_version_accepted: V1,
    });
    expect(profile!.legal_accepted_at).toBe((data as LegalColumns).legal_accepted_at);
  });

  it('同意の証跡が、文書ごとに 1 行ずつ、版・時刻・IP・端末つきで残る', async () => {
    const user = await createUser('evidence');
    const { error } = await accept(user, V1, V2, { ip: '203.0.113.9', ua: 'vitest-agent/2.0' });
    expect(error).toBeNull();

    const rows = await acceptancesOf(user.id);
    expect(pairs(rows)).toEqual([`privacy_policy:${V2}`, `terms_of_service:${V1}`]);
    for (const row of rows) {
      expect(row.user_id).toBe(user.id);
      expect(row.ip_address).toBe('203.0.113.9');
      expect(row.user_agent).toBe('vitest-agent/2.0');
      expect(Number.isNaN(Date.parse(row.accepted_at))).toBe(false);
    }
    // 2 行は同じ時刻 (1 回の同意)。プロフィールの同意日時とも同じ
    expect(rows[0].accepted_at).toBe(rows[1].accepted_at);
    expect((await profileOf(user.id))!.legal_accepted_at).toBe(rows[0].accepted_at);
  });

  it('IP と端末を省略しても記録できる (NULL)。user_agent は 512 文字で切る', async () => {
    const user = await createUser('device');
    const bare = await accept(user, V1, V1);
    expect(bare.error).toBeNull();
    for (const row of await acceptancesOf(user.id)) {
      expect(row.ip_address).toBeNull();
      expect(row.user_agent).toBeNull();
    }

    const user2 = await createUser('device-long');
    const long = await accept(user2, V1, V1, { ip: '2001:db8::1', ua: 'u'.repeat(600) });
    expect(long.error).toBeNull();
    for (const row of await acceptancesOf(user2.id)) {
      expect(row.ip_address).toBe('2001:db8::1');
      expect(row.user_agent).toBe('u'.repeat(512));
    }
  });

  it('既存のプロフィールは、同意の 3 列以外が変わらない', async () => {
    const user = await createUser('existing', { withProfile: true });
    const before = await profileOf(user.id);
    expect(before).toMatchObject({ terms_version_accepted: null, privacy_version_accepted: null, legal_accepted_at: null });

    const { error } = await accept(user, V1, V1);
    expect(error).toBeNull();

    const after = await profileOf(user.id);
    expect(after).toMatchObject({
      nickname: 'legal-existing',
      age_group: '30s',
      gender: 'other',
      roles: before!.roles,
      onboarding_started_at: before!.onboarding_started_at,
      onboarding_completed_at: before!.onboarding_completed_at,
      terms_version_accepted: V1,
      privacy_version_accepted: V1,
    });
    expect(after!.legal_accepted_at).not.toBeNull();
  });

  it('★同じ版を送り直しても、証跡は増えず、同意日時も動かない (冪等)', async () => {
    const user = await createUser('idempotent');
    expect((await accept(user, V1, V1)).error).toBeNull();
    const first = await profileOf(user.id);
    const firstRows = await acceptancesOf(user.id);

    expect((await accept(user, V1, V1, { ip: '203.0.113.77', ua: 'later' })).error).toBeNull();
    const second = await profileOf(user.id);
    const secondRows = await acceptancesOf(user.id);

    expect(second!.legal_accepted_at).toBe(first!.legal_accepted_at);
    expect(secondRows).toHaveLength(2);
    // 最初の証跡がそのまま残る (後からの呼び出しで IP・端末が上書きされない)
    expect(secondRows.map((r) => r.id).sort()).toEqual(firstRows.map((r) => r.id).sort());
    expect(secondRows.every((r) => r.ip_address === null && r.user_agent === null)).toBe(true);
  });

  it('★版が上がったら、新しい版の証跡が増え、古い証跡は残る。プロフィールは新しい版と新しい日時になる', async () => {
    const user = await createUser('reconsent', { withProfile: true });
    expect((await accept(user, V1, V1)).error).toBeNull();
    const first = await profileOf(user.id);

    // 時刻が必ず進むように、少し待つ
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await accept(user, V2, V2)).error).toBeNull();
    const second = await profileOf(user.id);

    expect(second).toMatchObject({ terms_version_accepted: V2, privacy_version_accepted: V2 });
    expect(Date.parse(second!.legal_accepted_at!)).toBeGreaterThan(Date.parse(first!.legal_accepted_at!));
    expect(pairs(await acceptancesOf(user.id))).toEqual(
      [`privacy_policy:${V1}`, `privacy_policy:${V2}`, `terms_of_service:${V1}`, `terms_of_service:${V2}`].sort(),
    );
  });

  it('片方の文書だけ版が上がったときは、その文書の証跡だけが増える', async () => {
    const user = await createUser('one-doc');
    expect((await accept(user, V1, V1)).error).toBeNull();
    expect((await accept(user, V1, V3)).error).toBeNull();

    expect(pairs(await acceptancesOf(user.id))).toEqual(
      [`privacy_policy:${V1}`, `privacy_policy:${V3}`, `terms_of_service:${V1}`].sort(),
    );
    expect(await profileOf(user.id)).toMatchObject({ terms_version_accepted: V1, privacy_version_accepted: V3 });
  });

  it('同じ人が同時に何回呼んでも、証跡は 2 行のまま (競合しない)', async () => {
    const user = await createUser('race');
    const results = await Promise.all(Array.from({ length: 6 }, () => accept(user, V1, V1)));
    for (const result of results) expect(result.error).toBeNull();

    expect(await acceptancesOf(user.id)).toHaveLength(2);
    expect(await profileOf(user.id)).toMatchObject({ terms_version_accepted: V1, privacy_version_accepted: V1 });
  });

  it('本人は、自分の同意済みの版を user_profiles から読める (middleware の同意ゲートが読む列)', async () => {
    const user = await createUser('self-read');
    expect((await accept(user, V1, V2)).error).toBeNull();

    const { data, error } = await asUser(user.jwt)
      .from('user_profiles')
      .select('terms_version_accepted, privacy_version_accepted')
      .eq('id', user.id)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).toEqual({ terms_version_accepted: V1, privacy_version_accepted: V2 });
  });

  it('他人の同意済みの版は、user_profiles からも読めない', async () => {
    const owner = await createUser('profile-owner');
    const other = await createUser('profile-other');
    expect((await accept(owner, V1, V1)).error).toBeNull();

    const { data, error } = await asUser(other.jwt)
      .from('user_profiles')
      .select('terms_version_accepted, privacy_version_accepted')
      .eq('id', owner.id)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).toBeNull();
  });
});

describe('★他人の行は書けない', () => {
  it('関数に他人を指す引数は無い (引数は版・IP・端末だけ)', async () => {
    const rows = await pgQuery<{ args: string }>(`
      select pg_get_function_identity_arguments(p.oid) as args
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'accept_legal_documents'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].args).toBe('p_terms_version text, p_privacy_version text, p_ip inet, p_user_agent text');
  });

  it('A が呼んでも、B のプロフィールと証跡は変わらない', async () => {
    const a = await createUser('a-writer', { withProfile: true });
    const b = await createUser('b-bystander', { withProfile: true });
    const bBefore = await profileOf(b.id);

    expect((await accept(a, V1, V1)).error).toBeNull();

    expect(await profileOf(b.id)).toEqual(bBefore);
    expect(await acceptancesOf(b.id)).toEqual([]);
    expect(await acceptancesOf(a.id)).toHaveLength(2);
  });

  it('A が、B の user_id で証跡を直接 INSERT することはできない (RLS)', async () => {
    const a = await createUser('a-forger');
    const b = await createUser('b-victim');
    const { error } = await asUser(a.jwt).from('terms_acceptances').insert({
      user_id: b.id,
      document_type: 'terms_of_service',
      document_version: V1,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
    expect(await acceptancesOf(b.id)).toEqual([]);
  });
});

describe('★terms_acceptances は UPDATE / DELETE できない (不可逆な証跡)', () => {
  it('本人が自分の証跡を UPDATE / DELETE しようとしても、行は 1 件も変わらない', async () => {
    const user = await createUser('immutable');
    expect((await accept(user, V1, V1, { ip: '203.0.113.20', ua: 'orig' })).error).toBeNull();
    const before = await acceptancesOf(user.id);
    expect(before).toHaveLength(2);

    const update = await asUser(user.jwt)
      .from('terms_acceptances')
      .update({ document_version: 'tampered', ip_address: '198.51.100.1' })
      .eq('user_id', user.id)
      .select('id');
    // RLS (USING false) は、エラーにせず「対象の行が 0 件」にする
    expect(update.error).toBeNull();
    expect(update.data).toEqual([]);

    const del = await asUser(user.jwt).from('terms_acceptances').delete().eq('user_id', user.id).select('id');
    expect(del.error).toBeNull();
    expect(del.data).toEqual([]);

    expect(await acceptancesOf(user.id)).toEqual(before);
  });

  it('他人の証跡は SELECT でも見えず、UPDATE / DELETE も効かない', async () => {
    const owner = await createUser('owner');
    const other = await createUser('other');
    expect((await accept(owner, V1, V1)).error).toBeNull();
    const before = await acceptancesOf(owner.id);

    const seen = await asUser(other.jwt).from('terms_acceptances').select('id').eq('user_id', owner.id);
    expect(seen.error).toBeNull();
    expect(seen.data).toEqual([]);

    const update = await asUser(other.jwt)
      .from('terms_acceptances')
      .update({ document_version: 'tampered' })
      .eq('user_id', owner.id)
      .select('id');
    expect(update.data ?? []).toEqual([]);
    const del = await asUser(other.jwt).from('terms_acceptances').delete().eq('user_id', owner.id).select('id');
    expect(del.data ?? []).toEqual([]);

    expect(await acceptancesOf(owner.id)).toEqual(before);
  });

  it('本人は自分の証跡を SELECT できる', async () => {
    const user = await createUser('reader');
    expect((await accept(user, V1, V1)).error).toBeNull();
    const { data, error } = await asUser(user.jwt).from('terms_acceptances').select('document_type, document_version');
    expect(error).toBeNull();
    expect((data ?? []).map((r) => `${r.document_type}:${r.document_version}`).sort()).toEqual([
      `privacy_policy:${V1}`,
      `terms_of_service:${V1}`,
    ]);
  });
});

describe('★同意の 3 列は、本人が直接書き換えられない (特権列ガード)', () => {
  const direct: Array<{ name: string; values: () => Record<string, unknown> }> = [
    { name: 'terms_version_accepted', values: () => ({ terms_version_accepted: V2 }) },
    { name: 'privacy_version_accepted', values: () => ({ privacy_version_accepted: V2 }) },
    { name: 'legal_accepted_at', values: () => ({ legal_accepted_at: new Date().toISOString() }) },
  ];

  for (const c of direct) {
    it(`未同意の本人が ${c.name} を UPDATE で入れようとすると 42501 で拒否される`, async () => {
      const user = await createUser(`upd-${c.name}`, { withProfile: true });
      const { error } = await asUser(user.jwt).from('user_profiles').update(c.values()).eq('id', user.id);
      expect(error).not.toBeNull();
      expect(error!.code).toBe('42501');
      expect(error!.message).toContain('CANNOT_MODIFY_PRIVILEGED_COLUMN');
      expect(await profileOf(user.id)).toMatchObject({
        terms_version_accepted: null,
        privacy_version_accepted: null,
        legal_accepted_at: null,
      });
    });

    it(`同意済みの本人が ${c.name} を NULL に戻そうとしても 42501 で拒否される`, async () => {
      const user = await createUser(`clear-${c.name}`, { withProfile: true });
      expect((await accept(user, V1, V1)).error).toBeNull();
      const before = await profileOf(user.id);

      const { error } = await asUser(user.jwt)
        .from('user_profiles')
        .update({ [c.name]: null })
        .eq('id', user.id);
      expect(error).not.toBeNull();
      expect(error!.code).toBe('42501');
      expect(await profileOf(user.id)).toMatchObject({
        terms_version_accepted: before!.terms_version_accepted,
        privacy_version_accepted: before!.privacy_version_accepted,
        legal_accepted_at: before!.legal_accepted_at,
      });
    });
  }

  it('プロフィール行をまだ持たない本人が、同意の列つきで自分の行を作ろうとすると 42501 で拒否され、行は作られない', async () => {
    const user = await createUser('ins-attacker');
    const { error } = await asUser(user.jwt)
      .from('user_profiles')
      .insert({
        id: user.id,
        nickname: 'x',
        age_group: 'unspecified',
        gender: 'unspecified',
        terms_version_accepted: V1,
        privacy_version_accepted: V1,
        legal_accepted_at: new Date().toISOString(),
      });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
    expect(await profileOf(user.id)).toBeNull();
  });

  it('upsert (INSERT ... ON CONFLICT DO UPDATE) で同意の列を入れようとしても拒否される', async () => {
    const user = await createUser('upsert-attacker');
    const { error } = await asUser(user.jwt)
      .from('user_profiles')
      .upsert({ id: user.id, nickname: 'x', age_group: 'unspecified', gender: 'unspecified', terms_version_accepted: V1 });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
    expect(await profileOf(user.id)).toBeNull();
  });

  it('初期設定の保存 (同意の列を送らない upsert) は、同意済みの人でも通り、同意の 3 列は変わらない', async () => {
    const user = await createUser('onboarding-after-consent');
    // 初期設定より前に同意 -> 行が既定値で作られる
    expect((await accept(user, V1, V1)).error).toBeNull();
    const consented = await profileOf(user.id);

    // /api/onboarding/progress と同じ形の upsert
    const { error } = await asUser(user.jwt)
      .from('user_profiles')
      .upsert({
        id: user.id,
        nickname: 'さくら',
        age_group: '30s',
        gender: 'female',
        onboarding_started_at: new Date().toISOString(),
      });
    expect(error).toBeNull();
    expect(await profileOf(user.id)).toMatchObject({
      nickname: 'さくら',
      age_group: '30s',
      terms_version_accepted: V1,
      privacy_version_accepted: V1,
      legal_accepted_at: consented!.legal_accepted_at,
    });
  });

  it('同意前に初期設定を保存した人 (行はあるが未同意) も、そのまま同意できる', async () => {
    const user = await createUser('onboarding-before-consent');
    const { error: upsertError } = await asUser(user.jwt)
      .from('user_profiles')
      .upsert({ id: user.id, nickname: 'はなこ', age_group: '20s', gender: 'female' });
    expect(upsertError).toBeNull();

    expect((await accept(user, V1, V1)).error).toBeNull();
    expect(await profileOf(user.id)).toMatchObject({
      nickname: 'はなこ',
      terms_version_accepted: V1,
      privacy_version_accepted: V1,
    });
  });

  it('service_role (管理 API) は同意の 3 列を書ける (ガードの対象外)', async () => {
    const user = await createUser('by-admin', { withProfile: true });
    const stamp = new Date().toISOString();
    const { error } = await srAdmin
      .from('user_profiles')
      .update({ terms_version_accepted: V3, privacy_version_accepted: V3, legal_accepted_at: stamp })
      .eq('id', user.id);
    expect(error).toBeNull();
    expect(await profileOf(user.id)).toMatchObject({ terms_version_accepted: V3, privacy_version_accepted: V3 });
  });

  it('ガード関数 2 本に、既存の保護列 (roles など) と同意の 3 列が全部入っている', async () => {
    const rows = await pgQuery<{ def: string }>(`
      select pg_get_functiondef(p.oid) as def
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('guard_user_profiles_privileged', 'guard_user_profiles_privileged_on_insert')
    `);
    expect(rows).toHaveLength(2);
    for (const { def } of rows) {
      for (const column of [
        'roles',
        'org_role',
        'organization_id',
        'family_id',
        'is_active_in_org',
        'joined_org_at',
        'frozen_at',
        'frozen_by',
        'frozen_reason',
        'unban_at',
        'department_id',
        'terms_version_accepted',
        'privacy_version_accepted',
        'legal_accepted_at',
      ]) {
        expect(def, `${column} が守られていること`).toContain(`NEW.${column}`);
      }
    }
  });
});

describe('入力の検証と権限', () => {
  const bad: Array<{ name: string; terms: string | null; privacy: string | null }> = [
    { name: '空の版', terms: '', privacy: V1 },
    { name: '21 文字の版', terms: V1, privacy: 'x'.repeat(21) },
    { name: '空白を含む版', terms: 'v 1', privacy: V1 },
    { name: '改行で終わる版', terms: `${V1}\n`, privacy: V1 },
    { name: 'スラッシュを含む版', terms: V1, privacy: 'a/b' },
    { name: '日本語の版', terms: '第一版', privacy: V1 },
    { name: 'NULL の版 (利用規約)', terms: null, privacy: V1 },
    { name: 'NULL の版 (プライバシーポリシー)', terms: V1, privacy: null },
  ];

  for (const c of bad) {
    it(`★${c.name}は 22023 で拒否され、プロフィールも証跡も作られない`, async () => {
      const user = await createUser('bad-version');
      const { error } = await asUser(user.jwt).rpc('accept_legal_documents', {
        p_terms_version: c.terms,
        p_privacy_version: c.privacy,
      });
      expect(error).not.toBeNull();
      expect(error!.code).toBe('22023');
      expect(error!.message).toContain('INVALID_LEGAL_VERSION');
      expect(await profileOf(user.id)).toBeNull();
      expect(await acceptancesOf(user.id)).toEqual([]);
    });
  }

  it('20 文字ちょうどの版は受け付ける', async () => {
    const user = await createUser('max-length');
    const version = 'v'.repeat(20);
    const { error } = await accept(user, version, version);
    expect(error).toBeNull();
    expect(await profileOf(user.id)).toMatchObject({ terms_version_accepted: version, privacy_version_accepted: version });
  });

  it('★未ログイン (anon) は呼べない。何も作られない', async () => {
    const { error } = await anon().rpc('accept_legal_documents', { p_terms_version: V1, p_privacy_version: V1 });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('★service_role も呼べない (EXECUTE は authenticated だけ)', async () => {
    const { error } = await srAdmin.rpc('accept_legal_documents', { p_terms_version: V1, p_privacy_version: V1 });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('権限は authenticated のみ。SECURITY DEFINER で search_path が空', async () => {
    const rows = await pgQuery<{
      anon: boolean;
      authenticated: boolean;
      service_role: boolean;
      public_exec: boolean;
      secdef: boolean;
      config: string[] | null;
    }>(`
      select
        has_function_privilege('anon', f.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', f.oid, 'EXECUTE') as authenticated,
        has_function_privilege('service_role', f.oid, 'EXECUTE') as service_role,
        -- proacl が NULL (REVOKE していない) のときは PUBLIC に EXECUTE が付いた状態
        (
          f.proacl is null
          or exists (
            select 1 from pg_catalog.pg_proc p2, lateral aclexplode(p2.proacl) a
            where p2.oid = f.oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'
          )
        ) as public_exec,
        f.prosecdef as secdef,
        f.proconfig as config
      from pg_catalog.pg_proc f
      join pg_catalog.pg_namespace n on n.oid = f.pronamespace
      where n.nspname = 'public' and f.proname = 'accept_legal_documents'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      anon: false,
      authenticated: true,
      service_role: false,
      public_exec: false,
      secdef: true,
    });
    expect(rows[0].config).toEqual(['search_path=""']);
  });
});
