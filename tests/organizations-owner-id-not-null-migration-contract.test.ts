/**
 * #1103 項目 10: migration *_organizations_owner_id_not_null.sql (と、そのロールバック) と、それに合わせた型・コードの
 * ソース走査の contract テスト (DB は使わない)。
 *
 * 本物の DB での振る舞い (0 人の組織だけが消える・owner で埋まる・止まる条件・冪等・ロールバック) は
 * tests/integration/security/organizations-owner-id-not-null.test.ts が確かめる。
 * ここでは、写し間違いや後からの書き換えで崩れやすい所を、ファイルの文面だけで確かめる。
 * #1917 (docs/design/family/11-self-dissolve.md §11) で owner_id は NULL 許容 + CHECK organizations_active_has_owner (active な行では NOT NULL) になった。型と Zod の it はその形を見る。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OrganizationSchema } from '@/schemas/membership/organization';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const STEM_SUFFIX = '_organizations_owner_id_not_null';
const TYPE_FILES = ['src/types/database.types.ts', 'packages/shared/src/database.types.ts'] as const;

/** 2026-10-16 の本番の読み取りで数えた、owner_id が NULL でメンバーが 0 人の組織の数 (migration の c_max_deletions) */
const PROD_EMPTY_ORG_COUNT = 4;
/** migration が止まるときの例外の目印 (結合テストと運用の切り分けがこの文字列を頼りにする) */
const ERROR_CODES = [
  'ORG_OWNER_NOT_NULL_TOO_MANY_DELETIONS',
  'ORG_OWNER_NOT_NULL_REFERENCED',
  'ORG_OWNER_NOT_NULL_LICENSE_POOL_LINKED',
  'ORG_OWNER_NOT_NULL_DELETE_MISMATCH',
  'ORG_OWNER_NOT_NULL_OWNER_AMBIGUOUS',
] as const;

/** migration のファイル名 (version 14 桁 + `_` + 名前 + `.sql`) */
const MIGRATION_FILE = /^(\d{14})_.+\.sql$/;
/**
 * main を取り込んだ時点 (2026-10-16) の main の migration の最大。本 migration はこれより後に並べる。
 * main に入った migration は CI が本番へ当てるので、本番の台帳の最大 version はこれ以上になる。台帳の最大以下の
 * LOCAL_ONLY は deploy-supabase-migrations.yml の drift guard が exit 1 で止める (本 migration も後続も当たらない)。
 */
const MAIN_MAX_MIGRATION_AT_MERGE = '20261017090000_backup_audit_record';

