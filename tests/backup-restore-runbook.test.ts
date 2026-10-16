// @vitest-environment node
/**
 * tests/backup-restore-runbook.test.ts
 *
 * #1129 / #1191 DB バックアップの手順書 docs/operations/backup-restore.md の文面の検査 (段 D)。
 * 設計 docs/design/cross/17-backup-automation.md §12 (章立て)・§15 (段 D の行)・§19 (追随の行) のとおり。
 *
 * 手順書は、実コード (scripts/lib/backup-db.mjs・src/lib/backups/core.ts・.github/workflows/db-backup.yml) の挙動の写しなので、
 * コードが変わって手順書が古くなる (名前・打ち方・順番のずれ) のを、ここで機械的に見張る。
 * 値の写しを避けるもの (R2 の Lifecycle の JSON・日数つきの lock のコマンド・接続先) は、書かれていないことを見る。
 * ソースの走査だけで、R2・age・Supabase・Docker には触れない。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_ENTRIES,
  AWS_CHECKSUM_ENV,
  FAILURE_REASONS,
  OPTIONAL_VARIABLE_NAMES,
  PSQL_SCRIPTS,
  REQUIRED_SECRET_NAMES,
  REQUIRED_VARIABLE_NAMES,
  RESTORE_REQUIRED_ENV_NAMES,
  RETENTION_DAYS,
  SUPABASE_CLI_VERSION,
  SUPABASE_PROJECT_REF,
} from '../scripts/lib/backup-db.mjs';
import {
  BACKUP_STALE_AFTER_HOURS,
  BACKUP_TIERS,
  DR_TEST_ENVIRONMENTS,
  DR_TEST_KINDS,
  SUPER_ADMIN_BACKUPS_PATH,
} from '../src/lib/backups/core';

const ROOT = path.resolve(__dirname, '..');
const RUNBOOK_PATH = 'docs/operations/backup-restore.md';

const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

/** §12 の 10 章の見出し (番号の後ろに含まれる語)。章の順番も §12 のとおり */
const CHAPTER_TITLES = [
  '全体像',
  '初回の設定',
  '日々の確認',
  '手動で取る',
  '復元 (ローカル)',
  '復元 (新しい Supabase プロジェクト)',
  '復元点より後の退会',
  '訓練の予定と記録',
  '鍵の入れ替え',
  '困ったとき',
] as const;

interface Chapter {
  number: number;
  heading: string;
  body: string;
}

/** `## <番号>. <題>` で章に分ける。コードブロックの中の行は見出しにしない */
function chaptersOf(markdown: string): Chapter[] {
  const chapters: Chapter[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    const heading = inFence ? null : /^## (\d+)\. (.+)$/.exec(line);
    if (heading) {
      chapters.push({ number: Number(heading[1]), heading: heading[2], body: '' });
    } else if (chapters.length > 0) {
      chapters[chapters.length - 1].body += `${line}\n`;
    }
  }
  return chapters;
}

const runbook = read(RUNBOOK_PATH);
const chapters = chaptersOf(runbook);

function chapter(number: number): string {
  const found = chapters.find((c) => c.number === number);
  expect(found, `手順書に ${number} 章がある`).toBeDefined();
  return found?.body ?? '';
}

/** PSQL_SCRIPTS の本文 (bash -c で打つ形) を、手順書の書き方 (exec なし・接続先は $NEW_DB_URL・ファイルは名前) に直す */
function runbookPsqlLine(script: string, files: Record<string, string>): string {
  let line = script.replace(/^exec /, '').replace('"$PG_URL"', '"$NEW_DB_URL"');
  for (const [variable, file] of Object.entries(files)) line = line.replace(`"$${variable}"`, file);
  expect(line, '置き換えが残っていない (PSQL_SCRIPTS に新しい変数が増えたら、手順書とこのテストを直す)').not.toMatch(/\$(PG_URL|PSQL_FILE|SCHEMA_FILE|DATA_FILE)/);
  return line;
}

/** secrets / variables の名前の集合 (REQUIRED_SECRET_NAMES・REQUIRED_VARIABLE_NAMES・OPTIONAL_VARIABLE_NAMES) */
const WORKFLOW_SETTING_NAMES = [...REQUIRED_SECRET_NAMES, ...REQUIRED_VARIABLE_NAMES, ...OPTIONAL_VARIABLE_NAMES].sort();

