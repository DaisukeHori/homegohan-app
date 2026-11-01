/**
 * #2157 R2: 運営・スーパー管理者の画面の表の列名・欄名に、英字だけの文 (DB の列名そのままなど) を出さない
 *
 * 以前の問題:
 *   - バックアップの画面 (src/app/super-admin/backups/page.tsx) の監査の表の列が「action_type」「stage / reason」「details」だった
 *   - プランの一覧・詳細 (src/app/super-admin/plans/page.tsx・src/app/super-admin/plans/[id]/page.tsx) の欄が「plan_key」、
 *     機能パッケージの詳細 (src/app/super-admin/feature-packages/[id]/page.tsx) と新規作成 (src/app/super-admin/feature-packages/new/page.tsx)
 *     の欄が「package_key」だった
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
 *     欄名は要素のじかの子の文 (入れ子の要素の文は含めない) から必須の印「*」を除いたもの。入れ子の要素 (注記の span など) の文は
 *     それぞれ別の文として同じく判定する。以前は入れ子の注記の文までつないで 1 文にしていたので、
 *     新規作成の画面の「package_key *」に日本語の注記の span が続くと日本語を含むと判定し、見逃していた
 *   - 英字だけの判定が DB の列名の形 (下線・数字・コロンを含む) を拾うこと (判定の自己検査)
 *   - 直した欄が日本語の名前で出ていて、Stripe の項目名は残っていること
 *
 * #2166 X3: span / div で書いた欄名も見張る
 *
 * 以前の問題:
 *   - 監査ログの詳細の「IP: 」(src/app/super-admin/audit-logs/page.tsx)、指標のグラフの下の「min:」「max:」
 *     (src/app/super-admin/infra/metrics/page.tsx)、売上の画面の「MAU」(src/app/admin/finance/page.tsx)、
 *     サポートの利用者の一覧の印「BAN」(src/app/(support)/support/users/page.tsx) が英字のまま出ていた
 *   - 見張りは th・dt・label だけを走査し、span / div の欄名を見ていなかった
 *
 * 直したあと:
 *   - IP → IP アドレス・min / max → 最小 / 最大・MAU → 月間の利用者 (MAU)・BAN → 利用停止
 *   - Stripe の項目名 (プランの詳細の「Product ID:」「Price ID (月額):」「Price ID (年額):」・請求書の詳細の「Stripe Event ID」) は
 *     「Stripe Customer」と同じく Stripe の画面と同じ名前で探すので英字のまま残し、許可の表で明示して外す
 *   - 見張りを span / div の欄名 (末尾がコロンの短い文。「IP アドレス: {値}」の形) にも広げる。
 *     欄名はコロンを除いた文で判定する
 *
 * 見張りの限界: 列名・欄名を変数や関数の呼び出し ({label} など) で渡す欄は、ソースの文として見えないので数えない
 * (値の表示名は tests/admin-english-labels-2112.test.tsx が描画して見る)。
 * span / div は、末尾がコロンの文だけを欄名として見る (コロンの無い見出しの div・印の span は文の役割をソースから決められない)。
 * 売上の画面の「月間の利用者 (MAU)」とサポートの一覧の印「利用停止」は、下の「直した欄の名前」で名指しして確かめる
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

/** 入力が必須の欄の印 (「表示名 *」など)。欄名の一部ではないので、英字だけの判定の前に除く */
const REQUIRED_MARK = '*';

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

/**
 * Stripe の画面と同じ名前で探す Stripe の項目名 (#2166 X3)。この名前そのもの、またはこの名前に空白と補いが続く欄名
 * (プランの詳細の「Product ID:」「Price ID (月額):」「Price ID (年額):」) は英字のまま出してよい。
 * どれも今の画面のどこかで使っていることを下で確かめる
 */
const STRIPE_FIELD_NAMES: readonly string[] = ['Product ID', 'Price ID'];

