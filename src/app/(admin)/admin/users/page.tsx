"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

interface UserRow {
  id: string;
  email?: string;
  nickname: string;
  role: 'user' | 'admin';
  created_at: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const supabase = createClient();

  const fetchUsers = async () => {
    setLoading(true);
    
    // 自分のID取得
    const { data: { user } } = await supabase.auth.getUser();
    if (user) setCurrentUser(user.id);

    // ユーザー一覧取得
    // Note: auth.usersテーブルはクライアントから直接参照できないため、
    // user_profilesをベースにする。emailはprofileに含まれないため、
    // 厳密な管理にはEdge Function経由でauth.usersを引く必要があるが、
    // ここではnicknameとroleで管理する。
    const { data } = await supabase
      .from('user_profiles')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (data) setUsers(data as any);
    setLoading(false);
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const toggleRole = async (userId: string, currentRole: string) => {
    const newRole = currentRole === 'admin' ? 'user' : 'admin';
    
    if (userId === currentUser && newRole === 'user') {
      alert("自分自身の管理者権限は解除できません");
      return;
    }

    if (!confirm(`このユーザーを ${newRole.toUpperCase()} に変更しますか？`)) return;

    try {
      const res = await fetch(`/api/admin/users/${userId}/role`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error);
      }

      // UI更新
      setUsers(prev => prev.map(u => 
        u.id === userId ? { ...u, role: newRole } : u
      ));
      
    } catch (error: any) {
      alert(`エラー: ${error.message}`);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">User Management</h1>
        <Button onClick={fetchUsers} variant="outline">Refresh</Button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="p-4 text-xs font-bold text-gray-500 uppercase">User</th>
              <th className="p-4 text-xs font-bold text-gray-500 uppercase">Role</th>
              <th className="p-4 text-xs font-bold text-gray-500 uppercase">Joined</th>
              <th className="p-4 text-xs font-bold text-gray-500 uppercase text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={4} className="p-8 text-center text-gray-400">Loading...</td></tr>
            ) : (
              users.map((user) => (
                <tr key={user.id} className="hover:bg-gray-50 transition-colors">
                  <td className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center font-bold text-gray-500 text-xs">
                        {user.nickname[0]}
                      </div>
                      <div>
                        <p className="font-bold text-gray-900">{user.nickname}</p>
                        <p className="text-xs text-gray-400 font-mono">{user.id.slice(0, 8)}...</p>
                      </div>
                    </div>
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded-full text-xs font-bold ${
                      user.role === 'admin' 
                        ? 'bg-purple-100 text-purple-700' 
                        : 'bg-gray-100 text-gray-600'
                    }`}>
                      {user.role.toUpperCase()}
                    </span>
                  </td>
                  <td className="p-4 text-sm text-gray-500">
                    {new Date(user.created_at).toLocaleDateString()}
                  </td>
                  <td className="p-4 text-right">
                    <button
                      onClick={() => toggleRole(user.id, user.role)}
                      className={`text-xs font-bold px-3 py-1.5 rounded-lg transition-colors ${
                        user.role === 'admin'
                          ? 'text-red-600 hover:bg-red-50'
                          : 'text-blue-600 hover:bg-blue-50'
                      }`}
                      disabled={user.id === currentUser}
                    >
                      {user.role === 'admin' ? 'Demote to User' : 'Promote to Admin'}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}


