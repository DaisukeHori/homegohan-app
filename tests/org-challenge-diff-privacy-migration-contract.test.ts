/**
 * #1688: migration *_org_challenge_diff_privacy.sql (と、そのロールバック) のソース走査 contract テスト (DB は使わない)
 *
 * 本物の DB での振る舞い (延べ数・確定 1 回・遷移のガード・印・重なりの判定・削除の制限) は、
 * tests/integration/rls/org-challenge-diff-privacy.test.ts と tests/integration/security/org-challenges-api.test.ts が確かめる。
 * ここでは、番号の付け直しや写し間違いで崩れやすい所を、ファイルの文面だけで確かめる (設計 docs/design/org/10-challenge-diff-privacy.md §13)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORG_CHALLENGE_MIN_PARTICIPANTS } from '@/lib/org-challenges';
import {
  ORG_CHALLENGE_DELETABLE_STATUSES,
  ORG_CHALLENGE_RANKING_HIDDEN_ROLES,
  ORG_CHALLENGE_STATUS_TRANSITIONS,
} from '@/lib/org-challenge-privacy';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const STEM_SUFFIX = '_org_challenge_diff_privacy';
/** 集計の関数を 1 つ前に定義した migration (#1600) と、順位表の関数を 1 つ前に定義した migration (#1132)。ロールバックの戻す先 */
const MIN10_STEM_SUFFIX = '_org_challenge_min10_join_policy';
const PROGRESS_STEM_SUFFIX = '_org_challenge_progress';

const AGGREGATES = 'get_org_challenge_aggregates';
const RANKING = 'get_org_challenge_ranking';
const PROGRESS = 'update_org_challenge_progress';
const TRIGGER_FUNCTIONS = [
  'org_challenge_count_join',
  'org_challenge_guard_update',
  'org_challenge_finalize',
  'org_challenge_mark_admin',
] as const;
const TRIGGERS = [
  'trg_org_challenge_count_join',
  'trg_org_challenge_guard_update',
  'trg_org_challenge_finalize',
  'trg_org_challenge_mark_admin',
] as const;
const DELETE_POLICY = 'Org challenges can be deleted only as draft or cancelled';
const ADMIN_POLICY = 'Org admins can manage challenges';
/** ガードが止める列 (draft 以外での期間・種類・部署と、常時の organization_id) */
const LOCKED_COLUMNS = ['start_date', 'end_date', 'challenge_type', 'department_id', 'organization_id'] as const;

/** migration のファイル名 (version 14 桁 + `_` + 名前 + `.sql`) */
const MIGRATION_FILE = /^(\d{14})_.+\.sql$/;

