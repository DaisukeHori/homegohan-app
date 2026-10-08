/**
 * #1148 機能フラグの一本化: feature_flags に最初の 4 行を入れる migration の回帰テスト
 *
 * 20261008140200_unify_feature_flags_seed.sql は、旧の置き場 (system_settings の key = 'feature_flags') から
 * 新しい置き場 (feature_flags テーブル) へ、献立生成の 2 つのフラグを引き継ぎ、AI 相談の緊急停止スイッチと
 * メンテナンスモードの行を作る。
 *
 * 確認すること:
 *   A. ファイル: migration と rollback が同じ version / 名前で対になっていて、rollback は migration が書いた description と一致する行だけを消す
 *   B. 適用後の状態 (このテストが migration を流さなくても): 4 つのフラグの行がある。
 *      ai_chat_enabled は ON、maintenance_mode は OFF (デプロイした瞬間に AI 相談が止まる・メンテナンスになることが無い)
 *   C. 引き継ぎ (migration の SQL をこのテストが流して確かめる):
 *      - 旧の行が無ければ、献立生成は ON (旧のコードの既定値)
 *      - 旧の menu_generation_v5_* が JSON の false なら、その値で作る
 *      - ai_chat_enabled / maintenance_mode は、旧の値 (false / true) が入っていても引き継がず、ON / OFF で作る
 *      - true / false 以外の値 (文字列・null・数値) は引き継がず、ON にする
 *      - 旧の system_settings の行は変えない
 *   D. 冪等: 2 回流しても同じ。すでにある行 (運営画面で切り替えた状態を含む) は書き換えない。一部の行だけがあれば足りない行だけを作る
 *   E. rollback: migration が作った行だけが消え、同じ key の別の行 (description が違う) と、description を書き換えた行は残る。2 回流してもエラーにならない
 *
 * migration の SQL は、本番 (supabase db push) と同じ postgres ロールで、ローカルスタックの postgres-meta (/pg/query) から流す。
 * 本番には接続しない。テストが触る行 (feature_flags の 4 行と system_settings の feature_flags) は、始める前の状態を控えておき、
 * 終わったら元に戻す。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/feature-flags-seed.test.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { supabaseAdmin } from '../helpers/supabase';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const REPO_ROOT = path.resolve(__dirname, '../../..');
const VERSION = '20261008140200';
const NAME = 'unify_feature_flags_seed';
const MIGRATION_FILE = `supabase/migrations/${VERSION}_${NAME}.sql`;
const ROLLBACK_FILE = `supabase/rollbacks/${VERSION}_${NAME}.down.sql`;
const MIGRATION_SQL = fs.readFileSync(path.join(REPO_ROOT, MIGRATION_FILE), 'utf8');
const ROLLBACK_SQL = fs.readFileSync(path.join(REPO_ROOT, ROLLBACK_FILE), 'utf8');

const SEEDED_KEYS = [
  'ai_chat_enabled',
  'maintenance_mode',
  'menu_generation_v5_wrapped',
  'menu_generation_v5_direct',
] as const;
type SeededKey = (typeof SEEDED_KEYS)[number];

interface FlagRow {
  id: string;
  key: string;
  description: string | null;
  enabled: boolean;
  rollout_strategy: unknown;
  constraints: unknown;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface SettingRow {
  key: string;
  value: unknown;
  description: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

/** ローカルスタックの postgres-meta で SQL を流す (migration / rollback の実行にだけ使う) */
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

/** 本番の migration と同じ postgres ロールで流す (このリクエストの中だけ) */
function asPostgres(sql: string): Promise<Record<string, unknown>[]> {
  return pgQuery(`SET LOCAL ROLE postgres;\n${sql}`);
}

async function runMigration(): Promise<void> {
  await asPostgres(MIGRATION_SQL);
}

async function runRollback(): Promise<void> {
  await asPostgres(ROLLBACK_SQL);
}

async function selectFlags(keys: readonly string[] = SEEDED_KEYS): Promise<Map<string, FlagRow>> {
  const { data, error } = await supabaseAdmin.from('feature_flags').select('*').in('key', [...keys]);
  expect(error, 'feature_flags の SELECT').toBeNull();
  return new Map((data as FlagRow[]).map((row) => [row.key, row]));
}

async function deleteSeededFlags(): Promise<void> {
  const { error } = await supabaseAdmin.from('feature_flags').delete().in('key', [...SEEDED_KEYS]);
  expect(error, 'feature_flags の DELETE').toBeNull();
}

