/**
 * #1584 / #1611 Next (next dev / next start) を起こすとき、待ち受けるポートを PORT にも入れる
 *
 * 運営画面のサーバー側 fetch (src/lib/admin/fetch.ts の adminFetch) は、NEXTAUTH_URL も VERCEL_URL も無いと
 * http://localhost:<PORT> の自分自身に問い合わせる。`next start -p <ポート>` だけで PORT を入れないと、
 * adminFetch は既定の 3000 = 別のサーバー (か、誰もいないポート) に繋がり、運営画面の一覧が空になる。
 *   - scripts/local-ci.sh は枠 (slot) ごとに Next のポートをずらすので、Next を起こすすべての行で PORT を入れる (#1584)
 *   - CI のワークフロー (.github/workflows/*.yml) は、2 つ目・3 つ目のサーバーを `-p 3001` / `-p 3002` で起こす。
 *     そこにも同じ値の PORT を入れる (#1611)。-p を付けずに起こす行 (`npm run start` など) は、Next も adminFetch も
 *     PORT が無ければ 3000 を使うので食い違わない (PORT は求めない)
 *
 * ソースだけを見る静的検査: コメント (# 以降) を除いた各行のうち Next を起こす行について、
 *   1. PORT を入れていること (`export PORT="$X"`・`env PORT="$X" ...`・`PORT=3001 ...`)。ワークフローは -p を付けた行だけ
 *   2. -p でポートを渡していれば、PORT と -p が同じ値 (同じ変数か、同じ数) であること
 * を確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, 'scripts/local-ci.sh');
const WORKFLOW_DIR = path.join(ROOT, '.github/workflows');

/** Next のサーバーを起こすコマンド (ビルドは除く) */
const NEXT_SERVER_LAUNCH = /\b(?:npx\s+next\s+(?:start|dev)|npm\s+run\s+(?:start|dev))\b/;
/** ポートの値: `"$X"` / `"${X}"` / `$X` / 数 (`3001` / `"3001"`) */
const PORT_VALUE = String.raw`(?:"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"|\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?|"?([0-9]+)"?)`;
/** 値の後ろ (語の切れ目) */
const VALUE_END = String.raw`(?=[\s;&|)]|$)`;
/** PORT への代入 (`export PORT=` / `env PORT=` / 行頭の `PORT=`)。ENFORCED_APP_PORT= などの別の変数は対象外 */
const PORT_ASSIGNMENT = new RegExp(String.raw`(?<![A-Za-z0-9_])PORT=${PORT_VALUE}${VALUE_END}`);
const PORT_FLAG = new RegExp(String.raw`\s-p\s+${PORT_VALUE}${VALUE_END}`);

/** 照合用に値をそろえる (変数は `$名前`、数はそのまま) */
function portValueOf(match: RegExpExecArray | null): string | null {
  if (!match) return null;
  const variable = match[1] ?? match[2];
  return variable !== undefined ? `$${variable}` : match[3];
}

/** 行のうち、クォートの外の # から後ろ (コメント) を除く */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

interface LaunchProblem {
  line: number;
  problem: string;
}

interface LaunchScan {
  launches: number;
  /** -p でポートを渡している起動の数 */
  withPortFlag: number;
  problems: LaunchProblem[];
}

/**
 * Next を起こす行を挙げ、PORT の渡し忘れ・-p との食い違いを返す。
 * requirePortWithoutFlag: -p を付けない起動にも PORT を求めるか (local-ci.sh は求める。ワークフローは求めない)
 */
function findNextLaunches(source: string, requirePortWithoutFlag: boolean): LaunchScan {
  let launches = 0;
  let withPortFlag = 0;
  const problems: LaunchProblem[] = [];
  source.split('\n').forEach((raw, index) => {
    const code = stripComment(raw);
    if (!NEXT_SERVER_LAUNCH.test(code)) return;
    launches += 1;
    const line = index + 1;
    const port = portValueOf(PORT_ASSIGNMENT.exec(code));
    const flag = portValueOf(PORT_FLAG.exec(code));
    if (flag !== null) withPortFlag += 1;
    if (port === null) {
      if (flag !== null || requirePortWithoutFlag) problems.push({ line, problem: 'PORT を渡していない' });
      return;
    }
    if (flag !== null && flag !== port) {
      problems.push({ line, problem: `PORT (${port}) と -p (${flag}) が違う` });
    }
  });
  return { launches, withPortFlag, problems };
}

/** .github/workflows の YAML (ファイル名の昇順) */
function workflowFiles(): string[] {
  return fs
    .readdirSync(WORKFLOW_DIR)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => path.join(WORKFLOW_DIR, name));
}