const backupNamesIn = (text: string): string[] => [...new Set(text.match(/\bBACKUP_[A-Z0-9_]+\b/g) ?? [])].sort();

describe('docs/operations/backup-restore.md の章立て (§12)', () => {
  it('10 章が、§12 の順番と題で並んでいる', () => {
    expect(chapters.map((c) => c.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    CHAPTER_TITLES.forEach((title, index) => {
      expect(chapters[index].heading, `${index + 1} 章の題`).toContain(title);
    });
  });

  it('r2-config と restore の打ち方の行がある (2 章と 5 章)', () => {
    const lines2 = chapter(2).split('\n').map((l) => l.trim());
    const lines5 = chapter(5).split('\n').map((l) => l.trim());
    expect(lines2.some((l) => l.startsWith('node scripts/backup-db.mjs r2-config --bucket ') && l.includes('--out-dir '))).toBe(true);
    expect(lines5.some((l) => l.startsWith('node scripts/backup-db.mjs restore --key ') && l.includes('--identity-file ') && l.includes('--slot '))).toBe(true);
  });
});

describe('6 章 (新しい Supabase プロジェクトへの復元) の手順と順番', () => {
  const six = chapter(6);

  it('fixups.sql・snapshot_catalog.sql・verify_baseline.py・migration repair・ledger.txt・project-ref・cron_jobs.sql の確かめがある', () => {
    for (const needle of [
      'fixups.sql',
      'snapshot_catalog.sql',
      'verify_baseline.py',
      'migration repair --status applied',
      'ledger.txt',
      'project-ref',
      'cron_jobs.sql',
    ]) {
      expect(six, `6 章に ${needle}`).toContain(needle);
    }
  });

  it('順番: --file fixups.sql が --file data.sql より後・migration repair が verify_baseline.py より後・--file cron_jobs.sql が migration repair より後', () => {
    const at = (needle: string): number => {
      const index = six.indexOf(needle);
      expect(index, `6 章に ${needle}`).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(at('--file fixups.sql')).toBeGreaterThan(at('--file data.sql'));
    expect(at('migration repair')).toBeGreaterThan(at('verify_baseline.py'));
    expect(at('--file cron_jobs.sql')).toBeGreaterThan(at('migration repair'));
    // roles → schema+data の順も (data の後に fixups。上の 1 つ目と合わせて roles → data → fixups)
    expect(at('--file roles.sql')).toBeLessThan(at('--file schema.sql'));
  });

  it('psql の打ち方が PSQL_SCRIPTS (roles・restore・reset=fixups・catalog・cron_dry_run) と同じ形', () => {
    const lines = six.split('\n').map((l) => l.trim());
    const expected = [
      runbookPsqlLine(PSQL_SCRIPTS.roles, { PSQL_FILE: 'roles.sql' }),
      runbookPsqlLine(PSQL_SCRIPTS.restore, { SCHEMA_FILE: 'schema.sql', DATA_FILE: 'data.sql' }),
      runbookPsqlLine(PSQL_SCRIPTS.reset, { PSQL_FILE: 'fixups.sql' }),
    ];
    for (const line of expected) expect(lines, line).toContain(line);
    // snapshot_catalog.sql は空のディレクトリに CSV を書くので、サブシェルの中で流す (行の頭ではなく途中に出る)
    const catalogLine = runbookPsqlLine(PSQL_SCRIPTS.catalog, { PSQL_FILE: '"$CHECKOUT/scripts/baseline/snapshot_catalog.sql"' });
    expect(lines.some((l) => l.includes(catalogLine) && l.includes('cd "$RESTORED_CATALOG"')), catalogLine).toBe(true);
  });

  it('cron_jobs.sql を流す行が 2 つある: 本番の障害 (--single-transaction) と、訓練 (PSQL_SCRIPTS.cron_dry_run の BEGIN … ROLLBACK)', () => {
    const lines = six.split('\n').map((l) => l.trim());
    const commit = 'psql "$NEW_DB_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction --file cron_jobs.sql';
    const dryRun = runbookPsqlLine(PSQL_SCRIPTS.cron_dry_run, { PSQL_FILE: 'cron_jobs.sql' });
    expect(dryRun).toBe('psql "$NEW_DB_URL" -X -q -v ON_ERROR_STOP=1 --command "BEGIN" --file cron_jobs.sql --command "ROLLBACK"');
    expect(lines).toContain(commit);
    expect(lines).toContain(dryRun);
    expect(lines.filter((l) => l.includes('--file cron_jobs.sql'))).toHaveLength(2);
  });

  it('migration から cron のジョブを流し直す手順に戻さない (tests/helpers/migration-cron-jobs.ts の語が無い)', () => {
    expect(six).not.toContain('migration-cron-jobs');
  });

  it('(1) の aws の行: env -u … で別の AWS の鍵を外し、R2 の鍵を写し、CHECKSUM の 2 つを付け、endpoint と region を付ける', () => {
    const awsLines = six.split('\n').filter((l) => l.includes('aws s3 cp'));
    expect(awsLines.length).toBeGreaterThan(0);
    const required = [
      'env -u AWS_SESSION_TOKEN -u AWS_PROFILE',
      'AWS_ACCESS_KEY_ID="$BACKUP_R2_ACCESS_KEY_ID"',
      'AWS_SECRET_ACCESS_KEY="$BACKUP_R2_SECRET_ACCESS_KEY"',
      ...Object.entries(AWS_CHECKSUM_ENV).map(([name, value]) => `${name}=${value}`),
      '--endpoint-url "https://$BACKUP_R2_ACCOUNT_ID.r2.cloudflarestorage.com"',
      '--region auto',
    ];
    const complete = awsLines.filter((l) => required.every((fragment) => l.includes(fragment)));
    expect(complete, `欠けている部分: ${JSON.stringify(awsLines.map((l) => required.filter((f) => !l.includes(f))))}`).toHaveLength(1);
    // 3 ファイル (書庫・.sha256・manifest) を取り、確かめてから復号する
    for (const suffix of ['.tar.zst.age', '.sha256', '.manifest.json']) expect(six).toContain(suffix);
    expect(six.indexOf('sha256sum -c')).toBeLessThan(six.indexOf('age -d -i'));
    expect(six).toContain('zstd -d | tar -x');
  });

  it('台帳は migration repair の CLI の版 (SUPABASE_CLI_VERSION) で戻し、migration list --linked で確かめる', () => {
    expect(six).toContain(`npx --yes supabase@${SUPABASE_CLI_VERSION} migration repair --status applied`);
    expect(six).toContain(`npx --yes supabase@${SUPABASE_CLI_VERSION} migration list --linked`);
  });

  it('本番の ref を git grep で洗う手順がある (本番の障害のときだけ)', () => {
    expect(six).toContain(`git grep ${SUPABASE_PROJECT_REF}`);
  });

  it('書庫の中身 (ARCHIVE_ENTRIES の 7 つ) を 1 章で説明している', () => {
    expect(ARCHIVE_ENTRIES).toHaveLength(7);
    const one = chapter(1);
    for (const name of ARCHIVE_ENTRIES) expect(one, `1 章に ${name}`).toContain(name);
  });
});

describe('5 章 (ローカルの復元) の前提', () => {
  it('手元のシェルに置く R2 の 4 つの名前 (RESTORE_REQUIRED_ENV_NAMES) がある', () => {
    expect(RESTORE_REQUIRED_ENV_NAMES).toHaveLength(4);
    const five = chapter(5);
    for (const name of RESTORE_REQUIRED_ENV_NAMES) expect(five, `5 章に ${name}`).toContain(name);
  });

  it('復元用は読み取り専用のトークンで、取得用の鍵は手元に写さない', () => {
    expect(chapter(5)).toContain('Object Read only');
    expect(chapter(2)).toContain('Object Read & Write');
    expect(chapter(2)).toContain('手元に写しません');
  });
});

describe('値を書かない・写さない', () => {
  it('接続先の値 (postgres:// / postgresql:// で始まる文字列) を書いていない', () => {
    expect(runbook).not.toMatch(/postgres(?:ql)?:\/\//i);
  });

  it('秘密らしい値 (age の鍵・AWS のキー・32 桁の 16 進のアカウント ID) を書いていない', () => {
    expect(runbook).not.toMatch(/age1[0-9a-z]{58}/);
    expect(runbook).not.toContain('AGE-SECRET-KEY-');
    expect(runbook).not.toMatch(/\bAKIA[0-9A-Z]{16}\b/);
    expect(runbook).not.toMatch(/\b[0-9a-f]{32}\b/);
  });

  it('R2 の Lifecycle の JSON と、日数つきの lock のコマンドを写していない (r2-config の出力が正。§4.5)', () => {
    expect(runbook).not.toContain('"deleteObjectsTransition"');
    expect(runbook).not.toContain('"storageClassTransitions"');
    expect(runbook).not.toContain('"maxAge"');
    expect(runbook).not.toMatch(/--retention-days\s+\d+/);
  });
});

describe('secrets と variables の名前 (§13)', () => {
  it('手順書の BACKUP_* の名前の集合 = REQUIRED_SECRET_NAMES + REQUIRED_VARIABLE_NAMES + OPTIONAL_VARIABLE_NAMES', () => {
    expect(backupNamesIn(runbook)).toEqual(WORKFLOW_SETTING_NAMES);
  });

  it('2 章の登録の表に、必須の secrets 2 つと variables 3 つがある', () => {
    const two = chapter(2);
    for (const name of [...REQUIRED_SECRET_NAMES, ...REQUIRED_VARIABLE_NAMES]) expect(two, `2 章に ${name}`).toContain(name);
    expect(REQUIRED_SECRET_NAMES).toHaveLength(2);
    expect(REQUIRED_VARIABLE_NAMES).toHaveLength(3);
    expect(OPTIONAL_VARIABLE_NAMES).toHaveLength(4);
  });

  it('ENV_SETUP.md の「GitHub Actions secrets」の DB バックアップの節: 名前の集合が同じ。復元用の 4 つと NEW_DB_URL の扱いがある', () => {
    const doc = read('ENV_SETUP.md');
    const start = doc.indexOf('\n## GitHub Actions secrets\n');
    expect(start, 'ENV_SETUP.md に「## GitHub Actions secrets」がある').toBeGreaterThanOrEqual(0);
    const rest = doc.slice(start + 1);
    const end = rest.search(/\n## (?!GitHub Actions secrets)/);
    const section = end === -1 ? rest : rest.slice(0, end);
    const backup = section.slice(section.indexOf('### DB バックアップ'));
    expect(backup.startsWith('### DB バックアップ'), '「### DB バックアップ」の節がある').toBe(true);
    expect(backupNamesIn(backup)).toEqual(WORKFLOW_SETTING_NAMES);
    for (const name of RESTORE_REQUIRED_ENV_NAMES) expect(backup).toContain(name);
    expect(backup).toContain('NEW_DB_URL');
    expect(backup).toContain('GitHub・Vercel には置きません');
    expect(backup).toContain('docs/operations/backup-restore.md');
    for (const name of ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA', 'RUNNER_TEMP']) {
      expect(backup, `GitHub が自動で入れる ${name}`).toContain(name);
    }
  });
});

describe('実コードとの突き合わせ', () => {
  it('1 章: 層ごとの保持の日数が RETENTION_DAYS と同じ', () => {
    const one = chapter(1);
    for (const tier of BACKUP_TIERS) {
      expect(one, `${tier} の保持`).toContain(`${RETENTION_DAYS[tier].toLocaleString('en-US')} 日`);
    }
  });

  it('3 章: 「古い」とみなす時間 (BACKUP_STALE_AFTER_HOURS) と画面のパス', () => {
    const three = chapter(3);
    expect(three).toContain(`${BACKUP_STALE_AFTER_HOURS} 時間`);
    expect(three).toContain(SUPER_ADMIN_BACKUPS_PATH);
  });

  it('4 章: workflow_dispatch の tier の選択肢 (db-backup.yml) を全部説明し、取得の実行中は auto にする', () => {
    const workflow = read('.github/workflows/db-backup.yml');
    expect(workflow).toContain('name: DB Backup');
    const four = chapter(4);
    for (const option of ['auto', 'daily', 'weekly', 'annual']) {
      expect(workflow, `workflow の tier の選択肢 ${option}`).toMatch(new RegExp(`^\\s+- ${option}$`, 'm'));
      expect(four, `4 章に tier ${option}`).toContain(`\`${option}\``);
    }
    expect(four).toContain('`tier` を `auto` にします');
    expect(four).toContain('gh workflow run db-backup.yml -f tier=auto');
  });

  it('8 章: 訓練の kind (DR_TEST_KINDS)・記録の environment・plan_not_pro・画面の名前', () => {
    const eight = chapter(8);
    for (const kind of DR_TEST_KINDS) expect(eight, `8 章に ${kind}`).toContain(kind);
    for (const environment of ['staging', 'local', 'new_project'] as const) {
      expect(DR_TEST_ENVIRONMENTS).toContain(environment);
      expect(eight, `8 章に ${environment}`).toContain(environment);
    }
    expect(eight).toContain('plan_not_pro');
    expect(eight).toContain('DR 訓練を記録');
    expect(eight).toContain(SUPER_ADMIN_BACKUPS_PATH);
    expect(read('src/app/super-admin/backups/page.tsx')).toContain('DR 訓練を記録');
  });

  it('10 章: 取り上げた reason は FAILURE_REASONS にあり、設計書 §12 の主な reason がそろっている', () => {
    const ten = chapter(10);
    const mentioned = [
      'not_configured',
      'timeout',
      'catalog_failed',
      'copy_failed',
      'restore_check_failed',
      'dump_incomplete',
      'restore_env_failed',
      'image_pull_unavailable',
      'link_failed',
      'checksum_mismatch',
      'decrypt_failed',
    ];
    for (const reason of mentioned) {
      expect(FAILURE_REASONS, `${reason} は FAILURE_REASONS にある`).toContain(reason);
      expect(ten, `10 章に ${reason}`).toContain(`\`${reason}\``);
    }
    // 手順書が backtick で挙げた reason らしい名前 (小文字と _ だけで _ を含む) は、すべて実在する
    const looksLikeReason = [...new Set(ten.match(/`([a-z]+(?:_[a-z]+)+)`/g) ?? [])]
      .map((token) => token.slice(1, -1))
      .filter((token) => /_(failed|configured|incomplete|unavailable|mismatch)$/.test(token));
    for (const token of looksLikeReason) expect(FAILURE_REASONS, `${token} は存在しない reason`).toContain(token);
  });

  it('手順書が backtick で挙げたリポジトリ内のパスは、実在する', () => {
    const paths = [...new Set([...runbook.matchAll(/`((?:scripts|docs|\.github|supabase|src)\/[A-Za-z0-9_./-]+)`/g)].map((m) => m[1]))];
    expect(paths.length, '走査が空振りしていない').toBeGreaterThan(5);
    for (const relativePath of paths) {
      expect(fs.existsSync(path.join(ROOT, relativePath)), `${relativePath} が無い`).toBe(true);
    }
  });
});

describe('§19 の追随 (段 D の行)', () => {
  it('docs/operations/ci-supabase-image-pull.md: backup-db.mjs の取得の行と、ジョブごとの扱いの DB Backup の行がある', () => {
    const doc = read('docs/operations/ci-supabase-image-pull.md');
    const rows = doc.split('\n').filter((l) => l.startsWith('|'));
    const autoRow = rows.filter((l) => l.includes('scripts/backup-db.mjs') && l.includes('scripts/supabase-image-fallback.sh'));
    expect(autoRow, '「自動でしていること」の表の行').toHaveLength(1);
    expect(autoRow[0]).toContain('supabase-local.sh start');
    expect(autoRow[0]).toContain('roundtrip-check');
    const perJob = rows.filter((l) => l.startsWith('| DB Backup ('));
    expect(perJob, '「ジョブごとの扱い」の表の行').toHaveLength(1);
    expect(perJob[0]).toContain('image_pull_unavailable');
    expect(perJob[0]).toContain('workflow_dispatch');
    expect(perJob[0]).toContain('docs/operations/backup-restore.md');
  });

  it('supabase/baseline/README.md: build_restore_fixups.py と、取得・復元の検査が同じ道具を使うことを書いている', () => {
    const doc = read('supabase/baseline/README.md');
    for (const needle of [
      'scripts/baseline/build_restore_fixups.py',
      'build_function_acl_sql',
      'build_table_acl_sql',
      'build_storage_sql',
      'snapshot_catalog.sql',
      'verify_baseline.py',
      'tests/backup-db.test.ts',
      'CATALOG_CSV_FILES',
      'roundtrip-check',
    ]) {
      expect(doc, `README に ${needle}`).toContain(needle);
    }
    expect(fs.existsSync(path.join(ROOT, 'scripts/baseline/build_restore_fixups.py'))).toBe(true);
  });
});
