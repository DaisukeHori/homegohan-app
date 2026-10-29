/**
 * #2086 V5 (triage-1029c) のテスト: 運営のメンバーシップの監査ログの画面 (/operator/membership/audit)
 *
 * 以前の画面は、操作 (membership_audit.action) と対象 (scope) の内部の英字の値をそのまま出していた:
 *  - 一覧の「Action」の列に operator_force_owner_transfer などを font-mono で出す
 *  - 絞り込みの選択肢の文も内部の値。見出しも Scope / Action / Actor / All
 *  - 詳細の枠は Scope に organization / family、Action に内部の値
 *  - 一覧の Scope の列は日本語にしていたが、organization 以外をすべて「家族」と出す
 * 直したあとは、操作・対象を日本語の表示名の表 (src/lib/membership/audit-labels.ts) に通して出し、表に無い値は
 * 「不明な操作」「不明な対象」の固定の文にする (内部の値を添えて出すこともしない)。
 *
 * あわせて (V7 と同じ型): 一覧の API が 200 で data が配列でない壊れた応答を返したとき、「ログがありません」(0 件) と見せていた。
 * 読み込めなかったものとして「監査ログを読み込めませんでした」を出す。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: MembershipAuditPage } = await import('@/app/(operator)/operator/membership/audit/page');

/** 画面に出す日本語 (画面と同じもの。表の全数は tests/membership-audit-labels-contract-2086.test.ts が見る) */
const EXPECTED_ACTION_LABELS: Record<string, string> = {
  operator_force_owner_transfer: '運営によるオーナーの強制譲渡',
  operator_force_representative_transfer: '運営による代表者の強制譲渡',
  operator_force_dissolve: '運営による強制解散',
  invite_accepted: '招待の承諾',
  member_left: 'メンバーの脱退',
  owner_transferred: 'オーナーの譲渡',
  representative_transferred: '代表者の譲渡',
  paste_executed: '食事の家族への貼り付け',
};
const EXPECTED_SCOPE_LABELS: Record<string, string> = { organization: '組織', family: '家族' };
const UNKNOWN_ACTION_LABEL = '不明な操作';
const UNKNOWN_SCOPE_LABEL = '不明な対象';
const ALL_LABEL = 'すべて';

/** 表に無い値 (将来の値・壊れた応答) */
const FUTURE_ACTION = 'future_action_value';
const FUTURE_SCOPE = 'future_scope_value';

const OPERATOR_ID = '0e0e0e0e-0000-4000-8000-000000000001';
const ACTOR_ID = 'acacacac-0000-4000-8000-000000000002';

function auditRow(n: number, overrides: Record<string, unknown>) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    scope: 'family',
    scope_id: '00000000-0000-4000-8000-0000000000ee',
    action: 'invite_accepted',
    actor_id: ACTOR_ID,
    target_user_id: null,
    metadata: {},
    created_at: '2026-10-08T04:30:00.000Z',
    ...overrides,
  };
}

const ROWS = [
  auditRow(1, { scope: 'organization', action: 'operator_force_owner_transfer', actor_id: null, metadata: { operator_id: OPERATOR_ID } }),
  auditRow(2, { scope: 'family', action: 'invite_accepted' }),
  auditRow(3, { scope: 'family', action: 'paste_executed' }),
  auditRow(4, { scope: FUTURE_SCOPE, action: FUTURE_ACTION }),
];

/** 画面に出てはいけない内部の英字の値 */
const INTERNAL_VALUES = [
  ...Object.keys(EXPECTED_ACTION_LABELS),
  'organization',
  'family',
  FUTURE_ACTION,
  FUTURE_SCOPE,
];

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 英字の内部の値が、語として (前後が英字・_ でない形で) 文の中に出ていないか */
function containsEnglishValue(text: string, value: string): boolean {
  return new RegExp(`(^|[^A-Za-z_])${value}([^A-Za-z_]|$)`).test(text);
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderPage(body: unknown, status = 200) {
  fetchMock = vi.fn(async () => jsonResponse(status, body));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    root.render(<MembershipAuditPage />);
  });
  await flush();
}

