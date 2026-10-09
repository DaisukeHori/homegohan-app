import { describe, expect, it } from 'vitest';
import {
  APP_LOG_ALERT_COOLDOWN_MINUTES,
  APP_LOG_ALERT_ERROR_THRESHOLD,
  APP_LOG_ALERT_KEY,
  APP_LOG_ALERT_MAX_FUNCTIONS,
  APP_LOG_ALERT_WINDOW_MINUTES,
  NO_FUNCTION_NAME_LABEL,
  SUPER_ADMIN_LOGS_PATH,
  exceedsErrorThreshold,
  parseErrorCountRows,
  sanitizeFunctionNameForAlert,
  summarizeErrorCounts,
  type ErrorCountRow,
} from '@/lib/ops-alerts/app-log-error-spike';

// #1157 本番エラーの急増を運用メールに知らせる: しきい値の判定と、メールに載せる内容の整え方 (純粋な関数)。
// DB・メール送信は route のテスト (src/__tests__/api/cron/app-log-alerts.test.ts) で確かめる。

const row = (function_name: string | null, error_count: number, total_count: number): ErrorCountRow => ({
  function_name,
  error_count,
  total_count,
});

describe('定数 (#1157)', () => {
  it('K-1: オーナー判断どおりの値: 15 分の窓・20 件・同じ通知は 60 分は送り直さない', () => {
    expect(APP_LOG_ALERT_WINDOW_MINUTES).toBe(15);
    expect(APP_LOG_ALERT_ERROR_THRESHOLD).toBe(20);
    expect(APP_LOG_ALERT_COOLDOWN_MINUTES).toBe(60);
    expect(APP_LOG_ALERT_KEY).toBe('app_logs_error_spike');
    expect(SUPER_ADMIN_LOGS_PATH).toBe('/super-admin/logs');
  });

  it('K-2: DB の関数 app_log_error_counts が受け付ける範囲 (窓 1〜1440 分・行数 1〜100) に収まっている', () => {
    expect(APP_LOG_ALERT_WINDOW_MINUTES).toBeGreaterThanOrEqual(1);
    expect(APP_LOG_ALERT_WINDOW_MINUTES).toBeLessThanOrEqual(1440);
    expect(APP_LOG_ALERT_MAX_FUNCTIONS).toBeGreaterThanOrEqual(1);
    expect(APP_LOG_ALERT_MAX_FUNCTIONS).toBeLessThanOrEqual(100);
    // claim_ops_alert のクールダウンは 1〜10080 分
    expect(APP_LOG_ALERT_COOLDOWN_MINUTES).toBeGreaterThanOrEqual(1);
    expect(APP_LOG_ALERT_COOLDOWN_MINUTES).toBeLessThanOrEqual(10080);
  });
});

describe('exceedsErrorThreshold (#1157)', () => {
  it('T-1: しきい値ちょうどまでは通知しない。1 件でも超えたら通知する (20 件は対象外、21 件から)', () => {
    expect(exceedsErrorThreshold(0)).toBe(false);
    expect(exceedsErrorThreshold(1)).toBe(false);
    expect(exceedsErrorThreshold(19)).toBe(false);
    expect(exceedsErrorThreshold(20)).toBe(false);
    expect(exceedsErrorThreshold(21)).toBe(true);
    expect(exceedsErrorThreshold(5000)).toBe(true);
  });

  it('T-2: しきい値を引数で変えられる', () => {
    expect(exceedsErrorThreshold(10, 10)).toBe(false);
    expect(exceedsErrorThreshold(11, 10)).toBe(true);
    expect(exceedsErrorThreshold(0, 0)).toBe(false);
    expect(exceedsErrorThreshold(1, 0)).toBe(true);
  });
});

