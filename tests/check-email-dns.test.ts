// @vitest-environment node
/**
 * tests/check-email-dns.test.ts
 *
 * #1194: `node scripts/check-email-dns.mjs` (scripts/lib/email-dns.mjs) の契約テスト。
 *
 *   - 引数の解釈 (既定値 / 上書き / 環境変数 EMAIL_FROM / 誤り)
 *   - Resend の DKIM・Return-Path (MX と SPF)・DMARC・EMAIL_FROM の合否判定
 *   - 終了コード (0 = FAIL なし / 1 = FAIL あり / 2 = 引数の誤り) と、DNS を引けないときの扱い
 *
 * DNS の問い合わせは差し替える。実際のネットワークには接続しない。
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_APEX,
  DEFAULT_SEND_DOMAIN,
  HELP,
  UsageError,
  domainOfFrom,
  evaluate,
  flattenTxt,
  formatReport,
  main,
  parseArgs,
  parseDmarc,
  runChecks,
  spfRecords,
} from '../scripts/lib/email-dns.mjs';

const APEX = 'example.test';
const SEND = 'mail.example.test';
const DKIM_VALUE = `p=${'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC'.repeat(2)}`;

type Level = 'pass' | 'warn' | 'fail' | 'info';
type Check = { id: string; level: Level; title: string; detail: string };
const levelOf = (checks: Check[], id: string) => checks.find((c) => c.id === id)?.level;

/** すべて整っている DNS の答え */
const goodDns = () => ({
  apexMx: [{ exchange: 'example-test.mail.protection.outlook.com', priority: 0 }],
  apexTxt: ['v=spf1 include:spf.protection.outlook.com -all'],
  dkimTxt: [DKIM_VALUE],
  returnPathMx: [{ exchange: 'feedback-smtp.ap-northeast-1.amazonses.com', priority: 10 }],
  returnPathTxt: ['v=spf1 include:amazonses.com ~all'],
  dmarcTxt: ['v=DMARC1; p=quarantine; rua=mailto:dmarc@example.test'],
});

/** 名前ごとに答えを返す、偽の DNS。無い名前は本物と同じ ENODATA / ENOTFOUND で断る */
function fakeResolver(answers: Record<string, unknown>, failWith?: { name: string; code: string }) {
  const answer = (kind: 'MX' | 'TXT', name: string) => {
    if (failWith && failWith.name === name) throw Object.assign(new Error(failWith.code), { code: failWith.code });
    const key = `${kind} ${name}`;
    if (!(key in answers)) throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
    return answers[key];
  };
  return {
    resolveMx: async (name: string) => answer('MX', name),
    resolveTxt: async (name: string) => answer('TXT', name),
  };
}

/** goodDns と同じ内容の偽の DNS (TXT は resolveTxt の形 = 文字列の配列の配列) */
function goodResolver(overrides: Record<string, unknown> = {}) {
  const dns = goodDns();
  return fakeResolver({
    [`MX ${APEX}`]: dns.apexMx,
    [`TXT ${APEX}`]: dns.apexTxt.map((t) => [t]),
    [`TXT resend._domainkey.${SEND}`]: dns.dkimTxt.map((t) => [t]),
    [`MX send.${SEND}`]: dns.returnPathMx,
    [`TXT send.${SEND}`]: dns.returnPathTxt.map((t) => [t]),
    [`TXT _dmarc.${APEX}`]: dns.dmarcTxt.map((t) => [t]),
    ...overrides,
  });
}

