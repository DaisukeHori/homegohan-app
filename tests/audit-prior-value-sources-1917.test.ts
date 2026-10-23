/**
 * #1917 監査・履歴に「変更前の値」を書く箇所の棚卸しの見張り
 *
 * 欠陥の型 (#1917): 鍵も条件も無く先に読んだ値を、監査・履歴の「変更前の値」として書く。
 * 2 人の運営がほぼ同時に同じ行を変えると、あとの変更の記録の「変更前の値」が、実際の直前の値 (先の変更の後の値) と食い違う。
 * 直し方は 2 通り: DB の関数が対象の行をロックして読んだ値を返す (locked_rpc) か、読んだ値を条件にして更新し 0 行なら書かない (cas)。
 * DB の鍵をまたげない操作 (Auth の管理 API) の前に fail-closed で書く記録は、値を「操作の前に数えた値」と定義して扱う (counted_before)。
 *
 * (a) src の .ts / .tsx (src/types/database.types.ts・__tests__ のディレクトリ・*.test.ts(x) を除く) で、監査・履歴を書く呼び出し
 *     (record...Audit(...) と .insert(...) / .upsert(...)) の引数の中の、変更前の値に見える名前のキー (PRIOR_KEY_PATTERN) を
 *     構文木で集め、下の表 (INVENTORY) と両向きに突き合わせる。
 *     表に無いキーが増えたら赤 (値をどこから取るかを決めて、表に 1 行足す)。表にあって見つからないキーも赤 (表を直す)。
 * (b) locked_rpc / cas の行は、同時の変更の振る舞いを確かめるテスト (guardedBy) があり、そのテストがキーの名前を見ていること。
 * (b') counted_before の行 (取り消せない操作の前に書く記録の「操作の前に数えた値」) は、手順の順と記録の値を確かめるテスト (guardedBy) があり、
 *     そのテストがキーの名前を見ていること。
 * (c) open (直していない) の行は理由がある。open にしてよいのは OPEN_FILES_AT_1917 のファイルだけ
 *     (ほかのファイルを open にするときは、理由を書いて OPEN_FILES_AT_1917 にも足す)。
 *     #1917 の続きで、価格の変更 (予約の行と DB の関数で直した) と MFA のリセット (記録の定義を「削除の前に数えた値」と明記した) を片付け、
 *     いまは open の行は無い。
 *
 * 限界 (このテストは見張りであって、証明ではない):
 *  - オブジェクトのリテラルに書いたキーだけを見る。変数に入れたオブジェクト (例: details: updates) の中は見えない。
 *  - キーの名前でだけ拾う。変更前の値を別の名前で書くと見えない (名前は PRIOR_KEY_PATTERN に合わせること)。
 *  - 値の取り方 (ロック・条件つきの更新) が正しいかは見ない。それは guardedBy のテストの受け持ち。
 *  - SQL の関数の中で書く監査 (membership_audit など) と、src の外 (supabase/functions・apps/mobile) は見ない
 *    (#1917 の時点で手で見た範囲では同じ型は無い。calculate-segment-stats の previous_value は前の期間の指標で、変更前の値ではない)。
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
  /**
   * 取り消せない操作 (DB の鍵をまたげない Auth の管理 API の削除など) より先に fail-closed で書く記録で、値は「操作の前に数えた値」と
   * 記録の定義 (設計書) に明記してあるもの。how は定義の場所、guardedBy は手順の順と記録の値を確かめるテスト
   */
  | { kind: 'counted_before'; how: string; guardedBy: string }
  /** 名前は似ているが、変更前の値ではない (期間の始まり・一覧の条件など) */
  | { kind: 'not_prior'; why: string }
  /** 直していない (#1917 の範囲の外)。理由 */
  | { kind: 'open'; why: string };

/**
 * 価格の変更の監査の old_* (#1917 の続き)。route は、プランごとの予約 (begin_plan_price_change) で価格の変更を 1 本ずつにし、
 * 履歴と価格を apply_plan_price_change が 1 つのトランザクションで書く (履歴の old_* は DB の関数の中で書くので、ここの走査には出ない)。
 * 監査の old_* は apply の戻り値 previous (プランの行を FOR NO KEY UPDATE でロックして読んだ、この更新の直前の値)
 */
const PRICE_CHANGE_LOCKED: PriorValueSource = {
  kind: 'locked_rpc',
  how:
    'apply_plan_price_change がプランの行を FOR NO KEY UPDATE でロックして読んだ、この更新の直前の値 (戻り値の previous)。' +
    '予約 (begin_plan_price_change) が自分のもののままのときだけ書くので、Stripe を呼ぶのは 1 本だけで、その間に別の価格の変更は入らない',
  guardedBy: 'tests/price-change-reservation-route.test.ts',
};
/** 価格の変更の監査の old_stripe_*_deactivated / *_skipped_reason: 変更前の値ではなく、Edge Function が旧 Price を無効化したかの結果 */
const PRICE_CHANGE_DEACTIVATION_RESULT: PriorValueSource = {
  kind: 'not_prior',
  why: 'Edge Function stripe-price-sync が旧 Price を無効化したか (と、しなかった理由) の結果。変更前の値ではない',
};
/** MFA のリセットの監査の消す前の数 (#1917 の続き) */
const MFA_RESET_COUNTED_BEFORE: PriorValueSource = {
  kind: 'counted_before',
  how:
    'docs/design/cross/12-operator-mfa.md §17 の details の表が「削除の前に数えた値」と定義する (§14.7 の fail-closed: 監査を削除より先に書く)。' +
    'Auth の管理 API (listFactors / deleteFactor) は DB の鍵をまたげない。route は数えた factor そのものを消す (src/app/api/super-admin/admins/[id]/mfa/reset/route.ts の冒頭の注記)',
  guardedBy: 'tests/super-admin-mfa-reset-route.test.ts',
};

