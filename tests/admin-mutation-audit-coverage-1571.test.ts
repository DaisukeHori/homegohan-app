/**
 * #1571 運営の変更系の API が監査ログ (recordAdminAudit) を残すことの見張り
 *
 * 判断の基準: 運営の操作で状態を変えるもの (POST / PUT / PATCH / DELETE) は、すべて admin_audit_logs に記録する。
 * #1571 で、記録の無かった変更系 (営業リードの活動の追加・システム設定・埋め込みの再生成・チケットのメッセージの追加・
 * 運営の家族 / 組織の強制解散と譲渡) に記録を足した。4 つのディレクトリの外の運営ロール専用の変更系
 * (お知らせの作成・比較ランキングの集計の手動実行) にも記録を足し、走査に入れた (#1571 の残り)。
 *
 * (a) src/app/api/{admin,super-admin,support,operator} の全 route の変更系の handler を構文木で数え、
 *     下の表 (EXPECTED) と突き合わせる。表に無い handler が増えたら赤 (記録するか、記録しない理由を表に書くかを決める)。
 *     「audited」の handler は、handler の本体 (同じファイルの関数を呼んでいればその中も) で recordAdminAudit を呼んでいること。
 * (b) src の recordAdminAudit の呼び出しは、すべて request を渡していること
 *     (渡さないと ip_address / user_agent が null になる。#1571 の本番の実測で、ip_address の多くが NULL だった)。
 *
 * 限界 (このテストは見張りであって、証明ではない):
 *  - recordAdminAudit が「呼ばれうる」ことだけを見る。成功したすべての経路で呼ばれるか、呼ぶ順番 (状態を変えた後か) は見ない
 *    (それは各 route の振る舞いのテスト。#1571 の分は tests/admin-mutation-audit-1571.test.ts)。
 *  - 同じファイルの中の関数の呼び出しだけを追う。別のファイルの関数 (例: src/lib の共通処理) の中で記録している handler は
 *    「audited」と判定できないので、そうするときは表に理由を書いて「delegated」にする。
 *  - handler が `export async function POST` / `export const POST =` / `export { x as POST }` のどれかで書かれていることを前提にする。
 *  - (b) は呼び出しの引数がオブジェクトのリテラルのときだけ見る (変数に入れたオブジェクトを渡すと見えない。そう書かないこと)。
 *  - 4 つのディレクトリの外の route は、変更系の handler が運営ロールの確認 (requireRole / requireSuperAdmin。同じファイルの関数の中も)
 *    に届くものだけを表に載せる (POST /api/announcements・POST /api/comparison/trigger・/api/auth/mfa/*)。
 *    requireRole を別のファイルの関数の中で呼ぶ handler は見えない。requireRole は運営ロール以外 (org_admin など) にも使えるので、
 *    届いたものが運営の操作でなければ、表に理由を書いて外す。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCANNED_DIRS = ['src/app/api/admin', 'src/app/api/super-admin', 'src/app/api/support', 'src/app/api/operator'];
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AUDIT_FUNCTION = 'recordAdminAudit';
/** 4 つのディレクトリの外で、これに届く変更系の handler を運営ロール専用とみなして表に載せる */
const OPERATOR_GATE_FUNCTIONS = ['requireRole', 'requireSuperAdmin'];

type Expectation = 'audited' | { exempt: string };

/** 運営の二段階認証の自己サービス。記録は別のファイルの recordMfaAudit (src/lib/auth/mfa/audit.ts) の中の recordAdminAudit */
const MFA_SELF_SERVICE_DELEGATED: Expectation = {
  exempt:
    'admin.mfa.* を recordMfaAudit (src/lib/auth/mfa/audit.ts) の中の recordAdminAudit で書く (docs/design/operator/07-audit-monitoring.md §4.1 の 4 種の記録のルール)。' +
    '別のファイルの関数なので、この走査では audited と判定できない',
};

/** 501 (準備中) を返すだけで、DB に触れない */
const NOT_SUPPORTED_STUB: Expectation = { exempt: '501 (準備中・未対応) を返すだけで、何も保存しない (#1126)' };

/**
 * 変更系の handler と、監査ログの扱い。キーは「ROOT からのパス メソッド」。
 * 新しい変更系を足したら、ここに 1 行足す (記録しないなら理由を書く)。
 */
