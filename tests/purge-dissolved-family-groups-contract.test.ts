/**
 * #1125 (B) 解散した家族のグループの物理削除 (migration 20261018010000_purge_dissolved_family_groups.sql・設計 operator/11 §5.4・§11.1) の
 * ソース走査 contract テスト (DB には接続しない)。段 C。
 *
 * 実際の動き (消える範囲・CASCADE・上限・同意の記録・監査ログ・権限・ジョブの登録) は tests/integration/security/purge-dissolved-family-groups.test.ts で確かめる。
 * ここでは、DB を立てなくても通常のテストで止められる「書き方の取り決め」を固定する。
 *
 *   1. migration と rollback が同じ名前で対になっていて、1・2 行目の見出しと案内が正しい。版の番号が重ならない
 *   2. 関数は SECURITY INVOKER・search_path 空・参照が完全修飾・動的 SQL なし。EXECUTE は service_role だけ (完全形の REVOKE のあとに GRANT)
 *   3. 候補の条件: status = dissolved・dissolved_at が保存期間 (90 日) より前・parental_consents を持たない。1 回 500 件・古い順
 *   4. 同意の記録を持つグループは数えるだけ (skipped)。消す DELETE は 1 か所で、候補と同じ条件を持つ
 *   5. 監査ログは actor NULL・system.family.dissolved_purge・target_type cron_job・severity info。INSERT は 1 か所で、
 *      IF NOT p_dry_run AND v_candidates > 0 の中だけ (0 件の回は、同意の記録を持つグループだけが残る回も書かない)
 *   6. dry run (p_dry_run = true) は DELETE も INSERT もしない。戻り値の purge_count は dry run では候補の数、そうでなければ消した数
 *   7. ジョブ purge-dissolved-family-groups: 40 18 * * * (03:40 JST)・command が決めたとおり。pg_cron が無い DB では飛ばす。command を NOTICE に載せない
 *   8. 関数の外の既存の行を変えない・消さない (migration の DELETE は関数の中の 1 か所だけ。UPDATE・TRUNCATE・cron.alter_job を書かない)
 *   9. rollback がジョブの登録解除と関数の DROP を行い、行を消す・変える文を持たない
 *  10. 消す範囲の前提: family_groups を参照する外部キーは 5 本 (invites / members / promotion_requests / parental_consents = CASCADE、user_profiles = SET NULL)。
 *      増えたら設計 §5.4.2 の表とこの一覧を直す (結合テストの C-3 が本物の DB で同じことを確かめる)
 *  11. 03:40 JST のジョブの時刻が、ほかのジョブの時刻と重ならない
 *  12. database.types.ts (2 か所) に関数の型がある
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { collectMigrationCronJobs, stripSqlComments } from './helpers/migration-cron-jobs';

const ROOT = path.resolve(__dirname, '..');
const VERSION = '20261018010000';
const NAME = 'purge_dissolved_family_groups';
const MIGRATION_FILE = `${VERSION}_${NAME}.sql`;
const ROLLBACK_FILE = `${VERSION}_${NAME}.down.sql`;
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, MIGRATION_FILE);
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', ROLLBACK_FILE);
const TYPE_FILES = ['src/types/database.types.ts', 'packages/shared/src/database.types.ts'] as const;

const JOB_NAME = 'purge-dissolved-family-groups';
/** 毎日 03:40 JST。pg_cron は UTC で解釈するので 18:40 UTC */
const JOB_SCHEDULE = '40 18 * * *';
const JOB_COMMAND = 'SELECT public.purge_dissolved_family_groups(false);';
const FUNCTION_SIGNATURE = 'public.purge_dissolved_family_groups(BOOLEAN)';
/** REVOKE で外すロール (完全形。Supabase の自動の GRANT と PostgreSQL の PUBLIC を両方外す) */
const REVOKED_ROLES = 'PUBLIC, anon, authenticated, service_role';
/** 保存期間 (日)。設計 §0.4 Q-1 の確認の結果 = 90 日 */
const RETENTION_DAYS = 90;
/** 1 回の実行で消す上限。設計 §5.4.1 */
const BATCH_LIMIT = 500;
/** family_groups を参照する外部キー (migration の ON DELETE の指定)。設計 §5.4.2 の表と同じ */
const EXPECTED_FOREIGN_KEYS = [
  'family_invites.family_id CASCADE',
  'family_members.family_id CASCADE',
  'family_promotion_requests.family_id CASCADE',
  'parental_consents.family_id CASCADE',
  'user_profiles.family_id SET NULL',
] as const;

