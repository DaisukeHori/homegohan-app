// @vitest-environment node
/**
 * tests/security-workflow.test.ts
 *
 * 依存パッケージの脆弱性の検知とシークレットの検査 (#1156) の契約テスト。ワークフローの定義と設定ファイルを読んで、
 * 次のことが崩れていないかを調べる (GitHub には接続しない)。
 *
 *   - .github/dependabot.yml: npm と GitHub Actions を週 1 回、PR の数を絞る。メジャー更新を出さないパッケージ。
 *   - .github/workflows/security.yml: gitleaks は PR を止める (範囲は増えたコミットだけ・値をログに出さない・版を固定)。
 *     npm audit は止めない。依存関係レビューと CodeQL は、リポジトリが公開の間だけ動く。
 *   - Dependabot の PR には Actions のシークレットが渡されない。シークレットを使うジョブが Dependabot の PR で動くと、
 *     必ず失敗して依存更新の PR が赤くなるので、`github.actor != 'dependabot[bot]'` で外してあること。
 *   - .gitleaks.toml: 誤検知の除外は値を狭く指定していて、本物の service_role キーなどを隠さないこと。
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  'continue-on-error'?: boolean;
};
type Job = {
  name?: string;
  if?: string;
  'continue-on-error'?: boolean;
  permissions?: Record<string, string>;
  steps?: Step[];
};
type Workflow = {
  name?: string;
  on?: unknown;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; 'cancel-in-progress'?: unknown };
  jobs: Record<string, Job>;
};

const readText = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8');
const loadWorkflow = (file: string) => yaml.load(readFileSync(path.join(WORKFLOW_DIR, file), 'utf8')) as Workflow;
const workflowFiles = () => readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

/** on: の書き方 (文字列・配列・オブジェクト) を、トリガー名 → 設定 の形にそろえる */
function triggersOf(workflow: Workflow): Record<string, any> {
  const on = workflow.on;
  if (typeof on === 'string') return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((name) => [String(name), null]));
  return (on ?? {}) as Record<string, any>;
}

const BOT_GUARD = "github.actor != 'dependabot[bot]'";

/**
 * ジョブの中に GITHUB_TOKEN 以外のシークレットへの参照があるか。
 * secrets.XXX と secrets['XXX'] の両方の書き方と、再利用ワークフローに渡す `secrets: inherit` を見る。
 */
