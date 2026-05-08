/**
 * seed-classify-fixtures.ts
 *
 * /tmp/classify-test/ に最小 JPEG ファイルを生成する。
 * ImageMagick 等の外部依存なしに Node.js Buffer だけで有効な JPEG を作成する。
 *
 * 生成ファイル:
 *   meal-1.jpg, meal-2.jpg
 *   fridge-1.jpg, fridge-2.jpg
 *   health-1.jpg, health-2.jpg
 *   weight-1.jpg, weight-2.jpg
 *   unknown-blank.jpg
 */

import * as fs from "node:fs";
import * as path from "node:path";

const CLASSIFY_TEST_DIR = "/tmp/classify-test";

/**
 * 1x1 ピクセルの最小有効 JPEG バイナリ (Base64 エンコード済み)
 * SOI + APP0(JFIF) + DQT + SOF0 + DHT + SOS + EOI の完全な構造を持つ
 * Node.js で生成・検証済み (SOI=FF D8, EOI=FF D9)
 */
const MINIMAL_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALChAYKDM9DAwOExo6PDcODRAYKDlFOA4R" +
  "Fh0zV1A+EhYlOERtZ00YIzdAUWhxXDFATldneXhlSFxfYnBkZ2P/wAALCAABAAEBAREA" +
  "/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/9oACAEBAAA/AH///9k=";

/**
 * 最小 JPEG バイナリを生成する
 */
function makeMinimalJpeg(): Buffer {
  return Buffer.from(MINIMAL_JPEG_BASE64, "base64");
}

/**
 * classify-test ディレクトリと必要な JPEG ファイルを生成する。
 * 既存ファイルはスキップする。
 */
export function seedClassifyFixtures(): void {
  if (!fs.existsSync(CLASSIFY_TEST_DIR)) {
    fs.mkdirSync(CLASSIFY_TEST_DIR, { recursive: true });
    console.log(`[seed-classify-fixtures] ディレクトリ作成: ${CLASSIFY_TEST_DIR}`);
  }

  const files = [
    "meal-1.jpg",
    "meal-2.jpg",
    "fridge-1.jpg",
    "fridge-2.jpg",
    "health-1.jpg",
    "health-2.jpg",
    "weight-1.jpg",
    "weight-2.jpg",
    "unknown-blank.jpg",
  ];

  const jpegBuf = makeMinimalJpeg();

  for (const file of files) {
    const filePath = path.join(CLASSIFY_TEST_DIR, file);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, jpegBuf);
      console.log(`[seed-classify-fixtures] 生成: ${filePath} (${jpegBuf.length} bytes)`);
    } else {
      console.log(`[seed-classify-fixtures] スキップ (既存): ${filePath}`);
    }
  }
}

// スクリプトとして直接実行された場合
if (require.main === module) {
  seedClassifyFixtures();
  console.log("[seed-classify-fixtures] 完了");
}