const migration = fs.readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf-8');
const code = stripSqlComments(migration);
const rollbackCode = stripSqlComments(rollback);

/** CREATE OR REPLACE FUNCTION public.purge_dissolved_family_groups( から、本体の終わりの $$ まで */
function functionSource(): { header: string; body: string; whole: string } {
  const start = code.indexOf(`CREATE OR REPLACE FUNCTION public.${NAME}(`);
  expect(start, 'CREATE OR REPLACE FUNCTION が見つからない').toBeGreaterThanOrEqual(0);
  const rest = code.slice(start);
  const opener = /\bAS\s+\$\$/.exec(rest);
  expect(opener, 'AS $$ が見つからない').not.toBeNull();
  const opened = opener as RegExpExecArray;
  const bodyStart = opened.index + opened[0].length;
  const bodyEnd = rest.indexOf('$$', bodyStart);
  expect(bodyEnd, '本体の終わりの $$ が見つからない').toBeGreaterThan(bodyStart);
  return { header: rest.slice(0, opened.index), body: rest.slice(bodyStart, bodyEnd), whole: rest.slice(0, bodyEnd + 2) };
}

describe('#1125 (B) 解散した家族のグループの物理削除 (段 C の migration) のソース走査', () => {
  it('migration と rollback が対・1・2 行目の見出しと案内が正しい・版の番号が重ならない', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
    expect(fs.existsSync(ROLLBACK_PATH)).toBe(true);
    const lines = migration.split('\n');
    expect(lines[0]).toBe(`-- migration: ${MIGRATION_FILE}`);
    expect(lines[1]).toBe(`-- 戻し方: supabase/rollbacks/${ROLLBACK_FILE}`);
    expect(rollback.split('\n')[0]).toBe(`-- rollback: ${MIGRATION_FILE}`);
    const sameVersion = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.startsWith(`${VERSION}_`));
    expect(sameVersion).toEqual([MIGRATION_FILE]);
  });

  it('関数は SECURITY INVOKER・search_path 空・参照が完全修飾・動的 SQL なし。EXECUTE は service_role だけ', () => {
    const { header, body, whole } = functionSource();
    expect(header).toMatch(/\bSECURITY INVOKER\b/);
    expect(header).not.toMatch(/SECURITY DEFINER/);
    expect(header).toMatch(/SET search_path = ''/);
    expect(header).toMatch(/\bVOLATILE\b/);
    expect(body, '動的 SQL なし').not.toMatch(/\bEXECUTE\b/i);
    // 表の参照 (FROM / JOIN / INTO / UPDATE / DELETE FROM / INSERT INTO) はスキーマ付き。FROM の直後のかっこ (副問い合わせ) は除く
    const unqualified = [...body.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_]\w*)(\.)?/gi)]
      .filter((match) => !match[2])
      // `SELECT … INTO v_candidates` は変数 (v_)、`EXTRACT(DAY FROM c_retention)` は定数 (c_) で、表ではない
      .filter((match) => !/^(v_|c_)/.test(match[1]))
      .map((match) => match[0]);
    expect(unqualified, 'スキーマ無しの表の参照').toEqual([]);
    // 関数の呼び出しも pg_catalog 付き (search_path が空なので、付けないと実行時に解けない)
    const bare = [...whole.matchAll(/(?<![.\w])(now|count|jsonb_build_object|to_regclass)\s*\(/gi)].map((match) => match[0]);
    expect(bare, 'pg_catalog 無しの組み込み関数').toEqual([]);

    expect(code).toContain(`REVOKE ALL ON FUNCTION ${FUNCTION_SIGNATURE} FROM ${REVOKED_ROLES};`);
    const grants = [...code.matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+(\S+?\([^)]*\))\s+TO\s+([^;]+);/gi)].map((match) => `${match[1]} -> ${match[2].trim()}`);
    expect(grants).toEqual([`${FUNCTION_SIGNATURE} -> service_role`]);
    expect(code.indexOf(`GRANT EXECUTE ON FUNCTION ${FUNCTION_SIGNATURE}`)).toBeGreaterThan(code.indexOf(`REVOKE ALL ON FUNCTION ${FUNCTION_SIGNATURE}`));
    // 戻り値の形 (設計 §5.4.1)
    expect(header).toMatch(
      /RETURNS TABLE \(purge_count INTEGER, remaining_count INTEGER, skipped_with_consents_count INTEGER, dry_run BOOLEAN\)/,
    );
    expect(header).toMatch(/p_dry_run BOOLEAN DEFAULT false/);
  });

  it('候補の条件: status = dissolved・dissolved_at < now - 90 日・parental_consents を持たない。LIMIT 500・古い順', () => {
    const { body } = functionSource();
    // 保存期間と上限は名前付きの定数 (式に数字を埋めない)
    expect(body).toMatch(new RegExp(`c_retention\\s+CONSTANT\\s+pg_catalog\\.interval\\s*:=\\s*interval '${RETENTION_DAYS} days'`));
    expect(body).toMatch(new RegExp(`c_batch_limit\\s+CONSTANT\\s+INTEGER\\s*:=\\s*${BATCH_LIMIT};`));
    // 候補 (数える SELECT と消す DELETE の副問い合わせの 2 か所) は同じ 4 つの条件を持つ
    expect(body.match(/\.status = 'dissolved'/g) ?? []).toHaveLength(3);
    expect(body.match(/\.dissolved_at IS NOT NULL/g) ?? []).toHaveLength(3);
    expect(body.match(/\.dissolved_at < pg_catalog\.now\(\) - c_retention/g) ?? []).toHaveLength(3);
    // 同意の記録を持たない: 候補の 2 か所は NOT EXISTS、残すものの 1 か所は EXISTS
    expect(body.match(/AND NOT EXISTS \(SELECT 1 FROM public\.parental_consents AS pc WHERE pc\.family_id = g2?\.id\)/g) ?? []).toHaveLength(2);
    expect(body.match(/AND EXISTS \(SELECT 1 FROM public\.parental_consents AS pc WHERE pc\.family_id = g\.id\)/g) ?? []).toHaveLength(1);
    // 消す順と上限
    expect(body).toMatch(/ORDER BY g2\.dissolved_at ASC\s+LIMIT c_batch_limit/);
    // 業務の意味を持つ数値をリテラルのまま式に埋めない (90・500 は定数にだけ書く)
    const withoutDeclare = body.slice(body.indexOf('BEGIN'));
    expect(withoutDeclare).not.toMatch(/\b(90|500)\b/);
  });

  it('消す DELETE は 1 か所 (family_groups)。同意の記録を持つグループは数えるだけで、消さない', () => {
    const deletes = [...code.matchAll(/\bDELETE\s+FROM\s+(\S+)/gi)].map((match) => match[1]);
    expect(deletes).toEqual(['public.family_groups']);
    // 消す対象は副問い合わせで選んだ id だけ (副問い合わせが同意の記録なしの条件を持つことは、上の it が固定している)
    expect(functionSource().body).toMatch(/DELETE FROM public\.family_groups AS g\s+WHERE g\.id IN \(\s*SELECT g2\.id/);
    // 関連の表を個別に消さない (CASCADE に任せる。parental_consents を直接消さない)
    expect(code).not.toMatch(/DELETE\s+FROM\s+public\.(family_members|family_invites|family_promotion_requests|parental_consents)/i);
  });

  it('監査ログは actor NULL・system.family.dissolved_purge・target_type cron_job・severity info。INSERT は IF NOT p_dry_run AND v_candidates > 0 の中だけ (0 件の回は、同意の記録を持つグループだけが残る回も書かない)', () => {
    const { body } = functionSource();
    const inserts = [...code.matchAll(/\bINSERT\s+INTO\s+(\S+)/gi)].map((match) => match[1]);
    expect(inserts).toEqual(['public.admin_audit_logs']);
    expect(body).toMatch(/INSERT INTO public\.admin_audit_logs \(actor_id, action_type, target_type, severity, details\)\s+VALUES \(NULL, 'system\.family\.dissolved_purge', 'cron_job', 'info',/);
    for (const key of ['purge_count', 'remaining_count', 'skipped_with_consents_count', 'retention_days']) {
      expect(body, `details に ${key}`).toContain(`'${key}'`);
    }
    // INSERT と DELETE は、どちらも「dry run でなく、候補が 1 件以上」の IF の中にだけある
    const ifStart = body.indexOf('IF NOT p_dry_run AND v_candidates > 0 THEN');
    const ifEnd = body.indexOf('END IF;', ifStart);
    expect(ifStart, 'IF NOT p_dry_run AND v_candidates > 0 THEN').toBeGreaterThanOrEqual(0);
    expect(ifEnd).toBeGreaterThan(ifStart);
    const insideIf = body.slice(ifStart, ifEnd);
    expect(insideIf).toMatch(/\bDELETE\s+FROM\b/);
    expect(insideIf).toMatch(/\bINSERT\s+INTO\b/);
    const outsideIf = body.slice(0, ifStart) + body.slice(ifEnd);
    expect(outsideIf).not.toMatch(/\b(DELETE\s+FROM|INSERT\s+INTO|UPDATE)\b/i);
    // 同意の記録を持つグループだけが残る回 (v_skipped > 0) では書かない: 書く条件に v_skipped を使わない
    expect(body.match(/IF [^\n]*THEN/g)?.filter((condition) => /v_skipped/.test(condition)) ?? []).toEqual([]);
  });

  it('dry run は DELETE も INSERT もしない。purge_count は dry run では候補の数、そうでなければ消した数', () => {
    const { body } = functionSource();
    expect(body).toMatch(/CASE WHEN p_dry_run THEN v_candidates ELSE v_purged END,\s+CASE WHEN p_dry_run THEN 0 ELSE v_candidates - v_purged END,\s+v_skipped,\s+p_dry_run;/);
    // 書く文は p_dry_run が偽のときだけの IF の中 (上の it)。ここでは IF の条件が dry run を除くことを固定する
    expect(body).toMatch(/IF NOT p_dry_run AND v_candidates > 0 THEN/);
    // migration 自身が流す確認は dry run (true) だけ。false で呼ぶ文は、ジョブの command の 1 か所だけ
    const calls = [...code.matchAll(new RegExp(`purge_dissolved_family_groups\\((true|false)\\)`, 'g'))].map((match) => match[1]);
    expect(calls.filter((arg) => arg === 'false')).toHaveLength(1);
    expect(code).toContain(`'${JOB_COMMAND}'`);
    expect(code).toMatch(/FROM public\.purge_dissolved_family_groups\(true\)/);
  });

  it(`ジョブ ${JOB_NAME}: ${JOB_SCHEDULE} (03:40 JST)・command が決めたとおり。1 つだけ登録する`, () => {
    const registered = collectMigrationCronJobs(MIGRATIONS_DIR);
    expect(registered.unresolved, 'ジョブの名前が解けない呼び出し').toEqual([]);
    expect(registered.names.filter((name) => name === JOB_NAME)).toEqual([JOB_NAME]);
    // この migration の cron.schedule は 1 回で、名前・時刻・command は決めたとおり
    const schedules = [...code.matchAll(/cron\.schedule\(\s*'([^']+)',\s*'([^']+)',\s*'([^']+)'\s*\)/g)];
    expect(schedules).toHaveLength(1);
    expect([schedules[0][1], schedules[0][2], schedules[0][3]]).toEqual([JOB_NAME, JOB_SCHEDULE, JOB_COMMAND]);
    // 18:40 UTC = 03:40 JST
    const [minute, hourUtc] = JOB_SCHEDULE.split(' ');
    expect(`${String((Number(hourUtc) + 9) % 24).padStart(2, '0')}:${minute}`).toBe('03:40');
  });

  it('pg_cron が無い DB では登録を飛ばす (cron.job の存在を確かめてから触る)。同名・同じ処理のジョブを先に登録解除する。command を NOTICE に載せない', () => {
    expect(code).toMatch(/IF to_regclass\('cron\.job'\) IS NULL THEN\s+RAISE NOTICE '[^']+';\s+RETURN;\s+END IF;/);
    expect(code).toMatch(/jobname = 'purge-dissolved-family-groups'\s+OR command ~\* '\[\[:<:\]\]purge_dissolved_family_groups\[\[:>:\]\]'/);
    const unscheduleAt = code.indexOf('cron.unschedule(');
    const scheduleAt = code.indexOf('cron.schedule(');
    expect(unscheduleAt).toBeGreaterThanOrEqual(0);
    expect(scheduleAt).toBeGreaterThan(unscheduleAt);
    // RAISE の引数に command を渡さない
    for (const raise of code.matchAll(/RAISE\s+(?:NOTICE|EXCEPTION|WARNING)[^;]*;/g)) {
      expect(raise[0], 'RAISE に command を載せない').not.toMatch(/\bcommand\b/);
    }
  });

  it('既存の行を変えない・消さない: 関数の外に DELETE・UPDATE・TRUNCATE が無く、実行履歴・ほかのジョブに触れない', () => {
    const { whole } = functionSource();
    const outside = code.replace(whole, '');
    expect(outside).not.toMatch(/\b(DELETE\s+FROM|UPDATE|TRUNCATE|INSERT\s+INTO)\b/i);
    expect(code).not.toMatch(/\bcron\.(alter_job|schedule_in_database)\b/i);
    // cron.unschedule は、同名・同じ処理を呼ぶジョブ (v_job) だけ
    expect([...code.matchAll(/cron\.unschedule\(([^)]*)\)/g)].map((match) => match[1])).toEqual(['v_job.jobid']);
    expect(code).not.toMatch(/job_run_details|cron_failure_alerts/);
    // 表・列・索引・ポリシーを足さない (関数とジョブだけ)
    expect(code).not.toMatch(/\b(CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|CREATE\s+POLICY|CREATE\s+TRIGGER|DROP\s+TABLE)\b/i);
  });

  it('rollback がジョブの登録解除と関数の DROP を行い、行を消す・変える文を持たない', () => {
    expect(rollbackCode).toMatch(/jobname = 'purge-dissolved-family-groups'/);
    expect(rollbackCode).toMatch(/PERFORM cron\.unschedule\(v_job\.jobid\);/);
    expect(rollbackCode).toMatch(/IF to_regclass\('cron\.job'\) IS NULL THEN\s+RETURN;/);
    const drops = [...rollbackCode.matchAll(/DROP\s+(FUNCTION|TABLE)\s+IF EXISTS\s+([^;]+);/gi)].map((match) => `${match[1].toUpperCase()} ${match[2].replace(/\s+/g, ' ').trim()}`);
    expect(drops).toEqual([`FUNCTION ${FUNCTION_SIGNATURE}`]);
    // ジョブを先に外し、そのあと関数を消す
    expect(rollbackCode.indexOf('cron.unschedule')).toBeLessThan(rollbackCode.indexOf('DROP FUNCTION'));
    expect(rollbackCode).not.toMatch(/\b(DELETE|UPDATE|INSERT|TRUNCATE)\b/i);
    expect(rollbackCode).not.toMatch(/admin_audit_logs|parental_consents|FROM\s+public\.family_groups/i);
  });

  it('消す範囲の前提: family_groups を参照する外部キーは 5 本で、ON DELETE の指定が設計 §5.4.2 の表と同じ (増えたら設計とこの一覧を直す)', () => {
    // 参照元を、migration とベースラインから集める (REFERENCES ... family_groups と ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES ... family_groups の 2 つの書き方)
    const files = [
      ...fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).map((file) => path.join(MIGRATIONS_DIR, file)),
      path.join(ROOT, 'supabase', 'baseline', 'prod_schema.sql'),
    ];
    const found = new Set<string>();
    for (const file of files) {
      const sql = stripSqlComments(fs.readFileSync(file, 'utf-8'));
      // ADD CONSTRAINT "x" FOREIGN KEY ("col") REFERENCES "public"."family_groups"("id") ON DELETE CASCADE;
      for (const match of sql.matchAll(
        /ALTER TABLE ONLY "public"\."(\w+)"\s+ADD CONSTRAINT "[^"]+" FOREIGN KEY \("(\w+)"\) REFERENCES "public"\."family_groups"\("id"\)([^;]*);/g,
      )) {
        found.add(`${match[1]}.${match[2]} ${onDelete(match[3])}`);
      }
      // 列定義の中の col uuid ... REFERENCES public.family_groups(id) ON DELETE CASCADE
      for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS (?:public\.)?(\w+) \(([\s\S]*?)\n\);/gi)) {
        for (const column of match[2].matchAll(/^\s*(\w+)\s+uuid[^\n]*?REFERENCES (?:public\.)?family_groups\s*\(id\)([^\n,]*)/gim)) {
          found.add(`${match[1]}.${column[1]} ${onDelete(column[2])}`);
        }
      }
    }
    expect([...found].sort()).toEqual([...EXPECTED_FOREIGN_KEYS].sort());
    // RESTRICT / NO ACTION の参照が無い (あれば DELETE が 23503 で止まる。設計 P-25)
    expect([...found].filter((entry) => /RESTRICT|NO ACTION/.test(entry))).toEqual([]);
  });

  it('ジョブの時刻 (UTC の分と時) が、ほかの pg_cron のジョブと重ならない', () => {
    const slots = new Map<string, string[]>();
    for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
      const sql = stripSqlComments(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
      for (const match of sql.matchAll(/cron\.schedule\(\s*'([^']+)',\s*'([0-9]+) ([0-9]+) \* \* \*'/g)) {
        const slot = `${match[2]} ${match[3]}`;
        slots.set(slot, [...(slots.get(slot) ?? []), match[1]]);
      }
    }
    expect(slots.get('40 18')).toEqual([JOB_NAME]);
  });

  it.each(TYPE_FILES)('%s に purge_dissolved_family_groups の型がある (p_dry_run は省略できる・戻り値は 4 つの列の配列)', (typeFile) => {
    const source = fs.readFileSync(path.join(ROOT, typeFile), 'utf-8');
    const start = source.indexOf('      purge_dissolved_family_groups: {');
    expect(start, `${typeFile}: purge_dissolved_family_groups が無い`).toBeGreaterThanOrEqual(0);
    const block = source.slice(start, source.indexOf('\n      }\n', start));
    expect(block).toContain('Args: { p_dry_run?: boolean }');
    for (const column of ['dry_run: boolean', 'purge_count: number', 'remaining_count: number', 'skipped_with_consents_count: number']) {
      expect(block, column).toContain(column);
    }
    expect(block).toContain('}[]');
  });
});

/** ON DELETE の指定を CASCADE / SET NULL / RESTRICT / NO ACTION にそろえる (無ければ NO ACTION) */
function onDelete(clause: string): string {
  const match = /ON DELETE (CASCADE|SET NULL|RESTRICT|NO ACTION|SET DEFAULT)/i.exec(clause);
  return match ? match[1].toUpperCase() : 'NO ACTION';
}
