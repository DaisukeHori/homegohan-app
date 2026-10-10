/**
 * #1175 退会 (deleteAccount = POST /api/account/delete の本体) の結合テスト
 *
 * 外部キーに「ON DELETE の指定が無い」(NO ACTION) 表に行がある利用者・運営者は、auth.admin.deleteUser が外部キー違反 (23503) で
 * 失敗していた。migration 20261010000100_auth_users_fk_on_delete.sql と src/lib/account-deletion.ts で直した。
 *
 * このテストは、本物のローカル Supabase (DB・Auth・Storage) に対して次を確かめる:
 *   A. 外部キーのある全ての表 (NO ACTION だった 28 テーブル + SET NULL / CASCADE の主な表) に行を作ってから、
 *      - 運営者 (staff) を素の auth.admin.deleteUser で消せる (参照する行は SET NULL で残る)
 *      - 利用者 (subject) を deleteAccount で退会できる
 *   B. 退会後: 本人だけの記録は消え (CASCADE)、サポート・会計の記録は行が残って本人との紐づけが NULL になる。
 *      匿名化した償還記録 (coupon_redemptions) は anonymized_at が入る。
 *      本人の非公開レシピは消える (recipes.user_id が NULL の行は RLS で全員に見えるため。公開レシピは user_id だけが外れて残る)
 *   C. 退会後: 本人の生のメールアドレスが、メール配信ログ・問い合わせ・招待に残っていない。他の人の行は変わらない。
 *      pending の招待は revoked になる。ログ (app_logs) にメールアドレスは載らない
 *   D. Storage: 3 バケットの <user_id>/ 以下、旧パス、URL が指す本人の献立の画像が消える。
 *      他人のファイル (自分の行の URL で指されていても) と、持ち主がパスから分からない旧ファイルは消えない
 *   E. 組織のオーナー・家族の代表者は 409 で止まり、何も消えない・伏せられない
 *   F. もう一度退会を実行しても成功する (やり直せる)
 *
 * 修正前 (migration を流す前) に流すと、staff / subject の削除が外部キー違反で失敗し、prepare_account_deletion も無いため
 * A〜D が失敗する。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/account-deletion.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import { deleteAccount } from '../../../src/lib/account-deletion';

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

/** ローカルスタックの postgres-meta で SQL を実行する (テスト用の行の作成・確認・後片付けにだけ使う) */
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
const id = () => randomUUID();

const RUN = randomBytes(4).toString('hex');
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
/** 生のメールアドレスが残っていないかを調べるための、この実行だけの目印を含むアドレス */
const emailOf = (label: string) => `t11-${label}-${RUN}@homegohan.test`;

const MASKED_EMAIL = 'redacted@redacted.invalid';

const createdUserIds: string[] = [];

/** 後片付けの対象から外す (すでに消したユーザー) */
function forget(userId: string): void {
  const index = createdUserIds.indexOf(userId);
  if (index >= 0) createdUserIds.splice(index, 1);
}

