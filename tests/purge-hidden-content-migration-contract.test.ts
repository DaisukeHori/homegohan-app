/**
 * #1538 運営が隠したコンテンツの完全削除: migration と Edge Function・本体の突き合わせ (DB を使わない静的な検査)
 *
 * migration 20261016100000_purge_hidden_content.sql の SQL と、supabase/functions/_shared/hidden-content-purge.ts の定数が
 * 食い違わないことを確かめる。DB の上での動きは tests/integration/security/purge-hidden-content.test.ts。
 *
 *   1. 完全削除の対象の表 (HIDDEN_CONTENT_TABLES) が、migration で hidden_at を足した表とちょうど同じ
 *      (隠す表を足したのに、完全削除の対象に入れ忘れることを防ぐ)
 *   2. pg_cron のジョブ・呼び先の Edge Function・応答の待ち時間が、本体の時間の上限と合っている
 *   3. 画像の確認の関数が、本体の呼ぶ名前と引数で作られ、service_role だけが呼べる。期限を過ぎた隠した行は数えない
 *   4. ロールバックがジョブと 2 つの関数を外す
 *   5. 隠す側のコード・テストの説明が、完全削除のジョブを「別の作業」「未定」と書かず、ジョブの名前を挙げる
 *      (ジョブを足したあとも古い説明が残ると、読んだ人が「隠した行は消えない」と誤解する)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HIDDEN_CONTENT_PURGE_MAX_DURATION_MS,
  HIDDEN_CONTENT_TABLES,
  REFERENCED_NEEDLES_RPC,
} from '../supabase/functions/_shared/hidden-content-purge';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');
const MIGRATION = 'supabase/migrations/20261016100000_purge_hidden_content.sql';
const ROLLBACK = 'supabase/rollbacks/20261016100000_purge_hidden_content.down.sql';
const EDGE_FUNCTION = 'purge-hidden-content';
const JOB_NAME = 'purge-hidden-content';
/** 毎日 03:25 JST (18:25 UTC) */
const JOB_SCHEDULE = '25 18 * * *';

const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
/** SQL の行コメント (-- から行末) を外す。コメントの中の語で検査が通らないようにする */
const stripSqlComments = (sql: string) => sql.replace(/--[^\n]*/g, '');

const sql = stripSqlComments(read(MIGRATION));
const rollback = stripSqlComments(read(ROLLBACK));

describe('#1538 1. 完全削除の対象の表', () => {
  it('HIDDEN_CONTENT_TABLES は、migration で hidden_at を足した表とちょうど同じ', () => {
    const tablesWithHiddenAt = new Set<string>();
    for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql'))) {
      const body = stripSqlComments(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      for (const match of body.matchAll(/ALTER TABLE\s+(?:public\.)?"?(\w+)"?\s+((?:[^;])*?)ADD COLUMN(?: IF NOT EXISTS)?\s+hidden_at\b/gi)) {
        tablesWithHiddenAt.add(match[1].toLowerCase());
      }
    }
    // 番兵: 読み取りが壊れて何も拾わなくなったときに素通りしない (#1101 で足した 2 つ)
    expect([...tablesWithHiddenAt].sort()).toEqual(expect.arrayContaining(['meals', 'recipes']));
    expect(HIDDEN_CONTENT_TABLES.map((spec) => spec.table).sort()).toEqual([...tablesWithHiddenAt].sort());
  });

  it('画像の列は meals.photo_url と recipes.image_url', () => {
    expect(HIDDEN_CONTENT_TABLES).toEqual([
      { table: 'meals', imageColumn: 'photo_url' },
      { table: 'recipes', imageColumn: 'image_url' },
    ]);
  });
});

describe('#1538 2. pg_cron のジョブと呼び先', () => {
  it(`ジョブ ${JOB_NAME} を毎日 03:25 JST に登録し、同じ名前のジョブを先に外す`, () => {
    expect(sql).toMatch(new RegExp(`WHERE jobname = '${JOB_NAME}'`));
    expect(sql).toContain(`cron.schedule(\n  '${JOB_NAME}',\n  '${JOB_SCHEDULE}',\n  $$ SELECT public.invoke_purge_hidden_content() $$\n)`);
  });

  it(`呼び先は Edge Function ${EDGE_FUNCTION} (リポジトリにある関数) で、verify_jwt = false`, () => {
    expect(sql).toContain(`c_url CONSTANT text := 'https://flmeolcfutuwwbjmzyoz.supabase.co/functions/v1/${EDGE_FUNCTION}';`);
    expect(fs.existsSync(path.join(ROOT, 'supabase/functions', EDGE_FUNCTION, 'index.ts'))).toBe(true);
    expect(read('supabase/config.toml')).toContain(`[functions.${EDGE_FUNCTION}]\nverify_jwt = false`);
  });

  it('pg_net の応答の待ち時間は、本体の時間の上限より長い (本体が結果を返す前に待ち時間切れにならない)', () => {
    const match = /c_timeout_ms CONSTANT integer := (\d+);/.exec(sql);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThan(HIDDEN_CONTENT_PURGE_MAX_DURATION_MS);
  });

  it('呼び出しの関数は SECURITY DEFINER で、PUBLIC / anon / authenticated / service_role の EXECUTE を外す (呼べるのは pg_cron のジョブだけ)', () => {
    expect(sql).toMatch(/FUNCTION public\.invoke_purge_hidden_content\(\)\s+RETURNS bigint\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = ''/);
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.invoke_purge_hidden_content() FROM PUBLIC, anon, authenticated, service_role;');
    expect(sql).not.toMatch(/GRANT[^;]*invoke_purge_hidden_content/);
  });
});