/** 欄名が Stripe の項目名 name そのもの、または name に空白と補いが続く名前か */
function isNamedAsStripeField(text: string, name: string): boolean {
  return text === name || text.startsWith(`${name} `);
}

function isStripeFieldName(text: string): boolean {
  return STRIPE_FIELD_NAMES.some((name) => isNamedAsStripeField(text, name));
}

function isAllowedEnglishLabel(text: string): boolean {
  return (
    ALLOWED_ENGLISH_LABELS.has(text) ||
    EXTERNAL_SERVICE_NAME_PREFIXES.some((prefix) => text.startsWith(prefix)) ||
    isStripeFieldName(text)
  );
}

/** 欄名をコロンつきで書くことがある要素 (「IP アドレス: {値}」など。#2166 X3) */
const COLON_LABEL_TAGS: ReadonlySet<string> = new Set(['span', 'div']);

/** 欄名の末尾のコロン (半角・全角) */
const TRAILING_LABEL_COLON = /[:：]$/;

/**
 * span / div の末尾がコロンの文を欄名とみなす長さの上限 (コロンを除いた文字数)。
 * 今の運営の画面の欄名は長いものでも十数文字 (「Price ID (月額)」「既存契約への影響」) なので、その倍の余裕をとる。
 * これより長い末尾がコロンの文は、欄名ではなく説明の文とみなす
 */
const COLON_LABEL_MAX_LENGTH = 24;

/** 末尾がコロンの短い文なら、コロンを除いた欄名を返す。欄名の形でなければ null */
function colonLabelNameOf(text: string): string | null {
  if (!TRAILING_LABEL_COLON.test(text)) return null;
  const name = text.replace(TRAILING_LABEL_COLON, '').trim();
  if (name === '' || name.length > COLON_LABEL_MAX_LENGTH) return null;
  return name;
}

/**
 * 列名・欄名の要素 (tag) の中の文。
 * - part: 'own' は要素のじかの子の文 (欄名そのもの)、'nested' は中の入れ子の要素 (nestedTag) のじかの子の文 (注記など)
 */
type LabelText = { file: string; line: number; tag: string; part: 'own' | 'nested'; nestedTag?: string; text: string };

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

/** 文から必須の印「*」を除く (「package_key *」・「package_key*」→「package_key」) */
function withoutRequiredMark(text: string): string {
  return collapseWhitespace(text.split(REQUIRED_MARK).join(' '));
}

/**
 * 要素のじかの子に書かれた文 (JSX の文と、{'…'} の文字列の直書き) を、出てくる順に空白でつなぐ。必須の印「*」は除く。
 * 入れ子の要素 (注記の span など) の文は含めない (入れ子の要素の文は、その要素の文として別に数える)。
 * <>…</> の中は要素ではないので、じかの子として読む
 */
function ownTextOf(element: ts.JsxElement): string {
  const parts: string[] = [];
  const visitChildren = (children: ts.NodeArray<ts.JsxChild>) => {
    for (const child of children) {
      if (ts.isJsxText(child)) {
        parts.push(child.text);
      } else if (ts.isJsxExpression(child)) {
        const expression = child.expression;
        if (expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))) {
          parts.push(expression.text);
        }
        // 式 ({label} や三項演算子) は文として見えないので数えない (見張りの限界。ファイルの先頭の注)
      } else if (ts.isJsxFragment(child)) {
        visitChildren(child.children);
      }
      // 入れ子の要素 (JsxElement・JsxSelfClosingElement) はじかの子の文ではない
    }
  };
  visitChildren(element.children);
  return withoutRequiredMark(collapseWhitespace(parts.join(' ')));
}

function tagNameOf(element: ts.JsxElement | ts.JsxSelfClosingElement): string {
  const opening = ts.isJsxElement(element) ? element.openingElement : element;
  return opening.tagName.getText();
}

