#!/usr/bin/env node
/**
 * scripts/consistency-check.mjs — 毎日の整合性チェックの本体
 * (.github/workflows/daily-consistency-check.yml から呼ぶ。判定は scripts/lib/consistency-check.mjs)
 *
 *   node scripts/consistency-check.mjs db --migration-list <file> --db-diff <file> --db-diff-status <code> [--dry-run]
 *   node scripts/consistency-check.mjs stale [--dry-run]
 *
 * db:    `supabase migration list --linked` と `supabase db diff --linked` の結果 (ファイル) を読み、
 *        本番 DB とリポジトリの migration のずれを判定する。DB には接続しない (結果のファイルを読むだけ)。
 * stale: GitHub API で、PR になっていないブランチと、24 時間以上止まっている PR を探す。
 *
 * どちらも、問題があれば Issue を 1 件作り (同じ目印の Issue が開いていれば本文を更新)、無くなれば閉じる。
 * GitHub への読み書きは gh CLI (`gh api`) で行う。認証は環境変数 GH_TOKEN (ワークフローでは github.token)。
 * 書き込みは Issue の作成・本文の更新・コメント・クローズだけ (PR・ブランチ・設定には触らない)。
 * --dry-run のときは Issue に触らず、するはずだったことと本文を標準出力に出す。
 *
 * 終了コード: db は問題があれば 1 (ワークフローを赤にして気づけるように)。stale は問題があっても 0。
 *            引数の誤り・API の失敗などで検査そのものができなかったときは 2。
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  DB_ISSUE_MARKER,
  DB_ISSUE_TITLE,
  DEFAULT_STALE_HOURS,
  STALE_ISSUE_MARKER,
  STALE_ISSUE_TITLE,
  buildDbProblems,
  classifyOpenPullRequests,
  filterStaleBranches,
  findBranchCandidates,
  hasStaleFindings,
  planIssueAction,
  renderDbIssueBody,
  renderStaleIssueBody,
} from './lib/consistency-check.mjs';

export class UsageError extends Error {}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'db' && command !== 'stale') {
    throw new UsageError('使い方: consistency-check.mjs <db|stale> [--dry-run] (db は --migration-list / --db-diff / --db-diff-status も)');
  }
  const args = { command, dryRun: false, migrationList: null, dbDiff: null, dbDiffStatus: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const value = () => {
      if (i + 1 >= rest.length) throw new UsageError(`${a} には値が必要です`);
      return rest[++i];
    };
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--migration-list') args.migrationList = value();
    else if (a === '--db-diff') args.dbDiff = value();
    else if (a === '--db-diff-status') args.dbDiffStatus = value();
    else throw new UsageError(`知らない引数です: ${a}`);
  }
  return args;
}

/** gh を実行して標準出力を返す。input を渡すと標準入力に流す (書き込みの本文は引数でなく標準入力で渡す) */
function defaultGh(args, input) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
}

export const PER_PAGE = 100;
const MAX_PAGES = 100;

/**
 * gh api の薄い包み。読み取りは --jq で 1 件 1 行の JSON にして受け取る。
 * ページ送りは gh の --paginate (Link ヘッダの URL をたどる) を使わず、page= を 1 から増やして、
 * 1 ページの件数が PER_PAGE 未満になったら止める (Link ヘッダの URL を通さない中継を経由しても動くように)。
 * そのため --jq では件数を減らさない (絞り込みは JavaScript 側で行う)。
 */
