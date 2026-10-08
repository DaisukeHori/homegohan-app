// #1210: 組織ダッシュボードの「Refresh Data」は aggregate-org-stats を呼ぶとき、
// 集計する日付 (date) を送る。以前は new Date().toISOString().split('T')[0] (= UTC の暦日) で、
// JST 00:00〜08:59 は前日の日付を送っていた。JST の「今日」を送ることを、実際にボタンを押して確かめる。

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

// ブラウザ用 Supabase クライアントの偽物。ログイン済みの組織管理者 (組織 org-1) が見ている想定。
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "admin-1" } }, error: null }) },
    from: (table: string) => {
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "order", "limit"]) {
        query[method] = () => query;
      }
      query.single = async () =>
        table === "user_profiles"
          ? { data: { organization_id: "org-1" }, error: null }
          : { data: null, error: { message: "no rows" } };
      return query;
    },
    functions: { invoke: mocks.invoke },
  }),
}));

import OrgDashboardPage from "../src/app/(org)/org/dashboard/page";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => unknown) => Promise<void> }).act;

let container: HTMLDivElement;
let root: Root;
let alertSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue({ data: { success: true }, error: null });
  alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
  // Date だけ偽物にする (Promise / タイマーはそのまま動かす)
  vi.useFakeTimers({ toFake: ["Date"] });

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  alertSpy.mockRestore();
  vi.useRealTimers();
});

// 更新が最後まで終わる (成功の alert が出る) のを待つ。
// vi.waitFor は偽の時計を進めてしまい、境界ちょうどの時刻での検証が崩れるので使わない。
// Date 以外は偽物にしていないので、本物の setTimeout / performance で待てる。
async function untilAlerted() {
  const startedAt = performance.now();
  while (alertSpy.mock.calls.length === 0) {
    if (performance.now() - startedAt > 3000) {
      throw new Error("更新が終わりませんでした (alert が呼ばれていません)");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function clickRefresh() {
  await act(async () => {
    root.render(h(OrgDashboardPage));
  });

  const button = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Refresh Data"),
  );
  expect(button, "「Refresh Data」ボタンが見つかりません").toBeTruthy();

  await act(async () => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await untilAlerted();
  });
}

describe("組織ダッシュボード: Refresh Data が送る集計日は JST の今日 (#1210)", () => {
  // [UTC の現在時刻, JST での時刻 (説明用), 期待する集計日]
  const cases: Array<[string, string, string]> = [
    ["2026-07-12T14:59:59.999Z", "JST 7/12 23:59:59.999", "2026-07-12"],
    ["2026-07-12T15:00:00.000Z", "JST 7/13 00:00:00", "2026-07-13"],
    ["2026-07-12T16:00:00.000Z", "JST 7/13 01:00 (Issue の再現例)", "2026-07-13"],
    ["2026-07-12T23:59:59.999Z", "JST 7/13 08:59:59.999", "2026-07-13"],
    ["2026-07-13T00:00:00.000Z", "JST 7/13 09:00:00", "2026-07-13"],
    ["2026-07-13T15:00:00.000Z", "JST 7/14 00:00:00", "2026-07-14"],
  ];

  it.each(cases)("%s (%s) → date は %s", async (nowUtc, _jst, expectedDate) => {
    vi.setSystemTime(new Date(nowUtc));

    await clickRefresh();

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("aggregate-org-stats", {
      body: { organizationId: "org-1", date: expectedDate },
    });
    expect(alertSpy).toHaveBeenCalledWith("最新データに更新しました");
    // 偽の時計が動いていない (= 境界ちょうどの時刻のまま検証できている)
    expect(new Date().toISOString()).toBe(nowUtc);
  });
});