/**
 * ソースの中の、指定した要素の文 (空のものは除く)。要素ごとに、じかの子の文 ('own') と、
 * 中の入れ子の要素ごとのじかの子の文 ('nested') を別々に返す。入れ子の要素が指定した要素なら、その要素の 'own' として数える
 */
function elementTextsInSource(file: string, source: string, tags: ReadonlySet<string>): LabelText[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: LabelText[] = [];
  const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const visit = (node: ts.Node, enclosingTag: string | null) => {
    if (ts.isJsxElement(node)) {
      const tag = tagNameOf(node);
      if (tags.has(tag)) {
        const text = ownTextOf(node);
        if (text !== '') found.push({ file, line: lineOf(node), tag, part: 'own', text });
        ts.forEachChild(node, (child) => visit(child, tag));
        return;
      }
      if (enclosingTag !== null) {
        const text = ownTextOf(node);
        if (text !== '') found.push({ file, line: lineOf(node), tag: enclosingTag, part: 'nested', nestedTag: tag, text });
      }
    }
    ts.forEachChild(node, (child) => visit(child, enclosingTag));
  };
  visit(sourceFile, null);
  return found;
}

/** 読んだソース (列名・欄名の走査と span / div の走査で同じファイルを 2 度読まない) */
const SOURCE_CACHE = new Map<string, string>();

function sourceOf(file: string): string {
  const cached = SOURCE_CACHE.get(file);
  if (cached !== undefined) return cached;
  const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  SOURCE_CACHE.set(file, source);
  return source;
}

/** ファイルの中の、指定した要素の文 */
function elementTextsIn(file: string, tags: ReadonlySet<string>): LabelText[] {
  return elementTextsInSource(file, sourceOf(file), tags);
}

/**
 * span / div の文のうち、欄名の形 (末尾がコロンの短い文) のもの。文はコロンを除いた欄名に置き換える (#2166 X3)。
 * 入れ子の要素 (strong など) の末尾がコロンの文も同じく欄名として数える
 */
function colonLabelsOf(texts: readonly LabelText[]): LabelText[] {
  return texts.flatMap((label) => {
    const name = colonLabelNameOf(label.text);
    return name === null ? [] : [{ ...label, text: name }];
  });
}

function isEnglishOnlyLabel(label: LabelText): boolean {
  return isEnglishOnlyText(label.text) && !isAllowedEnglishLabel(label.text);
}

function describeLabel(label: LabelText): string {
  const where = label.part === 'own' ? `<${label.tag}>` : `<${label.tag}> の中の <${label.nestedTag}>`;
  return `${label.file}:${label.line} ${where} ${label.text}`;
}

const OPERATOR_SCREEN_FILES = OPERATOR_SCREEN_DIRS.flatMap(listTsxFiles);
const OPERATOR_LABEL_TEXTS = OPERATOR_SCREEN_FILES.flatMap((file) => elementTextsIn(file, LABEL_TAGS));
const OPERATOR_COLON_LABELS = colonLabelsOf(OPERATOR_SCREEN_FILES.flatMap((file) => elementTextsIn(file, COLON_LABEL_TAGS)));

/** ファイルの中の、指定した要素 (span / div) の欄名そのもの (じかの子の文) */
function spanDivTextsOf(file: string, tag: string): string[] {
  return elementTextsIn(file, COLON_LABEL_TAGS)
    .filter((label) => label.tag === tag && label.part === 'own')
    .map((label) => label.text);
}

/** ファイルの中の、span / div の欄名の形の文 (コロンを除いた欄名) */
function colonLabelNamesOf(file: string): string[] {
  return OPERATOR_COLON_LABELS.filter((label) => label.file === file).map((label) => label.text);
}