const usesRepositorySecrets = (job: Job & { secrets?: unknown }) =>
  job.secrets !== undefined || /\bsecrets\s*(?:\.(?!GITHUB_TOKEN\b)[A-Za-z_]|\[)/i.test(JSON.stringify(job));

/**
 * Dependabot が絶対に変えないファイルだけを起動条件にしているか。
 * (Dependabot の PR が変えるのは package.json / package-lock.json と .github/workflows/*.yml。
 *  supabase/migrations 配下だけを対象にした deploy-supabase-migrations.yml は、Dependabot の PR では起動しない)
 */
function onlyFiresForPathsDependabotNeverTouches(workflow: Workflow): boolean {
  const paths = triggersOf(workflow).pull_request?.paths;
  return Array.isArray(paths) && paths.length > 0 && paths.every((p: string) => p.startsWith('supabase/migrations/'));
}

/**
 * pull_request で起動し、シークレットを使うのに、Dependabot の PR を外していないジョブ (workflow:job) を返す。
 * ワークフロー直下 (env: など、jobs の外) でシークレットを参照しているときは、すべてのジョブが使えてしまうので、
 * すべてのジョブを対象にする。
 */
function findUnguardedSecretJobs(file: string, workflow: Workflow): string[] {
  if (!('pull_request' in triggersOf(workflow))) return [];
  if (onlyFiresForPathsDependabotNeverTouches(workflow)) return [];
  const { jobs, ...workflowLevel } = workflow;
  const sharedSecrets = usesRepositorySecrets(workflowLevel as unknown as Job);
  return Object.entries(jobs)
    .filter(([, job]) => (sharedSecrets || usesRepositorySecrets(job)) && !(job.if ?? '').includes(BOT_GUARD))
    .map(([id]) => `${file}:${id}`);
}

describe('.github/dependabot.yml', () => {
  const config = yaml.load(readText('.github/dependabot.yml')) as {
    version: number;
    updates: Array<{
      'package-ecosystem': string;
      directory: string;
      schedule: { interval: string };
      'open-pull-requests-limit'?: number;
      groups?: Record<string, { 'update-types'?: string[]; patterns?: string[] }>;
      ignore?: Array<{ 'dependency-name': string; 'update-types'?: string[]; versions?: string[] }>;
    }>;
  };
  const npm = config.updates.find((u) => u['package-ecosystem'] === 'npm')!;
  const actions = config.updates.find((u) => u['package-ecosystem'] === 'github-actions')!;

  it('version 2 で、npm と github-actions を対象にしている', () => {
    expect(config.version).toBe(2);
    expect(config.updates.map((u) => u['package-ecosystem']).sort()).toEqual(['github-actions', 'npm']);
  });

  it('npm はルート (workspaces をまとめて管理する package-lock.json) を、週 1 回見る', () => {
    expect(npm.directory).toBe('/');
    expect(npm.schedule.interval).toBe('weekly');
  });

  it('github-actions は週 1 回見る', () => {
    expect(actions.directory).toBe('/');
    expect(actions.schedule.interval).toBe('weekly');
  });

  it('同時に開く PR の数を絞っている (待ちの列を長くしない)', () => {
    for (const update of [npm, actions]) {
      expect(update['open-pull-requests-limit']).toBeTypeOf('number');
      expect(update['open-pull-requests-limit']).toBeGreaterThan(0);
      expect(update['open-pull-requests-limit']).toBeLessThanOrEqual(5);
    }
  });

  it('npm のマイナー更新とパッチ更新は 1 本の PR にまとめる (メジャー更新はまとめない)', () => {
    const groups = Object.values(npm.groups ?? {});
    const minorPatch = groups.find((g) => g['update-types']?.includes('minor') && g['update-types']?.includes('patch'));
    expect(minorPatch).toBeDefined();
    expect(minorPatch!['update-types']).not.toContain('major');
  });

  describe('メジャー更新の PR を出さない (計画して上げるもの)', () => {
    /** その依存について、メジャー更新が無視されているか (versions / update-types を付けない = すべて無視) */
    const ignoresMajor = (name: string) =>
      (npm.ignore ?? []).some(
        (rule) =>
          rule['dependency-name'] === name &&
          (!rule['update-types'] || rule['update-types'].includes('version-update:semver-major')),
      );

    it.each(['next', 'react', 'react-dom', '@types/react*', 'expo*', 'react-native*'])('%s', (name) => {
      expect(ignoresMajor(name)).toBe(true);
    });

    it('Expo / React Native は SDK ごとに版が決まるので、マイナー更新も出さない', () => {
      for (const name of ['expo*', 'react-native*', '@react-native*']) {
        const rule = (npm.ignore ?? []).find((r) => r['dependency-name'] === name);
        expect(rule?.['update-types']).toEqual(
          expect.arrayContaining(['version-update:semver-major', 'version-update:semver-minor']),
        );
      }
    });

    it('すべての依存を無視する指定 (dependency-name: "*") は無い (他の更新と脆弱性の知らせまで止めない)', () => {
      expect((npm.ignore ?? []).map((r) => r['dependency-name'])).not.toContain('*');
    });
  });
});

describe('.github/workflows/security.yml', () => {
  const workflow = loadWorkflow('security.yml');
  const triggers = triggersOf(workflow);
  const step = (jobId: string, name: string) => workflow.jobs[jobId].steps!.find((s) => s.name === name)!;

  it('PR・main への push・週 1 回の定期実行で動く', () => {
    expect(Object.keys(triggers)).toEqual(expect.arrayContaining(['pull_request', 'push', 'schedule']));
    expect(triggers.push.branches).toEqual(['main']);
    expect(triggers.schedule).toHaveLength(1);
    expect(triggers.schedule[0].cron).toMatch(/^\d+ \d+ \* \* [0-7]$/);
  });

  it('pull_request_target を使わない (PR のコードを、権限の強い文脈で動かさない)', () => {
    expect(Object.keys(triggers)).not.toContain('pull_request_target');
  });

  it('権限は読み取りだけが既定で、シークレットは使わない', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(readText('.github/workflows/security.yml')).not.toMatch(/\bsecrets\.(?!GITHUB_TOKEN\b)/);
  });

  it('4 つのジョブがある', () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(['codeql', 'dependency-review', 'gitleaks', 'npm-audit']);
  });

  it('main への連続した push の途中の実行を止めない (止めると、そのコミットが検査されずに残る)', () => {
    expect(workflow.concurrency?.group).toContain('github.sha');
    expect(String(workflow.concurrency?.['cancel-in-progress'])).toContain("github.event_name == 'pull_request'");
  });

  describe('gitleaks (止める検査)', () => {
    const job = workflow.jobs.gitleaks;
    const scan = step('gitleaks', 'Scan new commits for secrets').run!;
    const install = step('gitleaks', 'Install gitleaks (version and checksum pinned)');

    it('失敗してもワークフローを通す設定 (continue-on-error) が無い', () => {
      expect(job['continue-on-error']).toBeUndefined();
      expect(scan).not.toMatch(/\|\|\s*true\b/);
    });

    it('PR と push で動く (週次・手動では動かさない)', () => {
      expect(job.if).toContain("github.event_name == 'pull_request'");
      expect(job.if).toContain("github.event_name == 'push'");
    });

    it('比べる相手のコミットまで取る (fetch-depth: 0)。浅いと全体を検査してしまう', () => {
      const checkout = job.steps!.find((s) => s.uses?.startsWith('actions/checkout@'))!;
      expect(checkout.with?.['fetch-depth']).toBe(0);
    });

    it('見る範囲は「今回増えたコミット」だけ (過去の履歴で止めない)', () => {
      expect(scan).toContain('--log-opts=');
      expect(scan).toContain('${PR_BASE_SHA}..${PR_HEAD_SHA}');
      expect(scan).toContain('${PUSH_BEFORE_SHA}..${PUSH_AFTER_SHA}');
      // 履歴全体を見る指定にしない
      expect(scan).not.toMatch(/--no-git|--all\b/);
    });

    it('見つけた値をログに出さない (--redact)。公開リポジトリのログは誰でも読める', () => {
      expect(scan).toContain('--redact');
      expect(scan).not.toMatch(/--verbose|\s-v\s|--redact=0/);
    });

    it('「見つかった」と「検査に失敗した」を区別し、どちらも失敗にする', () => {
      expect(scan).toContain('--exit-code 2');
      expect(scan).toMatch(/exit 1/);
    });

    it('.gitleaks.toml を使う', () => {
      expect(scan).toContain('--config .gitleaks.toml');
    });

    it('gitleaks の版と SHA-256 を固定し、検証してから使う', () => {
      expect(install.env?.GITLEAKS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
      expect(install.env?.GITLEAKS_TARBALL_SHA256).toMatch(/^[0-9a-f]{64}$/);
      expect(install.run).toContain('sha256sum --check');
      // 最新版を取る指定 (latest) にしない
      expect(install.run).not.toMatch(/releases\/latest|\/latest\//);
    });
  });

  describe('npm audit (止めない参考情報)', () => {
    const job = workflow.jobs['npm-audit'];
    const auditStep = step('npm-audit', 'npm audit (production dependencies, critical)');

    // ジョブに continue-on-error を付けると、ワークフロー全体は通るが、そのジョブの check run は失敗 (赤い ×) のまま残る。
    // すると、すべての PR の Checks が赤くなり、毎日の整合性チェック (scripts/lib/consistency-check.mjs) も、
    // 止まっている PR を「赤のまま」に数える。止めない設定は、ステップに付ける (ステップなら、ジョブの check run は緑になる)
    it('ジョブには continue-on-error を付けない (check run が赤い × のまま残るため)', () => {
      expect(job['continue-on-error']).toBeUndefined();
    });

    it('npm audit のステップには continue-on-error を付ける (失敗しても、ジョブと PR を止めない)', () => {
      expect(auditStep['continue-on-error']).toBe(true);
    });

    it('continue-on-error を付けたステップは npm audit だけ (checkout などの失敗まで隠さない)', () => {
      const names = job.steps!.filter((s) => s['continue-on-error'] !== undefined).map((s) => s.name);
      expect(names).toEqual([auditStep.name]);
    });

    it('本番で動く依存だけを、critical の基準で調べる', () => {
      const run = auditStep.run!;
      expect(run).toContain('npm audit --omit=dev --audit-level=critical');
      expect(run).toContain('scripts/npm-audit-summary.mjs');
    });
  });

  describe('依存関係レビュー (公開リポジトリの間だけ)', () => {
    const job = workflow.jobs['dependency-review'];

    it('PR で、リポジトリが公開のときだけ動く (非公開では GitHub Advanced Security が無いと動かない)', () => {
      expect(job.if).toContain("github.event_name == 'pull_request'");
      expect(job.if).toContain('github.event.repository.private == false');
    });

    it('high 以上の既知の脆弱性がある版を入れる PR を止める', () => {
      const review = job.steps!.find((s) => s.uses?.startsWith('actions/dependency-review-action@'))!;
      expect(review).toBeDefined();
      expect(review.with?.['fail-on-severity']).toBe('high');
    });
  });

  describe('CodeQL (公開リポジトリの間だけ)', () => {
    const job = workflow.jobs.codeql;

    it('リポジトリが公開のときだけ動く', () => {
      expect(job.if).toContain('github.event.repository.private == false');
    });

    it('Dependabot の PR と fork からの PR では動かさない (ソースが変わらない・結果を送る権限が無い)', () => {
      expect(job.if).toContain(BOT_GUARD);
      expect(job.if).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    });

    it('JavaScript / TypeScript を調べ、結果を Security タブに送る権限だけを持つ', () => {
      const init = job.steps!.find((s) => s.uses?.startsWith('github/codeql-action/init@'))!;
      expect(init.with?.languages).toBe('javascript-typescript');
      expect(job.permissions).toEqual({ actions: 'read', contents: 'read', 'security-events': 'write' });
    });
  });
});

describe('PR の Checks を赤く残さない', () => {
  // ジョブ単位の continue-on-error は、ワークフロー全体の失敗を防ぐだけで、そのジョブの check run は失敗 (赤い ×) のまま残る。
  // すると、その PR の Checks は失敗と表示され、gh pr checks も失敗を返し、毎日の整合性チェック
  // (scripts/lib/consistency-check.mjs の classifyOpenPullRequests) は、止まっている PR を「赤のまま」に数える。
  // 失敗しても止めたくないものは、止めたくないステップに continue-on-error を付ける (ジョブの check run は緑になる)
  it('pull_request で動くワークフローのジョブに、ジョブ単位の continue-on-error を付けない (止めたくないステップに付ける)', () => {
    const offenders = workflowFiles().flatMap((file) => {
      const workflow = loadWorkflow(file);
      if (!('pull_request' in triggersOf(workflow))) return [];
      return Object.entries(workflow.jobs)
        .filter(([, job]) => job['continue-on-error'] !== undefined)
        .map(([id]) => `${file}:${id}`);
    });
    expect(offenders).toEqual([]);
  });
});

describe('Dependabot の PR ではシークレットを使うジョブを動かさない', () => {
  it('pull_request で起動するワークフローの、シークレットを使うジョブは、すべて Dependabot の PR を外している', () => {
    const offenders = workflowFiles().flatMap((file) => findUnguardedSecretJobs(file, loadWorkflow(file)));
    expect(offenders).toEqual([]);
  });

  it('e2e (本番のテストユーザーのシークレットを使う) と、本番スキーマのスナップショットは外している', () => {
    expect(String(loadWorkflow('e2e.yml').jobs.test.if)).toContain(BOT_GUARD);
    expect(String(loadWorkflow('prod-schema-snapshot.yml').jobs.snapshot.if)).toContain(BOT_GUARD);
  });

  it('prod-schema-snapshot は、fork からの PR を外す元の条件も残している', () => {
    expect(String(loadWorkflow('prod-schema-snapshot.yml').jobs.snapshot.if)).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
  });

  it('migration の deploy は supabase/migrations 配下だけで起動する (Dependabot の PR では起動しない)', () => {
    const workflow = loadWorkflow('deploy-supabase-migrations.yml');
    expect(triggersOf(workflow).pull_request.paths).toEqual(['supabase/migrations/**']);
    expect(onlyFiresForPathsDependabotNeverTouches(workflow)).toBe(true);
  });

  it('この検査自体が働く: 外していないジョブは見つかり、外したジョブと GITHUB_TOKEN だけのジョブは見つからない', () => {
    const unguarded = yaml.load(`
on:
  pull_request:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "$TOKEN"
        env:
          TOKEN: \${{ secrets.SOME_PRODUCTION_TOKEN }}
`) as Workflow;
    expect(findUnguardedSecretJobs('sample.yml', unguarded)).toEqual(['sample.yml:deploy']);

    const guarded = structuredClone(unguarded);
    guarded.jobs.deploy.if = `${BOT_GUARD} && github.event_name == 'pull_request'`;
    expect(findUnguardedSecretJobs('sample.yml', guarded)).toEqual([]);

    const tokenOnly = yaml.load(`
on:
  pull_request:
jobs:
  comment:
    runs-on: ubuntu-latest
    steps:
      - run: gh pr comment
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`) as Workflow;
    expect(findUnguardedSecretJobs('sample.yml', tokenOnly)).toEqual([]);

    // secrets['NAME'] の書き方と、再利用ワークフローへの secrets: inherit も見落とさない
    const bracket = yaml.load(`
on:
  pull_request:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "$TOKEN"
        env:
          TOKEN: \${{ secrets['SOME_PRODUCTION_TOKEN'] }}
`) as Workflow;
    expect(findUnguardedSecretJobs('sample.yml', bracket)).toEqual(['sample.yml:deploy']);

    const inherit = yaml.load(`
on:
  pull_request:
jobs:
  call:
    uses: ./.github/workflows/reusable.yml
    secrets: inherit
`) as Workflow;
    expect(findUnguardedSecretJobs('sample.yml', inherit)).toEqual(['sample.yml:call']);

    const pushOnly = yaml.load(`
on:
  push:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "$TOKEN"
        env:
          TOKEN: \${{ secrets.SOME_PRODUCTION_TOKEN }}
`) as Workflow;
    expect(findUnguardedSecretJobs('sample.yml', pushOnly)).toEqual([]);

    // ワークフロー直下 (jobs の外) の env: でシークレットを参照していると、すべてのジョブが使える。
    // シークレットをジョブの中で書いていなくても、外していないジョブは見つかる
    const workflowEnv = yaml.load(`
on:
  pull_request:
env:
  TOKEN: \${{ secrets.SOME_PRODUCTION_TOKEN }}
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
  deploy:
    if: github.actor != 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`) as Workflow;
    expect(findUnguardedSecretJobs('sample.yml', workflowEnv)).toEqual(['sample.yml:lint']);

    // ワークフロー直下で GITHUB_TOKEN だけを使うのは問題ない
    const workflowEnvTokenOnly = yaml.load(`
on:
  pull_request:
env:
  GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
`) as Workflow;
    expect(findUnguardedSecretJobs('sample.yml', workflowEnvTokenOnly)).toEqual([]);
  });
});

describe('.gitleaks.toml (誤検知の除外は、値を狭く指定する)', () => {
  const text = readText('.gitleaks.toml');
  // コメント行を除いた本文
  const body = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  /** TOML のリテラル文字列 '''...''' を、正規表現として取り出す */
  const regexes = [...body.matchAll(/'''(.*?)'''/g)].map((m) => new RegExp(m[1]));

  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const claims = (role: string, ref = 'flmeolcfutuwwbjmzyoz') => ({ iss: 'supabase', ref, role, iat: 1763970186, exp: 2079546186 });
  // 署名の部分は作り物 (本物のキーではない)
  const token = (role: string, ref?: string) => `${header}.${b64(claims(role, ref))}.${'x'.repeat(43)}`;
  const allowed = (value: string) => regexes.some((re) => re.test(value));

  it('gitleaks の既定のルールを使ったうえで、除外を足している', () => {
    expect(body).toMatch(/\[extend\][^[]*useDefault\s*=\s*true/);
    expect(body).toContain('[[allowlists]]');
  });

  it('ファイルやディレクトリ単位では除外しない (paths を使わない)', () => {
    expect(body).not.toMatch(/^\s*paths\s*=/m);
  });

  it('このプロジェクトの anon key (公開用) は除外する', () => {
    expect(allowed(token('anon'))).toBe(true);
  });

  it('service_role のキーと、別のプロジェクトのキーは除外しない', () => {
    expect(allowed(token('service_role'))).toBe(false);
    expect(allowed(token('authenticated'))).toBe(false);
    expect(allowed(token('anon', 'zzzzzzzzzzzzzzzzzzzz'))).toBe(false);
  });

  it.each([
    'abcdef0123456789',
    'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    'abc123def456',
    'WrongPass2026x',
    'it-1306-cron-secret',
    '5-1-analyzing-or-result',
    'vitamin_b12_ug',
    'dummy-api-key-for-test-0123456789',
    'v1.MR5OBK2qk3lA9wxkmjm0YRkd0tg9FdcYT5CqvW9_pw9nE0j',
    '3f9a1c0be77d4c2a9b1e5d6f7a8b9c0d',
  ])('確かめたダミーの値は除外する: %s', (value) => {
    expect(allowed(value)).toBe(true);
  });

  it.each([
    'abcdef0123456789abcdef012345678X',
    'abc123def4567',
    'WrongPass2026xy',
    'x-it-1306-cron-secret',
    'vitamin_b12_ug_extra',
    'dummy-api-key-for-test-01234567890',
    'Zq8mR2vL5nT7xK1dF4hJ9bW3',
    // 点 (.) を任意の 1 文字として扱っていないこと・前後に足した値を通さないこと
    'v1xMR5OBK2qk3lA9wxkmjm0YRkd0tg9FdcYT5CqvW9_pw9nE0j',
    'v1.MR5OBK2qk3lA9wxkmjm0YRkd0tg9FdcYT5CqvW9_pw9nE0jX',
    '3f9a1c0be77d4c2a9b1e5d6f7a8b9c0d1e2f3a4b5c6d4e7f8a9b0c1d2e3f4a5b',
  ])('少しでも違う値や、ランダムに見える値は除外しない: %s', (value) => {
    expect(allowed(value)).toBe(false);
  });
});
