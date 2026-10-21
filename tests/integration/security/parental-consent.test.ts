/**
 * #1173 未成年の年齢確認と保護者の同意 (DB) の結合テスト
 * 設計書 docs/design/cross/14-parental-consent.md §6.13 の B (T-DB7〜T-DB32・T-DB34〜T-DB38。T-DB1〜T-DB6・T-DB33 は
 * legal-documents-acceptance.test.ts)。migration: 20261017030000_parental_consent_and_birth_date.sql
 *
 * 確かめること:
 *   - add_family_child: 生年月日は必須 (列に入れる)。18 歳未満は保護者の電子署名 (版・氏名・親権者の確認) を同じトランザクションで記録する。
 *     署名できるのは、自分の生年月日で 18 歳以上と確かめられる家族の大人だけ
 *   - parental_consents の RLS (家族の大人・署名した本人・運営が読める。クライアントは書けない) と保持 (取り消し・削除のあとも残す)
 *   - 取り消しのトリガー 2 本 (外す・抜ける・解散・行の削除)
 *   - 昇格 2 本の年齢と同意の検査、legal_minor_has_guardian_path()、18 歳未満の本人の家族・組織の役割 (MINOR_ACCOUNT_NOT_ALLOWED)
 *
 * この結合テストのファイルで add_family_child を呼ぶ大人は、作る helper で全員 user_profiles.birth_date を service_role で
 * 1990-01-01 にしておく (T-DB32 だけが NULL / 16 歳に変える)。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/parental-consent.test.ts
 *
 * 関数定義・権限・トリガーの確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で読み取りだけ行う。本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, afterAll } from 'vitest';
import ws from 'ws';
import { PARENTAL_CONSENT_DOCUMENT, addDaysToDate, todayLocal } from '@homegohan/shared';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';
import { grantFamilyPlan } from '../helpers/family-plan';

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
  email: string;
  jwt: string;
}

interface TestFamily {
  rep: TestUser;
  familyId: string;
}

interface ConsentRow {
  id: string;
  family_member_id: string | null;
  family_id: string;
  parent_user_id: string | null;
  signed_name: string;
  guardian_attested: boolean;
  consent_version: string;
  child_birth_date: string;
  child_age_at_signing: number;
  signed_at: string;
  ip_address: string | null;
  user_agent: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

interface AuditRow {
  action: string;
  actor_id: string | null;
  target_user_id: string | null;
  metadata: Record<string, unknown>;
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdFamilyIds: string[] = [];
const createdOrgIds: string[] = [];
let userSeq = 0;

/** 成人の生年月日 (この結合テストの家族の大人・署名者) */
const ADULT_BIRTH_DATE = '1990-01-01';
const SIGNED_NAME = 'テスト 保護者';
/** 署名の長さの上限 (SIGNED_NAME_MAX_LENGTH)。T-DB12 は 1 文字超えた値を送る */
const SIGNED_NAME_LIMIT = 100;
/** user_agent の切り詰め (accept_legal_documents と同じ 512 文字) */
const USER_AGENT_LIMIT = 512;
/** テストの家族の人数の上限 (1 つの家族に子供・大人を何人も足すため。人数の上限そのものは family-member-limit-race が確かめる) */
const FAMILY_MEMBER_LIMIT = 20;

/** JST の今日から years 年前の同じ月日 (その日が誕生日 = ちょうど years 歳)。2/29 は 2/28 に寄せる */
function yearsAgo(years: number): string {
  const today = todayLocal();
  const monthDay = today.slice(4) === '-02-29' ? '-02-28' : today.slice(4);
  return `${String(Number(today.slice(0, 4)) - years).padStart(4, '0')}${monthDay}`;
}
/** years 歳の誕生日の前日 (= years - 1 歳の最後の日) */
const dayBeforeBirthday = (years: number): string => addDaysToDate(yearsAgo(years), 1);

/**
 * 利用者を作る。withProfile (既定 true) ならプロフィールの行を作り、birthDate (既定 1990-01-01。null で入れない) を service_role で入れる。
 * withProfile: false は「新規登録しただけ」の人 (プロフィールの行が無い)
 */
async function createUser(
  label: string,
  options: { withProfile?: boolean; birthDate?: string | null } = {},
): Promise<TestUser> {
  userSeq += 1;
  const email = `sec-parental-${label}-${userSeq}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  if (options.withProfile !== false) {
    const birthDate = options.birthDate === undefined ? ADULT_BIRTH_DATE : options.birthDate;
    const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
      db.from('user_profiles').upsert(
        { id: data.user.id, nickname: `parental-${label}`, age_group: '30s', gender: 'other', birth_date: birthDate },
        { onConflict: 'id' },
      ));
    if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  }
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, email, jwt: signIn.data.session.access_token };
}

async function createFamily(label: string): Promise<TestFamily> {
  const rep = await createUser(`rep-${label}`);
  // billing/03 §6.6: 家族グループは家族プランの契約者だけが作れるので、作る前に家族プランを手動付与する
  await grantFamilyPlan(srAdmin, rep.id);
  const { data, error } = await asUser(rep.jwt).rpc('create_family_group', {
    p_name: `#1173 family ${label} ${TS}`,
    p_plan_key: 'free',
  });
  if (error || !data) throw new Error(`create_family_group ${label}: ${error?.message}`);
  const familyId = (data as { id: string }).id;
  createdFamilyIds.push(familyId);
  // 1 つの家族に子供・大人を何人も足すので、人数の上限 (無料プランは 4) を service_role で広げる
  const { error: limitError } = await srAdmin.from('family_groups').update({ member_limit: FAMILY_MEMBER_LIMIT }).eq('id', familyId);
  if (limitError) throw new Error(`member_limit ${label}: ${limitError.message}`);
  return { rep, familyId };
}

/** 家族に大人を 1 人足す (service_role で招待を作り、本人が承諾する) */
async function addAdult(family: TestFamily, label: string, options: { birthDate?: string | null } = {}): Promise<TestUser> {
  const adult = await createUser(`adult-${label}`, options);
  const token = randomBytes(32).toString('hex');
  const { error: inviteError } = await srAdmin.from('family_invites').insert({
    family_id: family.familyId,
    email: adult.email,
    token,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    status: 'pending',
    invited_by: family.rep.id,
  });
  if (inviteError) throw new Error(`invite ${label}: ${inviteError.message}`);
  const { error } = await asUser(adult.jwt).rpc('accept_family_invite', { p_token: token });
  if (error) throw new Error(`accept_family_invite ${label}: ${error.message}`);
  return adult;
}

interface ChildOptions {
  birthDate?: string | null;
  childProfile?: Record<string, unknown>;
  /** 既定は署名つき (版・氏名・親権者の確認)。null で何も送らない */
  consent?: { version?: string | null; signedName?: string | null; attested?: boolean | null } | null;
  ip?: string | null;
  userAgent?: string | null;
}

function addChildRpc(caller: TestUser, familyId: string, name: string, options: ChildOptions = {}) {
  const consent = options.consent === undefined ? {} : options.consent;
  return asUser(caller.jwt).rpc('add_family_child', {
    p_family_id: familyId,
    p_display_name: name,
    p_child_profile: options.childProfile ?? { note: '#1173' },
    p_birth_date: options.birthDate === undefined ? yearsAgo(8) : options.birthDate,
    ...(consent === null
      ? {}
      : {
          p_consent_version: consent.version === undefined ? PARENTAL_CONSENT_DOCUMENT.version : consent.version,
          p_signed_name: consent.signedName === undefined ? SIGNED_NAME : consent.signedName,
          p_guardian_attested: consent.attested === undefined ? true : consent.attested,
        }),
    ...(options.ip === undefined ? {} : { p_ip: options.ip }),
    ...(options.userAgent === undefined ? {} : { p_user_agent: options.userAgent }),
  });
}