/** ファイルの中の、列名・欄名の要素 (tag) の欄名そのもの (じかの子の文) */
function labelTextsOf(file: string, tag: string): string[] {
  return OPERATOR_LABEL_TEXTS.filter((label) => label.file === file && label.tag === tag && label.part === 'own').map(
    (label) => label.text,
  );
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

  it('許可の表: Stripe の項目名はその名前そのものと、空白と補いが続く名前だけを外す (#2166 X3)', () => {
    for (const name of STRIPE_FIELD_NAMES) {
      expect(isEnglishOnlyText(name)).toBe(true);
      expect(isAllowedEnglishLabel(name)).toBe(true);
    }
    expect(isAllowedEnglishLabel('Price ID (monthly)')).toBe(true);
    // 名前の途中で切れているもの・前に別の語がつくものは外さない
    expect(isAllowedEnglishLabel('Product IDs')).toBe(false);
    expect(isAllowedEnglishLabel('Old Price ID')).toBe(false);
    expect(isAllowedEnglishLabel('IP')).toBe(false);
    expect(isAllowedEnglishLabel('MAU')).toBe(false);
    expect(isAllowedEnglishLabel('BAN')).toBe(false);
  });
});

describe('span / div の欄名の取り出し (#2166 X3)', () => {
  const FIXTURE_FILE = 'fixture.tsx';
  const colonLabelsIn = (source: string) => colonLabelsOf(elementTextsInSource(FIXTURE_FILE, source, COLON_LABEL_TAGS));

  it('末尾がコロンの短い文を、コロンを除いた欄名として拾う (値の式は文に入れない)', () => {
    // 以前の監査ログの詳細と指標のグラフの下の形
    const source = `const A = ({ ip, min, max }: { ip: string; min: number; max: number }) => (
      <div>
        <div className="text-xs">IP: {ip}</div>
        <div className="flex">
          <span>min: {min}</span>
          <span>max：{max}</span>
        </div>
      </div>
    );`;
    const labels = colonLabelsIn(source);
    expect(labels.map((label) => `${label.tag}:${label.text}`)).toEqual(['div:IP', 'span:min', 'span:max']);
    expect(labels.filter(isEnglishOnlyLabel).map((label) => label.text)).toEqual(['IP', 'min', 'max']);
  });

  it('日本語の欄名・Stripe の項目名は英字だけの欄名にしない', () => {
    const source = `const B = ({ ip, id, price }: { ip: string; id: string; price: string }) => (
      <div>
        <div>IP アドレス: {ip}</div>
        <span>Product ID:</span> {id}
        <span>Price ID (月額):</span> {price}
      </div>
    );`;
    const labels = colonLabelsIn(source);
    expect(labels.map((label) => label.text)).toEqual(['IP アドレス', 'Product ID', 'Price ID (月額)']);
    expect(labels.filter(isEnglishOnlyLabel)).toEqual([]);
  });

  it('入れ子の要素の末尾がコロンの文も欄名として拾う', () => {
    const source = `const C = ({ v }: { v: string }) => <div><strong>Status:</strong> {v}</div>;`;
    const labels = colonLabelsIn(source);
    expect(labels.map(({ part, nestedTag, text }) => ({ part, nestedTag, text }))).toEqual([
      { part: 'nested', nestedTag: 'strong', text: 'Status' },
    ]);
    expect(labels.filter(isEnglishOnlyLabel).map((label) => label.text)).toEqual(['Status']);
  });

  it('末尾がコロンでない文・上限より長い文・コロンだけの文は欄名にしない', () => {
    const longSentence = 'A'.repeat(COLON_LABEL_MAX_LENGTH + 1);
    const atLimit = 'B'.repeat(COLON_LABEL_MAX_LENGTH);
    const source = `const D = ({ a, b }: { a: string; b: string }) => (
      <div>
        <div>MAU</div>
        <span>{a}:{b}</span>
        <span>${longSentence}:</span>
        <span>${atLimit}:</span>
        <span>{a} :</span>
      </div>
    );`;
    expect(colonLabelsIn(source).map((label) => label.text)).toEqual([atLimit]);
  });
});

