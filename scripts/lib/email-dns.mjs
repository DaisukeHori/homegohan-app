/**
 * メール送信用の DNS レコードの確認 (#1194)。本体は scripts/check-email-dns.mjs から呼ぶ。
 *
 * Resend で送信ドメインを検証するときに DNS へ登録するレコード (DKIM / Return-Path の MX と SPF) と、
 * なりすまし対策の DMARC が、公開 DNS から見えているかを調べる。DNS を引くだけで、何も書き換えない。
 * 手順の全体は docs/operations/email-domain.md。
 *
 * 見るのは「レコードの形」で、値そのもの (DKIM の公開鍵など) は Resend の画面が正。
 * 値は Resend がドメインごとに発行するので、ここでは決め打ちしない。
 *
 * 判定の意味:
 *   PASS  期待どおり
 *   WARN  今すぐ送信できなくなるわけではないが、直したほうがよい (DMARC が無い・まだ監視だけ、など)
 *   FAIL  このままでは Resend の検証が通らない / メールが届かないおそれ
 *   INFO  参考情報
 * 終了コード: 0 = FAIL なし / 1 = FAIL あり / 2 = 引数の誤り
 *
 * 単体テストから使えるよう、本体 (このファイル) と入口 (scripts/check-email-dns.mjs) を分けてある。
 * DNS の問い合わせ (resolver) も差し替えられるので、テストはネットワークに接続しない。
 */
import { Resolver } from 'node:dns/promises';

/** 切り替え先のドメイン。引数で変えられる */
export const DEFAULT_APEX = 'homegohan.com';
/** 送信専用のサブドメイン (推奨)。メールの受信 (Microsoft 365) に使う homegohan.com 本体とは分ける */
export const DEFAULT_SEND_DOMAIN = 'mail.homegohan.com';

export class UsageError extends Error {}

export const HELP = `使い方: node scripts/check-email-dns.mjs [オプション]

  --send-domain <ドメイン>  Resend に登録した送信用のドメイン (既定: ${DEFAULT_SEND_DOMAIN})
  --apex <ドメイン>         組織のドメイン。DMARC と受信 (MX) を見る (既定: ${DEFAULT_APEX})
  --from <値>              EMAIL_FROM に設定する(した)値。送信ドメインと合っているか確かめる (既定: 環境変数 EMAIL_FROM)
  --server <IP>            この DNS サーバーに問い合わせる (例: 1.1.1.1)。設定を変えた直後で、手元の DNS が古い値を覚えているとき
  --help                   このメッセージ

DNS を引くだけで、何も書き換えません。終了コード: 0 = 問題なし(警告は除く) / 1 = 直すべき点あり / 2 = 引数の誤り`;

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 */
export function parseArgs(argv, env = process.env) {
  const options = {
    apex: DEFAULT_APEX,
    sendDomain: DEFAULT_SEND_DOMAIN,
    from: env.EMAIL_FROM?.trim() || undefined,
    server: undefined,
    help: false,
  };
  const valueOf = (name, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new UsageError(`${name} には値が必要です`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    switch (flag) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--apex':
      case '--send-domain':
      case '--from':
      case '--server': {
        const value = inline ?? valueOf(flag, i);
        if (inline === undefined) i += 1;
        if (flag === '--apex') options.apex = normalizeDomain(value, flag);
        else if (flag === '--send-domain') options.sendDomain = normalizeDomain(value, flag);
        else if (flag === '--from') options.from = value;
        else options.server = value;
        break;
      }
      default:
        throw new UsageError(`知らないオプションです: ${arg}`);
    }
  }
  return options;
}

/** @param {string} value @param {string} name */
function normalizeDomain(value, name) {
  const domain = value.trim().toLowerCase().replace(/\.$/, '');
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) {
    throw new UsageError(`${name} はドメイン名で指定してください (例: homegohan.com): ${value}`);
  }
  return domain;
}

/** resolveTxt の結果 (文字列の配列の配列) を、1 レコード 1 文字列にする */
export function flattenTxt(records) {
  return (records ?? []).map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)));
}

/** TXT のうち SPF (v=spf1) のレコード */
export function spfRecords(txts) {
  return txts.filter((txt) => /^v=spf1(\s|$)/i.test(txt.trim()));
}

/**
 * DMARC レコードの読み取り。無ければ null
 * @param {string[]} txts
 */
