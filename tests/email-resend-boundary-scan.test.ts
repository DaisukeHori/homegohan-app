// @vitest-environment node
/**
 * #1193 Resend を直接使うのは送信待ちの worker の送信 (src/lib/emails/outbox.ts の createResendTransport) だけ、のソース走査テスト。
 * 設計: docs/design/operator/10-logs-and-mail-retry.md §6・§12 (R-23)。
 *
 * アプリが送るメールはすべて sendEmail (src/lib/emails/send.ts) で送信待ち (email_outbox) に登録し、送るのは worker だけにする。
 * Resend を直接呼ぶと、記録・再試行・届けられなかったときの通知・再送・退会の伏せ字がどれも効かない
 * (以前のお問い合わせの管理者通知は api.resend.com を直接 fetch し、失敗は console.error だけだった)。
 *
 * 何を数えるか (TypeScript の構文木で解析するので、コメントの中は見ない):
 *   (1) `import … from 'resend'` (`import type` は除く)
 *   (2) `import('resend')` (動的 import)
 *   (3) `new Resend(…)`
 *   (4) 'api.resend.com' を含む文字列リテラル・テンプレート
 * 対象: src/ の .ts / .tsx (`__tests__`・`*.test.*`・`*.spec.*`・`.d.ts` を除く)。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOT = 'src';
const RESEND_MODULE = 'resend';
const RESEND_CLASS = 'Resend';
const RESEND_API_HOST = 'api.resend.com';
/** 走査が機能していることの目安 (src の .ts / .tsx はこれより十分に多い) */
const MIN_SCANNED_FILES = 100;

/** Resend を直接使ってよいファイルと理由 */
const ALLOWED: Readonly<Record<string, string>> = {
  'src/lib/emails/outbox.ts': 'worker の送信 (createResendTransport)。Resend を呼ぶのはここだけ (#1193)',
};

type ResendUseKind = 'import' | 'dynamic-import' | 'new-resend' | 'api-host';

/** ソース 1 つの中の、Resend を直接使う書き方を数える */
function findResendUses(source: string, fileName = 'virtual.ts'): ResendUseKind[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const uses: ResendUseKind[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      const typeOnly = node.importClause?.isTypeOnly === true;
      if (ts.isStringLiteral(specifier) && specifier.text === RESEND_MODULE && !typeOnly) uses.push('import');
      return; // import の文字列は (4) で数えない
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text === RESEND_MODULE
    ) {
      uses.push('dynamic-import');
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === RESEND_CLASS) {
      uses.push('new-resend');
    }
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && node.text.includes(RESEND_API_HOST)) {
      uses.push('api-host');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return uses;
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

const scanned = collectSourceFiles(path.join(ROOT, SCAN_ROOT)).map((file) => ({
  relative: path.relative(ROOT, file).split(path.sep).join('/'),
  uses: findResendUses(fs.readFileSync(file, 'utf8'), file),
}));
const users = scanned.filter((file) => file.uses.length > 0);

describe('Resend を直接使うのは送信待ちの worker だけ (#1193)', () => {
  it('Resend を直接使うのは src/lib/emails/outbox.ts だけ (ほかのファイルが使えば赤。sendEmail で送信待ちに登録する)', () => {
    const offenders = users.filter((file) => !(file.relative in ALLOWED)).map((file) => `${file.relative}: ${file.uses.join(', ')}`);

    expect(offenders, 'メールは @/lib/emails/send の sendEmail で送信待ちに登録すること (送るのは GET /api/cron/email-outbox)').toEqual([]);
  });

  it('走査が機能している: src/lib/emails/outbox.ts を検出し、走査したファイルが 100 を超える', () => {
    expect(scanned.length).toBeGreaterThan(MIN_SCANNED_FILES);
    expect(users.find((file) => file.relative === 'src/lib/emails/outbox.ts')?.uses).toEqual(['import', 'new-resend']);
  });

  it('許可の一覧が古くない (許可のファイルが実在し、今も Resend を直接使う)', () => {
    for (const [file, reason] of Object.entries(ALLOWED)) {
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
      expect(users.some((user) => user.relative === file), file).toBe(true);
      expect(reason.trim()).not.toBe('');
    }
  });

  it("検出力: 合成ソースで 4 つの書き方を拾い、コメント・import type・'resend' を含む別のモジュール名 ('resend-webhook-event') は拾わない", () => {
    expect(findResendUses("import { Resend } from 'resend';")).toEqual(['import']);
    expect(findResendUses("import Resend from 'resend';")).toEqual(['import']);
    expect(findResendUses("const m = await import('resend');")).toEqual(['dynamic-import']);
    expect(findResendUses("const r = new Resend('key');")).toEqual(['new-resend']);
    expect(findResendUses("await fetch('https://api.resend.com/emails');")).toEqual(['api-host']);
    expect(findResendUses('const host = `https://api.resend.com/${path}`;')).toEqual(['api-host']);
    expect(findResendUses('const url = `${base}/x/api.resend.com`;')).toEqual(['api-host']);

    expect(findResendUses("import type { CreateEmailOptions } from 'resend';")).toEqual([]);
    expect(findResendUses("// new Resend(key) と https://api.resend.com/emails はコメントの中\n/* import { Resend } from 'resend' */")).toEqual([]);
    expect(findResendUses("import { classify } from '@/lib/emails/resend-webhook-event';")).toEqual([]);
    expect(findResendUses("import { POST } from '@/app/api/webhooks/resend/route';")).toEqual([]);
    expect(findResendUses('const r = new ResendClient();')).toEqual([]);
    expect(findResendUses("const label = 'resend';")).toEqual([]);
  });
});
