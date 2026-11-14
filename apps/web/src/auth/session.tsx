'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuthUser, LoginResponse } from '@internpath/contracts';
import { ApiError, apiRequest } from '@/lib/api';

const REFRESH_KEY = 'internpath.refresh_token';

type AuthContextValue = {
  ready: boolean;
  user: AuthUser | null;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  request<T>(path: string): Promise<T>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const accessToken = useRef<string | null>(null);
  const refreshing = useRef<Promise<LoginResponse> | null>(null);

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

  const refresh = useCallback(async (): Promise<void> => {
    const token = localStorage.getItem(REFRESH_KEY);
    if (!token) throw new ApiError('UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบ', 401);
    if (!refreshing.current) {
      refreshing.current = apiRequest<LoginResponse>('/auth/refresh', { refresh_token: token });
    }
    try {
      const session = await refreshing.current;
      if (localStorage.getItem(REFRESH_KEY) === token) applySession(session);
    }
    catch (error) {
      if (error instanceof ApiError && error.status === 401 && localStorage.getItem(REFRESH_KEY) === token) {
        clearSession();
      }
      throw error;
    }
    finally { refreshing.current = null; }
  }, [applySession, clearSession]);

  useEffect(() => {
    if (!localStorage.getItem(REFRESH_KEY)) { setReady(true); return; }
    void refresh().catch(() => undefined).finally(() => setReady(true));
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const session = await apiRequest<LoginResponse>('/auth/login', { email, password });
    applySession(session);
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

  const request = useCallback(async <T,>(path: string): Promise<T> => {
    if (!accessToken.current) await refresh();
    try { return await apiRequest<T>(path, undefined, accessToken.current || undefined); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401 && error.code !== 'ACCOUNT_SUSPENDED') {
        await refresh();
        return apiRequest<T>(path, undefined, accessToken.current || undefined);
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
