/**
 * scripts/lib/consistency-check.mjs
 *
 * 毎日の整合性チェック (.github/workflows/daily-consistency-check.yml) の判定と文面。
 *
 * claude/ ブランチの即マージ (auto-merge.yml) をやめた (#1360) あと、次の 2 つが
 * 「マージが無い日」に気づかれないまま進むのを防ぐ。
 *   1. 本番 DB とリポジトリの migration のずれ (#1064 で 2 か月デプロイできなくなった種類の事故)
 *   2. push されただけで PR になっていないブランチや、緑・赤・競合のまま止まっている PR
 *
 * このファイルは判定と文面づくりだけを持つ (ネットワーク・ファイル・プロセスには触らない)。
 * GitHub API の呼び出しと Issue の作成・更新・クローズは scripts/consistency-check.mjs が行う。
 */

export const DB_ISSUE_MARKER = '<!-- consistency-check:db -->';
export const STALE_ISSUE_MARKER = '<!-- consistency-check:stale -->';
export const DB_ISSUE_TITLE = '[自動検査] 本番 DB とリポジトリの migration がずれています';
export const STALE_ISSUE_TITLE = '[自動検査] 置き去りのブランチ・PR があります';

/** これより新しい動きがあるもの (作業中) は、置き去りとして数えない */
export const DEFAULT_STALE_HOURS = 24;
/** PR が一度も無いブランチは、最後のコミットがこの日数以内のものだけ見る (古い残骸を毎日並べないため) */
export const DEFAULT_RECENT_DAYS = 14;
/** Issue に並べる件数の上限 (本文の長さの上限 65,536 文字を超えないように) */
export const MAX_LISTED = 50;

const VERSION_RE = /^[0-9]{14}$/;
const RED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const GREEN_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
const IGNORED_BRANCH_PREFIXES = ['dependabot/'];
const IGNORED_BRANCHES = new Set(['main', 'gh-pages']);

// ───────────────────────────────────────────────────────────────────────────
// 1. 本番 DB とリポジトリの migration のずれ
// ───────────────────────────────────────────────────────────────────────────

/**
 * `supabase migration list --linked` の出力から、(local, remote) の行を取り出す。
 * 実際の出力は ` 20251126124224 | 20251126124224 | 2025-11-26 12:42:24 ` の形 (行頭・行末に | は無い)。
 * 古い形式の `| a | b | c |` にも対応する。見出し行・区切り線は数字でないので落ちる。
 */
export function parseMigrationList(text) {
  const rows = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.includes('|')) continue;
    const inner = line.startsWith('|') && line.endsWith('|') ? line.slice(1, -1) : line;
    const cols = inner.split('|').map((c) => c.trim());
    if (cols.length < 2) continue;
    const [local, remote] = cols;
    if (!/^[0-9]*$/.test(local) || !/^[0-9]*$/.test(remote)) continue;
    if (local === '' && remote === '') continue;
    rows.push({ local, remote });
  }
  return rows;
}

/**
 * migration の台帳 (本番) とリポジトリの対応を分類する。
 * 毎日の検査では、deploy の drift guard と違って「新しい LOCAL_ONLY」も問題として扱う
 * (main に入ったのに本番へ適用されていない = デプロイの失敗・取りこぼし)。
 */
export function classifyMigrationDrift(rows) {
  const malformed = new Set();
  const remoteOnly = [];
  const localOnly = [];
  let ledgerMax = null;
  for (const { local, remote } of rows) {
    for (const v of [local, remote]) {
      if (v && !VERSION_RE.test(v)) malformed.add(v);
    }
    if ((local && !VERSION_RE.test(local)) || (remote && !VERSION_RE.test(remote))) continue;
    if (local && remote) {
      if (ledgerMax === null || remote > ledgerMax) ledgerMax = remote;
    } else if (remote) {
      remoteOnly.push(remote);
    } else if (local) {
      localOnly.push(local);
    }
  }
  return { malformed: [...malformed].sort(), remoteOnly, localOnly, ledgerMax, parsedRows: rows.length };
}

