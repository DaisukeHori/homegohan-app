// @vitest-environment node
/**
 * tests/npm-audit-summary.test.ts
 *
 * scripts/npm-audit-summary.mjs の契約テスト。`npm audit --json` の結果を GitHub Actions の Summary 用の Markdown にまとめる
 * (.github/workflows/security.yml の npm-audit ジョブが使う。#1156)。
 * npm には接続しない。結果の形は、実際の `npm audit --omit=dev --json` (auditReportVersion 2) の出力に合わせてある。
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_TITLE_LENGTH,
  MAX_TITLES,
  criticalPackages,
  describeFix,
  main,
  renderAuditSummary,
} from '../scripts/npm-audit-summary.mjs';

/** 実際の出力に近い結果 (critical は next / shell-quote / tar の 3 件) */
const REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {
    next: {
      name: 'next',
      severity: 'critical',
      isDirect: true,
      via: [
        { source: 1, name: 'next', title: 'Next.js self-hosted applications vulnerable to DoS', severity: 'moderate' },
        { source: 2, name: 'next', title: 'Next.js: Unauthenticated Remote Code Execution on windows-hosted servers', severity: 'critical' },
        { source: 3, name: 'next', title: 'Next.js: Unauthenticated Remote Code Execution in Image Optimization API', severity: 'critical' },
      ],
      effects: [],
      fixAvailable: { name: 'next', version: '16.4.0', isSemVerMajor: true },
    },
    'shell-quote': {
      name: 'shell-quote',
      severity: 'critical',
      isDirect: false,
      via: [
        { title: 'shell-quote quote() does not escape newlines in object .op values', severity: 'critical' },
        { title: 'shell-quote: Quadratic-complexity Denial of Service in `parse()`', severity: 'high' },
      ],
      effects: [],
      fixAvailable: true,
    },
    tar: {
      name: 'tar',
      severity: 'critical',
      isDirect: false,
      via: [{ title: 'node-tar: Decompression/parse DoS via unlimited input', severity: 'critical' }],
      effects: [],
      fixAvailable: true,
    },
    ws: { name: 'ws', severity: 'high', isDirect: false, via: [], effects: [], fixAvailable: true },
  },
  metadata: { vulnerabilities: { info: 0, low: 3, moderate: 29, high: 33, critical: 3, total: 68 } },
};