const EXPECTED: Record<string, Expectation> = {
  'src/app/api/admin/catalog/import/route.ts POST': 'audited',
  'src/app/api/admin/data-requests/[id]/route.ts PATCH': 'audited',
  'src/app/api/admin/finance/exports/route.ts POST': 'audited',
  'src/app/api/admin/finance/refunds/route.ts POST': 'audited',
  'src/app/api/admin/inquiries/[id]/route.ts PATCH': 'audited',
  'src/app/api/admin/inquiries/[id]/route.ts PUT': 'audited',
  'src/app/api/admin/moderation/[type]/[id]/route.ts POST': 'audited',
  'src/app/api/admin/moderation/[type]/[id]/route.ts PUT': 'audited',
  'src/app/api/admin/moderation/[type]/[id]/restore/route.ts POST': 'audited',
  'src/app/api/admin/organizations/[id]/route.ts PATCH': 'audited',
  'src/app/api/admin/organizations/route.ts POST': 'audited',
  'src/app/api/admin/sales/leads/[id]/activities/route.ts POST': 'audited',
  'src/app/api/admin/sales/leads/[id]/route.ts PATCH': 'audited',
  'src/app/api/admin/sales/leads/route.ts POST': 'audited',
  'src/app/api/admin/support/tickets/[id]/assign/route.ts POST': 'audited',
  'src/app/api/admin/support/tickets/[id]/messages/route.ts POST': 'audited',
  'src/app/api/admin/support/tickets/[id]/route.ts PATCH': 'audited',
  'src/app/api/admin/support/tickets/route.ts POST': 'audited',
  'src/app/api/admin/users/[id]/freeze/route.ts DELETE': 'audited',
  'src/app/api/admin/users/[id]/freeze/route.ts POST': 'audited',
  'src/app/api/admin/users/[id]/role/route.ts PATCH': 'audited',
  'src/app/api/admin/users/[id]/role/route.ts PUT': 'audited',
  'src/app/api/admin/users/[id]/route.ts PATCH': 'audited',
  // ここから 4 つのディレクトリの外 (運営ロールの確認に届く変更系だけ)
  'src/app/api/announcements/route.ts POST': 'audited',
  'src/app/api/auth/mfa/backup-codes/route.ts POST': MFA_SELF_SERVICE_DELEGATED,
  'src/app/api/auth/mfa/enroll/route.ts POST': {
    exempt: '登録を始めるだけ (まだ使えない factor を作る)。登録の完了 = verify の成功で admin.mfa.enroll を書く (docs/design/cross/12-operator-mfa.md §17)',
  },
  'src/app/api/auth/mfa/factors/[id]/route.ts DELETE': MFA_SELF_SERVICE_DELEGATED,
  'src/app/api/auth/mfa/recover/route.ts POST': MFA_SELF_SERVICE_DELEGATED,
  'src/app/api/auth/mfa/verify/route.ts POST': MFA_SELF_SERVICE_DELEGATED,
  'src/app/api/comparison/trigger/route.ts POST': 'audited',
  // ここから 4 つのディレクトリの中
  'src/app/api/operator/membership/family/[id]/dissolve/route.ts POST': 'audited',
  'src/app/api/operator/membership/family/[id]/transfer/route.ts POST': 'audited',
  'src/app/api/operator/membership/org/[id]/dissolve/route.ts POST': 'audited',
  'src/app/api/operator/membership/org/[id]/transfer/route.ts POST': 'audited',
  'src/app/api/super-admin/admins/[id]/mfa/reset/route.ts POST': { exempt: '監査 super_admin.mfa.reset は recordMfaAudit (src/lib/auth/mfa/audit.ts) の中の recordAdminAudit で、削除より先に fail-closed で書く (docs/design/cross/12-operator-mfa.md §14.7・§17.1)。別のファイルの関数なので、この走査では audited と判定できない' },
  'src/app/api/super-admin/backups/dr-tests/route.ts POST': 'audited',
  'src/app/api/super-admin/coupons/[id]/apply/route.ts POST': 'audited',
  'src/app/api/super-admin/coupons/[id]/route.ts DELETE': 'audited',
  'src/app/api/super-admin/coupons/[id]/route.ts PATCH': 'audited',
  'src/app/api/super-admin/coupons/route.ts POST': 'audited',
  'src/app/api/super-admin/email-outbox/[id]/requeue/route.ts POST': 'audited',
  'src/app/api/super-admin/embeddings/regenerate/route.ts POST': 'audited',
  'src/app/api/super-admin/experiments/[id]/route.ts DELETE': 'audited',
  'src/app/api/super-admin/experiments/[id]/route.ts PATCH': 'audited',
  'src/app/api/super-admin/experiments/route.ts POST': 'audited',
  'src/app/api/super-admin/exports/[id]/route.ts DELETE': NOT_SUPPORTED_STUB,
  'src/app/api/super-admin/exports/[id]/route.ts PATCH': NOT_SUPPORTED_STUB,
  'src/app/api/super-admin/exports/[id]/route.ts POST': NOT_SUPPORTED_STUB,
  'src/app/api/super-admin/exports/[id]/route.ts PUT': NOT_SUPPORTED_STUB,
  'src/app/api/super-admin/exports/route.ts DELETE': NOT_SUPPORTED_STUB,
  'src/app/api/super-admin/exports/route.ts PATCH': NOT_SUPPORTED_STUB,
  'src/app/api/super-admin/exports/route.ts POST': NOT_SUPPORTED_STUB,
  'src/app/api/super-admin/exports/route.ts PUT': NOT_SUPPORTED_STUB,
  'src/app/api/super-admin/feature-packages/[id]/route.ts DELETE': 'audited',
  'src/app/api/super-admin/feature-packages/[id]/route.ts PATCH': 'audited',
  'src/app/api/super-admin/feature-packages/route.ts POST': 'audited',
  'src/app/api/super-admin/flags/[key]/route.ts DELETE': 'audited',
  'src/app/api/super-admin/flags/[key]/route.ts PATCH': 'audited',
  'src/app/api/super-admin/flags/route.ts POST': 'audited',
  'src/app/api/super-admin/llm/quotas/route.ts PATCH': 'audited',
  'src/app/api/super-admin/plans/[id]/price-change/route.ts POST': 'audited',
  'src/app/api/super-admin/plans/[id]/route.ts DELETE': 'audited',
  'src/app/api/super-admin/plans/[id]/route.ts PATCH': 'audited',
  'src/app/api/super-admin/plans/route.ts POST': 'audited',
  'src/app/api/super-admin/settings/route.ts PUT': 'audited',
  'src/app/api/super-admin/users/[id]/manual-plan/route.ts DELETE': 'audited',
  'src/app/api/super-admin/users/[id]/manual-plan/route.ts POST': 'audited',
  'src/app/api/support/users/[id]/notes/route.ts POST': 'audited',
};

