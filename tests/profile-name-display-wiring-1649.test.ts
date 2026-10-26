/**
 * #1649 Web で仮置きの 'Guest' を名前として出していた箇所の配線の回帰テスト
 *
 * 確かめること:
 *   - Web のハンズオンツアー 5 画面は自前の safeNickname を持たず、Web・モバイル共通の
 *     @homegohan/shared の handsonTourNickname を使う (モバイルの safe-nickname.ts も同じものを読み直すだけ)
 *   - プロフィール・管理・運営・組織・サポートの画面は、nickname をそのまま出さず normalizeProfileName を通す
 *     (`nickname ?? '…'`・`nickname || '…'`・`{x.nickname}`・`nickname?.[0]` の形で直接出していない)
 *
 * 表示そのもの ('Guest' を出さないこと) は、描画できる画面を tests/handson-tour-profile-pages.test.tsx・
 * src/__tests__/app/{family,org}/transfer-accept-page.test.ts で確かめる。ここはそれ以外の画面も含めた配線だけを見る。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/** 行コメント・ブロックコメントを除く (コメントの中の説明に反応しないため) */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const TOUR_SCREENS = [
  'src/app/handson-tour/page.tsx',
  'src/app/handson-tour/photo/page.tsx',
  'src/app/handson-tour/menu/page.tsx',
  'src/app/handson-tour/badges/page.tsx',
  'src/app/handson-tour/graduate/page.tsx',
];

describe('#1649 Web のハンズオンツアー 5 画面は共通の handsonTourNickname を使う', () => {
  it.each(TOUR_SCREENS)('%s は @homegohan/shared の handsonTourNickname を使い、自前の safeNickname を持たない', (file) => {
    const source = stripComments(read(file));
    expect(source).toMatch(/import\s*\{[^}]*\bhandsonTourNickname\b[^}]*\}\s*from\s*'@homegohan\/shared'/);
    expect(source).not.toMatch(/function\s+safeNickname\s*\(/);
    expect(source).not.toMatch(/\bsafeNickname\s*\(/);
    expect(source).toMatch(/handsonTourNickname\(\s*(data|profile)\.nickname\s*\)/);
    // 呼びかけの既定の文言を画面ごとに直書きしない
    expect(source).not.toContain("'あなた'");
  });

  it('モバイルの safe-nickname.ts は規則を持たず、同じ handsonTourNickname を safeNickname として読み直す', () => {
    const source = stripComments(read('apps/mobile/src/handson-tour/safe-nickname.ts'));
    expect(source).toMatch(/handsonTourNickname\s+as\s+safeNickname/);
    expect(source).toContain("from '@homegohan/shared'");
    expect(source).not.toMatch(/function\s+safeNickname\s*\(/);
  });
});

const DISPLAY_SCREENS = [
  'src/app/(main)/profile/page.tsx',
  'src/app/(main)/family/transfer-accept/[proposal_id]/page.tsx',
  'src/app/(org)/org/members/page.tsx',
  'src/app/(org)/org/settings/owner-transfer/page.tsx',
  'src/app/(main)/org/transfer-accept/[proposal_id]/page.tsx',
  'src/app/(operator)/operator/membership/families/[id]/transfer/page.tsx',
  'src/app/(operator)/operator/membership/orgs/[id]/transfer/page.tsx',
  'src/app/(support)/layout.tsx',
  'src/app/(support)/support/users/page.tsx',
  'src/app/admin/users/page.tsx',
  'src/app/admin/users/[id]/page.tsx',
  'src/app/admin/users/[id]/freeze/page.tsx',
];

describe('#1649 プロフィール・管理・運営・組織・サポートの画面は nickname を normalizeProfileName に通して出す', () => {
  it.each(DISPLAY_SCREENS)('%s', (file) => {
    const source = stripComments(read(file));
    expect(source).toMatch(/import\s*\{\s*normalizeProfileName\s*\}\s*from\s*["']@\/lib\/profile-name["']/);
    expect(source).toMatch(/normalizeProfileName\(/);
    // 保存値を既定の文言で補うだけで画面に出す形 (仮置きの 'Guest' がそのまま出る)。
    // プロフィールの編集の入力欄 (editForm) は保存値をそのまま出すので除く (下のテストで変えていないことを確かめる)
    expect(source).not.toMatch(/(?<!editForm)\.nickname\s*(\?\?|\|\|)/);
    // JSX にそのまま差し込む形
    expect(source).not.toMatch(/\{\s*[\w?.]*\.nickname\s*\}/);
    // 頭文字をそのまま取る形
    expect(source).not.toMatch(/\.nickname\??\.\[0\]/);
  });

  it('プロフィールの編集の入力欄は保存されている値をそのまま出す (変えない)', () => {
    const source = read('src/app/(main)/profile/page.tsx');
    expect(source).toContain("value={editForm.nickname || ''}");
  });
});
