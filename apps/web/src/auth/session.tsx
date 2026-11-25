'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuthUser, LoginResponse } from '@internpath/contracts';
import { ApiError, apiRequest } from '@/lib/api';
import type { HttpMethod } from '@/lib/api';

const REFRESH_KEY = 'internpath.refresh_token';
const REFRESH_LOCK = 'internpath.refresh';

type AuthContextValue = {
  ready: boolean;
  user: AuthUser | null;
  /** คืนผู้ใช้ที่เพิ่งล็อกอิน เพื่อให้หน้าที่เรียกพาไปหน้าแรกตามบทบาทได้ทันที (state `user` ยังไม่อัปเดตในรอบนี้) */
  login(email: string, password: string, unlockToken?: string): Promise<AuthUser>;
  logout(): Promise<void>;
  request<T>(path: string, init?: { method?: HttpMethod; body?: unknown }): Promise<T>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const accessToken = useRef<string | null>(null);
  const refreshing = useRef<Promise<void> | null>(null);

  const clearSession = useCallback(() => {
    accessToken.current = null;
    localStorage.removeItem(REFRESH_KEY);
    setUser(null);
  }, []);

  const applySession = useCallback((session: LoginResponse) => {
    accessToken.current = session.access_token;
    localStorage.setItem(REFRESH_KEY, session.refresh_token);
    setUser(session.user);
    setReady(true);
  }, []);

  /**
   * ต่ออายุ session ทีละครั้ง — ทั้งในหน้าเดียวกัน (refreshing) และข้ามแท็บ (Web Locks)
   * Identity หมุน Refresh Token ทุกครั้ง และถ้าเห็น token ที่หมุนไปแล้วถูกใช้ซ้ำจะเพิกถอนทั้ง family
   * ⇒ เดิมเปิดหลายแท็บ/โหลดหน้าพร้อมกันแล้วทุกตัวส่ง token เดิม ผู้ใช้หลุดออกจากระบบทุกแท็บ
   * จึงอ่าน token หลังได้ lock (แท็บก่อนหน้าอาจหมุนไปแล้ว ก็ใช้ token ใหม่ต่อ)
   */
  const refresh = useCallback((): Promise<void> => {
    if (!refreshing.current) {
      const run = async (): Promise<void> => {
        const token = localStorage.getItem(REFRESH_KEY);
        if (!token) throw new ApiError('UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบ', 401);
        try {
          const session = await apiRequest<LoginResponse>('/auth/refresh', { refresh_token: token });
          if (localStorage.getItem(REFRESH_KEY) === token) applySession(session);
        }
        catch (error) {
          if (error instanceof ApiError && error.status === 401 && localStorage.getItem(REFRESH_KEY) === token) {
            clearSession();
          }
          throw error;
        }
      };
      const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
      refreshing.current = (locks ? locks.request(REFRESH_LOCK, run) : run())
        .finally(() => { refreshing.current = null; });
    }
    return refreshing.current;
  }, [applySession, clearSession]);

  useEffect(() => {
    if (!localStorage.getItem(REFRESH_KEY)) { setReady(true); return; }
    void refresh().catch(() => undefined).finally(() => setReady(true));
  }, [refresh]);

  const login = useCallback(async (email: string, password: string, unlockToken?: string) => {
    const session = await apiRequest<LoginResponse>('/auth/login', {
      email, password, ...(unlockToken ? { unlock_token: unlockToken } : {}),
    });
    applySession(session);
    return session.user;
  }, [applySession]);

  const logout = useCallback(async () => {
    let token = localStorage.getItem(REFRESH_KEY);
    try {
      if (token && !accessToken.current) {
        await refresh();
        token = localStorage.getItem(REFRESH_KEY);
      }
      if (token && accessToken.current) {
        try { await apiRequest<void>('/auth/logout', { refresh_token: token }, accessToken.current); }
        catch (error) {
          if (!(error instanceof ApiError) || error.status !== 401) throw error;
          await refresh();
          token = localStorage.getItem(REFRESH_KEY);
          if (token && accessToken.current) {
            await apiRequest<void>('/auth/logout', { refresh_token: token }, accessToken.current);
          }
        }
      }
    } finally { clearSession(); }
  }, [clearSession, refresh]);

  const request = useCallback(async <T,>(path: string, init: { method?: HttpMethod; body?: unknown } = {}): Promise<T> => {
    if (!accessToken.current) await refresh();
    try { return await apiRequest<T>(path, init.body, accessToken.current || undefined, init.method); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401 && error.code !== 'ACCOUNT_SUSPENDED') {
        await refresh();
        return apiRequest<T>(path, init.body, accessToken.current || undefined, init.method);
      }
      if (error instanceof ApiError && error.code === 'ACCOUNT_SUSPENDED') clearSession();
      throw error;
    }
  }, [clearSession, refresh]);

  return <AuthContext.Provider value={{ ready, user, login, logout, request }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('AuthProvider is missing');
  return context;
}
