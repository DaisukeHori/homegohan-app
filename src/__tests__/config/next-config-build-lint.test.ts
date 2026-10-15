import { describe, expect, it } from 'vitest';

/**
 * next.config.mjs: next build の中では ESLint を動かさない (#1444)
 *
 * lint は `npm run lint` (eslint .) を CI (ci.yml) と local-ci の unit 段で回している。Next 15 の next build は、
 * ESLint 8.57 と flat config (eslint.config.mjs) の組み合わせで設定を渡しそこね、「⨯ ESLint: Invalid Options」を出して
 * lint を飛ばす。飛ばされると分かっている検査をビルドに残さないよう、ビルドの中の lint を止めている。
 * ESLint を 9 に上げて build の lint が動くようになったら、この設定とテストを見直す。
 */
type NextConfigWithEslint = { eslint?: { ignoreDuringBuilds?: boolean } };

describe('next.config.mjs: next build の中では ESLint を動かさない (#1444)', () => {
  it('eslint.ignoreDuringBuilds が true', async () => {
    const mod = await import(/* @vite-ignore */ '../../../next.config.mjs');
    expect((mod.default as NextConfigWithEslint).eslint?.ignoreDuringBuilds).toBe(true);
  });
});