async function addChild(caller: TestUser, familyId: string, name: string, options: ChildOptions = {}): Promise<string> {
  const { data, error } = await addChildRpc(caller, familyId, name, options);
  if (error || !data) throw new Error(`add_family_child ${name}: ${error?.message}`);
  return (data as { id: string }).id;
}

async function consentsOfFamily(familyId: string): Promise<ConsentRow[]> {
  const { data, error } = await srAdmin
    .from('parental_consents')
    .select('*')
    .eq('family_id', familyId)
    .order('signed_at', { ascending: true });
  if (error) throw new Error(`consentsOfFamily: ${error.message}`);
  return (data ?? []) as ConsentRow[];
}

async function consentById(id: string): Promise<ConsentRow | null> {
  const { data, error } = await srAdmin.from('parental_consents').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`consentById: ${error.message}`);
  return data as ConsentRow | null;
}

async function consentOfMember(memberId: string): Promise<ConsentRow> {
  const { data, error } = await srAdmin.from('parental_consents').select('*').eq('family_member_id', memberId).single();
  if (error) throw new Error(`consentOfMember: ${error.message}`);
  return data as ConsentRow;
}

async function auditOf(familyId: string, action: string): Promise<AuditRow[]> {
  const { data, error } = await srAdmin
    .from('membership_audit')
    .select('action, actor_id, target_user_id, metadata')
    .eq('scope_id', familyId)
    .eq('action', action)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`auditOf: ${error.message}`);
  return (data ?? []) as AuditRow[];
}

async function memberOf(memberId: string) {
  const { data, error } = await srAdmin
    .from('family_members')
    .select('id, family_id, user_id, role, status, display_name, child_profile, birth_date')
    .eq('id', memberId)
    .maybeSingle();
  if (error) throw new Error(`memberOf: ${error.message}`);
  return data as {
    id: string;
    family_id: string;
    user_id: string | null;
    role: string;
    status: string;
    display_name: string | null;
    child_profile: Record<string, unknown> | null;
    birth_date: string | null;
  } | null;
}

async function familyMemberCount(familyId: string): Promise<number> {
  const { count, error } = await srAdmin
    .from('family_members')
    .select('id', { count: 'exact', head: true })
    .eq('family_id', familyId);
  if (error) throw new Error(`familyMemberCount: ${error.message}`);
  return count ?? 0;
}

async function profileOf(userId: string) {
  const { data, error } = await srAdmin
    .from('user_profiles')
    .select('family_id, birth_date, organization_id, org_role')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw new Error(`profileOf: ${error.message}`);
  return data as { family_id: string | null; birth_date: string | null; organization_id: string | null; org_role: string | null } | null;
}

async function requestPromotion(family: TestFamily, memberId: string, email: string) {
  const { data, error } = await asUser(family.rep.jwt).rpc('request_child_promotion', { p_member_id: memberId, p_email: email });
  if (error || !data) throw new Error(`request_child_promotion: ${error?.message}`);
  return data as { id: string; token: string; status: string };
}

async function requestsOf(memberId: string) {
  const { data, error } = await srAdmin
    .from('family_promotion_requests')
    .select('id, status, expires_at')
    .eq('member_id', memberId);
  if (error) throw new Error(`requestsOf: ${error.message}`);
  return (data ?? []) as Array<{ id: string; status: string; expires_at: string }>;
}

/** 家族の子供 (birthDate・同意つき) を minor の本人のアカウントへ昇格させる。昇格した本人のメンバーの id を返す */
async function promote(family: TestFamily, minor: TestUser, birthDate: string): Promise<string> {
  const memberId = await addChild(family.rep, family.familyId, `promoted-${minor.id.slice(0, 6)}`, { birthDate });
  const request = await requestPromotion(family, memberId, minor.email);
  const { error } = await asUser(minor.jwt).rpc('accept_child_promotion', { p_token: request.token });
  if (error) throw new Error(`accept_child_promotion: ${error.message}`);
  return memberId;
}

async function guardianPath(user: TestUser): Promise<boolean> {
  const { data, error } = await asUser(user.jwt).rpc('legal_minor_has_guardian_path');
  if (error) throw new Error(`legal_minor_has_guardian_path: ${error.message}`);
  return data as boolean;
}

afterAll(async () => {
  // 組織の owner_id / 家族の representative_id は auth.users を RESTRICT で参照するため先に消す
  // (子供の行・同意の行は family_groups の削除に連動して消える)
  for (const id of createdOrgIds) await srAdmin.from('organizations').delete().eq('id', id);
  for (const id of createdFamilyIds) await srAdmin.from('family_groups').delete().eq('id', id);
  for (const id of createdUserIds) await srAdmin.auth.admin.deleteUser(id);
}, 120_000);

