/**
 * #1600 migration *_org_challenge_aggregate_snapshot.sql (と、そのロールバック) のソース走査 contract テスト (DB は使わない)
 *
 * 本物の DB での振る舞い (9 人では集計を返さない・10 人で返す・やめた直後に集計も順位表も動かない・終了したチャレンジを開催中に戻しても
 * 控えが動かない・直接の INSERT が拒まれる) は
 * tests/integration/rls/org-challenge-progress.test.ts / tests/integration/security/org-challenges-api.test.ts /
 * tests/integration/rls/challenge-participants-org-scope.test.ts が確かめる。
 * ここでは、後の migration の上書きや番号の付け直しで崩れやすい所を、ファイルの文面だけで確かめる。
 *   1. 関数 update_org_challenge_progress / get_org_challenge_aggregates / get_org_challenge_ranking / refresh_org_challenge_aggregates を
 *      最後に定義した migration が本 migration で、get_org_challenge_aggregates は控え (organization_challenge_aggregates) から、
 *      get_org_challenge_ranking は順位表の控え (organization_challenge_ranking_entries) から読み、参加者の行を直接数えない・並べない
 *   2. update_org_challenge_progress の定義は、20261014100100 の定義に「今夜の対象を選ぶ 1 か所」(開催中で、控えが無いか
 *      集計に含める最後の日が進んだもの。値を計算し直す集合と人数だけ書く集合に分ける)・計算の対象をその集合に絞ること・
 *      「控えの数え直し (その 2 つの集合を渡す)」・返す jsonb の aggregates を足しただけ。数え直しは、進み具合・順位の書き込みのあと・終了にする前
 *   3. refresh_org_challenge_aggregates は、書くチャレンジを自分では選ばない (種類・開始日を見ない)。渡された集合のうち、
 *      開催中で集計に含める最後の日が進んだものだけを書き、値まで書くのは「値を計算し直した」集合だけ (人数だけの集合は、順位がついた
 *      人数 0・平均 NULL・順位表は空)。ほかに控えの無い終了・中止のチャレンジを最初の 1 回だけ書く。下書きは作らない。
 *      控えの最後の日 (counted_through) は、参加者の行の値が計算された日より先に進めない (開催中は min(終了日, 前日)。控えの無い
 *      終了・中止は、順位がついた参加者がいれば min(終了日, 前日)、いなければ開始日の前日)
 *   4. 権限: 4 本とも service_role だけ。控えの 2 つの表は RLS を有効にし、ポリシーを作らず、anon / authenticated の権限を外す
 *   5. 参加の INSERT ポリシーの最後の定義が、API (POST /api/org/challenges/[id]/join) と同じ条件を見る
 *   6. ロールバックは、20261014100100 の 3 本の定義と #1238 の INSERT ポリシー (本番 baseline) にそのまま戻し、控えと関数を消す
 *   7. 控えを最初に作るのは、毎晩の更新 update_org_challenge_progress(now()) を 1 回流すことだけ (関数をすべて定義したあと)。
 *      参加者の行の値のまま、計算せずに控えに値を書く呼び出し (refresh_org_challenge_aggregates に開催中のチャレンジを渡す) を置かない。
 *      振る舞い (JST 0:00〜03:10 に作っても、終了日が前日のチャレンジの最後の日が値と順位に入ってから終了になる) は
 *      tests/integration/rls/org-challenge-progress.test.ts の K-13 が確かめる
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORG_CHALLENGE_MIN_PARTICIPANTS, ORG_CHALLENGE_TYPES } from '@/lib/org-challenges';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const STEM_SUFFIX = '_org_challenge_aggregate_snapshot';
/** #1132 の migration (本 migration が作り直す 2 本の、1 つ前の定義。ロールバックの戻す先) */
const PREVIOUS_STEM_SUFFIX = '_org_challenge_progress';
/**
 * 本 migration の番号を付け直したとき (origin/main を取り込んだとき) の、main の migration の最大。
 * main に入った migration は CI が本番へ番号順に当てるので、本番に当たり済みの最後の migration より前の番号にすると、
 * 順序の違反として拒まれるか、当たらずに飛ばされる。マージの直前に main がさらに進んでいれば、付け直してここも進める
 */