describe('parseArgs', () => {
  it('既定値: 切り替え先は homegohan.com、送信ドメインは mail.homegohan.com', () => {
    expect(parseArgs([], {})).toEqual({
      apex: DEFAULT_APEX,
      sendDomain: DEFAULT_SEND_DOMAIN,
      from: undefined,
      server: undefined,
      help: false,
    });
    expect(DEFAULT_APEX).toBe('homegohan.com');
    expect(DEFAULT_SEND_DOMAIN).toBe('mail.homegohan.com');
  });

  it('--apex / --send-domain / --from / --server を上書きできる (= の形も可)。ドメインは小文字にして末尾のドットを除く', () => {
    const options = parseArgs(['--apex', 'Example.TEST.', '--send-domain=mail.example.test', '--from', 'a <b@mail.example.test>', '--server=1.1.1.1'], {});
    expect(options).toMatchObject({
      apex: 'example.test',
      sendDomain: 'mail.example.test',
      from: 'a <b@mail.example.test>',
      server: '1.1.1.1',
    });
  });

  it('--from が無ければ、環境変数 EMAIL_FROM を使う (空は未設定扱い)', () => {
    expect(parseArgs([], { EMAIL_FROM: 'ほめゴハン <noreply@mail.example.test>' }).from).toBe('ほめゴハン <noreply@mail.example.test>');
    expect(parseArgs([], { EMAIL_FROM: '  ' }).from).toBeUndefined();
    expect(parseArgs(['--from', 'x@mail.example.test'], { EMAIL_FROM: 'y@other.test' }).from).toBe('x@mail.example.test');
  });

  it('誤りは UsageError: 知らないオプション・値の欠け・ドメインでない値', () => {
    expect(() => parseArgs(['--nope'], {})).toThrow(UsageError);
    expect(() => parseArgs(['--apex'], {})).toThrow('--apex には値が必要です');
    expect(() => parseArgs(['--apex', '--help'], {})).toThrow(UsageError);
    expect(() => parseArgs(['--send-domain', 'not a domain'], {})).toThrow('ドメイン名で指定してください');
    expect(() => parseArgs(['--apex', 'localhost'], {})).toThrow(UsageError);
  });
});

describe('DNS の答えの読み取り', () => {
  it('flattenTxt: 255 文字ごとに分かれた TXT を 1 つの文字列に戻す', () => {
    expect(flattenTxt([['v=spf1 ', 'include:a.test -all'], ['other']])).toEqual(['v=spf1 include:a.test -all', 'other']);
    expect(flattenTxt(null)).toEqual([]);
  });

  it('spfRecords: v=spf1 で始まる TXT だけ (大文字小文字は問わない)', () => {
    expect(spfRecords(['google-site-verification=abc', 'v=spf1 -all', 'V=SPF1 include:x.test'])).toEqual(['v=spf1 -all', 'V=SPF1 include:x.test']);
  });

  it('parseDmarc: p / sp / pct / rua を読む。DMARC でなければ null', () => {
    expect(parseDmarc(['v=DMARC1; p=reject; sp=quarantine; pct=50; rua=mailto:a@example.test'])).toEqual({
      policy: 'reject',
      subdomainPolicy: 'quarantine',
      pct: 50,
      rua: 'mailto:a@example.test',
    });
    expect(parseDmarc(['v=DMARC1; p=none'])).toMatchObject({ policy: 'none', pct: 100, rua: undefined });
    expect(parseDmarc(['v=spf1 -all', 'other'])).toBeNull();
    expect(parseDmarc([])).toBeNull();
  });

  it('domainOfFrom: 「表示名 <アドレス>」でもアドレスだけでも、ドメインを取り出す', () => {
    expect(domainOfFrom('ほめゴハン <noreply@Mail.Example.test>')).toBe('mail.example.test');
    expect(domainOfFrom('noreply@mail.example.test')).toBe('mail.example.test');
    expect(domainOfFrom('noreply')).toBeNull();
  });
});