describe('欄名の取り出し (#2157 R2)', () => {
  const FIXTURE_FILE = 'fixture.tsx';

  it('欄名は要素のじかの子の文で、入れ子の注記の文をつながない (日本語の注記で英字の欄名を見逃さない)', () => {
    // 以前の機能パッケージの新規作成の画面の形。以前は「package_key * 英小文字・数字・アンダースコアのみ」を 1 文にして見逃していた
    const source = `const A = () => (
      <label className="block">
        package_key *
        <span className="text-xs">英小文字・数字・アンダースコアのみ</span>
      </label>
    );`;
    const texts = elementTextsInSource(FIXTURE_FILE, source, LABEL_TAGS);
    expect(texts.map(({ part, nestedTag, text }) => ({ part, nestedTag, text }))).toEqual([
      { part: 'own', nestedTag: undefined, text: 'package_key' },
      { part: 'nested', nestedTag: 'span', text: '英小文字・数字・アンダースコアのみ' },
    ]);
    expect(texts.filter(isEnglishOnlyLabel).map((label) => label.text)).toEqual(['package_key']);
  });

  it('入れ子の要素の英字だけの文も拾う・必須の印と式は除く・<>…</> の中はじかの子として読む', () => {
    const source = `const B = ({ hint }: { hint: string }) => (
      <table>
        <thead>
          <tr>
            <th><span>action_type</span></th>
            <th>操作 <span className="text-red-500">*</span></th>
            <th>{'details'}</th>
            <th><>stage / reason</></th>
            <th>{hint}</th>
          </tr>
        </thead>
      </table>
    );`;
    const texts = elementTextsInSource(FIXTURE_FILE, source, LABEL_TAGS);
    expect(texts.map(({ part, text }) => `${part}:${text}`)).toEqual([
      'nested:action_type',
      'own:操作',
      'own:details',
      'own:stage / reason',
    ]);
    expect(texts.filter(isEnglishOnlyLabel).map((label) => label.text)).toEqual(['action_type', 'details', 'stage / reason']);
  });

  it('欄名につけた必須の印「*」は空白が無くても除く', () => {
    const source = `const D = () => <label>plan_key*</label>;`;
    const texts = elementTextsInSource(FIXTURE_FILE, source, LABEL_TAGS);
    expect(texts.map((label) => label.text)).toEqual(['plan_key']);
    expect(texts.filter(isEnglishOnlyLabel).map((label) => label.text)).toEqual(['plan_key']);
  });

  it('列名・欄名の要素の中の列名・欄名の要素は、その要素の欄名として数える', () => {
    const source = `const C = () => (
      <dt>
        <label>plan_key</label>
      </dt>
    );`;
    const texts = elementTextsInSource(FIXTURE_FILE, source, LABEL_TAGS);
    expect(texts.map(({ tag, part, text }) => `${tag}:${part}:${text}`)).toEqual(['label:own:plan_key']);
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
    const englishOnly = OPERATOR_LABEL_TEXTS.filter(isEnglishOnlyLabel).map(describeLabel);
    expect(englishOnly).toEqual([]);
  });

  it('許可の表の略語は今の画面のどこかで使っている (使われなくなった許可を残さない)', () => {
    for (const allowed of ALLOWED_ENGLISH_LABELS) {
      expect(OPERATOR_LABEL_TEXTS.some((label) => label.part === 'own' && label.text === allowed), allowed).toBe(true);
    }
  });
});

describe('運営の画面の span / div の欄名 (末尾がコロンの短い文) に英字だけの文が無い (#2166 X3)', () => {
  it('走査の対象を取れている (span・div のどちらの欄名も拾えている)', () => {
    for (const tag of COLON_LABEL_TAGS) {
      expect(OPERATOR_COLON_LABELS.some((label) => label.tag === tag), tag).toBe(true);
    }
  });

  it('英字だけの欄名は許可の表のものだけ', () => {
    const englishOnly = OPERATOR_COLON_LABELS.filter(isEnglishOnlyLabel).map(describeLabel);
    expect(englishOnly).toEqual([]);
  });

  it('許可の表の Stripe の項目名は今の画面のどこかで使っている (使われなくなった許可を残さない)', () => {
    for (const name of STRIPE_FIELD_NAMES) {
      expect(OPERATOR_COLON_LABELS.some((label) => isNamedAsStripeField(label.text, name)), name).toBe(true);
    }
  });
});

