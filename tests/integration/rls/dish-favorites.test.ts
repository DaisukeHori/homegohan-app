/**
 * dish_favorites の RLS・権限・制約を実 DB で確かめる (docs/design/cross/22-dish-favorites.md §7.14)
 *
 *   I-1. 本人は自分の行を INSERT / SELECT / UPDATE / DELETE できる
 *   I-2. 他人の行は SELECT で 0 行・UPDATE / DELETE で 0 行 (エラーにならず、行は変わらない)。他人の user_id で INSERT すると 42501
 *   I-3. anon は SELECT / INSERT ともに権限が無い (42501)
 *   I-4. UNIQUE (user_id, dish_name_key): 同じ鍵の 2 行目は 23505。upsert (on_conflict) は 1 行のまま写しを置き換える
 *   I-5. CHECK: 名前が空・101 文字・dish がオブジェクトでない・写しが jsonb の文字列で 65536 バイト超 は 23514
 *   I-6. 退会 (auth.users の削除) で行が消える (CASCADE)
 *   I-7. updated_at は UPDATE で進む (トリガー。前の値より厳密に後)
 *   I-8. route が通す最大の写し (JSON.stringify で 32768 バイト・数 80 個 (栄養 30 個と構造の形の材料 50 件の amount_g) が jsonb の文字列で最も長くなる値) は CHECK に当たらない
 *
 * 前提: ローカル Supabase (bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local)
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/dish-favorites.test.ts
 * 作った行と利用者は afterAll で消す。本番には接続しない。
 */
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const TABLE = 'dish_favorites';
/** Postgres のエラーコード */
const PG_INSUFFICIENT_PRIVILEGE = '42501';
const PG_UNIQUE_VIOLATION = '23505';
const PG_CHECK_VIOLATION = '23514';
/** 名前の上限 (core.ts の DISH_FAVORITE_NAME_MAX_CHARS と同じ値。DB の CHECK を直接見るので数を書く) */
const NAME_MAX_CHARS = 100;
/** route が見る写しの上限 (core.ts の DISH_FAVORITE_DISH_MAX_BYTES と同じ値。JSON.stringify の UTF-8 の長さ) */
const DISH_MAX_BYTES = 32768;
/** DB の CHECK dish_favorites_dish_size の値 (core.ts の DISH_FAVORITE_DISH_DB_MAX_BYTES と同じ値。jsonb の文字列の長さ) */
const DISH_DB_MAX_BYTES = 65536;
/** markdown の長さの上限 (core.ts の DISH_FAVORITE_MARKDOWN_MAX_CHARS と同じ値) */
const MARKDOWN_MAX_CHARS = 8000;
/** 材料の件数の上限 (core.ts の DISH_FAVORITE_INGREDIENTS_MAX_ITEMS と同じ値) */
const INGREDIENTS_MAX_ITEMS = 50;
/** 写しの数の項目 (core.ts の DishSnapshotSchema の calories_kcal と栄養 29 項目。構造の形の材料の amount_g は I-8 が別に埋める) */
const NUMBER_KEYS = [
  'calories_kcal',
  'protein_g',
  'fat_g',
  'carbs_g',
  'sodium_g',
  'sugar_g',
  'fiber_g',
  'fiber_soluble_g',
  'fiber_insoluble_g',
  'potassium_mg',
  'calcium_mg',
  'phosphorus_mg',
  'magnesium_mg',
  'iron_mg',
  'zinc_mg',
  'iodine_ug',
  'cholesterol_mg',
  'vitamin_a_ug',
  'vitamin_b1_mg',
  'vitamin_b2_mg',
  'vitamin_b6_mg',
  'vitamin_b12_ug',
  'vitamin_c_mg',
  'vitamin_d_ug',
  'vitamin_e_mg',
  'vitamin_k_ug',
  'folic_acid_ug',
  'saturated_fat_g',
  'monounsaturated_fat_g',
  'polyunsaturated_fat_g',
] as const;