describe('検出の仕組みの確認 (空振りしないこと)', () => {
  it('local-ci.sh の書き方: PORT の渡し忘れ・-p との食い違いを見つけ、コメントの中のコマンドは見ない', () => {
    const source = [
      '( ci_env && cd "$WT" && exec nohup env X=on npx next start -p "$ENFORCED_APP_PORT" ) >"$log" 2>&1 &', // 1
      '( ci_env && cd "$WT" && export PORT="$APP_PORT" && exec nohup env X=on npx next start -p "$NOTICE_APP_PORT" ) &', // 2
      '( ci_env && cd "$WT" && exec nohup npm run dev ) &', // 3
      '( ci_env && cd "$WT" && export PORT="$APP_PORT" && exec nohup npm run start ) &', // 4
      '  # npx next start -p "$ENFORCED_APP_PORT" はコメントなので数えない', // 5
      '  run_in "$WT" "$log" npm run build', // 6
      '( ci_env && cd "$WT" && exec nohup env PORT="$NOTICE_APP_PORT" X=on npx next start -p "$NOTICE_APP_PORT" ) &', // 7
      '( ci_env && cd "$WT" && exec nohup env ENFORCED_APP_PORT="$A" npx next start -p "$A" ) &', // 8: 別の変数は PORT ではない
      '( ci_env && cd "$WT" && exec nohup env PORT="${A}" npx next start -p "$B" ) &', // 9
    ].join('\n');

    const { launches, withPortFlag, problems } = findNextLaunches(source, true);

    expect(launches).toBe(7);
    expect(withPortFlag).toBe(5);
    expect(problems).toEqual([
      { line: 1, problem: 'PORT を渡していない' },
      { line: 2, problem: 'PORT ($APP_PORT) と -p ($NOTICE_APP_PORT) が違う' },
      { line: 3, problem: 'PORT を渡していない' },
      { line: 8, problem: 'PORT を渡していない' },
      { line: 9, problem: 'PORT ($A) と -p ($B) が違う' },
    ]);
  });

  it('ワークフローの書き方: -p を付けた起動だけ PORT を求め、数の食い違いを見つける (#1611)', () => {
    const source = [
      '          nohup npx next start -p 3001 > /tmp/next-start-enforced.log 2>&1 &', // 1: 以前の e2e-local.yml
      '          PORT=3002 nohup npx next start -p 3001 > /tmp/x.log 2>&1 &', // 2
      '          PORT=3001 nohup npx next start -p 3001 > /tmp/x.log 2>&1 &', // 3
      '          nohup npm run start > /tmp/next-start.log 2>&1 &', // 4: -p なし (どちらも 3000)
      '          # nohup npx next start -p 3001 はコメントなので数えない', // 5
      '          PORT="3002" nohup npx next start -p "3002" &', // 6
      '          PORT=30010 nohup npx next start -p 3001 &', // 7: 数の一部だけ一致しても同じとみなさない
    ].join('\n');

    const { launches, withPortFlag, problems } = findNextLaunches(source, false);

    expect(launches).toBe(6);
    expect(withPortFlag).toBe(5);
    expect(problems).toEqual([
      { line: 1, problem: 'PORT を渡していない' },
      { line: 2, problem: 'PORT (3002) と -p (3001) が違う' },
      { line: 7, problem: 'PORT (30010) と -p (3001) が違う' },
    ]);
  });
});

describe('scripts/local-ci.sh: Next を起こすときに、待ち受けるポートを PORT にも入れる (#1584)', () => {
  it('Next を起こすすべての行が、-p と同じポートを PORT として渡している', () => {
    const { launches, withPortFlag, problems } = findNextLaunches(fs.readFileSync(SCRIPT, 'utf-8'), true);

    // 走査が空振りしていないこと: 結合テストの next dev・e2e の next start 3 つ (通常・同意の強制あり・お知らせあり)
    expect(launches).toBeGreaterThanOrEqual(4);
    // -p で起こすもの: 同意の強制あり・お知らせあり
    expect(withPortFlag).toBeGreaterThanOrEqual(2);
    expect(problems).toEqual([]);
  });
});

describe('.github/workflows: -p で Next を起こす行は、同じポートを PORT にも入れる (#1611)', () => {
  it('ワークフローの Next を起こす行で、-p と PORT が一致している', () => {
    const scans = workflowFiles().map((file) => ({
      file: path.relative(ROOT, file),
      ...findNextLaunches(fs.readFileSync(file, 'utf-8'), false),
    }));
    const launches = scans.reduce((sum, scan) => sum + scan.launches, 0);
    const withPortFlag = scans.reduce((sum, scan) => sum + scan.withPortFlag, 0);
    const problems = scans.flatMap((scan) => scan.problems.map((p) => `${scan.file}:${p.line} ${p.problem}`));

    // 走査が空振りしていないこと: e2e-local.yml の next start 3 つ・security-regression.yml の next dev
    expect(launches).toBeGreaterThanOrEqual(4);
    // e2e-local.yml の同意の強制あり (3001)・お知らせあり (3002)
    expect(withPortFlag).toBeGreaterThanOrEqual(2);
    expect(problems).toEqual([]);
  });
});