describe('renderAuditSummary', () => {
  const markdown = renderAuditSummary(REPORT);

  it('重大度ごとの件数を表にする (info は 0 件なら出さない)', () => {
    expect(markdown).toContain('| critical | 3 |');
    expect(markdown).toContain('| high | 33 |');
    expect(markdown).toContain('| moderate | 29 |');
    expect(markdown).toContain('| low | 3 |');
    expect(markdown).not.toContain('| info |');
  });

  it('info が 1 件でもあれば出す', () => {
    const withInfo = renderAuditSummary({ ...REPORT, metadata: { vulnerabilities: { ...REPORT.metadata.vulnerabilities, info: 2 } } });
    expect(withInfo).toContain('| info | 2 |');
  });

  it('critical が残っている間は PR を止めない参考情報だと書く', () => {
    expect(markdown).toContain('参考情報です');
    expect(markdown).toContain('continue-on-error');
  });

  it('critical のパッケージだけを内訳に出す (high のパッケージは出さない)', () => {
    expect(markdown).toContain('### critical の内訳');
    expect(markdown).toContain('| `next` |');
    expect(markdown).toContain('| `shell-quote` |');
    expect(markdown).toContain('| `tar` |');
    expect(markdown).not.toContain('| `ws` |');
  });

  it('critical と判定された理由 (critical の題名) を出し、moderate の題名は出さない', () => {
    expect(markdown).toContain('Next.js: Unauthenticated Remote Code Execution on windows-hosted servers');
    expect(markdown).toContain('Next.js: Unauthenticated Remote Code Execution in Image Optimization API');
    expect(markdown).not.toContain('self-hosted applications vulnerable to DoS');
    // 同じパッケージの high の題名も出さない
    expect(markdown).not.toContain('Quadratic-complexity');
  });

  it('直接の依存かどうかと、直し方を出す', () => {
    const rows = markdown.split('\n');
    const next = rows.find((r) => r.startsWith('| `next` |'))!;
    const shellQuote = rows.find((r) => r.startsWith('| `shell-quote` |'))!;
    expect(next).toContain('はい');
    expect(next).toContain('`next@16.4.0` に上げる (メジャー更新)');
    expect(shellQuote).toContain('いいえ');
    expect(shellQuote).toContain('`npm audit fix` で直せる');
  });

  it('critical が無いときは、止める検査に切り替えられると書き、内訳は出さない', () => {
    const none = renderAuditSummary({
      vulnerabilities: { ws: { name: 'ws', severity: 'high', via: [] } },
      metadata: { vulnerabilities: { low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
    });
    expect(none).toContain('critical の脆弱性は 0 件です');
    expect(none).toContain('continue-on-error');
    expect(none).not.toContain('### critical の内訳');
    expect(none).toContain('| high | 1 |');
  });

  it('npm audit が失敗した結果 (error) は、その旨を書く', () => {
    const failed = renderAuditSummary({ error: { code: 'ENOAUDIT', summary: 'Audit endpoint returned an error' } });
    expect(failed).toContain('npm audit を実行できませんでした');
    expect(failed).toContain('Audit endpoint returned an error');
    expect(failed).not.toContain('| critical |');
  });

  it('結果を読めなかった (null) ときも、Markdown を返して落ちない', () => {
    for (const bad of [null, undefined, 'text', 42]) {
      expect(renderAuditSummary(bad as never)).toContain('結果を読めませんでした');
    }
  });

  it('metadata や vulnerabilities が無い空の結果でも落ちない (件数は 0)', () => {
    const empty = renderAuditSummary({});
    expect(empty).toContain('| critical | 0 |');
    expect(empty).toContain('critical の脆弱性は 0 件です');
  });
});

describe('criticalPackages', () => {
  it('名前順に並べ、題名は critical のものを重複なく集める', () => {
    const list = criticalPackages({
      vulnerabilities: {
        zeta: { severity: 'critical', via: [{ title: 'A', severity: 'critical' }, { title: 'A', severity: 'critical' }] },
        alpha: { severity: 'critical', isDirect: true, via: [] },
        beta: { severity: 'low', via: [] },
      },
    });
    expect(list.map((p) => p.name)).toEqual(['alpha', 'zeta']);
    expect(list[1].titles).toEqual(['A']);
    expect(list[0].isDirect).toBe(true);
    expect(list[1].isDirect).toBe(false);
  });

  it('題名が無く、他のパッケージ経由 (via が文字列) のときは、そのパッケージ名を出す', () => {
    const markdown = renderAuditSummary({
      vulnerabilities: { 'expo-cli': { name: 'expo-cli', severity: 'critical', isDirect: false, via: ['tar', 'shell-quote'], fixAvailable: false } },
      metadata: { vulnerabilities: { critical: 1, total: 1 } },
    });
    expect(markdown).toContain('依存先 (tar, shell-quote) の脆弱性');
    expect(markdown).toContain('直った版がまだ無い');
  });

  it('題名が MAX_TITLES を超えたら「ほか N 件」にまとめ、長い題名は切る', () => {
    const titles = Array.from({ length: MAX_TITLES + 2 }, (_, i) => `Title ${i + 1} ${'x'.repeat(MAX_TITLE_LENGTH)}`);
    const markdown = renderAuditSummary({
      vulnerabilities: { many: { severity: 'critical', via: titles.map((title) => ({ title, severity: 'critical' })), fixAvailable: true } },
      metadata: { vulnerabilities: { critical: 1, total: 1 } },
    });
    expect(markdown).toContain('ほか 2 件');
    expect(markdown).toContain('…');
    expect(markdown).not.toContain('x'.repeat(MAX_TITLE_LENGTH));
  });

  it('題名の縦線・山括弧・改行で表が崩れたり、HTML が入ったりしない', () => {
    const markdown = renderAuditSummary({
      vulnerabilities: {
        evil: {
          name: 'evil',
          severity: 'critical',
          via: [{ title: 'a | b <img src=x onerror=alert(1)>\nsecond line', severity: 'critical' }],
          fixAvailable: true,
        },
      },
      metadata: { vulnerabilities: { critical: 1, total: 1 } },
    });
    const row = markdown.split('\n').find((r) => r.startsWith('| `evil` |'))!;
    expect(row).toContain('a \\| b &lt;img src=x onerror=alert(1)&gt; second line');
    expect(row).not.toContain('<img');
    // 表の行が 1 行のまま (改行で分かれていない)
    expect(row.endsWith('|')).toBe(true);
  });
});

describe('describeFix', () => {
  it('true は npm audit fix、オブジェクトは更新先 (メジャーなら明記)、false・未定義は修正版なし', () => {
    expect(describeFix(true)).toBe('`npm audit fix` で直せる');
    expect(describeFix({ name: 'tar', version: '7.5.7', isSemVerMajor: false })).toBe('`tar@7.5.7` に上げる');
    expect(describeFix({ name: 'next', version: '16.4.0', isSemVerMajor: true })).toBe('`next@16.4.0` に上げる (メジャー更新)');
    expect(describeFix(false)).toBe('直った版がまだ無い');
    expect(describeFix(undefined)).toBe('直った版がまだ無い');
  });
});

describe('main (CLI)', () => {
  it('ファイルを読み、Markdown を書き出して 0 で終わる', () => {
    let written = '';
    const code = main(['audit.json'], { read: () => JSON.stringify(REPORT), write: (s: string) => (written += s) });
    expect(code).toBe(0);
    expect(written).toContain('### critical の内訳');
  });

  it('壊れた JSON・読めないファイルでも、Markdown を書いて 0 で終わる (ジョブの判定は npm audit の終了コードで行う)', () => {
    for (const read of [() => '{not json', () => '', () => { throw new Error('ENOENT'); }]) {
      let written = '';
      const code = main(['audit.json'], { read, write: (s: string) => (written += s) });
      expect(code).toBe(0);
      expect(written).toContain('結果を読めませんでした');
    }
  });

  it('引数が無ければ 2 で終わる', () => {
    expect(main([], { read: () => '', write: () => undefined })).toBe(2);
  });
});
