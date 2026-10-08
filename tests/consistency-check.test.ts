// @vitest-environment node
/**
 * tests/consistency-check.test.ts
 *
 * 毎日の整合性チェック (.github/workflows/daily-consistency-check.yml) の契約テスト。
 * claude/ ブランチの即マージをやめた (#1360) 代わりに、次の 2 つを毎日検査して Issue で知らせる。
 *   1. 本番 DB とリポジトリの migration のずれ (#1064 で 2 か月デプロイが止まった種類の事故)
 *   2. 置き去りのブランチ・PR (push しただけ・緑や赤のまま止まっている)
 *
 *   - 判定 (scripts/lib/consistency-check.mjs): migration list の読み取り・ずれの分類・PR とブランチの分類・Issue の文面
 *   - CLI (scripts/consistency-check.mjs): gh を差し替え、Issue の作成・更新・クローズと終了コードを確かめる
 *   - ワークフローの定義: 起動条件・権限・本番に書き込むコマンドを使っていないこと
 *
 * gh と時刻は差し替える。実際の GitHub・本番 DB には接続しない。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import {
  DB_ISSUE_MARKER,
  DB_ISSUE_TITLE,
  MAX_LISTED,
  STALE_ISSUE_MARKER,
  STALE_ISSUE_TITLE,
  buildDbProblems,
  classifyMigrationDrift,
  classifyOpenPullRequests,
  filterStaleBranches,
  findBranchCandidates,
  hasStaleFindings,
  parseMigrationList,
  planIssueAction,
  renderDbIssueBody,
  renderStaleIssueBody,
} from '../scripts/lib/consistency-check.mjs';
import { PER_PAGE, createGitHub, main, parseArgs } from '../scripts/consistency-check.mjs';

const NOW = new Date('2026-10-09T00:17:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

// `supabase migration list --linked` (supabase@2.62.10) の実際の出力の形
const LIST_IN_SYNC = [
  '',
  '  ',
  '   Local          | Remote         | Time (UTC)          ',
  '  ----------------|----------------|---------------------',
  '   20251126124224 | 20251126124224 | 2025-11-26 12:42:24 ',
  '   20261007112200 | 20261007112200 | 2026-10-07 11:22:00 ',
  '   20261008120100 | 20261008120100 | 2026-10-08 12:01:00 ',
  '',
].join('\n');

const LIST_DRIFTED = [
  '   Local          | Remote         | Time (UTC)          ',
  '  ----------------|----------------|---------------------',
  '   20251126124224 | 20251126124224 | 2025-11-26 12:42:24 ',
  '                  | 20251201093011 | 2025-12-01 09:30:11 ',
  '   20261008120100 | 20261008120100 | 2026-10-08 12:01:00 ',
  '   20261009090000 |                | 2026-10-09 09:00:00 ',
].join('\n');

// ───────────────────────────────────────────────────────────────────────────
// 1. migration のずれ
// ───────────────────────────────────────────────────────────────────────────

describe('parseMigrationList', () => {
  it('実際の出力 (行頭・行末に | が無い) から version の行だけを取り出す (見出し・区切り線は落とす)', () => {
    expect(parseMigrationList(LIST_IN_SYNC)).toEqual([
      { local: '20251126124224', remote: '20251126124224' },
      { local: '20261007112200', remote: '20261007112200' },
      { local: '20261008120100', remote: '20261008120100' },
    ]);
  });

  it('片側が空の行 (本番だけ・リポジトリだけ) も位置を崩さずに読む', () => {
    expect(parseMigrationList(LIST_DRIFTED)).toEqual([
      { local: '20251126124224', remote: '20251126124224' },
      { local: '', remote: '20251201093011' },
      { local: '20261008120100', remote: '20261008120100' },
      { local: '20261009090000', remote: '' },
    ]);
  });

  it('古い形式 (| a | b | c |) にも対応する', () => {
    const text = ['|Local|Remote|Time (UTC)|', '|-----|------|----|', '|20251126124224|20251126124224|x|', '||20251201093011|y|'].join('\n');
    expect(parseMigrationList(text)).toEqual([
      { local: '20251126124224', remote: '20251126124224' },
      { local: '', remote: '20251201093011' },
    ]);
  });

  it('空・null・無関係な文字列は 0 行', () => {
    expect(parseMigrationList('')).toEqual([]);
    expect(parseMigrationList(null)).toEqual([]);
    expect(parseMigrationList('Connecting to remote database...\nerror: failed')).toEqual([]);
  });
});

describe('classifyMigrationDrift', () => {
  it('揃っていれば問題なし。台帳の最新 version を返す', () => {
    const drift = classifyMigrationDrift(parseMigrationList(LIST_IN_SYNC));
    expect(drift).toEqual({ malformed: [], remoteOnly: [], localOnly: [], ledgerMax: '20261008120100', parsedRows: 3 });
  });

  it('本番にだけある version と、本番に適用されていない version を分ける (新しい LOCAL_ONLY も問題として数える)', () => {
    const drift = classifyMigrationDrift(parseMigrationList(LIST_DRIFTED));
    expect(drift.remoteOnly).toEqual(['20251201093011']);
    expect(drift.localOnly).toEqual(['20261009090000']);
    expect(drift.ledgerMax).toBe('20261008120100');
  });

  it('14 桁でない version は形式違いとして別に数え、ずれの分類には入れない', () => {
    const drift = classifyMigrationDrift([
      { local: '2026100812', remote: '' },
      { local: '020261008120100', remote: '020261008120100' },
      { local: '20261008120100', remote: '20261008120100' },
    ]);
    expect(drift.malformed).toEqual(['020261008120100', '2026100812']);
    expect(drift.localOnly).toEqual([]);
    expect(drift.ledgerMax).toBe('20261008120100');
  });
});

describe('buildDbProblems', () => {
  it('台帳が揃っていて db diff も空なら問題なし', () => {
    const { problems } = buildDbProblems({ migrationListText: LIST_IN_SYNC, diffStatus: 0, diffText: '' });
    expect(problems).toEqual([]);
  });

  it('台帳を取得できなかった (null) ・1 行も読めなかったときは、問題なしにしない (fail-open にしない)', () => {
    expect(buildDbProblems({ migrationListText: null, diffStatus: 0, diffText: '' }).problems.map((p) => p.kind)).toEqual(['list-failed']);
    expect(buildDbProblems({ migrationListText: 'error: connection refused', diffStatus: 0, diffText: '' }).problems.map((p) => p.kind)).toEqual([
      'list-failed',
    ]);
  });

  it('本番だけ・未適用・形式違いをそれぞれ問題にする', () => {
    const { problems } = buildDbProblems({
      migrationListText: `${LIST_DRIFTED}\n   2026100812     |                | x`,
      diffStatus: 0,
      diffText: '',
    });
    expect(problems.map((p) => p.kind)).toEqual(['remote-only', 'local-only', 'malformed']);
    expect(problems[0].detail).toContain('20251201093011');
    expect(problems[1].detail).toContain('20261009090000');
  });

  it('db diff を実行できなかった・失敗した・差分が出たをそれぞれ問題にする', () => {
    const kinds = (diffStatus: number | null, diffText = '') =>
      buildDbProblems({ migrationListText: LIST_IN_SYNC, diffStatus, diffText }).problems.map((p) => p.kind);
    expect(kinds(null)).toEqual(['diff-not-run']);
    expect(kinds(1)).toEqual(['diff-failed']);
    expect(kinds(0, 'create policy "x" on public.t for select using (true);\nalter table public.t enable row level security;\n')).toEqual([
      'schema-diff',
    ]);
    expect(kinds(0, '   \n\n')).toEqual([]);
  });

  it('差分の SQL そのものは Issue に載せない (行数だけ)', () => {
    const secretish = 'create policy "only_this_line_should_not_appear" on public.t using (true);';
    const { problems, drift } = buildDbProblems({ migrationListText: LIST_IN_SYNC, diffStatus: 0, diffText: `${secretish}\nselect 1;` });
    expect(problems[0].detail).toContain('2 行');
    const body = renderDbIssueBody({ problems, drift, runUrl: 'https://example.test/run/1', checkedAt: '2026-10-09 09:17 (JST)' });
    expect(body).not.toContain('only_this_line_should_not_appear');
  });
});

describe('renderDbIssueBody', () => {
  it('目印・確認日時・台帳の最新 version・実行ログ・見つかったこと・対応のしかたを載せる', () => {
    const { problems, drift } = buildDbProblems({ migrationListText: LIST_DRIFTED, diffStatus: 0, diffText: '' });
    const body = renderDbIssueBody({ problems, drift, runUrl: 'https://example.test/run/1', checkedAt: '2026-10-09 09:17 (JST)' });
    expect(body.startsWith(DB_ISSUE_MARKER)).toBe(true);
    expect(body).toContain('2026-10-09 09:17 (JST)');
    expect(body).toContain('20261008120100');
    expect(body).toContain('https://example.test/run/1');
    expect(body).toContain('### 本番にだけある migration が 1 件あります');
    expect(body).toContain('### 本番に適用されていない migration が 1 件あります');
    expect(body).toContain('本番へ直接 DDL を当てないでください');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. 置き去りの PR・ブランチ
// ───────────────────────────────────────────────────────────────────────────

type Check = { name: string; status: string; conclusion: string | null };
const pr = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  draft: false,
  updated_at: hoursAgo(30),
  html_url: `https://github.com/o/r/pull/${number}`,
  mergeable_state: 'clean',
  checks: [{ name: 'test', status: 'completed', conclusion: 'success' }] as Check[],
  ...over,
});

describe('classifyOpenPullRequests', () => {
  it('緑・赤・競合・CI が終わらないに分ける', () => {
    const result = classifyOpenPullRequests(
      [
        pr(1),
        pr(2, { checks: [{ name: 'test', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'completed', conclusion: 'success' }] }),
        pr(3, { mergeable_state: 'dirty', checks: [{ name: 'test', status: 'completed', conclusion: 'failure' }] }),
        pr(4, { checks: [{ name: 'e2e', status: 'in_progress', conclusion: null }] }),
        pr(5, { checks: [] }),
        pr(6, { checks: [{ name: 'a', status: 'completed', conclusion: 'skipped' }, { name: 'b', status: 'completed', conclusion: 'neutral' }] }),
      ],
      NOW,
    );
    expect(result.green.map((p) => p.number)).toEqual([1, 6]);
    expect(result.red).toEqual([{ number: 2, title: 'PR 2', url: 'https://github.com/o/r/pull/2', hours: 30, failed: ['test'] }]);
    expect(result.conflict.map((p) => p.number)).toEqual([3]);
    expect(result.pending.map((p) => p.number)).toEqual([4, 5]);
  });

  it('cancelled / timed_out なども赤として数える', () => {
    for (const conclusion of ['cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']) {
      const result = classifyOpenPullRequests([pr(1, { checks: [{ name: 'e2e', status: 'completed', conclusion }] })], NOW);
      expect(result.red.map((p) => p.number)).toEqual([1]);
    }
  });

  it('下書きと、最後の動きから 24 時間たっていないもの (作業中) は数えない', () => {
    const result = classifyOpenPullRequests([pr(1, { draft: true }), pr(2, { updated_at: hoursAgo(23) }), pr(3, { updated_at: hoursAgo(24) })], NOW);
    expect([...result.green, ...result.red, ...result.conflict, ...result.pending].map((p) => p.number)).toEqual([3]);
  });

  it('staleHours を変えられる', () => {
    const result = classifyOpenPullRequests([pr(1, { updated_at: hoursAgo(5) })], NOW, { staleHours: 4 });
    expect(result.green.map((p) => p.number)).toEqual([1]);
  });
});

describe('findBranchCandidates', () => {
  const prs = [
    { number: 10, state: 'closed', merged_at: hoursAgo(100), head: { ref: 'fix/merged-clean', sha: 'aaa' } },
    { number: 11, state: 'closed', merged_at: hoursAgo(100), head: { ref: 'fix/pushed-after', sha: 'bbb' } },
    { number: 15, state: 'closed', merged_at: null, head: { ref: 'fix/pushed-after', sha: 'ccc' } },
    { number: 12, state: 'open', merged_at: null, head: { ref: 'fix/open', sha: 'old' } },
  ];
  const branches = [
    { name: 'main', sha: 'm' },
    { name: 'gh-pages', sha: 'g' },
    { name: 'dependabot/npm_and_yarn/next-14.2.35', sha: 'd' },
    { name: 'fix/merged-clean', sha: 'aaa' },
    { name: 'fix/pushed-after', sha: 'zzz' },
    { name: 'fix/open', sha: 'new' },
    { name: 'claude/never-pr', sha: 'eee' },
  ];

  it('PR が無いブランチと、PR のあとに push されたブランチだけを候補にする', () => {
    expect(findBranchCandidates(branches, prs)).toEqual([
      { name: 'fix/pushed-after', sha: 'zzz', reason: 'pushed-after-pr', lastPr: 15 },
      { name: 'claude/never-pr', sha: 'eee', reason: 'no-pr' },
    ]);
  });
});

describe('filterStaleBranches', () => {
  it('最後のコミットから 24 時間たっていないものは外す。日時が分からないものは残す', () => {
    const result = filterStaleBranches(
      [
        { name: 'fix/b', sha: '1', reason: 'no-pr', committedAt: hoursAgo(2) },
        { name: 'fix/a', sha: '2', reason: 'no-pr', committedAt: hoursAgo(25) },
        { name: 'fix/c', sha: '3', reason: 'pushed-after-pr', committedAt: null },
      ],
      NOW,
    );
    expect(result.map((b) => [b.name, b.hours])).toEqual([
      ['fix/a', 25],
      ['fix/c', null],
    ]);
  });

  it('PR が一度も無い古い (14 日より前の) ブランチは並べない。ただし claude/ と、PR のあとに push されたものは残す', () => {
    const old = hoursAgo(24 * 30);
    const result = filterStaleBranches(
      [
        { name: 'feature/ancient', sha: '1', reason: 'no-pr', committedAt: old },
        { name: 'claude/ancient', sha: '2', reason: 'no-pr', committedAt: old },
        { name: 'fix/after-pr', sha: '3', reason: 'pushed-after-pr', committedAt: old },
        { name: 'feature/recent', sha: '4', reason: 'no-pr', committedAt: hoursAgo(24 * 13) },
      ],
      NOW,
    );
    expect(result.map((b) => b.name)).toEqual(['claude/ancient', 'feature/recent', 'fix/after-pr']);
  });
});

describe('renderStaleIssueBody / hasStaleFindings', () => {
  const empty = { green: [], red: [], conflict: [], pending: [] };

  it('該当が無ければ hasStaleFindings は false', () => {
    expect(hasStaleFindings({ prs: empty, branches: [] })).toBe(false);
    expect(hasStaleFindings({ prs: { ...empty, pending: [{ number: 1, title: 't', url: 'u', hours: 30 }] }, branches: [] })).toBe(true);
  });

  it('区分ごとに見出しを付けて並べる (該当の無い区分は出さない)', () => {
    const body = renderStaleIssueBody({
      prs: { ...empty, red: [{ number: 7, title: 'CI 直し', url: 'u', hours: 50, failed: ['test', 'e2e'] }] },
      branches: [{ name: 'claude/x', sha: '0123456789abcdef', reason: 'no-pr', hours: 30 }],
      runUrl: 'https://example.test/run/2',
      checkedAt: '2026-10-09 09:17 (JST)',
    });
    expect(body.startsWith(STALE_ISSUE_MARKER)).toBe(true);
    expect(body).toContain('## CI が赤のままの PR');
    expect(body).toContain('- #7 CI 直し (最後の動きから 2 日) — 失敗: test, e2e');
    expect(body).toContain('## main に入っていないブランチ');
    expect(body).toContain('- `claude/x` (0123456) — PR がありません (最後のコミットから 30 時間)');
    expect(body).not.toContain('## CI が緑のまま');
    expect(body).not.toContain('## main と競合したままの PR');
  });

  it(`並べるのは区分ごとに ${MAX_LISTED} 件まで (残りは件数だけ)`, () => {
    const many = Array.from({ length: MAX_LISTED + 3 }, (_, i) => ({ number: i + 1, title: `t${i + 1}`, url: 'u', hours: 30 }));
    const body = renderStaleIssueBody({ prs: { ...empty, green: many }, branches: [], runUrl: 'r', checkedAt: 'c' });
    expect(body).toContain(`- #${MAX_LISTED} t${MAX_LISTED} `);
    expect(body).not.toContain(`- #${MAX_LISTED + 1} `);
    expect(body).toContain('- ほか 3 件 (実行ログを参照)');
  });
});

describe('planIssueAction', () => {
  it('問題があれば作る (既にあれば更新)、無くなれば閉じる (無ければ何もしない)', () => {
    expect(planIssueAction({ existing: undefined, hasProblems: true })).toBe('create');
    expect(planIssueAction({ existing: { number: 1 }, hasProblems: true })).toBe('update');
    expect(planIssueAction({ existing: { number: 1 }, hasProblems: false })).toBe('close');
    expect(planIssueAction({ existing: undefined, hasProblems: false })).toBe('none');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. CLI (gh を差し替える)
// ───────────────────────────────────────────────────────────────────────────

type GhCall = { args: string[]; input?: string };

/** gh api の呼び出しを記録し、path ごとの応答を返す偽物 */
function fakeGh(routes: Record<string, string | ((input?: string) => string)>) {
  const calls: GhCall[] = [];
  const gh = (args: string[], input?: string) => {
    calls.push({ args, input });
    const target = args.find((a) => a.startsWith('repos/')) ?? '';
    const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
    const key = `${method} ${target}`;
    const route = routes[key];
    if (route === undefined) throw new Error(`unexpected gh call: ${key}`);
    return typeof route === 'function' ? route(input) : route;
  };
  return { gh, calls };
}

