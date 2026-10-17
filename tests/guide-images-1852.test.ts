// @vitest-environment node
/**
 * #1852: 使い方ガイド (/guide) が指す画面の画像が、すべて public に実在することの見張り
 *
 * 以前は src/app/guide/page.tsx が /guide/*.png を 15 枚指していたが、public/guide/ が無く、本番で 404 だった。
 * 画像はローカルの組み立てで scripts/guide-screenshots/ の台本が撮って public/guide/ に置く。
 * 同じ取りこぼし (存在しない画像を指す・撮り直しで大きさや重さが崩れる・使わない画像が残る) を、ここで止める。
 * 型は tests/metadata-public-paths-1845.test.ts と同じ (public のファイルの実在と、src/proxy.ts の matcher の外であること)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '@/proxy';
import { GUIDES, GUIDE_IMAGE_SIZE, guideImagePaths } from '@/app/guide/guide-content';

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const GUIDE_PUBLIC_DIR = path.join(PUBLIC_DIR, 'guide');
const GUIDE_SOURCE_DIR = path.join(ROOT, 'src/app/guide');

/** ガイドの章 5 つ × 手順 3 つ (Issue #1852 の 15 枚) */
const EXPECTED_IMAGE_COUNT = 15;
/** 1 枚の重さの上限 (Issue #1852 の目安。ページを開くたびに読むので軽くする) */
const GUIDE_IMAGE_MAX_BYTES = 300 * 1024;

/** PNG の先頭 8 バイト (シグネチャ) */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** IHDR チャンクの幅・高さの位置 (シグネチャ 8 + 長さ 4 + 種類 4 の後ろ) */
const PNG_IHDR_TYPE_OFFSET = 12;
const PNG_IHDR_WIDTH_OFFSET = 16;
const PNG_IHDR_HEIGHT_OFFSET = 20;
const PNG_HEADER_BYTES = 24;

/** matcher を正規表現にして判定する (tests/metadata-public-paths-1845.test.ts と同じ方法) */
function runsMiddleware(pathname: string): boolean {
  const [matcher] = config.matcher;
  return new RegExp(`^${matcher}$`).test(pathname);
}

function publicFileOf(urlPath: string): string {
  return path.join(PUBLIC_DIR, urlPath.replace(/^\//, ''));
}

/** PNG の幅と高さ (IHDR)。PNG でなければ null */
function pngSize(file: string): { width: number; height: number } | null {
  const head = fs.readFileSync(file).subarray(0, PNG_HEADER_BYTES);
  if (head.length < PNG_HEADER_BYTES || !head.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  if (head.toString('ascii', PNG_IHDR_TYPE_OFFSET, PNG_IHDR_WIDTH_OFFSET) !== 'IHDR') return null;
  return { width: head.readUInt32BE(PNG_IHDR_WIDTH_OFFSET), height: head.readUInt32BE(PNG_IHDR_HEIGHT_OFFSET) };
}

/** src/app/guide の中のソースに直に書かれた /guide/*.png (guide-content.ts 以外に書くと見張りから漏れる) */
function literalGuideImagePaths(): Array<{ file: string; urlPath: string }> {
  const found: Array<{ file: string; urlPath: string }> = [];
  for (const name of fs.readdirSync(GUIDE_SOURCE_DIR)) {
    if (!/\.(ts|tsx)$/.test(name)) continue;
    const source = fs.readFileSync(path.join(GUIDE_SOURCE_DIR, name), 'utf8');
    for (const match of source.matchAll(/["'`](\/guide\/[^"'`]+\.png)["'`]/g)) {
      found.push({ file: name, urlPath: match[1] });
    }
  }
  return found;
}

describe('#1852 使い方ガイドの画像', () => {
  const paths = guideImagePaths();

  it('見張りの対象を拾えている (5 章 × 3 手順 = 15 枚・重複なし)', () => {
    expect(GUIDES).toHaveLength(5);
    expect(GUIDES.flatMap((guide) => guide.steps)).toHaveLength(EXPECTED_IMAGE_COUNT);
    expect(paths).toHaveLength(EXPECTED_IMAGE_COUNT);
    expect(paths).toEqual(expect.arrayContaining(['/guide/signup.png', '/guide/analyze.png', '/guide/badge-collection.png']));
  });

  it('ガイドの画像のパスは guide-content.ts にだけ書かれている', () => {
    const outside = literalGuideImagePaths().filter(({ file }) => file !== 'guide-content.ts');
    expect(outside, 'ページなどに直に書いたパスは見張りから漏れる。guide-content.ts の GUIDES に書くこと').toEqual([]);
  });

  it('すべて public/guide/ に実在する', () => {
    const missing = paths.filter((urlPath) => {
      const file = publicFileOf(urlPath);
      return !(fs.existsSync(file) && fs.statSync(file).isFile());
    });
    expect(missing, '存在しない画像を指している。scripts/guide-screenshots/run.sh で撮って public/guide/ に置くこと').toEqual([]);
  });

  it('すべて PNG で、大きさは GUIDE_IMAGE_SIZE・重さは上限以下', () => {
    for (const urlPath of paths) {
      const file = publicFileOf(urlPath);
      expect(pngSize(file), `${urlPath} の大きさ`).toEqual(GUIDE_IMAGE_SIZE);
      expect(fs.statSync(file).size, `${urlPath} の重さ (バイト)`).toBeLessThanOrEqual(GUIDE_IMAGE_MAX_BYTES);
    }
  });

  it('public/guide/ にガイドが使わない画像が残っていない', () => {
    const referenced = new Set<string>(paths);
    const files = fs.existsSync(GUIDE_PUBLIC_DIR) ? fs.readdirSync(GUIDE_PUBLIC_DIR) : [];
    const unused = files.filter((name) => !referenced.has(`/guide/${name}`));
    expect(unused, 'ガイドが指していないファイル。消すか、GUIDES から指すこと').toEqual([]);
  });

  it('すべて src/proxy.ts の matcher の外 (未ログインの訪問者にもログイン画面ではなく画像が返る)', () => {
    expect(paths.filter((urlPath) => runsMiddleware(urlPath))).toEqual([]);
  });

  it('見張りの判定そのものが働く (PNG でないファイル・matcher の対象のパス)', () => {
    expect(pngSize(path.join(PUBLIC_DIR, 'icon.svg'))).toBeNull();
    expect(runsMiddleware('/guide')).toBe(true);
    expect(runsMiddleware('/guide/signup.png')).toBe(false);
  });
});
