/**
 * #1540 (#1524 の整合ゲートの残り) の回帰テスト。
 *
 * プロバイダー別の LLM 使用量の画面 (src/app/super-admin/llm/[provider]/page.tsx) は、応答の by_model の 1 行の型
 * (ModelStats) を手で書き写していた (その時点では一致)。いまは route が返す型 (LlmUsageResponseData) から導くので、
 * 応答の形が変われば画面の型も一緒に変わり、合わなくなった読み方は型検査 (npm run typecheck) で止まる。
 * ここでは「手書きの型に戻っていないこと」をコードの文で見張る (型の一致そのものは tsc が担保する)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const page = readFileSync(resolve(ROOT, 'src/app/super-admin/llm/[provider]/page.tsx'), 'utf8');
/** コメントを除いた画面のコード (説明のコメントに以前の型の語が残っても拾わないため) */
const pageCode = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('プロバイダー別の LLM 使用量の画面の型は、route の応答の型から導く (#1540)', () => {
  it('LlmUsageResponseData を import し、ModelStats をその by_model の要素の型にする', () => {
    expect(pageCode).toMatch(/import type \{ LlmUsageResponseData \} from "@\/lib\/super-admin\/llm-usage-summary"/);
    expect(pageCode).toMatch(/type ModelStats = LlmUsageResponseData\["by_model"\]\[number\];/);
  });

  it('応答の項目を手で書き写した型 (interface ModelStats・型の本体に cost_usd: number) を書かない', () => {
    expect(pageCode).not.toMatch(/interface ModelStats\b/);
    expect(pageCode).not.toMatch(/cost_usd\s*:\s*number/);
  });

  it('取得した応答の data に LlmUsageResponseData の注釈を付ける (by_model の読み方を型検査に掛ける)', () => {
    expect(pageCode).toContain('const { data }: { data: LlmUsageResponseData } = await res.json();');
  });
});