export function createGitHub({ repo, gh = defaultGh }) {
  const jsonLines = (args) =>
    gh(args)
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  const pages = (path, jq) => {
    const all = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = jsonLines(['api', `${path}${path.includes('?') ? '&' : '?'}per_page=${PER_PAGE}&page=${page}`, '--jq', jq]);
      all.push(...items);
      if (items.length < PER_PAGE) return all;
    }
    throw new Error(`${path} の一覧が ${MAX_PAGES} ページを超えました`);
  };
  const send = (method, path, payload) => gh(['api', '-X', method, path, '--input', '-'], JSON.stringify(payload));
  return {
    listPulls: () =>
      pages(
        `repos/${repo}/pulls?state=all`,
        '.[] | {number, title, state, draft, merged_at, updated_at, html_url, head: {ref: .head.ref, sha: .head.sha}} | @json',
      ),
    getMergeableState: (number) =>
      gh(['api', `repos/${repo}/pulls/${number}`, '--jq', '.mergeable_state // ""']).trim(),
    listChecks: (sha) => pages(`repos/${repo}/commits/${sha}/check-runs`, '.check_runs[] | {name, status, conclusion} | @json'),
    listBranches: () => pages(`repos/${repo}/branches`, '.[] | {name, sha: .commit.sha} | @json'),
    commitDate: (sha) => gh(['api', `repos/${repo}/commits/${sha}`, '--jq', '.commit.committer.date']).trim(),
    // issues の一覧には PR も含まれる。件数を減らさないよう jq では印を付けるだけにして、ここで除く
    listOpenIssues: () =>
      pages(`repos/${repo}/issues?state=open`, '.[] | {number, title, body, is_pr: (.pull_request != null)} | @json')
        .filter((issue) => !issue.is_pr)
        .map(({ number, title, body }) => ({ number, title, body })),
    createIssue: (title, body) => JSON.parse(send('POST', `repos/${repo}/issues`, { title, body })).number,
    updateIssue: (number, body) => {
      send('PATCH', `repos/${repo}/issues/${number}`, { body });
    },
    closeIssue: (number, comment) => {
      send('POST', `repos/${repo}/issues/${number}/comments`, { body: comment });
      send('PATCH', `repos/${repo}/issues/${number}`, { state: 'closed', state_reason: 'completed' });
    },
  };
}

function formatJst(now) {
  return `${new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')} (JST)`;
}

function runUrlFrom(env) {
  if (env.RUN_URL) return env.RUN_URL;
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
    return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  }
  return '(ローカル実行)';
}