const MAIN_LATEST_AT_RENUMBER = '20261015180000_meal_image_jobs_pickup_cron.sql';
/** 要件書 (docs/requirements/02-organization-management.md §6.4) の匿名化集計の最低人数 */
const REQUIRED_MIN_PARTICIPANTS = 10;
/** 本 migration が service_role だけに EXECUTE を渡す関数 (引数の型まで含めた完全形)。先頭は本 migration で新しく作るもの */
const SERVICE_ROLE_FUNCTIONS = [
  'public.refresh_org_challenge_aggregates(timestamptz, uuid[], uuid[])',
  'public.update_org_challenge_progress(timestamptz)',
  'public.get_org_challenge_aggregates(uuid)',
  'public.get_org_challenge_ranking(uuid, uuid, integer, boolean)',
];
/** 本 migration が作り直し、ロールバックが 20261014100100 の定義に戻す関数 */
const REPLACED_FUNCTIONS = ['update_org_challenge_progress', 'get_org_challenge_aggregates', 'get_org_challenge_ranking'];
/** 本 migration が作る控えの表 (service_role だけが読み書きする) */
const SNAPSHOT_TABLES = ['organization_challenge_aggregates', 'organization_challenge_ranking_entries'];

const MIGRATION_FILE = /^(\d{14})_.+\.sql$/;

const migrationFiles = fs
  .readdirSync(path.join(ROOT, MIGRATIONS_DIR))
  .filter((name) => MIGRATION_FILE.test(name))
  .sort();

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

/** SQL のコメント (-- から行末、/* ... *\/) を取り除く。コメントの中の語を拾わないように */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

function onlyFileWithSuffix(dir: string, suffix: string, ext: string): string {
  const found = fs.readdirSync(path.join(ROOT, dir)).filter((name) => name.endsWith(`${suffix}${ext}`));
  expect(found, `${dir} に *${suffix}${ext} がちょうど 1 つある`).toHaveLength(1);
  return found[0];
}

const MIGRATION_NAME = onlyFileWithSuffix(MIGRATIONS_DIR, STEM_SUFFIX, '.sql');
const PREVIOUS_NAME = onlyFileWithSuffix(MIGRATIONS_DIR, PREVIOUS_STEM_SUFFIX, '.sql');
const ROLLBACK_NAME = onlyFileWithSuffix(ROLLBACKS_DIR, STEM_SUFFIX, '.down.sql');
const MIGRATION = stripSqlComments(read(`${MIGRATIONS_DIR}/${MIGRATION_NAME}`));
const PREVIOUS = stripSqlComments(read(`${MIGRATIONS_DIR}/${PREVIOUS_NAME}`));
const ROLLBACK = stripSqlComments(read(`${ROLLBACKS_DIR}/${ROLLBACK_NAME}`));
const BASELINE = read('supabase/baseline/prod_schema.sql');
const JOIN_ROUTE = read('src/app/api/org/challenges/[id]/join/route.ts');

/** CREATE OR REPLACE FUNCTION public.<name>( ... $$ 本体 $$; の全体 (定義の文) */
function definition(sql: string, name: string): string {
  const m = sql.match(new RegExp(String.raw`CREATE OR REPLACE FUNCTION public\.${name}\([\s\S]*?\$\$[\s\S]*?\$\$;`));
  if (!m) throw new Error(`関数 ${name} の定義が見つからない`);
  return m[0];
}

/** 定義の本体 ($$ と $$ の間) */
function bodyOf(sql: string, name: string): string {
  return definition(sql, name).match(/\$\$([\s\S]*?)\$\$/)![1];
}

/** 関数を最後に定義した migration のファイル名 */
function lastDefiner(name: string): string {
  const pattern = new RegExp(String.raw`CREATE OR REPLACE FUNCTION public\.${name}\(`);
  const found = migrationFiles.filter((f) => pattern.test(stripSqlComments(read(`${MIGRATIONS_DIR}/${f}`))));
  if (found.length === 0) throw new Error(`関数 ${name} を定義する migration が無い`);
  return found[found.length - 1];
}

/** 参加の INSERT ポリシー「Users can join challenges」を最後に作った migration の、その CREATE POLICY 文 */
function lastJoinPolicy(): string {
  const statements = migrationFiles
    .map((f) => stripSqlComments(read(`${MIGRATIONS_DIR}/${f}`)).match(/CREATE POLICY "Users can join challenges"[\s\S]*?\);\s*(?:\n|$)/))
    .filter((m): m is RegExpMatchArray => m !== null);
  if (statements.length === 0) throw new Error('「Users can join challenges」を作る migration が無い');
  return statements[statements.length - 1][0];
}

