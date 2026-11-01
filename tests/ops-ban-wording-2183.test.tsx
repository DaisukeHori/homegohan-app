/**
 * #2183 Z4 運営の凍結のフォーム・審査の画面・API の文の英字の BAN を「凍結」の系に揃える
 *
 * 以前の問題:
 *   凍結の画面の見出しは「ユーザー凍結」(#2178 Y2) なのに、中のフォームは「BAN 種別・一時 BAN・永久 BAN・BAN 期間」、
 *   完了の文は「永久 BAN で凍結しました」だった。審査の画面は「削除 + 一時 BAN」「投稿者を BAN しました」、非表示の解除の
 *   カードは「投稿者を BAN している場合、BAN は…」と出す。API の文 (「BAN の適用に失敗しました」「…のユーザーは BAN できません」
 *   「永久 BAN は…実行できます」「一時 BAN の場合は日数…」) も、そのまま画面に出る。
 *
 * 直したあと: 「凍結の種類」「一時凍結」「無期限凍結」「凍結の期間 (日数)」「投稿者を凍結しました」「凍結に失敗しました」
 * 「…のユーザーは凍結できません」の系。内部の鍵 (ban_type・delete_and_temp_ban / delete_and_perm_ban・ban_duration_days・
 * 監査の admin.user.ban・定数名・API の JSON の鍵) は変えない。
 *
 * 確かめること:
 *   - 呼び名の定数 (src/lib/admin/freeze-labels.ts) と、API・ライブラリの文の値
 *   - 凍結のフォーム・審査のフォームを描いた画面の文字に、英字の BAN が無い
 *   - 同じ型: src (と apps/mobile) のソースの、画面・API の文になりうる文字 (JSX の文字・文字列・テンプレート文字列。
 *     コメントは数えない) に英字の BAN が無い
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { stripAllTags } from './helpers/strip-tags';
import { findErrorTexts } from './helpers/api-error-text-scan';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const { default: UserFreezeForm } = await import('@/components/admin/UserFreezeForm');
const { default: ModerationReviewForm } = await import('@/components/operator/moderation/ModerationReviewForm');
const freezeLabels = await import('@/lib/admin/freeze-labels');
const userBan = await import('@/lib/admin/user-ban');

const ROOT = path.resolve(__dirname, '..');

/** 画面・API の文に出してはいけない英字の BAN (BANNER などの一部や、ban_type などの小文字の内部の鍵は数えない) */
const ENGLISH_BAN = /\bBAN\b|\bBan\b/;

function mount(element: ReactElement): string {
  document.body.innerHTML = renderToStaticMarkup(element);
  return stripAllTags(document.body.innerHTML, ' ');
}

describe('呼び名の定数 (src/lib/admin/freeze-labels.ts)', () => {
  it('凍結のフォーム・審査のフォームの欄と選択肢の語', () => {
    expect(freezeLabels.FREEZE_TYPE_LABEL).toBe('凍結の種類');
    expect(freezeLabels.TEMPORARY_FREEZE_LABEL).toBe('一時凍結');
    expect(freezeLabels.PERMANENT_FREEZE_LABEL).toBe('無期限凍結');
    expect(freezeLabels.FREEZE_DURATION_DAYS_LABEL).toBe('凍結の期間 (日数)');
  });

  it('期間の入力の誤りの文と、完了の文', () => {
    expect(freezeLabels.freezeDurationDaysRangeMessage(1, 365)).toBe('凍結の期間は 1〜365 の整数 (日数) で入力してください');
    expect(freezeLabels.PERMANENT_FREEZE_DONE_MESSAGE).toBe('無期限で凍結しました');
    expect(freezeLabels.temporaryFreezeDoneMessage(7)).toBe('7 日間凍結しました');
    expect(freezeLabels.CONTENT_OWNER_FROZEN_MESSAGE).toBe('投稿者を凍結しました');
  });
});

describe('API・ライブラリの文 (src/lib/admin/user-ban.ts。凍結の route と審査の route が本文の message にする)', () => {
  it('DB の失敗の固定の文は「凍結に失敗しました」', () => {
    expect(userBan.BAN_INTERNAL_ERROR_MESSAGE).toBe('凍結に失敗しました');
  });

  it('運営最上位の凍結を断る文は、凍結の route と審査の route で同じ「…のユーザーは凍結できません」', () => {
    expect(userBan.SUPER_ADMIN_BAN_REJECTED_MESSAGE).toBe('運営最上位のユーザーは凍結できません');
    expect(userBan.SUPER_ADMIN_BAN_REJECTED_MESSAGE).toBe(userBan.SUPER_ADMIN_FREEZE_REJECTED_MESSAGE);
  });

  it('無期限凍結を断る文', () => {
    expect(userBan.PERMANENT_BAN_SUPER_ADMIN_ONLY_MESSAGE).toBe('無期限凍結は運営最上位のみ実行できます');
  });

  it('route の 400 の文 (定数・テンプレートの式をたどって値にしたもの): 一時凍結の日数が無いとき', () => {
    const texts = (file: string) => findErrorTexts(file, { substitutions: { exempt: new Map() } }).map((found) => found.text);
    expect(texts('src/app/api/admin/users/[id]/freeze/route.ts')).toContain('一時凍結の場合は日数 (duration_days) が必須です');
    expect(texts('src/app/api/admin/moderation/[type]/[id]/route.ts')).toContain(
      '削除と一時凍結 (delete_and_temp_ban) の場合は凍結の日数 (ban_duration_days) が必須です',
    );
  });
});