describe('summarizeErrorCounts (#1157)', () => {
  it('S-1: 行が無ければ合計 0・関数なし・その他 0', () => {
    expect(summarizeErrorCounts([])).toEqual({ total: 0, functions: [], otherCount: 0 });
  });

  it('S-2: 件数の多い順に並べ、同じ件数なら名前順にする', () => {
    const summary = summarizeErrorCounts([
      row('b-fn', 5, 20),
      row('a-fn', 5, 20),
      row('top-fn', 10, 20),
    ]);

    expect(summary.functions).toEqual([
      { name: 'top-fn', count: 10 },
      { name: 'a-fn', count: 5 },
      { name: 'b-fn', count: 5 },
    ]);
    expect(summary.total).toBe(20);
    expect(summary.otherCount).toBe(0);
  });

  it('S-3: DB が上位だけを返したとき、全体の合計は total_count、載せなかった分は otherCount になる', () => {
    // 全体 50 件のうち、上位 2 関数 (30 + 8) だけが返ってきた
    const summary = summarizeErrorCounts([row('POST /api/meals', 30, 50), row('cron/process-menu-queue', 8, 50)]);

    expect(summary.total).toBe(50);
    expect(summary.functions.map((f) => f.count)).toEqual([30, 8]);
    expect(summary.otherCount).toBe(12);
  });

  it('S-4: 載せる関数の数を maxFunctions で絞ると、載せなかった分は otherCount に入る', () => {
    const rows = [row('a', 9, 30), row('b', 8, 30), row('c', 7, 30), row('d', 6, 30)];
    const summary = summarizeErrorCounts(rows, 2);

    expect(summary.functions).toEqual([
      { name: 'a', count: 9 },
      { name: 'b', count: 8 },
    ]);
    expect(summary.total).toBe(30);
    expect(summary.otherCount).toBe(13);
  });

  it('S-5: function_name が NULL・空・空白だけの行は「関数名なし」にまとめて件数を足す', () => {
    const summary = summarizeErrorCounts([row(null, 3, 10), row('', 2, 10), row('   ', 1, 10), row('real-fn', 4, 10)]);

    expect(summary.functions).toEqual([
      { name: NO_FUNCTION_NAME_LABEL, count: 6 },
      { name: 'real-fn', count: 4 },
    ]);
    expect(summary.total).toBe(10);
  });

  it('S-6: ID だけが違う関数名は、マスクしたあとの名前でまとめて件数を足す', () => {
    const summary = summarizeErrorCounts([
      row('GET /api/users/11111111-1111-4111-8111-111111111111/notes', 7, 12),
      row('GET /api/users/22222222-2222-4222-8222-222222222222/notes', 5, 12),
    ]);

    expect(summary.functions).toEqual([{ name: 'GET /api/users/[id]/notes', count: 12 }]);
    expect(summary.total).toBe(12);
    expect(summary.otherCount).toBe(0);
  });

  it('S-7: total_count が行の合計より小さくても、合計を行の合計より小さくしない', () => {
    const summary = summarizeErrorCounts([row('a', 6, 3), row('b', 4, 3)]);

    expect(summary.total).toBe(10);
    expect(summary.otherCount).toBe(0);
  });

  it('S-8: しきい値の判定は total で行う (関数ごとではなく、全体の合計)', () => {
    // 1 関数あたりは 5 件ずつで少ないが、全体では 25 件 (しきい値 20 を超える)
    const rows = Array.from({ length: 5 }, (_, i) => row(`fn-${i}`, 5, 25));
    const summary = summarizeErrorCounts(rows);

    expect(summary.total).toBe(25);
    expect(exceedsErrorThreshold(summary.total)).toBe(true);
    expect(summary.functions.every((f) => !exceedsErrorThreshold(f.count))).toBe(true);
  });
});

