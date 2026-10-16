/**
 * #1365 段 2: 非公開化の migration と、コードの定数・戻し・段 1 の説明文の突き合わせ (DB を使わない静的な検査)
 *
 *   1. migration は 1 本だけあり、ローカル / CI のスタックで 2 つのバケットが非公開になる:
 *      版が本番の台帳の最大 (supabase/baseline/manifest.json の ledger_max_version) より新しい (= スタックに当たる)、
 *      または、本番に適用してベースラインを取り直した後で、ベースライン (supabase/baseline/prod_storage.sql) の
 *      INSERT が 2 つとも public = false (取り直すと ledger_max_version が本書の版以上になり、前者は偽になる)
 *   2. migration が非公開にするバケットは PHOTO_STORAGE_BUCKETS (packages/shared) とちょうど同じ。
 *      storage.objects のポリシーを作らず・消さず、health-checkups に触れない
 *   3. 戻し (supabase/rollbacks) が同じ版で存在し、同じバケットを public = true に戻す
 *   4. 段 1 のコードとテストが「まだ公開のまま」「段 2 で非公開にする」と書いていない
 *      (非公開にしたあとも古い説明が残ると、読んだ人が「公開 URL で読める」と誤解する)
 * DB の上での動きは tests/integration/security/photo-buckets-private.test.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHOTO_STORAGE_BUCKETS } from '@homegohan/shared';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const MANIFEST = 'supabase/baseline/manifest.json';
/** 取り直したベースラインの storage バケット設定 (scripts/baseline/build_baseline.py が生成する) */
const BASELINE_STORAGE = 'supabase/baseline/prod_storage.sql';
const MIGRATION_SUFFIX = '_private_photo_buckets.sql';
const ROLLBACK_SUFFIX = '_private_photo_buckets.down.sql';
/** migration のファイル名の先頭の版 (14 桁) */
const VERSION_PATTERN = /^(\d{14})_/;
/** DO ブロックの c_buckets の定義 (1 番目の組が ARRAY の中身) */
const BUCKETS_ARRAY_PATTERN = /c_buckets\s+CONSTANT\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/;
const SET_PRIVATE_PATTERN = /UPDATE\s+storage\.buckets\s+SET\s+public\s*=\s*false\s+WHERE\s+id\s*=\s*ANY\s*\(c_buckets\)/i;
const SET_PUBLIC_PATTERN = /UPDATE\s+storage\.buckets\s+SET\s+public\s*=\s*true\s+WHERE\s+id\s*=\s*ANY\s*\(c_buckets\)/i;
/** もとから非公開で、本件が触らないバケット */
const UNTOUCHED_BUCKET = 'health-checkups';

/**
 * 段 1 のファイルに残っていてはいけない、公開バケットを前提にした説明の語。
 * origin/main の STAGE1_FILES の該当行 (9.7 の表の左の列) をそれぞれ 1 語以上で捕まえる
 */
const STALE_WORDS = [
  'まだ公開のまま', // src/lib/photo-storage-signing.ts:4
  'まだ公開 (public) のまま', // packages/shared/src/signed-photo-url.ts:6
  '段 2 で非公開にする', // src/lib/photo-storage-signing.ts:4・packages/shared/src/signed-photo-url.ts:14
  '段 2 で扱う', // packages/shared/src/signed-photo-url.ts:7
  '段 2 でバケットを非公開に', // packages/shared/src/signed-photo-url.ts:9・tests/signed-photo-display-scan.test.ts:5
  '今は誰でも見られる', // tests/signed-photo-display-scan.test.ts:6
  '段 2 (バケットの非公開化) の前に', // src/app/api/storage/signed-urls/route.ts:71
  'これから非公開にする', // src/lib/admin/moderation-backend.ts:111
  '公開バケットのまま', // tests/integration/security/storage-fridge-images-rls.test.ts:12 (ヘッダ)・:150 (P-1)・:172 (M-3)
  'updateBucket', // tests/integration/security/photo-signed-urls.test.ts:98 (afterAll)・:139, 146 (S-4)
];
const STAGE1_FILES = [
  'src/lib/photo-storage-signing.ts',
  'packages/shared/src/signed-photo-url.ts',
  'src/app/api/storage/signed-urls/route.ts',
  'src/lib/admin/moderation-backend.ts',
  'tests/signed-photo-display-scan.test.ts',
  'tests/integration/security/storage-fridge-images-rls.test.ts',
  'tests/integration/security/photo-signed-urls.test.ts',
] as const;