describe('evaluate: 合否判定', () => {
  const options = { apex: APEX, sendDomain: SEND, from: 'ほめゴハン <noreply@mail.example.test>' };

  it('すべて整っていれば FAIL も WARN も無い', () => {
    const checks = evaluate(goodDns(), options);

    expect(checks.filter((c) => c.level === 'fail' || c.level === 'warn')).toEqual([]);
    for (const id of ['send-domain', 'dkim', 'return-path-mx', 'return-path-spf', 'dmarc', 'from']) {
      expect(levelOf(checks, id), id).toBe('pass');
    }
  });

  it('DKIM が無い / 公開鍵 (p=) が空: FAIL', () => {
    expect(levelOf(evaluate({ ...goodDns(), dkimTxt: null }, options), 'dkim')).toBe('fail');
    expect(levelOf(evaluate({ ...goodDns(), dkimTxt: ['p='] }, options), 'dkim')).toBe('fail');
    expect(levelOf(evaluate({ ...goodDns(), dkimTxt: ['something else'] }, options), 'dkim')).toBe('fail');
  });

  it('Return-Path の MX: 無い / Amazon SES (amazonses.com) 以外を指す: FAIL。リージョンが違っても amazonses.com なら PASS', () => {
    expect(levelOf(evaluate({ ...goodDns(), returnPathMx: null }, options), 'return-path-mx')).toBe('fail');
    expect(
      levelOf(evaluate({ ...goodDns(), returnPathMx: [{ exchange: 'mail.other.test', priority: 10 }] }, options), 'return-path-mx'),
    ).toBe('fail');
    expect(
      levelOf(
        evaluate({ ...goodDns(), returnPathMx: [{ exchange: 'feedback-smtp.us-east-1.amazonses.com.', priority: 10 }] }, options),
        'return-path-mx',
      ),
    ).toBe('pass');
  });

  it('Return-Path の SPF: 無い / include:amazonses.com が無い / 複数ある: FAIL', () => {
    expect(levelOf(evaluate({ ...goodDns(), returnPathTxt: null }, options), 'return-path-spf')).toBe('fail');
    expect(levelOf(evaluate({ ...goodDns(), returnPathTxt: ['v=spf1 -all'] }, options), 'return-path-spf')).toBe('fail');
    expect(
      levelOf(
        evaluate({ ...goodDns(), returnPathTxt: ['v=spf1 include:amazonses.com ~all', 'v=spf1 include:other.test ~all'] }, options),
        'return-path-spf',
      ),
    ).toBe('fail');
  });

  it('DMARC: 無い・p=none は WARN (最初は監視だけでよい)、quarantine / reject は PASS、p= が不正は FAIL', () => {
    expect(levelOf(evaluate({ ...goodDns(), dmarcTxt: null }, options), 'dmarc')).toBe('warn');
    expect(levelOf(evaluate({ ...goodDns(), dmarcTxt: ['v=DMARC1; p=none; rua=mailto:a@example.test'] }, options), 'dmarc')).toBe('warn');
    expect(levelOf(evaluate({ ...goodDns(), dmarcTxt: ['v=DMARC1; p=reject'] }, options), 'dmarc')).toBe('pass');
    expect(levelOf(evaluate({ ...goodDns(), dmarcTxt: ['v=DMARC1; p=bogus'] }, options), 'dmarc')).toBe('fail');
  });

  it('組織のドメインの SPF が複数ある: FAIL (SPF 全体が無効になる)。1 つなら参考情報', () => {
    expect(
      levelOf(evaluate({ ...goodDns(), apexTxt: ['v=spf1 -all', 'v=spf1 include:x.test -all'] }, options), 'apex-spf'),
    ).toBe('fail');
    expect(levelOf(evaluate(goodDns(), options), 'apex-spf')).toBe('info');
  });

  it('送信ドメインが組織のドメイン本体: WARN。組織のドメインの下に無い: WARN', () => {
    expect(levelOf(evaluate(goodDns(), { ...options, sendDomain: APEX }), 'send-domain')).toBe('warn');
    expect(levelOf(evaluate(goodDns(), { ...options, sendDomain: 'mail.other.test' }), 'send-domain')).toBe('warn');
  });

  it('EMAIL_FROM: 送信ドメインと合っていれば PASS、違えば FAIL (未検証のドメインだと Resend が断る)、アドレスが無ければ WARN、未指定は INFO', () => {
    expect(levelOf(evaluate(goodDns(), { ...options, from: 'a <noreply@mail.example.test>' }), 'from')).toBe('pass');
    expect(levelOf(evaluate(goodDns(), { ...options, from: 'a <noreply@sub.mail.example.test>' }), 'from')).toBe('pass');
    expect(levelOf(evaluate(goodDns(), { ...options, from: 'a <noreply@other.test>' }), 'from')).toBe('fail');
    expect(levelOf(evaluate(goodDns(), { ...options, from: 'noreply' }), 'from')).toBe('warn');
    expect(levelOf(evaluate(goodDns(), { ...options, from: undefined }), 'from')).toBe('info');
  });
});

