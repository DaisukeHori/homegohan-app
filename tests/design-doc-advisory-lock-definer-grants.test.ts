// @vitest-environment node
/**
 * 設計書の SQL の例の SECURITY DEFINER の関数 (advisory lock を仕事と同じ関数の中で取る形) が、
 * 実行できる役割を service_role に絞っていることの contract テスト (ソース走査)
 *
 * #2025 の docs (advisory lock を「仕事をする関数の中で取る」にそろえる) で、org/04 §6.2 の bulk-revoke を
 * TS の 2 回の書き込みから SQL の関数 `org_bulk_revoke_assignments` に替え、cross/02 §6.3 の例を
 * `example_locked_operation` にした。最初の形はどちらも REVOKE / GRANT が無く、操作者 `p_actor_id` を引数で受け取っていた。
 * Supabase の既定の権限では新しい関数を anon / authenticated も EXECUTE できる
 * (supabase/migrations/20251126124224_create_meal_planner_tables.sql の ALTER DEFAULT PRIVILEGES)。
 * 例のとおりに作ると、ログインしただけの利用者が任意の組織のライセンスを一括で取り消せ、監査の操作者も偽れた。
 * 実コードの service_role だけの関数 (20261016210000_billing_core.sql の billing_apply_stripe_subscription など) と同じく、
 * 関数のあとに `REVOKE ALL … FROM PUBLIC, anon, authenticated` と `GRANT EXECUTE … TO service_role` を置く。
 *
 * 文書の側の確かめは、対象の関数の定義が SQL の例にあるときに効く (設計書の変更が入る前の文書には定義が無い)。
 * 判定の関数そのものは、下の「判定の関数」の it で、権限の行が欠けた・違う例を赤にすることを確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

const CROSS02 = 'docs/design/cross/02-rls-patterns.md';
const ORG04 = 'docs/design/org/04-license-management.md';

/** 対象: 文書と、その文書の SQL の例が定義する service_role だけの関数 */
const TARGETS: ReadonlyArray<{ file: string; functionName: string }> = [
  { file: CROSS02, functionName: 'example_locked_operation' },
  { file: ORG04, functionName: 'org_bulk_revoke_assignments' },
];