/** 正規表現の中で文字どおりに扱う (関数の完全形の . ( ) [ ] など) */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 空白の違いを無視して比べる */
function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** SQL の中の 'a', 'b', 'c' のような文字列の並び */
function quotedList(sql: string): string[] {
  return [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('1. 最後の定義が本 migration で、集計は控えから読む', () => {
  it.each([...REPLACED_FUNCTIONS, 'refresh_org_challenge_aggregates'])(
    '%s を最後に定義した migration は本 migration',
    (name) => {
      expect(lastDefiner(name)).toBe(MIGRATION_NAME);
    },
  );

  it('本 migration は #1132 の migration より後の番号', () => {
    expect(MIGRATION_NAME > PREVIOUS_NAME).toBe(true);
  });

  it('本 migration は、番号を付け直したときの main の最大より後の番号。同じ番号 (先頭 14 桁) の migration はほかに無い', () => {
    expect(migrationFiles).toContain(MAIN_LATEST_AT_RENUMBER);
    expect(MIGRATION_NAME > MAIN_LATEST_AT_RENUMBER).toBe(true);
    const stamp = MIGRATION_NAME.slice(0, MIGRATION_NAME.indexOf('_'));
    expect(migrationFiles.filter((f) => f.startsWith(`${stamp}_`))).toEqual([MIGRATION_NAME]);
  });

  it('get_org_challenge_aggregates は控えの表から読み、参加者の行を直接数えない。最小人数は 10 人 (共有の定数と同じ)', () => {
    const body = bodyOf(MIGRATION, 'get_org_challenge_aggregates');
    expect(body).toMatch(/LEFT JOIN public\.organization_challenge_aggregates AS s\s+ON s\.challenge_id = c\.id/);
    expect(body).not.toMatch(/organization_challenge_participants/);
    const m = body.match(/SELECT (\d+) AS min_participants/);
    expect(m, '最小人数が見つからない').not.toBeNull();
    expect(Number(m![1])).toBe(REQUIRED_MIN_PARTICIPANTS);
    expect(ORG_CHALLENGE_MIN_PARTICIPANTS).toBe(REQUIRED_MIN_PARTICIPANTS);
    // 人数も平均も、控えの人数が最小人数以上のときだけ出す
    expect(body).toMatch(/CASE WHEN s\.participant_count >= cfg\.min_participants THEN s\.participant_count::bigint END/);
    expect(body).toMatch(/CASE WHEN s\.ranked_count >= cfg\.min_participants THEN round\(s\.average_value, 1\) END/);
  });

  it.each(['get_org_challenge_aggregates', 'get_org_challenge_ranking'])(
    '%s の引数・返す列・SECURITY INVOKER・STABLE・search_path は 20261014100100 と同じ',
    (name) => {
      const header = (sql: string) => squash(definition(sql, name).split('$$')[0]);
      expect(header(MIGRATION)).toBe(header(PREVIOUS));
      expect(header(MIGRATION)).toContain('SECURITY INVOKER');
      expect(header(MIGRATION)).toContain('STABLE');
      expect(header(MIGRATION)).toContain("SET search_path = ''");
    },
  );

  it('get_org_challenge_ranking は順位表の控えから並べ、参加者の行は「見る人がいま参加者か」の確認にだけ使う。人数の決め方 (cfg) は 20261014100100 と同じ', () => {
    const body = bodyOf(MIGRATION, 'get_org_challenge_ranking');
    const ranked = body.match(/ranked AS \(([\s\S]*?)\)\s*SELECT r\.rank/);
    expect(ranked, '順位表の CTE (ranked) が見つからない').not.toBeNull();
    expect(ranked![1]).toMatch(/FROM public\.organization_challenge_ranking_entries AS e/);
    expect(ranked![1]).not.toMatch(/organization_challenge_participants/);
    // 見られる人の確認 (EXISTS) は、20261014100100 と同じ (いまの参加者で、今も組織のメンバーである本人だけ)
    const gate = (sql: string) => squash(bodyOf(sql, 'get_org_challenge_ranking').match(/AND EXISTS \(([\s\S]*?)\)\s*ORDER BY r\.pos/)![1]);
    expect(gate(MIGRATION)).toBe(gate(PREVIOUS));
    const cfg = (sql: string) => bodyOf(sql, 'get_org_challenge_ranking').match(/SELECT \d+ AS default_limit, \d+ AS max_limit/)![0];
    expect(cfg(MIGRATION)).toBe(cfg(PREVIOUS));
  });
});

describe('2. update_org_challenge_progress は、1 つ前の定義に「今夜の対象を選ぶ 1 か所」と控えの数え直しを足しただけ', () => {
  /** 今夜の対象を選ぶ文 (値を計算し直す集合と、人数だけ書く集合) */
  const SELECTION = /\n\s*SELECT COALESCE\(array_agg\(x\.id\) FILTER \(WHERE x\.computable\), '\{\}'::uuid\[\]\),[\s\S]*?INTO v_recompute, v_count_only[\s\S]*?\) AS x;\n/;
  /** 計算の対象 (target) を、上で選んだ集合に絞る条件 */
  const TARGET_WHERE = /WHERE c\.id = ANY \(v_recompute\)\n/;
  /** 1 つ前の定義の、計算の対象の条件 (上の選ぶ文の computable と同じ式) */
  const PREVIOUS_TARGET_WHERE =
    "WHERE c.status = 'active' AND c.challenge_type IN ('breakfast_rate', 'veg_score', 'cooking_rate') AND c.start_date <= LEAST(c.end_date, v_last_day)\n";
  const CALL = /\n\s*v_aggregates := public\.refresh_org_challenge_aggregates\(p_now, v_recompute, v_count_only\);\n/;
  const DECLARES = [/\n\s*v_recompute\s+uuid\[\];/, /\n\s*v_count_only\s+uuid\[\];/, /\n\s*v_aggregates\s+integer := 0;/];
  const RESULT_KEY = /\n\s*'aggregates',\s+v_aggregates,/;

  it('足した部分 (対象を選ぶ文・対象の絞り込み・数え直しの呼び出し・変数・返す jsonb のキー) を除くと、20261014100100 の定義と同じ', () => {
    const current = definition(MIGRATION, 'update_org_challenge_progress');
    for (const added of [SELECTION, TARGET_WHERE, CALL, ...DECLARES, RESULT_KEY]) expect(current).toMatch(added);
    let stripped = current.replace(SELECTION, '\n').replace(TARGET_WHERE, PREVIOUS_TARGET_WHERE).replace(CALL, '\n').replace(RESULT_KEY, '');
    for (const declared of DECLARES) stripped = stripped.replace(declared, '');
    expect(squash(stripped)).toBe(squash(definition(PREVIOUS, 'update_org_challenge_progress')));
  });

  it('今夜の対象は、開催中で、控えが無いか集計に含める最後の日が進んだものだけ。値を計算し直すのは計算できる種類で集計できる日があるもの、残りは人数だけ', () => {
    const selection = squash(bodyOf(MIGRATION, 'update_org_challenge_progress').match(SELECTION)![0]);
    expect(selection).toContain(
      "WHERE c.status = 'active' AND (s.challenge_id IS NULL OR LEAST(c.end_date, v_last_day) > s.counted_through)",
    );
    expect(selection).toContain("COALESCE(array_agg(x.id) FILTER (WHERE NOT x.computable), '{}'::uuid[])");
    // 計算できるかの式は、1 つ前の定義の計算の対象の条件 (種類・開始日) と同じ
    const computable = selection.match(/\((c\.challenge_type IN \([^)]*\) AND c\.start_date <= LEAST\(c\.end_date, v_last_day\))\) AS computable/);
    expect(computable, '計算できるかの式が見つからない').not.toBeNull();
    expect(squash(PREVIOUS_TARGET_WHERE)).toContain(computable![1]);
    expect(quotedList(computable![1]).sort()).toEqual([...ORG_CHALLENGE_TYPES].sort());
  });

  it('計算の対象 (target) は、選んだ集合 (v_recompute) だけ。状態・種類・開始日の条件を別に書かない (選ぶのは 1 か所だけ)', () => {
    const target = bodyOf(MIGRATION, 'update_org_challenge_progress').match(/WITH target AS \(([\s\S]*?)\),\s*member AS/);
    expect(target, '計算の対象 (target) が見つからない').not.toBeNull();
    const where = squash(target![1].split('FROM public.organization_challenges AS c')[1]);
    expect(where).toBe('WHERE c.id = ANY (v_recompute)');
  });

  it('数え直しは、進み具合・順位の書き込みのあと、終了にする (completed) 前。選んだ 2 つの集合を渡す', () => {
    const body = bodyOf(MIGRATION, 'update_org_challenge_progress');
    const selected = body.search(SELECTION);
    const written = body.indexOf('UPDATE public.organization_challenge_participants');
    const refresh = body.search(/public\.refresh_org_challenge_aggregates\(p_now, v_recompute, v_count_only\)/);
    const complete = body.indexOf("SET status = 'completed'");
    expect(selected).toBeGreaterThan(-1);
    expect(written).toBeGreaterThan(selected);
    expect(refresh).toBeGreaterThan(written);
    expect(complete).toBeGreaterThan(refresh);
  });
});

