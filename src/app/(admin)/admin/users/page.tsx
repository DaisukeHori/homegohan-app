"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

interface UserRow {
  id: string;
  nickname: string | null;
  roles: string[];
  isBanned: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

const ROLE_STYLES: Record<string, string> = {
  super_admin: "bg-purple-100 text-purple-700",
  admin: "bg-orange-100 text-orange-700",
  support: "bg-teal-100 text-teal-700",
  org_admin: "bg-blue-100 text-blue-700",
  user: "bg-gray-100 text-gray-600",
};

async function fetchUsersPageData(): Promise<{ currentUserId: string | null; users: UserRow[] }> {
  const supabase = createClient();
  const [{ data: authData }, usersResponse] = await Promise.all([
    supabase.auth.getUser(),
    fetch("/api/admin/users?limit=100", { cache: "no-store" }),
  ]);

  if (!usersResponse.ok) {
    const error = await usersResponse.json().catch(() => ({ error: "Failed to load users" }));
    throw new Error(error.error || "Failed to load users");
  }

  const usersData = await usersResponse.json();
  return {
    currentUserId: authData.user?.id ?? null,
    users: (usersData.users ?? []) as UserRow[],
  };
}

function uniqueRoles(roles: string[]): string[] {
  return Array.from(new Set(roles.filter(Boolean)));
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        const data = await fetchUsersPageData();
        if (cancelled) return;

        setCurrentUserId(data.currentUserId);
        setUsers(data.users);
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "Failed to load users";
          alert(`エラー: ${message}`);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const data = await fetchUsersPageData();
      setCurrentUserId(data.currentUserId);
      setUsers(data.users);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load users";
      alert(`エラー: ${message}`);
    } finally {
      setRefreshing(false);
    }
  };

  const toggleAdminRole = async (user: UserRow) => {
    const currentRoles = uniqueRoles(user.roles || ["user"]);
    const hasAdmin = currentRoles.includes("admin");
    const nextRoles = hasAdmin
      ? currentRoles.filter((role) => role !== "admin")
      : uniqueRoles([...currentRoles, "admin", "user"]);

    if (user.id === currentUserId && !nextRoles.includes("admin")) {
      alert("自分自身の管理者権限は解除できません");
      return;
    }

    if (user.roles.includes("super_admin")) {
      alert("super_admin の権限はこの画面から変更できません");
      return;
    }

    if (!confirm(`このユーザーの admin 権限を${hasAdmin ? "解除" : "付与"}しますか？`)) {
      return;
    }

    try {
      const res = await fetch(`/api/admin/users/${user.id}/role`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roles: nextRoles }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed to update roles" }));
        throw new Error(err.error || "Failed to update roles");
      }

      setUsers((prev) =>
        prev.map((row) =>
          row.id === user.id
            ? {
                ...row,
                roles: uniqueRoles(nextRoles),
              }
            : row
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update roles";
      alert(`エラー: ${message}`);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">User Management</h1>
        <Button onClick={handleRefresh} variant="outline" disabled={refreshing}>
          {refreshing ? "Refreshing..." : "Refresh"}
        </Button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="p-4 text-xs font-bold text-gray-500 uppercase">User</th>
              <th className="p-4 text-xs font-bold text-gray-500 uppercase">Roles</th>
              <th className="p-4 text-xs font-bold text-gray-500 uppercase">Joined</th>
              <th className="p-4 text-xs font-bold text-gray-500 uppercase text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={4} className="p-8 text-center text-gray-400">
                  Loading...
                </td>
              </tr>
            ) : (
              users.map((user) => {
                const roleList = uniqueRoles(user.roles || ["user"]);
                const hasAdmin = roleList.includes("admin");
                const isSelf = user.id === currentUserId;
                const isLocked = roleList.includes("super_admin");

                return (
                  <tr key={user.id} className="hover:bg-gray-50 transition-colors">
                    <td className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center font-bold text-gray-500 text-xs">
                          {user.nickname?.[0] || "?"}
                        </div>
                        <div>
                          <p className="font-bold text-gray-900">{user.nickname || "(no name)"}</p>
                          <p className="text-xs text-gray-400 font-mono">{user.id.slice(0, 8)}...</p>
                          {user.isBanned ? (
                            <p className="text-xs text-red-500 font-medium mt-1">BANNED</p>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className="p-4">
                      <div className="flex flex-wrap gap-2">
                        {roleList.map((role) => (
                          <span
                            key={role}
                            className={`px-2 py-1 rounded-full text-xs font-bold ${ROLE_STYLES[role] || ROLE_STYLES.user}`}
                          >
                            {role}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="p-4 text-sm text-gray-500">
                      <div>{new Date(user.createdAt).toLocaleDateString()}</div>
                      <div className="text-xs text-gray-400 mt-1">
                        Last login: {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : "-"}
                      </div>
                    </td>
                    <td className="p-4 text-right">
                      <button
                        onClick={() => toggleAdminRole(user)}
                        className={`text-xs font-bold px-3 py-1.5 rounded-lg transition-colors ${
                          hasAdmin
                            ? "text-red-600 hover:bg-red-50"
                            : "text-blue-600 hover:bg-blue-50"
                        } ${isLocked ? "opacity-50 cursor-not-allowed" : ""}`}
                        disabled={isLocked || (isSelf && hasAdmin && roleList.length === 1)}
                      >
                        {hasAdmin ? "Remove Admin" : "Make Admin"}
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
