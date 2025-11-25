"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { motion, AnimatePresence } from "framer-motion";

interface Member {
  id: string;
  nickname: string;
  role: string;
  created_at: string;
}

export default function MembersPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [form, setForm] = useState({ email: "", password: "", nickname: "" });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchMembers = async () => {
    setLoading(true);
    const res = await fetch('/api/org/users');
    if (res.ok) {
      const data = await res.json();
      setMembers(data.members);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchMembers();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/org/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error);
      }

      alert("メンバーを作成しました。\nログイン情報を共有してください。");
      setForm({ email: "", password: "", nickname: "" });
      setShowAddModal(false);
      fetchMembers();
    } catch (error: any) {
      alert(`作成失敗: ${error.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-8 space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Members</h1>
          <p className="text-gray-500 text-sm">所属メンバーの管理と招待</p>
        </div>
        <Button onClick={() => setShowAddModal(true)} className="bg-blue-600 hover:bg-blue-700 text-white font-bold px-6 rounded-xl shadow-lg shadow-blue-200">
          + Add Member
        </Button>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="p-4 text-xs font-bold text-gray-500 uppercase">Nickname</th>
              <th className="p-4 text-xs font-bold text-gray-500 uppercase">Role</th>
              <th className="p-4 text-xs font-bold text-gray-500 uppercase">Joined</th>
              <th className="p-4 text-xs font-bold text-gray-500 uppercase text-right">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={4} className="p-8 text-center text-gray-400">Loading...</td></tr>
            ) : members.length === 0 ? (
              <tr><td colSpan={4} className="p-8 text-center text-gray-400">No members yet.</td></tr>
            ) : (
              members.map((member) => (
                <tr key={member.id} className="hover:bg-gray-50 transition-colors">
                  <td className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-100 to-blue-50 flex items-center justify-center font-bold text-blue-500 text-xs">
                        {member.nickname[0]}
                      </div>
                      <span className="font-bold text-gray-900">{member.nickname}</span>
                    </div>
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                      member.role === 'org_admin' 
                        ? 'bg-blue-100 text-blue-700' 
                        : 'bg-gray-100 text-gray-600'
                    }`}>
                      {member.role.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="p-4 text-sm text-gray-500 font-mono">
                    {new Date(member.created_at).toLocaleDateString()}
                  </td>
                  <td className="p-4 text-right">
                    <span className="inline-block w-2 h-2 rounded-full bg-green-400" />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* メンバー追加モーダル */}
      <AnimatePresence>
        {showAddModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-white w-full max-w-md rounded-3xl p-8 shadow-2xl"
            >
              <h2 className="text-xl font-bold text-gray-900 mb-6">Create New Member</h2>
              <form onSubmit={handleCreate} className="space-y-4">
                <div>
                  <Label htmlFor="nickname">Nickname</Label>
                  <Input
                    id="nickname"
                    value={form.nickname}
                    onChange={(e) => setForm({ ...form, nickname: e.target.value })}
                    className="mt-1"
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    className="mt-1"
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="password">Temporary Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    className="mt-1"
                    minLength={6}
                    required
                  />
                  <p className="text-xs text-gray-400 mt-1">※ユーザーに共有してください</p>
                </div>
                
                <div className="flex gap-3 pt-4">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setShowAddModal(false)}
                    className="flex-1 rounded-xl"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={isSubmitting}
                    className="flex-1 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold shadow-lg shadow-blue-200"
                  >
                    {isSubmitting ? "Creating..." : "Create Account"}
                  </Button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

