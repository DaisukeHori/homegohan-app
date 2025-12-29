import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthProvider";

export type MobileUserProfile = {
  id: string;
  nickname?: string | null;
  roles: string[];
  organizationId?: string | null;
};

type ProfileState = {
  isLoading: boolean;
  profile: MobileUserProfile | null;
  roles: string[];
  hasRole: (role: string) => boolean;
  refresh: () => Promise<void>;
};

const ProfileContext = createContext<ProfileState | null>(null);

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [profile, setProfile] = useState<MobileUserProfile | null>(null);

  const refresh = useCallback(async () => {
    if (!user) {
      setProfile(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    const { data, error } = await supabase
      .from("user_profiles")
      .select("id,nickname,roles,organization_id")
      .eq("id", user.id)
      .maybeSingle();

    if (error || !data) {
      // 未オンボーディング（プロフィール未作成）などを想定
      setProfile({
        id: user.id,
        nickname: null,
        roles: [],
        organizationId: null,
      });
      setIsLoading(false);
      return;
    }

    setProfile({
      id: data.id,
      nickname: (data as any).nickname ?? null,
      roles: Array.isArray((data as any).roles) ? (data as any).roles : [],
      organizationId: (data as any).organization_id ?? null,
    });
    setIsLoading(false);
  }, [user?.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refresh();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const value: ProfileState = useMemo(() => {
    const roles = profile?.roles ?? [];
    return {
      isLoading,
      profile,
      roles,
      hasRole: (role: string) => roles.includes(role),
      refresh,
    };
  }, [isLoading, profile, refresh]);

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfile(): ProfileState {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error("useProfile must be used within <ProfileProvider>");
  return ctx;
}