async function selectLegacySetting(): Promise<SettingRow | null> {
  const { data, error } = await supabaseAdmin
    .from('system_settings')
    .select('*')
    .eq('key', 'feature_flags')
    .maybeSingle();
  expect(error, 'system_settings の SELECT').toBeNull();
  return (data as SettingRow | null) ?? null;
}

async function setLegacySetting(value: unknown): Promise<void> {
  const { error } = await supabaseAdmin
    .from('system_settings')
    .upsert({ key: 'feature_flags', value, updated_at: new Date().toISOString() });
  expect(error, 'system_settings の UPSERT').toBeNull();
}

async function deleteLegacySetting(): Promise<void> {
  const { error } = await supabaseAdmin.from('system_settings').delete().eq('key', 'feature_flags');
  expect(error, 'system_settings の DELETE').toBeNull();
}

function enabledOf(rows: Map<string, FlagRow>, key: SeededKey): boolean {
  const row = rows.get(key);
  expect(row, `${key} の行が無い`).toBeDefined();
  return row!.enabled;
}

// ---------------------------------------------------------------
// テストの前後で元の状態に戻す
// ---------------------------------------------------------------
let originalFlags: FlagRow[] = [];
let originalSetting: SettingRow | null = null;

beforeAll(async () => {
  originalFlags = [...(await selectFlags()).values()];
  originalSetting = await selectLegacySetting();
});

afterAll(async () => {
  await deleteSeededFlags();
  if (originalFlags.length > 0) {
    const { error } = await supabaseAdmin.from('feature_flags').insert(originalFlags);
    expect(error, 'feature_flags の復元').toBeNull();
  }
  if (originalSetting) {
    const { error } = await supabaseAdmin.from('system_settings').upsert(originalSetting);
    expect(error, 'system_settings の復元').toBeNull();
  } else {
    await deleteLegacySetting();
  }
});

// ---------------------------------------------------------------
// A. ファイル
// ---------------------------------------------------------------
describe('#1148 A. migration と rollback のファイル', () => {
  it('migration と rollback が同じ version / 名前で対になっている', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, MIGRATION_FILE)), `${MIGRATION_FILE} が無い`).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, ROLLBACK_FILE)), `${ROLLBACK_FILE} が無い`).toBe(true);
  });

  it('migration は既存の行を書き換えない書き方 (ON CONFLICT DO NOTHING) で、UPDATE / DELETE を含まない', () => {
    const code = MIGRATION_SQL.split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(code).toMatch(/ON CONFLICT \(key\) DO NOTHING/);
    expect(code, '既存の行を UPDATE しない').not.toMatch(/\bUPDATE\b/i);
    expect(code, '既存の行を DELETE しない').not.toMatch(/\bDELETE\b/i);
    expect(code, 'CHECK 制約を足さない').not.toMatch(/\bCHECK\b/i);
  });

  it('rollback は key と description の両方が一致する行だけを消す', () => {
    const code = ROLLBACK_SQL.split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(code).toMatch(/DELETE FROM public\.feature_flags/);
    expect(code).toMatch(/f\.key = seeded\.key/);
    expect(code).toMatch(/f\.description = seeded\.description/);
  });
});

// ---------------------------------------------------------------
// B. 適用後の状態 (このテストが migration を流さなくても、DB に入っているはずの状態)
//    CI は空の DB に全 migration を流してから、この検査をする。
// ---------------------------------------------------------------
describe('#1148 B. migration を適用した DB の状態', () => {
  it('4 つのフラグの行がある。ai_chat_enabled は ON、maintenance_mode は OFF (デプロイで止まらない)', async () => {
    const rows = await selectFlags();

    for (const key of SEEDED_KEYS) {
      expect(rows.has(key), `feature_flags に ${key} の行が無い`).toBe(true);
    }
    expect(enabledOf(rows, 'ai_chat_enabled'), 'ai_chat_enabled は ON').toBe(true);
    expect(enabledOf(rows, 'maintenance_mode'), 'maintenance_mode は OFF').toBe(false);
    expect(typeof enabledOf(rows, 'menu_generation_v5_wrapped')).toBe('boolean');
    expect(typeof enabledOf(rows, 'menu_generation_v5_direct')).toBe('boolean');
  });

  it('全ユーザーが対象 (rollout_strategy / constraints は NULL)。description に #1148 を書いてある', async () => {
    const rows = await selectFlags();
    for (const key of SEEDED_KEYS) {
      const row = rows.get(key);
      expect(row, `feature_flags に ${key} の行が無い`).toBeDefined();
      expect(row!.rollout_strategy, `${key} は全ユーザー対象`).toBeNull();
      expect(row!.constraints, `${key} に条件は付けない`).toBeNull();
      expect(row!.description ?? '', `${key} の description`).toContain('#1148');
    }
  });
});

