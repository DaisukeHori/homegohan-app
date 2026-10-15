/**
 * #1631 の回帰テスト: 要件書 docs/requirements/03-operator-admin.md の「12.2 E2E (Playwright)」は事実だけを書く。
 *
 * - 一覧の `op/` の spec はリポジトリに無いので、各行に「(未作成)」と書く。実際に作られたら、この印を外して実在の
 *   パスに直す (印と実在が食い違ったら赤)。
 * - この節が実在の E2E (tests/e2e/…spec.ts) を挙げるなら、運営画面 (パスに operator / admin を含む) の E2E を
 *   全部挙げる。一部だけを挙げると「実在するのはそれだけ」と読めてしまうため (#1631 の R1 で、5 本あるうちの 2 本だけを
 *   挙げた文が事実と食い違った)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const REQUIREMENTS_DOC = 'docs/requirements/03-operator-admin.md';
const SECTION_HEADING = '### 12.2 E2E (Playwright)';
const E2E_DIR = 'tests/e2e';

/** 一覧の `op/NN-xxx.spec.ts` の行 */
const OP_SPEC_LINE = /^-\s+`op\/([\w.-]+\.spec\.ts)`(.*)$/;
/** 未作成の印 */
const NOT_CREATED_MARK = '(未作成)';
/** 節の中で挙げた実在の E2E のパス */
const REFERENCED_E2E_PATH = /tests\/e2e\/[\w./-]+\.spec\.ts/g;
/** 運営画面の E2E とみなすパス */
const OPERATOR_E2E_PATH = /operator|admin/i;

/** 見出しから次の同じ深さの見出しの手前まで */
function extractSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start < 0) return '';
  const rest = markdown.slice(start + heading.length);
  const next = rest.search(/^#{1,3} /m);
  return next < 0 ? rest : rest.slice(0, next);
}

/** tests/e2e の下の spec を ROOT からの相対パスで集める */
function collectE2eSpecs(): string[] {
  const specs: string[] = [];
  const walk = (relativeDir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, relativeDir), { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) walk(relativePath);
      else if (entry.name.endsWith('.spec.ts')) specs.push(relativePath);
    }
  };
  walk(E2E_DIR);
  return specs;
}

/** 節の中の `op/` の行のうち、印と実在が食い違うもの */
function mismatchedOpSpecLines(section: string, specs: readonly string[]): string[] {
  return section
    .split('\n')
    .map((line) => line.match(OP_SPEC_LINE))
    .filter((match): match is RegExpMatchArray => match !== null)
    .filter((match) => {
      const fileName = match[1] ?? '';
      const marked = (match[2] ?? '').includes(NOT_CREATED_MARK);
      const exists = specs.some((spec) => path.posix.basename(spec) === fileName);
      return exists === marked;
    })
    .map((match) => match[0]);
}

/** 節が実在の E2E を挙げているのに、挙げていない運営画面の E2E */
function unlistedOperatorSpecs(section: string, specs: readonly string[]): string[] {
  const referenced = new Set(section.match(REFERENCED_E2E_PATH) ?? []);
  if (referenced.size === 0) return [];
  return specs.filter((spec) => OPERATOR_E2E_PATH.test(spec) && !referenced.has(spec)).sort();
}

describe('#1631 要件書 03-operator-admin.md の E2E の一覧は事実だけを書く', () => {
  const markdown = fs.readFileSync(path.join(ROOT, REQUIREMENTS_DOC), 'utf8');
  const section = extractSection(markdown, SECTION_HEADING);
  const specs = collectE2eSpecs();

  it('節がある (見出しの改名で検査が空振りしない) と、op/ の行が 8 本ある', () => {
    expect(section).not.toBe('');
    expect(section.split('\n').filter((line) => OP_SPEC_LINE.test(line))).toHaveLength(8);
  });

  it('op/ の各行の「(未作成)」の印は、実在と食い違わない', () => {
    expect(mismatchedOpSpecLines(section, specs)).toEqual([]);
  });

  it('節が挙げる tests/e2e のパスはどれも実在する', () => {
    for (const referenced of section.match(REFERENCED_E2E_PATH) ?? []) {
      expect(fs.existsSync(path.join(ROOT, referenced)), referenced).toBe(true);
    }
  });

  it('節が実在の E2E を挙げるなら、運営画面の E2E を全部挙げる (一部だけ挙げない)', () => {
    expect(unlistedOperatorSpecs(section, specs)).toEqual([]);
  });

  it('検査は、一部だけを挙げた文と、印の付け忘れを実際に拾う (検査が空振りしていない)', () => {
    // 運営画面の E2E は tests/e2e/operator の 2 本のほかにもある (この前提が崩れたら下の例を見直す)
    const operatorSpecs = specs.filter((spec) => OPERATOR_E2E_PATH.test(spec));
    expect(operatorSpecs).toEqual(
      expect.arrayContaining(['tests/e2e/operator/01-admin-flow.spec.ts', 'tests/e2e/operator/02-super-admin-flow.spec.ts']),
    );
    expect(operatorSpecs.length).toBeGreaterThan(2);
    // #1631 の R1 の文 (operator の 2 本だけを挙げた)
    const partial = `${SECTION_HEADING}\n運営画面の E2E として実在するのは\n\`tests/e2e/operator/01-admin-flow.spec.ts\` と \`tests/e2e/operator/02-super-admin-flow.spec.ts\`。\n`;
    expect(unlistedOperatorSpecs(partial, specs).length).toBeGreaterThan(0);
    // 実在する spec に「(未作成)」を付けた行と、無い spec に印を付け忘れた行
    const existing = path.posix.basename(operatorSpecs[0] ?? '');
    expect(mismatchedOpSpecLines(`- \`op/${existing}\` (未作成)`, specs)).toHaveLength(1);
    expect(mismatchedOpSpecLines('- `op/05-llm-usage-dashboard.spec.ts`', specs)).toHaveLength(1);
    expect(mismatchedOpSpecLines('- `op/05-llm-usage-dashboard.spec.ts` (未作成)', specs)).toEqual([]);
  });
});