const REPO = 'o/r';
const ENV = { GITHUB_REPOSITORY: REPO, RUN_URL: 'https://example.test/run/9' };
const lines = (items: unknown[]) => items.map((i) => JSON.stringify(i)).join('\n') + '\n';

function runCli(argv: string[], routes: Parameters<typeof fakeGh>[0], files: Record<string, string> = {}) {
  const { gh, calls } = fakeGh(routes);
  const out: string[] = [];
  const err: string[] = [];
  const summary: string[] = [];
  const code = main(argv, {
    gh,
    env: ENV,
    now: NOW,
    log: (m: string) => out.push(m),
    logError: (m: string) => err.push(m),
    appendSummary: (t: string) => summary.push(t),
    readFile: (f: string) => files[f],
    exists: (f: string) => f in files,
  });
  return { code, calls, out: out.join('\n'), err: err.join('\n'), summary: summary.join('\n') };
}

const ISSUES = `GET repos/${REPO}/issues?state=open&per_page=100&page=1`;

describe('CLI: db', () => {
  const dbArgs = ['db', '--migration-list', '/tmp/list.txt', '--db-diff', '/tmp/diff.sql', '--db-diff-status', '0'];

  it('ずれが無く Issue も無ければ、何も書き込まず 0 で終わる', () => {
    const r = runCli(dbArgs, { [ISSUES]: '' }, { '/tmp/list.txt': LIST_IN_SYNC, '/tmp/diff.sql': '' });
    expect(r.code).toBe(0);
    expect(r.calls.filter((c) => c.args.includes('-X'))).toEqual([]);
    expect(r.summary).toContain('ずれなし');
    expect(r.summary).toContain('20261008120100');
  });

  it('ずれがあれば Issue を作り、1 で終わる (本文は標準入力で渡す)', () => {
    const r = runCli(
      dbArgs,
      { [ISSUES]: lines([{ number: 3, title: 'ほかの Issue', body: '関係ない' }]), [`POST repos/${REPO}/issues`]: '{"number":42}' },
      { '/tmp/list.txt': LIST_DRIFTED, '/tmp/diff.sql': '' },
    );
    expect(r.code).toBe(1);
    const create = r.calls.find((c) => c.args.includes('POST'));
    expect(create?.args).toEqual(['api', '-X', 'POST', `repos/${REPO}/issues`, '--input', '-']);
    const payload = JSON.parse(create?.input ?? '{}');
    expect(payload.title).toBe(DB_ISSUE_TITLE);
    expect(payload.body.startsWith(DB_ISSUE_MARKER)).toBe(true);
    expect(payload.body).toContain('https://example.test/run/9');
    expect(payload.body).toContain('2026-10-09 09:17 (JST)');
    expect(r.out).toContain('Issue を作りました: #42');
  });

  it('同じ目印の Issue が開いていれば、新しく作らず本文を更新する', () => {
    const r = runCli(
      dbArgs,
      {
        [ISSUES]: lines([{ number: 8, title: DB_ISSUE_TITLE, body: `${DB_ISSUE_MARKER}\n前回の結果` }]),
        [`PATCH repos/${REPO}/issues/8`]: '{}',
      },
      { '/tmp/list.txt': LIST_DRIFTED, '/tmp/diff.sql': '' },
    );
    expect(r.code).toBe(1);
    expect(r.calls.some((c) => c.args.includes('POST'))).toBe(false);
    const patch = r.calls.find((c) => c.args.includes('PATCH'));
    expect(Object.keys(JSON.parse(patch?.input ?? '{}'))).toEqual(['body']);
  });

  it('ずれが無くなったら、開いている Issue にコメントして閉じる', () => {
    const r = runCli(
      dbArgs,
      {
        [ISSUES]: lines([{ number: 8, title: DB_ISSUE_TITLE, body: `${DB_ISSUE_MARKER}\n前回の結果` }]),
        [`POST repos/${REPO}/issues/8/comments`]: '{}',
        [`PATCH repos/${REPO}/issues/8`]: '{}',
      },
      { '/tmp/list.txt': LIST_IN_SYNC, '/tmp/diff.sql': '' },
    );
    expect(r.code).toBe(0);
    const comment = r.calls.find((c) => c.args.includes(`repos/${REPO}/issues/8/comments`));
    expect(JSON.parse(comment?.input ?? '{}').body).toContain('自動で閉じます');
    const close = r.calls.find((c) => c.args.includes('PATCH'));
    expect(JSON.parse(close?.input ?? '{}')).toEqual({ state: 'closed', state_reason: 'completed' });
  });

  it('台帳のファイルが無い (取得に失敗した) ときは問題として報告する', () => {
    const r = runCli(
      ['db', '--migration-list', '/tmp/missing.txt', '--db-diff', '/tmp/diff.sql', '--db-diff-status', ''],
      { [ISSUES]: '', [`POST repos/${REPO}/issues`]: '{"number":5}' },
      { '/tmp/diff.sql': '' },
    );
    expect(r.code).toBe(1);
    const payload = JSON.parse(r.calls.find((c) => c.args.includes('POST'))?.input ?? '{}');
    expect(payload.body).toContain('本番の migration 台帳を読めませんでした');
    expect(payload.body).toContain('本番のスキーマとの比較 (db diff) を実行できませんでした');
  });

  it('--dry-run では Issue に触らず、本文を出力する', () => {
    const r = runCli([...dbArgs, '--dry-run'], { [ISSUES]: '' }, { '/tmp/list.txt': LIST_DRIFTED, '/tmp/diff.sql': '' });
    expect(r.code).toBe(1);
    expect(r.calls.filter((c) => c.args.includes('-X'))).toEqual([]);
    expect(r.out).toContain('[dry-run] Issue: create');
    expect(r.out).toContain(DB_ISSUE_MARKER);
  });

  it('引数の誤り・環境変数の不足は 2 で終わる', () => {
    expect(runCli(['nope'], {}).code).toBe(2);
    expect(runCli(['db', '--db-diff-status', 'abc'], { [ISSUES]: '' }).code).toBe(2);
    expect(runCli(['db', '--migration-list'], {}).code).toBe(2);
    const { gh } = fakeGh({});
    expect(main(['stale'], { gh, env: {}, now: NOW, log: () => {}, logError: () => {}, appendSummary: () => {} })).toBe(2);
  });
});