const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
/** SQL のコメント (-- から行末、/* ... *\/) を取り除く */
const stripComments = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
/** 空白の並びを 1 つにそろえる */
const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
/** SQL の中の 'a', 'b' のような文字列の並びを取り出す */
const quotedList = (sql: string): string[] => [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

const migrationFiles = (): string[] =>
  fs
    .readdirSync(path.join(ROOT, MIGRATIONS_DIR))
    .filter((f) => MIGRATION_FILE.test(f))
    .sort();

function stemOf(suffix: string): string {
  const found = migrationFiles().filter((f) => f.endsWith(`${suffix}.sql`));
  expect(found, `${suffix} の migration がちょうど 1 本ある`).toHaveLength(1);
  return found[0].replace(/\.sql$/, '');
}

const migration = () => read(`${MIGRATIONS_DIR}/${stemOf(STEM_SUFFIX)}.sql`);
const code = () => stripComments(migration());
const rollback = () => read(`${ROLLBACKS_DIR}/${stemOf(STEM_SUFFIX)}.down.sql`);

/** 関数の定義 (CREATE OR REPLACE から $$; まで)。コメントを除き、空白をそろえる */
function functionOf(sql: string, name: string, where: string): string {
  const m = stripComments(sql).match(
    new RegExp(String.raw`CREATE OR REPLACE FUNCTION public\.${name}\([\s\S]*?\$\$[\s\S]*?\$\$;`),
  );
  if (!m) throw new Error(`${where} に ${name} の定義が無い`);
  return squash(m[0]);
}

/** 関数の本体 ($$ ... $$)。コメントを除く */
function bodyOf(sql: string, name: string): string {
  const m = stripComments(sql).match(
    new RegExp(String.raw`CREATE OR REPLACE FUNCTION public\.${name}\([\s\S]*?\$\$([\s\S]*?)\$\$`),
  );
  if (!m) throw new Error(`${name} の定義が無い`);
  return m[1];
}

/** 番号順で、文面 (コメントを除く) に関数の定義がある migration */
function definingFiles(name: string): string[] {
  const pattern = new RegExp(String.raw`CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.${name}\s*\(`);
  return migrationFiles().filter((f) => pattern.test(stripComments(read(`${MIGRATIONS_DIR}/${f}`))));
}

describe('#1688 冒頭のコメントと番号', () => {
  it('migration と down の 1 行目の名前が実ファイル名と一致し、本文のロールバックの参照が実在する', () => {
    const stem = stemOf(STEM_SUFFIX);
    expect(migration().split('\n')[0]).toBe(`-- migration: ${stem}.sql`);
    expect(migration()).toContain(`-- ロールバック: ${ROLLBACKS_DIR}/${stem}.down.sql`);
    expect(fs.existsSync(path.join(ROOT, ROLLBACKS_DIR, `${stem}.down.sql`))).toBe(true);
    expect(rollback().split('\n')[0]).toBe(`-- rollback: ${stem}.sql`);
  });
});

describe('#1688 状態の NOT NULL', () => {
  it('状態の NULL を draft にする UPDATE と SET NOT NULL が、この順でガードのトリガーの作成より前にある。down は DROP NOT NULL を持つ', () => {
    const sql = squash(code());
    const update = sql.indexOf("UPDATE public.organization_challenges SET status = 'draft' WHERE status IS NULL;");
    const notNull = sql.indexOf('ALTER TABLE public.organization_challenges ALTER COLUMN status SET NOT NULL;');
    const guard = sql.indexOf('CREATE OR REPLACE TRIGGER trg_org_challenge_guard_update');
    expect(update).toBeGreaterThanOrEqual(0);
    expect(notNull).toBeGreaterThan(update);
    expect(guard).toBeGreaterThan(notNull);
    expect(squash(stripComments(rollback()))).toContain(
      'ALTER TABLE public.organization_challenges ALTER COLUMN status DROP NOT NULL;',
    );
  });
});

describe('#1688 新しい表 2 つ', () => {
  it.each(['organization_challenge_aggregates', 'organization_challenge_ranking_exclusions'])(
    '%s を作り、RLS を有効にし、PUBLIC・anon・authenticated の権限を外し、ポリシーを作らない',
    (table) => {
      const sql = squash(code());
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${table} (`);
      expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated;`);
      expect(sql).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${table} TO service_role;`);
      expect(sql).not.toMatch(new RegExp(String.raw`CREATE POLICY [^;]* ON public\.${table}\b`));
      // GRANT は service_role にだけ
      expect(sql.match(new RegExp(String.raw`GRANT [^;]* ON TABLE public\.${table} TO [^;]*;`, 'g'))).toEqual([
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${table} TO service_role;`,
      ]);
    },
  );

  it('印の表の外部キーは organization_challenges(id) と auth.users(id) に ON DELETE CASCADE。集計の表は organization_challenges(id) に CASCADE', () => {
    const sql = squash(code());
    const exclusions = sql.match(/CREATE TABLE IF NOT EXISTS public\.organization_challenge_ranking_exclusions \(([\s\S]*?)\);/);
    expect(exclusions).not.toBeNull();
    expect(exclusions![1]).toContain(
      'challenge_id uuid NOT NULL REFERENCES public.organization_challenges(id) ON DELETE CASCADE',
    );
    expect(exclusions![1]).toContain('user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE');
    expect(exclusions![1]).toContain('PRIMARY KEY (challenge_id, user_id)');
    const aggregates = sql.match(/CREATE TABLE IF NOT EXISTS public\.organization_challenge_aggregates \(([\s\S]*?)\) \);/);
    expect(aggregates).not.toBeNull();
    expect(aggregates![1]).toContain(
      'challenge_id uuid PRIMARY KEY REFERENCES public.organization_challenges(id) ON DELETE CASCADE',
    );
  });
});

