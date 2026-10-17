/**
 * 撮った画面 (shoot.pw.ts が .guide-shots/raw に置く PNG) を、ガイドの表示の大きさに縮め、色数を減らした PNG にして
 * public/guide/ に置く (#1852)。run.sh から呼ぶ。
 *
 *   npx --yes tsx@4 scripts/guide-screenshots/optimize.ts
 *
 * 大きさは src/app/guide/guide-content.ts の GUIDE_IMAGE_SIZE。重さが GUIDE_IMAGE_MAX_BYTES を超えたら、色数を減らして
 * 作り直す。それでも超えたら失敗で止める (tests/guide-images-1852.test.ts と同じ上限)。
 * 縮めるのは sharp (next の optionalDependencies。npm ci で入る) を使う。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';
import { GUIDE_IMAGE_SIZE, guideImagePaths } from '../../src/app/guide/guide-content';

const ROOT = path.resolve(__dirname, '..', '..');
const RAW_DIR = path.resolve(ROOT, process.env.GUIDE_SHOTS_RAW_DIR ?? path.join('.guide-shots', 'raw'));
const OUT_DIR = path.join(ROOT, 'public', 'guide');
/** 1 枚の重さの上限 (tests/guide-images-1852.test.ts の GUIDE_IMAGE_MAX_BYTES と同じ) */
const GUIDE_IMAGE_MAX_BYTES = 300 * 1024;
/** 試す色数 (多い順)。画面の絵は色が少ないので、たいてい最初で収まる */
const PALETTE_COLOURS = [256, 192, 128, 96];
/** 色数を減らすときの品質 (0〜100) と、圧縮の手間 (1〜10。大きいほど小さくなる) */
const PALETTE_QUALITY = 90;
const PNG_EFFORT = 10;
const PNG_COMPRESSION_LEVEL = 9;

async function optimizeOne(name: string): Promise<{ bytes: number; colours: number }> {
  const source = path.join(RAW_DIR, name);
  if (!fs.existsSync(source)) throw new Error(`撮った画像が無い: ${source}`);
  for (const colours of PALETTE_COLOURS) {
    const buffer = await sharp(source)
      .resize(GUIDE_IMAGE_SIZE.width, GUIDE_IMAGE_SIZE.height, { fit: 'cover', position: 'top' })
      .png({ palette: true, colours, quality: PALETTE_QUALITY, effort: PNG_EFFORT, compressionLevel: PNG_COMPRESSION_LEVEL })
      .toBuffer();
    if (buffer.length <= GUIDE_IMAGE_MAX_BYTES) {
      fs.writeFileSync(path.join(OUT_DIR, name), buffer);
      return { bytes: buffer.length, colours };
    }
  }
  throw new Error(`${name} を ${GUIDE_IMAGE_MAX_BYTES} バイト以下にできない`);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const urlPath of guideImagePaths()) {
    const name = path.basename(urlPath);
    const { bytes, colours } = await optimizeOne(name);
    console.log(`${name}\t${bytes} バイト\t${colours} 色`);
  }
})().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
