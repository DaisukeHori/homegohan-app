/**
 * #1917 監査・履歴に「変更前の値」を書く箇所の棚卸しの見張り
 *
 * 欠陥の型 (#1917): 鍵も条件も無く先に読んだ値を、監査・履歴の「変更前の値」として書く。
 * 2 人の運営がほぼ同時に同じ行を変えると、あとの変更の記録の「変更前の値」が、実際の直前の値 (先の変更の後の値) と食い違う。
 * 直し方は 2 通り: DB の関数が対象の行をロックして読んだ値を返す (locked_rpc) か、読んだ値を条件にして更新し 0 行なら書かない (cas)。
 *
 * (a) src の .ts / .tsx (src/types/database.types.ts・__tests__ を除く) で、監査・履歴を書く呼び出し
 *     (record...Audit(...) と .insert(...) / .upsert(...)) の引数の中の、変更前の値に見える名前のキー (PRIOR_KEY_PATTERN) を
 *     構文木で集め、下の表 (INVENTORY) と両向きに突き合わせる。
 *     表に無いキーが増えたら赤 (値をどこから取るかを決めて、表に 1 行足す)。表にあって見つからないキーも赤 (表を直す)。
 * (b) locked_rpc / cas の行は、同時の変更の振る舞いを確かめるテスト (guardedBy) があり、そのテストがキーの名前を見ていること。
 * (c) open (直していない) の行は理由がある。open は #1917 の時点で範囲の外にしたものだけ (増やすときは理由と追う先を書く)。
 *
 * 限界 (このテストは見張りであって、証明ではない):
 *  - オブジェクトのリテラルに書いたキーだけを見る。変数に入れたオブジェクト (例: details: updates) の中は見えない。
 *  - キーの名前でだけ拾う。変更前の値を別の名前で書くと見えない (名前は PRIOR_KEY_PATTERN に合わせること)。
 *  - 値の取り方 (ロック・条件つきの更新) が正しいかは見ない。それは guardedBy のテストの受け持ち。
 *  - SQL の関数の中で書く監査 (membership_audit など) は見ない。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCANNED_DIR = 'src';
const EXCLUDED_FILES = new Set(['src/types/database.types.ts']);

/** 監査・履歴を書く呼び出しの名前 (関数名、または `.from(...).insert(...)` のようなメソッド名) */
const WRITER_CALLEE_PATTERN = /^(record[A-Za-z]*Audit|insert|upsert)$/;

/**
 * 変更前の値に見えるキーの名前: before / from / previous / prev / old そのもの、その接頭辞 (old_x・previous_x・from_x・before_x)、
 * 接尾辞 (x_before・x_from)、キャメルの接頭辞 (previousX・oldX)
 */
const PRIOR_KEY_PATTERN = /^(before|from|previous|prev|old)$|^(previous|prev|old|from|before)_|_(before|from)$|^(previous|prev|old|before)[A-Z]/;

type PriorValueSource =
  /** DB の関数が対象の行をロックして読んだ値 (戻り値) か、ロックの下で確かめた値。guardedBy は同時の変更を確かめるテスト */
  | { kind: 'locked_rpc'; how: string; guardedBy: string }
  /** 読んだ値を条件にした更新 (0 行なら書かない・記録しない)。guardedBy は 0 行の振る舞いを確かめるテスト */
  | { kind: 'cas'; how: string; guardedBy: string }
  /** 名前は似ているが、変更前の値ではない (期間の始まり・一覧の条件など) */
  | { kind: 'not_prior'; why: string }
  /** 直していない (#1917 の範囲の外)。理由 */
  | { kind: 'open'; why: string };

const PRICE_CHANGE_OPEN: PriorValueSource = {
  kind: 'open',
  why:
    '#1917 の範囲の外 (別 Issue)。subscription_plans をロックも条件も無く読み、その値を plan_price_history と監査の old_* に書き、' +
    '価格の UPDATE は .eq(id) だけ。読んでから書くまでの間に Stripe の Price の作成・無効化を呼ぶので、DB の鍵をまたげない ' +
    '(条件つきの UPDATE と 409、または Stripe を呼ぶ前に予約の行を取る形が要る)',
};
const TRANSFER_OPEN: PriorValueSource = {
  kind: 'open',
  why:
    '#1917 の範囲の外 (別 Issue)。from_user_id は RPC の前にロックの外で読んだ旧オーナー / 旧代表者。RPC は更新した後の行を返すので、' +
    'ロックの下で読んだ旧オーナーを返すように RPC と migration を変える必要がある (RPC の中の membership_audit の old_* はロックの下で読んでいる)',
};
const MFA_RESET_OPEN: PriorValueSource = {
  kind: 'open',
  why:
    '#1917 の範囲の外 (別 Issue)。消す前の数を Auth の管理 API (listFactors) と backup codes の件数で数え、監査を削除より先に書く ' +
    '(fail-closed の設計 cross/12-operator-mfa.md §14.7)。Auth の API の呼び出しは DB の鍵をまたげない',
};

