/**
 * tests/no-auto-merge-workflow.test.ts
 *
 * オーナー判断 (2026-10-08): claude/ ブランチの即マージと Dependabot の自動承認・自動マージをやめ、
 * 「CI を確認してから手動でマージ」に統一する。
 *
 * 以前の .github/workflows/auto-merge.yml は、claude/** への push で GITHUB_TOKEN を使って PR を作り、
 * その場で squash マージしていた。GITHUB_TOKEN で作った PR では CI が動かないため、
 * テストを通らないコードが main (= Vercel の本番デプロイと Supabase のデプロイ) に入り得た。
 * 同じ仕組みが戻ってこないよう、ワークフローの定義を検査する。
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOW_DIR = path.join(process.cwd(), '.github', 'workflows');

function loadWorkflows(): Array<{ file: string; text: string }> {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((file) => ({ file, text: readFileSync(path.join(WORKFLOW_DIR, file), 'utf8') }));
}

describe('自動マージの仕組みが無いこと (手動マージに統一)', () => {
  const workflows = loadWorkflows();

  it('ワークフローの定義を読み込めている', () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  it('auto-merge.yml が無い', () => {
    expect(workflows.map((w) => w.file)).not.toContain('auto-merge.yml');
  });

  it('PR をマージする・自動マージを有効にするワークフローが無い', () => {
    const offenders = workflows
      .filter(({ text }) => /gh\s+pr\s+merge\b/.test(text) || /enable-pr-auto-merge|pull-request-auto-merge/i.test(text))
      .map((w) => w.file);
    expect(offenders).toEqual([]);
  });

  it('PR を自動で承認するワークフローが無い', () => {
    const offenders = workflows
      .filter(({ text }) => /gh\s+pr\s+review\b[^\n]*--approve/.test(text))
      .map((w) => w.file);
    expect(offenders).toEqual([]);
  });

  it('claude/ ブランチへの push を起点に動くワークフローが無い', () => {
    const offenders = workflows.filter(({ text }) => /['"]?claude\/\*\*['"]?/.test(text)).map((w) => w.file);
    expect(offenders).toEqual([]);
  });
});