function client(key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

const admin = client(serviceKey);

interface TestUser {
  id: string;
  email: string;
  db: SupabaseClient;
}

async function createUser(tag: string): Promise<TestUser> {
  const email = `dish-fav-${tag}-${randomUUID()}@example.com`;
  const password = `Pw-${randomUUID()}`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error(`createUser: ${created.error?.message}`);
  const db = client(anonKey);
  const signed = await db.auth.signInWithPassword({ email, password });
  if (signed.error) throw new Error(`signIn: ${signed.error.message}`);
  return { id: created.data.user.id, email, db };
}

/** 最小の写し (core.ts の DishSnapshotSchema の形。材料は 1 行の文字列と構造の形の両方) */
function dishOf(name: string): Record<string, unknown> {
  return {
    name,
    role: 'main',
    calories_kcal: 320,
    ingredients: ['じゃがいも 2個', { name: '牛肉', amount_g: 150, note: null }],
    recipe_steps: ['切る', '煮る'],
    ingredients_md: null,
    recipe_steps_md: null,
  };
}

function rowOf(userId: string, name: string, key = name): Record<string, unknown> {
  return { user_id: userId, dish_name: name, dish_name_key: key, dish: dishOf(name) };
}

let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  alice = await createUser('alice');
  bob = await createUser('bob');
});

afterAll(async () => {
  for (const user of [alice, bob]) {
    if (!user) continue;
    await admin.from(TABLE).delete().eq('user_id', user.id);
    await admin.auth.admin.deleteUser(user.id);
  }
});

describe('dish_favorites: 本人の行 (I-1・I-7)', () => {
  it('I-1: 本人は INSERT / SELECT / UPDATE / DELETE できる', async () => {
    const inserted = await alice.db.from(TABLE).insert(rowOf(alice.id, 'I-1 肉じゃが')).select('id, dish_name, updated_at').single();
    expect(inserted.error).toBeNull();
    const id = inserted.data!.id as string;

    const read = await alice.db.from(TABLE).select('id').eq('id', id);
    expect(read.data).toHaveLength(1);

    const updated = await alice.db.from(TABLE).update({ dish: dishOf('I-1 肉じゃが (改)') }).eq('id', id).select('updated_at').single();
    expect(updated.error).toBeNull();
    // I-7: updated_at はトリガーで進む。INSERT と UPDATE は別の要求 (別のトランザクション) なので now() は厳密に後になる。
    // マイクロ秒まで比べるため DB で比べる (トリガーが無ければ updated_at は INSERT の値のままで、0 行になる)
    const advanced = await alice.db.from(TABLE).select('id').eq('id', id).gt('updated_at', inserted.data!.updated_at as string);
    expect(advanced.error).toBeNull();
    expect(advanced.data).toHaveLength(1);

    const deleted = await alice.db.from(TABLE).delete().eq('id', id).select('id');
    expect(deleted.data).toHaveLength(1);
  });
});

describe('dish_favorites: 他人と anon (I-2・I-3)', () => {
  let bobRowId: string;

  beforeAll(async () => {
    const inserted = await admin.from(TABLE).insert(rowOf(bob.id, 'I-2 bob の料理')).select('id').single();
    bobRowId = inserted.data!.id as string;
  });

  it('I-2: 他人の行は SELECT で 0 行、UPDATE / DELETE で 0 行 (行は変わらない)', async () => {
    const read = await alice.db.from(TABLE).select('id').eq('id', bobRowId);
    expect(read.error).toBeNull();
    expect(read.data).toEqual([]);

    const updated = await alice.db.from(TABLE).update({ dish_name: 'alice が書き換え' }).eq('id', bobRowId).select('id');
    expect(updated.error).toBeNull();
    expect(updated.data).toEqual([]);

    const deleted = await alice.db.from(TABLE).delete().eq('id', bobRowId).select('id');
    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual([]);

    const still = await admin.from(TABLE).select('dish_name').eq('id', bobRowId).single();
    expect(still.data?.dish_name).toBe('I-2 bob の料理');
  });

  it('I-2: 他人の user_id で INSERT すると 42501 (WITH CHECK)', async () => {
    const inserted = await alice.db.from(TABLE).insert(rowOf(bob.id, 'I-2 なりすまし'));
    expect(inserted.error?.code).toBe(PG_INSUFFICIENT_PRIVILEGE);
  });

  it('I-3: anon は SELECT も INSERT もできない (42501)', async () => {
    const anon = client(anonKey);
    const read = await anon.from(TABLE).select('id').limit(1);
    expect(read.error?.code).toBe(PG_INSUFFICIENT_PRIVILEGE);
    const inserted = await anon.from(TABLE).insert(rowOf(alice.id, 'I-3 anon'));
    expect(inserted.error?.code).toBe(PG_INSUFFICIENT_PRIVILEGE);
  });
});

