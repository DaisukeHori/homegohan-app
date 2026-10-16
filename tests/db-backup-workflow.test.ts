// @vitest-environment node
/**
 * tests/db-backup-workflow.test.ts
 *
 * #1129 / #1191 .github/workflows/db-backup.yml の契約 (設計 docs/design/cross/17-backup-automation.md §4.11・§15)。
 * YAML を読むだけ (GitHub Actions も本番も動かさない)。値は scripts/lib/backup-db.mjs の定数と突き合わせる。
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import {
  BACKUP_CONCURRENCY_GROUP,
  BACKUP_SCHEDULE_CRON_UTC,
  BACKUP_TIERS,
  JOB_TIMEOUT_MINUTES,
  OPTIONAL_VARIABLE_NAMES,
  REQUIRED_SECRET_NAMES,
  REQUIRED_VARIABLE_NAMES,
  ROUNDTRIP_CONCURRENCY_GROUP,
  ROUNDTRIP_JOB_TIMEOUT_MINUTES,
  RUN_REPORT_FILE_NAME,
  RUN_STEP_TIMEOUT_MINUTES,
  SUPABASE_CLI_VERSION,
} from '../scripts/lib/backup-db.mjs';

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, '.github/workflows/db-backup.yml');
const TEXT = fs.readFileSync(FILE, 'utf8');

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  'timeout-minutes'?: number;
}
interface Job {
  if?: string;
  'runs-on'?: string;
  'timeout-minutes'?: number;
  'continue-on-error'?: unknown;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: unknown;
  env?: Record<string, unknown>;
  jobs: Record<string, Job>;
}

// js-yaml は `on:` を文字列のキー 'on' として読む (YAML 1.2 の core schema)
const workflow = yaml.load(TEXT) as Workflow;
const backup = workflow.jobs.backup;
const roundtrip = workflow.jobs['roundtrip-check'];
const stepNamed = (job: Job, name: string) => {
  const step = job.steps.find((s) => s.name === name);
  if (!step) throw new Error(`step ${name} が無い`);
  return step;
};
const BOT_GUARD = "github.actor != 'dependabot[bot]'";

describe('db-backup.yml の起動条件と権限', () => {
  it('schedule が BACKUP_SCHEDULE_CRON_UTC・workflow_dispatch の tier が auto + BACKUP_TIERS', () => {
    const on = workflow.on as {
      schedule: Array<{ cron: string }>;
      workflow_dispatch: { inputs: { tier: { options: string[]; default: string } } };
    };
    expect(on.schedule).toEqual([{ cron: BACKUP_SCHEDULE_CRON_UTC }]);
    expect(on.workflow_dispatch.inputs.tier.options).toEqual(['auto', ...BACKUP_TIERS]);
    expect(on.workflow_dispatch.inputs.tier.default).toBe('auto');
  });

  it('on は schedule・workflow_dispatch・pull_request の 3 つで、PR の paths は 4 つ', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'schedule', 'workflow_dispatch']);
    expect((workflow.on.pull_request as { paths: string[] }).paths).toEqual([
      'scripts/backup-db.mjs', 'scripts/lib/backup-db.mjs', 'scripts/supabase-local.sh', '.github/workflows/db-backup.yml',
    ]);
  });

  it('permissions が contents: read・issues: write だけ', () => {
    expect(workflow.permissions).toEqual({ contents: 'read', issues: 'write' });
  });

  it('ワークフロー直下に concurrency が無い・backup と roundtrip-check の group が別', () => {
    expect(workflow.concurrency).toBeUndefined();
    expect(backup.concurrency).toEqual({ group: BACKUP_CONCURRENCY_GROUP, 'cancel-in-progress': false });
    expect(roundtrip.concurrency).toEqual({ group: ROUNDTRIP_CONCURRENCY_GROUP, 'cancel-in-progress': true });
    expect(ROUNDTRIP_CONCURRENCY_GROUP).toContain('${{ github.ref }}');
    expect(ROUNDTRIP_CONCURRENCY_GROUP).not.toBe(BACKUP_CONCURRENCY_GROUP);
  });

  it('backup job の if が PR でない・main・Dependabot でないの 3 つを含む', () => {
    for (const part of ["github.event_name != 'pull_request'", "github.ref == 'refs/heads/main'", BOT_GUARD]) expect(backup.if).toContain(part);
  });

  it('roundtrip-check は schedule を外し、secrets を参照しない', () => {
    expect(roundtrip.if).toBe("github.event_name != 'schedule'");
    expect(JSON.stringify(roundtrip)).not.toContain('secrets.');
  });
});

describe('db-backup.yml の job と step', () => {
  it('backup の timeout-minutes が JOB_TIMEOUT_MINUTES・step の並びが §4.11 のとおり', () => {
    expect(backup['timeout-minutes']).toBe(JOB_TIMEOUT_MINUTES);
    expect(backup.steps.map((s) => s.name)).toEqual([
      'Checkout repository', 'Setup Node.js', 'Install age and check tools', 'Run backup', 'Stop local Supabase', 'Report (Issue)',
    ]);
  });

  it('age を apt で入れ、同じ step で age・psql・python3 の版を打つ', () => {
    const run = stepNamed(backup, 'Install age and check tools').run ?? '';
    expect(run).toContain('apt-get install -y age');
    for (const cmd of ['age --version', 'psql --version', 'python3 --version']) expect(run).toContain(cmd);
  });

  it('Run backup: id run・timeout RUN_STEP_TIMEOUT_MINUTES・--result-file・入力を run の文字列に埋めない', () => {
    const step = stepNamed(backup, 'Run backup');
    expect(step.id).toBe('run');
    expect(step['timeout-minutes']).toBe(RUN_STEP_TIMEOUT_MINUTES);
    expect(step.run).toContain(`--result-file "$RUNNER_TEMP/${RUN_REPORT_FILE_NAME}"`);
    expect(step.run).toContain('run --tier "$TIER_INPUT"');
    expect(step.run).not.toContain('${{ inputs.');
    expect(step.env?.TIER_INPUT).toContain('inputs.tier');
  });

  it('Report (Issue): always・report-issue・同じ --result-file・outcome と URL と GH_TOKEN', () => {
    const step = stepNamed(backup, 'Report (Issue)');
    expect(step.if).toBe('always()');
    expect(step.run).toContain('report-issue');
    expect(step.run).toContain(`--result-file "$RUNNER_TEMP/${RUN_REPORT_FILE_NAME}"`);
    expect(step.run).toContain('--run-outcome "$RUN_OUTCOME"');
    expect(step.run).toContain('--run-url "$RUN_URL"');
    expect(step.env?.RUN_OUTCOME).toBe('${{ steps.run.outcome }}');
    expect(step.env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(backup.steps.indexOf(step)).toBeGreaterThan(backup.steps.findIndex((s) => s.name === 'Run backup'));
  });

  it('Stop local Supabase が if: always() (2 つの job とも)', () => {
    expect(stepNamed(backup, 'Stop local Supabase').if).toBe('always()');
    expect(stepNamed(roundtrip, 'Stop local Supabase').if).toBe('always()');
  });

  it('roundtrip-check: timeout が ROUNDTRIP_JOB_TIMEOUT_MINUTES・step の並び・roundtrip-local', () => {
    expect(roundtrip['timeout-minutes']).toBe(ROUNDTRIP_JOB_TIMEOUT_MINUTES);
    expect(roundtrip.steps.map((s) => s.name)).toEqual(['Checkout repository', 'Setup Node.js', 'Roundtrip (local)', 'Stop local Supabase']);
    expect(stepNamed(roundtrip, 'Roundtrip (local)').run).toContain('roundtrip-local');
  });

  it('job 単位の continue-on-error が無い', () => {
    for (const job of Object.values(workflow.jobs)) expect(job['continue-on-error']).toBeUndefined();
  });
});

describe('db-backup.yml の秘密と本番への書き込み', () => {
  it('secrets の名前が REQUIRED_SECRET_NAMES + SUPABASE_ACCESS_TOKEN・SUPABASE_DB_PASSWORD (+ GITHUB_TOKEN) だけ', () => {
    const secrets = new Set([...TEXT.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]));
    const allowed = new Set([...REQUIRED_SECRET_NAMES, 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'GITHUB_TOKEN']);
    for (const name of secrets) expect(allowed.has(name), name).toBe(true);
    for (const name of [...REQUIRED_SECRET_NAMES, 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD']) expect(secrets.has(name), name).toBe(true);
  });

  it('variables の名前が REQUIRED_VARIABLE_NAMES + OPTIONAL_VARIABLE_NAMES だけ', () => {
    const vars = new Set([...TEXT.matchAll(/vars\.([A-Z0-9_]+)/g)].map((m) => m[1]));
    expect(vars).toEqual(new Set([...REQUIRED_VARIABLE_NAMES, ...OPTIONAL_VARIABLE_NAMES]));
  });

  it('ワークフロー直下 (jobs の外) で secrets を参照しない', () => {
    expect(JSON.stringify({ ...workflow, jobs: undefined })).not.toContain('secrets.');
  });

  it('本番へ書くコマンド (db push・migration repair・db reset・apply_migration) を含まない・supabase@ の版が SUPABASE_CLI_VERSION', () => {
    for (const word of ['db push', 'migration repair', 'db reset', 'apply_migration']) expect(TEXT).not.toContain(word);
    for (const m of TEXT.matchAll(/supabase@([0-9.]+)/g)) expect(m[1]).toBe(SUPABASE_CLI_VERSION);
  });
});
