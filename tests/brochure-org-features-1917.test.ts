// @vitest-environment node
/**
 * BROCHURE.md の組織・企業向けの機能の書き方が、実装の事実と合うことの contract テスト (ソース走査)
 *
 * #1917 の続き (docs-1023b) で、BROCHURE §10 の 10-1・10-3・10-5 (集計・部門別の統計・レポート) を実装の事実に合わせたが、
 * すぐ隣の 10-2 (部門への所属設定・アクティブ状況の確認) と 10-4 (部門対抗チャレンジ・表彰機能) に、
 * 実装の無い機能が残った (R1 指摘 1)。直した 10-1 が「部門別の統計は提供していない」と書くのに、
 * 10-4 が部門対抗チャレンジを宣伝する、という食い違いになっていた。
 *
 * ここでは 2 つを確かめる:
 *   1. BROCHURE の組織の節・法人の表・導入事例で、実装の無い機能の語を含む行は、
 *      どれも「現在は提供していません」と書く (宣伝の行として残っていない)
 *   2. その語が「無い」と言える実装の事実 (部門への所属を書く処理が無い・表彰 / 対抗の機能が無い・
 *      レポートの route が無い・メンバーの一覧に活動状況の列が無い) と、残した「ランキング表示」の根拠
 *      (参加者の順位表) がまだ成り立つ。実装が足されたらここが赤になり、BROCHURE を書き直す合図になる
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

const BROCHURE = 'BROCHURE.md';
const NOT_OFFERED = '現在は提供していません';

/** 実装の無い機能を表す語 (BROCHURE のこれらを含む行は「現在は提供していません」と書く) */
const UNIMPLEMENTED_TERMS = [
  '部門別の統計',
  '部門への所属設定',
  'アクティブ状況の確認',
  '部門対抗',
  '表彰',
  '部門間比較',
  '健康データを可視化',
  '健康データの集計',
  '一元管理',
  'レポート出力',
] as const;

/** start で始まる行から、次の end に当たる行の手前まで (start の行は含む) */
function section(text: string, start: string, end: RegExp): string[] {
  const lines = text.split('\n');
  const from = lines.findIndex((line) => line.startsWith(start));
  expect(from, `${BROCHURE} に「${start}」で始まる行がある`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(from + 1);
  const to = rest.findIndex((line) => end.test(line));
  expect(to, `${BROCHURE} の「${start}」の節に終わりがある`).toBeGreaterThan(0);
  return [lines[from], ...rest.slice(0, to)];
}

/** dir の下のファイル (拡張子が exts のどれか) を再帰で集める (リポジトリのルートからの相対パス) */
function listFiles(dir: string, exts: readonly string[]): string[] {
  const absolute = path.join(ROOT, dir);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listFiles(relative, exts);
    return exts.some((ext) => entry.name.endsWith(ext)) ? [relative] : [];
  });
}

const isTestFile = (file: string): boolean => /(^|\/)__tests__\//.test(file) || /\.test\.tsx?$/.test(file);

/** ブロックコメントと行コメントを取り除く (コメントの中の語を実装と数えない) */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SOURCE_EXTS = ['.ts', '.tsx'] as const;