// ─────────────────────────────────────────────────────────────────────────────
// 構文木の走査
// ─────────────────────────────────────────────────────────────────────────────

function listFiles(dir: string, pattern: RegExp): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, pattern));
    else if (pattern.test(entry.name)) out.push(full);
  }
  return out;
}

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** ファイルの一番外側にある関数 (function 宣言と、const に入れた関数式・アロー関数) を名前で引けるようにする */
function topLevelFunctions(sf: ts.SourceFile): Map<string, ts.Node> {
  const functions = new Map<string, ts.Node>();
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      functions.set(statement.name.text, statement.body);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          functions.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }
  return functions;
}

/** export された変更系の handler (メソッド名 → 本体)。本体は handler そのもの、または別名の元の関数 */
function mutatingHandlers(sf: ts.SourceFile): Map<string, ts.Node> {
  const functions = topLevelFunctions(sf);
  const handlers = new Map<string, ts.Node>();
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && hasExportModifier(statement)) {
      const name = statement.name.text;
      if (MUTATING_METHODS.has(name) && statement.body) handlers.set(name, statement.body);
    }
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && MUTATING_METHODS.has(declaration.name.text) && declaration.initializer) {
          handlers.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const specifier of statement.exportClause.elements) {
        const exported = specifier.name.text;
        const local = (specifier.propertyName ?? specifier.name).text;
        const body = functions.get(local);
        if (MUTATING_METHODS.has(exported) && body) handlers.set(exported, body);
      }
    }
  }
  return handlers;
}

