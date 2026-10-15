/**
 * 同意画面の文面 (packages/shared の LEGAL_CONSENT_COPY) を Web の同意フォームが使っていることのテスト
 * (#1442 / 設計書 docs/design/cross/13a-legal-consent-api-server.md §6.14 E)
 *
 *   - T-C1: src/app/legal-consent/LegalConsentForm.tsx は共有の文面を使い、見出し・導入・ボタンの文をリテラルで持たない
 *   - T-C2: LEGAL_CONSENT_COPY の値は e2e・unit が画面を探す文と同じ (逐語で固定)
 *   - T-C3: Web の「同意しない」のボタンは declineAndSignOutButton を使い、declineButton を使わない
 *
 * 走査は TypeScript の構文木で行う (コメントはノードにならないので拾わない)。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { LEGAL_CONSENT_COPY, legalConsentAgreeLabel } from '@homegohan/shared';

const ROOT = path.resolve(__dirname, '..');
const FORM_FILE = path.join(ROOT, 'src', 'app', 'legal-consent', 'LegalConsentForm.tsx');

function parseForm(): ts.SourceFile {
  const text = fs.readFileSync(FORM_FILE, 'utf-8');
  return ts.createSourceFile(FORM_FILE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** 文字列リテラル・テンプレートの各部分・JSX のテキストの文 (コメントは入らない) */
function collectLiteralTexts(sf: ts.SourceFile): string[] {
  const texts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      texts.push(node.text);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      texts.push(node.text);
    } else if (ts.isJsxText(node)) {
      const trimmed = node.text.trim();
      if (trimmed) texts.push(trimmed);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return texts;
}

/** `LEGAL_CONSENT_COPY.<name>` の参照の数 */
function countCopyReferences(sf: ts.SourceFile, name: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'LEGAL_CONSENT_COPY' &&
      node.name.text === name
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

describe('Web の同意フォームの文面 (#1442)', () => {
  it('Web の同意フォーム (LegalConsentForm.tsx) は共有の文面 (LEGAL_CONSENT_COPY) を使い、見出し・導入・ボタンのリテラルを持たない', () => {
    const sf = parseForm();
    const texts = collectLiteralTexts(sf);
    // 走査が空振りしていない (押している間の文はリテラルのまま残る)
    expect(texts).toContain('記録しています...');
    expect(texts).toContain('ログアウトしています...');

    const copyValues: string[] = Object.values(LEGAL_CONSENT_COPY);
    const offenders = texts.flatMap((text) =>
      copyValues.filter((value) => text.includes(value)).map((value) => `${JSON.stringify(text)} に ${JSON.stringify(value)}`),
    );
    expect(offenders).toEqual([]);

    // 文面を shared から取っている
    for (const name of ['heading', 'introFirst', 'introReconsent', 'revisedBadge', 'acceptButton', 'versionMismatch', 'declineUnavailable', 'acceptFailed']) {
      expect(countCopyReferences(sf, name), `LEGAL_CONSENT_COPY.${name}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('LEGAL_CONSENT_COPY の値は e2e が探す文 (見出し・チェックの文・ボタンの文) と同じ', () => {
    // e2e tests/e2e/legal-consent-gate.spec.ts の consentHeading / acceptButton / termsCheckbox と、
    // unit tests/legal-consent-page.test.tsx の toBe('同意して続ける') / includes('同意しない') が探す文
    expect(LEGAL_CONSENT_COPY.heading).toBe('利用規約・プライバシーポリシーへの同意');
    expect(LEGAL_CONSENT_COPY.acceptButton).toBe('同意して続ける');
    expect(LEGAL_CONSENT_COPY.declineAndSignOutButton).toBe('同意しない（ログアウトする）');
    expect(LEGAL_CONSENT_COPY.declineAndSignOutButton.startsWith(LEGAL_CONSENT_COPY.declineButton)).toBe(true);
    expect(legalConsentAgreeLabel('利用規約')).toBe('利用規約の内容を確認し、同意します');
  });

  it('Web の「同意しない」のボタンは declineAndSignOutButton を使い、declineButton を使わない', () => {
    const sf = parseForm();
    expect(countCopyReferences(sf, 'declineAndSignOutButton')).toBeGreaterThanOrEqual(1);
    expect(countCopyReferences(sf, 'declineButton')).toBe(0);
  });
});
