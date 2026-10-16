// @vitest-environment node
/**
 * #1365 段 1: 保存された写真の URL を、署名付き URL を通さずに画面へ出していないかのソース走査
 *
 * 食事写真・冷蔵庫写真 (meal_photos / fridge-images) のバケットは非公開 (段 2)。DB に保存された公開 URL と同じ形の文字列を
 * そのまま <Image src> / <img src> / <Image source={{ uri }}> に渡すと表示できない。
 * 画面は SignedPhotoImage (Web: src/components/photo/SignedPhotoImage.tsx。モバイルの apps/mobile/src/components/photo/SignedPhotoImage.tsx は #1598 で消した。
 * 使っていた食事の詳細・週の献立のネイティブの画面と一緒に消した。アプリの写真は WebView の Web の画面が出す)
 * を使い、サーバーが本人の写真だと確かめて署名した URL を表示する。
 *
 * 見るもの: 本番の .tsx (src・apps/mobile/app・apps/mobile/src) の JSX の Image / img 要素の src / source 属性に、
 * 保存された写真の URL を表す名前 (image_url・imageUrl・photo_url・photoUrl・content_url (運営の審査の写真)) が書かれていないこと。
 * 例外は下の ALLOWED (理由つき)。
 *
 * 限界 (見張りであって証明ではない): 名前の違う変数 (preview・uri など) に入れ替えてから渡すもの、
 * Image / img 以外の部品 (背景画像の style など) に渡すものは見つけられない。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['src', 'apps/mobile/app', 'apps/mobile/src'];
const RAW_IMAGE_TAGS = new Set(['Image', 'img']);
const SOURCE_ATTRIBUTES = new Set(['src', 'source']);
const STORED_PHOTO_URL_NAME = /(image_?url|photo_?url|content_?url)/i;

/** 例外 (ファイル → 理由)。ここに足すときは、署名付き URL を通さなくてよい理由を書く */
const ALLOWED: Record<string, string> = {
  'src/app/admin/moderation/page.tsx':
    'content_url は運営の API (/api/admin/moderation*) がサーバーで署名してから返す (withSignedModerationContentUrls。tests/moderation-photo-signing.test.ts が確かめる)',
  'src/app/admin/moderation/[type]/[id]/page.tsx':
    'content_url は運営の API (/api/admin/moderation/[type]/[id]) がサーバーで署名してから返す (withSignedModerationContentUrls。tests/moderation-photo-signing.test.ts が確かめる)',
  'src/app/(main)/health/checkups/[id]/CheckupDetailClient.tsx':
    '健康診断の画像は別のバケット (health-checkups。もとから非公開) で、#1365 の 2 つのバケットの対象外',
  // (apps/mobile/app/health/checkups/[id].tsx の行は、画面ごと消したので除いた。#1598)
};

function listTsxFiles(dir: string): string[] {
  const absolute = path.join(ROOT, dir);
  if (!fs.existsSync(absolute)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      result.push(...listTsxFiles(relative));
    } else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) {
      result.push(relative);
    }
  }
  return result;
}

interface Finding {
  file: string;
  line: number;
  text: string;
}

function findRawStoredPhotoSources(file: string): Finding[] {
  const source = fs.readFileSync(path.isAbsolute(file) ? file : path.join(ROOT, file), 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && RAW_IMAGE_TAGS.has(node.tagName.getText(sf))) {
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute) || !SOURCE_ATTRIBUTES.has(attribute.name.getText(sf))) continue;
        const text = attribute.initializer?.getText(sf) ?? '';
        if (STORED_PHOTO_URL_NAME.test(text)) {
          findings.push({ file, line: sf.getLineAndCharacterOfPosition(attribute.getStart(sf)).line + 1, text });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

describe('#1365 保存された写真の URL は SignedPhotoImage を通して表示する', () => {
  const files = SCAN_ROOTS.flatMap(listTsxFiles);

  it('走査の対象が見つかる (走査そのものが空回りしていない)', () => {
    expect(files).toContain('src/app/(main)/meals/[id]/page.tsx');
    // (以前はモバイルの食事の詳細 apps/mobile/app/meals/[id].tsx を見ていた。#1598 で消したので、残した画面を見る)
    expect(files).toContain('apps/mobile/app/health/blood-tests.tsx');
  });

  it('Image / img の src / source に保存された写真の URL を直接渡していない', () => {
    const findings = files.filter((file) => !(file in ALLOWED)).flatMap(findRawStoredPhotoSources);
    expect(findings).toEqual([]);
  });

  it('例外の一覧は、いまも実際に該当する書き方があるファイルだけ (古い例外を残さない)', () => {
    const stale = Object.keys(ALLOWED).filter((file) => !fs.existsSync(path.join(ROOT, file)) || findRawStoredPhotoSources(file).length === 0);
    expect(stale).toEqual([]);
  });

  it('見張りが実際に捕まえる (書き換えた例で確かめる)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signed-photo-scan-'));
    try {
      const sample = path.join(tmpDir, 'sample.tsx');
      fs.writeFileSync(
        sample,
        'export const A = ({ meal }: { meal: { image_url: string } }) => <><img src={meal.image_url} alt="" /><Image source={{ uri: meal.image_url }} /></>;\n',
      );
      expect(findRawStoredPhotoSources(sample)).toHaveLength(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