describe('dish_favorites: 制約 (I-4・I-5・I-8)', () => {
  it('I-4: 同じ鍵の 2 行目は 23505。upsert は 1 行のまま写しを置き換える', async () => {
    const first = await alice.db.from(TABLE).insert(rowOf(alice.id, 'I-4 カレー', 'i-4 カレー')).select('id').single();
    expect(first.error).toBeNull();
    const second = await alice.db.from(TABLE).insert(rowOf(alice.id, 'I-4 カレー', 'i-4 カレー'));
    expect(second.error?.code).toBe(PG_UNIQUE_VIOLATION);

    const upserted = await alice.db
      .from(TABLE)
      .upsert({ ...rowOf(alice.id, 'I-4 カレー', 'i-4 カレー'), dish: dishOf('I-4 カレー (2 回目)') }, { onConflict: 'user_id,dish_name_key' })
      .select('id, dish')
      .single();
    expect(upserted.error).toBeNull();
    expect(upserted.data!.id).toBe(first.data!.id);
    expect((upserted.data!.dish as { name: string }).name).toBe('I-4 カレー (2 回目)');
    const rows = await alice.db.from(TABLE).select('id').eq('dish_name_key', 'i-4 カレー');
    expect(rows.data).toHaveLength(1);
  });

  it.each([
    ['名前が空', { dish_name: '', dish_name_key: 'x' }],
    ['名前が上限 + 1 文字', { dish_name: 'あ'.repeat(NAME_MAX_CHARS + 1), dish_name_key: 'y' }],
    ['dish がオブジェクトでない', { dish_name: 'I-5 配列', dish_name_key: 'i-5 配列', dish: ['not', 'an', 'object'] }],
    ['写しが上限を超える', { dish_name: 'I-5 大きい', dish_name_key: 'i-5 大きい', dish: { name: 'I-5 大きい', recipe_steps_md: 'x'.repeat(DISH_DB_MAX_BYTES) } }],
  ])('I-5: %s は 23514', async (_name, patch) => {
    const inserted = await alice.db.from(TABLE).insert({ ...rowOf(alice.id, 'I-5'), ...patch });
    expect(inserted.error?.code).toBe(PG_CHECK_VIOLATION);
  });

  it('I-8: route が通す最大の写し (JSON.stringify で 32768 バイト・数 80 個 (栄養 30 個と構造の形の材料 50 件の amount_g) が jsonb の文字列で最も長くなる値) は CHECK に当たらない', async () => {
    // Number.MIN_VALUE は JSON.stringify では '5e-324' (6 バイト) だが、jsonb の文字列では 0.000…5 (326 バイト) になる。
    // 材料は構造の形を上限の件数まで並べ、どの amount_g も Number.MIN_VALUE にする (jsonb の文字列で長くなる数と区切りの空白が最も多い形)。
    // markdown は Zod の上限 (MARKDOWN_MAX_CHARS 文字) の中で埋める: 材料の md を 3 バイトの文字で上限まで、残りを作り方の md に 1 バイトの文字で
    const ingredients = Array.from({ length: INGREDIENTS_MAX_ITEMS }, () => ({ name: 'x', amount_g: Number.MIN_VALUE, note: null }));
    const base: Record<string, unknown> = {
      ...dishOf('I-8 大きい'),
      ingredients,
      ingredients_md: 'あ'.repeat(MARKDOWN_MAX_CHARS),
      recipe_steps_md: '',
    };
    for (const key of NUMBER_KEYS) base[key] = Number.MIN_VALUE;
    const padding = DISH_MAX_BYTES - Buffer.byteLength(JSON.stringify(base), 'utf8');
    expect(padding).toBeGreaterThan(0);
    expect(padding).toBeLessThanOrEqual(MARKDOWN_MAX_CHARS);
    const dish = { ...base, recipe_steps_md: 'x'.repeat(padding) };
    expect(Buffer.byteLength(JSON.stringify(dish), 'utf8')).toBe(DISH_MAX_BYTES);

    const inserted = await alice.db.from(TABLE).insert({ ...rowOf(alice.id, 'I-8 大きい', 'i-8 大きい'), dish }).select('id').single();
    expect(inserted.error).toBeNull();
  });
});

describe('dish_favorites: 退会 (I-6)', () => {
  it('I-6: auth.users の削除で行が消える (CASCADE)', async () => {
    const carol = await createUser('carol');
    const inserted = await carol.db.from(TABLE).insert(rowOf(carol.id, 'I-6 消える料理')).select('id').single();
    expect(inserted.error).toBeNull();
    const removed = await admin.auth.admin.deleteUser(carol.id);
    expect(removed.error).toBeNull();
    const after = await admin.from(TABLE).select('id').eq('id', inserted.data!.id as string);
    expect(after.data).toEqual([]);
  });
});