const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
/** SQL の行コメント (-- から行末) を外す。コメントの中の語で検査が通らないようにする */
const stripSqlComments = (sql: string) => sql.replace(/--[^\n]*/g, '');

/** 正規表現の特殊文字を逃がす (バケット名の `-` などをそのまま比べる) */
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * ベースラインの `INSERT INTO storage.buckets (id, name, public, …) VALUES ('<id>', '<name>', <public>, …)` の public の値。
 * そのバケットの INSERT が無ければ undefined
 */
function baselinePublicOf(storageSql: string, bucket: string): string | undefined {
  const pattern = new RegExp(
    `INSERT\\s+INTO\\s+storage\\.buckets\\s*\\(\\s*id\\s*,\\s*name\\s*,\\s*public\\b[^)]*\\)\\s*VALUES\\s*\\(\\s*'${escapeRegExp(bucket)}'\\s*,\\s*'[^']*'\\s*,\\s*(true|false)\\b`,
    'i',
  );
  return pattern.exec(storageSql)?.[1]?.toLowerCase();
}

function bucketsOf(sql: string): string[] {
  const match = BUCKETS_ARRAY_PATTERN.exec(sql);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((item) => item.trim().replace(/^'|'$/g, ''))
    .filter((item) => item.length > 0)
    .sort();
}

const migrationFiles = fs.readdirSync(path.join(ROOT, MIGRATIONS_DIR)).filter((name) => name.endsWith(MIGRATION_SUFFIX));
const migrationFile = migrationFiles[0] ?? '';
const version = VERSION_PATTERN.exec(migrationFile)?.[1] ?? '';
const sql = migrationFile ? stripSqlComments(read(`${MIGRATIONS_DIR}/${migrationFile}`)) : '';
const rollbackFile = `${version}${ROLLBACK_SUFFIX}`;
const expectedBuckets = [...PHOTO_STORAGE_BUCKETS].sort();

describe('#1365 段 2 1. migration の有無と版', () => {
  it('_private_photo_buckets.sql は 1 本だけ', () => {
    expect(migrationFiles).toHaveLength(1);
  });

  it('ローカル / CI で非公開になる: 版が本番の台帳の最大 (ledger_max_version) より新しい、または取り直したベースラインで 2 つとも public = false', () => {
    const manifest = JSON.parse(read(MANIFEST)) as { ledger_max_version: string };
    expect(version).toMatch(/^\d{14}$/);
    // 取り直しの前: 本書の migration がスタックに当たる
    const appliedOnLocalStack = version > manifest.ledger_max_version;
    // 取り直しの後: ledger_max_version は本書の版以上になり、ベースラインの INSERT が非公開を持つ
    const baselineStorage = stripSqlComments(read(BASELINE_STORAGE));
    const baselinePrivate = expectedBuckets.every((bucket) => baselinePublicOf(baselineStorage, bucket) === 'false');
    expect(
      appliedOnLocalStack || baselinePrivate,
      `版 ${version} が ledger_max_version ${manifest.ledger_max_version} 以下で、ベースラインの ${expectedBuckets.join(' / ')} も public = false でない`,
    ).toBe(true);
  });
});

describe('#1365 段 2 2. 非公開にするバケット', () => {
  it('c_buckets は PHOTO_STORAGE_BUCKETS (meal_photos / fridge-images) とちょうど同じ', () => {
    expect(bucketsOf(sql)).toEqual(expectedBuckets);
  });

  it('public = false にする UPDATE が 1 つあり、storage.objects のポリシーを作らず・消さず、health-checkups に触れない', () => {
    expect(SET_PRIVATE_PATTERN.test(sql)).toBe(true);
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
    expect(sql).not.toMatch(/DROP\s+POLICY/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toContain(UNTOUCHED_BUCKET);
  });
});

describe('#1365 段 2 3. 戻し', () => {
  it('同じ版の .down.sql があり、同じバケットを public = true に戻す', () => {
    const rollbackPath = path.join(ROOT, ROLLBACKS_DIR, rollbackFile);
    expect(fs.existsSync(rollbackPath)).toBe(true);
    const rollback = stripSqlComments(fs.readFileSync(rollbackPath, 'utf8'));
    expect(SET_PUBLIC_PATTERN.test(rollback)).toBe(true);
    expect(bucketsOf(rollback)).toEqual(expectedBuckets);
  });
});

describe('#1365 段 2 4. 段 1 の説明文', () => {
  it.each(STAGE1_FILES)('%s は公開バケットを前提にした語を持たない', (file) => {
    const text = read(file);
    for (const word of STALE_WORDS) {
      expect(text, `${file} に「${word}」が残っている`).not.toContain(word);
    }
  });
});