/**
 * DB の検査結果から、Issue に載せる「問題」の一覧を作る。
 *
 * @param {object} input
 * @param {string|null} input.migrationListText `migration list --linked` の出力 (取得できなかったら null)
 * @param {number|null} input.diffStatus        `db diff --linked` の終了コード (実行できなかったら null)
 * @param {string}      input.diffText          `db diff --linked` の出力 (SQL)。空なら差分なし
 */
export function buildDbProblems({ migrationListText, diffStatus, diffText }) {
  const problems = [];
  const drift = classifyMigrationDrift(parseMigrationList(migrationListText ?? ''));

  if (migrationListText === null || drift.parsedRows === 0) {
    problems.push({
      kind: 'list-failed',
      title: '本番の migration 台帳を読めませんでした',
      detail: '`supabase migration list --linked` の取得に失敗したか、出力を 1 行も読めませんでした。認証情報 (SUPABASE_ACCESS_TOKEN / SUPABASE_DB_PASSWORD) か接続の問題が考えられます。実行ログを確認してください。',
    });
  } else {
    if (drift.remoteOnly.length > 0) {
      problems.push({
        kind: 'remote-only',
        title: `本番にだけある migration が ${drift.remoteOnly.length} 件あります`,
        detail: `本番の台帳にあって、リポジトリにファイルが無い version: ${drift.remoteOnly.join(', ')}。本番へ直接 DDL を当てた (Supabase MCP の apply_migration、ダッシュボードの SQL Editor など) か、migration ファイルの改名・削除の疑いがあります (#1064 と同じ種類)。`,
      });
    }
    if (drift.localOnly.length > 0) {
      problems.push({
        kind: 'local-only',
        title: `本番に適用されていない migration が ${drift.localOnly.length} 件あります`,
        detail: `リポジトリにあって、本番の台帳に無い version: ${drift.localOnly.join(', ')}。main に入ったのに Deploy Supabase Migrations が失敗した・動いていない可能性があります。`,
      });
    }
    if (drift.malformed.length > 0) {
      problems.push({
        kind: 'malformed',
        title: `形式の違う version が ${drift.malformed.length} 件あります`,
        detail: `14 桁 (YYYYMMDDHHMMSS) でない version: ${drift.malformed.join(', ')}。`,
      });
    }
  }

  if (diffStatus === null || diffStatus === undefined) {
    problems.push({
      kind: 'diff-not-run',
      title: '本番のスキーマとの比較 (db diff) を実行できませんでした',
      detail: '前の手順が失敗したため、`supabase db diff --linked` を実行していません。実行ログを確認してください。',
    });
  } else if (diffStatus !== 0) {
    problems.push({
      kind: 'diff-failed',
      title: '本番のスキーマとの比較 (db diff) が失敗しました',
      detail: `\`supabase db diff --linked\` が終了コード ${diffStatus} で失敗しました。空の DB に migration を流せなかった可能性があります (#1116)。実行ログを確認してください。`,
    });
  } else if (String(diffText ?? '').trim() !== '') {
    const lines = String(diffText).trim().split(/\r?\n/).length;
    problems.push({
      kind: 'schema-diff',
      title: '本番のスキーマが migration と一致しません',
      detail: `\`supabase db diff --linked --schema public\` に ${lines} 行の差分が出ました。本番へ直接変更を当てた可能性があります。差分の SQL は実行ログの Summary にあります (この Issue には載せません)。`,
    });
  }

  return { problems, drift };
}

// ───────────────────────────────────────────────────────────────────────────
// 2. 置き去りの PR・ブランチ
// ───────────────────────────────────────────────────────────────────────────

function hoursSince(iso, now) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / 3_600_000;
}

/**
 * 開いている PR を「緑のまま」「赤のまま」「競合のまま」「CI が終わらない」に分ける。
 * 下書き (draft) と、最後の動きから staleHours 未満のもの (作業中) は数えない。
 *
 * @param {Array<{number:number,title:string,draft:boolean,updated_at:string,html_url:string,mergeable_state?:string,checks:Array<{name:string,status:string,conclusion:string|null}>}>} prs
 */