/**
 * 監査・履歴の呼び出しの中の、変更前の値に見えるキーと、その値の出どころ。キーは「ROOT からのパス 呼び出しの名前 キー」。
 * 新しく書いたら 1 行足す。
 */
const INVENTORY: Record<string, PriorValueSource> = {
  'src/app/api/operator/membership/org/[id]/transfer/route.ts recordAdminAudit from_user_id': {
    kind: 'locked_rpc',
    how: 'operator_force_owner_transfer が組織の行を FOR NO KEY UPDATE でロックして読んだ旧オーナー (戻り値の old_owner_id。membership_audit の old_owner_id と同じ値)。戻り値が古い形 (migration の前の DB) のときだけ RPC の前の控えで記録してログに残す',
    guardedBy: 'src/__tests__/api/operator/membership/org-transfer.test.ts',
  },
  'src/app/api/operator/membership/family/[id]/transfer/route.ts recordAdminAudit from_user_id': {
    kind: 'locked_rpc',
    how: 'operator_force_representative_transfer が家族の行を FOR NO KEY UPDATE でロックして読んだ旧代表者 (戻り値の old_rep_id。membership_audit の old_rep_id と同じ値)。戻り値が古い形 (migration の前の DB) のときだけ RPC の前の控えで記録してログに残す',
    guardedBy: 'src/__tests__/api/operator/membership/family-transfer.test.ts',
  },
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
  'src/app/api/super-admin/plans/[id]/route.ts recordAdminAudit status_from': {
    kind: 'cas',
    how:
      '読んだ status (廃止で既存の ends_at に頼るときは ends_at が NULL でないことも) を条件にした UPDATE。' +
      '0 行なら読み直し、送った変更がもう入っていれば 200 で書かず記録しない・入っていなければ 409 CONFLICT_STALE_DATA',
    guardedBy: 'tests/super-admin-plan-status-cas-route.test.ts',
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

  'src/app/api/super-admin/plans/[id]/price-change/route.ts recordAdminAudit old_monthly_price_jpy': PRICE_CHANGE_LOCKED,
  'src/app/api/super-admin/plans/[id]/price-change/route.ts recordAdminAudit old_yearly_price_jpy': PRICE_CHANGE_LOCKED,
  'src/app/api/super-admin/plans/[id]/price-change/route.ts recordAdminAudit old_stripe_price_id': PRICE_CHANGE_LOCKED,
  'src/app/api/super-admin/plans/[id]/price-change/route.ts recordAdminAudit old_stripe_yearly_price_id': PRICE_CHANGE_LOCKED,
  'src/app/api/super-admin/plans/[id]/price-change/route.ts recordAdminAudit old_stripe_price_deactivated': PRICE_CHANGE_DEACTIVATION_RESULT,
  'src/app/api/super-admin/plans/[id]/price-change/route.ts recordAdminAudit old_stripe_price_deactivation_skipped_reason':
    PRICE_CHANGE_DEACTIVATION_RESULT,
  'src/app/api/super-admin/plans/[id]/price-change/route.ts recordAdminAudit old_stripe_yearly_price_deactivated':
    PRICE_CHANGE_DEACTIVATION_RESULT,
  'src/app/api/super-admin/plans/[id]/price-change/route.ts recordAdminAudit old_stripe_yearly_price_deactivation_skipped_reason':
    PRICE_CHANGE_DEACTIVATION_RESULT,
  'src/app/api/super-admin/admins/[id]/mfa/reset/route.ts recordMfaAudit factors_before': MFA_RESET_COUNTED_BEFORE,
  'src/app/api/super-admin/admins/[id]/mfa/reset/route.ts recordMfaAudit backup_codes_before': MFA_RESET_COUNTED_BEFORE,
};

/**
 * 範囲の外にした open のファイル (open を増やすときは、ここにも足して理由を書く)。
 * #1917 の時点の 2 本 (価格の変更・MFA のリセット) は #1917 の続きで片付けたので、いまは無い
 */
const OPEN_FILES_AT_1917: ReadonlySet<string> = new Set<string>();

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

type GuardedSource = Extract<PriorValueSource, { kind: 'locked_rpc' | 'cas' | 'counted_before' }>;

function isGuarded(source: PriorValueSource): source is GuardedSource {
  return source.kind === 'locked_rpc' || source.kind === 'cas' || source.kind === 'counted_before';
}

describe('(b) locked_rpc / cas / counted_before の行は、確かめるテストがキーの名前を見ている', () => {
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
  const open = Object.entries(INVENTORY).filter(([, source]) => source.kind === 'open');

  it('#1917 の続きの後、open の行は無い (価格の変更と MFA のリセットを片付けた)', () => {
    expect(open.map(([entry]) => entry)).toEqual([]);
  });

  it('OPEN_FILES_AT_1917 のファイルには open の行がある (片付けたファイルは一覧から外す)', () => {
    for (const file of OPEN_FILES_AT_1917) {
      expect(open.some(([entry]) => entry.startsWith(`${file} `)), file).toBe(true);
    }
  });

  it('理由があり、範囲の外にしたファイル (OPEN_FILES_AT_1917) だけ', () => {
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