describe('#1688 get_org_challenge_aggregates (控えの表から返す)', () => {
  it('最後に定義するのは本 migration。本体は organization_challenge_aggregates から読み、organization_challenge_participants を読まない', () => {
    expect(definingFiles(AGGREGATES).slice(-1)).toEqual([`${stemOf(STEM_SUFFIX)}.sql`]);
    const body = bodyOf(migration(), AGGREGATES);
    expect(body).toMatch(/\bpublic\.organization_challenge_aggregates\b/);
    expect(body).not.toMatch(/\bpublic\.organization_challenge_participants\b/);
  });

  it('cfg の最小人数が ORG_CHALLENGE_MIN_PARTICIPANTS と同じ。名前・引数・返す列・SECURITY INVOKER は 1 つ前 (#1600) と同じ', () => {
    const body = bodyOf(migration(), AGGREGATES);
    expect(body).toContain(`SELECT ${ORG_CHALLENGE_MIN_PARTICIPANTS} AS min_participants`);
    const header = (sql: string) => functionOf(sql, AGGREGATES, 'migration').split(' AS $$')[0];
    expect(header(migration())).toBe(header(read(`${MIGRATIONS_DIR}/${stemOf(MIN10_STEM_SUFFIX)}.sql`)));
    expect(header(migration())).toContain("LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''");
  });

  it('重なりの判定 (同じ種類・期間が重なる (両端を含む)・確定の時刻と ID の順) を持つ', () => {
    const body = squash(bodyOf(migration(), AGGREGATES));
    expect(body).toContain('e.challenge_type = c.challenge_type');
    expect(body).toContain('e.start_date <= c.end_date');
    expect(body).toContain('c.start_date <= e.end_date');
    expect(body).toContain('(e.finalized_at, e.id) < (a.finalized_at, c.id)');
    expect(body).toContain('sa.final_ranked_count >= cfg.min_participants');
    expect(body).toContain('CASE WHEN a.joined_count >= cfg.min_participants THEN a.joined_count::bigint END');
  });

  it('権限を流し直す: service_role にだけ EXECUTE', () => {
    const sql = squash(code());
    expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${AGGREGATES}(uuid) FROM PUBLIC, anon, authenticated, service_role;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${AGGREGATES}(uuid) TO service_role;`);
  });
});

describe('#1688 get_org_challenge_ranking (管理者と印のある人に 0 行)', () => {
  it('最後に定義するのは本 migration。1 つ前の定義 (#1132) に、役割と印の条件だけを足したもの', () => {
    expect(definingFiles(RANKING).slice(-1)).toEqual([`${stemOf(STEM_SUFFIX)}.sql`]);
    const current = functionOf(migration(), RANKING, '本 migration');
    const previous = functionOf(read(`${MIGRATIONS_DIR}/${stemOf(PROGRESS_STEM_SUFFIX)}.sql`), RANKING, '#1132 の migration');
    const added = squash(
      `AND (meup.org_role IS NULL OR meup.org_role NOT IN ('owner', 'admin'))
       AND NOT EXISTS (
         SELECT 1
           FROM public.organization_challenge_ranking_exclusions AS x
          WHERE x.challenge_id = c2.id
            AND x.user_id = p_user_id
       )`,
    );
    const anchor = 'WHERE c2.id = p_challenge_id';
    expect(previous).toContain(`${anchor} )`);
    expect(current).toBe(previous.replace(`${anchor} )`, `${anchor} ${added} )`));
  });

  it('cfg (20 / 100) と LEAST(GREATEST(...)) は 1 つ前と同じ。除外する役割の並びが ORG_CHALLENGE_RANKING_HIDDEN_ROLES と同じ', () => {
    const body = squash(bodyOf(migration(), RANKING));
    expect(body).toContain('SELECT 20 AS default_limit, 100 AS max_limit');
    expect(body).toContain('LEAST(GREATEST(COALESCE(p_limit, cfg.default_limit), 1), cfg.max_limit)');
    const roles = body.match(/meup\.org_role NOT IN \(([^)]*)\)/);
    expect(roles).not.toBeNull();
    expect(quotedList(roles![1])).toEqual([...ORG_CHALLENGE_RANKING_HIDDEN_ROLES]);
    expect(body).toMatch(/NOT EXISTS \( SELECT 1 FROM public\.organization_challenge_ranking_exclusions AS x/);
  });
});

describe('#1688 update_org_challenge_progress は作り直さない', () => {
  it('最後の定義は #1132 の migration のまま', () => {
    expect(definingFiles(PROGRESS).slice(-1)).toEqual([`${stemOf(PROGRESS_STEM_SUFFIX)}.sql`]);
    expect(code()).not.toMatch(new RegExp(String.raw`FUNCTION public\.${PROGRESS}\b`));
  });
});

describe('#1688 ガードのトリガー', () => {
  it('通す遷移は ORG_CHALLENGE_STATUS_TRANSITIONS の 5 本と同じ。NEW.status IS NULL を断り、比較を COALESCE(..., false) で包む', () => {
    const body = bodyOf(migration(), 'org_challenge_guard_update');
    const allowed = [...body.matchAll(/\(v_from = '([a-z]+)'\s+AND NEW\.status IN \(([^)]*)\)\)/g)].flatMap((m) =>
      quotedList(m[2]).map((to) => `${m[1]}>${to}`),
    );
    const expected = Object.entries(ORG_CHALLENGE_STATUS_TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => `${from}>${to}`));
    expect(allowed.sort()).toEqual(expected.sort());
    expect(squash(body)).toContain('IF NEW.status IS NULL OR NOT COALESCE(');
    expect(squash(body)).toMatch(/, false \) THEN RAISE EXCEPTION 'CHALLENGE_STATUS_LOCKED'/);
  });

  it('止める列は start_date・end_date・challenge_type・department_id・organization_id (draft 以外で期間・種類・部署、常時の組織)', () => {
    const body = squash(bodyOf(migration(), 'org_challenge_guard_update'));
    for (const column of LOCKED_COLUMNS) {
      expect(body).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`);
    }
    expect(body).toContain("IF v_from <> 'draft' AND (");
    expect(body.match(/RAISE EXCEPTION 'CHALLENGE_PERIOD_LOCKED'/g)).toHaveLength(2);
  });

  it('BEFORE UPDATE ON organization_challenges の行ごとのトリガー', () => {
    expect(squash(code())).toContain(
      'CREATE OR REPLACE TRIGGER trg_org_challenge_guard_update BEFORE UPDATE ON public.organization_challenges FOR EACH ROW EXECUTE FUNCTION public.org_challenge_guard_update();',
    );
  });
});