/** Markdown の ```sql の囲みの中身 */
function sqlFences(markdown: string): string[] {
  return [...markdown.matchAll(/```sql\n([\s\S]*?)```/g)].map(([, body]) => body);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 引数の並び (名前つき or 型だけ) を、型だけの並びにそろえる (大文字・空白の正規化) */
function argTypes(list: string, withNames: boolean): string[] {
  const parts = list
    .split(',')
    .map((part) => part.trim().replace(/\s+/g, ' '))
    .filter((part) => part.length > 0);
  return parts.map((part) => (withNames ? part.split(' ').slice(1).join(' ') : part).toUpperCase());
}

/** 定義の囲み (`CREATE OR REPLACE FUNCTION public.<name>(` を含む SQL の例) */
function definingFence(markdown: string, functionName: string): string | undefined {
  const create = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${escapeRegExp(functionName)}\\(`);
  return sqlFences(markdown).find((fence) => create.test(fence));
}

/**
 * 1 つの SQL の例について、SECURITY DEFINER の関数 functionName の実行の権限が service_role だけに絞られているかを見る。
 * 返り値は問題の一覧 (空なら良い)
 */
function definerGrantProblems(fence: string, functionName: string): string[] {
  const name = escapeRegExp(functionName);
  const create = fence.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(([^)]*)\\)`));
  if (create === null) return [`${functionName} の定義が無い`];
  const problems: string[] = [];
  if (!/SECURITY DEFINER/.test(fence)) problems.push(`${functionName} が SECURITY DEFINER でない`);
  const expectedTypes = argTypes(create[1], true);

  const revoke = fence.match(
    new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(([^)]*)\\)\\s+FROM PUBLIC, anon, authenticated;`),
  );
  if (revoke === null) {
    problems.push(`${functionName} の REVOKE ALL … FROM PUBLIC, anon, authenticated が無い`);
  } else if (JSON.stringify(argTypes(revoke[1], false)) !== JSON.stringify(expectedTypes)) {
    problems.push(`${functionName} の REVOKE の引数の型 (${revoke[1]}) が定義 (${expectedTypes.join(', ')}) と違う`);
  }

  const grant = fence.match(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(([^)]*)\\)\\s+TO service_role;`));
  if (grant === null) {
    problems.push(`${functionName} の GRANT EXECUTE … TO service_role が無い`);
  } else if (JSON.stringify(argTypes(grant[1], false)) !== JSON.stringify(expectedTypes)) {
    problems.push(`${functionName} の GRANT の引数の型 (${grant[1]}) が定義 (${expectedTypes.join(', ')}) と違う`);
  }

  const otherGrant = new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\)\\s+TO [^;]*\\b(anon|authenticated|PUBLIC)\\b`);
  if (otherGrant.test(fence)) problems.push(`${functionName} を anon / authenticated / PUBLIC に GRANT している`);
  return problems;
}

describe('判定の関数 definerGrantProblems', () => {
  const head = [
    'CREATE OR REPLACE FUNCTION public.f(p_a UUID, p_b TEXT[])',
    'RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = \'\' AS $$',
    'BEGIN',
    'END $$;',
  ].join('\n');
  const revoke = 'REVOKE ALL ON FUNCTION public.f(UUID, TEXT[]) FROM PUBLIC, anon, authenticated;';
  const grant = 'GRANT EXECUTE ON FUNCTION public.f(UUID, TEXT[]) TO service_role;';

  it('REVOKE と GRANT がそろった例は問題なし', () => {
    expect(definerGrantProblems([head, revoke, grant].join('\n'), 'f')).toEqual([]);
  });

  it('REVOKE が無い例を問題にする', () => {
    expect(definerGrantProblems([head, grant].join('\n'), 'f')).toEqual([
      'f の REVOKE ALL … FROM PUBLIC, anon, authenticated が無い',
    ]);
  });

  it('GRANT が無い例を問題にする', () => {
    expect(definerGrantProblems([head, revoke].join('\n'), 'f')).toEqual(['f の GRANT EXECUTE … TO service_role が無い']);
  });

  it('権限の行がどちらも無い例 (#2025 の最初の形) を問題にする', () => {
    expect(definerGrantProblems(head, 'f')).toHaveLength(2);
  });

  it('REVOKE が authenticated を外さない例を問題にする', () => {
    const partial = 'REVOKE ALL ON FUNCTION public.f(UUID, TEXT[]) FROM PUBLIC, anon;';
    expect(definerGrantProblems([head, partial, grant].join('\n'), 'f')).toEqual([
      'f の REVOKE ALL … FROM PUBLIC, anon, authenticated が無い',
    ]);
  });

  it('引数の型が定義と違う REVOKE / GRANT を問題にする (別の関数の権限になる)', () => {
    const wrongRevoke = 'REVOKE ALL ON FUNCTION public.f(UUID) FROM PUBLIC, anon, authenticated;';
    const wrongGrant = 'GRANT EXECUTE ON FUNCTION public.f(UUID, TEXT) TO service_role;';
    expect(definerGrantProblems([head, wrongRevoke, wrongGrant].join('\n'), 'f')).toEqual([
      'f の REVOKE の引数の型 (UUID) が定義 (UUID, TEXT[]) と違う',
      'f の GRANT の引数の型 (UUID, TEXT) が定義 (UUID, TEXT[]) と違う',
    ]);
  });

  it('authenticated にも GRANT する例を問題にする', () => {
    const wide = 'GRANT EXECUTE ON FUNCTION public.f(UUID, TEXT[]) TO authenticated, service_role;';
    expect(definerGrantProblems([head, revoke, grant, wide].join('\n'), 'f')).toEqual([
      'f を anon / authenticated / PUBLIC に GRANT している',
    ]);
  });

  it('SECURITY DEFINER でない例を問題にする', () => {
    const invoker = head.replace('SECURITY DEFINER', 'SECURITY INVOKER');
    expect(definerGrantProblems([invoker, revoke, grant].join('\n'), 'f')).toEqual(['f が SECURITY DEFINER でない']);
  });
});

describe('設計書の SQL の例の SECURITY DEFINER の関数の権限 (#2025)', () => {
  it.each(TARGETS)('$file の $functionName は、定義があれば service_role だけに絞っている', ({ file, functionName }) => {
    const fence = definingFence(read(file), functionName);
    if (fence === undefined) return; // 設計書の変更が入る前の文書には定義が無い
    expect(definerGrantProblems(fence, functionName)).toEqual([]);
  });
});