export function classifyOpenPullRequests(prs, now, { staleHours = DEFAULT_STALE_HOURS } = {}) {
  const result = { green: [], red: [], conflict: [], pending: [] };
  for (const pr of prs) {
    if (pr.draft) continue;
    const hours = hoursSince(pr.updated_at, now);
    if (hours === null || hours < staleHours) continue;
    const entry = { number: pr.number, title: pr.title, url: pr.html_url, hours: Math.floor(hours) };
    const checks = pr.checks ?? [];
    const failed = checks.filter((c) => c.status === 'completed' && RED_CONCLUSIONS.has(c.conclusion ?? ''));
    const unfinished = checks.filter((c) => c.status !== 'completed');
    if (pr.mergeable_state === 'dirty') {
      result.conflict.push(entry);
    } else if (failed.length > 0) {
      result.red.push({ ...entry, failed: failed.map((c) => c.name) });
    } else if (unfinished.length > 0 || checks.length === 0) {
      result.pending.push(entry);
    } else if (checks.every((c) => GREEN_CONCLUSIONS.has(c.conclusion ?? ''))) {
      result.green.push(entry);
    } else {
      result.pending.push(entry);
    }
  }
  return result;
}

function isIgnoredBranch(name) {
  return IGNORED_BRANCHES.has(name) || IGNORED_BRANCH_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * PR との対応から、置き去りの候補になるブランチを選ぶ (日付はまだ見ない)。
 *  - no-pr:           PR が一度も作られていない
 *  - pushed-after-pr: PR はマージ (またはクローズ) 済みだが、そのあとにコミットが push されている
 * 開いている PR があるもの、マージ・クローズされた PR の head と同じコミットのもの (片付け忘れの残骸) は除く。
 *
 * @param {Array<{name:string,sha:string}>} branches
 * @param {Array<{number:number,state:string,merged_at:string|null,head:{ref:string,sha:string}}>} prs すべての状態の PR
 */
export function findBranchCandidates(branches, prs) {
  const byRef = new Map();
  for (const pr of prs) {
    const ref = pr.head?.ref;
    if (!ref) continue;
    if (!byRef.has(ref)) byRef.set(ref, []);
    byRef.get(ref).push(pr);
  }
  const candidates = [];
  for (const b of branches) {
    if (isIgnoredBranch(b.name)) continue;
    const related = byRef.get(b.name) ?? [];
    if (related.some((p) => p.state === 'open')) continue;
    if (related.some((p) => p.head.sha === b.sha)) continue;
    if (related.length === 0) {
      candidates.push({ name: b.name, sha: b.sha, reason: 'no-pr' });
    } else {
      const last = [...related].sort((a, z) => z.number - a.number)[0];
      candidates.push({ name: b.name, sha: b.sha, reason: 'pushed-after-pr', lastPr: last.number });
    }
  }
  return candidates;
}

/**
 * 候補のうち、最後のコミットから staleHours 以上たったものを残す。
 * PR が一度も無いブランチは、claude/ ブランチを除き、recentDays 以内のものだけにする
 * (昔の作業ブランチの残骸を毎日並べ続けないため)。日付が分からないものは残す (見落とさない側に倒す)。
 *
 * @param {Array<{name:string,sha:string,reason:string,committedAt?:string|null}>} candidates
 */
export function filterStaleBranches(candidates, now, { staleHours = DEFAULT_STALE_HOURS, recentDays = DEFAULT_RECENT_DAYS } = {}) {
  const stale = [];
  for (const c of candidates) {
    const hours = c.committedAt ? hoursSince(c.committedAt, now) : null;
    if (hours !== null && hours < staleHours) continue;
    if (c.reason === 'no-pr' && hours !== null && hours > recentDays * 24 && !c.name.startsWith('claude/')) continue;
    stale.push({ ...c, hours: hours === null ? null : Math.floor(hours) });
  }
  return stale.sort((a, z) => a.name.localeCompare(z.name));
}

// ───────────────────────────────────────────────────────────────────────────
// 3. Issue の文面と、作る・更新する・閉じるの判断
// ───────────────────────────────────────────────────────────────────────────

function listed(items, render) {
  const shown = items.slice(0, MAX_LISTED).map(render);
  if (items.length > MAX_LISTED) shown.push(`- ほか ${items.length - MAX_LISTED} 件 (実行ログを参照)`);
  return shown.join('\n');
}

function ageLabel(hours) {
  if (hours === null || hours === undefined) return '日時不明';
  if (hours < 48) return `${hours} 時間`;
  return `${Math.floor(hours / 24)} 日`;
}

export function renderDbIssueBody({ problems, drift, runUrl, checkedAt }) {
  return [
    DB_ISSUE_MARKER,
    '毎日の整合性チェック (`.github/workflows/daily-consistency-check.yml`) が、本番 DB とリポジトリの migration のずれを見つけました。',
    '',
    `- 確認した日時: ${checkedAt}`,
    `- 本番の台帳の最新 version: ${drift.ledgerMax ?? '(読めませんでした)'}`,
    `- 実行ログ: ${runUrl}`,
    '',
    '## 見つかったこと',
    '',
    ...problems.flatMap((p) => [`### ${p.title}`, '', p.detail, '']),
    '## 対応のしかた',
    '',
    '- 本番へ直接 DDL を当てないでください (CLAUDE.md「Supabase 本番スキーマ変更ポリシー」)。直すときも `supabase/migrations/*.sql` を追加して PR → CI → マージで反映します。',
    '- 台帳の修復が必要なときは、手動の `migration-repair.yml` / `migration-apply.yml` を使います (#1064)。',
    '- 直ったあとの次の検査で問題が無ければ、この Issue は自動で閉じます。',
  ].join('\n');
}

export function hasStaleFindings({ prs, branches }) {
  return prs.green.length + prs.red.length + prs.conflict.length + prs.pending.length + branches.length > 0;
}

export function renderStaleIssueBody({ prs, branches, runUrl, checkedAt, staleHours = DEFAULT_STALE_HOURS }) {
  const sections = [];
  const prLine = (p, extra = '') => `- #${p.number} ${p.title} (最後の動きから ${ageLabel(p.hours)})${extra}`;
  if (prs.green.length > 0) {
    sections.push('## CI が緑のまま、マージされていない PR', '', listed(prs.green, (p) => prLine(p)), '');
  }
  if (prs.red.length > 0) {
    sections.push('## CI が赤のままの PR', '', listed(prs.red, (p) => prLine(p, ` — 失敗: ${p.failed.join(', ')}`)), '');
  }
  if (prs.conflict.length > 0) {
    sections.push('## main と競合したままの PR', '', listed(prs.conflict, (p) => prLine(p)), '');
  }
  if (prs.pending.length > 0) {
    sections.push('## CI が終わらない (結果が出ていない) PR', '', listed(prs.pending, (p) => prLine(p)), '');
  }
  if (branches.length > 0) {
    const reason = (b) => (b.reason === 'no-pr' ? 'PR がありません' : `#${b.lastPr} のあとに push されたコミットが main に入っていません`);
    sections.push(
      '## main に入っていないブランチ',
      '',
      listed(branches, (b) => `- \`${b.name}\` (${b.sha.slice(0, 7)}) — ${reason(b)} (最後のコミットから ${ageLabel(b.hours)})`),
      '',
    );
  }
  return [
    STALE_ISSUE_MARKER,
    `毎日の整合性チェック (\`.github/workflows/daily-consistency-check.yml\`) が、${staleHours} 時間以上止まっている PR と、main に入っていないブランチを見つけました。`,
    'claude/ ブランチの自動マージはやめたので (#1360)、push しただけの作業は PR → CI → マージをしないと本番に出ません。',
    '',
    `- 確認した日時: ${checkedAt}`,
    `- 実行ログ: ${runUrl}`,
    '',
    ...sections,
    '## 対応のしかた',
    '',
    '- 必要な作業なら PR を作る (または CI を直す・競合を解消する) → CI が緑になったらマージします。',
    '- 不要になったブランチ・PR は閉じて (ブランチは削除して) ください。',
    '- 次の検査で該当が無くなれば、この Issue は自動で閉じます。',
  ].join('\n');
}

/**
 * 既にある Issue (同じ目印を本文に持つ、開いているもの) と、今回の結果から、することを決める。
 * @returns {'create'|'update'|'close'|'none'}
 */
export function planIssueAction({ existing, hasProblems }) {
  if (hasProblems) return existing ? 'update' : 'create';
  return existing ? 'close' : 'none';
}