describe('#1173 add_family_child: 生年月日と保護者の同意', () => {
  // T-DB7
  it('add_family_child: p_birth_date なしは CHILD_BIRTH_DATE_REQUIRED、未来・121 年前は CHILD_BIRTH_DATE_INVALID。行は作られない', async () => {
    const family = await createFamily('db7');
    const before = await familyMemberCount(family.familyId);
    const missing = await addChildRpc(family.rep, family.familyId, 'db7-missing', { birthDate: null });
    expect(missing.error?.message).toContain('CHILD_BIRTH_DATE_REQUIRED');
    for (const birthDate of [addDaysToDate(todayLocal(), 1), yearsAgo(121)]) {
      const invalid = await addChildRpc(family.rep, family.familyId, 'db7-invalid', { birthDate });
      expect(invalid.error?.message, birthDate).toContain('CHILD_BIRTH_DATE_INVALID');
    }
    expect(await familyMemberCount(family.familyId)).toBe(before);
    expect(await consentsOfFamily(family.familyId)).toEqual([]);
  });

  // T-DB8
  it('子供の行の birth_date は列に入り、child_profile に birth_date キーが残らない (送っても除かれる)', async () => {
    const family = await createFamily('db8');
    const memberId = await addChild(family.rep, family.familyId, 'db8-child', {
      birthDate: yearsAgo(70),
      childProfile: { birth_date: '2000-01-01', allergies: ['egg'] },
      consent: null,
    });
    const member = await memberOf(memberId);
    expect(member?.birth_date).toBe(yearsAgo(70));
    expect(member?.child_profile).toEqual({ allergies: ['egg'] });
  });

  // T-DB9
  it('家族の大人が family_members.birth_date を直接 UPDATE すると 42501 (display_name の更新は通る)', async () => {
    const family = await createFamily('db9');
    const memberId = await addChild(family.rep, family.familyId, 'db9-child');
    const birth = await asUser(family.rep.jwt).from('family_members').update({ birth_date: yearsAgo(30) }).eq('id', memberId);
    expect(birth.error?.code).toBe('42501');
    const name = await asUser(family.rep.jwt).from('family_members').update({ display_name: 'db9-renamed' }).eq('id', memberId);
    expect(name.error).toBeNull();
    const member = await memberOf(memberId);
    expect(member?.birth_date).toBe(yearsAgo(8));
    expect(member?.display_name).toBe('db9-renamed');
  });

  // T-DB10
  it('8 歳 + 版 + 署名 + 親権者の確認 → 子供の行と parental_consents 1 行 (child_age_at_signing = 8、parent_user_id = 呼び出し者、user_agent は 512 文字で切れる) と監査 parental_consent_recorded / child_added (consent_id つき)', async () => {
    const family = await createFamily('db10');
    const memberId = await addChild(family.rep, family.familyId, 'db10-child', {
      birthDate: yearsAgo(8),
      consent: { signedName: `  ${SIGNED_NAME}  ` },
      ip: '203.0.113.10',
      userAgent: 'u'.repeat(USER_AGENT_LIMIT + 88),
    });
    const consents = await consentsOfFamily(family.familyId);
    expect(consents).toHaveLength(1);
    const consent = consents[0];
    expect(consent).toMatchObject({
      family_member_id: memberId,
      family_id: family.familyId,
      parent_user_id: family.rep.id,
      signed_name: SIGNED_NAME,
      guardian_attested: true,
      consent_version: PARENTAL_CONSENT_DOCUMENT.version,
      child_birth_date: yearsAgo(8),
      child_age_at_signing: 8,
      ip_address: '203.0.113.10',
      revoked_at: null,
      revoked_reason: null,
    });
    expect(consent.user_agent).toBe('u'.repeat(USER_AGENT_LIMIT));

    const recorded = await auditOf(family.familyId, 'parental_consent_recorded');
    expect(recorded).toHaveLength(1);
    expect(recorded[0].actor_id).toBe(family.rep.id);
    expect(recorded[0].metadata).toMatchObject({
      member_id: memberId,
      consent_id: consent.id,
      consent_version: PARENTAL_CONSENT_DOCUMENT.version,
      child_age: 8,
    });
    const added = await auditOf(family.familyId, 'child_added');
    expect(added).toHaveLength(1);
    expect(added[0].metadata).toMatchObject({ member_id: memberId, consent_id: consent.id });
  });

  // T-DB11
  it('17 歳も同じ (child_age_at_signing = 17)', async () => {
    const family = await createFamily('db11');
    const memberId = await addChild(family.rep, family.familyId, 'db11-child', { birthDate: dayBeforeBirthday(18) });
    expect(await consentOfMember(memberId)).toMatchObject({ child_age_at_signing: 17, parent_user_id: family.rep.id });
  });

  // T-DB12
  it('17 歳で 版なし / 署名が空白だけ / 101 文字 / guardian_attested false → PARENTAL_CONSENT_REQUIRED。行も同意も監査も作られない (S9)', async () => {
    const family = await createFamily('db12');
    const before = await familyMemberCount(family.familyId);
    const cases: Array<ChildOptions['consent']> = [
      null,
      { version: null },
      { version: 'not a version' },
      { signedName: '   ' },
      { signedName: 'x'.repeat(SIGNED_NAME_LIMIT + 1) },
      { attested: false },
    ];
    for (const consent of cases) {
      const { error } = await addChildRpc(family.rep, family.familyId, 'db12-child', { birthDate: yearsAgo(17), consent });
      expect(error?.message, JSON.stringify(consent)).toContain('PARENTAL_CONSENT_REQUIRED');
    }
    expect(await familyMemberCount(family.familyId)).toBe(before);
    expect(await consentsOfFamily(family.familyId)).toEqual([]);
    expect(await auditOf(family.familyId, 'parental_consent_recorded')).toEqual([]);
    expect(await auditOf(family.familyId, 'child_added')).toEqual([]);
    // 100 文字ちょうどは通る
    const memberId = await addChild(family.rep, family.familyId, 'db12-max', {
      birthDate: yearsAgo(17),
      consent: { signedName: 'x'.repeat(SIGNED_NAME_LIMIT) },
    });
    expect((await consentOfMember(memberId)).signed_name).toHaveLength(SIGNED_NAME_LIMIT);
  });

  // T-DB13
  it('版の文字列はそのまま記録され、関数は現行の版かどうかを見ない (任意の形式内の版で通る。版の一致は route の責務)', async () => {
    const family = await createFamily('db13');
    const memberId = await addChild(family.rep, family.familyId, 'db13-child', { consent: { version: 'old-v0.9' } });
    expect((await consentOfMember(memberId)).consent_version).toBe('old-v0.9');
  });

  // T-DB14
  it('70 歳は同意なしで追加され、parental_consents は増えない (S8)。同意を送っても無視される', async () => {
    const family = await createFamily('db14');
    await addChild(family.rep, family.familyId, 'db14-none', { birthDate: yearsAgo(70), consent: null });
    await addChild(family.rep, family.familyId, 'db14-sent', { birthDate: yearsAgo(70) });
    // 18 歳の誕生日の当日も大人
    await addChild(family.rep, family.familyId, 'db14-18', { birthDate: yearsAgo(18), consent: null });
    expect(await consentsOfFamily(family.familyId)).toEqual([]);
    expect(await auditOf(family.familyId, 'parental_consent_recorded')).toEqual([]);
    expect(await auditOf(family.familyId, 'child_added')).toHaveLength(3);
  });

  // T-DB32
  it('add_family_child: 17 歳の子供 + 版 + 署名 + 親権者の確認でも、呼び出す大人の user_profiles.birth_date が NULL、または 16 歳 (昇格した本人を role = adult にした状態) なら PARENTAL_CONSENT_SIGNER_NOT_ADULT。子供の行・同意・監査は作られない。署名の入力が欠けていれば先に PARENTAL_CONSENT_REQUIRED。70 歳の子供の追加は署名者の生年月日を見ずに通る (S19・P14b・P11)', async () => {
    const family = await createFamily('db32');
    const noBirth = await addAdult(family, 'db32-nobirth', { birthDate: null });
    const minor = await createUser('db32-minor', { withProfile: false });
    await promote(family, minor, yearsAgo(16));
    expect((await profileOf(minor.id))?.birth_date).toBe(yearsAgo(16));
    const before = await familyMemberCount(family.familyId);
    const consentsBefore = (await consentsOfFamily(family.familyId)).length;
    const auditBefore = (await auditOf(family.familyId, 'child_added')).length;

    for (const signer of [noBirth, minor]) {
      const { error } = await addChildRpc(signer, family.familyId, 'db32-child', { birthDate: yearsAgo(17) });
      expect(error?.message, signer.email).toContain('PARENTAL_CONSENT_SIGNER_NOT_ADULT');
      const missing = await addChildRpc(signer, family.familyId, 'db32-child', { birthDate: yearsAgo(17), consent: { attested: false } });
      expect(missing.error?.message, signer.email).toContain('PARENTAL_CONSENT_REQUIRED');
    }
    expect(await familyMemberCount(family.familyId)).toBe(before);
    expect(await consentsOfFamily(family.familyId)).toHaveLength(consentsBefore);
    expect(await auditOf(family.familyId, 'child_added')).toHaveLength(auditBefore);

    for (const signer of [noBirth, minor]) {
      const { error } = await addChildRpc(signer, family.familyId, 'db32-adult-child', { birthDate: yearsAgo(70), consent: null });
      expect(error, signer.email).toBeNull();
    }
  });
});

