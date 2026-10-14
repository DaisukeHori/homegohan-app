/**
 * #1175 auth.users を指す外部キーの ON DELETE (退会が外部キーで失敗しないこと) の回帰テスト
 *
 * 問題: auth.users を指す外部キーのうち 33 本は ON DELETE の指定が無く (= NO ACTION)、参照する行が 1 つでも残っていると
 * auth.admin.deleteUser が外部キー違反 (23503) で失敗した。退会 API は 11 テーブルだけを事前に掃除していて、
 * support_tickets / email_delivery_logs / coupon_redemptions / nps_surveys / gdpr_deletion_requests などが漏れていた。
 * 修正: migration 20261010000100_auth_users_fk_on_delete.sql が、本人だけの記録は CASCADE、サポート・会計・運営者の参照は
 * SET NULL (列を NULL を許す形にして) に張り直し、重複していた admin_audit_logs_admin_id_fkey を外した。
 *
 * 確認すること (DB のカタログ。データは作らない。実際に退会して消えること・残ることは account-deletion.test.ts):
 *   A. auth.users を指す外部キーに NO ACTION が 1 本も無い (許可リストは空。足すときは理由を書く)
 *   B. RESTRICT は「組織のオーナー」と「家族の代表者」の 2 本だけ (退会 API が先に 409 で止める仕様)
 *   C. SET NULL の外部キーの列はすべて NULL を許す (NOT NULL のままだと、退会が 23502 で失敗する)
 *   D. 張り直した 32 本が、決めたとおりの動作 (CASCADE / SET NULL) になっている。admin_audit_logs の actor_id を指す外部キーは 1 本だけ
 *   E. 退会で消える表 (auth.users と、prepare_account_deletion が直接 DELETE する表から、CASCADE でたどれる表) を指す
 *      NO ACTION / RESTRICT の外部キーは、同じ削除で一緒に消える行からだけ参照されている (許可リスト)。
 *      同じ表を指す SET NULL の外部キーの列は NULL を許す (NOT NULL のままだと、退会が 23502 で失敗する)
 *   F. coupon_redemptions の CHECK は anonymized_at で緩めてある。トリガーが user_id を外す更新で anonymized_at を入れる
 *   G. prepare_account_deletion は service_role だけが実行できる (トリガー関数 coupon_redemptions_mark_anonymized は誰にも直接実行させない)
 *   H. メールアドレスらしい列 (列名に mail を含む) が、退会時の扱いを決めた一覧と一致する (新しい列を足したら扱いを決める)
 *
 * 修正前 (migration を流す前) に流すと A・D・F・G が失敗する。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/auth-users-fk-on-delete.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
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

function client(key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

const srAdmin = client(serviceKey);

/** ローカルスタックの postgres-meta で SQL を実行する (カタログの読み取りと、テスト用の行の作成・削除にだけ使う) */
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

interface AuthUsersFk {
  schema: string;
  table: string;
  column: string;
  constraint: string;
  action: 'a' | 'r' | 'c' | 'n' | 'd';
  not_null: boolean;
}

const ACTION_NAME: Record<AuthUsersFk['action'], string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

/** auth.users を指す外部キー (auth スキーマ自身 = Supabase Auth の内部テーブルを除く) */
async function authUsersForeignKeys(): Promise<AuthUsersFk[]> {
  return pgQuery<AuthUsersFk>(`
    select n.nspname as schema, c.relname as "table", a.attname as "column", con.conname as "constraint",
           con.confdeltype as action, a.attnotnull as not_null
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class c on c.oid = con.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join lateral unnest(con.conkey) as k(attnum)
    join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
    where con.contype = 'f'
      and con.confrelid = 'auth.users'::regclass
      and n.nspname <> 'auth'
    order by 1, 2, 3, 4
  `);
}

const keyOf = (fk: { schema?: string; table: string; column: string }) => `${fk.table}.${fk.column}`;

/**
 * NO ACTION のままにしてよい外部キー。「表.列」→ 理由。
 * 今は空: NO ACTION の外部キーは、参照する行が残っていると退会 (auth.admin.deleteUser) を止める。
 * 足すときは、退会 API (src/lib/account-deletion.ts) が先に必ず片付ける理由を書くこと。
 */
