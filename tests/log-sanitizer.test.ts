/**
 * tests/log-sanitizer.test.ts
 *
 * #1171: app_logs に保存するログ文面のサニタイザ (supabase/functions/_shared/log-sanitizer.ts)。
 *  - 秘密情報の書式のマスク / 無害な文面を壊さないこと / 冪等性
 *  - 悪意のある長い入力でも時間がかからないこと (正規表現の量指定子が上限付きであること)
 *  - sanitizeLogEntry (3 つの文字列項目 + metadata + user_id)
 *  - Edge Functions と Next.js のロガーがこのサニタイザを通してから insert していること (ソース文字列の契約テスト)
 *
 * Deno 側の db-logger.ts は https://esm.sh から import するためテストでは読み込めない。
 * そこは実行時のモックではなく、ソースの契約テストで配線を守る (tests/llm-grok-migration.test.ts と同じ方式)。
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  LOG_SANITIZER_FAILED_MESSAGE,
  LOG_TEXT_RULES,
  LOG_TRUNCATED_SUFFIX,
  MAX_LOG_ERROR_MESSAGE_CHARS,
  MAX_LOG_MESSAGE_CHARS,
  MAX_LOG_STACK_CHARS,
  SCAN_LIMIT,
  maskSecrets,
  maskSecretsInText,
  sanitizeLogEntry,
  sanitizeLogText,
  sanitizeMetadata,
  truncateMetadata,
  type SanitizableLogEntry,
} from "../supabase/functions/_shared/log-sanitizer.ts";

// 秘密情報に見える文字列は、リポジトリのシークレットスキャンに誤検知されないよう実行時に組み立てる
const join = (...parts: string[]) => parts.join("");

const FAKE = {
  jwt: join(
    "eyJ",
    "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    ".",
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0",
    ".",
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ),
  openai: join("sk-", "proj-", "abcdefghijklmnopqrstuvwxyz0123456789ABCD"),
  google: join("AI", "za", "SyA1234567890abcdefghijklmnopqrstuv"),
  supabaseSecret: join("sb_", "secret_", "abcdefghijklmnopqrstuvwxyz012345"),
  stripeSecret: join("sk_", "live_", "abcdefghijklmnopqrstuvwx"),
  stripeWebhook: join("wh", "sec_", "abcdefghijklmnopqrstuv"),
  xai: join("xa", "i-", "abcdefghijklmnopqrstuvwxyz0123"),
  github: join("gh", "p_", "abcdefghijklmnopqrstuvwxyz0123456789"),
  aws: join("AK", "IA", "ABCDEFGHIJKLMNOP"),
  slack: join("xo", "xb-", "1234567890-abcdefghij"),
  resend: join("re", "_", "abcd1234", "_", "efgh5678ijkl"),
  bearer: "abcdefghijklmnopqrstuvwx0123456789",
  pemHeader: join("-----BEGIN ", "RSA PRIVATE KEY", "-----"),
  pemFooter: join("-----END ", "RSA PRIVATE KEY", "-----"),
};

const VALID_UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

describe("maskSecretsInText – 秘密情報の書式をマスクする", () => {
  const providerKeys: Array<[string, string]> = [
    ["JWT", FAKE.jwt],
    ["OpenAI (sk-proj-)", FAKE.openai],
    ["Google (AIza)", FAKE.google],
    ["Supabase (sb_secret_)", FAKE.supabaseSecret],
    ["Stripe 秘密鍵", FAKE.stripeSecret],
    ["Stripe Webhook", FAKE.stripeWebhook],
    ["xAI", FAKE.xai],
    ["GitHub", FAKE.github],
    ["AWS", FAKE.aws],
    ["Slack", FAKE.slack],
    ["Resend", FAKE.resend],
  ];

  it.each(providerKeys)("%s のキーは文中のどこにあってもマスクされる", (_label, secret) => {
    const out = maskSecretsInText(`upstream error: ${secret} was rejected (status 401)`);
    expect(out).not.toContain(secret);
    expect(out).toBe("upstream error: *** was rejected (status 401)");
  });

  it("Bearer トークン: 語は残してトークンだけをマスクする", () => {
    expect(maskSecretsInText(`header Bearer ${FAKE.bearer} sent`)).toBe("header Bearer *** sent");
    expect(maskSecretsInText(`header bearer ${FAKE.bearer}`)).toBe("header bearer ***");
  });

  it("Authorization: 認証方式の語ごと値をマスクする (短い値や Basic 認証も)", () => {
    expect(maskSecretsInText(`Authorization: Bearer ${FAKE.bearer}`)).toBe("Authorization: ***");
    expect(maskSecretsInText("authorization: Bearer abc123")).toBe("authorization: ***");
    expect(maskSecretsInText("Authorization: Basic dXNlcjpwYXNzd29yZA==")).toBe("Authorization: ***");
  });

  it("接続文字列 (scheme://user:password@host): パスワードだけをマスクしてホストは残す", () => {
    expect(
      maskSecretsInText("connect postgresql://postgres.abcd:S3cr3t!pass@aws-0.pooler.supabase.com:6543/postgres failed"),
    ).toBe("connect postgresql://postgres.abcd:***@aws-0.pooler.supabase.com:6543/postgres failed");
    expect(maskSecretsInText("GET https://user:pa55@example.com/x?y=1")).toBe("GET https://user:***@example.com/x?y=1");
    // パスワードに @ が含まれていても、最後の @ までを値として扱う
    expect(maskSecretsInText("postgres://u:p@ss@host.example.com:5432/db")).toBe("postgres://u:***@host.example.com:5432/db");
  });

  it("password=... / パスワードを含む JSON / トークンのクエリ: キー名の直後の値をマスクする", () => {
    expect(maskSecretsInText("login failed password=hunter2 for bob")).toBe("login failed password=*** for bob");
    expect(maskSecretsInText('{"user":"bob","password":"hunter2","n":1}')).toBe('{"user":"bob","password":"***","n":1}');
    expect(maskSecretsInText('{"api_key":"abc123"}')).toBe('{"api_key":"***"}');
    expect(maskSecretsInText("x-api-key: abc123def456")).toBe("x-api-key: ***");
    expect(maskSecretsInText("GET /invite/accept?token=abc123DEF&x=1")).toBe("GET /invite/accept?token=***&x=1");
    expect(maskSecretsInText("access_token=abcDEF123 refresh_token: xyz987")).toBe("access_token=*** refresh_token: ***");
    // JSON 文字列の中にエスケープされて入っている場合
    expect(maskSecretsInText('body: {\\"password\\":\\"hunter2\\"}')).not.toContain("hunter2");
  });

  it("Postgres のエラー詳細: 衝突した値と制約に違反した行の中身をマスクする", () => {
    expect(
      maskSecretsInText('duplicate key value violates unique constraint "u_email_key" DETAIL: Key (email)=(a.b@example.com) already exists.'),
    ).toBe('duplicate key value violates unique constraint "u_email_key" DETAIL: Key (email)=(***) already exists.');
    const out = maskSecretsInText("null value in column \"x\" violates not-null constraint\nDETAIL: Failing row contains (id-1, a@b.com, secret text, null).");
    expect(out).toBe('null value in column "x" violates not-null constraint\nDETAIL: Failing row contains (***)');
  });

  it("メールアドレスは [email] に置き換える", () => {
    expect(maskSecretsInText("contact taro.yamada+test@example.co.jp now")).toBe("contact [email] now");
    expect(maskSecretsInText("a@b.com, c@d.org")).toBe("[email], [email]");
    // URL のクエリでは @ が %40 になる (招待・ログインの遷移先に email が入る)
    expect(maskSecretsInText("GET /login?redirect=/invite/x&email=taro%40example.com&role=member")).toBe(
      "GET /login?redirect=/invite/x&email=[email]&role=member",
    );
  });

  it("PEM 形式の秘密鍵は本体ごと消す", () => {
    const pem = `${FAKE.pemHeader}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nabcdef\n${FAKE.pemFooter}`;
    const out = maskSecretsInText(`key: ${pem} end`);
    expect(out).not.toContain("MIIEvQ");
    expect(out.startsWith("key: ***")).toBe(true);
  });

  it("1 つの文字列に複数の秘密情報があれば全部マスクする", () => {
    const out = maskSecretsInText(`${FAKE.openai} then ${FAKE.jwt} and password=hunter2 and a@b.com`);
    expect(out).toBe("*** then *** and password=*** and [email]");
  });

  it("同じ入力を続けて渡しても結果が変わらない (グローバル正規表現の lastIndex が呼び出し間で持ち越されない)", () => {
    const text = `x ${FAKE.openai} y`;
    expect(maskSecretsInText(text)).toBe("x *** y");
    expect(maskSecretsInText(text)).toBe("x *** y");
  });
});

describe("maskSecretsInText – 無害な文面は変えない", () => {
  const benign = [
    "メニューの生成に失敗しました (ユーザー操作)",
    'duplicate key value violates unique constraint "x_pkey"',
    "meal 123e4567-e89b-12d3-a456-426614174000 not found",
    "    at fetch (node_modules/@supabase/supabase-js/dist/main/index.js:12:3)",
    "    at foo (node_modules/pkg@1.2.3/index.js:1:1)",
    "    at https://esm.sh/@supabase/postgrest-js@1.19.4/es2022/postgrest-js.mjs:2:3",
    "    at file:///src/index.ts:10:5",
    "/app/node_modules/.pnpm/foo@1.0.0/node_modules/foo/index.js",
    "Basic information is required",
    "Missing access token",
    "max_tokens=4096 total tokens: 120 input_tokens: 5",
    'column "password" of relation "users" does not exist',
    "Bearer token missing",
    "fetch http://localhost:3000/api/log?x=a@b failed",
    "AuthApiError: Invalid login credentials",
    // 単語の途中に sk- / re_ が現れる普通の語 (キーと取り違えない)
    "task-management-system-overview-document is ready",
    "risk-based-assessment-and-planning-for-meals",
    "more_information_available_for_users",
    "",
    " ",
  ];

  it.each(benign)("そのまま返す: %j", (text) => {
    expect(maskSecretsInText(text)).toBe(text);
  });
});

describe("maskSecretsInText – 冪等性", () => {
  // 決定的な疑似乱数 (LCG)。失敗したときに同じ入力を再現できる
  function makeRandom(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  const fragments = [
    FAKE.jwt, FAKE.openai, FAKE.google, FAKE.supabaseSecret, FAKE.stripeSecret, FAKE.github, FAKE.aws, FAKE.resend,
    "Bearer ", FAKE.bearer, "Authorization: ", "authorization=Basic ", "password=", "token: ", '"api_key":"', "secret=", "pwd=",
    "postgres://u:p@h:5432/db", "https://user:pa55@example.com/x", "://", "a@b.com", "@", "taro@example.co.jp",
    "Key (email)=(a@b.c) already exists.", "Failing row contains (1, a@b.c, x).", FAKE.pemHeader, FAKE.pemFooter,
    "hello", "メニュー", "🍙", "\n", " ", "  ", "=", ":", '"', "'", "\\", ",", ";", "&", ")", "]", "}", "...", "---", "eyJ", "sk-", "re_",
    "a".repeat(40), "Z".repeat(300), "0123456789",
  ];

  // 断片のつなぎ目は英数字・_ 以外の文字にする。キーの規則は \b (単語境界) で区切られたものだけを対象にする
  // (task-xxx のような普通の語の一部を、キーと取り違えないため)。キー同士が区切りなしで連結している
  // 入力は想定しない (1 つ目をマスクして初めて 2 つ目に境界ができるので、1 回では消えない)。
  const separators = [" ", "\n", ",", "=", ":", "/", "(", '"', "|", "; ", " - "];

  function randomText(random: () => number): string {
    const count = 1 + Math.floor(random() * 30);
    let text = "";
    for (let i = 0; i < count; i++) {
      if (i > 0) text += separators[Math.floor(random() * separators.length)];
      text += fragments[Math.floor(random() * fragments.length)];
    }
    return text;
  }

  it("f(f(x)) === f(x): 固定の入力", () => {
    const inputs = [
      `Authorization: Bearer ${FAKE.bearer}`,
      "postgres://password:secret@host/db",
      "token=sk-short Bearer ",
      `${FAKE.pemHeader} ${"A".repeat(5000)}`,
      "x".repeat(SCAN_LIMIT * 3),
      `${"x".repeat(SCAN_LIMIT - 30)}${FAKE.jwt}${"y".repeat(500)}`,
      `${"🍙".repeat(SCAN_LIMIT)}`,
      `${"a".repeat(SCAN_LIMIT - 1)}🍙${"b".repeat(100)}`,
    ];
    for (const input of inputs) {
      const once = maskSecretsInText(input);
      expect(maskSecretsInText(once)).toBe(once);
    }
  });

  it("f(f(x)) === f(x): 疑似乱数で組み立てた 3000 通り", () => {
    const random = makeRandom(1171);
    for (let i = 0; i < 3000; i++) {
      const input = randomText(random);
      const once = maskSecretsInText(input);
      const twice = maskSecretsInText(once);
      if (twice !== once) {
        throw new Error(`冪等でない入力 (i=${i}): ${JSON.stringify(input)}\n1回目: ${JSON.stringify(once)}\n2回目: ${JSON.stringify(twice)}`);
      }
    }
  });

  it("疑似乱数の入力から、秘密情報の書式が 1 つも残らない", () => {
    const secrets = [FAKE.jwt, FAKE.openai, FAKE.google, FAKE.supabaseSecret, FAKE.stripeSecret, FAKE.github, FAKE.aws, FAKE.resend];
    const random = makeRandom(20261007);
    for (let i = 0; i < 2000; i++) {
      const input = randomText(random);
      const out = maskSecretsInText(input);
      for (const secret of secrets) {
        // 入力に含まれていた秘密情報が、そのままの形では出力に残らない
        expect(out.includes(secret), `i=${i} ${JSON.stringify(input)}`).toBe(false);
      }
    }
  });
});

describe("maskSecretsInText – 上限と、悪意のある入力に対する処理時間", () => {
  // CI が混んでいても落ちないよう、3 回計って最短を使う (実測は数 ms〜数十 ms)
  function bestOfThree(run: () => unknown): number {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      run();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  }

  const window = SCAN_LIMIT + 2048;
  const fit = (unit: string) => unit.repeat(Math.ceil(window / unit.length)).slice(0, window);

  const hostile: Array<[string, string]> = [
    ["'token' x 100000", "token".repeat(100_000)],
    ["'a' x 1e6", "a".repeat(1_000_000)],
    ["'eyJ' の繰り返し", fit("eyJ")],
    ["'eyJ-' の繰り返し", fit("eyJ-")],
    ["JWT の先頭だけの繰り返し", fit("eyJaaaaaaaa.bbbbbbbb.cc")],
    ["ドットの無い長い eyJ", `eyJ${"a".repeat(1_000_000)}`],
    ["'Bearer ' の繰り返し", fit("Bearer ")],
    ["Bearer + 空白だけ", `Bearer${" ".repeat(1_000_000)}`],
    ["'sk-' の繰り返し", fit("sk-")],
    ["'re_' の繰り返し", fit("re_")],
    ["'a://b:' の繰り返し", fit("a://b:")],
    ["パスワード部が長く @ が無い URL", `a://u:${"p".repeat(1_000_000)}`],
    ["'password' の繰り返し", fit("password")],
    ["'password=' の繰り返し", fit("password=")],
    ["password + 空白だけ", `password:${" ".repeat(1_000_000)}x`],
    ["'authorization: Bearer ' の繰り返し", fit("authorization: Bearer ")],
    ["'Key (' の繰り返し", fit("Key (")],
    ["'Failing row contains (' の繰り返し", fit("Failing row contains (")],
    ["'-----BEGIN ' の繰り返し", fit("-----BEGIN ")],
    ["'a@' の繰り返し", fit("a@")],
    ["'a@b.c' の繰り返し", fit("a@b.c")],
    ["'%40' の繰り返し", fit("%40")],
    ["'a%40b' の繰り返し", fit("a%40b")],
    ["'a%40b.c' の繰り返し", fit("a%40b.c")],
    ["ラベルだらけのドメイン", `a@${"b.".repeat(window / 2)}`],
    ["64 文字の局所部 + 数字だけのドメイン", fit(`${"a".repeat(64)}@${`${"1".repeat(63)}.`.repeat(5)}`)],
    ["'.' だけ", ".".repeat(1_000_000)],
    ["'-' だけ", "-".repeat(1_000_000)],
    ["改行だけ", "\n".repeat(1_000_000)],
    ["絵文字だけ", "🍙".repeat(500_000)],
  ];

  it.each(hostile)("%s: 200ms 未満で終わり、出力は上限内に収まる", (_label, input) => {
    let out = "";
    const elapsed = bestOfThree(() => {
      out = maskSecretsInText(input);
    });
    expect(elapsed).toBeLessThan(200);
    expect(out.length).toBeLessThanOrEqual(SCAN_LIMIT + 1 + LOG_TRUNCATED_SUFFIX.length);
    expect((out as string & { isWellFormed(): boolean }).isWellFormed()).toBe(true);
  });

  it("SCAN_LIMIT を超える入力は先頭だけを残して接尾辞を付ける (後ろを生のまま保存しない)", () => {
    const out = maskSecretsInText(`${"a".repeat(SCAN_LIMIT)}tail-secret-${"b".repeat(1000)}`);
    expect(out.endsWith(LOG_TRUNCATED_SUFFIX)).toBe(true);
    expect(out).not.toContain("tail-secret");
    expect(out.length).toBe(SCAN_LIMIT + LOG_TRUNCATED_SUFFIX.length);
  });

  it("切り口をまたぐ JWT も、断片が残らずマスクされる", () => {
    // JWT が SCAN_LIMIT の手前から始まり、切り口の後ろまで続く
    const out = maskSecretsInText(`${"x ".repeat((SCAN_LIMIT - 30) / 2)}${FAKE.jwt}${" y".repeat(2000)}`);
    expect(out).not.toContain("eyJ");
    expect(out).not.toContain("hbGciOi");
    expect(out).not.toContain("SflKxw");
    expect(out.endsWith(LOG_TRUNCATED_SUFFIX)).toBe(true);
  });

  it("切り詰めはサロゲートペア (絵文字) の途中で行わない", () => {
    // SCAN_LIMIT の直前に絵文字がある
    const text = `${"a".repeat(SCAN_LIMIT - 1)}🍙${"b".repeat(5000)}`;
    const out = maskSecretsInText(text);
    expect((out as string & { isWellFormed(): boolean }).isWellFormed()).toBe(true);
    expect(out.startsWith(`${"a".repeat(SCAN_LIMIT - 1)}🍙`)).toBe(true);
  });

  it("LOG_TEXT_RULES の量指定子はすべて上限付き (+ * {n,} を使わない)", () => {
    const unbounded: string[] = [];
    for (const [pattern] of LOG_TEXT_RULES) {
      const source = pattern.source;
      let inClass = false;
      for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (ch === "\\") {
          i++; // エスケープされた文字は量指定子ではない
          continue;
        }
        if (inClass) {
          if (ch === "]") inClass = false;
          continue;
        }
        if (ch === "[") {
          inClass = true;
          continue;
        }
        if (ch === "+" || ch === "*") unbounded.push(`${source} の ${i} 文字目 '${ch}'`);
        if (ch === "{") {
          const close = source.indexOf("}", i);
          if (/^\{\d+,\}$/.test(source.slice(i, close + 1))) unbounded.push(`${source} の ${i} 文字目 ${source.slice(i, close + 1)}`);
        }
      }
    }
    expect(unbounded).toEqual([]);
  });
});

describe("sanitizeLogText", () => {
  it("null / undefined は undefined を返す", () => {
    expect(sanitizeLogText(null, 100)).toBeUndefined();
    expect(sanitizeLogText(undefined, 100)).toBeUndefined();
  });

  it("文字列でない値は文字列に直して処理する (例外を投げない)", () => {
    expect(sanitizeLogText(123, 100)).toBe("123");
    expect(sanitizeLogText(false, 100)).toBe("false");
    expect(sanitizeLogText(new Error("boom password=hunter2"), 100)).toBe("Error: boom password=***");
    expect(sanitizeLogText({}, 100)).toBe("[object Object]");
    expect(sanitizeLogText(Object.create(null), 100)).toBe("[unprintable]");
    expect(sanitizeLogText(Symbol("s"), 100)).toBe("Symbol(s)");
  });

  it("空文字列はそのまま空文字列を返す (undefined にしない)", () => {
    expect(sanitizeLogText("", 100)).toBe("");
  });

  it("max を超えたら切り詰めて接尾辞を付ける。max ちょうどなら付けない", () => {
    expect(sanitizeLogText("a".repeat(100), 100)).toBe("a".repeat(100));
    const out = sanitizeLogText("a".repeat(101), 100)!;
    expect(out).toBe(`${"a".repeat(100)}${LOG_TRUNCATED_SUFFIX}`);
  });

  it("秘密情報は切り詰めの前にマスクする (切り口にかかった秘密情報の断片が残らない)", () => {
    // OpenAI キーが 2000 文字目をまたぐ
    const text = `${"a".repeat(MAX_LOG_MESSAGE_CHARS - 11)} ${FAKE.openai} ${"b".repeat(100)}`;
    const out = sanitizeLogText(text, MAX_LOG_MESSAGE_CHARS)!;
    expect(out).not.toContain("sk-");
    expect(out).not.toContain("proj-");
    expect(out.endsWith(LOG_TRUNCATED_SUFFIX)).toBe(true);
  });

  it("サロゲートペアの途中で切らない (孤立サロゲートは DB の JSON に拒否される)", () => {
    const out = sanitizeLogText(`${"a".repeat(99)}🍙${"b".repeat(100)}`, 100)!;
    expect((out as string & { isWellFormed(): boolean }).isWellFormed()).toBe(true);
    expect(out).toBe(`${"a".repeat(99)}🍙${LOG_TRUNCATED_SUFFIX}`);
  });

  it("もう一度通しても同じ結果になる", () => {
    for (const text of ["a".repeat(5000), `${"a".repeat(99)}🍙${"b".repeat(100)}`, `password=hunter2 ${"x".repeat(3000)}`]) {
      const once = sanitizeLogText(text, 100)!;
      expect(sanitizeLogText(once, 100)).toBe(once);
    }
  });
});

describe("maskSecrets / sanitizeMetadata – 値の文字列", () => {
  it("キー名が無関係でも、値の文字列に含まれる秘密情報の書式をマスクする", () => {
    const result = maskSecrets({ error: `upstream said ${FAKE.openai}`, note: "ok", n: 3 }) as Record<string, unknown>;
    expect(result.error).toBe("upstream said ***");
    expect(result.note).toBe("ok");
    expect(result.n).toBe(3);
  });

  it("配列・ネストの中の文字列もマスクする", () => {
    const result = maskSecrets({ list: [`a ${FAKE.jwt}`, "b"], deep: { url: "postgres://u:p@h/db" } }) as any;
    expect(result.list).toEqual(["a ***", "b"]);
    expect(result.deep.url).toBe("postgres://u:***@h/db");
  });

  it("キー名によるマスクは従来どおり", () => {
    const result = maskSecrets({ password: "x", apiKey: "y", safe: "z" }) as Record<string, unknown>;
    expect(result).toEqual({ password: "***", apiKey: "***", safe: "z" });
  });

  it("入力を書き換えない。Date はそのまま残す", () => {
    const date = new Date("2026-10-07T00:00:00Z");
    const input = { at: date, list: [{ token: "abc", text: `x ${FAKE.openai}` }] };
    const snapshot = JSON.stringify(input);
    const result = maskSecrets(input) as any;
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(result.at).toBe(date);
    expect(result.list[0].token).toBe("***");
    expect(result.list[0].text).toBe("x ***");
  });

  it("BigInt が含まれていても JSON にできる (JSON.stringify は BigInt で例外を投げるため)", () => {
    const result = sanitizeMetadata({ count: 10n, nested: { id: 20n } }) as any;
    expect(result.count).toBe("10");
    expect(result.nested.id).toBe("20");
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("文字列の走査量に上限がある: 小さい文字列を大量に並べても時間がかからず、超えた分は値ごとマスクされる", () => {
    const items = Array.from({ length: 300_000 }, (_, i) => `item-${i}`);
    const start = performance.now();
    const result = maskSecrets({ items }) as { items: string[] };
    expect(performance.now() - start).toBeLessThan(2000);
    expect(result.items[0]).toBe("item-0");
    expect(result.items[result.items.length - 1]).toBe("***");
  });

  it("大きい文字列を大量に並べても時間がかからない", () => {
    const big = "x".repeat(SCAN_LIMIT);
    const leaves = Array.from({ length: 200 }, () => big);
    const start = performance.now();
    const result = maskSecrets({ leaves }) as { leaves: string[] };
    expect(performance.now() - start).toBeLessThan(500);
    expect(result.leaves[0]).toBe(maskSecretsInText(big));
    expect(result.leaves[199]).toBe("***");
  });

  it("通常の大きさの metadata は走査量の上限に届かない", () => {
    const metadata = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, `value ${i} ${"x".repeat(200)}`]));
    const result = maskSecrets(metadata) as Record<string, string>;
    expect(Object.values(result).every((v) => v !== "***")).toBe(true);
  });

  it("8KB を超える metadata は切り詰める。切り口が絵文字の途中でも JSON として妥当な文字列を残す", () => {
    const result = truncateMetadata({ text: "🍙".repeat(5000) })!;
    expect(result._truncated).toBe(true);
    expect((result._preview as string & { isWellFormed(): boolean }).isWellFormed()).toBe(true);
  });
});

describe("sanitizeLogEntry", () => {
  const base: SanitizableLogEntry = {
    level: "error",
    source: "api-route",
    function_name: "api/test",
    user_id: VALID_UUID,
    message: "処理に失敗しました",
    request_id: "req_1_abc",
  };

  it("message / error_message / error_stack の 3 項目から秘密情報をマスクする", () => {
    const out = sanitizeLogEntry({
      ...base,
      message: `login failed password=hunter2 for ${"a@b.com"}`,
      error_message: `Bearer ${FAKE.bearer} rejected`,
      error_stack: `Error: boom ${FAKE.jwt}\n    at foo (file:///src/index.ts:1:1)`,
    });
    expect(out.message).toBe("login failed password=*** for [email]");
    expect(out.error_message).toBe("Bearer *** rejected");
    expect(out.error_stack).toBe("Error: boom ***\n    at foo (file:///src/index.ts:1:1)");
  });

  it("metadata は、キー名と値の両方でマスクする", () => {
    const out = sanitizeLogEntry({
      ...base,
      metadata: { password: "hunter2", error: `x ${FAKE.openai}`, nested: { urls: ["postgres://u:p@h/db"] }, ok: 1 },
    });
    expect(out.metadata).toEqual({ password: "***", error: "x ***", nested: { urls: ["postgres://u:***@h/db"] }, ok: 1 });
  });

  it("巨大な metadata は 8KB に切り詰める", () => {
    const out = sanitizeLogEntry({ ...base, metadata: { blob: "x".repeat(50_000), more: ["y".repeat(50_000)] } });
    expect(out.metadata?._truncated).toBe(true);
  });

  it("文字列項目は上限で切り詰める", () => {
    const out = sanitizeLogEntry({
      ...base,
      message: "m".repeat(MAX_LOG_MESSAGE_CHARS * 3),
      error_message: "e".repeat(MAX_LOG_ERROR_MESSAGE_CHARS * 3),
      error_stack: "s".repeat(MAX_LOG_STACK_CHARS * 3),
    });
    expect(out.message).toBe(`${"m".repeat(MAX_LOG_MESSAGE_CHARS)}${LOG_TRUNCATED_SUFFIX}`);
    expect(out.error_message).toBe(`${"e".repeat(MAX_LOG_ERROR_MESSAGE_CHARS)}${LOG_TRUNCATED_SUFFIX}`);
    expect(out.error_stack).toBe(`${"s".repeat(MAX_LOG_STACK_CHARS)}${LOG_TRUNCATED_SUFFIX}`);
  });

  it("上限以内の文字列、level / source / function_name / request_id はそのまま通す", () => {
    const out = sanitizeLogEntry({ ...base, metadata: { foo: "bar" }, error_message: "boom", error_stack: "Error: boom\n    at x" });
    expect(out).toEqual({
      level: "error",
      source: "api-route",
      function_name: "api/test",
      user_id: VALID_UUID,
      message: "処理に失敗しました",
      metadata: { foo: "bar" },
      error_message: "boom",
      error_stack: "Error: boom\n    at x",
      request_id: "req_1_abc",
    });
  });

  it("省略された項目は省略のまま (null も undefined にそろえる)", () => {
    const out = sanitizeLogEntry({ ...base, user_id: null, metadata: null, error_message: null, error_stack: null, function_name: null, request_id: null });
    expect(out.user_id).toBeUndefined();
    expect(out.metadata).toBeUndefined();
    expect(out.error_message).toBeUndefined();
    expect(out.error_stack).toBeUndefined();
    expect(out.function_name).toBeUndefined();
    expect(out.request_id).toBeUndefined();
  });

  it("uuid の形をした user_id は残す (大文字も可)", () => {
    expect(sanitizeLogEntry({ ...base, user_id: VALID_UUID }).user_id).toBe(VALID_UUID);
    expect(sanitizeLogEntry({ ...base, user_id: VALID_UUID.toUpperCase() }).user_id).toBe(VALID_UUID.toUpperCase());
  });

  it.each(["unknown", "user-uuid-1234", "", " ", `${VALID_UUID} `, ` ${VALID_UUID}`, `${VALID_UUID}0`, "a0eebc999c0b4ef8bb6d6bb9bd380a11", "null", "undefined"])(
    "uuid でない user_id %j は省略する (NULL になる。insert を失敗させてログごと捨てない)",
    (userId) => {
      const out = sanitizeLogEntry({ ...base, user_id: userId });
      expect(out.user_id).toBeUndefined();
      expect(out.message).toBe(base.message);
    },
  );

  it("文字列でない user_id も省略する", () => {
    expect(sanitizeLogEntry({ ...base, user_id: 123 as unknown as string }).user_id).toBeUndefined();
    expect(sanitizeLogEntry({ ...base, user_id: {} as unknown as string }).user_id).toBeUndefined();
  });

  it("引数を書き換えない (凍結したオブジェクトでも通る)", () => {
    const deepFreeze = <T,>(value: T): T => {
      if (value && typeof value === "object") {
        Object.values(value as Record<string, unknown>).forEach(deepFreeze);
        Object.freeze(value);
      }
      return value;
    };
    const entry = deepFreeze({
      ...base,
      user_id: "unknown",
      message: `password=hunter2 ${FAKE.jwt}`,
      error_stack: `Error ${FAKE.openai}`,
      metadata: { password: "x", list: [`y ${FAKE.openai}`], nested: { z: 1 } },
    });
    const snapshot = JSON.stringify(entry);
    const out = sanitizeLogEntry(entry);
    expect(JSON.stringify(entry)).toBe(snapshot);
    expect(out).not.toBe(entry);
    expect(out.metadata).not.toBe(entry.metadata);
  });

  it("app_logs の列以外のキーは落とす (マスクされない余計な値を insert に混ぜない)", () => {
    const out = sanitizeLogEntry({ ...base, password: "hunter2", extra: { a: 1 } } as SanitizableLogEntry);
    expect(Object.keys(out).sort()).toEqual(
      ["error_message", "error_stack", "function_name", "level", "message", "metadata", "request_id", "source", "user_id"].sort(),
    );
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  it("BigInt の metadata でも例外を投げず、message などはそのまま残る", () => {
    const out = sanitizeLogEntry({ ...base, metadata: { total: 12345678901234567890n } });
    expect(out.message).toBe(base.message);
    expect(out.metadata).toEqual({ total: "12345678901234567890" });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("message が文字列でなくても (JS 呼び出しの誤り) 例外を投げず、message は空文字列にする", () => {
    expect(sanitizeLogEntry({ ...base, message: undefined as unknown as string }).message).toBe("");
    expect(sanitizeLogEntry({ ...base, message: 42 as unknown as string }).message).toBe("42");
  });

  it("途中で例外が起きても投げず、生の文面を含まない最小の行を返す (fail closed)", () => {
    const secret = FAKE.openai;
    const entry = {
      ...base,
      error_stack: `Error: ${secret}`,
      metadata: { password: "hunter2", text: secret },
      get message(): string {
        throw new Error("getter failed");
      },
    } as SanitizableLogEntry;
    const out = sanitizeLogEntry(entry);
    expect(out).toEqual({
      level: "error",
      source: "api-route",
      function_name: "api/test",
      user_id: VALID_UUID,
      message: LOG_SANITIZER_FAILED_MESSAGE,
      request_id: "req_1_abc",
    });
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  it("最小の行を作る処理まで失敗しても、固定の行を返して投げない", () => {
    const hostile = new Proxy({}, {
      get() {
        throw new Error("every access fails");
      },
    }) as unknown as SanitizableLogEntry;
    expect(sanitizeLogEntry(hostile)).toEqual({ level: "error", source: "unknown", message: LOG_SANITIZER_FAILED_MESSAGE });
    expect(() => sanitizeLogEntry(null as unknown as SanitizableLogEntry)).not.toThrow();
    expect(() => sanitizeLogEntry(undefined as unknown as SanitizableLogEntry)).not.toThrow();
  });

  it("もう一度通しても同じ結果になる", () => {
    const entry: SanitizableLogEntry = {
      ...base,
      message: `login password=hunter2 ${"x".repeat(5000)}`,
      error_message: `Bearer ${FAKE.bearer}`,
      error_stack: `Error: ${FAKE.jwt}\n${"    at foo (file:///a.ts:1:1)\n".repeat(1000)}`,
      metadata: { error: `x ${FAKE.openai}`, big: "y".repeat(20_000) },
    };
    const once = sanitizeLogEntry(entry);
    expect(sanitizeLogEntry(once)).toEqual(once);
  });
});

describe("配線の契約: ロガーはサニタイザを通してから app_logs へ insert する", () => {
  const read = (relativePath: string) => readFileSync(path.join(process.cwd(), relativePath), "utf8");

  // コメントは無視して、コード部分だけを見る
  const code = (relativePath: string) =>
    read(relativePath)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("Edge Functions の _shared/db-logger.ts: ./log-sanitizer.ts を import し、.insert(sanitizeLogEntry(...)) だけを使う", () => {
    const source = code("supabase/functions/_shared/db-logger.ts");
    expect(source).toMatch(/import\s*\{[^}]*\bsanitizeLogEntry\b[^}]*\}\s*from\s*["']\.\/log-sanitizer\.ts["']/);
    expect(source).toContain(".insert(sanitizeLogEntry(");
    expect(source).not.toMatch(/\.insert\(\s*entry\s*\)/);
    // insert はすべてサニタイザ経由
    expect((source.match(/\.insert\(/g) ?? []).length).toBe((source.match(/\.insert\(sanitizeLogEntry\(/g) ?? []).length);
  });

  it("Next.js の src/lib/db-logger.ts: 共用のサニタイザを import し、.insert(sanitizeLogEntry(...)) だけを使う", () => {
    const source = code("src/lib/db-logger.ts");
    expect(source).toMatch(
      /import\s*\{[^}]*\bsanitizeLogEntry\b[^}]*\}\s*from\s*["']\.\.\/\.\.\/supabase\/functions\/_shared\/log-sanitizer["']/,
    );
    expect(source).toContain(".insert(sanitizeLogEntry(");
    expect(source).not.toMatch(/\.insert\(\s*(entry|sanitizedEntry)\s*\)/);
    expect((source.match(/\.insert\(/g) ?? []).length).toBe((source.match(/\.insert\(sanitizeLogEntry\(/g) ?? []).length);
    // 従来の import 元が壊れないよう、既存の export を再エクスポートしている
    for (const name of ["maskSecrets", "truncateMetadata", "sanitizeMetadata", "sanitizeLogText", "sanitizeLogEntry"]) {
      expect(source, name).toMatch(new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`));
    }
  });

  it("クライアントログを受ける src/app/api/log/route.ts: insert する行を sanitizeLogEntry に通す", () => {
    const source = code("src/app/api/log/route.ts");
    expect(source).toMatch(/\.insert\(\s*sanitizeLogEntry\(/);
    expect((source.match(/\.insert\(/g) ?? []).length).toBe((source.match(/\.insert\(\s*sanitizeLogEntry\(/g) ?? []).length);
  });

  it("サニタイザ自体は import を持たず、Deno / Node 固有の API を使わない (Edge と Next.js の両方で読むため)", () => {
    const source = code("supabase/functions/_shared/log-sanitizer.ts");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bfrom\s+["']/);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\bDeno\./);
    expect(source).not.toMatch(/\bprocess\./);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bBuffer\b/);
  });

  it("withUser(... ?? \"unknown\") のような、uuid でない代替値は Edge Functions に残っていない", () => {
    const root = path.join(process.cwd(), "supabase/functions");
    // (deno.json の nodeModulesDir: "auto" で作られうる node_modules は対象外)
    const files = (readdirSync(root, { recursive: true }) as string[]).filter(
      (file) => file.endsWith(".ts") && !file.split(path.sep).includes("node_modules"),
    );
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((file) => /withUser\(\s*[^)]*\?\?\s*["'`]/.test(readFileSync(path.join(root, file), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("generate-menu-v5: userId が無いときはユーザーなしのロガーで記録する", () => {
    // (userId ? logger.withUser(userId) : logger).error(...) の形。変数名が変わっても通る
    const menu = code("supabase/functions/generate-menu-v5/index.ts");
    const menuMatches = menu.match(/\(userId \? (\w+)\.withUser\(userId\) : \1\)\.error\(/g) ?? [];
    expect(menuMatches).toHaveLength(2);
  });
});
