// @vitest-environment node
/**
 * #1621 Next 16 (eslint-config-next 16・ESLint 9) に上げたあとの eslint.config.mjs の検査の範囲
 *
 * eslint-config-next 16 は eslint-plugin-react-hooks 7 を入れ、その recommended には React Compiler 向けのルールが増えた。
 * このアプリは React Compiler を使っていないので、Next 15 のときと同じ範囲 (rules-of-hooks と exhaustive-deps) に保つ。
 * また ESLint 9 は使われていない eslint-disable のコメントを既定で警告するが、ESLint 8 と同じく報告しない。
 * ここでは、実際の eslint.config.mjs を読んだ ESLint が、ファイルごとに計算した設定を確かめる。
 *   - rules-of-hooks はエラー、exhaustive-deps は警告のまま (Web。apps/mobile は exhaustive-deps を切ってある)
 *   - React Compiler 向けのルールは切ってある。切る一覧は、eslint-plugin-react-hooks の recommended から
 *     rules-of-hooks と exhaustive-deps を除いたものとちょうど同じ (版を上げて増えたら、ここで気づく)
 *   - Next の core-web-vitals のルール (no-html-link-for-pages・no-sync-scripts) はエラーのまま効いている
 *   - 使われていない eslint-disable のコメントは報告しない
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import eslintPackage from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';
import { REACT_COMPILER_RULES_OFF } from '../eslint.config.mjs';

const ROOT = path.resolve(__dirname, '..');

/**
 * eslint-config-next が使う eslint-plugin-react-hooks (ルートの package.json には直接は無い。eslint-config-next から解決する)
 */
type ReactHooksPlugin = { configs: { recommended: { rules?: Record<string, unknown> } } };
const requireFromEslintConfigNext = createRequire(createRequire(import.meta.url).resolve('eslint-config-next'));
const reactHooksPlugin: ReactHooksPlugin = requireFromEslintConfigNext('eslint-plugin-react-hooks');

/** ESLint の重さ (数値) */
const SEVERITY_OFF = 0;
const SEVERITY_WARN = 1;
const SEVERITY_ERROR = 2;

/** 今までどおり効かせる react-hooks のルール */
const KEPT_REACT_HOOKS_RULES = ['react-hooks/rules-of-hooks', 'react-hooks/exhaustive-deps'];

/** 設定を確かめる Web のファイル (App Router のページと、設定の .mjs) */
const WEB_FILES = ['src/app/page.tsx', 'next.config.mjs'];
const MOBILE_FILE = 'apps/mobile/app/_layout.tsx';

type RuleEntry = number | [number, ...unknown[]] | undefined;
type CalculatedConfig = {
  rules: Record<string, RuleEntry>;
  linterOptions?: { reportUnusedDisableDirectives?: number | string | boolean };
};

const severityOf = (entry: RuleEntry): number | undefined => (Array.isArray(entry) ? entry[0] : entry);

const configs = new Map<string, CalculatedConfig>();

beforeAll(async () => {
  const ESLintClass = await eslintPackage.loadESLint({ useFlatConfig: true });
  const eslint = new ESLintClass({ cwd: ROOT });
  for (const file of [...WEB_FILES, MOBILE_FILE]) {
    configs.set(file, (await eslint.calculateConfigForFile(path.join(ROOT, file))) as CalculatedConfig);
  }
});

const configOf = (file: string): CalculatedConfig => {
  const config = configs.get(file);
  if (!config) throw new Error(`設定を計算していない: ${file}`);
  return config;
};

describe('#1621 eslint.config.mjs: React Compiler 向けのルールは切り、Next 15 のときの範囲を保つ', () => {
  it('切る一覧は、eslint-plugin-react-hooks の recommended から rules-of-hooks と exhaustive-deps を除いたものと同じ', () => {
    const recommended = Object.keys(reactHooksPlugin.configs.recommended.rules ?? {});
    for (const rule of KEPT_REACT_HOOKS_RULES) expect(recommended).toContain(rule);
    const compilerRules = recommended.filter((rule) => !KEPT_REACT_HOOKS_RULES.includes(rule));
    expect([...REACT_COMPILER_RULES_OFF].sort()).toEqual([...compilerRules].sort());
    expect(REACT_COMPILER_RULES_OFF.length).toBeGreaterThan(0);
  });

  it.each(WEB_FILES)('%s: rules-of-hooks はエラー・exhaustive-deps は警告・React Compiler 向けのルールは切ってある', (file) => {
    const { rules } = configOf(file);
    expect(severityOf(rules['react-hooks/rules-of-hooks'])).toBe(SEVERITY_ERROR);
    expect(severityOf(rules['react-hooks/exhaustive-deps'])).toBe(SEVERITY_WARN);
    for (const rule of REACT_COMPILER_RULES_OFF) expect(severityOf(rules[rule]), rule).toBe(SEVERITY_OFF);
  });

  it(`${MOBILE_FILE}: React Compiler 向けのルールは切ってあり、rules-of-hooks はエラー (exhaustive-deps は前から切ってある)`, () => {
    const { rules } = configOf(MOBILE_FILE);
    expect(severityOf(rules['react-hooks/rules-of-hooks'])).toBe(SEVERITY_ERROR);
    expect(severityOf(rules['react-hooks/exhaustive-deps'])).toBe(SEVERITY_OFF);
    for (const rule of REACT_COMPILER_RULES_OFF) expect(severityOf(rules[rule]), rule).toBe(SEVERITY_OFF);
  });

  it.each(WEB_FILES)('%s: Next の core-web-vitals のルールはエラーのまま効いている', (file) => {
    const { rules } = configOf(file);
    expect(severityOf(rules['@next/next/no-html-link-for-pages'])).toBe(SEVERITY_ERROR);
    expect(severityOf(rules['@next/next/no-sync-scripts'])).toBe(SEVERITY_ERROR);
  });

  it.each([...WEB_FILES, MOBILE_FILE])('%s: 使われていない eslint-disable のコメントは報告しない (ESLint 8 と同じ)', (file) => {
    expect(configOf(file).linterOptions?.reportUnusedDisableDirectives).toBe(SEVERITY_OFF);
  });
});