const NO_ACTION_ALLOWLIST: Readonly<Record<string, string>> = {};

/** RESTRICT のままにしてよい外部キー。退会 API が先に 409 (譲渡か解散が先) で止める */
const RESTRICT_ALLOWLIST: Readonly<Record<string, string>> = {
  'organizations.owner_id': '組織のオーナーは、譲渡か解散をしないと退会できない (ACCOUNT_DELETE_BLOCKED_ORG_OWNER)',
  'family_groups.representative_id':
    '家族グループの代表者は、譲渡か解散をしないと退会できない (ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE)',
};

/** #1175 で張り直した 32 本の、決めた動作 */
const EXPECTED_ACTIONS: Readonly<Record<string, 'CASCADE' | 'SET NULL'>> = {
  // 本人だけの記録は本人と一緒に消す
  'nps_surveys.user_id': 'CASCADE',
  'csat_feedbacks.user_id': 'CASCADE',
  'experiment_assignments.user_id': 'CASCADE',
  'ai_content_logs.user_id': 'CASCADE',
  // サポート・会計のために残す記録は、行を残して本人との紐づけだけ外す
  'support_tickets.user_id': 'SET NULL',
  'support_ticket_messages.sender_id': 'SET NULL',
  'coupon_redemptions.user_id': 'SET NULL',
  'referral_rewards.referrer_id': 'SET NULL',
  'referral_rewards.referred_id': 'SET NULL',
  'gdpr_deletion_requests.user_id': 'SET NULL',
  'email_delivery_logs.user_id': 'SET NULL',
  // 運営者・作成者・承認者などの参照は、記録を残して紐づけだけ外す
  'admin_user_notes.admin_id': 'SET NULL',
  'announcements.created_by': 'SET NULL',
  'coupon_redemptions.approved_by': 'SET NULL',
  'coupons.created_by': 'SET NULL',
  'departments.manager_id': 'SET NULL',
  'email_blacklist.added_by': 'SET NULL',
  'experiments.created_by': 'SET NULL',
  'gdpr_deletion_requests.executed_by': 'SET NULL',
  'help_articles.created_by': 'SET NULL',
  'infra_alerts.ack_by': 'SET NULL',
  'moderation_flags.resolved_by': 'SET NULL',
  'organization_challenges.created_by': 'SET NULL',
  'organization_invites.created_by': 'SET NULL',
  'plan_price_history.changed_by': 'SET NULL',
  'recipe_flags.reporter_id': 'SET NULL',
  'recipe_flags.reviewed_by': 'SET NULL',
  'sales_lead_activities.actor_id': 'SET NULL',
  'sales_leads.assigned_to': 'SET NULL',
  'support_tickets.assignee_id': 'SET NULL',
  'system_settings.updated_by': 'SET NULL',
  'user_profiles.frozen_by': 'SET NULL',
};

let fks: AuthUsersFk[];

beforeAll(async () => {
  fks = await authUsersForeignKeys();
  // カタログの取り出しが空振りしていないこと
  expect(fks.length).toBeGreaterThan(80);
}, 30_000);

describe('#1175 A. NO ACTION の外部キーが無い', () => {
  it('auth.users を指す外部キーに NO ACTION が無い (許可リスト以外)', () => {
    const noAction = fks.filter((fk) => fk.action === 'a').map((fk) => `${keyOf(fk)} (${fk.constraint})`);
    const allowed = Object.keys(NO_ACTION_ALLOWLIST);
    const unexpected = fks.filter((fk) => fk.action === 'a' && !allowed.includes(keyOf(fk))).map((fk) => `${keyOf(fk)} (${fk.constraint})`);
    expect(unexpected, `NO ACTION の外部キー: ${noAction.join(', ')}`).toEqual([]);
  });

  it('許可リストは実在する NO ACTION の外部キーだけを指している (残骸が無い)', () => {
    const noActionKeys = new Set(fks.filter((fk) => fk.action === 'a').map(keyOf));
    expect(Object.keys(NO_ACTION_ALLOWLIST).filter((key) => !noActionKeys.has(key))).toEqual([]);
  });

  it('SET DEFAULT の外部キーは無い (退会後に別の行を指すようになってしまう)', () => {
    expect(fks.filter((fk) => fk.action === 'd').map(keyOf)).toEqual([]);
  });
});

