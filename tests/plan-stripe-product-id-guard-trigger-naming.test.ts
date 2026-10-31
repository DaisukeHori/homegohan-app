// @vitest-environment node
/**
 * トリガーの呼び名の番兵 (ソース走査。#2128 docs-1031c の R2 指摘 1 で 1 組から始め、#2134 U3 で migration の全部の組に広げた)
 *
 * migration の `CREATE TRIGGER <トリガー> … EXECUTE FUNCTION <関数>(…)` は、トリガーと、トリガーが呼ぶ関数に別の名前を付けることが多い
 * (例: トリガー trg_guard_plan_deprecate_subscribers が関数 guard_plan_deprecate_subscribers を呼ぶ)。
 * コメント・文書で関数の名前を「トリガー」と呼ぶと、DB でトリガーを探す人 (pg_trigger の tgname) が見つけられない。
 * 書き方は「トリガー trg_guard_plan_deprecate_subscribers (関数 guard_plan_deprecate_subscribers)」にそろえる。
 * 「トリガー」と関数の名前が別の行に分かれたコメント (「…DB のトリガー」の次の行が「 * guard_…」) は 1 行ずつの grep では見えないので、
 * 行の頭のコメントの印を外して行をまたいで探す。ここでは、
 *  1. supabase/migrations の全部の CREATE TRIGGER 文から (トリガー, 関数) の組を読む (読めない CREATE TRIGGER 文が無い)
 *  2. 探す名前 = 組の関数の名前のうち、どのトリガーの名前でもないもの (トリガーと同じ名前の関数は「トリガー <名前>」と書いても正しい)
 *  3. src・tests・docs・apps・scripts・supabase (migrations・rollbacks・functions)・CLAUDE.md の全文で、
 *     「トリガー」のすぐ後 (空白・改行・コメントの行の頭の * や //・--・#・> と、` や ( だけを挟む) に 2. の名前が来る所と、
 *     「トリガー」の後の ( の中 (「トリガー 2 種 (…)」「…のトリガー・…の RPC は … (…)」の形も) で 2. の名前を関数と呼ばずに書く所が無い。
 *     例外は FROZEN_MIGRATION_HITS (編集しない既存の migration。CLAUDE.md「既存の migration ファイルは編集せず」) の数まで。
 *     設計書 (docs/design) も 0 件
 *  3a. 本番の DB に残るコメント (migration を番号順に当てたとき、対象ごとに最後に効く COMMENT ON の文) にも 3. の書き方が無い。
 *     例外の表の migration の COMMENT ON の文の中の数 (ファイルは編集しないので数は残る) は、後の migration が出し直している
 *     (#2144 S4。20261031120000・20261031130000 が出し直した)
 *  4. 3. の見つけ方が、行をまたぐ書き方・` で囲む書き方・( で始める書き方・見出しと ( の中の並びを組にする書き方を見つけ、直した書き方 (トリガーの名前を書き、
 *     関数の名前は「関数 …」と書く) には反応しないことを、写しの文で確かめる
 * を確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { effectiveComments } from './helpers/sql-comment-statements';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.posix.join('supabase', 'migrations');
const STRIPE_GUARD_MIGRATION = path.posix.join(MIGRATIONS_DIR, '20261030160000_plan_stripe_product_id_price_change_guard.sql');
const FN = 'guard_plan_stripe_product_id_price_change';
const TRIGGER = 'trg_guard_plan_stripe_product_id_price_change';
/** #2134 U3 の報告の組 (supabase/migrations/20261024130000_plan_deprecate_lock_and_price_change_reservation.sql の CREATE TRIGGER) */
const DEPRECATE_FN = 'guard_plan_deprecate_subscribers';
const DEPRECATE_TRIGGER = 'trg_guard_plan_deprecate_subscribers';
/**
 * 写しの文に使う関数の名前 (このファイル自身も走査するので、写しの文は名前を直に書かず `${…}` で組み立てる)。
 * 1 つの関数を 2 本のトリガー (trg_meals_guard_hidden_columns・trg_recipes_guard_hidden_columns) が呼ぶ関数
 */