/**
 * 監査・履歴の呼び出しの中の、変更前の値に見えるキーと、その値の出どころ。キーは「ROOT からのパス 呼び出しの名前 キー」。
 * 新しく書いたら 1 行足す。
 */
const INVENTORY: Record<string, PriorValueSource> = {
  'src/app/api/admin/users/[id]/role/route.ts recordAdminAudit previous_roles': {
    kind: 'locked_rpc',
    how: 'admin_set_user_roles が対象の行を FOR NO KEY UPDATE でロックして読んだ、変える前の roles (戻り値の previous_roles)',
    guardedBy: 'tests/admin-user-role-previous-roles-route.test.ts',
  },
  'src/app/api/super-admin/email-outbox/[id]/requeue/route.ts recordAdminAudit previous_status': {
    kind: 'locked_rpc',
    how: "requeue_email_outbox が FOR UPDATE でロックした行が dead のときだけ 'requeued' を返すので、'dead' 固定",
    guardedBy: 'tests/super-admin-email-outbox-requeue-route.test.ts',
  },
  'src/app/api/super-admin/llm/quotas/route.ts recordAdminAudit before': {
    kind: 'cas',
    how: '読んだ daily_limit を条件にした UPDATE (行が無ければ ignoreDuplicates の upsert)。0 行なら 409 か、同じ値なら記録しない (#1967)',
    guardedBy: 'tests/super-admin-llm-quotas-route.test.ts',
  },
  'src/app/api/admin/inquiries/[id]/route.ts recordAdminAudit status_from': {
    kind: 'cas',
    how: '読んだ status と updated_at を条件にした UPDATE。0 行なら 409 (#1967)',
    guardedBy: 'tests/admin-inquiries-route.test.ts',
  },
  'src/app/api/admin/sales/leads/[id]/route.ts insert from_stage': {
    kind: 'cas',
    how: '読んだ stage を条件にした UPDATE。0 行なら 409 で、活動履歴を書かない (#1967)',
    guardedBy: 'tests/admin-sales-lead-patch-route.test.ts',
  },
  'src/app/api/admin/organizations/[id]/route.ts recordAdminAudit from': {
    kind: 'cas',
    how: '読んだ plan を条件にした UPDATE。0 行なら読み直して 409 か、同じプランなら記録しない',
    guardedBy: 'tests/admin-organization-plan-change-route.test.ts',
  },
  'src/app/api/admin/data-requests/[id]/route.ts recordAdminAudit status_from': {
    kind: 'cas',
    how: 'updateDsrByOperator が読んだ updated_at (If-Unmodified-Since) を条件にした UPDATE。0 行なら 409 CONFLICT_STALE_DATA',
    guardedBy: 'tests/admin-data-requests-route.test.ts',
  },
  'src/app/api/admin/moderation/[type]/[id]/restore/route.ts recordAdminAudit hidden_at_before': {
    kind: 'cas',
    how: '読んだ hidden_at を条件にした UPDATE (hidden_* の 3 列は隠す操作の 1 文で一緒に書く)。0 行なら raced',
    guardedBy: 'tests/moderation-restore-route-contracts.test.ts',
  },
  'src/app/api/admin/moderation/[type]/[id]/restore/route.ts recordAdminAudit hidden_by_before': {
    kind: 'cas',
    how: 'hidden_at_before と同じ (読んだ hidden_at を条件にした UPDATE)',
    guardedBy: 'tests/moderation-restore-route-contracts.test.ts',
  },
  'src/app/api/admin/moderation/[type]/[id]/restore/route.ts recordAdminAudit hidden_reason_before': {
    kind: 'cas',
    how: 'hidden_at_before と同じ (読んだ hidden_at を条件にした UPDATE)',
    guardedBy: 'tests/moderation-restore-route-contracts.test.ts',
  },

  'src/app/api/admin/finance/exports/route.ts recordAdminAudit from': { kind: 'not_prior', why: '書き出す期間の始まり (本文の from)' },
  'src/app/api/admin/users/route.ts recordAdminAudit last_login_before': { kind: 'not_prior', why: '一覧の絞り込みの条件' },
  'src/app/api/admin/users/route.ts recordAdminAudit registered_from': { kind: 'not_prior', why: '一覧の絞り込みの条件' },
  'src/app/api/super-admin/logs/route.ts recordAdminAudit from': { kind: 'not_prior', why: 'アプリログの検索の期間の始まり (一覧の絞り込みの条件)' },
  'src/app/api/super-admin/coupons/route.ts insert valid_from': { kind: 'not_prior', why: 'クーポンの有効期間の始まり' },
  'src/app/api/super-admin/coupons/route.ts recordAdminAudit valid_from': { kind: 'not_prior', why: 'クーポンの有効期間の始まり' },

  'src/app/api/super-admin/plans/[id]/price-change/route.ts insert old_monthly_price_jpy': PRICE_CHANGE_OPEN,
  'src/app/api/super-admin/plans/[id]/price-change/route.ts insert old_yearly_price_jpy': PRICE_CHANGE_OPEN,
  'src/app/api/super-admin/plans/[id]/price-change/route.ts insert old_stripe_price_id': PRICE_CHANGE_OPEN,
  'src/app/api/super-admin/plans/[id]/price-change/route.ts recordAdminAudit old_monthly_price_jpy': PRICE_CHANGE_OPEN,
  'src/app/api/super-admin/plans/[id]/price-change/route.ts recordAdminAudit old_yearly_price_jpy': PRICE_CHANGE_OPEN,
  'src/app/api/super-admin/plans/[id]/price-change/route.ts recordAdminAudit old_stripe_price_id': PRICE_CHANGE_OPEN,
  'src/app/api/super-admin/plans/[id]/price-change/route.ts recordAdminAudit old_stripe_yearly_price_id': PRICE_CHANGE_OPEN,
  'src/app/api/super-admin/plans/[id]/price-change/route.ts recordAdminAudit old_stripe_price_deactivated': PRICE_CHANGE_OPEN,
  'src/app/api/super-admin/plans/[id]/price-change/route.ts recordAdminAudit old_stripe_price_deactivation_skipped_reason': PRICE_CHANGE_OPEN,
  'src/app/api/super-admin/plans/[id]/price-change/route.ts recordAdminAudit old_stripe_yearly_price_deactivated': PRICE_CHANGE_OPEN,
  'src/app/api/super-admin/plans/[id]/price-change/route.ts recordAdminAudit old_stripe_yearly_price_deactivation_skipped_reason':
    PRICE_CHANGE_OPEN,
  'src/app/api/operator/membership/org/[id]/transfer/route.ts recordAdminAudit from_user_id': TRANSFER_OPEN,
  'src/app/api/operator/membership/family/[id]/transfer/route.ts recordAdminAudit from_user_id': TRANSFER_OPEN,
  'src/app/api/super-admin/admins/[id]/mfa/reset/route.ts recordMfaAudit factors_before': MFA_RESET_OPEN,
  'src/app/api/super-admin/admins/[id]/mfa/reset/route.ts recordMfaAudit backup_codes_before': MFA_RESET_OPEN,
};