export function parseDmarc(txts) {
  const record = txts.find((txt) => /^v=DMARC1\s*;/i.test(txt.trim()) || /^v=DMARC1$/i.test(txt.trim()));
  if (!record) return null;
  const tags = new Map();
  for (const part of record.split(';')) {
    const [key, ...rest] = part.split('=');
    if (key && rest.length > 0) tags.set(key.trim().toLowerCase(), rest.join('=').trim());
  }
  return {
    policy: (tags.get('p') ?? '').toLowerCase(),
    subdomainPolicy: (tags.get('sp') ?? '').toLowerCase() || undefined,
    pct: tags.has('pct') ? Number(tags.get('pct')) : 100,
    rua: tags.get('rua') || undefined,
  };
}

/** `ほめゴハン <noreply@mail.example.com>` / `noreply@mail.example.com` から、アドレスのドメイン部分を取り出す */
export function domainOfFrom(from) {
  const match = /<([^<>]+)>\s*$/.exec(from.trim());
  const address = (match ? match[1] : from).trim();
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).toLowerCase() : null;
}

/**
 * 集めた DNS の答えから、確認結果を作る (DNS を引かない純粋な関数)。
 * @param {{
 *   apexMx: Array<{exchange: string, priority: number}> | null,
 *   apexTxt: string[] | null,
 *   dkimTxt: string[] | null,
 *   returnPathMx: Array<{exchange: string, priority: number}> | null,
 *   returnPathTxt: string[] | null,
 *   dmarcTxt: string[] | null,
 * }} dns  引けなかった (レコードなし) ものは null
 * @param {{ apex: string, sendDomain: string, from?: string }} options
 * @returns {Array<{ id: string, level: 'pass' | 'warn' | 'fail' | 'info', title: string, detail: string }>}
 */