/** 目印の付いた Issue を、作る・更新する・閉じる (dry-run なら出力するだけ) */
function syncIssue({ github, marker, title, body, hasProblems, dryRun, log, closeComment }) {
  const existing = github.listOpenIssues().find((issue) => String(issue.body ?? '').includes(marker));
  const action = planIssueAction({ existing, hasProblems });
  if (dryRun) {
    log(`[dry-run] Issue: ${action}${existing ? ` #${existing.number}` : ''}`);
    if (hasProblems) log(`--- ${title}\n${body}`);
    return action;
  }
  if (action === 'create') log(`Issue を作りました: #${github.createIssue(title, body)}`);
  if (action === 'update') {
    github.updateIssue(existing.number, body);
    log(`Issue #${existing.number} を更新しました`);
  }
  if (action === 'close') {
    github.closeIssue(existing.number, closeComment);
    log(`Issue #${existing.number} を閉じました (該当なし)`);
  }
  if (action === 'none') log('該当なし (Issue はありません)');
  return action;
}

function readOptional(file, readFile, exists) {
  return file && exists(file) ? readFile(file, 'utf8') : null;
}

export function runDb(args, deps) {
  const { github, now, env, log, readFile = readFileSync, exists = existsSync, appendSummary } = deps;
  const migrationListText = readOptional(args.migrationList, readFile, exists);
  const statusText = String(args.dbDiffStatus ?? '').trim();
  const diffStatus = statusText === '' ? null : Number(statusText);
  if (diffStatus !== null && !Number.isInteger(diffStatus)) throw new UsageError(`--db-diff-status が数値ではありません: ${statusText}`);
  const diffText = readOptional(args.dbDiff, readFile, exists) ?? '';

  const { problems, drift } = buildDbProblems({ migrationListText, diffStatus, diffText });
  const body = renderDbIssueBody({ problems, drift, runUrl: runUrlFrom(env), checkedAt: formatJst(now) });

  appendSummary(
    problems.length === 0
      ? `## 本番 DB とリポジトリの migration: ずれなし\n\n台帳の最新 version: ${drift.ledgerMax}\n`
      : `## 本番 DB とリポジトリの migration: 問題 ${problems.length} 件\n\n${problems.map((p) => `- ${p.title}`).join('\n')}\n`,
  );
  for (const p of problems) log(`問題: ${p.title}`);

  syncIssue({
    github, marker: DB_ISSUE_MARKER, title: DB_ISSUE_TITLE, body, hasProblems: problems.length > 0, dryRun: args.dryRun, log,
    closeComment: `${formatJst(now)} の検査で、本番 DB とリポジトリの migration のずれが無くなったことを確認しました。自動で閉じます。\n\n実行ログ: ${runUrlFrom(env)}`,
  });
  return problems.length > 0 ? 1 : 0;
}

export function runStale(args, deps) {
  const { github, now, env, log, appendSummary, staleHours = DEFAULT_STALE_HOURS } = deps;
  const pulls = github.listPulls();

  // 開いている PR のうち、下書きでなく、最後の動きから staleHours 以上たったものだけ詳しく調べる (API の呼び出しを減らす)
  const old = pulls.filter(
    (p) => p.state === 'open' && !p.draft && (now.getTime() - Date.parse(p.updated_at)) / 3_600_000 >= staleHours,
  );
  const enriched = old.map((p) => ({ ...p, mergeable_state: github.getMergeableState(p.number), checks: github.listChecks(p.head.sha) }));
  const prs = classifyOpenPullRequests(enriched, now, { staleHours });

  const candidates = findBranchCandidates(github.listBranches(), pulls).map((c) => {
    let committedAt = null;
    try {
      committedAt = github.commitDate(c.sha) || null;
    } catch {
      committedAt = null; // 日付が分からなければ残す (見落とさない側)
    }
    return { ...c, committedAt };
  });
  const branches = filterStaleBranches(candidates, now, { staleHours });

  const findings = { prs, branches };
  const hasProblems = hasStaleFindings(findings);
  const body = renderStaleIssueBody({ ...findings, runUrl: runUrlFrom(env), checkedAt: formatJst(now), staleHours });

  const counts = `緑のまま ${prs.green.length} / 赤のまま ${prs.red.length} / 競合 ${prs.conflict.length} / CI が終わらない ${prs.pending.length} / main に入っていないブランチ ${branches.length}`;
  appendSummary(`## 置き去りのブランチ・PR\n\n${counts}\n`);
  log(counts);

  syncIssue({
    github, marker: STALE_ISSUE_MARKER, title: STALE_ISSUE_TITLE, body, hasProblems, dryRun: args.dryRun, log,
    closeComment: `${formatJst(now)} の検査で、置き去りのブランチ・PR が無くなったことを確認しました。自動で閉じます。\n\n実行ログ: ${runUrlFrom(env)}`,
  });
  return 0;
}

export function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((msg) => process.stdout.write(`${msg}\n`));
  const logError = deps.logError ?? ((msg) => process.stderr.write(`${msg}\n`));
  try {
    const args = parseArgs(argv);
    const repo = env.GITHUB_REPOSITORY;
    if (!repo) throw new UsageError('環境変数 GITHUB_REPOSITORY (owner/repo) が必要です');
    const github = deps.github ?? createGitHub({ repo, gh: deps.gh });
    const appendSummary =
      deps.appendSummary ?? ((text) => env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`));
    const common = { ...deps, github, env, log, appendSummary, now: deps.now ?? new Date() };
    return args.command === 'db' ? runDb(args, common) : runStale(args, common);
  } catch (err) {
    logError(err instanceof UsageError ? err.message : `検査に失敗しました: ${err?.message ?? err}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