describe('3. 控えを書き直すのは、渡された集合のうち、集計に含める最後の日が進んだものだけ', () => {
  const body = bodyOf(MIGRATION, 'refresh_org_challenge_aggregates');
  /** 書くチャレンジを選ぶ文 (WITH picked AS ( ... ) SELECT ... INTO v_full, v_count_only FROM picked AS k;) */
  const picked = body.match(/WITH picked AS \(([\s\S]*?)\)\s*SELECT ([\s\S]*?)\s+INTO v_full, v_count_only\s+FROM picked AS k;/);

  it('集計に含める最後の日は、update_org_challenge_progress と同じ決め方 (JST の今日の前日。終了日で打ち切る)', () => {
    expect(body).toMatch(/v_today\s+:= \(COALESCE\(p_now, now\(\)\) AT TIME ZONE 'Asia\/Tokyo'\)::date;/);
    expect(body).toMatch(/v_last_day := v_today - 1;/);
    expect(bodyOf(MIGRATION, 'update_org_challenge_progress')).toMatch(/v_last_day := v_today - 1;/);
    const agg = squash(body.match(/WITH agg AS \(([\s\S]*?)\),\s*written AS/)![1]);
    expect(agg).toContain("CASE WHEN c.status = 'active' THEN LEAST(c.end_date, v_last_day)");
  });

  it('控えの最後の日は、参加者の行の値が計算された日より先に進めない: 控えの無い終了・中止は、順位がついた参加者がいれば min(終了日, 前日)、いなければ開始日の前日', () => {
    const agg = squash(body.match(/WITH agg AS \(([\s\S]*?)\),\s*written AS/)![1]);
    expect(agg).toContain(
      "CASE WHEN c.status = 'active' THEN LEAST(c.end_date, v_last_day) " +
        'WHEN EXISTS ( SELECT 1 FROM public.organization_challenge_participants AS rp WHERE rp.challenge_id = c.id AND rp.rank IS NOT NULL ) ' +
        'THEN LEAST(c.end_date, v_last_day) ' +
        'ELSE LEAST(c.start_date - 1, v_last_day) END AS counted_through',
    );
    // counted_through を決める式は 1 つだけ (ほかの場所で LEAST(c.end_date, v_last_day) をそのまま書かない)
    expect([...agg.matchAll(/AS counted_through/g)]).toHaveLength(1);
    expect(agg).toContain('GROUP BY c.id, c.status, c.start_date, c.end_date');
  });

  it('引数は p_now と、値を計算し直した集合・人数だけ書く集合 (既定は空 = 単独で呼んでも開催中のチャレンジは書かない)', () => {
    const header = squash(definition(MIGRATION, 'refresh_org_challenge_aggregates').split('$$')[0]);
    expect(header).toContain(
      "refresh_org_challenge_aggregates( p_now timestamptz DEFAULT now(), p_recomputed_ids uuid[] DEFAULT '{}'::uuid[], p_count_only_ids uuid[] DEFAULT '{}'::uuid[] )",
    );
  });

  it("書いてよいのは、開催中で控えが無いか最後の日が進んだもの (update_org_challenge_progress の選ぶ文と同じ式) と、控えの無い終了・中止。下書きは入らない", () => {
    expect(picked, '書くチャレンジを選ぶ文が見つからない').not.toBeNull();
    const cte = squash(picked![1]);
    expect(cte).toContain(
      "WHERE (c.status = 'active' AND (s.challenge_id IS NULL OR LEAST(c.end_date, v_last_day) > s.counted_through)) " +
        "OR (c.status IN ('completed', 'cancelled') AND s.challenge_id IS NULL)",
    );
    const updateSelection = squash(bodyOf(MIGRATION, 'update_org_challenge_progress'));
    expect(updateSelection).toContain('(s.challenge_id IS NULL OR LEAST(c.end_date, v_last_day) > s.counted_through)');
    expect(quotedList(cte.split('WHERE')[1]).sort()).toEqual(['active', 'cancelled', 'completed']);
  });

  it('書くチャレンジは自分では選ばない: 種類・開始日を見ず、開催中のものは渡された集合に入っているものだけ。両方に入っていたら人数だけ', () => {
    expect(body).not.toMatch(/challenge_type/);
    // 開始日は、控えの無い終了・中止の最後の日 (一度も計算していなければ開始日の前日) を決めるところにだけ出る (選ぶのには使わない)
    expect(picked![1]).not.toMatch(/start_date/);
    expect([...body.matchAll(/start_date/g)]).toHaveLength(2);
    expect(body).toContain('ELSE LEAST(c.start_date - 1, v_last_day)');
    expect(body).toMatch(/GROUP BY c\.id, c\.status, c\.start_date, c\.end_date/);
    const cte = squash(picked![1]);
    const countOnly = cte.indexOf("WHEN c.status = 'active' AND c.id = ANY (COALESCE(p_count_only_ids, '{}'::uuid[])) THEN 'count_only'");
    const full = cte.indexOf("WHEN c.status = 'active' AND c.id = ANY (COALESCE(p_recomputed_ids, '{}'::uuid[])) THEN 'full'");
    expect(countOnly).toBeGreaterThan(-1);
    expect(full).toBeGreaterThan(countOnly);
    expect(cte).toContain("WHEN c.status IN ('completed', 'cancelled') THEN 'full'");
    // CASE に ELSE は無い (どれにも当たらない開催中のチャレンジは NULL になり、どちらの集合にも入らない)
    expect(cte).not.toMatch(/\bELSE\b/);
    expect(squash(picked![2])).toBe(
      "COALESCE(array_agg(k.id) FILTER (WHERE k.mode = 'full'), '{}'::uuid[]), COALESCE(array_agg(k.id) FILTER (WHERE k.mode = 'count_only'), '{}'::uuid[])",
    );
  });

  it('人数だけのチャレンジは、順位がついた人数 0・平均 NULL・順位表は空 (参加者の行に残った値・順位を控えに入れない)', () => {
    const agg = squash(body.match(/WITH agg AS \(([\s\S]*?)\),\s*written AS/)![1]);
    expect(agg).toContain('CASE WHEN c.id = ANY (v_count_only) THEN 0 ELSE (count(m.user_id) FILTER (WHERE m.rank IS NOT NULL))::integer END AS ranked');
    expect(agg).toContain('CASE WHEN c.id = ANY (v_count_only) THEN NULL ELSE avg(m.current_value) FILTER (WHERE m.rank IS NOT NULL) END AS average_value');
    expect(agg).toContain('WHERE c.id = ANY (v_full) OR c.id = ANY (v_count_only)');
    expect(body).toMatch(
      /DELETE FROM public\.organization_challenge_ranking_entries AS e\s+WHERE e\.challenge_id = ANY \(v_full\) OR e\.challenge_id = ANY \(v_count_only\);/,
    );
    // 順位表に行を入れるのは、値まで書くチャレンジだけ
    expect(body).toMatch(/WHERE c\.id = ANY \(v_full\)\s+AND p\.rank IS NOT NULL;/);
    expect([...body.matchAll(/INSERT INTO public\.organization_challenge_ranking_entries/g)]).toHaveLength(1);
  });

  it('最後の日 (counted_through) も一緒に書く。値が同じでも最後の日は進めて書く', () => {
    expect(body).toMatch(/counted_through\s+= EXCLUDED\.counted_through/);
    // 書かずにおくと、次の機会に「進んだ」と見なされ、人の出入りだけが控えに入る
    expect(body).not.toMatch(/IS DISTINCT FROM/);
  });

  it('数えるのは今も組織のメンバーである参加者だけ (update_org_challenge_progress と同じ絞り込み)', () => {
    expect([...body.matchAll(/JOIN public\.user_profiles AS up\s+ON up\.id = p\.user_id\s+AND up\.organization_id = c\.organization_id/g)]).toHaveLength(2);
  });

  it('update_org_challenge_progress と同じ鍵で直列にする', () => {
    const lock = "pg_advisory_xact_lock(hashtextextended('public.update_org_challenge_progress', 0))";
    expect(body).toContain(lock);
    expect(bodyOf(MIGRATION, 'update_org_challenge_progress')).toContain(lock);
  });

  it('SECURITY DEFINER・search_path が空', () => {
    const header = squash(definition(MIGRATION, 'refresh_org_challenge_aggregates').split('$$')[0]);
    expect(header).toContain('SECURITY DEFINER');
    expect(header).toContain("SET search_path = ''");
  });
});