export function evaluate(dns, { apex, sendDomain, from }) {
  const checks = [];
  const add = (id, level, title, detail) => checks.push({ id, level, title, detail });
  const returnPathHost = `send.${sendDomain}`;
  const dkimHost = `resend._domainkey.${sendDomain}`;
  const dmarcHost = `_dmarc.${apex}`;

  // 送信ドメインの置き場所
  if (sendDomain === apex) {
    add(
      'send-domain',
      'warn',
      `送信ドメインが ${apex} 本体です`,
      '本体には受信 (MX) と SPF がすでにあることが多く、Resend のレコードとぶつかりやすいです。送信専用のサブドメイン (例: mail.' +
        `${apex}) を Resend に登録するほうが安全です。`,
    );
  } else if (!sendDomain.endsWith(`.${apex}`)) {
    add('send-domain', 'warn', `送信ドメイン ${sendDomain} は ${apex} の下にありません`, 'DMARC は組織のドメイン (' + apex + ') の設定を引き継ぐため、別のドメインだと効きません。');
  } else {
    add('send-domain', 'pass', `送信ドメイン: ${sendDomain}`, `${apex} とは別の送信専用サブドメインです。`);
  }

  // DKIM (Resend が署名に使う公開鍵)
  const dkim = (dns.dkimTxt ?? []).find((txt) => /(^|;)\s*p=[A-Za-z0-9+/=]{20,}/.test(txt));
  if (dkim) add('dkim', 'pass', `DKIM: ${dkimHost}`, 'TXT に公開鍵 (p=…) があります。');
  else add('dkim', 'fail', `DKIM が見つかりません: ${dkimHost}`, 'Resend の画面に表示される TXT レコード (p=… で始まる値) を、このホスト名で登録してください。');

  // Return-Path の MX (バウンスを受け取る先)
  const mx = dns.returnPathMx ?? [];
  if (mx.length > 0 && mx.every((r) => r.exchange.toLowerCase().replace(/\.$/, '').endsWith('.amazonses.com'))) {
    add('return-path-mx', 'pass', `Return-Path の MX: ${returnPathHost}`, mx.map((r) => `${r.priority} ${r.exchange}`).join(', '));
  } else if (mx.length > 0) {
    add('return-path-mx', 'fail', `Return-Path の MX の向き先が違います: ${returnPathHost}`, `${mx.map((r) => r.exchange).join(', ')} (Resend の画面にある feedback-smtp.….amazonses.com を指す必要があります)`);
  } else {
    add('return-path-mx', 'fail', `Return-Path の MX が見つかりません: ${returnPathHost}`, 'Resend の画面に表示される MX レコード (優先度 10) を、このホスト名で登録してください。');
  }

  // Return-Path の SPF (送信を許可するサーバーの宣言)
  const sendSpf = spfRecords(dns.returnPathTxt ?? []);
  if (sendSpf.length > 1) {
    add('return-path-spf', 'fail', `SPF が複数あります: ${returnPathHost}`, '1 つのホスト名に v=spf1 の TXT は 1 つだけにしてください (複数あると SPF 全体が無効になります)。');
  } else if (sendSpf.length === 1 && /\binclude:amazonses\.com\b/i.test(sendSpf[0])) {
    add('return-path-spf', 'pass', `Return-Path の SPF: ${returnPathHost}`, sendSpf[0]);
  } else if (sendSpf.length === 1) {
    add('return-path-spf', 'fail', `SPF に include:amazonses.com がありません: ${returnPathHost}`, sendSpf[0]);
  } else {
    add('return-path-spf', 'fail', `Return-Path の SPF が見つかりません: ${returnPathHost}`, 'Resend の画面に表示される TXT レコード (v=spf1 include:amazonses.com …) を、このホスト名で登録してください。');
  }

  // DMARC (SPF / DKIM を通らないメールをどう扱うかの宣言)
  const dmarc = parseDmarc(dns.dmarcTxt ?? []);
  if (!dmarc) {
    add('dmarc', 'warn', `DMARC がありません: ${dmarcHost}`, '最初は監視だけの p=none で登録してください (例: v=DMARC1; p=none; rua=mailto:<レポートを受け取るアドレス>)。');
  } else if (dmarc.policy === 'none') {
    add('dmarc', 'warn', `DMARC は監視だけです (p=none): ${dmarcHost}`, `レポート${dmarc.rua ? `(${dmarc.rua})` : ''}を 2〜4 週間見て、正当なメールがすべて通っていると確かめてから quarantine → reject へ段階的に強めてください。`);
  } else if (dmarc.policy === 'quarantine' || dmarc.policy === 'reject') {
    add('dmarc', 'pass', `DMARC: p=${dmarc.policy}${dmarc.pct !== 100 ? ` (pct=${dmarc.pct})` : ''}`, dmarc.rua ? `レポートの送り先: ${dmarc.rua}` : 'rua (レポートの送り先) がありません。付けると、通っていないメールに気づけます。');
  } else {
    add('dmarc', 'fail', `DMARC の p= が正しくありません: ${dmarcHost}`, 'p= は none / quarantine / reject のどれかです。');
  }

  // 組織のドメインの受信と SPF (参考)。Resend のレコードは、ここには置かない
  if ((dns.apexMx ?? []).length > 0) {
    add('apex-mx', 'info', `${apex} の受信 (MX)`, dns.apexMx.map((r) => `${r.priority} ${r.exchange}`).join(', '));
  } else {
    add('apex-mx', 'info', `${apex} に MX がありません`, 'support@ などの受信箱を作るには、メールサービスの MX レコードが要ります。');
  }
  const apexSpf = spfRecords(dns.apexTxt ?? []);
  if (apexSpf.length > 1) {
    add('apex-spf', 'fail', `${apex} の SPF が複数あります`, '1 つのホスト名に v=spf1 の TXT は 1 つだけにしてください (複数あると SPF 全体が無効になります)。');
  } else if (apexSpf.length === 1) {
    add('apex-spf', 'info', `${apex} の SPF`, `${apexSpf[0]} (送信専用サブドメインを使うなら、ここに Resend の記述を足す必要はありません)`);
  } else {
    add('apex-spf', 'info', `${apex} に SPF がありません`, '受信に使うメールサービスの案内に従って登録してください。');
  }

  // EMAIL_FROM が送信ドメインと合っているか
  if (from) {
    const fromDomain = domainOfFrom(from);
    if (!fromDomain) {
      add('from', 'warn', 'EMAIL_FROM にメールアドレスが見つかりません', 'ほめゴハン <noreply@mail.example.com> の形で設定してください。');
    } else if (fromDomain === sendDomain || fromDomain.endsWith(`.${sendDomain}`)) {
      add('from', 'pass', `EMAIL_FROM のドメイン: ${fromDomain}`, '検証した送信ドメインと合っています。');
    } else {
      add('from', 'fail', `EMAIL_FROM のドメイン (${fromDomain}) が送信ドメイン (${sendDomain}) と違います`, 'Resend で検証済みのドメインのアドレスを送信元にしてください。未検証だと Resend が送信を断ります。');
    }
  } else {
    add('from', 'info', 'EMAIL_FROM は確認していません', '--from "ほめゴハン <noreply@mail.homegohan.com>" を付けると、送信ドメインと合っているか確かめます。');
  }

  return checks;
}