describe('#1688 確定のトリガー', () => {
  it('AFTER UPDATE OF status と NEW.status = completed の WHEN を持つ', () => {
    expect(squash(code())).toContain(
      "CREATE OR REPLACE TRIGGER trg_org_challenge_finalize AFTER UPDATE OF status ON public.organization_challenges FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'completed') EXECUTE FUNCTION public.org_challenge_finalize();",
    );
  });

  it('INSERT は WHERE a.finalized_at IS NULL で 1 回だけ。INSERT より前に組織ごとの advisory lock を取り、確定の時刻に鍵の後の clock_timestamp() を使い、本体に now() を持たない', () => {
    const body = squash(bodyOf(migration(), 'org_challenge_finalize'));
    const lock = body.indexOf(
      "PERFORM pg_catalog.pg_advisory_xact_lock( pg_catalog.hashtextextended('org_challenge_finalize:' || NEW.organization_id::text, 0));",
    );
    const clock = body.indexOf('v_finalized_at := pg_catalog.clock_timestamp();');
    const insert = body.indexOf('INSERT INTO public.organization_challenge_aggregates');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(clock).toBeGreaterThan(lock);
    expect(insert).toBeGreaterThan(clock);
    expect(body).toContain('ON CONFLICT (challenge_id) DO UPDATE');
    expect(body).toMatch(/WHERE a\.finalized_at IS NULL; RETURN NULL;/);
    // 確定の時刻 (finalized_at) と updated_at はどちらも鍵の後の時刻 (v_finalized_at)
    expect(body).toContain('SELECT NEW.id, 0, v_finalized_at,');
    expect(body).toMatch(/round\(avg\(p\.current_value\) FILTER \(WHERE p\.rank IS NOT NULL\), 1\), v_finalized_at FROM/);
    expect(body).not.toMatch(/\bnow\(\)/);
  });
});