/** node の中で targets のどれかを呼ぶか (同じファイルの関数を呼んでいれば、その中もたどる) */
function reachesCall(
  node: ts.Node,
  functions: Map<string, ts.Node>,
  targets: readonly string[],
  visited = new Set<string>(),
): boolean {
  let found = false;
  const visit = (current: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
      const callee = current.expression.text;
      if (targets.includes(callee)) {
        found = true;
        return;
      }
      const local = functions.get(callee);
      if (local && !visited.has(callee)) {
        visited.add(callee);
        if (reachesCall(local, functions, targets, visited)) {
          found = true;
          return;
        }
      }
    }
    // handler の中で関数を値として渡す書き方 (`withAuth(handle)`) もたどる
    if (ts.isIdentifier(current) && !ts.isCallExpression(current.parent) && functions.has(current.text) && !visited.has(current.text)) {
      visited.add(current.text);
      if (reachesCall(functions.get(current.text) as ts.Node, functions, targets, visited)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/** 変更系の handler ごとに、recordAdminAudit に届くか */
function scanHandlers(fileName: string, source: string): Map<string, boolean> {
  return new Map([...scanHandlerReach(fileName, source)].map(([method, reach]) => [method, reach.audited]));
}

/** 変更系の handler ごとに、recordAdminAudit に届くか (audited) と、運営ロールの確認に届くか (gated) */
function scanHandlerReach(fileName: string, source: string): Map<string, { audited: boolean; gated: boolean }> {
  const sf = parse(fileName, source);
  const functions = topLevelFunctions(sf);
  const result = new Map<string, { audited: boolean; gated: boolean }>();
  for (const [method, body] of mutatingHandlers(sf)) {
    result.set(method, {
      audited: reachesCall(body, functions, [AUDIT_FUNCTION]),
      gated: reachesCall(body, functions, OPERATOR_GATE_FUNCTIONS),
    });
  }
  return result;
}

/** recordAdminAudit({ ... }) のうち、request を渡していない呼び出しの行番号 (1 始まり) */
function auditCallsWithoutRequest(fileName: string, source: string): number[] {
  const sf = parse(fileName, source);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === AUDIT_FUNCTION) {
      const [arg] = node.arguments;
      const passesRequest =
        arg !== undefined &&
        ts.isObjectLiteralExpression(arg) &&
        arg.properties.some(
          (p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name) && p.name.text === 'request',
        );
      if (!passesRequest) lines.push(sf.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// 検出器そのもののテスト (空振りしないこと)
// ─────────────────────────────────────────────────────────────────────────────

describe('検出器', () => {
  it('handler の書き方 (function・const・別名の export) と、同じファイルの関数の中の記録を見つける', () => {
    const source = `
      import { recordAdminAudit } from '@/lib/admin/audit';
      async function handle(request) { await recordAdminAudit({ supabase, actorId, actionType: 'x', request }); }
      async function noAudit() { return 1; }
      export async function POST(request) { return handle(request); }
      export const PUT = async () => noAudit();
      export { handle as PATCH };
      export async function DELETE() { // recordAdminAudit({ request }) はコメントなので数えない
        return 1;
      }
      export async function GET(request) { await recordAdminAudit({ request }); }
    `;
    expect(Object.fromEntries(scanHandlers('route.ts', source))).toEqual({ POST: true, PUT: false, PATCH: true, DELETE: false });
  });

  it('運営ロールの確認 (requireRole / requireSuperAdmin) に届く handler を見つける (同じファイルの関数の中も)', () => {
    const source = `
      async function gate() { await requireSuperAdmin(); }
      export async function POST() { await requireRole(['admin', 'super_admin']); }
      export async function PUT() { await gate(); }
      export async function PATCH() { await requireUser(); }
      export async function DELETE() { // requireRole(['admin']) はコメントなので数えない
        return 1;
      }
    `;
    const gated = Object.fromEntries([...scanHandlerReach('route.ts', source)].map(([method, reach]) => [method, reach.gated]));
    expect(gated).toEqual({ POST: true, PUT: true, PATCH: false, DELETE: false });
  });

  it('request を渡していない recordAdminAudit の呼び出しを見つける (省略記法と request: req は渡しているとみなす)', () => {
    const source = `
      await recordAdminAudit({ supabase, actorId, actionType: 'a', request });
      await recordAdminAudit({ supabase, actorId, actionType: 'b', request: req });
      await recordAdminAudit({ supabase, actorId, actionType: 'c' });
      await recordAdminAudit(params);
    `;
    expect(auditCallsWithoutRequest('x.ts', source)).toEqual([4, 5]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (a) 変更系の handler の表
// ─────────────────────────────────────────────────────────────────────────────

describe('(a) 運営の変更系の handler は監査ログを残す (#1571)', () => {
  const files = SCANNED_DIRS.flatMap((dir) => listFiles(path.join(ROOT, dir), /^route\.tsx?$/));
  const insideScannedDirs = (file: string) => SCANNED_DIRS.some((dir) => file.startsWith(path.join(ROOT, dir) + path.sep));
  const outsideFiles = listFiles(path.join(ROOT, 'src/app/api'), /^route\.tsx?$/).filter((file) => !insideScannedDirs(file));

  it('走査が空振りしていない (4 つのディレクトリのどれにも route がある)', () => {
    for (const dir of SCANNED_DIRS) {
      expect(files.some((f) => f.startsWith(path.join(ROOT, dir) + path.sep)), dir).toBe(true);
    }
  });

  it('4 つのディレクトリの外の走査が空振りしていない (運営ロールの確認に届く変更系が見つかる)', () => {
    const gatedOutside = outsideFiles.filter((file) =>
      [...scanHandlerReach(file, fs.readFileSync(file, 'utf8')).values()].some((reach) => reach.gated),
    );
    const rel = gatedOutside.map((file) => path.relative(ROOT, file).split(path.sep).join('/'));
    expect(rel).toContain('src/app/api/announcements/route.ts');
    expect(rel).toContain('src/app/api/comparison/trigger/route.ts');
  });

  it('変更系の handler の一覧が表 (EXPECTED) と一致し、「audited」はすべて recordAdminAudit に届く', () => {
    const actual: Record<string, boolean> = {};
    for (const file of files) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      for (const [method, audited] of scanHandlers(file, fs.readFileSync(file, 'utf8'))) {
        actual[`${rel} ${method}`] = audited;
      }
    }
    // 4 つのディレクトリの外は、運営ロールの確認に届く変更系の handler だけ
    for (const file of outsideFiles) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      for (const [method, reach] of scanHandlerReach(file, fs.readFileSync(file, 'utf8'))) {
        if (reach.gated) actual[`${rel} ${method}`] = reach.audited;
      }
    }

    // 表に無い handler (新しく足した変更系) と、表にあるのに無い handler (消した・移した) を両方見つける
    expect(Object.keys(actual).sort()).toEqual(Object.keys(EXPECTED).sort());

    const notAudited = Object.entries(EXPECTED)
      .filter(([key, expectation]) => expectation === 'audited' && actual[key] !== true)
      .map(([key]) => key);
    expect(notAudited).toEqual([]);

    // 理由を書いて外したものが、実は記録している (表が古い) ことも見つける
    const exemptButAudited = Object.entries(EXPECTED)
      .filter(([key, expectation]) => expectation !== 'audited' && actual[key] === true)
      .map(([key]) => key);
    expect(exemptButAudited).toEqual([]);
  });

  it('外したものには理由がある', () => {
    for (const [key, expectation] of Object.entries(EXPECTED)) {
      if (expectation !== 'audited') expect(expectation.exempt.trim().length, key).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) recordAdminAudit は request を渡して呼ぶ
// ─────────────────────────────────────────────────────────────────────────────

describe('(b) recordAdminAudit の呼び出しは request を渡す (ip_address / user_agent を null にしない)', () => {
  it('src のすべての呼び出しが request を渡している', () => {
    const files = listFiles(path.join(ROOT, 'src'), /\.(ts|tsx)$/).filter((f) => !f.includes(`${path.sep}__tests__${path.sep}`));
    const callers = files.filter((f) => fs.readFileSync(f, 'utf8').includes(`${AUDIT_FUNCTION}(`));
    // 走査が空振りしていない (呼び出しのあるファイルが見つかる)
    expect(callers.length).toBeGreaterThan(0);

    const violations = callers.flatMap((file) =>
      auditCallsWithoutRequest(file, fs.readFileSync(file, 'utf8')).map((line) => `${path.relative(ROOT, file)}:${line}`),
    );
    expect(violations).toEqual([]);
  });
});
