/**
 * billing/03 §10.6 (billing/01 §10.4・R11 を改めたもの): アプリの有料プランの購入はアプリ内課金 (App Store / Google Play) で、
 * アプリの画面「プランとお支払い」(app/settings/plan.tsx) で行う。アプリの画面から Web の購入のページ (/pricing・/account/billing) へは
 * 誘導しない (ストアの審査の要件。Web で申し込んだ契約も、アプリには「Web の画面から行えます」の文だけを出し、リンクは出さない。R16)。
 *
 * 以前はアプリに料金の画面 (app/(public)/pricing.tsx) があり、「Web版を開く」で Web の /pricing を外部のブラウザで開いていた。
 * 外部のブラウザには is_native_app の Cookie が無いので、/pricing は価格と「月額で始める」の CTA を描く
 * = アプリから Web での購入へ誘導することになる。料金の画面と入口のリンクを消したので、書き戻されないように見張る。
 *
 * 走査: app/ と src/ の .ts / .tsx に、'/pricing' と '/account/billing' の文字列 (webPath="/pricing"・href: "/pricing"・
 * webPageUrl('/pricing') の形を含む) が無いこと。拾い方が壊れて 0 件で通らないよう、同じ走査で about の webPath は拾えることも見る。
 */

import fs from 'fs';
import path from 'path';

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const APP_DIR = path.join(MOBILE_ROOT, 'app');
const SOURCE_DIRS = [APP_DIR, path.join(MOBILE_ROOT, 'src')];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** Web の購入のページのパス (billing/01 §10.4)。後ろが英数字・ハイフンで続く別のパス (/pricing-x など) には当てない */
const WEB_PURCHASE_PATH_PATTERN = /\/(?:pricing|account\/billing)(?![A-Za-z0-9_-])/;
/** 拾い方の確認に使う、残した公開ページの書き方 (app/(public)/about.tsx) */
const ABOUT_WEB_PATH_PATTERN = /webPath="\/about"/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/** 行ごとに正規表現に当たる箇所を「ファイル:行番号: 行」で返す */
function findLines(files: string[], pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${path.relative(MOBILE_ROOT, file)}:${index + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

describe('billing/01 §10.4: アプリから Web の購入のページを開かない', () => {
  it('no screen or module under apps/mobile/app and apps/mobile/src opens the Web purchase pages (/pricing, /account/billing) and the pricing screen app/(public)/pricing.tsx does not exist', () => {
    const files = SOURCE_DIRS.flatMap((dir) => walk(dir));

    // 拾い方が壊れて 0 件で通らないように: 同じ走査で、残した公開ページ (about) の webPath は拾える
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain(path.join(APP_DIR, '(public)', 'about.tsx'));
    expect(findLines(files, ABOUT_WEB_PATH_PATTERN)).toHaveLength(1);

    // 購入のページへのパスは 1 つも無い
    expect(findLines(files, WEB_PURCHASE_PATH_PATTERN)).toEqual([]);

    // 料金の画面は消した
    expect(fs.existsSync(path.join(APP_DIR, '(public)', 'pricing.tsx'))).toBe(false);
  });

  it('走査の正規表現は、購入のページの書き方 (webPath・href・webPageUrl) に当たり、別のパスには当たらない', () => {
    for (const source of ['<PublicPage title="料金" webPath="/pricing">', '{ href: "/pricing", label: "料金" }', "webPageUrl('/pricing')", "Linking.openURL(webPageUrl('/account/billing'))", '"/account/billing/checkout"']) {
      expect(WEB_PURCHASE_PATH_PATTERN.test(source)).toBe(true);
    }
    for (const source of ['webPath="/about"', '"/pricing-guide"', '"/account/settings"']) {
      expect(WEB_PURCHASE_PATH_PATTERN.test(source)).toBe(false);
    }
  });
});
