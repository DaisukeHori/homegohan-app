/**
 * #1125 / #1157 古いログの定期削除と日次のアクティブ利用者の集計 (migration 20261010150000) のソース走査 contract テスト (DB には接続しない)
 *
 * 実際の動き (JST の境界・権限・ジョブの登録) は tests/integration/security/log-cleanup-and-dau-snapshot.test.ts で確かめる。
 * ここでは、DB を立てなくても CI の通常のテストで止められる「書き方の取り決め」を固定する。
 *
 *   1. migration と rollback が同じ version / 名前で対になっている
 *   2. snapshot_daily_active_users は LANGUAGE sql (列名の誤りが適用時に分かる)・SECURITY DEFINER・search_path 空で、
 *      GoTrue の古い版に無い列 (auth.sessions.refreshed_at / auth.users.is_anonymous) を参照しない。
 *      本番の GoTrue は supabase/.temp/gotrue-version では v2.183.0 (link 時点の版) だが、その後の更新はリポジトリから分からないので、
 *      全ての版にある列 (user_id / created_at / updated_at / last_sign_in_at / deleted_at) だけを使う
 *      さらに、関数を作った直後に昔の日付で 1 回試し実行して、書いた行を取り消す (作れても動かない状態を、適用時に止める)
 *   3. 2 つの関数の EXECUTE は service_role だけ (PUBLIC / anon / authenticated から外す)
 *   4. ジョブ 2 つの名前・時刻 (UTC) ・command が決めたとおり。時刻は JST で 03:15 と 01:30 になる
 *   5. pg_cron が無い DB では登録を飛ばす (cron.job の存在を確かめてから触る)。実行ログ (RAISE) に command を載せない
 *   6. #1125 の第 1 段の範囲: オーナーの選択「課金は無料のまま計測」により、課金系の定期処理はこの段では足さない (revenue_snapshots / Stripe / ライセンスに触れない)。
 *      failed_invite_lookups / infra_metrics には書き込む処理が無いので、この段では掃除のジョブを足さない
 *   7. 既存の行を変えない・消さない (UPDATE / DELETE / TRUNCATE を書かない)
 *   8. 設計書 docs/design/operator/08-cron-batches.md に、2 つのジョブと migration の version が書かれていて、付け直す前の version (20261008200000) が設計書・SQL・DB のテストに残っていない
 *   9. 設計書の「いま」の記述 (§3.0・§3.1・§3.2・§5 の状態の注記) が、木の実物と合っている:
 *      Vercel Cron は vercel.json の crons と、pg_cron のジョブは supabase/migrations の cron.schedule と、名前も数も一致する。
 *      #1125 の課金系の扱いは、migration と同じ「この段では足さない」の言い回しで書き、恒久の判断 (「作らない」) として書かない
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

const ROOT = path.resolve(__dirname, '..');
const VERSION = '20261010150000';
// 付け直す前の version。main の最大より下だったため VERSION へ付け直した (#1125)。設計書・SQL・DB のテストに残っていないことを確かめる
const STALE_VERSION = '20261008200000';
const NAME = 'schedule_log_cleanup_and_dau_snapshot';
const MIGRATION_PATH = path.join(ROOT, 'supabase', 'migrations', `${VERSION}_${NAME}.sql`);
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${VERSION}_${NAME}.down.sql`);
const DOC_PATH = path.join(ROOT, 'docs', 'design', 'operator', '08-cron-batches.md');
const INTEGRATION_TEST_PATH = path.join(ROOT, 'tests', 'integration', 'security', 'log-cleanup-and-dau-snapshot.test.ts');
const VERCEL_JSON_PATH = path.join(ROOT, 'vercel.json');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');

const migration = fs.readFileSync(MIGRATION_PATH, 'utf-8');

/** `--` の行コメントを取り除く (この migration の文字列リテラルには `--` を含むものが無い) */
const stripLineComments = (sql: string) => sql.replace(/--.*$/gm, '');
const code = stripLineComments(migration);