describe('BROCHURE の組織の機能の行 (#1917 docs-1023b の R1 指摘 1)', () => {
  const brochure = read(BROCHURE);
  const orgSection = section(brochure, '### 10. 組織・企業向け機能', /^### 11\. /);
  const caseStudies = section(brochure, '## 💼 導入事例', /^## /);
  const corporateRow = brochure.split('\n').filter((line) => line.startsWith('| **企業** |'));

  it('§10 は 10-1〜10-4 の 4 つの小節だけ (実装の無いレポート出力の小節は無い)', () => {
    expect(orgSection.filter((line) => line.startsWith('#### 10-')).map((line) => line.slice(0, '#### 10-1'.length))).toEqual([
      '#### 10-1',
      '#### 10-2',
      '#### 10-3',
      '#### 10-4',
    ]);
  });

  it('§10・法人の表の企業の行・導入事例で、実装の無い機能の語を含む行は「現在は提供していません」と書く', () => {
    expect(corporateRow, '法人の表に企業の行がちょうど 1 行ある').toHaveLength(1);
    const offending = [...orgSection, ...corporateRow, ...caseStudies].filter(
      (line) => UNIMPLEMENTED_TERMS.some((term) => line.includes(term)) && !line.includes(NOT_OFFERED),
    );
    expect(offending).toEqual([]);
  });

  it('10-2・10-4 は、実装の無い機能を「現在は提供していません」と書いている (行ごと消して黙るのではない)', () => {
    const notOfferedLines = orgSection.filter((line) => line.includes(NOT_OFFERED));
    for (const term of ['部門への所属設定', 'アクティブ状況の確認', '部門対抗チャレンジ', '表彰機能']) {
      expect(
        notOfferedLines.some((line) => line.includes(term)),
        `§10 に「${term}」を「${NOT_OFFERED}」と書く行がある`,
      ).toBe(true);
    }
  });

  it('10-4 は「ランキング表示」を参加者の順位表として書く', () => {
    expect(orgSection).toContain('- ランキング表示（参加者が見る順位表）');
  });
});

describe('BROCHURE が「無い」と書く組織の機能の実装の事実 (#1917 docs-1023b の R1 指摘 1)', () => {
  it('メンバーの所属の部門 (user_profiles.department_id) を値で書く処理が src に無い (department_id を値で持つのはチャレンジの作成と、読んだ所属を返す DTO だけ)', () => {
    // 型の注釈 (`department_id: string | null`) は数えない。値を置く `department_id: <式>` だけを拾う
    const writesDepartment = /\bdepartment_id\??\s*:(?!\s*string\b)/;
    const hits = listFiles('src', SOURCE_EXTS)
      .filter((file) => !isTestFile(file) && !file.startsWith(path.join('src', 'types')))
      .filter((file) => writesDepartment.test(stripComments(read(file))))
      .sort();
    expect(hits).toEqual([
      // organization_challenges への insert (チャレンジを 1 つの部門に限る)。メンバーの所属ではない
      path.join('src', 'app', 'api', 'org', 'challenges', 'route.ts'),
      // requireOrgMember が、読んだ user_profiles.department_id をそのまま返す (書かない)
      path.join('src', 'lib', 'auth', 'org-member.ts'),
    ]);
  });

  it('表彰・部門対抗の機能が src とモバイルのアプリに無い', () => {
    const files = [...listFiles('src', SOURCE_EXTS), ...listFiles(path.join('apps', 'mobile', 'app'), SOURCE_EXTS)].filter(
      (file) => !isTestFile(file),
    );
    const hits = files.filter((file) => /表彰|対抗/.test(stripComments(read(file))));
    expect(hits).toEqual([]);
  });

  it('組織の API にレポートの route が無い', () => {
    const entries = fs.readdirSync(path.join(ROOT, 'src', 'app', 'api', 'org'));
    expect(entries.filter((name) => /report/i.test(name))).toEqual([]);
  });

  it('組織のメンバーの一覧の列は ユーザー・役割・参加日・操作 だけ (活動状況の列が無い)', () => {
    const page = read(path.join('src', 'app', '(org)', 'org', 'members', 'page.tsx'));
    const headers = [...page.matchAll(/<th\b[^>]*>([^<]*)<\/th>/g)].map(([, label]) => label.trim());
    expect(headers).toEqual(['ユーザー', '役割', '参加日', '操作']);
  });

  it('「ランキング表示」の根拠: チャレンジの詳細の API が参加者の順位表 (fetchChallengeRanking → get_org_challenge_ranking) を返す', () => {
    const route = stripComments(read(path.join('src', 'app', 'api', 'org', 'challenges', '[id]', 'route.ts')));
    expect(route).toContain('await fetchChallengeRanking(');
    const api = stripComments(read(path.join('src', 'lib', 'org-challenge-api.ts')));
    expect(api).toContain("rpc('get_org_challenge_ranking'");
  });
});