describe('CLI: stale', () => {
  const PULLS = `GET repos/${REPO}/pulls?state=all&per_page=100&page=1`;
  const BRANCHES = `GET repos/${REPO}/branches?per_page=100&page=1`;

  const baseRoutes = {
    [PULLS]: lines([
      { number: 20, title: '緑のまま', state: 'open', draft: false, merged_at: null, updated_at: hoursAgo(40), html_url: 'u20', head: { ref: 'fix/green', sha: 'g1' } },
      { number: 21, title: '作業中', state: 'open', draft: false, merged_at: null, updated_at: hoursAgo(1), html_url: 'u21', head: { ref: 'fix/wip', sha: 'w1' } },
      { number: 22, title: '下書き', state: 'open', draft: true, merged_at: null, updated_at: hoursAgo(99), html_url: 'u22', head: { ref: 'fix/draft', sha: 'd1' } },
      { number: 19, title: 'マージ済み', state: 'closed', draft: false, merged_at: hoursAgo(50), updated_at: hoursAgo(50), html_url: 'u19', head: { ref: 'fix/done', sha: 'm1' } },
    ]),
    [`GET repos/${REPO}/pulls/20`]: 'clean\n',
    [`GET repos/${REPO}/commits/g1/check-runs?per_page=100&page=1`]: lines([{ name: 'test', status: 'completed', conclusion: 'success' }]),
    [BRANCHES]: lines([
      { name: 'main', sha: 'mm' },
      { name: 'fix/green', sha: 'g1' },
      { name: 'fix/done', sha: 'm1' },
      { name: 'claude/forgotten', sha: 'c1' },
      { name: 'fix/just-pushed', sha: 'j1' },
    ]),
    [`GET repos/${REPO}/commits/c1`]: `${hoursAgo(30)}\n`,
    [`GET repos/${REPO}/commits/j1`]: `${hoursAgo(2)}\n`,
  };

  it('24 時間以上止まった PR と、PR になっていないブランチを Issue にする (0 で終わる)', () => {
    const r = runCli(['stale'], { ...baseRoutes, [ISSUES]: '', [`POST repos/${REPO}/issues`]: '{"number":77}' });
    expect(r.code).toBe(0);
    // 詳しく調べるのは、開いていて下書きでなく 24 時間以上止まっている PR だけ
    expect(r.calls.some((c) => c.args.includes(`repos/${REPO}/pulls/21`))).toBe(false);
    expect(r.calls.some((c) => c.args.includes(`repos/${REPO}/pulls/22`))).toBe(false);
    const payload = JSON.parse(r.calls.find((c) => c.args.includes('POST'))?.input ?? '{}');
    expect(payload.title).toBe(STALE_ISSUE_TITLE);
    expect(payload.body).toContain('- #20 緑のまま (最後の動きから 40 時間)');
    expect(payload.body).toContain('`claude/forgotten`');
    expect(payload.body).not.toContain('fix/just-pushed');
    expect(payload.body).not.toContain('fix/done');
    expect(r.summary).toContain('緑のまま 1 / 赤のまま 0 / 競合 0 / CI が終わらない 0 / main に入っていないブランチ 1');
  });

  it('コミットの日時を取れないブランチは残す (見落とさない側)', () => {
    const r = runCli(['stale', '--dry-run'], {
      ...baseRoutes,
      [`GET repos/${REPO}/commits/c1`]: () => {
        throw new Error('HTTP 502');
      },
      [ISSUES]: '',
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('`claude/forgotten` (c1) — PR がありません (最後のコミットから 日時不明)');
  });

  it('該当が無くなったら、開いている Issue を閉じる', () => {
    const r = runCli(['stale'], {
      [PULLS]: '',
      [BRANCHES]: lines([{ name: 'main', sha: 'mm' }]),
      [ISSUES]: lines([{ number: 30, title: STALE_ISSUE_TITLE, body: `${STALE_ISSUE_MARKER}\n前回` }]),
      [`POST repos/${REPO}/issues/30/comments`]: '{}',
      [`PATCH repos/${REPO}/issues/30`]: '{}',
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Issue #30 を閉じました');
  });

  it('GitHub API が失敗したら 2 で終わる (問題なしにしない)', () => {
    const r = runCli(['stale'], {
      [PULLS]: () => {
        throw new Error('HTTP 401: Bad credentials');
      },
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain('検査に失敗しました');
  });
});

describe('parseArgs / createGitHub', () => {
  it('db の引数を読む', () => {
    expect(parseArgs(['db', '--migration-list', 'a', '--db-diff', 'b', '--db-diff-status', '0', '--dry-run'])).toEqual({
      command: 'db',
      dryRun: true,
      migrationList: 'a',
      dbDiff: 'b',
      dbDiffStatus: '0',
    });
  });

  it('一覧は --jq で 1 件 1 行にして読む (Link ヘッダをたどる --paginate は使わない)', () => {
    const { gh, calls } = fakeGh({ [`GET repos/${REPO}/branches?per_page=100&page=1`]: lines([{ name: 'main', sha: 's' }]) });
    expect(createGitHub({ repo: REPO, gh }).listBranches()).toEqual([{ name: 'main', sha: 's' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('--jq');
    expect(calls[0].args).not.toContain('--paginate');
  });

  it(`1 ページが ${PER_PAGE} 件ちょうどなら次のページも読み、${PER_PAGE} 件未満のページで止める`, () => {
    const full = Array.from({ length: PER_PAGE }, (_, i) => ({ name: `b${i}`, sha: `s${i}` }));
    const { gh, calls } = fakeGh({
      [`GET repos/${REPO}/branches?per_page=100&page=1`]: lines(full),
      [`GET repos/${REPO}/branches?per_page=100&page=2`]: lines([{ name: 'last', sha: 'z' }]),
    });
    const branches = createGitHub({ repo: REPO, gh }).listBranches();
    expect(branches).toHaveLength(PER_PAGE + 1);
    expect(branches.at(-1)).toEqual({ name: 'last', sha: 'z' });
    expect(calls).toHaveLength(2);
  });

  it('Issue の一覧から PR を除く (PR の本文に目印があっても Issue として扱わない)', () => {
    const { gh } = fakeGh({
      [ISSUES]: lines([
        { number: 1, title: 'PR', body: DB_ISSUE_MARKER, is_pr: true },
        { number: 2, title: 'Issue', body: DB_ISSUE_MARKER, is_pr: false },
      ]),
    });
    expect(createGitHub({ repo: REPO, gh }).listOpenIssues()).toEqual([{ number: 2, title: 'Issue', body: DB_ISSUE_MARKER }]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. ワークフローの定義
// ───────────────────────────────────────────────────────────────────────────

const WORKFLOW_PATH = path.join(process.cwd(), '.github', 'workflows', 'daily-consistency-check.yml');
const workflowText = readFileSync(WORKFLOW_PATH, 'utf8');
type Step = { name?: string; run?: string; if?: string; env?: Record<string, string>; uses?: string };
type Job = { if?: string; steps: Step[] };
const workflow = yaml.load(workflowText) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};

describe('daily-consistency-check.yml', () => {
  it('毎日の schedule と手動実行だけで動く (push・PR では動かない)', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(workflow.on.schedule).toEqual([{ cron: '17 0 * * *' }]);
  });

  it('権限は読み取りと Issue の書き込みだけ', () => {
    expect(workflow.permissions).toEqual({ contents: 'read', issues: 'write', 'pull-requests': 'read', checks: 'read' });
  });

  it('どのジョブも main でだけ動く (作業ブランチから手動実行しても検査しない)', () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(['db-drift', 'stale']);
    for (const job of Object.values(workflow.jobs)) expect(job.if).toBe("github.ref == 'refs/heads/main'");
  });

  it('supabase のコマンドは link / migration list / db diff だけ (本番に書き込むコマンドを使わない)', () => {
    const runs = Object.values(workflow.jobs).flatMap((j) => j.steps.map((s) => s.run ?? ''));
    const subcommands = runs.flatMap((r) => [...r.matchAll(/supabase@[0-9.]+\s+([a-z]+(?:\s+[a-z][a-z-]*)?)/g)].map((m) => m[1]));
    expect(new Set(subcommands)).toEqual(new Set(['link', 'migration list', 'db diff']));
    // コメントの「使わない」という説明は対象外にし、実際に実行する run だけを見る
    const script = runs.join('\n');
    for (const forbidden of [/db\s+push/, /migration\s+repair/, /db\s+reset/, /--include-all/, /\bpsql\b/, /db\s+execute/]) {
      expect(script).not.toMatch(forbidden);
    }
  });

  it('Issue の報告は前の手順が失敗しても必ず動く', () => {
    const report = workflow.jobs['db-drift'].steps.find((s) => s.name === 'Report (Issue)');
    expect(report?.if).toBe('always()');
    expect(report?.run).toContain('node scripts/consistency-check.mjs db');
    expect(report?.env?.GH_TOKEN).toBe('${{ github.token }}');
    const stale = workflow.jobs.stale.steps.find((s) => s.name === 'Report (Issue)');
    expect(stale?.run).toBe('node scripts/consistency-check.mjs stale');
  });

  it('PR をマージ・承認しない (自動マージを戻さない)', () => {
    expect(workflowText).not.toMatch(/gh\s+pr\s+(merge|review)/);
    expect(workflowText).not.toMatch(/\/merge\b/);
  });
});
