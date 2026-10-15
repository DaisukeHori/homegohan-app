import { describe, expect, it } from 'vitest';

/**
 * next.config.mjs: `eslint` の項目を書かない (#1444・#1621)
 *
 * lint は `npm run lint` (eslint .) を CI (ci.yml) と local-ci の unit 段で回している。
 * Next 15 では、next build の中の ESLint が ESLint 8.57 と flat config の組み合わせで設定を渡しそこねて lint を飛ばしたので、
 * `eslint.ignoreDuringBuilds: true` でビルドの中の lint を止めていた (#1444)。
 * Next 16 で next build は ESLint を動かさなくなり、設定の `eslint` の項目そのものが無くなった (#1621)。
 * 残すと next の設定の検査が「知らない項目」として警告するので、戻していないことをここで確かめる。
 */
describe('next.config.mjs: Next 16 で無くなった eslint の項目を書かない (#1621)', () => {
  it('eslint の項目が無い', async () => {
    const mod = await import(/* @vite-ignore */ '../../../next.config.mjs');
    expect(Object.keys(mod.default)).not.toContain('eslint');
    // 項目を読めていること (空のオブジェクトで素通りしていない)
    expect(Object.keys(mod.default)).toContain('images');
  });
});
