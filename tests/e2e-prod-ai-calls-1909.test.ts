/**
 * PR のたびの本番向けの e2e (.github/workflows/e2e.yml) が、本番の AI を呼ばないこと (#1909 の後片付け)
 *
 * 本番の AI 相談のセッションに、利用者の発言として「こんにちは」が約 195 件たまっていた (10/07 から)。
 * 送り手は e2e.yml の PR の実行で、MVP スイートの 03-ai-advisor.spec.ts が毎回本番の AI 相談へ「こんにちは」を送っていた
 * (10/07 の #1265 で本番向けのジョブがログインまで通るようになってから)。
 * AI を呼ぶ手順は E2E_ALLOW_AI_CALLS=1 のときだけ流し、e2e.yml は手動の実行のときだけ 1 にする。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { E2E_ALLOW_AI_CALLS_ENV, isAiCallAllowed } from './e2e/helpers/ai-calls';

const ROOT = path.resolve(__dirname, '..');

type Step = { name?: string; run?: string; env?: Record<string, unknown> };
type Workflow = { on: Record<string, unknown>; jobs: Record<string, { steps: Step[] }> };

function loadE2eWorkflow(): Workflow {
  return yaml.load(readFileSync(path.join(ROOT, '.github/workflows/e2e.yml'), 'utf8')) as Workflow;
}

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

/** GitHub Actions の `${{ github.event_name == 'workflow_dispatch' && '1' || '' }}` を、イベント名ごとに評価する (この形だけを扱う) */
function evaluateDispatchOnly(expression: string, eventName: string): string {
  const match = /^\$\{\{\s*github\.event_name == '([a-z_]+)' && '([^']*)' \|\| '([^']*)'\s*\}\}$/.exec(expression);
  if (!match) throw new Error(`想定していない式: ${expression}`);
  const [, event, whenTrue, whenFalse] = match;
  return eventName === event ? whenTrue : whenFalse;
}

describe('isAiCallAllowed', () => {
  it.each([
    [{ [E2E_ALLOW_AI_CALLS_ENV]: '1' }, true],
    [{}, false],
    [{ [E2E_ALLOW_AI_CALLS_ENV]: '' }, false],
    [{ [E2E_ALLOW_AI_CALLS_ENV]: '0' }, false],
    [{ [E2E_ALLOW_AI_CALLS_ENV]: 'true' }, false],
    [{ [E2E_ALLOW_AI_CALLS_ENV]: ' 1' }, false],
  ])('%o → %s', (env, expected) => {
    expect(isAiCallAllowed(env)).toBe(expected);
  });
});

describe('e2e.yml: 本番向けの Playwright は、PR の実行で AI を呼ばない', () => {
  const workflow = loadE2eWorkflow();
  const playwrightSteps = workflow.jobs.test.steps.filter((step) => (step.run ?? '').includes('playwright test') || (step.run ?? '').includes('test:e2e'));

  it('Playwright を流す手順は 1 つで、E2E_ALLOW_AI_CALLS を渡している', () => {
    expect(playwrightSteps).toHaveLength(1);
    expect(playwrightSteps[0].env).toHaveProperty(E2E_ALLOW_AI_CALLS_ENV);
  });

  it('E2E_ALLOW_AI_CALLS は手動の実行 (workflow_dispatch) でだけ 1、PR の実行では空', () => {
    const expression = String(playwrightSteps[0].env?.[E2E_ALLOW_AI_CALLS_ENV]);
    expect(evaluateDispatchOnly(expression, 'pull_request')).toBe('');
    expect(isAiCallAllowed({ [E2E_ALLOW_AI_CALLS_ENV]: evaluateDispatchOnly(expression, 'pull_request') })).toBe(false);
    expect(evaluateDispatchOnly(expression, 'workflow_dispatch')).toBe('1');
  });

  it('e2e.yml は定期の実行 (schedule) を持たない (持たせるなら AI を呼ばないことを先に確かめる)', () => {
    expect(Object.keys(workflow.on)).not.toContain('schedule');
  });
});

describe('MVP スイートの spec は、AI を呼ぶ手順の前に isAiCallAllowed で止める', () => {
  it('03-ai-advisor: 送信ボタンを押す前に isAiCallAllowed を見て、許されていなければ押さずに終わる', () => {
    const source = read('tests/e2e/03-ai-advisor.spec.ts');
    const guard = source.indexOf('if (!isAiCallAllowed())');
    const click = source.indexOf('await submitBtn.click()');
    expect(guard).toBeGreaterThan(-1);
    expect(click).toBeGreaterThan(guard);
    // 止める枝の中に return がある (押さない)
    expect(source.slice(guard, click)).toMatch(/return;/);
    // 送信ボタンを押すのは 1 か所だけ
    expect(source.split('submitBtn.click()')).toHaveLength(2);
  });

  it('02-meal-photo: 写真を選ぶ・解析ボタンを押す前に isAiCallAllowed を見て skip する', () => {
    const source = read('tests/e2e/02-meal-photo.spec.ts');
    const guard = source.indexOf('if (!isAiCallAllowed())');
    expect(guard).toBeGreaterThan(-1);
    expect(source.indexOf('setInputFiles')).toBeGreaterThan(guard);
    expect(source.indexOf('analyzeBtn.click()')).toBeGreaterThan(guard);
    expect(source.slice(guard, source.indexOf('setInputFiles'))).toMatch(/test\.skip\(true, AI_CALLS_DISABLED_REASON\)/);
  });
});
