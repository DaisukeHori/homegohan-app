/**
 * #2157 R2: 運営・スーパー管理者の画面の表の列名・欄名に、英字だけの文 (DB の列名そのままなど) を出さない
 *
 * 以前の問題:
 *   - バックアップの画面 (src/app/super-admin/backups/page.tsx) の監査の表の列が「action_type」「stage / reason」「details」だった
 *   - プランの一覧・詳細 (src/app/super-admin/plans/page.tsx・src/app/super-admin/plans/[id]/page.tsx) の欄が「plan_key」、
 *     機能パッケージの詳細 (src/app/super-admin/feature-packages/[id]/page.tsx) の欄が「package_key」だった
 *   - NPS の画面 (src/app/admin/finance/nps/page.tsx) の絞り込みの欄が「期間 FROM」「期間 TO」だった
 *   #2150 Q3 は見出し (h1〜h6) だけを日本語にし、欄名は見張りの外だった
 *
 * 直したあと:
 *   - action_type → 操作・stage / reason → 段階 / 理由・details → 詳細・plan_key → プランの鍵・package_key → パッケージの鍵・
 *     期間 FROM → 期間の始め (対の「期間 TO」は期間の終わり)
 *   - 請求書の詳細の「Stripe Customer」「Stripe Subscription」は Stripe の画面と同じ名前で探すので英字のまま残す
 *
 * 確かめること (ソースの JSX を TypeScript の構文木で読む。描画はしない):
 *   - 運営の画面のソースの表の列名・欄名 (th・dt・label) の文に英字だけの文が無い。許すのは下の許可の表のものだけ
 *   - 英字だけの判定が DB の列名の形 (下線・数字・コロンを含む) を拾うこと (判定の自己検査)
 *   - 直した欄が日本語の名前で出ていて、Stripe の項目名は残っていること
 *
 * 見張りの限界: 列名・欄名を変数や関数の呼び出し ({label} など) で渡す欄は、ソースの文として見えないので数えない
 * (値の表示名は tests/admin-english-labels-2112.test.tsx が描画して見る)
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { isEnglishOnlyText } from './helpers/english-only-text';

const REPO_ROOT = path.resolve(__dirname, '..');

/** 運営・スーパー管理者・緊急介入・サポートの画面と、その画面だけが使う部品のソースの置き場所 */
const OPERATOR_SCREEN_DIRS: readonly string[] = [
  'src/app/admin',
  'src/app/super-admin',
  'src/app/(operator)',
  'src/app/(support)',
  'src/components/admin',
  'src/components/operator',
];

/** 表の列名・欄名を書く要素 */
const LABEL_TAGS: ReadonlySet<string> = new Set(['th', 'dt', 'label']);

/**
 * 英字のまま出してよい列名・欄名 (運用の略語)。どれも今の画面のどこかで使っていること (使われなくなったら表から外す) を下で確かめる
 * - ID: 行の識別子の列 (問い合わせ・組織の一覧など)。#2157 R2 で対象外と判断済み
 */
const ALLOWED_ENGLISH_LABELS: ReadonlySet<string> = new Set(['ID']);

/**
 * 外部サービスの固有名で始まる欄名は、そのサービスの画面と同じ名前で探すので英字のまま出してよい
 * (請求書の詳細の「Stripe Customer」「Stripe Subscription」「Stripe Event ID」・売上の画面の「Stripe Dashboard」)
 */
const EXTERNAL_SERVICE_NAME_PREFIXES: readonly string[] = ['Stripe '];

function isAllowedEnglishLabel(text: string): boolean {
  return ALLOWED_ENGLISH_LABELS.has(text) || EXTERNAL_SERVICE_NAME_PREFIXES.some((prefix) => text.startsWith(prefix));
}

type LabelText = { file: string; line: number; tag: string; text: string };

function listTsxFiles(dir: string): string[] {
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .flatMap((entry) => {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : listTsxFiles(rel);
      return entry.name.endsWith('.tsx') ? [rel] : [];
    });
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 要素の中に書かれた文 (JSX の文と、{'…'} の文字列の直書き)。入れ子の要素の文も含め、出てくる順に空白でつなぐ */
function jsxTextOf(node: ts.Node): string {
  const parts: string[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isJsxText(child)) {
      parts.push(child.text);
      return;
    }
    if (ts.isJsxExpression(child)) {
      const expression = child.expression;
      if (expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))) {
        parts.push(expression.text);
      }
      // 式 ({label} や三項演算子) は文として見えないので数えない (見張りの限界。ファイルの先頭の注)
      return;
    }
    // 属性 (className など) は画面の文ではない
    if (ts.isJsxAttributes(child)) return;
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return collapseWhitespace(parts.join(' '));
}

function tagNameOf(element: ts.JsxElement | ts.JsxSelfClosingElement): string {
  const opening = ts.isJsxElement(element) ? element.openingElement : element;
  return opening.tagName.getText();
}