/**
 * 1 回の問い合わせ。レコードが無い (ENOTFOUND / ENODATA) ときは null、それ以外のエラーはそのまま投げる。
 * @template T
 * @param {() => Promise<T>} query
 * @returns {Promise<T | null>}
 */
async function lookup(query) {
  try {
    return await query();
  } catch (error) {
    if (error && (error.code === 'ENOTFOUND' || error.code === 'ENODATA')) return null;
    throw error;
  }
}

/**
 * 公開 DNS から必要なレコードを集めて、確認結果を返す。
 * @param {{ apex: string, sendDomain: string, from?: string }} options
 * @param {{ resolveMx(name: string): Promise<any>, resolveTxt(name: string): Promise<any> }} resolver
 */
export async function runChecks(options, resolver) {
  const { apex, sendDomain } = options;
  const [apexMx, apexTxt, dkimTxt, returnPathMx, returnPathTxt, dmarcTxt] = await Promise.all([
    lookup(() => resolver.resolveMx(apex)),
    lookup(() => resolver.resolveTxt(apex)).then((r) => (r ? flattenTxt(r) : null)),
    lookup(() => resolver.resolveTxt(`resend._domainkey.${sendDomain}`)).then((r) => (r ? flattenTxt(r) : null)),
    lookup(() => resolver.resolveMx(`send.${sendDomain}`)),
    lookup(() => resolver.resolveTxt(`send.${sendDomain}`)).then((r) => (r ? flattenTxt(r) : null)),
    lookup(() => resolver.resolveTxt(`_dmarc.${apex}`)).then((r) => (r ? flattenTxt(r) : null)),
  ]);
  return evaluate({ apexMx, apexTxt, dkimTxt, returnPathMx, returnPathTxt, dmarcTxt }, options);
}

const MARK = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', info: 'INFO' };

/** 画面に出す文字列 */
export function formatReport(checks, { apex, sendDomain }) {
  const lines = [`メール送信用の DNS の確認 (送信ドメイン: ${sendDomain} / 組織のドメイン: ${apex})`, ''];
  for (const check of checks) {
    lines.push(`[${MARK[check.level]}] ${check.title}`);
    if (check.detail) lines.push(`       ${check.detail}`);
  }
  const count = (level) => checks.filter((c) => c.level === level).length;
  lines.push('', `結果: PASS ${count('pass')} / WARN ${count('warn')} / FAIL ${count('fail')}`);
  if (count('fail') > 0) lines.push('FAIL を直してから、Resend の画面で Verify を押してください。DNS の反映には数分〜数時間かかります。');
  return lines.join('\n');
}

/**
 * @param {string[]} argv
 * @param {{ resolver?: any, env?: Record<string, string | undefined>, log?: (line: string) => void, errorLog?: (line: string) => void }} [deps]
 * @returns {Promise<number>} 終了コード
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  const errorLog = deps.errorLog ?? ((line) => console.error(line));
  let options;
  try {
    options = parseArgs(argv, deps.env ?? process.env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    errorLog(`check-email-dns: ${error.message}\n\n${HELP}`);
    return 2;
  }
  if (options.help) {
    log(HELP);
    return 0;
  }

  let resolver = deps.resolver;
  if (!resolver) {
    resolver = new Resolver({ timeout: 5000, tries: 2 });
    if (options.server) resolver.setServers([options.server]);
  }

  let checks;
  try {
    checks = await runChecks(options, resolver);
  } catch (error) {
    errorLog(`check-email-dns: DNS を引けませんでした (${error?.code ?? error?.message ?? error})。ネットワークと --server を確かめてください。`);
    return 1;
  }
  log(formatReport(checks, options));
  return checks.some((check) => check.level === 'fail') ? 1 : 0;
}
