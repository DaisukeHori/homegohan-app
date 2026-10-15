/**
 * #1538 運営が隠したコンテンツを、隠してから 90 日を過ぎたら完全に消す (結合テスト)
 *
 * 本物のローカル Supabase (DB・Storage) に対して、Edge Function purge-hidden-content の本体
 * (supabase/functions/_shared/hidden-content-purge.ts の purgeExpiredHiddenContent) を service_role の client で直接呼ぶ。
 * 時刻は引数 now で固定する (行の hidden_at は、その now から 89 日・90 日・91 日前に置く)。
 * Edge Function そのもの (デプロイしたもの) は呼ばない (このワークフローは Edge Function を起動しない)。
 *
 * 確かめること:
 *   A. 隠してから 89 日・90 日ちょうどの行と、隠していない行は消えない。91 日の行は消える (食事・レシピとも)
 *   B. 消える行の画像 (持ち主のフォルダのファイル) も Storage から消える。消えない行の画像は残る
 *   C. 画像を消さないもの: ほかの行 (隠していない複製・まだ 90 日たっていない隠した行) が使っている画像、
 *      他人のフォルダの画像 (自分の行の URL に他人のファイルを入れたもの)。行は消える
 *   D. 外部キーのとおりに動く: 通報 (moderation_flags) は CASCADE で消え、献立の実績 (planned_meals.actual_meal_id) は NULL になって残る
 *   E. migration の定義: pg_cron のジョブ purge-hidden-content が 1 つ (毎日 18:25 UTC = 03:25 JST・postgres・有効)。
 *      呼び出しの関数は Vault の app_cron_secret を Bearer に付けて、Edge Function purge-hidden-content へ POST を積む
 *      (トランザクションの中で呼んでロールバックするので、実際には送らない)。秘密が無ければ例外で失敗する
 *   F. 権限: 呼び出しの関数は anon / authenticated / service_role が呼べない。画像の確認の関数は service_role だけが呼べる
 *   G. もう一度流しても、何も消さずに成功する (やり直せる)
 *
 * 作った行・ユーザー・ファイルは afterAll で消す。本番には接続しない。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/purge-hidden-content.test.ts
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import {
  HIDDEN_CONTENT_RETENTION_DAYS,
  purgeExpiredHiddenContent,
  type HiddenContentPurgeResult,
} from '../../../supabase/functions/_shared/hidden-content-purge';

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

type PgResult = { ok: true; rows: Record<string, unknown>[] } | { ok: false; status: number; message: string };

/** ローカルスタックの postgres-meta で SQL を流す。失敗は例外にせず、エラー文を返す */
async function pgQueryRaw(query: string): Promise<PgResult> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body: unknown = await res.json();
  if (res.ok) return { ok: true, rows: body as Record<string, unknown>[] };
  const message = (body as { message?: unknown; error?: unknown } | null)?.message ?? (body as { error?: unknown } | null)?.error;
  return { ok: false, status: res.status, message: typeof message === 'string' ? message : JSON.stringify(body) };
}

async function pgQuery(query: string): Promise<Record<string, unknown>[]> {
  const result = await pgQueryRaw(query);
  if (!result.ok) throw new Error(`pg/query ${result.status}: ${result.message}`);
  return result.rows;
}

/** SQL の文字列リテラル (テストが決めた値だけを渡す) */
const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;

const DAY_MS = 24 * 60 * 60 * 1000;
/** 完全削除に渡す「今」。行の hidden_at はここから数える */
const NOW = new Date();
const hiddenDaysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS).toISOString();
const DAYS_BEFORE = HIDDEN_CONTENT_RETENTION_DAYS - 1; // 89 日
const DAYS_AFTER = HIDDEN_CONTENT_RETENTION_DAYS + 1; // 91 日

const RUN = randomBytes(4).toString('hex');
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const BUCKET = 'fridge-images';
const RECIPE_NAME = (key: string) => `#1538 purge ${key} ${RUN}`;