describe('#1688 延べ数と印のトリガー', () => {
  it('参加の INSERT にだけ延べ数のトリガーを付け、DELETE・UPDATE には付けない', () => {
    const sql = squash(code());
    expect(sql).toContain(
      'CREATE OR REPLACE TRIGGER trg_org_challenge_count_join AFTER INSERT ON public.organization_challenge_participants FOR EACH ROW EXECUTE FUNCTION public.org_challenge_count_join();',
    );
    const onParticipants = [...sql.matchAll(/CREATE OR REPLACE TRIGGER (\w+) ([^;]*?) ON public\.organization_challenge_participants/g)];
    expect(onParticipants.map((m) => [m[1], m[2]])).toEqual([['trg_org_challenge_count_join', 'AFTER INSERT']]);
  });

  it('印のトリガーは AFTER INSERT OR UPDATE OF org_role, organization_id ON public.user_profiles で、関数の NOT IN の並びが ORG_CHALLENGE_RANKING_HIDDEN_ROLES と同じ', () => {
    expect(squash(code())).toContain(
      'CREATE OR REPLACE TRIGGER trg_org_challenge_mark_admin AFTER INSERT OR UPDATE OF org_role, organization_id ON public.user_profiles FOR EACH ROW EXECUTE FUNCTION public.org_challenge_mark_admin();',
    );
    const roles = bodyOf(migration(), 'org_challenge_mark_admin').match(/NEW\.org_role NOT IN \(([^)]*)\)/);
    expect(roles).not.toBeNull();
    expect(quotedList(roles![1])).toEqual([...ORG_CHALLENGE_RANKING_HIDDEN_ROLES]);
  });

  it('トリガー関数 4 本は PUBLIC・anon・authenticated・service_role から EXECUTE を外し、誰にも GRANT しない', () => {
    const sql = squash(code());
    for (const fn of TRIGGER_FUNCTIONS) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn}() FROM PUBLIC, anon, authenticated, service_role;`);
      expect(sql).not.toMatch(new RegExp(String.raw`GRANT [^;]* ON FUNCTION public\.${fn}\(`));
      expect(sql).toMatch(new RegExp(String.raw`CREATE OR REPLACE FUNCTION public\.${fn}\(\) RETURNS trigger`));
    }
  });
});

describe('#1688 削除のポリシー', () => {
  it('AS RESTRICTIVE・FOR DELETE・TO authenticated で、status IN (...) の並びが ORG_CHALLENGE_DELETABLE_STATUSES と同じ。作る前に同じ名前を消す', () => {
    const sql = squash(code());
    const drop = `DROP POLICY IF EXISTS "${DELETE_POLICY}" ON public.organization_challenges;`;
    const policy = sql.match(
      new RegExp(
        String.raw`CREATE POLICY "${DELETE_POLICY}" ON public\.organization_challenges AS RESTRICTIVE FOR DELETE TO authenticated USING \(status IN \(([^)]*)\)\);`,
      ),
    );
    expect(sql).toContain(drop);
    expect(policy).not.toBeNull();
    expect(sql.indexOf(drop)).toBeLessThan(sql.indexOf(`CREATE POLICY "${DELETE_POLICY}"`));
    expect(quotedList(policy![1])).toEqual([...ORG_CHALLENGE_DELETABLE_STATUSES]);
  });

  it(`「${ADMIN_POLICY}」を作り直さない`, () => {
    expect(code()).not.toContain(ADMIN_POLICY);
  });
});

describe('#1688 埋め戻し', () => {
  it('延べ数と確定の埋め戻しは ON CONFLICT で冪等。確定は completed だけで、確定済みは上書きしない。印は埋め戻さない', () => {
    const sql = squash(code());
    const section = sql.slice(sql.lastIndexOf('INSERT INTO public.organization_challenge_aggregates AS a (challenge_id, joined_count) SELECT'));
    expect(section).toContain('ON CONFLICT (challenge_id) DO NOTHING;');
    expect(section).toContain("WHERE c.status = 'completed'");
    expect(section).toMatch(/ON CONFLICT \(challenge_id\) DO UPDATE SET [^;]* WHERE a\.finalized_at IS NULL;$/);
    expect(sql).not.toMatch(/INSERT INTO public\.organization_challenge_ranking_exclusions[^;]*SELECT c\.id, up\./);
    // 印の表に書くのはトリガー関数 org_challenge_mark_admin だけ
    expect(sql.match(/INSERT INTO public\.organization_challenge_ranking_exclusions/g)).toHaveLength(1);
  });
});

describe('#1688 ロールバック', () => {
  it('トリガー → 関数 → ポリシー → 2 本の関数の復元 → 表 2 つ → NOT NULL の順', () => {
    const sql = squash(stripComments(rollback()));
    const order = [
      ...TRIGGERS.map((t) => sql.indexOf(`DROP TRIGGER IF EXISTS ${t} `)),
      ...TRIGGER_FUNCTIONS.map((f) => sql.indexOf(`DROP FUNCTION IF EXISTS public.${f}();`)),
      sql.indexOf(`DROP POLICY IF EXISTS "${DELETE_POLICY}" ON public.organization_challenges;`),
      sql.indexOf(`CREATE OR REPLACE FUNCTION public.${AGGREGATES}(`),
      sql.indexOf(`CREATE OR REPLACE FUNCTION public.${RANKING}(`),
      sql.indexOf('DROP TABLE IF EXISTS public.organization_challenge_ranking_exclusions;'),
      sql.indexOf('DROP TABLE IF EXISTS public.organization_challenge_aggregates;'),
      sql.indexOf('ALTER TABLE public.organization_challenges ALTER COLUMN status DROP NOT NULL;'),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('復元した 2 本の定義は 20261016170000 (集計) と 20261014100100 (順位表) の逐語で、権限を service_role だけに流し直す', () => {
    const down = rollback();
    expect(functionOf(down, AGGREGATES, 'ロールバック')).toBe(
      functionOf(read(`${MIGRATIONS_DIR}/${stemOf(MIN10_STEM_SUFFIX)}.sql`), AGGREGATES, '#1600 の migration'),
    );
    expect(functionOf(down, RANKING, 'ロールバック')).toBe(
      functionOf(read(`${MIGRATIONS_DIR}/${stemOf(PROGRESS_STEM_SUFFIX)}.sql`), RANKING, '#1132 の migration'),
    );
    const sql = squash(stripComments(down));
    expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${AGGREGATES}(uuid) FROM PUBLIC, anon, authenticated, service_role;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${AGGREGATES}(uuid) TO service_role;`);
    expect(sql).toContain(
      `REVOKE ALL ON FUNCTION public.${RANKING}(uuid, uuid, integer, boolean) FROM PUBLIC, anon, authenticated, service_role;`,
    );
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${RANKING}(uuid, uuid, integer, boolean) TO service_role;`);
  });
});