const HIDDEN_FN = 'guard_hidden_content_columns';
/** auth.sessions のトリガー on_auth_session_created / _refreshed / _deleted が呼ぶ関数 */
const [SESSION_CREATED_FN, SESSION_REFRESHED_FN, SESSION_DELETED_FN] = [
  'auth_session_created',
  'auth_session_refreshed',
  'auth_session_deleted',
] as const;
/** トリガー trg_org_challenge_count_join / trg_org_challenge_finalize が呼ぶ関数 */
const [COUNT_JOIN_FN, FINALIZE_FN] = ['org_challenge_count_join', 'org_challenge_finalize'] as const;
/** トリガー trg_family_members_revoke_parental_consent_on_delete が呼ぶ関数 */
const CONSENT_ON_DELETE_FN = 'revoke_parental_consent_on_member_delete';
/** auth.users のトリガー on_auth_user_password_changed が呼ぶ関数 */
const PASSWORD_HISTORY_FN = 'password_history_record';

/**
 * 本番のコメントに残っていた書き方を出し直した migration (#2144 S4)。これより前の migration だけを当てたときのコメントには
 * 3. の書き方が残っていたことを確かめて、3a. の見つけ方が空振りしないことを見る
 */
const COMMENTS_REISSUE_MIGRATION = '20261031130000_object_comments_trigger_names.sql';
/**
 * COMMENTS_REISSUE_MIGRATION の前の migration だけを当てたとき、本番に最後に効いていたコメントのうち 3. の書き方のもの
 * ([出した migration, 対象, 関数の名前])。列 user_profiles.last_login_at の分は 20261031120000 (#2141) が先に出し直した
 */
const COMMENT_HITS_BEFORE_REISSUE: readonly (readonly [file: string, key: string, fn: string])[] = [
  ['20261016190000_deletion_record_and_invite_email_hash.sql', 'FUNCTION public.membership_audit_hash_email_in_metadata(jsonb)', 'membership_audit_hash_invite_email'],
  ['20261016243000_auth_history_sessions.sql', 'COLUMN public.user_sessions_metadata.alert_status', SESSION_CREATED_FN],
  ['20261023130000_account_deletion_owner_guard.sql', 'TABLE public.account_deletion_guards', 'organizations_owner_not_deleting'],
  ['20261024130000_plan_deprecate_lock_and_price_change_reservation.sql', 'FUNCTION public.family_group_hold_plan_key_share()', DEPRECATE_FN],
  ['20261024130000_plan_deprecate_lock_and_price_change_reservation.sql', 'FUNCTION public.organization_hold_plan_key_share()', DEPRECATE_FN],
  ['20261024130000_plan_deprecate_lock_and_price_change_reservation.sql', 'FUNCTION public.personal_subscription_hold_plan_key_share()', DEPRECATE_FN],
];

/** 走査する場所 (リポジトリの根からの相対パス。ファイルでもディレクトリでもよい) */
const SCAN_ROOTS = ['src', 'tests', 'docs', 'apps', 'scripts', 'supabase', 'CLAUDE.md'];
/** 中に入らないディレクトリの名前 (依存・生成物) */
const SKIPPED_DIR_NAMES = new Set(['node_modules', '.next', '.expo', 'dist', 'build', 'coverage', 'Pods', '.turbo', '.git']);
/** 読むファイルの拡張子 (文字のファイル) */
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.md', '.mdx', '.sql', '.sh', '.yml', '.yaml']);

/**
 * 編集しない既存の migration に残る「トリガー <関数の名前>」の数 ([ファイル, 関数の名前, 数])。
 * 本番で適用済みの migration は書き換えない (CLAUDE.md「既存の migration ファイルは編集せず、変更は必ず新しい migration として追加する」)。
 * 新しい migration と、ここに無い組は 0 件を求める。
 * 数には COMMENT ON の文 (本番の DB のコメント) の中のものも入る。ファイルは編集しないので数は減らないが、本番に最後に効くコメントは
 * 後の migration が出し直している (下の「本番に最後に効くコメント」の it が確かめる。#2144 S4):
 *   - 20261016243000 の auth_session_created の 2 = 列 user_sessions_metadata.alert_status の COMMENT (20261031130000 が出し直した) と
 *     列 user_profiles.last_login_at の COMMENT (20261031120000 が出し直した)。user_profiles_fill_login_stats の 1 も last_login_at の COMMENT
 *   - 20261016190000 の 1・20261023130000 の 3 のうち 1・20261024130000 の 4 のうち 3 = COMMENT ON の文 (20261031130000 が出し直した)
 *   - ほか (-- のコメントと、関数の本文の中の -- のコメント) は本番のコメントではない
 */