describe('#1173 parental_consents: 読める人・書けない人', () => {
  // T-DB15
  it('parental_consents: その家族の active な大人は読める、別の家族の大人・子供の行を持つ家族の外の人・anon は 0 行。家族を抜けた署名者は自分が署名した行だけ読め、同じ家族の他の大人が署名した行は読めない', async () => {
    const family = await createFamily('db15');
    const signer = await addAdult(family, 'db15-signer');
    const byRep = await addChild(family.rep, family.familyId, 'db15-rep-child');
    const bySigner = await addChild(signer, family.familyId, 'db15-signer-child');
    const other = await createFamily('db15-other');
    const outsider = await createUser('db15-outsider');

    const visibleTo = async (jwt: string): Promise<string[]> => {
      const { data, error } = await asUser(jwt).from('parental_consents').select('family_member_id').eq('family_id', family.familyId);
      expect(error).toBeNull();
      return ((data ?? []) as Array<{ family_member_id: string }>).map((r) => r.family_member_id).sort();
    };
    expect(await visibleTo(family.rep.jwt)).toEqual([byRep, bySigner].sort());
    expect(await visibleTo(signer.jwt)).toEqual([byRep, bySigner].sort());
    expect(await visibleTo(other.rep.jwt)).toEqual([]);
    expect(await visibleTo(outsider.jwt)).toEqual([]);
    const anonRead = await anon().from('parental_consents').select('id').eq('family_id', family.familyId);
    expect(anonRead.data ?? []).toEqual([]);

    const { error: leaveError } = await asUser(signer.jwt).rpc('leave_family');
    expect(leaveError).toBeNull();
    expect(await visibleTo(signer.jwt)).toEqual([bySigner]);
  });

  // T-DB16
  it('authenticated の INSERT / UPDATE / DELETE は 42501 (GRANT なし)。service_role は読める', async () => {
    const family = await createFamily('db16');
    const memberId = await addChild(family.rep, family.familyId, 'db16-child');
    const consent = await consentOfMember(memberId);
    const api = asUser(family.rep.jwt);
    const insert = await api.from('parental_consents').insert({
      family_member_id: memberId,
      family_id: family.familyId,
      parent_user_id: family.rep.id,
      signed_name: 'forged',
      guardian_attested: true,
      consent_version: 'v1',
      child_birth_date: yearsAgo(8),
      child_age_at_signing: 8,
    });
    expect(insert.error?.code).toBe('42501');
    const update = await api.from('parental_consents').update({ signed_name: 'forged' }).eq('id', consent.id);
    expect(update.error?.code).toBe('42501');
    const remove = await api.from('parental_consents').delete().eq('id', consent.id);
    expect(remove.error?.code).toBe('42501');
    expect(await consentById(consent.id)).toMatchObject({ signed_name: SIGNED_NAME, revoked_at: null });
  });

  // T-DB17
  it('運営 (roles に admin) は他の家族の行も読める', async () => {
    const family = await createFamily('db17');
    const memberId = await addChild(family.rep, family.familyId, 'db17-child');
    const operator = await createUser('db17-admin');
    const { error: roleError } = await srAdmin.from('user_profiles').update({ roles: ['user', 'admin'] }).eq('id', operator.id);
    expect(roleError).toBeNull();
    const { data, error } = await asUser(operator.jwt).from('parental_consents').select('family_member_id').eq('family_id', family.familyId);
    expect(error).toBeNull();
    expect(data).toEqual([{ family_member_id: memberId }]);
  });
});