function bodyRows(): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll('tbody tr'));
}

function cellText(row: HTMLTableRowElement, index: number): string {
  return (row.querySelectorAll('td')[index]?.textContent ?? '').trim();
}

/** 列の番号 (見出しの順) */
const SCOPE_COLUMN = 1;
const ACTION_COLUMN = 2;
const ACTOR_COLUMN = 3;

function definitionOf(host: Element, term: string): string | null {
  const dt = Array.from(host.querySelectorAll('dt')).find((el) => el.textContent === term);
  return dt?.parentElement?.querySelector('dd')?.textContent?.trim() ?? null;
}

describe('#2086 V5 監査ログの一覧: 操作・対象を日本語の表示名で出す', () => {
  it('操作の列・対象の列は日本語の表示名。表に無い値は固定の文で、内部の英字の値を出さない', async () => {
    await renderPage({ data: ROWS, meta: { total: ROWS.length } });

    const rows = bodyRows();
    expect(rows).toHaveLength(ROWS.length);
    expect(cellText(rows[0], ACTION_COLUMN)).toBe(EXPECTED_ACTION_LABELS.operator_force_owner_transfer);
    expect(cellText(rows[1], ACTION_COLUMN)).toBe(EXPECTED_ACTION_LABELS.invite_accepted);
    expect(cellText(rows[2], ACTION_COLUMN)).toBe(EXPECTED_ACTION_LABELS.paste_executed);
    expect(cellText(rows[3], ACTION_COLUMN)).toBe(UNKNOWN_ACTION_LABEL);
    expect(cellText(rows[0], SCOPE_COLUMN)).toBe(EXPECTED_SCOPE_LABELS.organization);
    expect(cellText(rows[1], SCOPE_COLUMN)).toBe(EXPECTED_SCOPE_LABELS.family);
    // organization 以外を全部「家族」にしない (#2086 V5)
    expect(cellText(rows[3], SCOPE_COLUMN)).toBe(UNKNOWN_SCOPE_LABEL);

    const tbodyText = container.querySelector('tbody')?.textContent ?? '';
    for (const value of INTERNAL_VALUES) {
      expect(containsEnglishValue(tbodyText, value), `一覧に ${value} が出ている`).toBe(false);
    }
  });

  it('運営の強制操作の行は、操作した人の列に運営と運営者の ID の先頭を出す (英字の [SYS] op: を出さない)', async () => {
    await renderPage({ data: ROWS, meta: { total: ROWS.length } });

    const actor = cellText(bodyRows()[0], ACTOR_COLUMN);
    expect(actor).toContain('運営');
    expect(actor).toContain(OPERATOR_ID.slice(0, 8));
    expect(actor).not.toContain('[SYS]');
    expect(actor).not.toContain('op:');
  });

  it('見出しは日本語 (Scope / Action / Actor を出さない)', async () => {
    await renderPage({ data: ROWS, meta: { total: ROWS.length } });

    const headings = Array.from(container.querySelectorAll('thead th')).map((th) => (th.textContent ?? '').trim());
    expect(headings).toEqual(['日時', '対象', '操作', '操作した人']);
  });
});

