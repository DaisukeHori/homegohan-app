// src/app/(main)/favorites/_components/__tests__/notice-texts-location.test.ts
// #2011 (cross/22 §7.10 (2)・§7.12・§14 の「定数 (画面。export しない)」の行):
// 買い物リストに足したときの知らせの 3 つの文 (SHOPPING_LIST_*) は、お気に入りの画面の page.tsx に置かず、
// 詳細の部品 (FavoriteRecipeModal.tsx。分けるなら _components/shopping-list-notice.ts) の 1 か所だけが持つ。
// page は onNotice で受けた文をそのまま出す。
//
// 設計書の初版は「page.tsx と FavoriteRecipeModal.tsx の両方」に同じ文を置くと書いていたが、実装 (段 B2) は
// page.tsx に置かなかった。設計書・FavoriteRecipeModal.tsx のコメントはこの事実に合わせて直したので、
// ここで事実の側を固定する: page.tsx に定義が戻る / 2 か所に重複する / 部品から消える と赤になる
// (そのときは設計書 cross/22 の 3 か所とコメントも一緒に直す)。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const FAVORITES_DIR = path.resolve(__dirname, '..', '..');
const PAGE_FILE = path.join(FAVORITES_DIR, 'page.tsx');
const COMPONENTS_DIR = path.join(FAVORITES_DIR, '_components');

/** 3 つの文の定数の名前 (cross/22 §7.12) */
const NOTICE_TEXT_NAMES = [
  'SHOPPING_LIST_ADDED_MESSAGE',
  'SHOPPING_LIST_ADD_FAILED_MESSAGE',
  'SHOPPING_LIST_NO_INGREDIENTS_MESSAGE',
] as const;

/** 文を持ってよいファイル (cross/22 §7.12: 置き場を分けるなら shopping-list-notice.ts) */
const ALLOWED_OWNER_FILES = ['FavoriteRecipeModal.tsx', 'shopping-list-notice.ts'] as const;

function definitionPattern(name: string): RegExp {
  // 宣言だけを見る (コメントの中の名前や、使う側の参照は数えない)
  return new RegExp(`^\\s*(?:export\\s+)?const\\s+${name}\\s*=`, 'm');
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('お気に入りの画面の買い物リストの知らせの文の置き場 (#2011・cross/22 §7.10 (2)・§7.12)', () => {
  const pageSource = fs.readFileSync(PAGE_FILE, 'utf8');
  const sources = listSourceFiles(FAVORITES_DIR).map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));

  it.each(NOTICE_TEXT_NAMES)('page.tsx は %s を定義しない (onNotice で受けた文を出すだけ)', (name) => {
    expect(definitionPattern(name).test(pageSource)).toBe(false);
  });

  it.each(NOTICE_TEXT_NAMES)('%s はお気に入りの画面の中で 1 か所だけ、詳細の部品の側に定義がある', (name) => {
    const owners = sources.filter(({ text }) => definitionPattern(name).test(text)).map(({ file }) => file);
    expect(owners).toHaveLength(1);
    expect(path.dirname(owners[0])).toBe(COMPONENTS_DIR);
    expect(ALLOWED_OWNER_FILES).toContain(path.basename(owners[0]));
  });
});