describe('#1173 保持と取り消し', () => {
  // T-DB18
  it('署名者の auth.users を消すと parent_user_id が NULL になり行は残る (S14)', async () => {
    const family = await createFamily('db18');
    const signer = await addAdult(family, 'db18-signer');
    const memberId = await addChild(signer, family.familyId, 'db18-child');
    const consent = await consentOfMember(memberId);
    const { error } = await srAdmin.auth.admin.deleteUser(signer.id);
    expect(error).toBeNull();
    expect(await consentById(consent.id)).toMatchObject({
      parent_user_id: null,
      family_member_id: memberId,
      signed_name: SIGNED_NAME,
      revoked_at: null,
    });
  });

  // T-DB19
  it('子供の行 (8 歳・同意 active) を service_role で DELETE すると、同意の行は消えずに残り、revoked_at / revoked_reason=member_deleted が入って family_member_id が NULL になる。外した子供の行を DELETE すると member_removed のまま。有効な同意の family_member_id を NULL にすると 23514。家族の行を DELETE すると子供の行と同意の行が消える (P24・P24b)', async () => {
    const family = await createFamily('db19');
    const deleted = await addChild(family.rep, family.familyId, 'db19-deleted', { ip: '203.0.113.19', userAgent: 'db19-agent' });
    const removed = await addChild(family.rep, family.familyId, 'db19-removed');
    const kept = await addChild(family.rep, family.familyId, 'db19-kept');
    const deletedConsent = await consentOfMember(deleted);
    const removedConsent = await consentOfMember(removed);
    const keptConsent = await consentOfMember(kept);

    const { error: deleteError } = await srAdmin.from('family_members').delete().eq('id', deleted);
    expect(deleteError).toBeNull();
    const afterDelete = await consentById(deletedConsent.id);
    expect(afterDelete).toMatchObject({
      family_member_id: null,
      revoked_reason: 'member_deleted',
      signed_name: deletedConsent.signed_name,
      signed_at: deletedConsent.signed_at,
      consent_version: deletedConsent.consent_version,
      child_birth_date: deletedConsent.child_birth_date,
      child_age_at_signing: deletedConsent.child_age_at_signing,
      ip_address: '203.0.113.19',
      user_agent: 'db19-agent',
    });
    expect(afterDelete?.revoked_at).not.toBeNull();
    const revokedAudit = await auditOf(family.familyId, 'parental_consent_revoked');
    expect(revokedAudit).toHaveLength(1);
    expect(revokedAudit[0].actor_id).toBeNull();
    expect(revokedAudit[0].metadata).toMatchObject({ member_id: deleted, consent_id: deletedConsent.id, reason: 'member_deleted' });

    const { error: removeError } = await asUser(family.rep.jwt).rpc('remove_family_member', {
      p_family_id: family.familyId,
      p_member_id: removed,
    });
    expect(removeError).toBeNull();
    expect(await auditOf(family.familyId, 'parental_consent_revoked')).toHaveLength(2);
    const { error: deleteRemovedError } = await srAdmin.from('family_members').delete().eq('id', removed);
    expect(deleteRemovedError).toBeNull();
    expect(await consentById(removedConsent.id)).toMatchObject({ family_member_id: null, revoked_reason: 'member_removed' });
    expect(await auditOf(family.familyId, 'parental_consent_revoked')).toHaveLength(2);

    const { error: nullError } = await srAdmin.from('parental_consents').update({ family_member_id: null }).eq('id', keptConsent.id);
    expect(nullError?.code).toBe('23514');
    expect((await consentById(keptConsent.id))?.family_member_id).toBe(kept);

    const { error: familyDeleteError } = await srAdmin.from('family_groups').delete().eq('id', family.familyId);
    expect(familyDeleteError).toBeNull();
    for (const id of [deletedConsent.id, removedConsent.id, keptConsent.id]) {
      expect(await consentById(id), id).toBeNull();
    }
    expect(await memberOf(kept)).toBeNull();
  });

  // T-DB20
  it('remove_family_member で子供を外すと revoked_at / revoked_reason=member_removed が入り、同意の行は消えずに残り、監査 parental_consent_revoked (actor = 外した人) が 1 行 (S13)。operator_force_dissolve_family で家族を解散すると子供の同意は member_left (actor = 運営)。17 歳で昇格した本人 (role = adult) が leave_family で抜けても member_left が入る', async () => {
    const family = await createFamily('db20');
    const child = await addChild(family.rep, family.familyId, 'db20-child', { ip: '203.0.113.20', userAgent: 'db20-agent' });
    const before = await consentOfMember(child);
    const { error } = await asUser(family.rep.jwt).rpc('remove_family_member', { p_family_id: family.familyId, p_member_id: child });
    expect(error).toBeNull();
    const after = await consentById(before.id);
    expect(after).toMatchObject({
      family_member_id: child,
      revoked_reason: 'member_removed',
      signed_name: before.signed_name,
      signed_at: before.signed_at,
      consent_version: before.consent_version,
      child_birth_date: before.child_birth_date,
      ip_address: '203.0.113.20',
      user_agent: 'db20-agent',
    });
    expect(after?.revoked_at).not.toBeNull();
    const audit = await auditOf(family.familyId, 'parental_consent_revoked');
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_id).toBe(family.rep.id);
    expect(audit[0].metadata).toMatchObject({ member_id: child, consent_id: before.id, reason: 'member_removed' });

    const dissolved = await createFamily('db20-dissolve');
    const dissolvedChild = await addChild(dissolved.rep, dissolved.familyId, 'db20-dissolved-child');
    const operator = await createUser('db20-operator');
    const { error: roleError } = await srAdmin.from('user_profiles').update({ roles: ['user', 'super_admin'] }).eq('id', operator.id);
    expect(roleError).toBeNull();
    const dissolve = await asUser(operator.jwt).rpc('operator_force_dissolve_family', { p_family_id: dissolved.familyId, p_reason: '#1173 test' });
    expect(dissolve.error).toBeNull();
    expect(await consentOfMember(dissolvedChild)).toMatchObject({ revoked_reason: 'member_left' });
    const dissolveAudit = await auditOf(dissolved.familyId, 'parental_consent_revoked');
    expect(dissolveAudit).toHaveLength(1);
    expect(dissolveAudit[0].actor_id).toBe(operator.id);

    const promotedFamily = await createFamily('db20-promoted');
    const minor = await createUser('db20-minor', { withProfile: false });
    const promotedMember = await promote(promotedFamily, minor, yearsAgo(17));
    expect((await memberOf(promotedMember))?.role).toBe('adult');
    const leave = await asUser(minor.jwt).rpc('leave_family');
    expect(leave.error).toBeNull();
    expect(await consentOfMember(promotedMember)).toMatchObject({ revoked_reason: 'member_left' });
  });

  // T-DB21
  it('同意の無い (≥ 18 の) 子供を外しても、同意の無い大人が脱退しても、parental_consents と監査 parental_consent_revoked は増えない', async () => {
    const family = await createFamily('db21');
    const adultChild = await addChild(family.rep, family.familyId, 'db21-adult-child', { birthDate: yearsAgo(40), consent: null });
    const adult = await addAdult(family, 'db21-adult');
    const { error } = await asUser(family.rep.jwt).rpc('remove_family_member', { p_family_id: family.familyId, p_member_id: adultChild });
    expect(error).toBeNull();
    const leave = await asUser(adult.jwt).rpc('leave_family');
    expect(leave.error).toBeNull();
    expect(await consentsOfFamily(family.familyId)).toEqual([]);
    expect(await auditOf(family.familyId, 'parental_consent_revoked')).toEqual([]);
  });

  // T-DB22
  it('有効な同意は子供 1 人に 1 行 (uniq_parental_consents_active_member)。取り消し済みの行がある状態で新しい子供の行には別の同意が作れる', async () => {
    const family = await createFamily('db22');
    const child = await addChild(family.rep, family.familyId, 'db22-child');
    const duplicate = await srAdmin.from('parental_consents').insert({
      family_member_id: child,
      family_id: family.familyId,
      parent_user_id: family.rep.id,
      signed_name: 'dup',
      guardian_attested: true,
      consent_version: 'v1',
      child_birth_date: yearsAgo(8),
      child_age_at_signing: 8,
    });
    expect(duplicate.error?.code).toBe('23505');

    const { error } = await asUser(family.rep.jwt).rpc('remove_family_member', { p_family_id: family.familyId, p_member_id: child });
    expect(error).toBeNull();
    const second = await addChild(family.rep, family.familyId, 'db22-second');
    const consents = await consentsOfFamily(family.familyId);
    expect(consents).toHaveLength(2);
    expect(consents.find((c) => c.family_member_id === child)?.revoked_reason).toBe('member_removed');
    expect(consents.find((c) => c.family_member_id === second)?.revoked_at).toBeNull();
  });

  // T-DB28
  it('family_members_child_birth_date_required: service_role でも user_id NULL の子供の行は birth_date なしで INSERT できず、birth_date を NULL に UPDATE できない (23514)。user_id ありの行を role = child に UPDATE するのは birth_date なしで通る', async () => {
    const family = await createFamily('db28');
    const insert = await srAdmin.from('family_members').insert({
      family_id: family.familyId,
      user_id: null,
      role: 'child',
      display_name: 'db28-no-birth',
      child_profile: {},
      status: 'active',
    });
    expect(insert.error?.code).toBe('23514');
    const child = await addChild(family.rep, family.familyId, 'db28-child', { birthDate: yearsAgo(40), consent: null });
    const clear = await srAdmin.from('family_members').update({ birth_date: null }).eq('id', child);
    expect(clear.error?.code).toBe('23514');
    expect((await memberOf(child))?.birth_date).toBe(yearsAgo(40));

    const adult = await addAdult(family, 'db28-adult');
    const demote = await srAdmin
      .from('family_members')
      .update({ role: 'child' })
      .eq('family_id', family.familyId)
      .eq('user_id', adult.id)
      .select('role, birth_date');
    expect(demote.error).toBeNull();
    expect(demote.data).toEqual([{ role: 'child', birth_date: null }]);
  });
});