describe('#2086 V5 監査ログの絞り込み: 選択肢と見出しを日本語で出す', () => {
  it('対象・操作の選択肢の文は日本語で、送る値は内部の値のまま。「All」を出さない', async () => {
    await renderPage({ data: ROWS, meta: { total: ROWS.length } });

    const selects = Array.from(container.querySelectorAll('form select'));
    expect(selects).toHaveLength(2);
    const [scopeSelect, actionSelect] = selects;

    const scopeOptions = Array.from(scopeSelect.querySelectorAll('option')).map((o) => [o.value, o.textContent]);
    expect(scopeOptions).toEqual([
      ['', ALL_LABEL],
      ['organization', EXPECTED_SCOPE_LABELS.organization],
      ['family', EXPECTED_SCOPE_LABELS.family],
    ]);

    const actionOptions = Array.from(actionSelect.querySelectorAll('option'));
    expect(actionOptions[0]?.value).toBe('');
    expect(actionOptions[0]?.textContent).toBe(ALL_LABEL);
    for (const [value, label] of Object.entries(EXPECTED_ACTION_LABELS)) {
      const option = actionOptions.find((o) => o.value === value);
      expect(option, `選択肢 ${value}`).toBeDefined();
      expect(option?.textContent).toBe(label);
    }
    for (const option of actionOptions) {
      expect(/[A-Za-z]/.test(option.textContent ?? ''), `選択肢の文「${option.textContent}」が英字`).toBe(false);
    }

    const labels = Array.from(container.querySelectorAll('form label')).map((l) => (l.textContent ?? '').trim());
    for (const english of ['Scope', 'Action', 'From', 'To']) {
      expect(labels).not.toContain(english);
    }
  });

  it('操作の選択肢を選んで検索すると、API へは内部の値で絞り込む', async () => {
    await renderPage({ data: ROWS, meta: { total: ROWS.length } });

    const actionSelect = container.querySelectorAll('form select')[1] as HTMLSelectElement;
    await act(async () => {
      actionSelect.value = 'operator_force_owner_transfer';
      actionSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const lastUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]), 'http://localhost');
    expect(lastUrl.searchParams.get('action')).toBe('operator_force_owner_transfer');
  });
});

describe('#2086 V5 監査ログの詳細の枠: 操作・対象を日本語で出す', () => {
  async function openDetail(index: number) {
    await act(async () => {
      bodyRows()[index].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const modal = container.querySelector('h2')?.closest('div.bg-white');
    expect(modal, '詳細の枠').not.toBeNull();
    return modal as Element;
  }

  it('運営の強制譲渡の行: 対象は「組織 / <ID>」、操作は日本語の表示名', async () => {
    await renderPage({ data: ROWS, meta: { total: ROWS.length } });

    const modal = await openDetail(0);

    expect(definitionOf(modal, '対象 / ID')).toBe(`${EXPECTED_SCOPE_LABELS.organization} / ${ROWS[0].scope_id}`);
    expect(definitionOf(modal, '操作')).toBe(EXPECTED_ACTION_LABELS.operator_force_owner_transfer);
    // 操作した人が無い (システム) 行は英字の (system) を出さない
    expect(definitionOf(modal, '操作した人')).not.toContain('system');
    for (const term of ['Scope / ID', 'Action', 'Actor', 'Target User', 'Metadata']) {
      expect(definitionOf(modal, term), `見出し ${term}`).toBeNull();
    }
  });

  it('表に無い値の行: 対象・操作は固定の文で、内部の値を出さない', async () => {
    await renderPage({ data: ROWS, meta: { total: ROWS.length } });

    const modal = await openDetail(3);

    expect(definitionOf(modal, '対象 / ID')).toBe(`${UNKNOWN_SCOPE_LABEL} / ${ROWS[3].scope_id}`);
    expect(definitionOf(modal, '操作')).toBe(UNKNOWN_ACTION_LABEL);
    expect(modal.textContent ?? '').not.toContain(FUTURE_ACTION);
    expect(modal.textContent ?? '').not.toContain(FUTURE_SCOPE);
  });
});

describe('#2086 V5 (V7 と同じ型) 監査ログの一覧: 壊れた応答を「0 件」と見せない', () => {
  it.each([
    ['data が null', { data: null, meta: { total: 0 } }],
    ['data が無い', { meta: { total: 0 } }],
    ['data がオブジェクト', { data: { rows: [] }, meta: { total: 0 } }],
  ])('200 で %s の応答は「読み込めませんでした」を出し、「ログがありません」を出さない', async (_label, body) => {
    await renderPage(body);

    expect(container.textContent ?? '').toContain('監査ログを読み込めませんでした');
    expect(container.textContent ?? '').not.toContain('ログがありません');
  });

  it('読めた 0 件は「ログがありません」', async () => {
    await renderPage({ data: [], meta: { total: 0 } });

    expect(container.textContent ?? '').toContain('ログがありません');
    expect(container.textContent ?? '').not.toContain('読み込めませんでした');
  });
});
