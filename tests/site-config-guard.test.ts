/**
 * #1194 送信元・問い合わせ先・サイトの URL を「1 か所」に保つためのソース走査 contract テスト
 *
 * 以前は、送信元 (noreply@homegohan.app)・問い合わせ先 (support@homegohan.app / support@homegohan.jp)・サイトの URL
 * (https://homegohan.app) が、メールの文面 14 本・お問い合わせ API・招待画面・ページのメタ情報・モバイルの設定画面などに
 * 直接書かれていた。しかも .app / .jp / .com の 3 つのドメインに食い違い、どのドメインも実在しない (または別のサービスを指す) ため、
 * ドメインを切り替えるたびに、取りこぼしが出た (モバイルの利用規約・プライバシーポリシーのリンクは、開いても何も表示されなかった)。
 *
 * いまは値を src/lib/site-config.ts (Web) と apps/mobile/src/lib/siteConfig.ts (モバイル) の既定値 1 か所ずつにまとめ、
 * homegohan.com への切り替えは環境変数だけで行う (docs/operations/email-domain.md)。
 *
 * このテストは src/ と apps/mobile/ の全ファイルを読み、次のドメイン表記が直接書かれていないことを確かめる:
 *   '@homegohan.app'  '@homegohan.jp'  'https://homegohan.app'  'https://homegohan.jp'
 * 許すのは、既定値の定数そのものと、既定値を固定するテストだけ (ALLOWED_FILES)。
 * 落ちたときは、ドメインを書かずに getSiteUrl() / getEmailFrom() / getSupportEmail() (Web) か
 * getSupportEmail() / getTermsUrl() / getPrivacyUrl() (モバイル) を呼ぶ。テストの期待値には、定数 (DEFAULT_*) か
 * example.test のような例示用のドメインを使う。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EMAIL_FROM, DEFAULT_SITE_URL, DEFAULT_SUPPORT_EMAIL } from '@/lib/site-config';
import { DEFAULT_SUPPORT_EMAIL as MOBILE_DEFAULT_SUPPORT_EMAIL } from '../apps/mobile/src/lib/siteConfig';
import { DEFAULT_WEB_URL as MOBILE_DEFAULT_WEB_URL } from '../apps/mobile/src/lib/webBaseUrl';

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['src', 'apps/mobile'];
/** 読まないフォルダ (依存・ビルド成果物・ネイティブのプロジェクト) */
const SKIP_DIRS = new Set(['node_modules', '.expo', '.next', 'ios', 'android', 'dist', 'build', 'coverage', '.git']);
/** 読むファイル (テキスト)。画像などのバイナリは読まない */
const TEXT_FILE = /(?:\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|ya?ml|html|css|txt|svg)|env\.example)$/i;

/**
 * 直接書いてはいけない表記。
 * - '@homegohan.app' / '@homegohan.jp': メールアドレス (送信元・問い合わせ先)
 * - 'https://homegohan.app' / 'https://homegohan.jp': サイトの URL (www. 付きと http:// も含む)
 * 'com.homegohan.app' (アプリの識別子) や 'https://homegohan-app.vercel.app' (実際の URL) は対象外。
 */
const FORBIDDEN = /@homegohan\.(?:app|jp)\b|https?:\/\/(?:www\.)?homegohan\.(?:app|jp)\b/i;

/** 既定値の定数そのものと、既定値を固定するテスト。ここだけは直接書いてよい */
const ALLOWED_FILES: Record<string, string> = {
  'src/lib/site-config.ts': 'Web の既定値 (DEFAULT_EMAIL_FROM / DEFAULT_SUPPORT_EMAIL)',
  'apps/mobile/src/lib/siteConfig.ts': 'モバイルの既定値 (DEFAULT_SUPPORT_EMAIL)',
  'src/__tests__/lib/site-config.test.ts': '既定値が「いま動いている値」のままであることを固定するテスト',
};

/**
 * 別の PR が書き換え中のため、一時的に許すファイル。その PR が getSupportEmail() に置き換えたら、ここから消す
 * (消し忘れは下のテストが「もう書かれていない」と知らせる)。
 */
const PENDING_FILES: Record<string, string> = {
  'src/app/(main)/settings/page.tsx':
    'PR #1079 (孤立ネイティブ画面の導線) が設定画面を SettingsPageClient.tsx に移す。移した先で getSupportEmail() にする',
};

/** 本文からの禁止表記の位置 (1 始まりの行番号と、その行) */
function findForbidden(content: string): Array<{ line: number; text: string }> {
  const hits: Array<{ line: number; text: string }> = [];
  content.split('\n').forEach((text, index) => {
    if (FORBIDDEN.test(text)) hits.push({ line: index + 1, text: text.trim().slice(0, 120) });
  });
  return hits;
}

function collectFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...collectFiles(full));
    } else if (entry.isFile() && TEXT_FILE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const hitsByFile = new Map<string, Array<{ line: number; text: string }>>();
let scannedFileCount = 0;
for (const scanRoot of SCAN_ROOTS) {
  for (const file of collectFiles(path.join(ROOT, scanRoot))) {
    scannedFileCount += 1;
    const hits = findForbidden(fs.readFileSync(file, 'utf8'));
    if (hits.length > 0) hitsByFile.set(path.relative(ROOT, file).split(path.sep).join('/'), hits);
  }
}

const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('送信元・問い合わせ先・サイトの URL は 1 か所 (#1194): リポジトリのソース', () => {
  it('走査が機能している: 既定値の定数 (許可したファイル) の中の表記を検出する', () => {
    // 走査が壊れて何も見つけられなくなったときに、下の contract が空振りで通ってしまわないようにする
    expect(scannedFileCount).toBeGreaterThan(300);
    for (const file of Object.keys(ALLOWED_FILES)) {
      expect(hitsByFile.has(file), `${file} から禁止表記を検出できない (走査が壊れている、または既定値の書き方が変わった)`).toBe(true);
    }
  });

  it('@homegohan.app / @homegohan.jp / https://homegohan.app を直接書かない (既定値の定数と、それを固定するテストを除く)', () => {
    const offenders = [...hitsByFile.entries()]
      .filter(([file]) => !(file in ALLOWED_FILES) && !(file in PENDING_FILES))
      .flatMap(([file, hits]) => hits.map((hit) => `${file}:${hit.line}  ${hit.text}`));

    expect(
      offenders,
      '送信元・問い合わせ先・サイトの URL を直接書かず、Web は src/lib/site-config.ts の getEmailFrom() / getSupportEmail() / getSiteUrl()、' +
        'モバイルは apps/mobile/src/lib/siteConfig.ts の getSupportEmail() / getTermsUrl() / getPrivacyUrl() を使うこと。' +
        'テストの期待値には DEFAULT_* の定数か example.test のような例示用のドメインを使う:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('一時的に許しているファイルに、まだ禁止表記が残っている (置き換えが済んだら PENDING_FILES から外す)', () => {
    for (const [file, reason] of Object.entries(PENDING_FILES)) {
      expect(fs.existsSync(path.join(ROOT, file)), `${file} が無い。PENDING_FILES から外す (${reason})`).toBe(true);
      expect(
        hitsByFile.has(file),
        `${file} にはもう禁止表記が無い。PENDING_FILES から外すこと (${reason})`,
      ).toBe(true);
    }
  });
});

describe('既定値は Web とモバイルで同じ', () => {
  it('問い合わせ先の既定値が同じ', () => {
    expect(MOBILE_DEFAULT_SUPPORT_EMAIL).toBe(DEFAULT_SUPPORT_EMAIL);
  });

  it('モバイルが WebView で開く Web の既定の URL が、Web のサイトの URL の既定値と同じ (古いアプリのビルドが読み込む URL)', () => {
    expect(MOBILE_DEFAULT_WEB_URL).toBe(DEFAULT_SITE_URL);
  });

  it('送信元の既定値は、問い合わせ先の既定値と同じドメイン (片方だけ切り替わって食い違うのを防ぐ)', () => {
    const fromDomain = /<[^@]+@([^>]+)>/.exec(DEFAULT_EMAIL_FROM)?.[1];
    expect(fromDomain).toBeDefined();
    expect(DEFAULT_SUPPORT_EMAIL.endsWith(`@${fromDomain}`)).toBe(true);
  });
});

describe('設定の説明が、コードの環境変数名と合っている', () => {
  it('.env.example に Web の 3 つの環境変数が載っている', () => {
    const example = read('.env.example');
    for (const name of ['NEXT_PUBLIC_APP_URL', 'EMAIL_FROM', 'NEXT_PUBLIC_SUPPORT_EMAIL']) {
      expect(example, `.env.example に ${name} の説明が無い`).toMatch(new RegExp(`^#?\\s*${name}=`, 'm'));
    }
  });

  it('apps/mobile/env.example にモバイルの環境変数が載っている', () => {
    const example = read('apps/mobile/env.example');
    expect(example).toMatch(/^#?\s*EXPO_PUBLIC_SUPPORT_EMAIL=/m);
  });

  it('運用手順 (docs/operations/email-domain.md) に、切り替えで設定する環境変数がすべて載っている', () => {
    const doc = read('docs/operations/email-domain.md');
    for (const name of [
      'NEXT_PUBLIC_APP_URL',
      'EMAIL_FROM',
      'NEXT_PUBLIC_SUPPORT_EMAIL',
      'NEXT_PUBLIC_INVITE_BASE_URL',
      'SUPPORT_REPLY_TO',
      'EXPO_PUBLIC_SUPPORT_EMAIL',
      'EXPO_PUBLIC_WEB_URL',
      'ALLOWED_ORIGINS',
    ]) {
      expect(doc, `docs/operations/email-domain.md に ${name} の説明が無い`).toContain(name);
    }
  });
});

describe('禁止表記の判定ロジック', () => {
  it('メールアドレスとサイトの URL (.app / .jp) を検出する', () => {
    for (const text of [
      "from: 'ほめゴハン <noreply@homegohan.app>'",
      'href="mailto:support@homegohan.jp"',
      'Linking.openURL("https://homegohan.app/terms")',
      'https://www.homegohan.app/',
      'http://homegohan.jp',
      'SUPPORT@HOMEGOHAN.APP',
    ]) {
      expect(findForbidden(text), text).toHaveLength(1);
    }
  });

  it('許すもの: homegohan.com・実際の URL (vercel.app)・アプリの識別子 (com.homegohan.app)・例示用のドメイン', () => {
    for (const text of [
      'support@homegohan.com',
      'https://homegohan.com',
      'https://homegohan-app.vercel.app',
      'appId: com.homegohan.app',
      'bundleIdentifier: "com.homegohan.app"',
      'https://evil.homegohan.app',
      'support@example.test',
    ]) {
      expect(findForbidden(text), text).toEqual([]);
    }
  });

  it('行番号を返す', () => {
    expect(findForbidden('a\nb\nmailto:support@homegohan.jp\nd')).toEqual([
      { line: 3, text: 'mailto:support@homegohan.jp' },
    ]);
  });
});