describe('#1173 昇格の年齢と同意', () => {
  // T-DB23
  it('request_child_promotion: 17 歳で同意なし (service_role で同意を revoked にした状態) は PARENTAL_CONSENT_REQUIRED、依頼は作られない (S12)', async () => {
    const family = await createFamily('db23');
    const child = await addChild(family.rep, family.familyId, 'db23-child', { birthDate: yearsAgo(17) });
    const { error: revokeError } = await srAdmin
      .from('parental_consents')
      .update({ revoked_at: new Date().toISOString(), revoked_reason: 'member_removed' })
      .eq('family_member_id', child);
    expect(revokeError).toBeNull();
    const target = await createUser('db23-target', { withProfile: false });
    const { error } = await asUser(family.rep.jwt).rpc('request_child_promotion', { p_member_id: child, p_email: target.email });
    expect(error?.message).toContain('PARENTAL_CONSENT_REQUIRED');
    expect(await requestsOf(child)).toEqual([]);
  });

  // T-DB24
  it('17 歳で同意ありは従来どおり pending。70 歳は同意なしで pending', async () => {
    const family = await createFamily('db24');
    const minorChild = await addChild(family.rep, family.familyId, 'db24-minor', { birthDate: yearsAgo(17) });
    const adultChild = await addChild(family.rep, family.familyId, 'db24-adult', { birthDate: yearsAgo(70), consent: null });
    for (const child of [minorChild, adultChild]) {
      const target = await createUser(`db24-target-${child.slice(0, 4)}`, { withProfile: false });
      const request = await requestPromotion(family, child, target.email);
      expect(request.status).toBe('pending');
    }
  });

  // T-DB25
  it('accept_child_promotion: 承諾で user_profiles.birth_date がメンバーの birth_date で上書きされる (事前に別の日付が入っていても)', async () => {
    const family = await createFamily('db25');
    const minor = await createUser('db25-minor', { birthDate: yearsAgo(30) });
    await promote(family, minor, yearsAgo(17));
    expect(await profileOf(minor.id)).toMatchObject({ birth_date: yearsAgo(17), family_id: family.familyId });
  });

  // T-DB26
  it('accept_child_promotion: 承諾の直前に同意が revoked になっていれば PARENTAL_CONSENT_REQUIRED', async () => {
    const family = await createFamily('db26');
    const child = await addChild(family.rep, family.familyId, 'db26-child', { birthDate: yearsAgo(17) });
    const minor = await createUser('db26-minor', { withProfile: false });
    const request = await requestPromotion(family, child, minor.email);
    const { error: revokeError } = await srAdmin
      .from('parental_consents')
      .update({ revoked_at: new Date().toISOString(), revoked_reason: 'member_removed' })
      .eq('family_member_id', child);
    expect(revokeError).toBeNull();
    const { error } = await asUser(minor.jwt).rpc('accept_child_promotion', { p_token: request.token });
    expect(error?.message).toContain('PARENTAL_CONSENT_REQUIRED');
    expect((await memberOf(child))?.user_id).toBeNull();
    expect(await profileOf(minor.id)).toBeNull();
  });

  // T-DB29
  it('同意に期限は無い: service_role で parental_consents.signed_at を 20 年前に書き換えても、17 歳の子供への request_child_promotion は PARENTAL_CONSENT_REQUIRED にならず pending を作る (経過日数で失効しない。P31)', async () => {
    const family = await createFamily('db29');
    const child = await addChild(family.rep, family.familyId, 'db29-child', { birthDate: yearsAgo(17) });
    const { error: oldError } = await srAdmin
      .from('parental_consents')
      .update({ signed_at: `${yearsAgo(20)}T00:00:00+09:00` })
      .eq('family_member_id', child);
    expect(oldError).toBeNull();
    const target = await createUser('db29-target', { withProfile: false });
    expect((await requestPromotion(family, child, target.email)).status).toBe('pending');
  });

  // T-DB30
  it('accept_child_promotion: 70 歳 (同意なし) の子供への依頼は承諾でき、user_profiles.birth_date がメンバーの birth_date になる (承諾時の検査は 18 歳未満だけに掛かる。P19 の承諾時・P20)', async () => {
    const family = await createFamily('db30');
    const child = await addChild(family.rep, family.familyId, 'db30-child', { birthDate: yearsAgo(70), consent: null });
    const target = await createUser('db30-target', { withProfile: false });
    const request = await requestPromotion(family, child, target.email);
    const { error } = await asUser(target.jwt).rpc('accept_child_promotion', { p_token: request.token });
    expect(error).toBeNull();
    expect((await profileOf(target.id))?.birth_date).toBe(yearsAgo(70));
  });

  // T-DB34
  it('request_child_promotion: 12 歳の子供 (同意 active) は PROMOTION_UNDER_COPPA_AGE で依頼は作られない。13 歳の誕生日の当日の子供は pending。accept_child_promotion: 12 歳の子供への pending の依頼 (service_role で作る) は承諾で PROMOTION_UNDER_COPPA_AGE になり、family_members の行・user_profiles は変わらず依頼は pending のまま (S20・P17b・P20)', async () => {
    const family = await createFamily('db34');
    const under13 = await addChild(family.rep, family.familyId, 'db34-12', { birthDate: dayBeforeBirthday(13) });
    const just13 = await addChild(family.rep, family.familyId, 'db34-13', { birthDate: yearsAgo(13) });
    const target = await createUser('db34-target', { withProfile: false });
    const refused = await asUser(family.rep.jwt).rpc('request_child_promotion', { p_member_id: under13, p_email: target.email });
    expect(refused.error?.message).toContain('PROMOTION_UNDER_COPPA_AGE');
    expect(await requestsOf(under13)).toEqual([]);
    const target13 = await createUser('db34-target13', { withProfile: false });
    expect((await requestPromotion(family, just13, target13.email)).status).toBe('pending');

    const token = randomBytes(32).toString('hex');
    const { error: insertError } = await srAdmin.from('family_promotion_requests').insert({
      family_id: family.familyId,
      member_id: under13,
      email: target.email,
      token,
      status: 'pending',
      requested_by: family.rep.id,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(insertError).toBeNull();
    const memberBefore = await memberOf(under13);
    const { error } = await asUser(target.jwt).rpc('accept_child_promotion', { p_token: token });
    expect(error?.message).toContain('PROMOTION_UNDER_COPPA_AGE');
    expect(await memberOf(under13)).toEqual(memberBefore);
    expect(await profileOf(target.id)).toBeNull();
    expect((await requestsOf(under13)).map((r) => r.status)).toEqual(['pending']);
  });

  // T-DB31
  it('legal_minor_has_guardian_path(): 呼んだ本人のことだけを答える。17 歳の子供 (同意 active) に本人のメール宛の pending の依頼があれば true → 本人が断る / 代表者が取り消す / 期限を過去にする、のどれでも false。承諾して昇格した本人は true → leave_family / remove_family_member のあとは false。依頼も行も無い人は false。anon は 42501 (S17・S18・P32・P33)', async () => {
    const family = await createFamily('db31');
    const pathFor = async (label: string) => {
      const child = await addChild(family.rep, family.familyId, `db31-${label}`, { birthDate: yearsAgo(17) });
      const minor = await createUser(`db31-${label}`, { withProfile: false });
      const request = await requestPromotion(family, child, minor.email);
      expect(await guardianPath(minor), label).toBe(true);
      return { child, minor, request };
    };

    const rejected = await pathFor('rejected');
    const reject = await asUser(rejected.minor.jwt).rpc('reject_child_promotion', { p_token: rejected.request.token });
    expect(reject.error).toBeNull();
    expect(await guardianPath(rejected.minor)).toBe(false);

    const revoked = await pathFor('revoked');
    const revoke = await asUser(family.rep.jwt).rpc('revoke_child_promotion', { p_member_id: revoked.child });
    expect(revoke.error).toBeNull();
    expect(await guardianPath(revoked.minor)).toBe(false);

    const expired = await pathFor('expired');
    const { error: expireError } = await srAdmin
      .from('family_promotion_requests')
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', expired.request.id);
    expect(expireError).toBeNull();
    expect(await guardianPath(expired.minor)).toBe(false);

    // 別の人 (依頼の宛先でない) から見ると false (呼んだ本人のことだけ)
    const stranger = await createUser('db31-stranger', { withProfile: false });
    const live = await pathFor('live');
    expect(await guardianPath(stranger)).toBe(false);

    const leaver = await createUser('db31-leaver', { withProfile: false });
    await promote(family, leaver, yearsAgo(17));
    expect(await guardianPath(leaver)).toBe(true);
    expect((await asUser(leaver.jwt).rpc('leave_family')).error).toBeNull();
    expect(await guardianPath(leaver)).toBe(false);

    const removed = await createUser('db31-removed', { withProfile: false });
    const removedMember = await promote(family, removed, yearsAgo(17));
    expect(await guardianPath(removed)).toBe(true);
    const remove = await asUser(family.rep.jwt).rpc('remove_family_member', { p_family_id: family.familyId, p_member_id: removedMember });
    expect(remove.error).toBeNull();
    expect(await guardianPath(removed)).toBe(false);

    expect(await guardianPath(live.minor)).toBe(true);
    const anonCall = await anon().rpc('legal_minor_has_guardian_path');
    expect(anonCall.error?.code).toBe('42501');
  });
});

describe('#1173 18 歳未満の本人の家族・組織の役割 (MINOR_ACCOUNT_NOT_ALLOWED)', () => {
  // T-DB35
  it('create_family_group: 呼び出す本人の user_profiles.birth_date が 16 歳 (service_role で入れる) なら MINOR_ACCOUNT_NOT_ALLOWED で、family_groups・family_members・監査 group_created は作られず、user_profiles.family_id も変わらない。1990-01-01 の人と birth_date が NULL の人は従来どおり作れる (P36・P38・S21)', async () => {
    const minor = await createUser('db35-minor', { birthDate: yearsAgo(16) });
    const { error } = await asUser(minor.jwt).rpc('create_family_group', { p_name: `#1173 db35 ${TS}`, p_plan_key: 'free' });
    expect(error?.message).toContain('MINOR_ACCOUNT_NOT_ALLOWED');
    const groups = await srAdmin.from('family_groups').select('id').eq('representative_id', minor.id);
    expect(groups.data).toEqual([]);
    const rows = await srAdmin.from('family_members').select('id').eq('user_id', minor.id);
    expect(rows.data).toEqual([]);
    const audits = await srAdmin.from('membership_audit').select('id').eq('action', 'group_created').eq('actor_id', minor.id);
    expect(audits.data).toEqual([]);
    expect((await profileOf(minor.id))?.family_id).toBeNull();

    for (const birthDate of [ADULT_BIRTH_DATE, null]) {
      const user = await createUser(`db35-${birthDate ?? 'null'}`, { birthDate });
      // billing/03 §6.6: 家族グループは家族プランの契約者だけが作れるので、作る前に家族プランを手動付与する
      await grantFamilyPlan(srAdmin, user.id);
      const { data, error: createError } = await asUser(user.jwt).rpc('create_family_group', {
        p_name: `#1173 db35 ${birthDate ?? 'null'} ${TS}`,
        p_plan_key: 'free',
      });
      expect(createError, String(birthDate)).toBeNull();
      createdFamilyIds.push((data as { id: string }).id);
    }
  });

  // T-DB36
  it('accept_family_invite: 16 歳の本人 (昇格の経路がある状態) は、自分のメール宛の有効な家族の招待でも MINOR_ACCOUNT_NOT_ALLOWED で、family_members は増えず招待は pending のまま。そのあと同じ本人の accept_child_promotion は ALREADY_IN_FAMILY にならずに通る。1990-01-01 の人は同じ招待の形で承諾できる (P36・S21)', async () => {
    const guardianFamily = await createFamily('db36-guardian');
    const child = await addChild(guardianFamily.rep, guardianFamily.familyId, 'db36-child', { birthDate: yearsAgo(16) });
    const minor = await createUser('db36-minor', { withProfile: false });
    const request = await requestPromotion(guardianFamily, child, minor.email);
    expect(await guardianPath(minor)).toBe(true);
    // 本人の生年月日 (16 歳) は同意の記録で入る (経路があるので通る)
    const accepted = await asUser(minor.jwt).rpc('accept_legal_documents', {
      p_terms_version: 'test-v1',
      p_privacy_version: 'test-v1',
      p_birth_date: yearsAgo(16),
    });
    expect(accepted.error).toBeNull();

    const other = await createFamily('db36-other');
    const token = randomBytes(32).toString('hex');
    const { error: inviteError } = await srAdmin.from('family_invites').insert({
      family_id: other.familyId,
      email: minor.email,
      token,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'pending',
      invited_by: other.rep.id,
    });
    expect(inviteError).toBeNull();
    const before = await familyMemberCount(other.familyId);
    const { error } = await asUser(minor.jwt).rpc('accept_family_invite', { p_token: token });
    expect(error?.message).toContain('MINOR_ACCOUNT_NOT_ALLOWED');
    expect(await familyMemberCount(other.familyId)).toBe(before);
    const invite = await srAdmin.from('family_invites').select('status').eq('token', token).single();
    expect((invite.data as { status: string }).status).toBe('pending');

    const promotion = await asUser(minor.jwt).rpc('accept_child_promotion', { p_token: request.token });
    expect(promotion.error).toBeNull();
    expect((await memberOf(child))?.user_id).toBe(minor.id);

    // 1990-01-01 の人は同じ形の招待を承諾できる
    const adult = await addAdult(other, 'db36-adult');
    expect((await profileOf(adult.id))?.family_id).toBe(other.familyId);
  });

  // T-DB37
  it('accept_family_representative_transfer / accept_org_owner_transfer: 承諾で昇格した 16 歳の本人は MINOR_ACCOUNT_NOT_ALLOWED で、役割・代表者・オーナー・提案は変わらない。1990-01-01 の人はどちらも承諾できる (P37・S21)', async () => {
    const family = await createFamily('db37');
    const minor = await createUser('db37-minor', { withProfile: false });
    const minorMember = await promote(family, minor, yearsAgo(16));
    const adult = await addAdult(family, 'db37-adult');
    const insertProposal = async (scope: 'family' | 'organization', scopeId: string, from: string, to: string) => {
      const { data, error } = await srAdmin
        .from('ownership_transfer_proposals')
        .insert({ scope, scope_id: scopeId, from_user_id: from, to_user_id: to, status: 'pending' })
        .select('id')
        .single();
      if (error || !data) throw new Error(`proposal: ${error?.message}`);
      return (data as { id: string }).id;
    };
    const proposalStatus = async (id: string) =>
      ((await srAdmin.from('ownership_transfer_proposals').select('status').eq('id', id).single()).data as { status: string }).status;
    const representativeOf = async () =>
      ((await srAdmin.from('family_groups').select('representative_id').eq('id', family.familyId).single()).data as {
        representative_id: string;
      }).representative_id;

    const familyProposal = await insertProposal('family', family.familyId, family.rep.id, minor.id);
    const refused = await asUser(minor.jwt).rpc('accept_family_representative_transfer', { p_proposal_id: familyProposal });
    expect(refused.error?.message).toContain('MINOR_ACCOUNT_NOT_ALLOWED');
    expect((await memberOf(minorMember))?.role).toBe('adult');
    expect(await representativeOf()).toBe(family.rep.id);
    expect(await proposalStatus(familyProposal)).toBe('pending');

    const owner = await createUser('db37-owner');
    const { data: org, error: orgError } = await srAdmin
      .from('organizations')
      .insert({ name: `#1173 db37 org ${TS}`, owner_id: owner.id })
      .select('id')
      .single();
    if (orgError || !org) throw new Error(`org: ${orgError?.message}`);
    const orgId = (org as { id: string }).id;
    createdOrgIds.push(orgId);
    for (const [userId, role] of [
      [owner.id, 'owner'],
      [minor.id, 'member'],
      [adult.id, 'member'],
    ] as const) {
      const { error } = await srAdmin
        .from('user_profiles')
        .update({ organization_id: orgId, org_role: role, is_active_in_org: true })
        .eq('id', userId);
      expect(error).toBeNull();
    }
    const orgProposal = await insertProposal('organization', orgId, owner.id, minor.id);
    const orgRefused = await asUser(minor.jwt).rpc('accept_org_owner_transfer', { p_proposal_id: orgProposal });
    expect(orgRefused.error?.message).toContain('MINOR_ACCOUNT_NOT_ALLOWED');
    const ownerOf = async () =>
      ((await srAdmin.from('organizations').select('owner_id').eq('id', orgId).single()).data as { owner_id: string }).owner_id;
    expect(await ownerOf()).toBe(owner.id);
    expect((await profileOf(minor.id))?.org_role).toBe('member');
    expect(await proposalStatus(orgProposal)).toBe('pending');

    // 1990-01-01 の人はどちらも承諾できる (pending の提案は scope ごとに 1 件なので、断られた提案を先に期限切れにする)
    const { error: expireError } = await srAdmin
      .from('ownership_transfer_proposals')
      .update({ status: 'expired' })
      .in('id', [familyProposal, orgProposal]);
    expect(expireError).toBeNull();
    const adultFamilyProposal = await insertProposal('family', family.familyId, family.rep.id, adult.id);
    expect((await asUser(adult.jwt).rpc('accept_family_representative_transfer', { p_proposal_id: adultFamilyProposal })).error).toBeNull();
    expect(await representativeOf()).toBe(adult.id);
    const adultOrgProposal = await insertProposal('organization', orgId, owner.id, adult.id);
    expect((await asUser(adult.jwt).rpc('accept_org_owner_transfer', { p_proposal_id: adultOrgProposal })).error).toBeNull();
    expect(await ownerOf()).toBe(adult.id);
  });

  // T-DB38
  it('昇格した本人の退会 (P24・S22): 17 歳の子供 (同意 active) を昇格させた本人を auth.admin.deleteUser で消すと、本人の family_members の行は消え、同意の行は member_deleted・family_member_id NULL で残り、監査 parental_consent_revoked (actor_id は NULL) が 1 行。同意の行は署名した親の SELECT で読める。外してから消すと member_removed のまま family_member_id だけ NULL で残り、監査は外したときの 1 行だけ。どちらの退会も error なしで終わる', async () => {
    const family = await createFamily('db38');
    const leaving = await createUser('db38-leaving', { withProfile: false });
    const leavingMember = await promote(family, leaving, yearsAgo(17));
    const leavingConsent = await consentOfMember(leavingMember);
    const { error } = await srAdmin.auth.admin.deleteUser(leaving.id);
    expect(error).toBeNull();
    expect(await memberOf(leavingMember)).toBeNull();
    expect(await consentById(leavingConsent.id)).toMatchObject({ revoked_reason: 'member_deleted', family_member_id: null });
    const deletedAudit = (await auditOf(family.familyId, 'parental_consent_revoked')).filter(
      (a) => a.metadata.consent_id === leavingConsent.id,
    );
    expect(deletedAudit).toHaveLength(1);
    expect(deletedAudit[0].actor_id).toBeNull();
    const parentRead = await asUser(family.rep.jwt).from('parental_consents').select('id, revoked_reason').eq('id', leavingConsent.id);
    expect(parentRead.error).toBeNull();
    expect(parentRead.data).toEqual([{ id: leavingConsent.id, revoked_reason: 'member_deleted' }]);

    const removedFirst = await createUser('db38-removed', { withProfile: false });
    const removedMember = await promote(family, removedFirst, yearsAgo(17));
    const removedConsent = await consentOfMember(removedMember);
    const remove = await asUser(family.rep.jwt).rpc('remove_family_member', { p_family_id: family.familyId, p_member_id: removedMember });
    expect(remove.error).toBeNull();
    const { error: deleteError } = await srAdmin.auth.admin.deleteUser(removedFirst.id);
    expect(deleteError).toBeNull();
    expect(await consentById(removedConsent.id)).toMatchObject({ revoked_reason: 'member_removed', family_member_id: null });
    const removedAudit = (await auditOf(family.familyId, 'parental_consent_revoked')).filter(
      (a) => a.metadata.consent_id === removedConsent.id,
    );
    expect(removedAudit).toHaveLength(1);
    expect(removedAudit[0].metadata).toMatchObject({ reason: 'member_removed' });
  });
});

describe('#1173 関数の ACL', () => {
  // T-DB27
  it('関数の ACL: add_family_child と accept_legal_documents は新しい signature だけ。age_years_jst / parental_consent_active / トリガー関数 2 本はどのロールからも実行不可 (剥がしてもトリガーは動く)。legal_minor_has_guardian_path() は authenticated だけ・SECURITY DEFINER・search_path 空。caller_is_minor_jst() は SECURITY INVOKER・search_path 空・どのロールからも実行不可', async () => {
    const rows = await pgQuery<{
      name: string;
      sig: string;
      secdef: boolean;
      config: string[] | null;
      anon_exec: boolean;
      auth_exec: boolean;
      sr_exec: boolean;
      public_exec: boolean;
    }>(`
      SELECT p.proname AS name,
             p.oid::regprocedure::text AS sig,
             p.prosecdef AS secdef,
             p.proconfig AS config,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr_exec,
             EXISTS (
               SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0
             ) AS public_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN (
        'add_family_child', 'accept_legal_documents', 'age_years_jst', 'parental_consent_active',
        'revoke_parental_consent_on_member_inactive', 'revoke_parental_consent_on_member_delete',
        'legal_minor_has_guardian_path', 'caller_is_minor_jst'
      )
      ORDER BY 2
    `);
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(rows.map((r) => r.sig).sort()).toEqual(
      [
        'accept_legal_documents(text,text,inet,text,date)',
        'add_family_child(uuid,text,jsonb,date,text,text,boolean,inet,text)',
        'age_years_jst(date)',
        'caller_is_minor_jst()',
        'legal_minor_has_guardian_path()',
        'parental_consent_active(uuid)',
        'revoke_parental_consent_on_member_delete()',
        'revoke_parental_consent_on_member_inactive()',
      ].sort(),
    );
    for (const row of rows) {
      expect(row.anon_exec, row.sig).toBe(false);
      expect(row.public_exec, row.sig).toBe(false);
    }
    expect(byName.get('add_family_child')).toMatchObject({ auth_exec: true, sr_exec: true, secdef: true });
    expect(byName.get('accept_legal_documents')).toMatchObject({ auth_exec: true, sr_exec: false, secdef: true });
    for (const name of ['age_years_jst', 'parental_consent_active', 'revoke_parental_consent_on_member_inactive', 'revoke_parental_consent_on_member_delete', 'caller_is_minor_jst']) {
      expect(byName.get(name), name).toMatchObject({ auth_exec: false, sr_exec: false });
    }
    for (const name of ['parental_consent_active', 'revoke_parental_consent_on_member_inactive', 'revoke_parental_consent_on_member_delete']) {
      expect(byName.get(name)?.secdef, name).toBe(true);
    }
    expect(byName.get('legal_minor_has_guardian_path')).toMatchObject({ auth_exec: true, sr_exec: false, secdef: true });
    expect(byName.get('legal_minor_has_guardian_path')?.config).toEqual(['search_path=""']);
    expect(byName.get('caller_is_minor_jst')).toMatchObject({ secdef: false });
    expect(byName.get('caller_is_minor_jst')?.config).toEqual(['search_path=""']);

    // 剥がしてもトリガーは動く (取り消し・削除の後の失効は T-DB19・T-DB20 が確かめる。ここでは 1 回だけ)
    const family = await createFamily('db27');
    const child = await addChild(family.rep, family.familyId, 'db27-child');
    const { error } = await asUser(family.rep.jwt).rpc('remove_family_member', { p_family_id: family.familyId, p_member_id: child });
    expect(error).toBeNull();
    expect((await consentOfMember(child)).revoked_reason).toBe('member_removed');
    // クライアントからは age_years_jst / caller_is_minor_jst を直接呼べない
    for (const [fn, args] of [
      ['age_years_jst', { p_birth_date: ADULT_BIRTH_DATE }],
      ['caller_is_minor_jst', {}],
      ['parental_consent_active', { p_member_id: child }],
    ] as const) {
      const call = await asUser(family.rep.jwt).rpc(fn, args);
      expect(call.error?.code, fn).toBe('42501');
    }
  });
});