describe('#1538 3. 画像の確認の関数', () => {
  it(`本体が呼ぶ名前 (${REFERENCED_NEEDLES_RPC}) と引数 (p_needles text[], p_cutoff timestamptz) で作る`, () => {
    expect(sql).toContain(`CREATE OR REPLACE FUNCTION public.${REFERENCED_NEEDLES_RPC}(p_needles text[], p_cutoff timestamptz)`);
  });

  it('service_role だけが呼べる (PUBLIC / anon / authenticated から外す)', () => {
    expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${REFERENCED_NEEDLES_RPC}(text[], timestamptz) FROM PUBLIC, anon, authenticated;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${REFERENCED_NEEDLES_RPC}(text[], timestamptz) TO service_role;`);
  });

  it('隠した表 (食事・レシピ) は、期限を過ぎた隠した行 (今回消える行) を数えない。期限が NULL なら隠した行もすべて数える', () => {
    for (const spec of HIDDEN_CONTENT_TABLES) {
      const alias = spec.table === 'meals' ? 'm' : 'r';
      expect(sql).toContain(`FROM public.${spec.table} ${alias}`);
      expect(sql).toContain(`(${alias}.hidden_at IS NULL OR p_cutoff IS NULL OR ${alias}.hidden_at >= p_cutoff)`);
      expect(sql).toContain(`strpos(${alias}.${spec.imageColumn}, n.needle) > 0`);
    }
  });

  it('退会の Storage の掃除が URL を集める列 (src/lib/account-deletion-storage.ts) は、すべて確かめる', () => {
    const accountDeletion = read('src/lib/account-deletion-storage.ts');
    const labels = [...accountDeletion.matchAll(/label: '(\w+)\.(\w+)'/g)].map((m) => [m[1], m[2]] as const);
    // 番兵: 5 本 (meals.photo_url・health_checkups.image_url・blood_test_results.report_image_url・
    // weekly_menu_requests.inventory_image_url・meal_image_jobs.result_image_url)
    expect(labels).toHaveLength(5);
    for (const [table, column] of [...labels, ['planned_meals', 'image_url'] as const]) {
      expect(sql, `${table}.${column}`).toMatch(new RegExp(`FROM public\\.${table} (\\w+)[\\s\\S]*?strpos\\(\\1\\.${column}, n\\.needle\\) > 0`));
    }
  });
});

describe('#1538 4. ロールバック', () => {
  it('ジョブの登録を外し、2 つの関数を消す', () => {
    expect(rollback).toContain(`WHERE jobname = '${JOB_NAME}'`);
    expect(rollback).toContain('DROP FUNCTION IF EXISTS public.invoke_purge_hidden_content();');
    expect(rollback).toContain(`DROP FUNCTION IF EXISTS public.${REFERENCED_NEEDLES_RPC}(text[], timestamptz);`);
  });
});

/** 拡張子が .ts / .tsx のファイルを dir の下から全部集める (node_modules と . で始まるディレクトリは見ない) */
function listSources(dir: string): string[] {
  const absolute = path.join(ROOT, dir);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name.startsWith('.') ? [] : listSources(relative);
    return /\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}

describe('#1538 5. 隠す側の説明が、完全削除のジョブに追随している', () => {
  /**
   * ジョブが無かったころ (#1101) の言い回し。supabase/migrations は適用済みの記録なので見ない
   * (20261009000500_hide_moderated_content.sql の冒頭のコメントは、その時点の事実として残す)
   */
  const STALE_PHRASES = ['削除ジョブは別の作業', '保管期間とジョブは未定', '完全な削除は保管期間のあとに別のジョブで行う'];
  /** 隠す操作を説明しているコード・テスト。完全削除のジョブの名前を挙げる */
  const HIDE_DESCRIBERS = [
    'src/lib/admin/moderation-backend.ts',
    'src/app/api/admin/moderation/[type]/[id]/route.ts',
    'src/lib/admin/hidden-content-restore.ts',
    'src/app/api/admin/moderation/[type]/[id]/restore/route.ts',
    'tests/integration/rls/hidden-content-visibility.test.ts',
  ];
  /** このファイル自身 (言い回しを検査のために書いている) */
  const SELF = path.relative(ROOT, fileURLToPath(import.meta.url));

  it('src・supabase/functions・tests・apps・packages のどこにも、ジョブが無かったころの言い回しが残っていない', () => {
    const files = ['src', 'supabase/functions', 'tests', 'apps', 'packages']
      .flatMap(listSources)
      .filter((file) => file !== SELF);
    // 番兵: 集める処理が壊れて空振りしたまま素通りしない (隠す側の 3 つが集まっている)
    expect(files).toEqual(expect.arrayContaining(HIDE_DESCRIBERS));
    const stale = files.flatMap((file) => {
      const text = read(file);
      return STALE_PHRASES.filter((phrase) => text.includes(phrase)).map((phrase) => `${file}: ${phrase}`);
    });
    expect(stale).toEqual([]);
  });

  it.each(HIDE_DESCRIBERS)('%s は、完全削除のジョブ purge-hidden-content を挙げる', (file) => {
    expect(read(file)).toContain(JOB_NAME);
  });
});
