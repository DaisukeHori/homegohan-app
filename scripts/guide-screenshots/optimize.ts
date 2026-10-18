/**
 * 撮った画面 (shoot.pw.ts が .guide-shots/raw に置く PNG) を、表示の大きさに縮め、色数を減らした PNG にして置く (#1852・#1867 段 0)。
 * run.sh から呼ぶ。
 *
 *   npx --yes tsx@4 scripts/guide-screenshots/optimize.ts
 *
 * - 使い方ガイドの画像 (src/app/guide/guide-content.ts の 15 枚) → <置き場>/guide/<名前>.png (GUIDE_IMAGE_SIZE)
 * - 紹介ページの新しい画面 (src/components/marketing/landing-screens.ts の LANDING_SCREENS 6 枚) → <置き場>/marketing/screens/<名前>.png
 *   (ガイドの画像と同じ GUIDE_IMAGE_SIZE)
 * - 紹介ページの拡大の画像 (同じく LANDING_ZOOMS 2 枚) → <置き場>/marketing/screens/<名前>.png (LANDING_ZOOMS の width × height)
 * <置き場> は GUIDE_SHOTS_PUBLIC_DIR (既定 public)。置き換える画像だけを選んで持ち帰るときは、git の管理外の置き場
 * (例 .guide-shots/public) を渡す (run.sh の先頭のコメント)。
 * 重さが IMAGE_MAX_BYTES を超えたら、色数を減らして作り直す。それでも超えたら失敗で止める
 * (tests/guide-images-1852.test.ts と tests/landing-page-1867.test.ts の U-4 と同じ上限)。
 * 縮めるのは sharp (next の optionalDependencies。npm ci で入る) を使う。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';
import { GUIDE_IMAGE_SIZE, guideImagePaths } from '../../src/app/guide/guide-content';
import { LANDING_SCREENS, LANDING_SCREENS_DIR, LANDING_ZOOMS } from '../../src/components/marketing/landing-screens';

const ROOT = path.resolve(__dirname, '..', '..');
const RAW_DIR = path.resolve(ROOT, process.env.GUIDE_SHOTS_RAW_DIR ?? path.join('.guide-shots', 'raw'));
/** 縮めた画像の置き場の根 (public/ に当たる場所) */
const PUBLIC_DIR = path.resolve(ROOT, process.env.GUIDE_SHOTS_PUBLIC_DIR ?? 'public');
const GUIDE_OUT_DIR = path.join(PUBLIC_DIR, 'guide');
/** 紹介ページの画面と拡大の画像の置き場 (LANDING_SCREENS_DIR = /marketing/screens を、置き場の根の下に) */
const LANDING_OUT_DIR = path.join(PUBLIC_DIR, ...LANDING_SCREENS_DIR.split('/').filter(Boolean));
/** 1 枚の重さの上限 (tests/guide-images-1852.test.ts の GUIDE_IMAGE_MAX_BYTES・U-4 の上限と同じ) */
const IMAGE_MAX_BYTES = 300 * 1024;
/** 試す色数 (多い順)。画面の絵は色が少ないので、たいてい最初で収まる */
const PALETTE_COLOURS = [256, 192, 128, 96];
/** 色数を減らすときの品質 (0〜100) と、圧縮の手間 (1〜10。大きいほど小さくなる) */
const PALETTE_QUALITY = 90;
const PNG_EFFORT = 10;
const PNG_COMPRESSION_LEVEL = 9;

interface Target {
  /** 撮った画像の名前 (.guide-shots/raw/<名前>) と、置く名前 */
  name: string;
  outDir: string;
  width: number;
  height: number;
  /**
   * 縮め方。cover = 縦横比を保って上の端を合わせ、はみ出した下を切る (縦に長い 1 画面分の画面。これまでのガイドの画像と同じ)。
   * fill = 枠の大きさに合わせる (拡大の画像。撮るときに枠と同じ縦横比で切り出しているので、ゆがみは丸めの 1 画素未満)
   */
  fit: 'cover' | 'fill';
}

async function optimizeOne(target: Target): Promise<{ bytes: number; colours: number }> {
  const source = path.join(RAW_DIR, target.name);
  if (!fs.existsSync(source)) throw new Error(`撮った画像が無い: ${source}`);
  for (const colours of PALETTE_COLOURS) {
    const buffer = await sharp(source)
      .resize(target.width, target.height, { fit: target.fit, position: 'top' })
      .png({ palette: true, colours, quality: PALETTE_QUALITY, effort: PNG_EFFORT, compressionLevel: PNG_COMPRESSION_LEVEL })
      .toBuffer();
    if (buffer.length <= IMAGE_MAX_BYTES) {
      fs.writeFileSync(path.join(target.outDir, target.name), buffer);
      return { bytes: buffer.length, colours };
    }
  }
  throw new Error(`${target.name} を ${IMAGE_MAX_BYTES} バイト以下にできない`);
}

/** 縮める画像の一覧 (ガイド 15 枚 → 紹介ページの画面 6 枚 → 拡大の画像 2 枚の順) */
function targets(): Target[] {
  const guide = guideImagePaths().map((urlPath): Target => ({
    name: path.basename(urlPath),
    outDir: GUIDE_OUT_DIR,
    width: GUIDE_IMAGE_SIZE.width,
    height: GUIDE_IMAGE_SIZE.height,
    fit: 'cover',
  }));
  const screens = LANDING_SCREENS.map((screen): Target => ({
    name: path.basename(screen.src),
    outDir: LANDING_OUT_DIR,
    width: GUIDE_IMAGE_SIZE.width,
    height: GUIDE_IMAGE_SIZE.height,
    fit: 'cover',
  }));
  const zooms = LANDING_ZOOMS.map((zoom): Target => ({
    name: path.basename(zoom.src),
    outDir: LANDING_OUT_DIR,
    width: zoom.width,
    height: zoom.height,
    fit: 'fill',
  }));
  return [...guide, ...screens, ...zooms];
}

(async () => {
  fs.mkdirSync(GUIDE_OUT_DIR, { recursive: true });
  fs.mkdirSync(LANDING_OUT_DIR, { recursive: true });
  for (const target of targets()) {
    const { bytes, colours } = await optimizeOne(target);
    console.log(`${path.relative(ROOT, path.join(target.outDir, target.name))}\t${bytes} バイト\t${colours} 色`);
  }
})().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