const JOB_NAME = 'purge-hidden-content';
const JOB_SCHEDULE = '25 18 * * *';
const INVOKE_SIGNATURE = 'public.invoke_purge_hidden_content()';
const NEEDLES_SIGNATURE = 'public.hidden_content_purge_referenced_needles(text[],timestamp with time zone)';
const EDGE_FUNCTION_URL = 'https://flmeolcfutuwwbjmzyoz.supabase.co/functions/v1/purge-hidden-content';
/** E で、ロールバックさせる例外の目印 (この後ろに結果の JSON を付ける) */
const RESULT_MARK = 'I1538_RESULT:';

const createdUserIds: string[] = [];
const uploadedPaths: string[] = [];

function tinyPng(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

async function createUser(label: string): Promise<string> {
  const { data, error } = await srAdmin.auth.admin.createUser({
    email: `i1538-${label}-${RUN}@homegohan.test`,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `i1538-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  return data.user.id;
}

/** Storage にファイルを置き、その公開 URL を返す */
async function putObject(path: string): Promise<string> {
  const { error } = await srAdmin.storage.from(BUCKET).upload(path, tinyPng(), { contentType: 'image/png', upsert: true });
  if (error) throw new Error(`upload ${path}: ${error.message}`);
  uploadedPaths.push(path);
  return srAdmin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

async function exists(path: string): Promise<boolean> {
  const slash = path.lastIndexOf('/');
  const folder = path.slice(0, slash);
  const name = path.slice(slash + 1);
  const { data, error } = await srAdmin.storage.from(BUCKET).list(folder, { limit: 1000, search: name });
  if (error) throw new Error(`exists ${path}: ${error.message}`);
  return (data ?? []).some((entry) => entry.name === name && entry.id != null);
}

/** 食事を作る (service_role。隠し状態の列は service_role だけが書ける) */
async function insertMeal(userId: string, photoUrl: string | null, hiddenAt: string | null): Promise<string> {
  const { data, error } = await srAdmin
    .from('meals')
    .insert({
      user_id: userId,
      eaten_at: new Date().toISOString(),
      meal_type: 'dinner',
      memo: `#1538 ${RUN}`,
      photo_url: photoUrl,
      hidden_at: hiddenAt,
      hidden_reason: hiddenAt ? 'moderation:delete_only' : null,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`insert meal: ${error?.message}`);
  return data.id as string;
}

async function insertRecipe(key: string, userId: string, imageUrl: string | null, hiddenAt: string | null): Promise<string> {
  const { data, error } = await srAdmin
    .from('recipes')
    .insert({
      user_id: userId,
      name: RECIPE_NAME(key),
      is_public: true,
      image_url: imageUrl,
      hidden_at: hiddenAt,
      hidden_reason: hiddenAt ? 'moderation:delete_only' : null,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`insert recipe ${key}: ${error?.message}`);
  return data.id as string;
}

async function rowExists(table: 'meals' | 'recipes', id: string): Promise<boolean> {
  const { data, error } = await srAdmin.from(table).select('id').eq('id', id).maybeSingle();
  if (error) throw new Error(`read ${table}: ${error.message}`);
  return data !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 登場人物と、作る行
// ─────────────────────────────────────────────────────────────────────────────

let owner: string;
let other: string;

const paths = {
  m89: '', m90: '', m91: '', visible: '', pasteShared: '', laterShared: '', others: '', r89: '', r91: '',
};
const ids = {
  m89: '', m90: '', m91: '', visible: '', pasteSource: '', pasteCopy: '', laterMeal: '', laterRecipe: '', foreign: '',
  r89: '', r91: '', flag: '', plannedMeal: '',
};

let firstRun: HiddenContentPurgeResult;

beforeAll(async () => {
  owner = await createUser('owner');
  other = await createUser('other');

  const pathOf = (userId: string, key: string) => `${userId}/i1538-${RUN}-${key}.png`;
  paths.m89 = pathOf(owner, 'm89');
  paths.m90 = pathOf(owner, 'm90');
  paths.m91 = pathOf(owner, 'm91');
  paths.visible = pathOf(owner, 'visible');
  paths.pasteShared = pathOf(owner, 'paste');
  paths.laterShared = pathOf(owner, 'later');
  paths.others = pathOf(other, 'others');
  paths.r89 = pathOf(owner, 'r89');
  paths.r91 = pathOf(owner, 'r91');

  // A / B: 89 日・90 日ちょうど・91 日・隠していない
  ids.m89 = await insertMeal(owner, await putObject(paths.m89), hiddenDaysAgo(DAYS_BEFORE));
  ids.m90 = await insertMeal(owner, await putObject(paths.m90), hiddenDaysAgo(HIDDEN_CONTENT_RETENTION_DAYS));
  ids.m91 = await insertMeal(owner, await putObject(paths.m91), hiddenDaysAgo(DAYS_AFTER));
  ids.visible = await insertMeal(owner, await putObject(paths.visible), null);
  ids.r89 = await insertRecipe('r89', owner, await putObject(paths.r89), hiddenDaysAgo(DAYS_BEFORE));
  ids.r91 = await insertRecipe('r91', owner, await putObject(paths.r91), hiddenDaysAgo(DAYS_AFTER));

  // C: 同じ画像を、隠していない複製 (家族への貼り付けで中身を書き換えて隠さなかった行) が使っている
  const pasteUrl = await putObject(paths.pasteShared);
  ids.pasteSource = await insertMeal(owner, pasteUrl, hiddenDaysAgo(DAYS_AFTER));
  ids.pasteCopy = await insertMeal(other, pasteUrl, null);
  // C: 同じ画像を、まだ 90 日たっていない隠したレシピが使っている
  const laterUrl = await putObject(paths.laterShared);
  ids.laterMeal = await insertMeal(owner, laterUrl, hiddenDaysAgo(DAYS_AFTER));
  ids.laterRecipe = await insertRecipe('later', owner, laterUrl, hiddenDaysAgo(DAYS_BEFORE));
  // C: 自分の行の URL に他人のファイルを入れて隠された行
  ids.foreign = await insertMeal(owner, await putObject(paths.others), hiddenDaysAgo(DAYS_AFTER));

  // D: 91 日の食事への通報と、その食事を実績にした献立
  const { data: flag, error: flagError } = await srAdmin
    .from('moderation_flags')
    .insert({ meal_id: ids.m91, user_id: other, reason: `#1538 ${RUN}`, status: 'rejected' })
    .select('id')
    .single();
  if (flagError || !flag) throw new Error(`insert flag: ${flagError?.message}`);
  ids.flag = flag.id as string;

  const { data: day, error: dayError } = await srAdmin
    .from('user_daily_meals')
    .insert({ user_id: owner, day_date: '2026-01-01' })
    .select('id')
    .single();
  if (dayError || !day) throw new Error(`insert user_daily_meals: ${dayError?.message}`);
  const { data: planned, error: plannedError } = await srAdmin
    .from('planned_meals')
    .insert({ daily_meal_id: day.id, meal_type: 'dinner', dish_name: `#1538 ${RUN}`, actual_meal_id: ids.m91 })
    .select('id')
    .single();
  if (plannedError || !planned) throw new Error(`insert planned_meals: ${plannedError?.message}`);
  ids.plannedMeal = planned.id as string;

  firstRun = await purgeExpiredHiddenContent(srAdmin, { now: NOW });
}, 120_000);

afterAll(async () => {
  // recipes.user_id は ON DELETE SET NULL なので、ユーザーより先に行を消す
  await srAdmin.from('recipes').delete().like('name', `#1538 purge % ${RUN}`);
  for (const userId of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(userId);
  }
  if (uploadedPaths.length > 0) await srAdmin.storage.from(BUCKET).remove(uploadedPaths);
}, 60_000);

// ─────────────────────────────────────────────────────────────────────────────

describe('#1538 A. 89 日では消さない・91 日で消える・隠していない行は消さない', () => {
  it('食事: 89 日と 90 日ちょうどの隠した行、隠していない行は残る。91 日の行は消える', async () => {
    expect(await rowExists('meals', ids.m89)).toBe(true);
    expect(await rowExists('meals', ids.m90)).toBe(true);
    expect(await rowExists('meals', ids.visible)).toBe(true);
    expect(await rowExists('meals', ids.m91)).toBe(false);
  });

  it('レシピ: 89 日の隠した行は残り、91 日の行は消える', async () => {
    expect(await rowExists('recipes', ids.r89)).toBe(true);
    expect(await rowExists('recipes', ids.r91)).toBe(false);
  });

  it('期限は「今」の 90 日前で、処理を最後まで終えた', () => {
    expect(firstRun.cutoff).toBe(hiddenDaysAgo(HIDDEN_CONTENT_RETENTION_DAYS));
    expect(firstRun.completed).toBe(true);
    // この実行で作った 91 日の行 (食事 4・レシピ 1) は消えている (ほかのテストの行も数に入りうるので、以上で見る)
    expect(firstRun.deleted_rows.meals).toBeGreaterThanOrEqual(4);
    expect(firstRun.deleted_rows.recipes).toBeGreaterThanOrEqual(1);
  });
});

describe('#1538 B. 画像も消える', () => {
  it('91 日の食事・レシピの画像は Storage から消える', async () => {
    expect(await exists(paths.m91)).toBe(false);
    expect(await exists(paths.r91)).toBe(false);
  });

  it('消えない行 (89 日・90 日ちょうど・隠していない) の画像は残る', async () => {
    for (const path of [paths.m89, paths.m90, paths.visible, paths.r89]) {
      expect(await exists(path), path).toBe(true);
    }
  });
});

describe('#1538 C. 画像を消さないもの (行は消える)', () => {
  it('隠していない複製が使っている画像は残る。隠した元の行は消え、複製は残る', async () => {
    expect(await rowExists('meals', ids.pasteSource)).toBe(false);
    expect(await rowExists('meals', ids.pasteCopy)).toBe(true);
    expect(await exists(paths.pasteShared)).toBe(true);
  });

  it('まだ 90 日たっていない隠した行が使っている画像は残る', async () => {
    expect(await rowExists('meals', ids.laterMeal)).toBe(false);
    expect(await rowExists('recipes', ids.laterRecipe)).toBe(true);
    expect(await exists(paths.laterShared)).toBe(true);
  });

  it('自分の行の URL に入れた他人のファイルは消さない', async () => {
    expect(await rowExists('meals', ids.foreign)).toBe(false);
    expect(await exists(paths.others)).toBe(true);
  });

  it('画像の確認の関数は、期限を過ぎた隠した行を数えず、それ以外の行の URL に含まれる部分だけを返す', async () => {
    const needles = [`/${BUCKET}/${paths.pasteShared}`, `/${BUCKET}/${paths.laterShared}`, `/${BUCKET}/${owner}/i1538-${RUN}-none.png`];
    const { data, error } = await srAdmin.rpc('hidden_content_purge_referenced_needles', {
      p_needles: needles,
      p_cutoff: hiddenDaysAgo(HIDDEN_CONTENT_RETENTION_DAYS),
    });
    expect(error).toBeNull();
    expect([...(data as string[])].sort()).toEqual([needles[0], needles[1]].sort());

    // 期限を 89 日の行より後ろ (88 日前) にすると、89 日の隠したレシピも「消える行」になり、数えなくなる
    const later = await srAdmin.rpc('hidden_content_purge_referenced_needles', {
      p_needles: [needles[1]],
      p_cutoff: hiddenDaysAgo(DAYS_BEFORE - 1),
    });
    expect(later.error).toBeNull();
    expect(later.data).toEqual([]);
  });
});

describe('#1538 D. 関連の行', () => {
  it('通報は CASCADE で一緒に消え、献立の実績は NULL になって残る', async () => {
    const { data: flag } = await srAdmin.from('moderation_flags').select('id').eq('id', ids.flag).maybeSingle();
    expect(flag).toBeNull();
    const { data: planned, error } = await srAdmin
      .from('planned_meals')
      .select('id, actual_meal_id')
      .eq('id', ids.plannedMeal)
      .single();
    expect(error).toBeNull();
    expect(planned).toEqual({ id: ids.plannedMeal, actual_meal_id: null });
  });
});

describe('#1538 E. pg_cron のジョブと呼び出し', () => {
  it(`ジョブ ${JOB_NAME} が 1 つだけ、毎日 18:25 UTC に、postgres の権限で、有効な状態で登録されている`, async () => {
    const jobs = await pgQuery(`
      SET LOCAL ROLE postgres;
      SELECT schedule, command, username, active FROM cron.job WHERE jobname = ${lit(JOB_NAME)};
    `);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ schedule: JOB_SCHEDULE, username: 'postgres', active: true });
    expect(String(jobs[0].command).trim()).toBe(`SELECT ${INVOKE_SIGNATURE}`);
  });

  it('Vault に app_cron_secret が無いと、呼び出しの関数は例外で失敗する', async () => {
    const result = await pgQueryRaw(`
      SET LOCAL ROLE postgres;
      DELETE FROM vault.secrets WHERE name = 'app_cron_secret';
      SELECT ${INVOKE_SIGNATURE};
    `);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('app_cron_secret not found in Vault');
  });

  it('app_cron_secret があると、Edge Function purge-hidden-content への POST を Bearer 付きで積む (ロールバックして送らない)', async () => {
    const secret = `i1538-secret-${RUN}`;
    const result = await pgQueryRaw(`
      SET LOCAL ROLE postgres;
      DELETE FROM vault.secrets WHERE name = 'app_cron_secret';
      SELECT vault.create_secret(${lit(secret)}, 'app_cron_secret');
      DO $$
      DECLARE
        v_id bigint;
        v_row jsonb;
      BEGIN
        v_id := ${INVOKE_SIGNATURE};
        SELECT jsonb_build_object('method', method, 'url', url, 'headers', headers, 'body', convert_from(body, 'UTF8')::jsonb,
                                  'timeout_milliseconds', timeout_milliseconds)
          INTO v_row FROM net.http_request_queue WHERE id = v_id;
        RAISE EXCEPTION '${RESULT_MARK}%', v_row::text;
      END $$;
    `);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const index = result.message.indexOf(RESULT_MARK);
    expect(index).toBeGreaterThanOrEqual(0);
    const request = JSON.parse(result.message.slice(index + RESULT_MARK.length)) as {
      method: string;
      url: string;
      headers: Record<string, string>;
      body: unknown;
      timeout_milliseconds: number;
    };
    expect(request.method).toBe('POST');
    expect(request.url).toBe(EDGE_FUNCTION_URL);
    expect(request.headers.Authorization).toBe(`Bearer ${secret}`);
    expect(request.body).toEqual({});
  });
});

describe('#1538 F. 権限', () => {
  it('anon / authenticated / service_role は呼び出しの関数を EXECUTE できない。画像の確認の関数は service_role だけ', async () => {
    const rows = await pgQuery(`
      SELECT r.rolname,
             has_function_privilege(r.rolname, ${lit(INVOKE_SIGNATURE)}, 'EXECUTE') AS invoke,
             has_function_privilege(r.rolname, ${lit(NEEDLES_SIGNATURE)}, 'EXECUTE') AS needles
      FROM pg_roles r
      WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
      ORDER BY r.rolname;
    `);
    expect(rows).toEqual([
      { rolname: 'anon', invoke: false, needles: false },
      { rolname: 'authenticated', invoke: false, needles: false },
      { rolname: 'service_role', invoke: false, needles: true },
    ]);
  });
});

describe('#1538 G. やり直せる', () => {
  it('もう一度流しても成功し、残すべき行と画像は残ったまま', async () => {
    const second = await purgeExpiredHiddenContent(srAdmin, { now: NOW });
    expect(second.completed).toBe(true);
    expect(await rowExists('meals', ids.m89)).toBe(true);
    expect(await rowExists('meals', ids.pasteCopy)).toBe(true);
    expect(await exists(paths.pasteShared)).toBe(true);
    expect(await exists(paths.m89)).toBe(true);
  });
});
