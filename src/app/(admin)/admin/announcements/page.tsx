"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";

interface Announcement {
  id: string;
  title: string;
  content: string;
  is_public: boolean;
  created_at: string;
}

export default function AnnouncementsPage() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ title: "", content: "", isPublic: true });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchAnnouncements = async () => {
    setLoading(true);
    const res = await fetch('/api/announcements?mode=admin');
    if (res.ok) {
      const data = await res.json();
      setAnnouncements(data.announcements);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchAnnouncements();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title || !form.content) return;

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });

      if (!res.ok) throw new Error('Failed to create');

      setForm({ title: "", content: "", isPublic: true });
      fetchAnnouncements();
      alert("お知らせを作成しました");
    } catch (error) {
      alert("作成に失敗しました");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Announcements</h1>
      </div>

      {/* 作成フォーム */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
        <h2 className="text-lg font-bold mb-4">Create New</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="e.g. Maintenance Scheduled"
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="content">Content</Label>
            <textarea
              id="content"
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              className="w-full mt-1 p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#FF8A65] focus:outline-none min-h-[100px]"
              placeholder="Enter message..."
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="isPublic"
              checked={form.isPublic}
              onChange={(e) => setForm({ ...form, isPublic: e.target.checked })}
              className="w-4 h-4 text-[#FF8A65] rounded border-gray-300 focus:ring-[#FF8A65]"
            />
            <Label htmlFor="isPublic">Publish Immediately</Label>
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={isSubmitting || !form.title}>
              {isSubmitting ? "Creating..." : "Create Announcement"}
            </Button>
          </div>
        </form>
      </div>

      {/* 一覧 */}
      <div className="space-y-4">
        <h2 className="text-lg font-bold">History</h2>
        {loading ? (
          <p className="text-gray-400">Loading...</p>
        ) : announcements.length === 0 ? (
          <p className="text-gray-400">No announcements yet.</p>
        ) : (
          announcements.map((item) => (
            <div key={item.id} className="bg-white p-4 rounded-xl border border-gray-100 flex justify-between items-start">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                    item.is_public ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {item.is_public ? 'PUBLISHED' : 'DRAFT'}
                  </span>
                  <span className="text-xs text-gray-400">
                    {new Date(item.created_at).toLocaleDateString()}
                  </span>
                </div>
                <h3 className="font-bold text-gray-900">{item.title}</h3>
                <p className="text-sm text-gray-600 mt-1">{item.content}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