async function createUser(label: string): Promise<{ id: string; email: string }> {
  const email = emailOf(label);
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `t11-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  return { id: data.user.id, email };
}

function tinyPng(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

/** Storage にファイルを置く (service_role) */
async function putObject(bucket: string, path: string): Promise<void> {
  const { error } = await srAdmin.storage.from(bucket).upload(path, tinyPng(), { contentType: 'image/png', upsert: true });
  if (error) throw new Error(`upload ${bucket}/${path}: ${error.message}`);
}

/** フォルダ直下 (サブフォルダ含む) のオブジェクトの名前を再帰的に集める */
async function listAll(bucket: string, prefix: string): Promise<string[]> {
  const { data, error } = await srAdmin.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
  const out: string[] = [];
  for (const entry of data ?? []) {
    if (entry.id == null) out.push(...(await listAll(bucket, `${prefix}/${entry.name}`)));
    else out.push(`${prefix}/${entry.name}`);
  }
  return out;
}

async function exists(bucket: string, path: string): Promise<boolean> {
  const slash = path.lastIndexOf('/');
  const folder = slash >= 0 ? path.slice(0, slash) : '';
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const { data, error } = await srAdmin.storage.from(bucket).list(folder, { limit: 1000, search: name });
  if (error) throw new Error(`exists ${bucket}/${path}: ${error.message}`);
  return (data ?? []).some((entry) => entry.name === name && entry.id != null);
}

const publicUrl = (bucket: string, path: string) => srAdmin.storage.from(bucket).getPublicUrl(path).data.publicUrl;

async function count(table: string, where: string): Promise<number> {
  const rows = await pgQuery<{ n: number }>(`select count(*)::int as n from public.${table} where ${where}`);
  return rows[0].n;
}

async function one<T = Record<string, unknown>>(sql: string): Promise<T | undefined> {
  return (await pgQuery<T>(sql))[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// 登場人物と、作る行の ID
// ─────────────────────────────────────────────────────────────────────────────
let S: { id: string; email: string }; // 退会する利用者
let T: { id: string; email: string }; // 退会する運営者 (素の deleteUser で消す)
let B: { id: string; email: string }; // 残る利用者 (組織のオーナー・家族の代表者。比較用の行も持つ)

const rows = {
  org: id(),
  dept: id(),
  challenge: id(),
  orgInviteToS: id(),
  orgInviteAcceptedByS: id(),
  orgInviteToB: id(),
  fg: id(),
  fmB: id(),
  fmS: id(),
  fmChild: id(),
  fmChild2: id(),
  famInviteToS: id(),
  famInviteToB: id(),
  promoToS: id(),
  promoToB: id(),
  ticket: id(),
  msgFromS: id(),
  msgFromT: id(),
  csat: id(),
  nps: id(),
  exp: id(),
  coupon: id(),
  redemptionUser: id(),
  redemptionUserOrg: id(),
  rewardAsReferrer: id(),
  rewardAsReferred: id(),
  gdpr: id(),
  logOfS: id(),
  logOfSByAddress: id(),
  logOfB: id(),
  inquiryOfS: id(),
  inquiryOfSByAddress: id(),
  inquiryOfB: id(),
  aiLog: id(),
  recipeOfS: id(),
  recipePublicOfS: id(),
  recipeOfB: id(),
  recipeFlag: id(),
  /** 他人 (B) が S の非公開レシピに付けた通報。prepare_account_deletion がレシピを消すと、CASCADE で一緒に消える */
  recipeFlagOnPrivateOfS: id(),
  mealOfB: id(),
  moderationFlag: id(),
  noteOnS: id(),
  noteOnB: id(),
  announcement: id(),
  help: id(),
  alert: id(),
  lead: id(),
  leadActivity: id(),
  priceHistory: id(),
  auditLog: id(),
  mealOfS: id(),
  mealWithForeignPhoto: id(),
  mealWithForeignGenerated: id(),
  daily: id(),
  dailyOfB: id(),
  planned: id(),
  plannedForeign: id(),
  job: id(),
  weeklyRequest: id(),
  checkup: id(),
  bloodTest: id(),
  session: id(),
  message: id(),
  actionLog: id(),
  shoppingList: id(),
  shoppingRequest: id(),
};
const settingKey = `t11-${RUN}`;
const experimentKey = `t11-exp-${RUN}`;
const blacklistEmail = `t11-blacklist-${RUN}@homegohan.test`;
const FUNCTION_NAME = `t11-seed-${RUN}`;

/** Storage に置いたファイル。subject の退会で消えるもの / 残るもの */
const objects = {
  // 消える
  fridgeCurrent: ['fridge-images', () => `${S.id}/fridge/a-${RUN}.png`],
  fridgeNested: ['fridge-images', () => `${S.id}/generated/deep/b-${RUN}.png`],
  fridgeLegacyMeals: ['fridge-images', () => `meals/${S.id}/legacy-${RUN}.png`],
  fridgeLegacyGenerated: ['fridge-images', () => `generated/${S.id}/legacy-${RUN}.png`],
  mealPhotos: ['meal_photos', () => `${S.id}/photo-${RUN}.png`],
  checkup: ['health-checkups', () => `${S.id}/checkup-${RUN}.png`],
  checkupOldLayout: ['health-checkups', () => `old/${S.id}/checkup-${RUN}.png`],
  generatedForMeal: ['fridge-images', () => `generated/${rows.planned}/job-${RUN}.png`],
  // 残る
  othersFile: ['fridge-images', () => `${B.id}/keep-${RUN}.png`],
  othersLegacy: ['fridge-images', () => `meals/${B.id}/keep-${RUN}.png`],
  unownedGenerated: ['fridge-images', () => `generated/${rows.plannedForeign}/other-${RUN}.png`],
  rootLevel: ['fridge-images', () => `${RUN}-root.png`],
} as const;
type ObjectKey = keyof typeof objects;
const objectPath = (key: ObjectKey) => (objects[key][1] as () => string)();
const objectBucket = (key: ObjectKey) => objects[key][0] as string;
const REMOVED: ObjectKey[] = [
  'fridgeCurrent',
  'fridgeNested',
  'fridgeLegacyMeals',
  'fridgeLegacyGenerated',
  'mealPhotos',
  'checkup',
  'checkupOldLayout',
  'generatedForMeal',
];
const KEPT: ObjectKey[] = ['othersFile', 'othersLegacy', 'unownedGenerated', 'rootLevel'];

// ─────────────────────────────────────────────────────────────────────────────
// テストデータ (外部キーのある表に行を作る)
// ─────────────────────────────────────────────────────────────────────────────
async function seedOrgAndFamily(): Promise<void> {
  await pgQuery(`
    insert into public.organizations (id, name, owner_id) values (${q(rows.org)}, ${q(`t11 org ${RUN}`)}, ${q(B.id)});
    insert into public.departments (id, organization_id, name, manager_id) values (${q(rows.dept)}, ${q(rows.org)}, 't11 dept', ${q(T.id)});
    insert into public.organization_challenges (id, organization_id, title, challenge_type, start_date, end_date, created_by)
      values (${q(rows.challenge)}, ${q(rows.org)}, 't11 challenge', 'custom', current_date, current_date + 1, ${q(T.id)});
    insert into public.organization_invites (id, organization_id, email, token, expires_at, status, created_by, invited_by) values
      (${q(rows.orgInviteToS)}, ${q(rows.org)}, ${q(S.email)}, ${q(`tok-${id()}`)}, now() + interval '7 days', 'pending', ${q(T.id)}, ${q(T.id)}),
      (${q(rows.orgInviteToB)}, ${q(rows.org)}, ${q(B.email)}, ${q(`tok-${id()}`)}, now() + interval '7 days', 'pending', ${q(T.id)}, ${q(T.id)});
    insert into public.organization_invites (id, organization_id, email, token, expires_at, status, accepted_by, accepted_at)
      values (${q(rows.orgInviteAcceptedByS)}, ${q(rows.org)}, ${q(emailOf('someone-else'))}, ${q(`tok-${id()}`)}, now() + interval '7 days', 'accepted', ${q(S.id)}, now());

    insert into public.family_groups (id, name, representative_id) values (${q(rows.fg)}, 't11 family', ${q(B.id)});
    insert into public.family_members (id, family_id, user_id, role) values
      (${q(rows.fmB)}, ${q(rows.fg)}, ${q(B.id)}, 'representative'),
      (${q(rows.fmS)}, ${q(rows.fg)}, ${q(S.id)}, 'adult');
    insert into public.family_members (id, family_id, role, display_name, child_profile) values
      (${q(rows.fmChild)}, ${q(rows.fg)}, 'child', 't11 child', '{}'::jsonb),
      (${q(rows.fmChild2)}, ${q(rows.fg)}, 'child', 't11 child 2', '{}'::jsonb);
    insert into public.family_invites (id, family_id, email, token, expires_at, status, invited_by) values
      (${q(rows.famInviteToS)}, ${q(rows.fg)}, ${q(S.email)}, ${q(`tok-${id()}`)}, now() + interval '7 days', 'pending', ${q(B.id)}),
      (${q(rows.famInviteToB)}, ${q(rows.fg)}, ${q(B.email)}, ${q(`tok-${id()}`)}, now() + interval '7 days', 'pending', ${q(B.id)});
    insert into public.family_promotion_requests (id, family_id, member_id, email, token, requested_by) values
      (${q(rows.promoToS)}, ${q(rows.fg)}, ${q(rows.fmChild)}, ${q(S.email)}, ${q(`tok-${id()}`)}, ${q(B.id)}),
      (${q(rows.promoToB)}, ${q(rows.fg)}, ${q(rows.fmChild2)}, ${q(B.email)}, ${q(`tok-${id()}`)}, ${q(B.id)});
  `);
}

async function seedSupportAndBilling(): Promise<void> {
  const plan = await one<{ id: string }>(`select id from public.subscription_plans order by plan_key limit 1`);
  if (!plan) throw new Error('subscription_plans に行が無い');
  await pgQuery(`
    insert into public.support_tickets (id, user_id, subject, category, assignee_id) values (${q(rows.ticket)}, ${q(S.id)}, ${q(`t11 ticket ${RUN}`)}, 'account', ${q(T.id)});
    insert into public.support_ticket_messages (id, ticket_id, sender_id, body) values
      (${q(rows.msgFromS)}, ${q(rows.ticket)}, ${q(S.id)}, 't11 message from the user'),
      (${q(rows.msgFromT)}, ${q(rows.ticket)}, ${q(T.id)}, 't11 reply from staff');
    insert into public.csat_feedbacks (id, user_id, ticket_id, score) values (${q(rows.csat)}, ${q(S.id)}, ${q(rows.ticket)}, 5);
    insert into public.nps_surveys (id, user_id, score, sent_at) values (${q(rows.nps)}, ${q(S.id)}, 9, now());
    insert into public.experiments (id, key, name, variants, created_by) values (${q(rows.exp)}, ${q(experimentKey)}, 't11 experiment', '[]'::jsonb, ${q(T.id)});
    insert into public.experiment_assignments (experiment_id, user_id, variant_key) values (${q(rows.exp)}, ${q(S.id)}, 'a');

    insert into public.coupons (id, code, discount_type, discount_value, valid_from, valid_until, created_by)
      values (${q(rows.coupon)}, ${q(`T11-${RUN}`)}, 'fixed', 100, now(), now() + interval '30 days', ${q(T.id)});
    insert into public.coupon_redemptions (id, coupon_id, user_id, subscription_target, applied_to_subscription_id, discount_amount_jpy, approved_by) values
      (${q(rows.redemptionUser)}, ${q(rows.coupon)}, ${q(S.id)}, 'personal', ${q(id())}, 100, ${q(T.id)});
    insert into public.coupon_redemptions (id, coupon_id, user_id, organization_id, subscription_target, applied_to_subscription_id, discount_amount_jpy) values
      (${q(rows.redemptionUserOrg)}, ${q(rows.coupon)}, ${q(S.id)}, ${q(rows.org)}, 'org', ${q(id())}, 100);
    insert into public.referral_rewards (id, referrer_id, referred_id, reward_type, reward_value) values
      (${q(rows.rewardAsReferrer)}, ${q(S.id)}, ${q(B.id)}, 'credit', '{"amount": 100}'::jsonb),
      (${q(rows.rewardAsReferred)}, ${q(B.id)}, ${q(S.id)}, 'credit', '{"amount": 100}'::jsonb);
    insert into public.gdpr_deletion_requests (id, user_id, executed_by) values (${q(rows.gdpr)}, ${q(S.id)}, ${q(T.id)});
    insert into public.plan_price_history (id, plan_id, changed_by, effective_at, applies_to)
      values (${q(rows.priceHistory)}, ${q(plan.id)}, ${q(T.id)}, now(), 'new_only');
  `);
}

async function seedEmailsAndLogs(): Promise<void> {
  await pgQuery(`
    insert into public.email_delivery_logs (id, user_id, email, template, status) values
      (${q(rows.logOfS)}, ${q(S.id)}, ${q(S.email)}, 'support_ticket_reply', 'sent'),
      (${q(rows.logOfB)}, ${q(B.id)}, ${q(B.email)}, 'support_ticket_reply', 'sent');
    insert into public.email_delivery_logs (id, email, template, status)
      values (${q(rows.logOfSByAddress)}, ${q(S.email.toUpperCase())}, 'other', 'sent');
    insert into public.inquiries (id, user_id, inquiry_type, email, subject, message) values
      (${q(rows.inquiryOfS)}, ${q(S.id)}, 'general', ${q(S.email)}, 't11 inquiry', 't11 body'),
      (${q(rows.inquiryOfB)}, ${q(B.id)}, 'general', ${q(B.email)}, 't11 inquiry', 't11 body');
    insert into public.inquiries (id, inquiry_type, email, subject, message)
      values (${q(rows.inquiryOfSByAddress)}, 'general', ${q(S.email.toUpperCase())}, 't11 inquiry (not logged in)', 't11 body');
    insert into public.ai_content_logs (id, user_id, content_type, input_prompt) values (${q(rows.aiLog)}, ${q(S.id)}, 'other', 't11 prompt');
    insert into public.app_logs (user_id, source, message, function_name) values (${q(S.id)}, 'api-route', 't11 log', ${q(FUNCTION_NAME)});
    insert into public.membership_audit (scope, scope_id, action, actor_id, target_user_id) values ('family', ${q(rows.fg)}, 'member_added', ${q(S.id)}, ${q(S.id)});
  `);
}

async function seedStaffSide(): Promise<void> {
  await pgQuery(`
    insert into public.recipes (id, name, user_id, is_public) values
      (${q(rows.recipeOfS)}, 't11 private recipe of S', ${q(S.id)}, false),
      (${q(rows.recipePublicOfS)}, 't11 public recipe of S', ${q(S.id)}, true),
      (${q(rows.recipeOfB)}, 't11 private recipe of B', ${q(B.id)}, false);
    insert into public.recipe_flags (id, recipe_id, reporter_id, reviewed_by) values (${q(rows.recipeFlag)}, ${q(rows.recipeOfB)}, ${q(S.id)}, ${q(T.id)});
    insert into public.recipe_flags (id, recipe_id, reporter_id, reviewed_by) values (${q(rows.recipeFlagOnPrivateOfS)}, ${q(rows.recipeOfS)}, ${q(B.id)}, null);
    insert into public.meals (id, user_id, eaten_at, meal_type) values (${q(rows.mealOfB)}, ${q(B.id)}, now(), 'dinner');
    insert into public.moderation_flags (id, meal_id, user_id, resolved_by) values (${q(rows.moderationFlag)}, ${q(rows.mealOfB)}, ${q(S.id)}, ${q(T.id)});
    insert into public.admin_user_notes (id, user_id, admin_id, note) values
      (${q(rows.noteOnS)}, ${q(S.id)}, ${q(T.id)}, 't11 note'),
      (${q(rows.noteOnB)}, ${q(B.id)}, ${q(T.id)}, 't11 note');
    insert into public.announcements (id, title, content, created_by) values (${q(rows.announcement)}, 't11', 't11', ${q(T.id)});
    insert into public.help_articles (id, slug, title, body, created_by) values (${q(rows.help)}, ${q(`t11-${RUN}`)}, 't11', 't11', ${q(T.id)});
    insert into public.infra_alerts (id, metric_name, threshold, comparison, triggered_at, ack_by) values (${q(rows.alert)}, 't11', 1, '>', now(), ${q(T.id)});
    insert into public.system_settings (key, value, updated_by) values (${q(settingKey)}, '{}'::jsonb, ${q(T.id)});
    insert into public.email_blacklist (email, reason, added_by) values (${q(blacklistEmail)}, 'manual', ${q(T.id)});
    insert into public.sales_leads (id, company_name, assigned_to) values (${q(rows.lead)}, 't11 company', ${q(T.id)});
    insert into public.sales_lead_activities (id, lead_id, actor_id, activity_type, details) values (${q(rows.leadActivity)}, ${q(rows.lead)}, ${q(T.id)}, 'note', '{}'::jsonb);
    insert into public.admin_audit_logs (id, actor_id, impersonated_by, action_type) values (${q(rows.auditLog)}, ${q(T.id)}, ${q(T.id)}, 'test.t11');
    update public.user_profiles set frozen_at = now(), frozen_by = ${q(T.id)}, frozen_reason = 't11' where id = ${q(B.id)};
  `);
}

/** 退会する利用者の通常のデータ (CASCADE で消える) と、Storage のファイルを指す URL を持つ行 */
async function seedSubjectData(): Promise<void> {
  const checkupUrl = (await srAdmin.storage.from('health-checkups').createSignedUrl(objectPath('checkupOldLayout'), 3600)).data?.signedUrl;
  if (!checkupUrl) throw new Error('createSignedUrl failed');
  const today = new Date().toISOString().slice(0, 10);

  await pgQuery(`
    insert into public.meals (id, user_id, eaten_at, meal_type, photo_url) values
      (${q(rows.mealOfS)}, ${q(S.id)}, now(), 'dinner', ${q(publicUrl('fridge-images', objectPath('fridgeLegacyMeals')))}),
      (${q(rows.mealWithForeignPhoto)}, ${q(S.id)}, now(), 'lunch', ${q(publicUrl('fridge-images', objectPath('othersFile')))}),
      (${q(rows.mealWithForeignGenerated)}, ${q(S.id)}, now(), 'snack', ${q(publicUrl('fridge-images', objectPath('unownedGenerated')))});
    insert into public.user_daily_meals (id, user_id, day_date) values (${q(rows.daily)}, ${q(S.id)}, ${q(today)}), (${q(rows.dailyOfB)}, ${q(B.id)}, ${q(today)});
    insert into public.planned_meals (id, daily_meal_id, meal_type, dish_name, image_url) values
      (${q(rows.planned)}, ${q(rows.daily)}, 'dinner', 't11 dish', ${q(publicUrl('fridge-images', objectPath('generatedForMeal')))}),
      (${q(rows.plannedForeign)}, ${q(rows.dailyOfB)}, 'lunch', 't11 dish of B', ${q(publicUrl('fridge-images', objectPath('unownedGenerated')))});
    insert into public.meal_image_jobs (id, planned_meal_id, user_id, dish_index, subject_hash, idempotency_key, prompt, model, status, result_image_url)
      values (${q(rows.job)}, ${q(rows.planned)}, ${q(S.id)}, 0, 'h', ${q(`t11-${id()}`)}, 'p', 'm', 'completed', ${q(publicUrl('fridge-images', objectPath('generatedForMeal')))});
    insert into public.weekly_menu_requests (id, user_id, start_date, inventory_image_url)
      values (${q(rows.weeklyRequest)}, ${q(S.id)}, ${q(today)}, ${q(publicUrl('fridge-images', objectPath('rootLevel')))});
    insert into public.health_checkups (id, user_id, checkup_date, image_url) values (${q(rows.checkup)}, ${q(S.id)}, ${q(today)}, ${q(checkupUrl)});
    insert into public.blood_test_results (id, user_id, test_date, report_image_url)
      values (${q(rows.bloodTest)}, ${q(S.id)}, ${q(today)}, ${q(publicUrl('meal_photos', objectPath('mealPhotos')))});

    insert into public.ai_consultation_sessions (id, user_id) values (${q(rows.session)}, ${q(S.id)});
    insert into public.ai_consultation_messages (id, session_id, role, content) values (${q(rows.message)}, ${q(rows.session)}, 'user', 't11');
    insert into public.ai_action_logs (id, session_id, message_id, action_type, action_params)
      values (${q(rows.actionLog)}, ${q(rows.session)}, ${q(rows.message)}, 'create_meal', '{}'::jsonb);
    insert into public.shopping_lists (id, user_id, start_date, end_date) values (${q(rows.shoppingList)}, ${q(S.id)}, ${q(today)}, ${q(today)});
    insert into public.shopping_list_requests (id, user_id, shopping_list_id) values (${q(rows.shoppingRequest)}, ${q(S.id)}, ${q(rows.shoppingList)});
  `);
}

async function seedStorage(): Promise<void> {
  for (const key of Object.keys(objects) as ObjectKey[]) {
    await putObject(objectBucket(key), objectPath(key));
  }
}

/** 後片付け: 残る行 (SET NULL の行など) を、作った ID で消す。失敗しても次へ進む */
async function cleanup(): Promise<void> {
  const list = (ids: string[]) => ids.map(q).join(',');
  const statements = [
    `delete from public.coupon_redemptions where id in (${list([rows.redemptionUser, rows.redemptionUserOrg])})`,
    `delete from public.coupons where id = ${q(rows.coupon)}`,
    `delete from public.referral_rewards where id in (${list([rows.rewardAsReferrer, rows.rewardAsReferred])})`,
    `delete from public.gdpr_deletion_requests where id = ${q(rows.gdpr)}`,
    `delete from public.email_delivery_logs where id in (${list([rows.logOfS, rows.logOfSByAddress, rows.logOfB])})`,
    `delete from public.inquiries where id in (${list([rows.inquiryOfS, rows.inquiryOfSByAddress, rows.inquiryOfB])})`,
    `delete from public.csat_feedbacks where id = ${q(rows.csat)}`,
    `delete from public.support_ticket_messages where ticket_id = ${q(rows.ticket)}`,
    `delete from public.support_tickets where id = ${q(rows.ticket)}`,
    `delete from public.moderation_flags where id = ${q(rows.moderationFlag)}`,
    `delete from public.recipe_flags where id in (${list([rows.recipeFlag, rows.recipeFlagOnPrivateOfS])})`,
    `delete from public.recipes where id in (${list([rows.recipeOfS, rows.recipePublicOfS, rows.recipeOfB])})`,
    `delete from public.meals where id in (${list([rows.mealOfB, rows.mealOfS, rows.mealWithForeignPhoto, rows.mealWithForeignGenerated])})`,
    `delete from public.planned_meals where id in (${list([rows.planned, rows.plannedForeign])})`,
    `delete from public.user_daily_meals where id in (${list([rows.daily, rows.dailyOfB])})`,
    `delete from public.admin_user_notes where id in (${list([rows.noteOnS, rows.noteOnB])})`,
    `delete from public.announcements where id = ${q(rows.announcement)}`,
    `delete from public.help_articles where id = ${q(rows.help)}`,
    `delete from public.infra_alerts where id = ${q(rows.alert)}`,
    `delete from public.system_settings where key = ${q(settingKey)}`,
    `delete from public.email_blacklist where email = ${q(blacklistEmail)}`,
    `delete from public.sales_lead_activities where id = ${q(rows.leadActivity)}`,
    `delete from public.sales_leads where id = ${q(rows.lead)}`,
    `delete from public.plan_price_history where id = ${q(rows.priceHistory)}`,
    `delete from public.admin_audit_logs where id = ${q(rows.auditLog)}`,
    `delete from public.app_logs where function_name = ${q(FUNCTION_NAME)}`,
    `delete from public.membership_audit where scope_id in (${list([rows.fg, rows.org])})`,
    `delete from public.family_promotion_requests where id in (${list([rows.promoToS, rows.promoToB])})`,
    `delete from public.family_invites where id in (${list([rows.famInviteToS, rows.famInviteToB])})`,
    `delete from public.family_members where family_id = ${q(rows.fg)}`,
    `delete from public.family_groups where id = ${q(rows.fg)}`,
    `delete from public.organization_invites where organization_id = ${q(rows.org)}`,
    `delete from public.organization_challenges where id = ${q(rows.challenge)}`,
    `delete from public.departments where id = ${q(rows.dept)}`,
    `delete from public.organizations where id = ${q(rows.org)}`,
    `delete from public.experiment_assignments where experiment_id = ${q(rows.exp)}`,
    `delete from public.experiments where id = ${q(rows.exp)}`,
  ];
  for (const statement of statements) {
    try {
      await pgQuery(statement);
    } catch (error) {
      console.warn(`cleanup failed: ${statement.slice(0, 80)} ... ${error instanceof Error ? error.message : error}`);
    }
  }
  for (const key of Object.keys(objects) as ObjectKey[]) {
    try {
      await srAdmin.storage.from(objectBucket(key)).remove([objectPath(key)]);
    } catch {
      // 作る前に失敗していた場合など
    }
  }
  for (const userId of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(userId).catch(() => undefined);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A〜D, F: 全ての表に行を作って、運営者 → 利用者の順に消す
// ─────────────────────────────────────────────────────────────────────────────
describe('#1175 退会: 外部キーのある全ての表に行がある状態で、運営者と利用者を消せる', () => {
  let report: { ok: boolean; result: Awaited<ReturnType<typeof deleteAccount>> };
  let requestId: string;

  beforeAll(async () => {
    [S, T, B] = await Promise.all([createUser('subject'), createUser('staff'), createUser('bystander')]);
    await seedStorage();
    await seedOrgAndFamily();
    await seedSupportAndBilling();
    await seedEmailsAndLogs();
    await seedStaffSide();
    await seedSubjectData();
  }, 180_000);

  afterAll(cleanup, 120_000);

  it('前提: 退会前は、作った行がすべて入っている (空振りしていない)', async () => {
    expect(await count('support_tickets', `id = ${q(rows.ticket)} and user_id = ${q(S.id)} and assignee_id = ${q(T.id)}`)).toBe(1);
    expect(await count('coupon_redemptions', `id in (${q(rows.redemptionUser)}, ${q(rows.redemptionUserOrg)})`)).toBe(2);
    expect(await count('email_delivery_logs', `lower(email) = lower(${q(S.email)})`)).toBe(2);
    expect(await count('inquiries', `lower(email) = lower(${q(S.email)})`)).toBe(2);
    expect(await count('organization_invites', `lower(email) = lower(${q(S.email)}) and status = 'pending'`)).toBe(1);
    expect(await count('family_invites', `lower(email) = lower(${q(S.email)}) and status = 'pending'`)).toBe(1);
    expect(await count('family_promotion_requests', `lower(email) = lower(${q(S.email)}) and status = 'pending'`)).toBe(1);
    for (const key of [...REMOVED, ...KEPT]) {
      expect(await exists(objectBucket(key), objectPath(key)), `${objectBucket(key)}/${objectPath(key)}`).toBe(true);
    }
  });

  it('運営者 (T) を、素の auth.admin.deleteUser で消せる (参照する行は残り、参照だけが NULL になる)', async () => {
    const { error } = await srAdmin.auth.admin.deleteUser(T.id);
    expect(error, 'deleteUser(staff)').toBeNull();
    forget(T.id);

    // 記録そのものは残る
    expect(await count('departments', `id = ${q(rows.dept)}`)).toBe(1);
    expect(await count('organization_challenges', `id = ${q(rows.challenge)}`)).toBe(1);
    expect(await count('announcements', `id = ${q(rows.announcement)}`)).toBe(1);
    expect(await count('help_articles', `id = ${q(rows.help)}`)).toBe(1);
    expect(await count('infra_alerts', `id = ${q(rows.alert)}`)).toBe(1);
    expect(await count('system_settings', `key = ${q(settingKey)}`)).toBe(1);
    expect(await count('email_blacklist', `email = ${q(blacklistEmail)}`)).toBe(1);
    expect(await count('sales_lead_activities', `id = ${q(rows.leadActivity)}`)).toBe(1);
    expect(await count('plan_price_history', `id = ${q(rows.priceHistory)}`)).toBe(1);
    expect(await count('admin_audit_logs', `id = ${q(rows.auditLog)}`)).toBe(1);
    expect(await count('experiments', `id = ${q(rows.exp)}`)).toBe(1);
    expect(await count('coupons', `id = ${q(rows.coupon)}`)).toBe(1);

    // 運営者を指していた列がすべて NULL になった
    const nulled: Array<[string, string, string]> = [
      ['departments', 'manager_id', rows.dept],
      ['organization_challenges', 'created_by', rows.challenge],
      ['organization_invites', 'created_by', rows.orgInviteToS],
      ['organization_invites', 'invited_by', rows.orgInviteToS],
      ['announcements', 'created_by', rows.announcement],
      ['help_articles', 'created_by', rows.help],
      ['infra_alerts', 'ack_by', rows.alert],
      ['sales_leads', 'assigned_to', rows.lead],
      ['sales_lead_activities', 'actor_id', rows.leadActivity],
      ['plan_price_history', 'changed_by', rows.priceHistory],
      ['admin_audit_logs', 'actor_id', rows.auditLog],
      ['admin_audit_logs', 'impersonated_by', rows.auditLog],
      ['experiments', 'created_by', rows.exp],
      ['coupons', 'created_by', rows.coupon],
      ['coupon_redemptions', 'approved_by', rows.redemptionUser],
      ['gdpr_deletion_requests', 'executed_by', rows.gdpr],
      ['support_tickets', 'assignee_id', rows.ticket],
      ['support_ticket_messages', 'sender_id', rows.msgFromT],
      ['recipe_flags', 'reviewed_by', rows.recipeFlag],
      ['moderation_flags', 'resolved_by', rows.moderationFlag],
      ['admin_user_notes', 'admin_id', rows.noteOnB],
    ];
    for (const [table, column, rowId] of nulled) {
      expect(await count(table, `id = ${q(rowId)} and ${column} is null`), `${table}.${column}`).toBe(1);
    }
    expect(await count('system_settings', `key = ${q(settingKey)} and updated_by is null`)).toBe(1);
    expect(await count('email_blacklist', `email = ${q(blacklistEmail)} and added_by is null`)).toBe(1);
    expect(await count('user_profiles', `id = ${q(B.id)} and frozen_by is null and frozen_at is not null`)).toBe(1);

    // 運営者以外の列は変わらない
    expect(await count('support_tickets', `id = ${q(rows.ticket)} and user_id = ${q(S.id)}`)).toBe(1);
    expect(await count('support_ticket_messages', `id = ${q(rows.msgFromS)} and sender_id = ${q(S.id)}`)).toBe(1);
  }, 60_000);

  it('利用者 (S) を deleteAccount で退会できる', async () => {
    requestId = `req_t11_${RUN}`;
    const result = await deleteAccount({ userId: S.id, admin: srAdmin, requestId });
    report = { ok: result.ok, result };
    expect(result, JSON.stringify(result)).toEqual({ ok: true });
    forget(S.id);

    const { data } = await srAdmin.auth.admin.getUserById(S.id);
    expect(data.user).toBeNull();
  }, 120_000);

  it('本人だけの記録は消えている (CASCADE)', async () => {
    expect(await count('nps_surveys', `id = ${q(rows.nps)}`)).toBe(0);
    expect(await count('csat_feedbacks', `id = ${q(rows.csat)}`)).toBe(0);
    expect(await count('experiment_assignments', `experiment_id = ${q(rows.exp)}`)).toBe(0);
    expect(await count('ai_content_logs', `id = ${q(rows.aiLog)}`)).toBe(0);
    expect(await count('admin_user_notes', `id = ${q(rows.noteOnS)}`)).toBe(0);
    expect(await count('user_profiles', `id = ${q(S.id)}`)).toBe(0);
    expect(await count('meals', `user_id = ${q(S.id)}`)).toBe(0);
    expect(await count('user_daily_meals', `user_id = ${q(S.id)}`)).toBe(0);
    expect(await count('planned_meals', `id = ${q(rows.planned)}`)).toBe(0);
    // 他人 (B) の献立は残る
    expect(await count('planned_meals', `id = ${q(rows.plannedForeign)}`)).toBe(1);
    expect(await count('meal_image_jobs', `id = ${q(rows.job)}`)).toBe(0);
    expect(await count('weekly_menu_requests', `user_id = ${q(S.id)}`)).toBe(0);
    expect(await count('health_checkups', `user_id = ${q(S.id)}`)).toBe(0);
    expect(await count('blood_test_results', `user_id = ${q(S.id)}`)).toBe(0);
    expect(await count('family_members', `id = ${q(rows.fmS)}`)).toBe(0);
    // NO ACTION の外部キーが CASCADE の連鎖の中にあっても、同じ削除で一緒に消える
    expect(await count('ai_consultation_sessions', `id = ${q(rows.session)}`)).toBe(0);
    expect(await count('ai_consultation_messages', `id = ${q(rows.message)}`)).toBe(0);
    expect(await count('ai_action_logs', `id = ${q(rows.actionLog)}`)).toBe(0);
    expect(await count('shopping_lists', `id = ${q(rows.shoppingList)}`)).toBe(0);
    expect(await count('shopping_list_requests', `id = ${q(rows.shoppingRequest)}`)).toBe(0);
  });

  it('サポート・会計の記録は行が残り、本人との紐づけだけが NULL になる', async () => {
    const ticket = await one<{ user_id: string | null; subject: string }>(`select user_id, subject from public.support_tickets where id = ${q(rows.ticket)}`);
    expect(ticket).toEqual({ user_id: null, subject: `t11 ticket ${RUN}` });
    const message = await one<{ sender_id: string | null; body: string }>(`select sender_id, body from public.support_ticket_messages where id = ${q(rows.msgFromS)}`);
    expect(message).toEqual({ sender_id: null, body: 't11 message from the user' });
    expect(await count('support_ticket_messages', `id = ${q(rows.msgFromT)}`)).toBe(1);

    // 本人宛の償還記録: user_id が外れ、anonymized_at が入る (CHECK 制約に当たらない)
    const redemption = await one<{ user_id: string | null; organization_id: string | null; anonymized_at: string | null }>(
      `select user_id, organization_id, anonymized_at from public.coupon_redemptions where id = ${q(rows.redemptionUser)}`,
    );
    expect(redemption?.user_id).toBeNull();
    expect(redemption?.organization_id).toBeNull();
    expect(redemption?.anonymized_at).not.toBeNull();
    // 組織宛の償還記録 (user_id もある): 組織は残り、user_id が外れる
    const orgRedemption = await one<{ user_id: string | null; organization_id: string | null; anonymized_at: string | null }>(
      `select user_id, organization_id, anonymized_at from public.coupon_redemptions where id = ${q(rows.redemptionUserOrg)}`,
    );
    expect(orgRedemption?.user_id).toBeNull();
    expect(orgRedemption?.organization_id).toBe(rows.org);
    expect(orgRedemption?.anonymized_at).not.toBeNull();

    // 紹介報酬: 消えた側だけが NULL。相手 (B) は残る
    const asReferrer = await one<{ referrer_id: string | null; referred_id: string | null }>(
      `select referrer_id, referred_id from public.referral_rewards where id = ${q(rows.rewardAsReferrer)}`,
    );
    expect(asReferrer).toEqual({ referrer_id: null, referred_id: B.id });
    const asReferred = await one<{ referrer_id: string | null; referred_id: string | null }>(
      `select referrer_id, referred_id from public.referral_rewards where id = ${q(rows.rewardAsReferred)}`,
    );
    expect(asReferred).toEqual({ referrer_id: B.id, referred_id: null });

    expect(await count('gdpr_deletion_requests', `id = ${q(rows.gdpr)} and user_id is null`)).toBe(1);
    expect(await count('recipe_flags', `id = ${q(rows.recipeFlag)} and reporter_id is null`)).toBe(1);
    expect(await count('moderation_flags', `id = ${q(rows.moderationFlag)} and user_id is null`)).toBe(1);
    expect(await count('app_logs', `function_name = ${q(FUNCTION_NAME)} and user_id is null`)).toBe(1);
    expect(await count('membership_audit', `scope_id = ${q(rows.fg)} and actor_id is null and target_user_id is null`)).toBe(1);
  });

  it('レシピ: 本人の非公開レシピは消え、公開レシピは user_id だけが外れて残る。他人のレシピは変わらない', async () => {
    expect(await count('recipes', `id = ${q(rows.recipeOfS)}`)).toBe(0);
    expect(await count('recipes', `id = ${q(rows.recipePublicOfS)} and user_id is null and is_public`)).toBe(1);
    expect(await count('recipes', `id = ${q(rows.recipeOfB)} and user_id = ${q(B.id)}`)).toBe(1);
    // 他人の行から参照されている非公開レシピでも、消すことで退会が止まらない (recipes を指す外部キーは CASCADE。
    // 外部キーの検査は auth-users-fk-on-delete.test.ts の E)。参照していた他人の通報は、レシピと一緒に消える
    expect(await count('recipe_flags', `id = ${q(rows.recipeFlagOnPrivateOfS)}`)).toBe(0);

    // recipes.user_id は ON DELETE SET NULL で、user_id が NULL の行は RLS で全員に見える ("Users can view public recipes")。
    // 非公開のままだったレシピが、ログインしていない人 (anon) にも読めるようになっていない
    const { data, error } = await client(anonKey)
      .from('recipes')
      .select('id')
      .in('id', [rows.recipeOfS, rows.recipePublicOfS, rows.recipeOfB]);
    expect(error).toBeNull();
    expect((data ?? []).map((row) => row.id as string)).toEqual([rows.recipePublicOfS]);
  });

  it('生のメールアドレスが残っていない。他の人の行は変わらない', async () => {
    // メール配信ログ: 本人宛 (user_id あり / 宛先だけ一致) は伏せる。行は残る。B の行は変わらない
    const logs = await pgQuery<{ id: string; user_id: string | null; email: string }>(
      `select id, user_id, email from public.email_delivery_logs where id in (${[rows.logOfS, rows.logOfSByAddress, rows.logOfB].map(q).join(',')}) order by id`,
    );
    const byId = Object.fromEntries(logs.map((row) => [row.id, row]));
    expect(byId[rows.logOfS]).toMatchObject({ user_id: null, email: MASKED_EMAIL });
    expect(byId[rows.logOfSByAddress].email).toBe(MASKED_EMAIL);
    expect(byId[rows.logOfB]).toMatchObject({ user_id: B.id, email: B.email });

    const inquiries = await pgQuery<{ id: string; user_id: string | null; email: string; message: string }>(
      `select id, user_id, email, message from public.inquiries where id in (${[rows.inquiryOfS, rows.inquiryOfSByAddress, rows.inquiryOfB].map(q).join(',')})`,
    );
    const inquiryById = Object.fromEntries(inquiries.map((row) => [row.id, row]));
    expect(inquiryById[rows.inquiryOfS]).toMatchObject({ user_id: null, email: MASKED_EMAIL, message: 't11 body' });
    expect(inquiryById[rows.inquiryOfSByAddress]).toMatchObject({ email: MASKED_EMAIL, message: 't11 body' });
    expect(inquiryById[rows.inquiryOfB]).toMatchObject({ user_id: B.id, email: B.email });

    // 招待: 本人宛 (と、本人が受諾したもの) は伏せ、pending は revoked になる。B 宛は変わらない
    const orgInvites = await pgQuery<{ id: string; email: string; status: string; revoked_at: string | null }>(
      `select id, email, status, revoked_at from public.organization_invites where organization_id = ${q(rows.org)}`,
    );
    const orgInviteById = Object.fromEntries(orgInvites.map((row) => [row.id, row]));
    expect(orgInviteById[rows.orgInviteToS]).toMatchObject({ email: MASKED_EMAIL, status: 'revoked' });
    expect(orgInviteById[rows.orgInviteToS].revoked_at).not.toBeNull();
    expect(orgInviteById[rows.orgInviteAcceptedByS]).toMatchObject({ email: MASKED_EMAIL, status: 'accepted', revoked_at: null });
    expect(orgInviteById[rows.orgInviteToB]).toMatchObject({ email: B.email, status: 'pending' });

    const famInvites = await pgQuery<{ id: string; email: string; status: string }>(
      `select id, email, status from public.family_invites where family_id = ${q(rows.fg)}`,
    );
    const famInviteById = Object.fromEntries(famInvites.map((row) => [row.id, row]));
    expect(famInviteById[rows.famInviteToS]).toMatchObject({ email: MASKED_EMAIL, status: 'revoked' });
    expect(famInviteById[rows.famInviteToB]).toMatchObject({ email: B.email, status: 'pending' });

    const promos = await pgQuery<{ id: string; email: string; status: string; resolved_at: string | null }>(
      `select id, email, status, resolved_at from public.family_promotion_requests where family_id = ${q(rows.fg)}`,
    );
    const promoById = Object.fromEntries(promos.map((row) => [row.id, row]));
    expect(promoById[rows.promoToS]).toMatchObject({ email: MASKED_EMAIL, status: 'revoked' });
    expect(promoById[rows.promoToS].resolved_at).not.toBeNull();
    expect(promoById[rows.promoToB]).toMatchObject({ email: B.email, status: 'pending' });

    // どの表にも、本人のアドレスが (大文字小文字を問わず) 残っていない
    for (const table of ['email_delivery_logs', 'inquiries', 'organization_invites', 'family_invites', 'family_promotion_requests']) {
      expect(await count(table, `lower(email) = lower(${q(S.email)})`), table).toBe(0);
    }
  });

  it('ログ (app_logs) にメールアドレスも user_id も載らない。成功のログが 1 行残る', async () => {
    let logs: Array<{ message: string; user_id: string | null; metadata: unknown; error_message: string | null }> = [];
    // db-logger は非同期で書くので、現れるまで少し待つ
    for (let attempt = 0; attempt < 40 && logs.length === 0; attempt += 1) {
      logs = await pgQuery(
        `select message, user_id, metadata, error_message from public.app_logs where request_id = ${q(requestId)}`,
      );
      if (logs.length === 0) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(logs.map((row) => row.message)).toContain('account deleted');
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(S.email);
    expect(serialized.toLowerCase()).not.toContain(S.email.toLowerCase());
    expect(serialized).not.toContain(S.id);
    expect(logs.every((row) => row.user_id === null)).toBe(true);
  }, 30_000);

  it('Storage: 本人のファイルは消え、他人のファイルと持ち主が分からないファイルは残る', async () => {
    for (const key of REMOVED) {
      expect(await exists(objectBucket(key), objectPath(key)), `消えているはず: ${objectBucket(key)}/${objectPath(key)}`).toBe(false);
    }
    for (const key of KEPT) {
      expect(await exists(objectBucket(key), objectPath(key)), `残るはず: ${objectBucket(key)}/${objectPath(key)}`).toBe(true);
    }
    expect(await listAll('fridge-images', S.id)).toEqual([]);
    expect(await listAll('meal_photos', S.id)).toEqual([]);
    expect(await listAll('health-checkups', S.id)).toEqual([]);
  });

  it('もう一度退会を実行しても成功する (やり直せる)', async () => {
    const again = await deleteAccount({ userId: S.id, admin: srAdmin, requestId: `req_t11_again_${RUN}` });
    expect(again).toEqual({ ok: true });
    expect(report.ok).toBe(true);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// E. 組織のオーナー・家族の代表者は 409 で止まり、何も変わらない
// ─────────────────────────────────────────────────────────────────────────────
describe('#1175 退会: 組織のオーナー・家族の代表者は 409 で止まる', () => {
  const ownedIds = { org: id(), fg: id(), log: id(), inquiry: id() };
  const blockedUserIds: string[] = [];
  let owner: { id: string; email: string };
  let representative: { id: string; email: string };
  const keepPath = () => `${owner.id}/blocked-${RUN}.png`;

  beforeAll(async () => {
    owner = await createUser('blocked-owner');
    representative = await createUser('blocked-rep');
    blockedUserIds.push(owner.id, representative.id);
    await pgQuery(`
      insert into public.organizations (id, name, owner_id) values (${q(ownedIds.org)}, 't11 blocked org', ${q(owner.id)});
      insert into public.family_groups (id, name, representative_id) values (${q(ownedIds.fg)}, 't11 blocked family', ${q(representative.id)});
      insert into public.email_delivery_logs (id, user_id, email, template, status) values (${q(ownedIds.log)}, ${q(owner.id)}, ${q(owner.email)}, 'x', 'sent');
      insert into public.inquiries (id, user_id, inquiry_type, email, subject, message) values (${q(ownedIds.inquiry)}, ${q(owner.id)}, 'general', ${q(owner.email)}, 's', 'm');
    `);
    await putObject('fridge-images', keepPath());
  }, 60_000);

  afterAll(async () => {
    await pgQuery(`delete from public.email_delivery_logs where id = ${q(ownedIds.log)}`).catch(() => undefined);
    await pgQuery(`delete from public.inquiries where id = ${q(ownedIds.inquiry)}`).catch(() => undefined);
    await pgQuery(`delete from public.family_groups where id = ${q(ownedIds.fg)}`).catch(() => undefined);
    await pgQuery(`delete from public.organizations where id = ${q(ownedIds.org)}`).catch(() => undefined);
    await srAdmin.storage.from('fridge-images').remove([keepPath()]).catch(() => undefined);
    for (const userId of blockedUserIds) {
      await srAdmin.auth.admin.deleteUser(userId).catch(() => undefined);
      forget(userId);
    }
  }, 60_000);

  it('組織のオーナー: 409 ACCOUNT_DELETE_BLOCKED_ORG_OWNER。アカウントも、メールアドレスも、ファイルも変わらない', async () => {
    const result = await deleteAccount({ userId: owner.id, admin: srAdmin });
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER',
      organization: { id: ownedIds.org, name: 't11 blocked org' },
    });

    const { data } = await srAdmin.auth.admin.getUserById(owner.id);
    expect(data.user?.id).toBe(owner.id);
    expect(await count('email_delivery_logs', `id = ${q(ownedIds.log)} and email = ${q(owner.email)} and user_id = ${q(owner.id)}`)).toBe(1);
    expect(await count('inquiries', `id = ${q(ownedIds.inquiry)} and email = ${q(owner.email)}`)).toBe(1);
    expect(await exists('fridge-images', keepPath())).toBe(true);
  });

  it('家族の代表者: 409 ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE', async () => {
    const result = await deleteAccount({ userId: representative.id, admin: srAdmin });
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE',
      family_group: { id: ownedIds.fg, name: 't11 blocked family' },
    });
    const { data } = await srAdmin.auth.admin.getUserById(representative.id);
    expect(data.user?.id).toBe(representative.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// prepare_account_deletion を直接呼ぶ (戻り値の形・冪等・入力の確認)
// ─────────────────────────────────────────────────────────────────────────────
describe('#1175 prepare_account_deletion: 戻り値と冪等', () => {
  const REPORT_KEYS = ['email_delivery_logs', 'family_invites', 'family_promotion_requests', 'inquiries', 'organization_invites', 'private_recipes'];
  const ALL_ZERO = {
    email_delivery_logs: 0,
    inquiries: 0,
    organization_invites: 0,
    family_invites: 0,
    family_promotion_requests: 0,
    private_recipes: 0,
  };
  let lonely: { id: string; email: string };
  const logId = id();

  beforeAll(async () => {
    lonely = await createUser('prepare-only');
    await pgQuery(`
      insert into public.email_delivery_logs (id, user_id, email, template, status)
      values (${q(logId)}, ${q(lonely.id)}, ${q(lonely.email)}, 'x', 'sent')
    `);
  }, 60_000);

  afterAll(async () => {
    await pgQuery(`delete from public.email_delivery_logs where id = ${q(logId)}`).catch(() => undefined);
    await srAdmin.auth.admin.deleteUser(lonely.id).catch(() => undefined);
    forget(lonely.id);
  }, 60_000);

  it('件数だけの jsonb を返す (メールアドレスは返さない)。2 回目は何も伏せるものが無いので全部 0 (やり直せる)', async () => {
    const first = await srAdmin.rpc('prepare_account_deletion', { p_user_id: lonely.id });
    expect(first.error).toBeNull();
    expect(Object.keys(first.data as Record<string, number>).sort()).toEqual(REPORT_KEYS);
    expect(first.data).toEqual({ ...ALL_ZERO, email_delivery_logs: 1 });
    expect(JSON.stringify(first.data)).not.toContain(lonely.email);
    expect(await count('email_delivery_logs', `id = ${q(logId)} and email = ${q(MASKED_EMAIL)}`)).toBe(1);

    const second = await srAdmin.rpc('prepare_account_deletion', { p_user_id: lonely.id });
    expect(second.error).toBeNull();
    expect(second.data).toEqual(ALL_ZERO);
  });

  it('存在しない利用者の id でも失敗せず、全部 0 を返す', async () => {
    const { data, error } = await srAdmin.rpc('prepare_account_deletion', { p_user_id: randomUUID() });
    expect(error).toBeNull();
    expect(data).toEqual(ALL_ZERO);
  });

  it('p_user_id が NULL なら 22023 で失敗する (全員分を触らない)', async () => {
    const { error } = await srAdmin.rpc('prepare_account_deletion', { p_user_id: null });
    expect(error).not.toBeNull();
    expect(error?.code).toBe('22023');
  });
});