/** #1917 の時点で範囲の外にした open のファイル (open を増やすときは、ここにも足して理由を書く) */
const OPEN_FILES_AT_1917 = new Set([
  'src/app/api/super-admin/plans/[id]/price-change/route.ts',
  'src/app/api/operator/membership/org/[id]/transfer/route.ts',
  'src/app/api/operator/membership/family/[id]/transfer/route.ts',
  'src/app/api/super-admin/admins/[id]/mfa/reset/route.ts',
]);

// ─────────────────────────────────────────────────────────────────────────────
// 構文木の走査
// ─────────────────────────────────────────────────────────────────────────────

function listFiles(dir: string, pattern: RegExp): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') out.push(...listFiles(full, pattern));
    } else if (pattern.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 呼び出しの名前 (`f(...)` の f、`a.b.f(...)` の f)。それ以外の形は null */
function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function propertyKey(node: ts.Node): string | null {
  if (!ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) return null;
  const name = node.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/** 監査・履歴を書く呼び出しの引数の中の、変更前の値に見えるキー (「呼び出しの名前 キー」の集合) */
function priorValueKeys(fileName: string, source: string): Set<string> {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name !== null && WRITER_CALLEE_PATTERN.test(name)) {
        const collect = (inner: ts.Node) => {
          const key = propertyKey(inner);
          if (key !== null && PRIOR_KEY_PATTERN.test(key)) found.add(`${name} ${key}`);
          ts.forEachChild(inner, collect);
        };
        for (const arg of node.arguments) collect(arg);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** 構文木を作る前の絞り込み (WRITER_CALLEE_PATTERN に合う名前は、どれもこの文字列を含む。拾い漏れを作らない) */
const WRITER_NAME_SUBSTRING = /Audit|insert|upsert/;

function scanSrc(): Record<string, true> {
  const actual: Record<string, true> = {};
  for (const file of listFiles(path.join(ROOT, SCANNED_DIR), /\.tsx?$/)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (EXCLUDED_FILES.has(rel)) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (!WRITER_NAME_SUBSTRING.test(source)) continue;
    for (const key of priorValueKeys(rel, source)) actual[`${rel} ${key}`] = true;
  }
  return actual;
}

// ─────────────────────────────────────────────────────────────────────────────
// 検出器そのもののテスト (空振りしないこと・拾いすぎないこと)
// ─────────────────────────────────────────────────────────────────────────────

describe('検出器', () => {
  it('監査・履歴の呼び出しの引数の中の、変更前の値に見えるキーを拾う (入れ子・条件式・省略記法・文字列のキーも)', () => {
    const source = `
      await recordAdminAudit({ supabase, details: { previous_roles: r, new_roles: n, plan_key: k } });
      await recordMfaAudit({ details: { factors_before: f.length } });
      await admin.from('plan_price_history').insert({ old_monthly_price_jpy: p, new_monthly_price_jpy: q });
      await admin.from('x').upsert([{ 'status_from': a }]);
      await recordAdminAudit({ details: { before: b ? { daily_limit: b.daily_limit } : null, from_user_id } });
      await repo.recordAudit({ details: { previousStatus: s } });
    `;
    expect([...priorValueKeys('x.ts', source)].sort()).toEqual(
      [
        'insert old_monthly_price_jpy',
        'recordAdminAudit before',
        'recordAdminAudit from_user_id',
        'recordAdminAudit previous_roles',
        'recordAudit previousStatus',
        'recordMfaAudit factors_before',
        'upsert status_from',
      ].sort(),
    );
  });

  it('監査・履歴の呼び出しの外のキーと、似ていない名前のキーは拾わない', () => {
    const source = `
      const before = { previous_roles: r };
      await admin.from('x').update({ old_value: v }).eq('id', id);
      await recordAdminAudit({ details: { to: t, roles_new: n, beforehand: b, older: o, fromage: f } });
      // await recordAdminAudit({ details: { previous_roles: r } }) はコメントなので数えない
    `;
    expect([...priorValueKeys('x.ts', source)]).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (a) 棚卸しの表と src の突き合わせ
// ─────────────────────────────────────────────────────────────────────────────

describe('(a) 監査・履歴の「変更前の値」の出どころの表 (#1917)', () => {
  const actual = scanSrc();

  it('走査が空振りしていない (#1917 で直した previous_roles が見つかる)', () => {
    expect(actual['src/app/api/admin/users/[id]/role/route.ts recordAdminAudit previous_roles']).toBe(true);
  });

  it('src の変更前の値に見えるキーの一覧が表 (INVENTORY) と一致する (表に無いキーを足したら、出どころを決めて表に書く)', () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(INVENTORY).sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) (c) 表の各行
// ─────────────────────────────────────────────────────────────────────────────

type GuardedSource = Extract<PriorValueSource, { kind: 'locked_rpc' | 'cas' }>;

function isGuarded(source: PriorValueSource): source is GuardedSource {
  return source.kind === 'locked_rpc' || source.kind === 'cas';
}

describe('(b) locked_rpc / cas の行は、同時の変更を確かめるテストがキーの名前を見ている', () => {
  const guarded = Object.entries(INVENTORY).flatMap(([entry, source]) =>
    isGuarded(source) ? [{ entry, key: entry.slice(entry.lastIndexOf(' ') + 1), source }] : [],
  );

  it('対象の行がある (空振りしていない)', () => {
    expect(guarded.length).toBeGreaterThan(0);
  });

  it.each(guarded)('$entry', ({ key, source }) => {
    const testFile = path.join(ROOT, source.guardedBy);
    expect(fs.existsSync(testFile), source.guardedBy).toBe(true);
    expect(fs.readFileSync(testFile, 'utf8')).toMatch(new RegExp(`\\b${key}\\b`));
    expect(source.how.trim().length).toBeGreaterThan(0);
  });
});

describe('(c) open (直していない) の行', () => {
  it('理由があり、#1917 の時点で範囲の外にしたファイルだけ', () => {
    const open = Object.entries(INVENTORY).filter(([, source]) => source.kind === 'open');
    expect(open.length).toBeGreaterThan(0);
    for (const [entry, source] of open) {
      if (source.kind !== 'open') continue;
      expect(source.why.trim().length, entry).toBeGreaterThan(0);
      expect(OPEN_FILES_AT_1917.has(entry.slice(0, entry.indexOf(' '))), entry).toBe(true);
    }
  });

  it('not_prior の行は理由がある', () => {
    for (const [entry, source] of Object.entries(INVENTORY)) {
      if (source.kind === 'not_prior') expect(source.why.trim().length, entry).toBeGreaterThan(0);
    }
  });
});