// ---------------------------------------------------------------
// C. 旧の system_settings からの引き継ぎ
// ---------------------------------------------------------------
describe('#1148 C. 旧の system_settings.feature_flags からの引き継ぎ', () => {
  it('旧の行が無ければ、献立生成は ON (旧のコードの既定値)、AI 相談は ON、メンテナンスは OFF', async () => {
    await deleteSeededFlags();
    await deleteLegacySetting();

    await runMigration();

    const rows = await selectFlags();
    expect(enabledOf(rows, 'menu_generation_v5_wrapped')).toBe(true);
    expect(enabledOf(rows, 'menu_generation_v5_direct')).toBe(true);
    expect(enabledOf(rows, 'ai_chat_enabled')).toBe(true);
    expect(enabledOf(rows, 'maintenance_mode')).toBe(false);
  });

  it('旧の menu_generation_v5_* が false なら、その値で作る。旧の行は書き換えない', async () => {
    const legacy = {
      menu_generation_v5_wrapped: false,
      menu_generation_v5_direct: false,
      meal_photo_analysis: false,
    };
    await deleteSeededFlags();
    await setLegacySetting(legacy);
    const before = await selectLegacySetting();

    await runMigration();

    const rows = await selectFlags();
    expect(enabledOf(rows, 'menu_generation_v5_wrapped')).toBe(false);
    expect(enabledOf(rows, 'menu_generation_v5_direct')).toBe(false);
    expect(await selectLegacySetting(), '旧の system_settings の行はそのまま').toEqual(before);
  });

  it('片方だけ false なら、その 1 つだけが false になる', async () => {
    await deleteSeededFlags();
    await setLegacySetting({ menu_generation_v5_wrapped: true, menu_generation_v5_direct: false });

    await runMigration();

    const rows = await selectFlags();
    expect(enabledOf(rows, 'menu_generation_v5_wrapped')).toBe(true);
    expect(enabledOf(rows, 'menu_generation_v5_direct')).toBe(false);
  });

  it('旧の ai_chat_enabled = false / maintenance_mode = true は引き継がない (効いていなかった値で、デプロイ時に止めない)', async () => {
    await deleteSeededFlags();
    await setLegacySetting({ ai_chat_enabled: false, maintenance_mode: true });

    await runMigration();

    const rows = await selectFlags();
    expect(enabledOf(rows, 'ai_chat_enabled'), 'AI 相談は ON のまま').toBe(true);
    expect(enabledOf(rows, 'maintenance_mode'), 'メンテナンスは OFF のまま').toBe(false);
  });

  it('true / false 以外の値 (文字列・null・数値) は引き継がず、ON にする', async () => {
    await deleteSeededFlags();
    await setLegacySetting({ menu_generation_v5_wrapped: 'false', menu_generation_v5_direct: null });
    await runMigration();
    let rows = await selectFlags();
    expect(enabledOf(rows, 'menu_generation_v5_wrapped')).toBe(true);
    expect(enabledOf(rows, 'menu_generation_v5_direct')).toBe(true);

    await deleteSeededFlags();
    await setLegacySetting({ menu_generation_v5_wrapped: 0, menu_generation_v5_direct: 'off' });
    await runMigration();
    rows = await selectFlags();
    expect(enabledOf(rows, 'menu_generation_v5_wrapped')).toBe(true);
    expect(enabledOf(rows, 'menu_generation_v5_direct')).toBe(true);
  });

  it('旧の値がオブジェクトでない (配列・文字列) ときも失敗せず、既定値で作る', async () => {
    await deleteSeededFlags();
    await setLegacySetting(['menu_generation_v5_wrapped', false]);
    await runMigration();
    let rows = await selectFlags();
    expect(enabledOf(rows, 'menu_generation_v5_wrapped')).toBe(true);

    await deleteSeededFlags();
    await setLegacySetting('not an object');
    await runMigration();
    rows = await selectFlags();
    expect(enabledOf(rows, 'menu_generation_v5_wrapped')).toBe(true);
    expect(enabledOf(rows, 'ai_chat_enabled')).toBe(true);
    expect(enabledOf(rows, 'maintenance_mode')).toBe(false);
  });
});