const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
/** SQL のコメント (-- から行末、/* ... *\/) を取り除く */
const stripComments = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
/** 空白の並びを 1 つにそろえる */
const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
/** SQL の中の 'a', 'b' のような文字列の並びを取り出す */
const quotedList = (sql: string): string[] => [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

function stem(): string {
  const found = fs
    .readdirSync(path.join(ROOT, MIGRATIONS_DIR))
    .filter((f) => MIGRATION_FILE.test(f) && f.endsWith(`${STEM_SUFFIX}.sql`));
  expect(found, `${STEM_SUFFIX} の migration がちょうど 1 本ある`).toHaveLength(1);
  return found[0].replace(/\.sql$/, '');
}

const migration = () => read(`${MIGRATIONS_DIR}/${stem()}.sql`);
const code = () => squash(stripComments(migration()));
const rollback = () => read(`${ROLLBACKS_DIR}/${stem()}.down.sql`);

/** 本番を写したベースラインの org_license_pools の列 (生成列を含む) */
function baselineLicensePoolColumns(): string[] {
  const schema = read('supabase/baseline/prod_schema.sql');
  const m = /CREATE TABLE IF NOT EXISTS "public"\."org_license_pools" \(([\s\S]*?)\n\);/.exec(schema);
  if (!m) throw new Error('ベースラインに org_license_pools が無い');
  return m[1]
    .split('\n')
    .map((line) => /^\s+"([a-z_]+)"/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

describe('#1103 項目 10 migration の形', () => {
  it('ファイル名・見出し・戻し口がそろっている', () => {
    const name = stem();
    expect(migration().split('\n', 1)[0]).toBe(`-- migration: ${name}.sql`);
    expect(rollback().split('\n', 1)[0]).toBe(`-- rollback: ${name}.sql`);
    expect(migration()).toContain(`supabase/rollbacks/${name}.down.sql`);
  });

  it('version は main を取り込んだ時点の main の最大の migration より大きい (本番の台帳の最大以下だと drift guard で止まる)', () => {
    const files = fs.readdirSync(path.join(ROOT, MIGRATIONS_DIR));
    // 取り込んだ main の最大の migration が木にある (main を取り込まずに番号だけ上げた状態を通さない)
    expect(files).toContain(`${MAIN_MAX_MIGRATION_AT_MERGE}.sql`);
    const version = (name: string): string => MIGRATION_FILE.exec(`${name}.sql`)?.[1] ?? '';
    const floor = version(MAIN_MAX_MIGRATION_AT_MERGE);
    expect(floor).toMatch(/^\d{14}$/);
    expect(version(stem()) > floor, `${stem()} は ${MAIN_MAX_MIGRATION_AT_MERGE} より後`).toBe(true);
    // 同じ version の migration が他に無い (台帳は version で突き合わせる)
    const sameVersion = files.filter((f) => MIGRATION_FILE.exec(f)?.[1] === version(stem()));
    expect(sameVersion).toEqual([`${stem()}.sql`]);
  });

  it('文は DO ブロック 1 つだけ (supabase の適用はファイルをトランザクションで包まないので、途中で止まっても何も残さない)', () => {
    const sql = code();
    expect(sql.startsWith('DO $$')).toBe(true);
    expect(sql.endsWith('END $$;')).toBe(true);
    expect(sql.match(/\$\$/g)).toHaveLength(2);
  });

  it('最初にロック待ちの上限を付け、organizations と user_profiles をロックする', () => {
    const sql = code();
    const begin = sql.indexOf('BEGIN PERFORM');
    expect(begin).toBeGreaterThan(0);
    expect(sql).toContain("c_lock_timeout constant text := '10s'");
    expect(sql.slice(begin)).toMatch(
      /^BEGIN PERFORM set_config\('lock_timeout', c_lock_timeout, true\); LOCK TABLE public\.organizations IN ACCESS EXCLUSIVE MODE; LOCK TABLE public\.user_profiles IN SHARE MODE;/,
    );
  });

  it('消す件数の上限は本番の読み取りの件数と同じ', () => {
    expect(code()).toContain(`c_max_deletions constant integer := ${PROD_EMPTY_ORG_COUNT};`);
    expect(code()).toContain('IF cardinality(v_targets) > c_max_deletions THEN');
  });

  it('消す対象は owner_id が NULL でメンバー (user_profiles) が 0 人の組織だけ', () => {
    expect(code()).toContain(
      'FROM public.organizations o WHERE o.owner_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.organization_id = o.id);',
    );
    expect(code()).toContain('DELETE FROM public.organizations WHERE id = ANY (v_targets);');
  });

  it('参照の検査は外部キー (org_license_pools を除く) と外部キーの無い組織の列の両方を見る', () => {
    const sql = code();
    expect(sql).toContain("con.contype = 'f' AND con.confrelid = 'public.organizations'::regclass");
    expect(sql).toContain("con.conrelid <> 'public.org_license_pools'::regclass");
    expect(sql).toContain("(col.column_name = 'organization_id' OR col.column_name LIKE '%\\_org\\_id')");
    expect(sql).toContain("col.table_name NOT IN ('organizations', 'org_license_pools')");
  });

  it('org_license_pools の既知の列はベースラインの列と一致する (列が足されたら検査が見る)', () => {
    const m = /c_license_pool_columns constant text\[\] := ARRAY\[([^\]]*)\]/.exec(code());
    expect(m).not.toBeNull();
    expect(quotedList(m![1]).sort()).toEqual(baselineLicensePoolColumns().sort());
    // ベースラインより後の migration で org_license_pools に列を足していない (足したら既知の列に入れるかを決め直す)
    const later = fs
      .readdirSync(path.join(ROOT, MIGRATIONS_DIR))
      .filter((f) => MIGRATION_FILE.test(f) && !f.endsWith(`${STEM_SUFFIX}.sql`))
      .filter((f) =>
        // 列の追加 (ADD COLUMN / ADD <列名>) だけを見る。制約の追加 (ADD CONSTRAINT。主キー・外部キー) は列を増やさない
        /ALTER TABLE\s+(?:ONLY\s+)?(?:"?public"?\.)?"?org_license_pools"?\s+ADD\s+(?!CONSTRAINT\b)/i.test(
          stripComments(read(`${MIGRATIONS_DIR}/${f}`)),
        ),
      );
    expect(later).toEqual([]);
  });

  it("残った組織は org_role = 'owner' がちょうど 1 人のときだけ埋める", () => {
    const sql = code();
    expect(sql).toContain("WHERE up.organization_id = v_org.id AND up.org_role = 'owner';");
    expect(sql).toContain('IF cardinality(v_owners) <> 1 THEN');
    expect(sql).toContain('UPDATE public.organizations SET owner_id = v_owners[1] WHERE id = v_org.id;');
  });

  it('最後に SET NOT NULL する (DO ブロックの中)', () => {
    expect(code()).toMatch(/ALTER TABLE public\.organizations ALTER COLUMN owner_id SET NOT NULL; END \$\$;$/);
  });

  it.each(ERROR_CODES)('止まるときの目印 %s を例外に入れる', (codeName) => {
    expect(code()).toContain(`RAISE EXCEPTION '${codeName}:`);
  });
});

describe('#1103 項目 10 ロールバック', () => {
  it('NOT NULL を外すだけで、消した行は戻らないと冒頭に書く', () => {
    const text = rollback();
    expect(text).toContain('消した行は戻せない');
    const sql = squash(stripComments(text));
    expect(sql).toBe("SET LOCAL lock_timeout = '10s'; ALTER TABLE public.organizations ALTER COLUMN owner_id DROP NOT NULL;");
  });
});

describe('#1103 項目 10 / #1917 型とコード', () => {
  it.each(TYPE_FILES)(
    '%s: organizations の owner_id は Row で string | null・Insert と Update で省略可の string | null (解散した行は NULL。active な行の NOT NULL は CHECK organizations_active_has_owner が守る。#1917)',
    (rel) => {
      const source = read(rel);
      const start = source.indexOf('\n      organizations: {');
      expect(start).toBeGreaterThan(0);
      const block = source.slice(start, source.indexOf('\n      }', start));
      const section = (name: 'Row' | 'Insert' | 'Update') => {
        const from = block.indexOf(`${name}: {`);
        return block.slice(from, block.indexOf('}', from));
      };
      expect(section('Row')).toContain('owner_id: string | null\n');
      expect(section('Insert')).toContain('owner_id?: string | null\n');
      expect(section('Update')).toContain('owner_id?: string | null\n');
    },
  );

  it('Zod の OrganizationSchema は owner_id に NULL (解散した行) と UUID を受け、UUID でない文字列は受けない (#1917)', () => {
    expect(OrganizationSchema.shape.owner_id.safeParse(null).success).toBe(true);
    expect(OrganizationSchema.shape.owner_id.safeParse('00000000-0000-4000-8000-000000000000').success).toBe(true);
    expect(OrganizationSchema.shape.owner_id.safeParse('not-a-uuid').success).toBe(false);
  });

  it('src で organizations に INSERT / UPSERT する箇所は、どれも owner_id を入れる', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(rel);
        } else if (/\.(ts|tsx)$/.test(entry.name)) files.push(rel);
      }
    };
    walk('src');
    const sites: string[] = [];
    for (const rel of files) {
      const source = read(rel);
      for (const m of source.matchAll(/\.from\(['"]organizations['"]\)\s*\.(insert|upsert)\(([^)]*)\)/g)) {
        sites.push(rel);
        expect(m[2], `${rel} の ${m[1]}`).toContain('owner_id');
      }
    }
    // 組織を作る入口 (運営の作成 API) を拾えている (読み取りが壊れて素通りしない)
    expect(sites).toContain('src/app/api/admin/organizations/route.ts');
  });
});
