"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { createClient } from "@/lib/supabase/client";

export default function ModerationPage() {
  const [meals, setMeals] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  const fetchMeals = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('meals')
      .select('*, user_profiles(nickname)')
      .order('created_at', { ascending: false })
      .limit(50);
    
    if (data) setMeals(data);
    setLoading(false);
  };

  useEffect(() => {
    fetchMeals();
  }, []);

  const handleDelete = async (id: string) => {
    if (!confirm("本当に削除しますか？この操作は取り消せません。")) return;
    
    const { error } = await supabase.from('meals').delete().eq('id', id);
    if (error) {
      alert("削除に失敗しました");
    } else {
      setMeals(prev => prev.filter(m => m.id !== id));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Recent Posts</h1>
        <button onClick={fetchMeals} className="px-4 py-2 bg-gray-100 rounded-lg hover:bg-gray-200 text-sm font-bold">
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading feed...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {meals.map((meal) => (
            <div key={meal.id} className="bg-white rounded-xl overflow-hidden shadow-sm border border-gray-100 group">
              <div className="relative h-48 bg-gray-100">
                {meal.photo_url ? (
                  <Image src={meal.photo_url} fill alt="Meal" className="object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-4xl">🍽️</div>
                )}
                <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button 
                    onClick={() => handleDelete(meal.id)}
                    className="bg-red-500 text-white text-xs font-bold px-3 py-1.5 rounded-full shadow-lg hover:bg-red-600"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div className="p-4">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <p className="text-xs text-gray-400 font-bold mb-1">
                      {new Date(meal.created_at).toLocaleString()}
                    </p>
                    <p className="font-bold text-gray-900 line-clamp-1">{meal.memo || "No memo"}</p>
                  </div>
                  <span className="text-xs px-2 py-1 bg-gray-100 rounded text-gray-500 font-bold uppercase">
                    {meal.meal_type}
                  </span>
                </div>
                <p className="text-xs text-gray-500">
                  User: <span className="font-bold text-gray-700">{meal.user_profiles?.nickname || "Unknown"}</span>
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}