describe('sanitizeFunctionNameForAlert (#1157)', () => {
  it('N-1: 通常の関数名 (ルート名・cron 名・Edge Function 名) はそのまま', () => {
    for (const name of [
      'GET /api/org/settings',
      'POST /api/meals',
      'cron/process-menu-queue',
      'email',
      'stripe-webhook',
      'generate-menu-v5',
      'GET /api/admin/inquiries/[id]',
    ]) {
      expect(sanitizeFunctionNameForAlert(name)).toBe(name);
    }
  });

  it('N-2: null / undefined / 空 / 空白だけは「関数名なし」', () => {
    expect(sanitizeFunctionNameForAlert(null)).toBe(NO_FUNCTION_NAME_LABEL);
    expect(sanitizeFunctionNameForAlert(undefined)).toBe(NO_FUNCTION_NAME_LABEL);
    expect(sanitizeFunctionNameForAlert('')).toBe(NO_FUNCTION_NAME_LABEL);
    expect(sanitizeFunctionNameForAlert(' \n\t ')).toBe(NO_FUNCTION_NAME_LABEL);
  });

  it('N-3: UUID (ユーザー ID など) は載せない', () => {
    const out = sanitizeFunctionNameForAlert('GET /api/users/123e4567-e89b-12d3-a456-426614174000/notes');

    expect(out).toBe('GET /api/users/[id]/notes');
    expect(out).not.toMatch(/123e4567/);
  });

  it('N-4: メールアドレスは載せない', () => {
    const out = sanitizeFunctionNameForAlert('notify taro.yamada@example.com failed');

    expect(out).not.toContain('taro');
    expect(out).not.toContain('@');
    expect(out).toContain('[email]');
  });

  it('N-5: トークンや鍵の書式はマスクする', () => {
    const jwtLike = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;

    expect(sanitizeFunctionNameForAlert(`auth ${jwtLike}`)).not.toContain(jwtLike);
    expect(sanitizeFunctionNameForAlert('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345')).not.toContain('abcdefghijklmnop');
  });

  it('N-6: 改行・タブ・NUL・行区切りなどの制御文字は空白 1 つにして、1 行にする', () => {
    // 目に見えない文字をソースに直接書かないよう、コードポイントから作る
    const nul = String.fromCharCode(0x0000);
    const lineSeparator = String.fromCharCode(0x2028);
    const rightToLeftOverride = String.fromCharCode(0x202e);

    expect(sanitizeFunctionNameForAlert(`a\r\nb\tc${nul}d${lineSeparator}e${rightToLeftOverride}f`)).toBe('a b c d e f');
  });

  it('N-7: 80 文字までに収め、超える分は … にする (サロゲートペアを途中で切らない)', () => {
    const long = sanitizeFunctionNameForAlert('x'.repeat(200));
    expect(long).toBe(`${'x'.repeat(79)}…`);
    expect(long.length).toBe(80);

    // 絵文字 (UTF-16 で 2 つ分) が切れ目にかかっても、孤立したサロゲートを残さない
    const emoji = sanitizeFunctionNameForAlert(`${'x'.repeat(78)}😀😀😀`);
    expect(emoji.length).toBeLessThanOrEqual(80);
    expect(emoji.endsWith('…')).toBe(true);
    expect(encodeURIComponent(emoji)).toBeTruthy(); // 孤立サロゲートがあると URIError になる
  });

  it('N-8: 日本語の関数名はそのまま残る', () => {
    expect(sanitizeFunctionNameForAlert('献立生成 (週間)')).toBe('献立生成 (週間)');
  });

  it('N-9: 何度かけても同じ結果になる (メール側でもう一度かけても表示が変わらない)', () => {
    for (const name of [
      'GET /api/users/123e4567-e89b-12d3-a456-426614174000/notes',
      'notify taro@example.com failed',
      'x'.repeat(300),
      '  spaced   out  name ',
      null,
    ]) {
      const once = sanitizeFunctionNameForAlert(name);
      expect(sanitizeFunctionNameForAlert(once)).toBe(once);
    }
  });
});

describe('parseErrorCountRows (#1157)', () => {
  it('P-1: DB の応答 (配列) を型付きの行にする。function_name は NULL もあり', () => {
    expect(
      parseErrorCountRows([
        { function_name: 'POST /api/meals', error_count: 30, total_count: 50 },
        { function_name: null, error_count: 20, total_count: 50 },
      ]),
    ).toEqual([
      { function_name: 'POST /api/meals', error_count: 30, total_count: 50 },
      { function_name: null, error_count: 20, total_count: 50 },
    ]);
  });

  it('P-2: 行が無い (error が 1 件も無い) 応答は空の配列', () => {
    expect(parseErrorCountRows([])).toEqual([]);
  });

  it('P-3: bigint が数字だけの文字列で来ても受け付ける', () => {
    expect(parseErrorCountRows([{ function_name: 'a', error_count: '7', total_count: '9' }])).toEqual([
      { function_name: 'a', error_count: 7, total_count: 9 },
    ]);
  });

  it('P-4: 形が想定と違うときは例外にする (黙って 0 件として扱うと、アラートが静かに止まる)', () => {
    const bad: unknown[] = [
      null,
      undefined,
      {},
      'rows',
      [null],
      ['row'],
      [{ function_name: 'a', error_count: -1, total_count: 1 }],
      [{ function_name: 'a', error_count: 1.5, total_count: 2 }],
      [{ function_name: 'a', error_count: Number.NaN, total_count: 2 }],
      [{ function_name: 'a', error_count: '1e3', total_count: 2 }],
      [{ function_name: 'a', error_count: 1 }],
      [{ function_name: 'a', total_count: 1 }],
      [{ function_name: 123, error_count: 1, total_count: 1 }],
    ];
    for (const data of bad) {
      expect(() => parseErrorCountRows(data), JSON.stringify(data)).toThrow();
    }
  });

  it('P-5: 例外の文面に、応答の値 (関数名など) を含めない', () => {
    try {
      parseErrorCountRows([{ function_name: 'secret-looking-name', error_count: -1, total_count: 1 }]);
      throw new Error('例外になるはず');
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('secret-looking-name');
    }
  });
});