/** CREATE OR REPLACE FUNCTION public.snapshot_daily_active_users の属性 (AS $$ の手前まで) と本体 */
function snapshotFunction(): { header: string; body: string } {
  const start = code.indexOf('CREATE OR REPLACE FUNCTION public.snapshot_daily_active_users(');
  expect(start, 'snapshot_daily_active_users の CREATE OR REPLACE FUNCTION が見つからない').toBeGreaterThanOrEqual(0);
  const rest = code.slice(start);
  const opener = /\bAS\s+\$\$/.exec(rest);
  expect(opener, 'AS $$ が見つからない').not.toBeNull();
  const bodyStart = (opener as RegExpExecArray).index + (opener as RegExpExecArray)[0].length;
  const bodyEnd = rest.indexOf('$$', bodyStart);
  expect(bodyEnd, '本体の終わりの $$ が見つからない').toBeGreaterThan(bodyStart);
  return { header: rest.slice(0, (opener as RegExpExecArray).index), body: rest.slice(bodyStart, bodyEnd) };
}

describe('#1125 / #1157 migration と rollback のファイル', () => {
  it('rollback が同じ version / 名前で対になっていて、ジョブの登録解除・関数の削除・cleanup_old_logs の権限の復元を行う', () => {
    expect(fs.existsSync(ROLLBACK_PATH), `supabase/rollbacks/${VERSION}_${NAME}.down.sql が無い`).toBe(true);
    const rollback = stripLineComments(fs.readFileSync(ROLLBACK_PATH, 'utf-8'));
    expect(rollback).toContain("'cleanup-old-app-logs'");
    expect(rollback).toContain("'snapshot-daily-active-users'");
    expect(rollback).toMatch(/cron\.unschedule\(/);
    expect(rollback).toMatch(/DROP FUNCTION IF EXISTS public\.snapshot_daily_active_users\(date\)/);
    // 本番の元の権限 (supabase/baseline/prod_function_acl.sql) に戻す
    for (const role of ['PUBLIC', 'anon', 'authenticated', 'service_role']) {
      expect(rollback).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.cleanup_old_logs\\(\\) TO ${role}\\b`));
    }
    // 本番の元の関数にコメントは無い。この migration が付けたコメント (権限は service_role だけ、と書いてある) を外す
    expect(rollback).toMatch(/COMMENT ON FUNCTION public\.cleanup_old_logs\(\) IS NULL/);
    // 集計した行 (daily_active_users) とログは、ロールバックでも消さない
    expect(rollback).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(rollback).not.toMatch(/\bTRUNCATE\b/i);
    expect(rollback).not.toMatch(/\bDROP\s+TABLE\b/i);
  });
});

describe('#1125 snapshot_daily_active_users の書き方', () => {
  it('LANGUAGE sql・SECURITY DEFINER・SET search_path = ・引数は日付 1 つ (列名の誤りが migration の適用時に分かる)', () => {
    const { header } = snapshotFunction();
    expect(header).toMatch(/snapshot_daily_active_users\(p_date date\)/);
    expect(header).toMatch(/\bLANGUAGE\s+sql\b/);
    expect(header).toMatch(/\bSECURITY\s+DEFINER\b/);
    expect(header).toMatch(/SET\s+search_path\s*=\s*''/);
    expect(header).toMatch(/\bVOLATILE\b/);
    // plpgsql に書き換えると、列名の誤りが最初の cron の実行まで分からなくなる
    expect(header).not.toMatch(/\bplpgsql\b/i);
  });

  it('GoTrue の全ての版にある列だけを使う: auth.sessions(user_id, created_at, updated_at) と auth.users(id, last_sign_in_at, deleted_at)', () => {
    const { body } = snapshotFunction();
    expect(body, 'auth.sessions.refreshed_at は古い版に無い').not.toMatch(/refreshed_at/i);
    expect(body, 'auth.users.is_anonymous は古い版に無い').not.toMatch(/is_anonymous/i);
    expect(body).toMatch(/auth\.sessions/);
    expect(body).toMatch(/auth\.users/);
    for (const column of ['user_id', 'created_at', 'updated_at', 'last_sign_in_at', 'deleted_at']) {
      expect(body, `${column} を使っていること`).toMatch(new RegExp(`\\b${column}\\b`));
    }
    // 日付は JST の暦日。範囲は [開始, 終了) (終了は含めない)
    expect(body).toContain("AT TIME ZONE 'Asia/Tokyo'");
    expect(body).toMatch(/p_date - 6/);
    expect(body).toMatch(/p_date - 29/);
    expect(body).toMatch(/p_date \+ 1/);
    expect(body).toMatch(/active_at\s*<\s+b\.range_end/);
    // 書く先は (p_date, 'all', '') の 1 行
    expect(body).toMatch(/SELECT p_date, 'all', ''/);
    expect(body).toMatch(/ON CONFLICT \(date, plan_type, plan_key\) DO UPDATE/);
  });

  it('関数内の参照は完全修飾 (search_path が空でも動く)。動的 SQL は使わない', () => {
    const { body } = snapshotFunction();
    expect(body).toMatch(/INSERT INTO public\.daily_active_users/);
    expect(body).not.toMatch(/\bEXECUTE\b/i);
    // スキーマ名なしの表の参照が無い: FROM / JOIN / INTO の直後は auth. か public.、または CTE の名前
    const ctes = new Set(['bounds', 'signals', 'active', 'counts']);
    for (const match of body.matchAll(/\b(?:FROM|JOIN|INTO)\s+([A-Za-z_][A-Za-z0-9_.]*)/g)) {
      const ref = match[1];
      expect(ref.startsWith('auth.') || ref.startsWith('public.') || ctes.has(ref), `完全修飾されていない参照: ${ref}`).toBe(true);
    }
  });
});

describe('#1125 適用時の試し実行', () => {
  it('関数を作った直後・ジョブを登録する前に、昔の日付で 1 回試し実行して取り消す (作れても動かない状態を、適用時に止める)', () => {
    const create = code.indexOf('CREATE OR REPLACE FUNCTION public.snapshot_daily_active_users(');
    const trial = code.indexOf("PERFORM 1 FROM public.snapshot_daily_active_users(DATE '2000-01-01')");
    const firstSchedule = code.indexOf('cron.schedule(');
    expect(trial, '試し実行が無い').toBeGreaterThan(create);
    expect(trial, '試し実行は、ジョブを登録するより前').toBeLessThan(firstSchedule);
    // 取り消しは専用の SQLSTATE の例外で行い、その SQLSTATE だけを受け止める。ほかのエラーは握りつぶさず、migration を止める
    expect(code).toMatch(/RAISE EXCEPTION USING ERRCODE = 'P0T24'/);
    expect(code).toMatch(/WHEN SQLSTATE 'P0T24' THEN/);
    expect(code).not.toMatch(/WHEN OTHERS/i);
  });
});

describe('#1125 / #1157 権限', () => {
  for (const fn of ['snapshot_daily_active_users(date)', 'cleanup_old_logs()']) {
    it(`${fn}: PUBLIC / anon / authenticated から EXECUTE を外し、service_role に付ける`, () => {
      const escaped = fn.replace(/[()]/g, '\\$&');
      expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${escaped}\\s+FROM PUBLIC, anon, authenticated;`));
      expect(code).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${escaped}\\s+TO service_role;`));
    });
  }

  it('cleanup_old_logs() の定義は書き換えない (権限とコメントだけを変える)', () => {
    expect(code).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.cleanup_old_logs/i);
  });
});

describe('#1157 pg_cron のジョブ', () => {
  it('cleanup-old-app-logs: 毎日 18:15 UTC (03:15 JST) に cleanup_old_logs() を呼ぶ', () => {
    expect(code).toMatch(/cron\.schedule\(\s*'cleanup-old-app-logs',\s*'15 18 \* \* \*',\s*'SELECT public\.cleanup_old_logs\(\);'\s*\)/);
  });

  it('snapshot-daily-active-users: 毎日 16:30 UTC (01:30 JST) に、実行時刻の JST の日付 - 1 を数える', () => {
    expect(code).toMatch(
      /cron\.schedule\(\s*'snapshot-daily-active-users',\s*'30 16 \* \* \*',\s*'SELECT public\.snapshot_daily_active_users\(\(now\(\) AT TIME ZONE ''Asia\/Tokyo''\)::date - 1\);'\s*\)/,
    );
  });

  it('登録する時刻 (UTC) は JST で 03:15 と 01:30 になる', () => {
    const schedules = [...code.matchAll(/cron\.schedule\(\s*'([a-z-]+)',\s*'(\d+) (\d+) \* \* \*'/g)].map((m) => ({
      name: m[1],
      jstHour: (Number(m[3]) + 9) % 24,
      minute: Number(m[2]),
    }));
    expect(schedules).toEqual([
      { name: 'cleanup-old-app-logs', jstHour: 3, minute: 15 },
      { name: 'snapshot-daily-active-users', jstHour: 1, minute: 30 },
    ]);
  });

  it('登録の前に、同じ処理を呼ぶ既存のジョブ (名前は問わない) と同じ名前のジョブを登録解除する', () => {
    const unschedule = code.indexOf('cron.unschedule(');
    const firstSchedule = code.indexOf('cron.schedule(');
    expect(unschedule).toBeGreaterThan(0);
    expect(unschedule, '登録解除が登録より前').toBeLessThan(firstSchedule);
    expect(code).toContain("jobname IN ('cleanup-old-app-logs', 'snapshot-daily-active-users')");
    // 関数名は単語として探す (cleanup_old_logs_v2 のような別の関数を呼ぶジョブは対象にしない)
    expect(code).toContain("command ~* '[[:<:]]cleanup_old_logs[[:>:]]'");
    expect(code).toContain("command ~* '[[:<:]]snapshot_daily_active_users[[:>:]]'");
  });

  it('pg_cron が無い DB (cron.job が無い) では、ジョブの登録を飛ばす。cron の名前を評価する前に確かめる', () => {
    const guard = code.indexOf("to_regclass('cron.job')");
    expect(guard).toBeGreaterThan(0);
    expect(guard, 'ガードは cron.job を読むより前').toBeLessThan(code.indexOf('FROM cron.job'));
    expect(guard, 'ガードは cron.schedule より前').toBeLessThan(code.indexOf('cron.schedule('));
    expect(code).toMatch(/IF to_regclass\('cron\.job'\) IS NULL THEN[\s\S]*?RETURN;/);
  });

  it('実行ログ (RAISE) に command を載せない (既存のジョブの command には秘密が入っていることがある)', () => {
    // RAISE は複数行にまたがることがあるので、RAISE から ; までを 1 文として見る
    const raises = code.match(/\bRAISE\b[^;]*;/gi) ?? [];
    expect(raises.length, 'RAISE の検査が空振りしていないこと').toBeGreaterThan(0);
    for (const statement of raises) {
      expect(statement, 'RAISE に command を渡さない').not.toMatch(/\bcommand\b/i);
    }
  });
});

describe('#1125 第 1 段の範囲: この段で足さないもの・触らないもの', () => {
  it('課金系の定期処理 (収益スナップショット・Stripe・ライセンス) には触れない', () => {
    expect(code).not.toMatch(/revenue_snapshots|stripe|personal_subscriptions|org_license|subscription_plans|license_expire/i);
  });

  it('failed_invite_lookups / infra_metrics には書き込む処理が無いので、この段では掃除のジョブを足さない', () => {
    expect(code).not.toMatch(/failed_invite_lookups|infra_metrics/i);
  });

  it('既存の行を変えない・消さない: UPDATE / DELETE / TRUNCATE の文を書かない (daily_active_users への upsert だけ)', () => {
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
    // 文として始まる UPDATE (ON CONFLICT ... DO UPDATE は除く)
    expect(code).not.toMatch(/(^|;)\s*UPDATE\s/im);
    // 触る表は daily_active_users への INSERT だけ。cleanup の削除は既存の関数 (cleanup_old_logs) が行う
    const inserts = [...code.matchAll(/\bINSERT\s+INTO\s+([A-Za-z_.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(['public.daily_active_users']);
  });
});

describe('#1125 設計書', () => {
  it('docs/design/operator/08-cron-batches.md に 2 つのジョブ・時刻・集計の関数が書かれている', () => {
    const doc = fs.readFileSync(DOC_PATH, 'utf-8');
    const required = [
      'cleanup-old-app-logs',
      'snapshot-daily-active-users',
      'snapshot_daily_active_users',
      'cleanup_old_logs',
      '15 18 * * *',
      '30 16 * * *',
      VERSION,
    ];
    // 失敗時に本文全体を出さないよう、書かれていない語の一覧で比べる
    expect(
      required.filter((text) => !doc.includes(text)),
      '設計書に書かれていない語',
    ).toEqual([]);
  });

  it('付け直す前の version (20261008200000) が設計書・migration・rollback・DB のテストに残っていない', () => {
    const files = [DOC_PATH, MIGRATION_PATH, ROLLBACK_PATH, INTEGRATION_TEST_PATH];
    // 失敗時に本文全体を出さないよう、残っているファイルの一覧で比べる
    const stale = files.filter((file) => fs.readFileSync(file, 'utf-8').includes(STALE_VERSION)).map((file) => path.relative(ROOT, file));
    expect(stale, '古い version が残っているファイル').toEqual([]);
  });
});

/** 設計書のうち、startMarker から endMarker の手前まで (endMarker が null なら最後まで)。どちらも設計書に 1 回だけ出る見出し */
function docBetween(startMarker: string, endMarker: string | null): string {
  const doc = fs.readFileSync(DOC_PATH, 'utf-8');
  const start = doc.indexOf(startMarker);
  expect(start, `設計書に「${startMarker}」が無い`).toBeGreaterThanOrEqual(0);
  if (endMarker === null) return doc.slice(start);
  const end = doc.indexOf(endMarker, start + startMarker.length);
  expect(end, `設計書の「${startMarker}」より後に「${endMarker}」が無い`).toBeGreaterThan(start);
  return doc.slice(start, end);
}

/** 節のうち、状態の注記 (「> 」で始まる引用の行) だけ */
const noteLines = (section: string) =>
  section
    .split('\n')
    .filter((line) => line.startsWith('> '))
    .join('\n');

// 設計書の節。§3.0 は見出しから §3.0.1 の手前まで (表と箇条書きを含む)。§3.1 / §3.2 / §5 は状態の注記だけを見る
const section30 = () => docBetween('### 3.0 実装状況', '#### 3.0.1');
const section31Note = () => noteLines(docBetween('### 3.1 pg_cron ジョブ', '### 3.2 Vercel Cron ジョブ'));
const section32 = () => docBetween('### 3.2 Vercel Cron ジョブ', '## 4. pg_cron ジョブ詳細');
const section5Note = () => noteLines(docBetween('## 5. Vercel Cron ジョブ詳細', '### 5.1 vercel.json 設定'));
const section12 = () => docBetween('## 12. 未解決事項', null);

const VercelJsonSchema = z.object({ crons: z.array(z.object({ path: z.string(), schedule: z.string() })) });

/** vercel.json に登録されている Vercel Cron の名前 (path の最後の部分。例: /api/cron/app-log-alerts → app-log-alerts) */
function vercelCronNames(): string[] {
  const { crons } = VercelJsonSchema.parse(JSON.parse(fs.readFileSync(VERCEL_JSON_PATH, 'utf-8')));
  return crons
    .map((cron) => {
      const segments = cron.path.split('/');
      return segments[segments.length - 1];
    })
    .sort();
}

/**
 * supabase/migrations の SQL が cron.schedule で登録している pg_cron のジョブの名前 (行コメントを除いて探す)。
 * あとの migration がジョブを外したまま登録し直さない (ジョブをやめる) ときは、ここで外した名前を除く処理を足す
 */
function migrationCronJobNames(): string[] {
  const names = new Set<string>();
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql'))) {
    const sql = stripLineComments(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
    for (const match of sql.matchAll(/cron\.schedule\(\s*'([^']+)'/g)) names.add(match[1]);
  }
  return [...names].sort();
}

/** 節ごとに、書かれていない名前を「節: 名前」で返す (失敗時に本文全体を出さないため) */
function missingNames(sections: Record<string, string>, names: string[]): string[] {
  return Object.entries(sections).flatMap(([label, text]) =>
    names.filter((name) => !text.includes(`\`${name}\``)).map((name) => `${label}: ${name}`),
  );
}