describe('7. 控えを最初に作るのは、毎晩の更新を 1 回流すことだけ (参加者の行の値のまま、計算せずに控えに値を書かない)', () => {
  /** 関数の定義と文字列 (COMMENT の説明文など) を除いた、migration の上から順の文 (表・権限・ポリシー・最初の作成) */
  const TOP_LEVEL = MIGRATION.replace(/CREATE OR REPLACE FUNCTION public\.\w+\([\s\S]*?\$\$[\s\S]*?\$\$;/g, '').replace(
    /'(?:[^']|'')*'/g,
    "''",
  );

  it('関数の外で呼ぶのは update_org_challenge_progress(now()) の 1 回だけ。refresh_org_challenge_aggregates を関数の外で呼ばない', () => {
    const calls = [...TOP_LEVEL.matchAll(/SELECT public\.(\w+)\(([^;]*)\);/g)].map((m) => `${m[1]}(${squash(m[2])})`);
    expect(calls).toEqual(['update_org_challenge_progress(now())']);
    // refresh_org_challenge_aggregates が関数の外に出るのは、権限 (REVOKE / GRANT) と COMMENT の文だけ
    const mentions = TOP_LEVEL.split(';').filter((stmt) => stmt.includes('refresh_org_challenge_aggregates'));
    expect(mentions.map((stmt) => squash(stmt).split(' ').slice(0, 2).join(' '))).toEqual(['REVOKE ALL', 'GRANT EXECUTE', 'COMMENT ON']);
  });

  it('最初の作成は、控えの表と 4 本の関数をすべて定義したあと (新しい update_org_challenge_progress で流す)', () => {
    const call = MIGRATION.indexOf('SELECT public.update_org_challenge_progress(now());');
    expect(call).toBeGreaterThan(-1);
    for (const name of [...REPLACED_FUNCTIONS, 'refresh_org_challenge_aggregates']) {
      expect(MIGRATION.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`), name).toBeLessThan(call);
    }
    for (const table of SNAPSHOT_TABLES) {
      expect(MIGRATION.indexOf(`CREATE TABLE IF NOT EXISTS public.${table} (`), table).toBeLessThan(call);
    }
  });
});

describe('4. 権限', () => {
  it.each(SERVICE_ROLE_FUNCTIONS)('%s の EXECUTE は service_role だけ (PUBLIC / anon / authenticated から外す)', (fn) => {
    const escaped = escapeRegExp(fn);
    expect(MIGRATION).toMatch(new RegExp(String.raw`REVOKE ALL ON FUNCTION ${escaped}\s+FROM PUBLIC, anon, authenticated, service_role;`));
    expect(MIGRATION).toMatch(new RegExp(String.raw`GRANT EXECUTE ON FUNCTION ${escaped}\s+TO service_role;`));
    const grants = [...MIGRATION.matchAll(new RegExp(String.raw`GRANT [A-Z, ]+ ON FUNCTION ${escaped}\s+TO ([a-z_, ]+);`, 'g'))];
    expect(grants.map((g) => g[1].trim())).toEqual(['service_role']);
  });

  it.each(SNAPSHOT_TABLES)('控えの表 %s は RLS を有効にし、ポリシーを作らず、anon / authenticated の権限を外す', (table) => {
    expect(MIGRATION).toMatch(new RegExp(String.raw`ALTER TABLE public\.${table} ENABLE ROW LEVEL SECURITY;`));
    expect(MIGRATION).toMatch(new RegExp(String.raw`REVOKE ALL ON TABLE public\.${table} FROM PUBLIC, anon, authenticated;`));
    expect(MIGRATION).not.toMatch(new RegExp(String.raw`CREATE POLICY[^;]*ON public\.${table}\b`));
    expect(MIGRATION).not.toMatch(new RegExp(String.raw`GRANT [^;]*ON TABLE public\.${table} TO [^;]*(anon|authenticated)`));
  });

  it('順位表の控えは、アカウントを消した人の行をその場で消す (auth.users を ON DELETE CASCADE で参照する)', () => {
    const table = MIGRATION.match(/CREATE TABLE IF NOT EXISTS public\.organization_challenge_ranking_entries \(([\s\S]*?)\);/);
    expect(table).not.toBeNull();
    expect(squash(table![1])).toContain('user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE');
    expect(squash(table![1])).toContain('PRIMARY KEY (challenge_id, user_id)');
  });
});

describe('5. 参加の INSERT ポリシーは、API と同じ条件を見る', () => {
  const policy = squash(lastJoinPolicy());

  it('最後に作ったのは本 migration', () => {
    const lastFile = migrationFiles.filter((f) => /CREATE POLICY "Users can join challenges"/.test(stripSqlComments(read(`${MIGRATIONS_DIR}/${f}`)))).pop();
    expect(lastFile).toBe(MIGRATION_NAME);
  });

  it('元の条件 (本人・自分の組織のチャレンジ・進捗 0・順位なし) を残す', () => {
    expect(policy).toContain('FOR INSERT TO authenticated');
    expect(policy).toContain('user_id = (SELECT auth.uid())');
    expect(policy).toContain('ON up.organization_id = oc.organization_id');
    expect(policy).toContain('WHERE oc.id = organization_challenge_participants.challenge_id');
    expect(policy).toContain('AND up.id = (SELECT auth.uid())');
    expect(policy).toContain('AND COALESCE(current_value, 0) = 0');
    expect(policy).toContain('AND rank IS NULL');
  });

  it("開催中 (status = 'active') だけ。API は 409 CHALLENGE_NOT_ACTIVE", () => {
    expect(policy).toContain("AND oc.status = 'active'");
    expect(JOIN_ROUTE).toMatch(/challenge\.status !== 'active'[\s\S]{0,200}CHALLENGE_NOT_ACTIVE/);
  });

  it('種類は、食事の記録から計算できる種類 (ORG_CHALLENGE_TYPES) だけ。API は 409 CHALLENGE_TYPE_DISABLED', () => {
    const m = policy.match(/AND oc\.challenge_type IN \(([^)]+)\)/);
    expect(m, 'ポリシーに種類の絞り込みが無い').not.toBeNull();
    expect(quotedList(m![1]).sort()).toEqual([...ORG_CHALLENGE_TYPES].sort());
    expect(JOIN_ROUTE).toMatch(/!isOrgChallengeType\(challenge\.challenge_type\)[\s\S]{0,200}CHALLENGE_TYPE_DISABLED/);
  });

  it('終了日 (JST の暦日) を過ぎていない。API は 409 CHALLENGE_ENDED (todayJst と同じ決め方)', () => {
    expect(policy).toContain("AND oc.end_date >= (now() AT TIME ZONE 'Asia/Tokyo')::date");
    expect(JOIN_ROUTE).toMatch(/challenge\.end_date < todayJst\(\)[\s\S]{0,200}CHALLENGE_ENDED/);
  });

  it('部署を限定したチャレンジは、その部署のメンバーだけ。API は 403 PERM_DEPARTMENT_MISMATCH', () => {
    expect(policy).toContain('AND (oc.department_id IS NULL OR oc.department_id = up.department_id)');
    expect(JOIN_ROUTE).toMatch(
      /challenge\.department_id && challenge\.department_id !== profile\.department_id[\s\S]{0,200}PERM_DEPARTMENT_MISMATCH/,
    );
  });
});

describe('6. ロールバック', () => {
  it.each(REPLACED_FUNCTIONS)('%s を 20261014100100 の定義にそのまま戻す', (name) => {
    expect(squash(definition(ROLLBACK, name))).toBe(squash(definition(PREVIOUS, name)));
  });

  it('戻した 3 本の EXECUTE も service_role だけ', () => {
    for (const fn of SERVICE_ROLE_FUNCTIONS.slice(1)) {
      const escaped = escapeRegExp(fn);
      expect(ROLLBACK).toMatch(new RegExp(String.raw`REVOKE ALL ON FUNCTION ${escaped}\s+FROM PUBLIC, anon, authenticated, service_role;`));
      expect(ROLLBACK).toMatch(new RegExp(String.raw`GRANT EXECUTE ON FUNCTION ${escaped}\s+TO service_role;`));
    }
  });

  it('関数を戻したあとに、数え直しの関数と控えの表を消す', () => {
    const restored = Math.max(
      ...REPLACED_FUNCTIONS.map((name) => ROLLBACK.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)),
    );
    expect(Math.min(...REPLACED_FUNCTIONS.map((name) => ROLLBACK.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)))).toBeGreaterThan(-1);
    const dropFn = ROLLBACK.indexOf('DROP FUNCTION IF EXISTS public.refresh_org_challenge_aggregates(timestamptz, uuid[], uuid[]);');
    expect(dropFn).toBeGreaterThan(restored);
    for (const table of SNAPSHOT_TABLES) {
      expect(ROLLBACK.indexOf(`DROP TABLE IF EXISTS public.${table};`), table).toBeGreaterThan(dropFn);
    }
  });

  it('INSERT ポリシーを #1238 の定義 (本番 baseline) にそのまま戻す', () => {
    const baselinePolicy = BASELINE.match(/CREATE POLICY "Users can join challenges"[\s\S]*?\);\n/);
    const rollbackPolicy = ROLLBACK.match(/CREATE POLICY "Users can join challenges"[\s\S]*?\);\n?/);
    expect(baselinePolicy).not.toBeNull();
    expect(rollbackPolicy).not.toBeNull();
    expect(squash(rollbackPolicy![0])).toBe(squash(baselinePolicy![0]));
    expect(ROLLBACK).toMatch(/DROP POLICY IF EXISTS "Users can join challenges" ON public\.organization_challenge_participants;/);
  });

  it('migration とロールバックの冒頭のコメントが、実際のファイル名を指す', () => {
    const rawMigration = read(`${MIGRATIONS_DIR}/${MIGRATION_NAME}`);
    const rawRollback = read(`${ROLLBACKS_DIR}/${ROLLBACK_NAME}`);
    expect(rawMigration.split('\n')[0]).toBe(`-- migration: ${MIGRATION_NAME}`);
    expect(rawMigration).toContain(`supabase/rollbacks/${ROLLBACK_NAME}`);
    expect(rawRollback.split('\n')[0]).toBe(`-- rollback: ${MIGRATION_NAME}`);
    expect(ROLLBACK_NAME).toBe(MIGRATION_NAME.replace(/\.sql$/, '.down.sql'));
  });
});