describe('#1175 B. RESTRICT は組織のオーナーと家族の代表者だけ', () => {
  it('RESTRICT の外部キーは許可リストと一致する', () => {
    const restrict = fks.filter((fk) => fk.action === 'r').map(keyOf).sort();
    expect(restrict).toEqual(Object.keys(RESTRICT_ALLOWLIST).sort());
  });
});

describe('#1175 C. SET NULL の外部キーの列は NULL を許す', () => {
  it('SET NULL の列に NOT NULL が残っていない (残っていると退会が 23502 で失敗する)', () => {
    const notNull = fks.filter((fk) => fk.action === 'n' && fk.not_null).map(keyOf);
    expect(notNull).toEqual([]);
  });
});

describe('#1175 D. 張り直した外部キーの動作', () => {
  for (const [key, expected] of Object.entries(EXPECTED_ACTIONS)) {
    it(`${key} は ON DELETE ${expected}`, () => {
      const [table, column] = key.split('.');
      const found = fks.filter((fk) => fk.table === table && fk.column === column);
      expect(found.length, `${key} の外部キーが見つからない`).toBeGreaterThan(0);
      for (const fk of found) {
        expect(ACTION_NAME[fk.action], `${fk.constraint}`).toBe(expected);
      }
    });
  }

  it('admin_audit_logs の actor_id を指す外部キーは 1 本だけ (重複していた NO ACTION の admin_id_fkey が無い)', () => {
    const onActor = fks.filter((fk) => fk.table === 'admin_audit_logs' && fk.column === 'actor_id');
    expect(onActor.map((fk) => fk.constraint)).toEqual(['admin_audit_logs_actor_id_fkey']);
    expect(ACTION_NAME[onActor[0].action]).toBe('SET NULL');
  });
});