describe('描いた画面の文字に英字の BAN が無い', () => {
  it('凍結のフォーム (運営最上位): 欄名・選択肢は凍結の系', () => {
    const text = mount(<UserFreezeForm userId="00000000-0000-4000-8000-000000000001" isBanned={false} isSuperAdmin />);
    expect(document.querySelector('legend')?.textContent?.replace('*', '').trim()).toBe('凍結の種類');
    expect(document.querySelector('input[value="temporary"]')?.closest('label')?.textContent?.trim()).toBe('一時凍結');
    expect(document.querySelector('input[value="permanent"]')?.closest('label')?.textContent?.trim()).toBe(
      '無期限凍結 (運営最上位のみ)',
    );
    expect(document.querySelector('label[for="duration_days"]')?.textContent?.trim()).toBe('凍結の期間 (日数)');
    expect(text).not.toMatch(ENGLISH_BAN);
  });

  it('審査のフォーム (運営最上位): 選択肢は「削除 + 一時凍結」「削除 + 無期限凍結 (運営最上位のみ)」', () => {
    const text = mount(<ModerationReviewForm type="food" id="flag-1" status="pending" isSuperAdmin />);
    expect(document.querySelector('option[value="delete_and_temp_ban"]')?.textContent).toBe('削除 + 一時凍結');
    expect(document.querySelector('option[value="delete_and_perm_ban"]')?.textContent).toBe('削除 + 無期限凍結 (運営最上位のみ)');
    expect(text).not.toMatch(ENGLISH_BAN);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 同じ型: ソースの、画面・API の文になりうる文字に英字の BAN が無い
// ─────────────────────────────────────────────────────────────────────────────

/** 走査する所 (運営・サポートの画面とその API・ライブラリ・メールの文を含む src 全体と、モバイルのアプリ) */
const SCANNED_PATHS = ['src', 'apps/mobile/src', 'apps/mobile/app'] as const;

/** テストのファイル (画面・API の文ではない) */
const TEST_FILE = /(^|[\\/])__tests__[\\/]|\.(test|spec)\.tsx?$/;

function sourceFiles(target: string): string[] {
  if (!fs.existsSync(target)) return [];
  if (fs.statSync(target).isFile()) return [target];
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !TEST_FILE.test(full) ? [full] : [];
  });
}

/**
 * ソースの中の、画面・API の文になりうる文字 (JSX の文字・文字列・テンプレート文字列) のうち、英字の BAN を含むもの。
 * コメントは構文木に入らないので数えない。import / export の指定子は見ない
 */
function englishBanTexts(source: string, fileName: string): Array<{ line: number; text: string }> {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Array<{ line: number; text: string }> = [];
  const add = (node: ts.Node, text: string) => {
    if (!ENGLISH_BAN.test(text)) return;
    found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: text.trim() });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isJsxText(node)) add(node, node.text);
    else if (ts.isStringLiteralLike(node)) add(node, node.text);
    else if (ts.isTemplateExpression(node)) {
      add(node.head, node.head.text);
      for (const span of node.templateSpans) add(span.literal, span.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('同じ型: ソースの画面・API の文に英字の BAN が残っていない (コメントは数えない)', () => {
  it('走査が機能している: 直す前の各所の形を検出し、コメント・内部の鍵・BANNER などは数えない', () => {
    const sample = [
      '// 一時 BAN のコメント',
      '/** 永久 BAN を選べるのは super_admin だけ */',
      "const keys = { ban_type: 'temporary', action: 'delete_and_temp_ban', audit: 'admin.user.ban' };",
      "const banner = 'BANNER';",
      // 直す前の src/components/admin/UserFreezeForm.tsx
      'const a = <legend>BAN 種別 <span>*</span></legend>;',
      'const b = `${days === null ? \'永久 BAN で凍結しました\' : `${days} 日間の一時 BAN で凍結しました`}`;',
      // 直す前の src/components/operator/moderation/ModerationReviewForm.tsx
      "const c = { value: 'delete_and_temp_ban', label: '削除 + 一時 BAN' };",
      // 直す前の src/lib/admin/user-ban.ts
      'const d = `${label}のユーザーは BAN できません`;',
      // 直す前の src/app/api/admin/users/[id]/freeze/route.ts
      "const e = { message: '一時 BAN の場合は日数 (duration_days) が必須です' };",
    ].join('\n');
    expect(englishBanTexts(sample, 'sample.tsx').map(({ line }) => line)).toEqual([5, 6, 6, 7, 8, 9]);
  });

  it('走査する所に、画面・API の文として英字の BAN が無い', () => {
    const files = SCANNED_PATHS.flatMap((target) => sourceFiles(path.join(ROOT, target)));
    // 直した所が走査に入っている (パスの書き誤りで空振りしない)
    for (const fixed of [
      'src/components/admin/UserFreezeForm.tsx',
      'src/components/operator/moderation/ModerationReviewForm.tsx',
      'src/components/operator/moderation/ModerationRestoreForm.tsx',
      'src/lib/admin/user-ban.ts',
      'src/app/api/admin/users/[id]/freeze/route.ts',
      'src/app/api/admin/moderation/[type]/[id]/route.ts',
    ]) {
      expect(files, fixed).toContain(path.join(ROOT, fixed));
    }
    const violations = files.flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8');
      // 構文木を作るのは、英字の BAN を含むファイルだけ (走査の時間を抑える)
      if (!ENGLISH_BAN.test(source)) return [];
      return englishBanTexts(source, file).map(({ line, text }) => `${path.relative(ROOT, file)}:${line} ${text}`);
    });
    expect(violations).toEqual([]);
  });
});