const FROZEN_MIGRATION_HITS: readonly (readonly [file: string, fn: string, count: number])[] = [
  ['supabase/migrations/20261008090000_family_members_status_guard.sql', 'guard_family_members_privileged', 1],
  ['supabase/migrations/20261016190000_deletion_record_and_invite_email_hash.sql', 'membership_audit_hash_invite_email', 1],
  ['supabase/migrations/20261016240000_org_challenge_diff_privacy.sql', 'org_challenge_count_join', 1],
  ['supabase/migrations/20261016240000_org_challenge_diff_privacy.sql', 'org_challenge_finalize', 1],
  ['supabase/migrations/20261016240000_org_challenge_diff_privacy.sql', 'org_challenge_guard_update', 1],
  ['supabase/migrations/20261016240000_org_challenge_diff_privacy.sql', 'org_challenge_mark_admin', 1],
  ['supabase/migrations/20261016243000_auth_history_sessions.sql', 'auth_session_created', 2],
  ['supabase/migrations/20261016243000_auth_history_sessions.sql', 'user_profiles_fill_login_stats', 1],
  ['supabase/migrations/20261017230000_billing_manual_plan_grant.sql', 'billing_family_plan_follow_representative', 1],
  ['supabase/migrations/20261019120000_self_dissolve.sql', 'billing_family_plan_follow_representative', 1],
  ['supabase/migrations/20261022180000_org_tables_rpc_only_writes.sql', 'audit_organization_invite_created', 1],
  ['supabase/migrations/20261023130000_account_deletion_owner_guard.sql', 'organizations_owner_not_deleting', 3],
  ['supabase/migrations/20261024130000_plan_deprecate_lock_and_price_change_reservation.sql', DEPRECATE_FN, 4],
];

/** root (相対パス) の下の文字のファイル (相対パス。並べて返す) */
function textFilesUnder(root: string): string[] {
  const full = path.join(ROOT, root);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return [root];
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIR_NAMES.has(entry.name)) walk(child);
      } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
        out.push(child);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** 正規表現の特別な文字を逃がす */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** SQL の -- から行末までのコメントを外す (コメントの中の CREATE TRIGGER を数えない) */
const stripSqlLineComments = (sql: string): string => sql.replace(/--.*$/gm, '');

type TriggerPair = { trigger: string; fn: string };

/** SQL の CREATE TRIGGER 文の数 (OR REPLACE・CONSTRAINT を含む) */
function countCreateTriggerStatements(sql: string): number {
  return [...stripSqlLineComments(sql).matchAll(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/gi)].length;
}

/** SQL の CREATE TRIGGER 文ごとの (トリガー, 関数) の組 (名前の " とスキーマの接頭辞は外す) */
function triggerPairsIn(sql: string): TriggerPair[] {
  const pattern =
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+"?(\w+)"?[\s\S]*?\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:"?\w+"?\.)?"?(\w+)"?\s*\(/gi;
  return [...stripSqlLineComments(sql).matchAll(pattern)].map(([, trigger, fn]) => ({ trigger, fn }));
}