describe('直した欄の名前 (#2157 R2)', () => {
  it('バックアップの画面の監査の表の列は 操作・段階 / 理由・詳細', () => {
    const headers = labelTextsOf('src/app/super-admin/backups/page.tsx', 'th');
    expect(headers).toEqual(expect.arrayContaining(['日時', '操作', '重要度', '段階 / 理由', '詳細']));
    for (const old of ['action_type', 'stage / reason', 'details']) expect(headers).not.toContain(old);
  });

  it('プランの一覧の列・プランの詳細の欄は「プランの鍵」、機能パッケージの詳細・新規作成の欄は「パッケージの鍵」', () => {
    const fields: ReadonlyArray<{ file: string; tag: string; name: string; old: string }> = [
      { file: 'src/app/super-admin/plans/page.tsx', tag: 'th', name: 'プランの鍵', old: 'plan_key' },
      { file: 'src/app/super-admin/plans/[id]/page.tsx', tag: 'label', name: 'プランの鍵', old: 'plan_key' },
      { file: 'src/app/super-admin/feature-packages/[id]/page.tsx', tag: 'label', name: 'パッケージの鍵', old: 'package_key' },
      // 新規作成の欄は必須の印「*」と注記の span がつく (欄名はじかの子の文から「*」を除いたもの)
      { file: 'src/app/super-admin/feature-packages/new/page.tsx', tag: 'label', name: 'パッケージの鍵', old: 'package_key' },
    ];
    for (const { file, tag, name, old } of fields) {
      const labels = labelTextsOf(file, tag);
      expect(labels, file).toContain(name);
      expect(labels, file).not.toContain(old);
    }
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

describe('直した欄の名前 (#2166 X3)', () => {
  it('監査ログの詳細の欄は「IP アドレス」(IP は出さない)', () => {
    const labels = colonLabelNamesOf('src/app/super-admin/audit-logs/page.tsx');
    expect(labels).toContain('IP アドレス');
    expect(labels).not.toContain('IP');
  });

  it('指標のグラフの下の欄は「最小」「最大」(min・max は出さない)', () => {
    const labels = colonLabelNamesOf('src/app/super-admin/infra/metrics/page.tsx');
    expect(labels).toEqual(expect.arrayContaining(['最小', '最大']));
    for (const old of ['min', 'max']) expect(labels).not.toContain(old);
  });

  it('売上の画面の利用者数のカードの欄名は「月間の利用者 (MAU)」(英字だけの MAU は出さない)', () => {
    const texts = spanDivTextsOf('src/app/admin/finance/page.tsx', 'div');
    expect(texts).toContain('月間の利用者 (MAU)');
    expect(texts).not.toContain('MAU');
  });

  it('サポートの利用者の一覧の凍結の印は「利用停止」(BAN は出さない)', () => {
    const texts = spanDivTextsOf('src/app/(support)/support/users/page.tsx', 'span');
    expect(texts).toContain('利用停止');
    expect(texts).not.toContain('BAN');
  });

  it('プランの詳細・請求書の詳細の Stripe の項目名は Stripe の画面と同じ名前のまま残す', () => {
    expect(colonLabelNamesOf('src/app/super-admin/plans/[id]/page.tsx')).toEqual(
      expect.arrayContaining(['Product ID', 'Price ID (月額)', 'Price ID (年額)']),
    );
    expect(spanDivTextsOf('src/app/admin/finance/invoices/[id]/page.tsx', 'div')).toContain('Stripe Event ID');
  });
});
