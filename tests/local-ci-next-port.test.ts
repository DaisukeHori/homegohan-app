/**
 * #1584 scripts/local-ci.sh が Next (next dev / next start) を起こすとき、待ち受けるポートを PORT にも入れる
 *
 * 運営画面のサーバー側 fetch (src/lib/admin/fetch.ts の adminFetch) は、NEXTAUTH_URL も VERCEL_URL も無いと
 * http://localhost:<PORT> の自分自身に問い合わせる。local-ci.sh は枠 (slot) ごとに Next のポートをずらすので、
 * `next start -p <ポート>` だけで PORT を入れないと、adminFetch は既定の 3000 = 別の枠のサーバー (か、誰もいないポート) に繋がり、
 * 運営画面の一覧が空になる。
 *
 * ソースだけを見る静的検査: コメント (# 以降) を除いた各行のうち Next を起こす行について、
 *   1. `export PORT="$X"` があること
 *   2. `-p "$Y"` でポートを渡していれば、X と Y が同じ変数であること
 * を確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.join(process.cwd(), 'scripts/local-ci.sh');

/** Next のサーバーを起こすコマンド (ビルドは除く) */
const NEXT_SERVER_LAUNCH = /\b(?:npx\s+next\s+(?:start|dev)|npm\s+run\s+(?:start|dev))\b/;
const EXPORT_PORT = /\bexport\s+PORT="\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"/;
const PORT_FLAG = /\s-p\s+"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"/;

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

/** Next を起こす行を挙げ、PORT の渡し忘れ・食い違いを返す */
function findNextLaunches(source: string): { launches: number; problems: LaunchProblem[] } {
  let launches = 0;
  const problems: LaunchProblem[] = [];
  source.split('\n').forEach((raw, index) => {
    const code = stripComment(raw);
    if (!NEXT_SERVER_LAUNCH.test(code)) return;
    launches += 1;
    const line = index + 1;
    const exported = EXPORT_PORT.exec(code);
    if (!exported) {
      problems.push({ line, problem: 'PORT を export していない' });
      return;
    }
    const flag = PORT_FLAG.exec(code);
    if (flag && flag[1] !== exported[1]) {
      problems.push({ line, problem: `PORT ($${exported[1]}) と -p ($${flag[1]}) が違う` });
    }
  });
  return { launches, problems };
}

describe('検出の仕組みの確認 (空振りしないこと)', () => {
  it('PORT の渡し忘れ・-p との食い違いを見つけ、コメントの中のコマンドは見ない', () => {
    const source = [
      '( ci_env && cd "$WT" && exec nohup env X=on npx next start -p "$ENFORCED_APP_PORT" ) >"$log" 2>&1 &',
      '( ci_env && cd "$WT" && export PORT="$APP_PORT" && exec nohup env X=on npx next start -p "$NOTICE_APP_PORT" ) &',
      '( ci_env && cd "$WT" && exec nohup npm run dev ) &',
      '( ci_env && cd "$WT" && export PORT="$APP_PORT" && exec nohup npm run start ) &',
      '  # npx next start -p "$ENFORCED_APP_PORT" はコメントなので数えない',
      '  run_in "$WT" "$log" npm run build',
    ].join('\n');

    const { launches, problems } = findNextLaunches(source);

    expect(launches).toBe(4);
    expect(problems).toEqual([
      { line: 1, problem: 'PORT を export していない' },
      { line: 2, problem: 'PORT ($APP_PORT) と -p ($NOTICE_APP_PORT) が違う' },
      { line: 3, problem: 'PORT を export していない' },
    ]);
  });
});

describe('scripts/local-ci.sh: Next を起こすときに、待ち受けるポートを PORT にも入れる (#1584)', () => {
  it('Next を起こすすべての行が、-p と同じポートを PORT として export している', () => {
    const { launches, problems } = findNextLaunches(fs.readFileSync(SCRIPT, 'utf-8'));

    // 走査が空振りしていないこと: 結合テストの next dev・e2e の next start 3 つ (通常・同意の強制あり・お知らせあり)
    expect(launches).toBeGreaterThanOrEqual(4);
    expect(problems).toEqual([]);
  });
});