describe('runChecks / main', () => {
  it('整った DNS: 終了コード 0。TXT が分割されていても読める', async () => {
    const lines: string[] = [];
    const code = await main(['--apex', APEX, '--send-domain', SEND, '--from', 'ほめゴハン <noreply@mail.example.test>'], {
      resolver: goodResolver({ [`TXT send.${SEND}`]: [['v=spf1 include:', 'amazonses.com ~all']] }),
      env: {},
      log: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    const report = lines.join('\n');
    expect(report).toContain('[PASS] DKIM');
    expect(report).toContain('結果: PASS');
    expect(report).toContain('FAIL 0');
  });

  it('いまの homegohan.com (メールは Microsoft 365 のみ。Resend のレコードも DMARC も無い): DKIM / Return-Path が FAIL で終了コード 1', async () => {
    const lines: string[] = [];
    const resolver = fakeResolver({
      [`MX ${APEX}`]: [{ exchange: 'example-test.mail.protection.outlook.com', priority: 0 }],
      [`TXT ${APEX}`]: [['v=spf1 include:spf.protection.outlook.com -all']],
    });

    const code = await main(['--apex', APEX, '--send-domain', SEND], { resolver, env: {}, log: (line) => lines.push(line) });

    expect(code).toBe(1);
    const report = lines.join('\n');
    expect(report).toContain('[FAIL] DKIM が見つかりません: resend._domainkey.mail.example.test');
    expect(report).toContain('[FAIL] Return-Path の MX が見つかりません: send.mail.example.test');
    expect(report).toContain('[FAIL] Return-Path の SPF が見つかりません: send.mail.example.test');
    expect(report).toContain('[WARN] DMARC がありません: _dmarc.example.test');
    expect(report).toContain('Verify');
  });

  it('Resend のレコードは整っていて DMARC だけ無い (WARN) なら、終了コードは 0', async () => {
    const lines: string[] = [];
    const resolver = fakeResolver({
      [`MX ${APEX}`]: [{ exchange: 'x.mail.protection.outlook.com', priority: 0 }],
      [`TXT ${APEX}`]: [['v=spf1 -all']],
      [`TXT resend._domainkey.${SEND}`]: [[DKIM_VALUE]],
      [`MX send.${SEND}`]: [{ exchange: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 }],
      [`TXT send.${SEND}`]: [['v=spf1 include:amazonses.com ~all']],
    });

    const code = await main(['--apex', APEX, '--send-domain', SEND], { resolver, env: {}, log: (line) => lines.push(line) });

    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('[WARN] DMARC がありません');
  });

  it('DNS を引けない (タイムアウトなど): 例外にせず、原因のコードを出して終了コード 1', async () => {
    const errors: string[] = [];

    const code = await main(['--apex', APEX, '--send-domain', SEND], {
      resolver: fakeResolver({}, { name: `_dmarc.${APEX}`, code: 'ETIMEOUT' }),
      env: {},
      log: () => {},
      errorLog: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('ETIMEOUT');
  });

  it('引数の誤り: 使い方を出して終了コード 2。--help は 0', async () => {
    const errors: string[] = [];
    const logs: string[] = [];

    expect(await main(['--nope'], { env: {}, log: (l) => logs.push(l), errorLog: (l) => errors.push(l) })).toBe(2);
    expect(errors.join('\n')).toContain('知らないオプションです: --nope');
    expect(errors.join('\n')).toContain('使い方');

    expect(await main(['--help'], { env: {}, log: (l) => logs.push(l), errorLog: (l) => errors.push(l) })).toBe(0);
    expect(logs.join('\n')).toBe(HELP);
  });

  it('runChecks: 6 件の問い合わせを、決まったホスト名で行う', async () => {
    const asked: string[] = [];
    const resolver = {
      resolveMx: async (name: string) => {
        asked.push(`MX ${name}`);
        return [];
      },
      resolveTxt: async (name: string) => {
        asked.push(`TXT ${name}`);
        return [];
      },
    };

    await runChecks({ apex: APEX, sendDomain: SEND }, resolver);

    expect(asked.sort()).toEqual(
      [
        `MX ${APEX}`,
        `TXT ${APEX}`,
        `TXT resend._domainkey.${SEND}`,
        `MX send.${SEND}`,
        `TXT send.${SEND}`,
        `TXT _dmarc.${APEX}`,
      ].sort(),
    );
  });

  it('formatReport: 件数のまとめを出す。FAIL があるときだけ「直してから Verify」の案内を足す', () => {
    const ok = formatReport(evaluate(goodDns(), { apex: APEX, sendDomain: SEND }), { apex: APEX, sendDomain: SEND });
    expect(ok).toContain('結果:');
    expect(ok).not.toContain('Verify');

    const ng = formatReport(evaluate({ ...goodDns(), dkimTxt: null }, { apex: APEX, sendDomain: SEND }), { apex: APEX, sendDomain: SEND });
    expect(ng).toContain('FAIL 1');
    expect(ng).toContain('Verify');
  });
});