/** supabase/migrations の全部の .sql (相対パス) */
const migrationFiles = (): string[] => textFilesUnder(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql'));

/** 探す名前: 組の関数の名前のうち、どのトリガーの名前でもないもの (並べて返す) */
function functionNamesToFind(pairs: readonly TriggerPair[]): string[] {
  const triggerNames = new Set(pairs.map((pair) => pair.trigger));
  return [...new Set(pairs.map((pair) => pair.fn))].filter((fn) => !triggerNames.has(fn)).sort();
}

type Hit = { line: number; fn: string };

/** 並びの 1 つの名前 (` で囲んでも、() を付けてもよい) */
const LISTED_NAME = '`?\\w+(?:\\(\\))?`?';

/**
 * 「トリガー」の後の ( の中で、関数を関数と呼んでいる所 (「(関数 …)」の括弧と、「関数 a・b」の並び)。
 * ここは関数の名前があってよいので、見る前に同じ長さの空白に置き換える (位置は変えない)
 */
const FUNCTION_LABELED_SPANS = [/\(関数[^()]*\)/g, new RegExp(`関数(?:\\s*${LISTED_NAME}(?:\\s*[・/、,と]\\s*${LISTED_NAME})*)?`, 'g')];

/** 空白に置き換える (改行は残す。行の数を変えない) */
const blankOut = (span: string): string => span.replace(/[^\n]/g, ' ');

/**
 * text の open の位置の ( の中身 (位置は open + 1 から)。対になる ) か、文の終わり (「。」・表の区切り | ・空の行) の手前まで。
 * 中の ( … ) は入れ子として飛ばす
 */
function parenthesizedBody(text: string, open: number): string {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    const char = text[at];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, at);
    } else if (char === '。' || char === '|' || (char === '\n' && text[at + 1] === '\n')) {
      return text.slice(open + 1, at);
    }
  }
  return text.slice(open + 1);
}

/**
 * 「トリガー」が関数の名前を指している所 (行は 1 始まり。「トリガー」の行)。次の 2 つの形を探す。
 *  - 「トリガー」のすぐ後に fns のどれかが来る。間に挟んでよいのは空白・改行・` ・ ( だけ
 *    (trg_… は挟めないので、トリガーの名前の中の関数の名前には反応しない)
 *  - 「トリガー」の後の ( の中に fns のどれかがある。( の前に挟んでよいのは「N 本」「N 種」と、
 *    「・」「、」で続く見出し (「記録のトリガー・照合の RPC は … (`a`・`b`)」のように、見出しと並びを順に組にする書き方。
 *    見出しに「関数」が入るものは除く)。( の中は、対になる ) か「。」などの文の終わりまで見る
 *    (「トリガー 4 本 (`a` / `b`)」「トリガー 2 種 (… の a と …)」)。( の中で関数を関数と呼ぶ所
 *    (「(関数 …)」「関数 a・b」) は見ないので、「トリガー (trg_…。関数 …)」「トリガー 2 種 (… の trg_… (関数 a) と …)」には反応しない
 * 行の頭のコメントの印 (* ・ // ・ -- ・ # ・ >) は外してから見る (行の数は変えない) ので、行をまたいでも見つける。
 * 名前の後に英数字・_ が続くものは数えない (長い名前から先に試す)。同じ名前の同じ所は 1 回だけ数える。
 */