// ---------------------------------------------------------------
// D. 冪等
// ---------------------------------------------------------------
describe('#1148 D. 冪等 (すでにある行は書き換えない)', () => {
  it('2 回流しても行は 4 つのまま。運営画面で切り替えた状態は元に戻らない', async () => {
    await deleteSeededFlags();
    await deleteLegacySetting();
    await runMigration();

    // 運営画面で切り替えた状態を再現する
    const edited = await supabaseAdmin
      .from('feature_flags')
      .update({ enabled: true, description: '運営が書き換えた説明' })
      .eq('key', 'maintenance_mode');
    expect(edited.error).toBeNull();
    const off = await supabaseAdmin.from('feature_flags').update({ enabled: false }).eq('key', 'ai_chat_enabled');
    expect(off.error).toBeNull();
    const before = await selectFlags();

    // 旧の値が違っていても、すでにある行には効かない
    await setLegacySetting({ menu_generation_v5_wrapped: false });
    await runMigration();

    const after = await selectFlags();
    expect(after.size).toBe(4);
    for (const key of SEEDED_KEYS) {
      expect(after.get(key), `${key} は書き換えられない`).toEqual(before.get(key));
    }
    expect(enabledOf(after, 'maintenance_mode')).toBe(true);
    expect(enabledOf(after, 'ai_chat_enabled')).toBe(false);
    expect(enabledOf(after, 'menu_generation_v5_wrapped')).toBe(true);
  });

  it('同じ key の行が先にあれば、その行はそのまま。足りない行だけが作られる', async () => {
    await deleteSeededFlags();
    await deleteLegacySetting();
    const pre = await supabaseAdmin
      .from('feature_flags')
      .insert({
        key: 'ai_chat_enabled',
        description: 'migration より前から本番にあった行',
        enabled: false,
        rollout_strategy: { type: 'percentage', value: 50 },
      })
      .select('*')
      .single();
    expect(pre.error).toBeNull();

    await runMigration();

    const rows = await selectFlags();
    expect(rows.size).toBe(4);
    expect(rows.get('ai_chat_enabled')).toEqual(pre.data);
    expect(enabledOf(rows, 'maintenance_mode')).toBe(false);
    expect(enabledOf(rows, 'menu_generation_v5_wrapped')).toBe(true);
  });
});

// ---------------------------------------------------------------
// E. rollback
// ---------------------------------------------------------------
describe('#1148 E. rollback', () => {
  it('migration が作った行だけが消える。2 回流してもエラーにならない', async () => {
    await deleteSeededFlags();
    await deleteLegacySetting();
    await runMigration();
    expect((await selectFlags()).size).toBe(4);

    await runRollback();
    expect((await selectFlags()).size, '4 行とも消える').toBe(0);

    await runRollback(); // 冪等
    expect((await selectFlags()).size).toBe(0);
  });

  it('同じ key の別の行 (description が違う) と、description を書き換えた行は消えない', async () => {
    await deleteSeededFlags();
    await deleteLegacySetting();
    const pre = await supabaseAdmin
      .from('feature_flags')
      .insert({ key: 'maintenance_mode', description: 'migration より前からあった行', enabled: true })
      .select('*')
      .single();
    expect(pre.error).toBeNull();
    await runMigration(); // maintenance_mode はそのまま、残り 3 行が作られる

    const edited = await supabaseAdmin
      .from('feature_flags')
      .update({ description: '運営が書き換えた説明' })
      .eq('key', 'ai_chat_enabled');
    expect(edited.error).toBeNull();

    await runRollback();

    const rows = await selectFlags();
    expect([...rows.keys()].sort()).toEqual(['ai_chat_enabled', 'maintenance_mode']);
    expect(rows.get('maintenance_mode')).toEqual(pre.data);
    expect(rows.get('ai_chat_enabled')!.description).toBe('運営が書き換えた説明');
  });

  it('rollback のあとに migration をもう一度流すと、4 行が元どおり作られる (往復できる)', async () => {
    await deleteSeededFlags();
    await deleteLegacySetting();
    await runMigration();
    await runRollback();
    await runMigration();

    const rows = await selectFlags();
    expect(rows.size).toBe(4);
    expect(enabledOf(rows, 'ai_chat_enabled')).toBe(true);
    expect(enabledOf(rows, 'maintenance_mode')).toBe(false);
  });
});
