// @vitest-environment node
/**
 * #1746 Next 16 の lint ルール @next/next/no-location-assign-relative-destination の見直し
 *
 * このルールは window.location.assign('/x') や window.location.href = '/x' (内部のページへのページごとの遷移) に警告を出す。
 * このアプリの 14 か所は、どれもページごとの遷移が要る (middleware に Cookie・ログイン・初期設定の状態を判定し直させる・
 * ログアウト後に画面の状態を捨てる・Route Handler を叩く) ので、router の遷移には直さず、その行に理由つきの
 * eslint-disable-next-line を書いた。ここでは、実際の eslint.config.mjs を読んだ ESLint で次を確かめる。
 *   - ルールは設定ごと切っていない (警告のまま効いている)
 *   - 14 か所は、ルールが警告を出したうえで、理由つきの eslint-disable-next-line で抑えられている
 *     (抑えた数がファイルごとに一致する = ルールが今も効いていて、コメントが的外れでない)
 *   - 抑えていない警告は 0 件
 */
import path from 'node:path';
import eslintPackage from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const RULE_ID = '@next/next/no-location-assign-relative-destination';

/** ESLint の重さ (数値) */
const SEVERITY_WARN = 1;

/** ESLint をファイルごとに走らせる時間の上限 (weekly/page.tsx が 4,000 行あり、既定の 5 秒では足りないことがある) */
const LINT_TIMEOUT_MS = 60_000;

/**
 * ページごとの遷移を残す場所 (ファイル → 抑えた数)。#1746 の Issue の 14 か所
 *   - MainLayout.tsx: ログアウト後に /login へ (画面の状態を捨てる)
 *   - menus/weekly/page.tsx: 献立の生成・再生成の確認の 401 で /login へ (2 か所)
 *   - settings/page.tsx: /handson-tour/replay (Route Handler) へ
 *   - MFA の 4 画面と TotpCodeForm.tsx: 401 で /login?next= へ (docs/design/cross/12-operator-mfa.md §15.2)
 *   - LegalConsentForm.tsx: 同意の送信の 401 で /login?next= へ
 *   - onboarding/resume/page.tsx: 初期設定の状態で /home・/onboarding/welcome へ (4 か所)
 */
const EXPECTED_SUPPRESSIONS: Readonly<Record<string, number>> = {
  'src/app/(main)/MainLayout.tsx': 1,
  'src/app/(main)/menus/weekly/page.tsx': 2,
  'src/app/(main)/settings/page.tsx': 1,
  'src/app/(main)/settings/security/mfa/page.tsx': 1,
  'src/app/(main)/settings/security/mfa/verify/page.tsx': 1,
  'src/app/(main)/settings/security/mfa/setup/page.tsx': 1,
  'src/app/(main)/settings/security/mfa/recover/page.tsx': 1,
  'src/components/auth/mfa/TotpCodeForm.tsx': 1,
  'src/app/legal-consent/LegalConsentForm.tsx': 1,
  'src/app/onboarding/resume/page.tsx': 4,
};

/** Issue の数 (14 か所) */
const ISSUE_LOCATION_COUNT = 14;

type Suppression = { kind: string; justification: string };
type LintMessage = { ruleId: string | null; line: number; suppressions?: Suppression[] };
type LintResult = { filePath: string; messages: LintMessage[]; suppressedMessages: LintMessage[] };
type RuleEntry = number | [number, ...unknown[]] | undefined;
type CalculatedConfig = { rules: Record<string, RuleEntry> };

const severityOf = (entry: RuleEntry): number | undefined => (Array.isArray(entry) ? entry[0] : entry);

const FILES = Object.keys(EXPECTED_SUPPRESSIONS);
const results = new Map<string, LintResult>();
const configs = new Map<string, CalculatedConfig>();

beforeAll(async () => {
  const ESLintClass = await eslintPackage.loadESLint({ useFlatConfig: true });
  const eslint = new ESLintClass({ cwd: ROOT });
  const lintResults = (await eslint.lintFiles(FILES.map((file) => path.join(ROOT, file)))) as LintResult[];
  for (const result of lintResults) results.set(path.relative(ROOT, result.filePath), result);
  for (const file of FILES) {
    configs.set(file, (await eslint.calculateConfigForFile(path.join(ROOT, file))) as CalculatedConfig);
  }
}, LINT_TIMEOUT_MS);

const resultOf = (file: string): LintResult => {
  const result = results.get(file);
  if (!result) throw new Error(`lint していない: ${file}`);
  return result;
};

describe('#1746 no-location-assign-relative-destination: ページごとの遷移は理由つきで残し、ルールは効かせたまま', () => {
  it('一覧は Issue の 14 か所', () => {
    const total = Object.values(EXPECTED_SUPPRESSIONS).reduce((sum, count) => sum + count, 0);
    expect(total).toBe(ISSUE_LOCATION_COUNT);
  });

  it.each(FILES)('%s: ルールは警告のまま効いている (設定ごと切っていない)', (file) => {
    const config = configs.get(file);
    expect(config).toBeDefined();
    expect(severityOf(config?.rules[RULE_ID])).toBe(SEVERITY_WARN);
  });

  it.each(FILES)('%s: 抑えていない警告は 0 件', (file) => {
    const unsuppressed = resultOf(file).messages.filter((message) => message.ruleId === RULE_ID);
    expect(unsuppressed.map((message) => message.line)).toEqual([]);
  });

  it.each(FILES)('%s: ルールが警告を出した場所を、理由つきの eslint-disable-next-line で抑えている', (file) => {
    const suppressed = resultOf(file).suppressedMessages.filter((message) => message.ruleId === RULE_ID);
    expect(suppressed).toHaveLength(EXPECTED_SUPPRESSIONS[file]);
    for (const message of suppressed) {
      const suppressions = message.suppressions ?? [];
      expect(suppressions.length, `${file}:${message.line}`).toBeGreaterThan(0);
      for (const suppression of suppressions) {
        expect(suppression.kind, `${file}:${message.line}`).toBe('directive');
        // 理由 (「-- 」の後ろ) が空でない
        expect(suppression.justification.trim(), `${file}:${message.line}`).not.toBe('');
      }
    }
  });
});