function triggerCalledByFunctionName(text: string, fns: readonly string[]): Hit[] {
  if (fns.length === 0) return [];
  const fnSet = new Set(fns);
  const normalized = text.replace(/\n[ \t]*(?:\*(?!\/)|\/\/+|--+|#+|>)?/g, '\n');
  const alternatives = [...fns]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  const direct = new RegExp(`トリガー[\\s\`(]*(${alternatives})(?![A-Za-z0-9_])`, 'g');
  const parenthesized = /トリガー(?:\s*\d+\s*[本種]|[・、](?:(?!関数)[^。()|\n])*?)?\s*\(/g;
  /** 関数の名前の位置 → (「トリガー」の位置, 名前) */
  const found = new Map<number, { triggerAt: number; fn: string }>();
  for (const match of normalized.matchAll(direct)) {
    const nameAt = match.index + match[0].length - match[1].length;
    found.set(nameAt, { triggerAt: match.index, fn: match[1] });
  }
  for (const match of normalized.matchAll(parenthesized)) {
    const open = match.index + match[0].length - 1;
    const body = FUNCTION_LABELED_SPANS.reduce((rest, span) => rest.replace(span, blankOut), parenthesizedBody(normalized, open));
    for (const name of body.matchAll(/\w+/g)) {
      if (fnSet.has(name[0])) found.set(open + 1 + name.index, { triggerAt: match.index, fn: name[0] });
    }
  }
  return [...found]
    .sort(([a], [b]) => a - b)
    .map(([, { triggerAt, fn }]) => ({ line: normalized.slice(0, triggerAt).split('\n').length, fn }));
}

/** 見つけた所を [ファイル, 関数の名前] ごとに数える */
function countByFileAndFn(hits: readonly { file: string; fn: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { file, fn } of hits) {
    const key = `${file} ${fn}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** 例外の表 ([ファイル, 関数の名前, 数]) を [ファイル, 関数の名前] ごとの数の Map にする */
const allowanceOf = (table: readonly (readonly [string, string, number])[]): Map<string, number> =>
  new Map(table.map(([file, fn, count]) => [`${file} ${fn}`, count]));

/** counts のうち、allowance の数を超えるもの (「ファイル 関数 (見つけた数 > 許す数)」) */
function overAllowance(counts: Map<string, number>, allowance: Map<string, number>): string[] {
  return [...counts]
    .filter(([key, count]) => count > (allowance.get(key) ?? 0))
    .map(([key, count]) => `${key} (${count} > ${allowance.get(key) ?? 0})`);
}

describe('トリガーの呼び名 (#2128 docs-1031c の R2 指摘 1・#2134 U3)', () => {
  const allPairs = migrationFiles().flatMap((file) => triggerPairsIn(fs.readFileSync(path.join(ROOT, file), 'utf-8')));
  const fnsToFind = functionNamesToFind(allPairs);

  it('migration の CREATE TRIGGER 文を全部 (トリガー, 関数) の組として読める', () => {
    const unread = migrationFiles().flatMap((file) => {
      const sql = fs.readFileSync(path.join(ROOT, file), 'utf-8');
      const statements = countCreateTriggerStatements(sql);
      const pairs = triggerPairsIn(sql).length;
      return statements === pairs ? [] : [`${file} (CREATE TRIGGER ${statements} 本・読めた組 ${pairs})`];
    });
    expect(unread).toEqual([]);

    // Stripe の商品の ID を守るトリガーの migration は 1 組だけで、トリガーと関数は別の名前
    expect(triggerPairsIn(fs.readFileSync(path.join(ROOT, STRIPE_GUARD_MIGRATION), 'utf-8'))).toEqual([
      { trigger: TRIGGER, fn: FN },
    ]);
    expect(allPairs).toEqual(
      expect.arrayContaining([
        { trigger: TRIGGER, fn: FN },
        { trigger: DEPRECATE_TRIGGER, fn: DEPRECATE_FN },
        // 1 つの関数を 2 本のトリガーが呼ぶ組も読む
        { trigger: 'trg_meals_guard_hidden_columns', fn: HIDDEN_FN },
        { trigger: 'trg_recipes_guard_hidden_columns', fn: HIDDEN_FN },
      ]),
    );
  });

  it('探す名前は、トリガーの名前ではない関数の名前だけ (トリガーと同じ名前の関数は除く)', () => {
    const triggerNames = new Set(allPairs.map((pair) => pair.trigger));
    expect(fnsToFind).toEqual(expect.arrayContaining([FN, DEPRECATE_FN, HIDDEN_FN]));
    expect(fnsToFind.filter((fn) => triggerNames.has(fn))).toEqual([]);
    // トリガーと関数が同じ名前の組 (例: update_embedding_jobs_updated_at) の名前は探さない
    const sameNamed = allPairs.filter((pair) => pair.trigger === pair.fn).map((pair) => pair.fn);
    expect(sameNamed).toEqual(expect.arrayContaining(['update_embedding_jobs_updated_at']));
    expect(fnsToFind.filter((fn) => sameNamed.includes(fn))).toEqual([]);
  });

  it('src・tests・docs・apps・scripts・supabase・CLAUDE.md で、関数の名前を「トリガー」と呼ぶ所が無い (例外の表の数まで)', () => {
    const files = SCAN_ROOTS.flatMap(textFilesUnder);
    expect(files, 'src・tests・docs/design・supabase・CLAUDE.md のファイルを走査している').toEqual(
      expect.arrayContaining([
        'src/app/api/super-admin/plans/[id]/route.ts',
        'src/lib/super-admin/plan-price-change-reservation.ts',
        'src/lib/super-admin/plans-schemas.ts',
        'src/lib/super-admin/plan-subscribers.ts',
        'src/lib/api/list-order.ts',
        'tests/integration/security/plan-deprecate-lock-price-change-reservation.test.ts',
        'docs/design/operator/02-api-spec.md',
        STRIPE_GUARD_MIGRATION,
        'CLAUDE.md',
      ]),
    );
    const hits = files.flatMap((file) =>
      triggerCalledByFunctionName(fs.readFileSync(path.join(ROOT, file), 'utf-8'), fnsToFind).map(({ line, fn }) => ({
        file,
        line,
        fn,
      })),
    );
    const isFrozenMigration = (file: string) => file.startsWith(`${MIGRATIONS_DIR}/`);

    // 例外の外 (src・tests・docs (docs/design を含む)・CLAUDE.md・apps・scripts・migrations 以外の supabase) は 0 件
    expect(
      hits.filter(({ file }) => !isFrozenMigration(file)).map(({ file, line, fn }) => `${file}:${line} ${fn}`),
    ).toEqual([]);
    // 既存の migration は、例外の表の数まで (新しい migration・表に無い組は 0 件)
    expect(
      overAllowance(countByFileAndFn(hits.filter(({ file }) => isFrozenMigration(file))), allowanceOf(FROZEN_MIGRATION_HITS)),
    ).toEqual([]);
  });

  it('本番に最後に効くコメント (migration を番号順に当てた COMMENT ON の文) にも、関数の名前を「トリガー」と呼ぶ所が無い', () => {
    const migrations = migrationFiles().map((file) => ({ file, sql: fs.readFileSync(path.join(ROOT, file), 'utf-8') }));
    const hitsOf = (files: readonly { file: string; sql: string }[]): string[] =>
      [...effectiveComments(files)].flatMap(([key, { file, text }]) =>
        triggerCalledByFunctionName(text ?? '', fnsToFind).map(({ fn }) => `${path.posix.basename(file)} ${key} ${fn}`),
      );
    expect(migrations.map(({ file }) => path.posix.basename(file))).toContain(COMMENTS_REISSUE_MIGRATION);
    expect(hitsOf(migrations)).toEqual([]);

    // 見つけ方が空振りしない: 出し直す前の migration だけを当てたコメントには、出し直した 6 つが残っていた
    const before = migrations.filter(({ file }) => path.posix.basename(file) < COMMENTS_REISSUE_MIGRATION);
    expect(hitsOf(before).sort()).toEqual(COMMENT_HITS_BEFORE_REISSUE.map(([file, key, fn]) => `${file} ${key} ${fn}`).sort());
  });

  it('例外の表は migration から読んだ探す名前だけを書き、migrations の下にあるファイルだけ', () => {
    const tables = FROZEN_MIGRATION_HITS;
    expect(tables.filter(([, fn]) => !fnsToFind.includes(fn)).map(([file, fn]) => `${file} ${fn}`)).toEqual([]);
    expect(FROZEN_MIGRATION_HITS.filter(([file]) => !file.startsWith(`${MIGRATIONS_DIR}/`))).toEqual([]);
    expect(tables.filter(([file]) => !fs.existsSync(path.join(ROOT, file))).map(([file]) => file)).toEqual([]);
  });

  it('見つけ方が空振りしない: 行をまたぐ・` で囲む・( で始める・見出しと並びを組にする書き方を見つけ、直した書き方には反応しない', () => {
    // 直す前の route.ts の書き方 (「DB のトリガー」の次の行に関数の名前)
    const splitComment = ` * そのあいだは DB のトリガー\n * ${FN} (supabase/migrations/…) が、`;
    expect(triggerCalledByFunctionName(splitComment, fnsToFind)).toEqual([{ line: 1, fn: FN }]);
    // 直す前の plans/[id]/route.ts の廃止の安全弁の書き方 (#2134 U3。行をまたぐ形と 1 行の形)
    const deprecateSplit = ` * 書く文の中で DB のトリガー\n * ${DEPRECATE_FN} がプランの行を FOR UPDATE でロックし直し`;
    expect(triggerCalledByFunctionName(deprecateSplit, fnsToFind)).toEqual([{ line: 1, fn: DEPRECATE_FN }]);
    expect(triggerCalledByFunctionName(`(DB のトリガー ${DEPRECATE_FN} が、書く文の中で`, fnsToFind)).toEqual([
      { line: 1, fn: DEPRECATE_FN },
    ]);
    // 直す前の plan-price-change-reservation.ts の書き方 (次の行が ( で始まる)
    const parenthesized = `/**\n * …止めるトリガー\n * (${FN}。#2112 Z1-1) が RAISE する文`;
    expect(triggerCalledByFunctionName(parenthesized, fnsToFind)).toEqual([{ line: 2, fn: FN }]);
    // 直す前の operator/02 §17 の書き方 (` で囲む)
    expect(triggerCalledByFunctionName(`\`subscription_plans\` のトリガー \`${FN}\` (\`…\`)`, fnsToFind)).toEqual([
      { line: 1, fn: FN },
    ]);
    // SQL と // のコメントの行の継ぎ
    expect(triggerCalledByFunctionName(`-- 止めるトリガー\n--   ${FN}`, fnsToFind)).toEqual([{ line: 1, fn: FN }]);
    expect(triggerCalledByFunctionName(`// 止めるトリガー\n// ${FN}`, fnsToFind)).toEqual([{ line: 1, fn: FN }]);
    // ( の中の並びで関数の名前を「トリガー」と呼ぶ書き方 (直す前の operator/01 §3 と org/10 の消費経路の書き方)
    expect(
      triggerCalledByFunctionName(
        `書くのは \`auth.sessions\` のトリガー (\`${SESSION_CREATED_FN}\`・\`${SESSION_REFRESHED_FN}\`・\`${SESSION_DELETED_FN}\`)・RPC`,
        fnsToFind,
      ),
    ).toEqual([
      { line: 1, fn: SESSION_CREATED_FN },
      { line: 1, fn: SESSION_REFRESHED_FN },
      { line: 1, fn: SESSION_DELETED_FN },
    ]);
    expect(
      triggerCalledByFunctionName(`書く側 = トリガー 2 本 (\`${COUNT_JOIN_FN}\` / \`${FINALIZE_FN}\`)・埋め戻し`, fnsToFind),
    ).toEqual([
      { line: 1, fn: COUNT_JOIN_FN },
      { line: 1, fn: FINALIZE_FN },
    ]);
    // 直す前の cross/14 の書き方 (並びの頭が関数の名前で、次がトリガーの名前)
    expect(
      triggerCalledByFunctionName(
        `のトリガー (\`${CONSENT_ON_DELETE_FN}()\`・\`trg_family_members_revoke_parental_consent_on_delete\`) が`,
        fnsToFind,
      ),
    ).toEqual([{ line: 1, fn: CONSENT_ON_DELETE_FN }]);
    // 直す前の cross/01 §13.1 の書き方 (「トリガー・RPC」の見出しと ( の中の並びを順に組にする)
    expect(
      triggerCalledByFunctionName(
        `→ 記録のトリガー・照合の RPC は cross/16 §11 が正典 (\`${PASSWORD_HISTORY_FN}\`・\`auth_password_check\`)。`,
        fnsToFind,
      ),
    ).toEqual([{ line: 1, fn: PASSWORD_HISTORY_FN }]);
    // 直す前の plan-subscribers.ts の書き方 (「トリガー 2 種 (」の中で、パスの後に関数の名前。行をまたぐ)
    expect(
      triggerCalledByFunctionName(
        ` * トリガー 2 種 (supabase/migrations/…_reservation.sql の ${DEPRECATE_FN} と\n * trg_subscriber_plan_key_share の WHEN・関数)`,
        fnsToFind,
      ),
    ).toEqual([{ line: 1, fn: DEPRECATE_FN }]);
    // 1 つの関数を 2 本のトリガーが呼ぶ関数の名前も見つける
    expect(triggerCalledByFunctionName(`(DB のトリガー ${HIDDEN_FN})`, fnsToFind)).toEqual([{ line: 1, fn: HIDDEN_FN }]);
    // 直す前の list-order.ts の書き方 (#2135 U2。この枝を切ったあとに main に入った)
    expect(
      triggerCalledByFunctionName(`   * last_login_at はログインのたびにトリガー ${SESSION_CREATED_FN} が書く\n   * (supabase/…)`, fnsToFind),
    ).toEqual([{ line: 1, fn: SESSION_CREATED_FN }]);

    // 直した書き方 (トリガーの名前を書き、関数の名前は「関数 …」と書く) には反応しない
    expect(
      triggerCalledByFunctionName(` * DB のトリガー ${TRIGGER}\n * (関数 ${FN}。supabase/migrations/…) が、`, fnsToFind),
    ).toEqual([]);
    expect(triggerCalledByFunctionName(`のトリガー \`${TRIGGER}\` (関数 \`${FN}\`) (\`…\`)`, fnsToFind)).toEqual([]);
    expect(
      triggerCalledByFunctionName(`DB のトリガー ${DEPRECATE_TRIGGER} (関数 ${DEPRECATE_FN}) がプランの行を`, fnsToFind),
    ).toEqual([]);
    expect(
      triggerCalledByFunctionName(
        `   * last_login_at はログインのたびにトリガー on_auth_session_created (関数 ${SESSION_CREATED_FN}) が書く`,
        fnsToFind,
      ),
    ).toEqual([]);
    expect(
      triggerCalledByFunctionName(
        '(DB のトリガー trg_meals_guard_hidden_columns・trg_recipes_guard_hidden_columns (関数 guard_hidden_content_columns))',
        fnsToFind,
      ),
    ).toEqual([]);
    expect(
      triggerCalledByFunctionName('トリガー (weekly_menu_requests_enqueue_push。関数 enqueue_weekly_menu_result_push)', fnsToFind),
    ).toEqual([]);
    expect(
      triggerCalledByFunctionName(
        'のトリガー (`on_auth_session_created`・`on_auth_session_refreshed`。関数 `auth_session_created`・`auth_session_refreshed`)・RPC',
        fnsToFind,
      ),
    ).toEqual([]);
    expect(
      triggerCalledByFunctionName(
        'トリガー 2 本 (`trg_org_challenge_count_join` / `trg_org_challenge_finalize`。関数 `org_challenge_count_join` / `org_challenge_finalize`)',
        fnsToFind,
      ),
    ).toEqual([]);
    expect(
      triggerCalledByFunctionName(
        `→ 記録のトリガー (\`on_auth_user_password_changed\`。関数 \`${PASSWORD_HISTORY_FN}\`)・照合の RPC (\`auth_password_check\`) は cross/16 §11 が正典。`,
        fnsToFind,
      ),
    ).toEqual([]);
    expect(
      triggerCalledByFunctionName(
        ` * トリガー 2 種 (supabase/migrations/…_reservation.sql の ${DEPRECATE_TRIGGER} (関数 ${DEPRECATE_FN}) と\n * trg_subscriber_plan_key_share の WHEN・関数)`,
        fnsToFind,
      ),
    ).toEqual([]);
    // 関数を関数と呼ぶ書き方 (「トリガー関数 (…)」「トリガー・関数の名前 (…)」も)・トリガーと離れた所の関数の名前には反応しない
    expect(triggerCalledByFunctionName(`トリガー・関数の名前 (\`${TRIGGER}\`・\`${FN}\`)`, fnsToFind)).toEqual([]);
    expect(triggerCalledByFunctionName('トリガー関数 2 本 (`org_challenge_count_join` / `org_challenge_finalize`)', fnsToFind)).toEqual([]);
    expect(triggerCalledByFunctionName(`トリガーの関数 ${FN} が RAISE する`, fnsToFind)).toEqual([]);
    expect(triggerCalledByFunctionName(`-- 行トリガー ${TRIGGER}\n--   (関数 ${FN})`, fnsToFind)).toEqual([]);
    // トリガーと同じ名前の関数は「トリガー <名前>」と書いても数えない (探す名前に入らない)
    expect(triggerCalledByFunctionName('トリガー update_embedding_jobs_updated_at', fnsToFind)).toEqual([]);
  });

  it('例外の表の数え方が空振りしない: 表の数を超えたもの・表に無い組を返し、表の数までは返さない', () => {
    const allowance = allowanceOf([['docs/design/x.md', DEPRECATE_FN, 1]]);
    const one = [{ file: 'docs/design/x.md', fn: DEPRECATE_FN }];
    expect(overAllowance(countByFileAndFn(one), allowance)).toEqual([]);
    expect(overAllowance(countByFileAndFn([...one, ...one]), allowance)).toEqual([
      `docs/design/x.md ${DEPRECATE_FN} (2 > 1)`,
    ]);
    expect(overAllowance(countByFileAndFn([{ file: 'docs/design/y.md', fn: DEPRECATE_FN }]), allowance)).toEqual([
      `docs/design/y.md ${DEPRECATE_FN} (1 > 0)`,
    ]);
  });
});