describe('#1175 E. CASCADE の連鎖の中の NO ACTION / SET NULL', () => {
  /**
   * 退会で消える表 (削除の起点から CASCADE でたどれる表) を指す外部キーのうち、NO ACTION / RESTRICT のもの。
   * 参照する行も同じ削除の連鎖で一緒に消えるので、退会は止まらない (account-deletion.test.ts で実際に確かめる)。
   * 新しく増えたときは、参照する行が同じ連鎖で消えるかを確かめてから足すこと。
   */
  const CASCADE_CHAIN_ALLOWLIST: Readonly<Record<string, string>> = {
    'ai_action_logs.message_id': 'ai_consultation_messages を指す。ai_action_logs も ai_consultation_sessions の連鎖で一緒に消える',
    'shopping_list_requests.shopping_list_id': 'shopping_lists を指す。shopping_list_requests も user_id の CASCADE で一緒に消える',
  };

  /**
   * prepare_account_deletion が退会の直前に直接 DELETE する表 (auth.users のほかの、削除の起点)。
   * 関数の定義 (pg_get_functiondef) から読み取る。関数に DELETE を足すと、ここに自動で入り、下の検査の起点になる。
   * 退会の連鎖は auth.users だけから始まるわけではない: 本人の非公開レシピ (recipes) は auth.users から CASCADE でたどれない
   * (recipes.user_id は SET NULL) が、prepare_account_deletion が消す。recipes やその子を NO ACTION で指す外部キーが
   * 足されると、prepare が失敗して退会できなくなる。
   */
  async function prepareDeletionRoots(): Promise<string[]> {
    const rows = await pgQuery<{ def: string }>(`
      select pg_catalog.pg_get_functiondef('public.prepare_account_deletion(uuid)'::regprocedure) as def
    `);
    expect(rows).toHaveLength(1);
    const roots = new Set<string>();
    for (const match of rows[0].def.matchAll(/delete\s+from\s+(?:only\s+)?public\.("?)(\w+)\1/gi)) {
      roots.add(`public.${match[2]}`);
    }
    return [...roots].sort();
  }

  /** 削除の起点 (auth.users と prepare_account_deletion が DELETE する表) から CASCADE でたどれる表を chain に持つ CTE */
  function chainCte(roots: readonly string[]): string {
    const rootOids = ['auth.users', ...roots].map((rel) => `'${rel}'::regclass::oid`).join(', ');
    return `
      with recursive chain(rel) as (
        select unnest(array[${rootOids}])
        union
        select c.conrelid
        from pg_catalog.pg_constraint c
        join chain on c.confrelid = chain.rel
        where c.contype = 'f' and c.confdeltype = 'c'
      )`;
  }

  it('prepare_account_deletion が直接消す表は public.recipes だけ (増えたら、下の検査の起点に自動で入る)', async () => {
    // 読み取りの正規表現が何も拾わなくなった (関数の書き方が変わった) ときに、起点が黙って auth.users だけに戻らないための確認
    expect(await prepareDeletionRoots()).toEqual(['public.recipes']);
  });

  it('退会で消える表を指す NO ACTION / RESTRICT の外部キーは、許可リストだけ', async () => {
    const roots = await prepareDeletionRoots();
    const rows = await pgQuery<{ table: string; column: string; constraint: string }>(`
      ${chainCte(roots)}
      select distinct cl.relname as "table", a.attname as "column", c.conname as "constraint"
      from pg_catalog.pg_constraint c
      join chain on c.confrelid = chain.rel
      join pg_catalog.pg_class cl on cl.oid = c.conrelid
      join pg_catalog.pg_namespace n on n.oid = cl.relnamespace
      cross join lateral unnest(c.conkey) as k(attnum)
      join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.contype = 'f' and c.confdeltype in ('a', 'r')
        and chain.rel <> 'auth.users'::regclass::oid
        and n.nspname = 'public'
      order by 1, 2
    `);
    const found = rows.map((row) => `${row.table}.${row.column}`);
    expect(found.sort()).toEqual(Object.keys(CASCADE_CHAIN_ALLOWLIST).sort());
  });

  it('退会で消える表を指す SET NULL の外部キーの列は、すべて NULL を許す', async () => {
    // auth.users を直接指すものは C が見る。ここはその先 (連鎖で消える表と、prepare_account_deletion が消す表) を見る
    const roots = await prepareDeletionRoots();
    const rows = await pgQuery<{ table: string; column: string; constraint: string }>(`
      ${chainCte(roots)}
      select distinct cl.relname as "table", a.attname as "column", c.conname as "constraint"
      from pg_catalog.pg_constraint c
      join chain on c.confrelid = chain.rel
      join pg_catalog.pg_class cl on cl.oid = c.conrelid
      cross join lateral unnest(c.conkey) as k(attnum)
      join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.contype = 'f' and c.confdeltype = 'n'
        and chain.rel <> 'auth.users'::regclass::oid
        and a.attnotnull
      order by 1, 2
    `);
    expect(rows.map((row) => `${row.table}.${row.column} (${row.constraint})`)).toEqual([]);
  });
});

describe('#1175 F. coupon_redemptions の CHECK と anonymized_at', () => {
  const RUN = randomUUID().slice(0, 8);
  const createdCouponIds: string[] = [];
  const createdRedemptionIds: string[] = [];
  let userId: string;

  beforeAll(async () => {
    const { data, error } = await srAdmin.auth.admin.createUser({
      email: `fk-on-delete-${RUN}@homegohan.test`,
      password: `Pw-${randomUUID()}-Aa1!`,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
    userId = data.user.id;
  }, 30_000);

  afterAll(async () => {
    if (createdRedemptionIds.length > 0) {
      await pgQuery(`delete from public.coupon_redemptions where id in (${createdRedemptionIds.map((id) => `'${id}'`).join(',')})`);
    }
    if (createdCouponIds.length > 0) {
      await pgQuery(`delete from public.coupons where id in (${createdCouponIds.map((id) => `'${id}'`).join(',')})`);
    }
    await srAdmin.auth.admin.deleteUser(userId);
  }, 30_000);

  async function newCoupon(): Promise<string> {
    const id = randomUUID();
    createdCouponIds.push(id);
    await pgQuery(`
      insert into public.coupons (id, code, discount_type, discount_value, valid_from, valid_until, created_by)
      values ('${id}', 'FK-${RUN}-${id.slice(0, 6)}', 'fixed', 100, now(), now() + interval '1 day', null)
    `);
    return id;
  }

  async function insertRedemption(couponId: string, columns: string, values: string): Promise<string> {
    const id = randomUUID();
    createdRedemptionIds.push(id);
    await pgQuery(`
      insert into public.coupon_redemptions (id, coupon_id, subscription_target, applied_to_subscription_id, discount_amount_jpy, ${columns})
      values ('${id}', '${couponId}', 'personal', '${randomUUID()}', 100, ${values})
    `);
    return id;
  }

  it('coupons.created_by は NULL を許す (運営者が退会しても行を残せる)', async () => {
    const couponId = await newCoupon();
    const rows = await pgQuery<{ created_by: string | null }>(`select created_by from public.coupons where id = '${couponId}'`);
    expect(rows[0].created_by).toBeNull();
  });

  it('user_id も organization_id も anonymized_at も無い行は CHECK に拒否される (従来どおり)', async () => {
    const couponId = await newCoupon();
    await expect(insertRedemption(couponId, 'user_id', 'null')).rejects.toThrow(/coupon_redemptions_user_or_org|check/i);
  });

  it('anonymized_at がある行は user_id も organization_id も無くてよい', async () => {
    const couponId = await newCoupon();
    const id = await insertRedemption(couponId, 'user_id, anonymized_at', 'null, now()');
    const rows = await pgQuery<{ user_id: string | null; anonymized_at: string | null }>(
      `select user_id, anonymized_at from public.coupon_redemptions where id = '${id}'`,
    );
    expect(rows[0].user_id).toBeNull();
    expect(rows[0].anonymized_at).not.toBeNull();
  });

  it('user_id を NOT NULL → NULL にする更新で、トリガーが anonymized_at を入れる (CHECK に当たらない)', async () => {
    const couponId = await newCoupon();
    const id = await insertRedemption(couponId, 'user_id', `'${userId}'`);
    const before = await pgQuery<{ anonymized_at: string | null }>(`select anonymized_at from public.coupon_redemptions where id = '${id}'`);
    expect(before[0].anonymized_at).toBeNull();

    await pgQuery(`update public.coupon_redemptions set user_id = null where id = '${id}'`);
    const after = await pgQuery<{ user_id: string | null; anonymized_at: string | null }>(
      `select user_id, anonymized_at from public.coupon_redemptions where id = '${id}'`,
    );
    expect(after[0].user_id).toBeNull();
    expect(after[0].anonymized_at).not.toBeNull();
  });

  it('user_id を変えない更新では anonymized_at を触らない', async () => {
    const couponId = await newCoupon();
    const id = await insertRedemption(couponId, 'user_id', `'${userId}'`);
    await pgQuery(`update public.coupon_redemptions set discount_amount_jpy = 200 where id = '${id}'`);
    const rows = await pgQuery<{ anonymized_at: string | null }>(`select anonymized_at from public.coupon_redemptions where id = '${id}'`);
    expect(rows[0].anonymized_at).toBeNull();
  });
});

describe('#1175 G. prepare_account_deletion の実行権限', () => {
  it('service_role だけが実行できる (PUBLIC / anon / authenticated は実行できない)', async () => {
    const rows = await pgQuery<{ role: string; allowed: boolean }>(`
      select r.role, has_function_privilege(r.role, 'public.prepare_account_deletion(uuid)', 'EXECUTE') as allowed
      from (values ('anon'), ('authenticated'), ('service_role')) as r(role)
      order by r.role
    `);
    expect(Object.fromEntries(rows.map((row) => [row.role, row.allowed]))).toEqual({
      anon: false,
      authenticated: false,
      service_role: true,
    });

    const publicGrant = await pgQuery<{ has_public: boolean }>(`
      select exists (
        select 1 from pg_catalog.pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
        where p.oid = 'public.prepare_account_deletion(uuid)'::regprocedure and acl.grantee = 0
      ) as has_public
    `);
    expect(publicGrant[0].has_public).toBe(false);
  });

  it('トリガー関数 coupon_redemptions_mark_anonymized は、誰にも直接実行させない (PUBLIC / anon / authenticated / service_role に EXECUTE が無い)', async () => {
    const rows = await pgQuery<{ role: string; allowed: boolean }>(`
      select r.role, has_function_privilege(r.role, 'public.coupon_redemptions_mark_anonymized()', 'EXECUTE') as allowed
      from (values ('anon'), ('authenticated'), ('service_role')) as r(role)
      order by r.role
    `);
    expect(Object.fromEntries(rows.map((row) => [row.role, row.allowed]))).toEqual({
      anon: false,
      authenticated: false,
      service_role: false,
    });

    const publicGrant = await pgQuery<{ has_public: boolean }>(`
      select exists (
        select 1 from pg_catalog.pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
        where p.oid = 'public.coupon_redemptions_mark_anonymized()'::regprocedure and acl.grantee = 0
      ) as has_public
    `);
    expect(publicGrant[0].has_public).toBe(false);
  });

  it('SECURITY DEFINER で、search_path が空に固定されている', async () => {
    const rows = await pgQuery<{ prosecdef: boolean; proconfig: string[] | null }>(`
      select prosecdef, proconfig from pg_catalog.pg_proc where oid = 'public.prepare_account_deletion(uuid)'::regprocedure
    `);
    expect(rows[0].prosecdef).toBe(true);
    expect(rows[0].proconfig).toContain('search_path=""');
  });

  it('anon のキーで RPC を呼ぶと拒否される', async () => {
    const { error } = await client(anonKey).rpc('prepare_account_deletion', { p_user_id: randomUUID() });
    expect(error).not.toBeNull();
  });
});

describe('#1175 H. メールアドレスを持つ列の棚卸し', () => {
  /**
   * 退会しても行が残る表に、本人の生のメールアドレスが残らないようにする (prepare_account_deletion が伏せる)。
   * public の「メールアドレスらしい列」(列名に mail を含む) を全部ここに挙げ、退会時の扱いを決めてある。
   * 新しくメールアドレスの列を足したら、退会のときにどうするか (伏せる / 行ごと消える / 伏せない理由) を決めて、ここに足すこと。
   */
  const EMAIL_COLUMNS: Readonly<Record<string, string>> = {
    // prepare_account_deletion が伏せる (account-deletion.test.ts で確かめる)
    'email_delivery_logs.email': '伏せる (メール配信ログ。行は残す)',
    'inquiries.email': '伏せる (問い合わせ。行は残す)',
    'organization_invites.email': '伏せる (pending は revoked にする)',
    'family_invites.email': '伏せる (pending は revoked にする)',
    'family_promotion_requests.email': '伏せる (pending は revoked にする)',
    // 伏せない (理由つき)
    'email_blacklist.email': '伏せない。苦情・バウンスのあったアドレスへ二度と送らないための記録で、消すと再び送ってしまう',
    'admin_audit_logs.actor_email_snapshot':
      '伏せない。運営者が何をしたかを監査のために残す記録 (運営者が退会しても、誰の操作かを追えるようにする)',
    'organizations.contact_email': '利用者個人ではなく組織の連絡先 (オーナーは譲渡か解散をしないと退会できない)',
    'sales_leads.contact_email': '営業先の企業の連絡先で、アプリの利用者のものではない',
    'auth_login_failures.email_hash':
      '伏せない。生のメールアドレスではなく SHA-256 のハッシュで、行が持つのはログインの連続失敗の回数とロックの期限だけ (#1165)。' +
      'アカウントの無いメールアドレスも同じように数える表で、アカウントとは結び付けていない',
  };

  it('メールアドレスらしい列が、決めた一覧と一致する (新しい列を足したら退会時の扱いを決める)', async () => {
    const rows = await pgQuery<{ table: string; column: string }>(`
      select c.relname as "table", a.attname as "column"
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and a.attnum > 0 and not a.attisdropped
        and a.attname ~* 'mail'
      order by 1, 2
    `);
    expect(rows.map((row) => `${row.table}.${row.column}`).sort()).toEqual(Object.keys(EMAIL_COLUMNS).sort());
  });
});