/** ファイルの中の、指定した要素の文 (空のものは除く) */
function elementTextsIn(file: string, tags: ReadonlySet<string>): LabelText[] {
  const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: LabelText[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node)) {
      const tag = tagNameOf(node);
      if (tags.has(tag)) {
        const text = jsxTextOf(node);
        if (text !== '') {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          found.push({ file, line: line + 1, tag, text });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

const OPERATOR_SCREEN_FILES = OPERATOR_SCREEN_DIRS.flatMap(listTsxFiles);
const OPERATOR_LABEL_TEXTS = OPERATOR_SCREEN_FILES.flatMap((file) => elementTextsIn(file, LABEL_TAGS));

function labelTextsOf(file: string, tag: string): string[] {
  return OPERATOR_LABEL_TEXTS.filter((label) => label.file === file && label.tag === tag).map((label) => label.text);
}

describe('英字だけの判定 (#2157 R2)', () => {
  it('DB の列名の形 (下線)・数字・コロンを含む英字の文も英字だけと判定する', () => {
    // 以前の判定は下線を許しておらず、action_type・plan_key・package_key を拾わなかった
    expect(isEnglishOnlyText('action_type')).toBe(true);
    expect(isEnglishOnlyText('plan_key')).toBe(true);
    expect(isEnglishOnlyText('package_key')).toBe(true);
    expect(isEnglishOnlyText('stage / reason')).toBe(true);
    expect(isEnglishOnlyText('details')).toBe(true);
    expect(isEnglishOnlyText('Step 1:')).toBe(true);
    expect(isEnglishOnlyText('Price ID 2')).toBe(true);
    expect(isEnglishOnlyText('Stripe Customer')).toBe(true);
  });

  it('日本語を含む文・1 文字は英字だけではない', () => {
    expect(isEnglishOnlyText('操作')).toBe(false);
    expect(isEnglishOnlyText('段階 / 理由')).toBe(false);
    expect(isEnglishOnlyText('プランの鍵')).toBe(false);
    expect(isEnglishOnlyText('期間の始め')).toBe(false);
    expect(isEnglishOnlyText('Stripe の顧客')).toBe(false);
    expect(isEnglishOnlyText('M')).toBe(false);
  });

  it('許可の表: 略語と外部サービスの固有名だけを外し、DB の列名は外さない', () => {
    for (const allowed of ALLOWED_ENGLISH_LABELS) {
      // 許可の表のものも英字だけ (判定から漏れているのではなく、明示して外している)
      expect(isEnglishOnlyText(allowed)).toBe(true);
      expect(isAllowedEnglishLabel(allowed)).toBe(true);
    }
    expect(isAllowedEnglishLabel('Stripe Customer')).toBe(true);
    expect(isAllowedEnglishLabel('Stripe Subscription')).toBe(true);
    expect(isAllowedEnglishLabel('action_type')).toBe(false);
    expect(isAllowedEnglishLabel('plan_key')).toBe(false);
    expect(isAllowedEnglishLabel('Stripe')).toBe(false);
  });
});

describe('運営の画面の表の列名・欄名 (th・dt・label) に英字だけの文が無い (#2157 R2)', () => {
  it('走査の対象を取れている (置き場所の書き誤りで空振りしない)', () => {
    for (const dir of OPERATOR_SCREEN_DIRS) {
      expect(OPERATOR_SCREEN_FILES.some((file) => file.startsWith(`${dir}${path.sep}`)), dir).toBe(true);
    }
    for (const tag of LABEL_TAGS) {
      expect(OPERATOR_LABEL_TEXTS.some((label) => label.tag === tag), tag).toBe(true);
    }
  });

  it('英字だけの列名・欄名は許可の表のものだけ', () => {
    const englishOnly = OPERATOR_LABEL_TEXTS.filter((label) => isEnglishOnlyText(label.text) && !isAllowedEnglishLabel(label.text)).map(
      (label) => `${label.file}:${label.line} <${label.tag}> ${label.text}`,
    );
    expect(englishOnly).toEqual([]);
  });

  it('許可の表の略語は今の画面のどこかで使っている (使われなくなった許可を残さない)', () => {
    for (const allowed of ALLOWED_ENGLISH_LABELS) {
      expect(OPERATOR_LABEL_TEXTS.some((label) => label.text === allowed), allowed).toBe(true);
    }
  });
});

describe('直した欄の名前 (#2157 R2)', () => {
  it('バックアップの画面の監査の表の列は 操作・段階 / 理由・詳細', () => {
    const headers = labelTextsOf('src/app/super-admin/backups/page.tsx', 'th');
    expect(headers).toEqual(expect.arrayContaining(['日時', '操作', '重要度', '段階 / 理由', '詳細']));
    for (const old of ['action_type', 'stage / reason', 'details']) expect(headers).not.toContain(old);
  });

  it('プランの一覧の列・プランの詳細の欄は「プランの鍵」、機能パッケージの詳細の欄は「パッケージの鍵」', () => {
    expect(labelTextsOf('src/app/super-admin/plans/page.tsx', 'th')).toContain('プランの鍵');
    expect(labelTextsOf('src/app/super-admin/plans/[id]/page.tsx', 'label')).toContain('プランの鍵');
    expect(labelTextsOf('src/app/super-admin/feature-packages/[id]/page.tsx', 'label')).toContain('パッケージの鍵');
  });

  it('NPS の画面の絞り込みの欄は 期間の始め・期間の終わり (期間 FROM・期間 TO は出さない)', () => {
    const labels = labelTextsOf('src/app/admin/finance/nps/page.tsx', 'label');
    expect(labels).toEqual(expect.arrayContaining(['期間の始め', '期間の終わり']));
    for (const old of ['期間 FROM', '期間 TO']) expect(labels).not.toContain(old);
  });

  it('請求書の詳細の Stripe の項目名は Stripe の画面と同じ名前のまま残す', () => {
    const texts = elementTextsIn('src/app/admin/finance/invoices/[id]/page.tsx', new Set(['span'])).map((label) => label.text);
    expect(texts).toEqual(expect.arrayContaining(['Stripe Customer', 'Stripe Subscription']));
  });
});