describe('#1125 設計書の「いま」の記述が、木の実物と合っている', () => {
  it('Vercel Cron: §3.0・§3.2 の注記・§5 の注記が vercel.json の crons をすべて挙げ、§3.0 と §3.2 の注記の本数が実数と同じ', () => {
    const names = vercelCronNames();
    expect(names.length, 'vercel.json の crons の検査が空振りしていないこと').toBeGreaterThan(0);
    const sections = { '§3.0': section30(), '§3.2 の注記': noteLines(section32()), '§5 の注記': section5Note() };
    expect(missingNames(sections, names), '状態の記述に挙がっていない Vercel Cron').toEqual([]);
    for (const [label, text] of [
      ['§3.0', sections['§3.0']],
      ['§3.2 の注記', sections['§3.2 の注記']],
    ]) {
      const declared = /`vercel\.json` に登録されている Vercel Cron は[^\n]*?の (\d+) 本/.exec(text);
      expect(declared, `${label} に Vercel Cron の本数の記述が無い`).not.toBeNull();
      expect(Number(declared?.[1]), `${label} の Vercel Cron の本数`).toBe(names.length);
    }
  });

  it('§3.2 の注記の「この表のほかの N 本」が、表の行数から実装済みの行を引いた数と同じ', () => {
    const rows = section32()
      .split('\n')
      .filter((line) => line.startsWith('| `'));
    const implemented = rows.filter((line) => line.includes('実装済み'));
    expect(rows.length, '§3.2 の表の検査が空振りしていないこと').toBeGreaterThan(implemented.length);
    const declared = /この表のほかの (\d+) 本/.exec(noteLines(section32()));
    expect(declared, '§3.2 の注記に「この表のほかの N 本」が無い').not.toBeNull();
    expect(Number(declared?.[1]), '§3.2 の表のうち実装されていない行の数').toBe(rows.length - implemented.length);
  });

  it('pg_cron: §3.0 と §3.1 の注記が migration の登録しているジョブをすべて挙げ、数が実数と同じ', () => {
    const names = migrationCronJobNames();
    expect(names, 'migration の cron.schedule の検査が空振りしていないこと').toEqual(
      expect.arrayContaining(['cleanup-old-app-logs', 'snapshot-daily-active-users']),
    );
    const sections = { '§3.0': section30(), '§3.1 の注記': section31Note() };
    expect(missingNames(sections, names), '状態の記述に挙がっていない pg_cron のジョブ').toEqual([]);
    const declared30 = /migration が pg_cron に登録しているジョブは (\d+) つ/.exec(sections['§3.0']);
    expect(declared30, '§3.0 に pg_cron のジョブの数の記述が無い').not.toBeNull();
    expect(Number(declared30?.[1]), '§3.0 の pg_cron のジョブの数').toBe(names.length);
    const declared31 = /migration が pg_cron に登録しているのは[^\n]*?の (\d+) つ/.exec(sections['§3.1 の注記']);
    expect(declared31, '§3.1 の注記に pg_cron のジョブの数の記述が無い').not.toBeNull();
    expect(Number(declared31?.[1]), '§3.1 の注記の pg_cron のジョブの数').toBe(names.length);
  });

  it('#1125 の課金系の扱いは、migration と同じ「この段では足さない」の言い回しで書き、恒久の判断 (「作らない」) として書かない', () => {
    // 仕様の言い回し。migration の範囲の記述 (冒頭のコメント) と、設計書の各節で同じものを使う
    const deferral = 'オーナーの選択「課金は無料のまま計測」により';
    expect(migration.includes(deferral), 'migration の範囲の記述に、仕様の言い回しが無い').toBe(true);
    const doc = fs.readFileSync(DOC_PATH, 'utf-8');
    const permanent = doc
      .split('\n')
      .map((line, index) => ({ line, lineNumber: index + 1 }))
      .filter(({ line }) => line.includes('#1125') && /作らない|決めた|新しい判断|オーナー判断/.test(line))
      .map(({ lineNumber }) => `${lineNumber} 行目`);
    expect(permanent, '#1125 の課金系の扱いを、恒久の判断として書いている行').toEqual([]);
    const sections = {
      '§3.0': section30(),
      '§3.1 の注記': section31Note(),
      '§3.2 の注記': noteLines(section32()),
      '§5 の注記': section5Note(),
      '§12': section12(),
    };
    const lacking = Object.entries(sections)
      .filter(([, text]) => !(text.includes(deferral) && text.includes('#1125 の残り')))
      .map(([label]) => label);
    expect(lacking, '課金系の扱いを、仕様の言い回し + 「#1125 の残り」で書いていない節').toEqual([]);
  });
});
