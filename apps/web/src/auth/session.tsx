'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuthUser, LoginResponse } from '@internpath/contracts';
import { ApiError, apiRequest } from '@/lib/api';
import type { HttpMethod } from '@/lib/api';

/**
 * Session แยกต่อแท็บ: Refresh Token อยู่ใน sessionStorage ⇒ แต่ละแท็บล็อกอินคนละบัญชีได้ (เช่น แท็บหนึ่ง Admin อีกแท็บอาจารย์)
 * เปิดแท็บใหม่ต้องล็อกอินใหม่ • ออกจากระบบมีผลเฉพาะแท็บนั้น • ปิดแท็บ = session ในแท็บนั้นหาย
 */
const REFRESH_KEY = 'internpath.refresh_token';
const REFRESH_LOCK = 'internpath.refresh';
const TAB_KEY = 'internpath.tab_id';
const TAB_CHANNEL = 'internpath.tabs';
/** คีย์เดิมตอนเก็บ session ใน localStorage (ใช้ร่วมทุกแท็บ) — ย้ายเข้าแท็บแรกที่เปิดหลังอัปเดต แล้วลบทิ้ง */
const LEGACY_OWNER_KEY = 'internpath.session_user';

type TabMessage = { type: 'who' | 'here'; id: string };

function newTabId(): string {
  // crypto.randomUUID ใช้ได้เฉพาะ secure context — เปิดผ่าน IP ในวง LAN แบบ http จะไม่มี
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * เบราว์เซอร์คัดลอก sessionStorage ไปแท็บใหม่ตอน "ทำสำเนาแท็บ" ⇒ สองแท็บถือ Refresh Token เดียวกัน
 * ถ้าทั้งคู่ต่ออายุ Identity จะเห็น token ถูกใช้ซ้ำแล้วเพิกถอนทั้ง family (หลุดทั้งสองแท็บ)
 * จึงถามแท็บอื่นว่ามีใครใช้ tab id นี้อยู่ไหม — มี ⇒ แท็บนี้เป็นสำเนา ต้องทิ้ง session ที่คัดลอกมา
 */
function isDuplicateTab(id: string): Promise<boolean> {
  if (typeof BroadcastChannel === 'undefined') return Promise.resolve(false);
  const channel = new BroadcastChannel(TAB_CHANNEL);
  return new Promise((resolve) => {
    const done = (duplicate: boolean) => { clearTimeout(timer); channel.close(); resolve(duplicate); };
    const timer = setTimeout(() => done(false), 200);
    channel.onmessage = (event: MessageEvent<TabMessage>) => {
      if (event.data?.type === 'here' && event.data.id === id) done(true);
    };
    channel.postMessage({ type: 'who', id } satisfies TabMessage);
  });
}

type AuthContextValue = {
  ready: boolean;
  user: AuthUser | null;
  /** true เมื่อ session หายเพราะผู้ใช้กดออกจากระบบเอง (ไม่ใช่ session หมดอายุ) — ไม่ต้องจำหน้าเดิมไว้ใน `?next=` */
  signedOut: boolean;
  /** คืนผู้ใช้ที่เพิ่งล็อกอิน เพื่อให้หน้าที่เรียกพาไปหน้าแรกตามบทบาทได้ทันที (state `user` ยังไม่อัปเดตในรอบนี้) */
  login(email: string, password: string, unlockToken?: string): Promise<AuthUser>;
  logout(): Promise<void>;
  request<T>(path: string, init?: { method?: HttpMethod; body?: unknown }): Promise<T>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const accessToken = useRef<string | null>(null);
  const refreshing = useRef<Promise<void> | null>(null);

  const clearSession = useCallback(() => {
    accessToken.current = null;
    sessionStorage.removeItem(REFRESH_KEY);
    setUser(null);
  }, []);

  const applySession = useCallback((session: LoginResponse) => {
    accessToken.current = session.access_token;
    sessionStorage.setItem(REFRESH_KEY, session.refresh_token);
    setUser(session.user);
    setSignedOut(false);
    setReady(true);
  }, []);

  /**
   * ต่ออายุ session ทีละครั้ง — Identity หมุน Refresh Token ทุกครั้ง และถ้าเห็น token ที่หมุนไปแล้วถูกใช้ซ้ำจะเพิกถอนทั้ง family
   * ในแท็บเดียวกันกันด้วย `refreshing` • Web Locks คงไว้เป็นชั้นสำรองกรณีแท็บสำเนาที่ตรวจไม่ทัน (อ่าน token หลังได้ lock)
   */
  const refresh = useCallback((): Promise<void> => {
    if (!refreshing.current) {
      const run = async (): Promise<void> => {
        const token = sessionStorage.getItem(REFRESH_KEY);
        if (!token) throw new ApiError('UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบ', 401);
        try {
          const session = await apiRequest<LoginResponse>('/auth/refresh', { refresh_token: token });
          if (sessionStorage.getItem(REFRESH_KEY) === token) applySession(session);
        }
        catch (error) {
          if (error instanceof ApiError && error.status === 401 && sessionStorage.getItem(REFRESH_KEY) === token) {
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
    let cancelled = false;
    let channel: BroadcastChannel | null = null;
    void (async () => {
      // ย้าย session เดิมจาก localStorage (ก่อนแยกต่อแท็บ) มาไว้ในแท็บนี้ครั้งเดียว
      const legacy = localStorage.getItem(REFRESH_KEY);
      localStorage.removeItem(REFRESH_KEY);
      localStorage.removeItem(LEGACY_OWNER_KEY);
      if (legacy && !sessionStorage.getItem(REFRESH_KEY)) sessionStorage.setItem(REFRESH_KEY, legacy);

      const copiedId = sessionStorage.getItem(TAB_KEY);
      if (copiedId && await isDuplicateTab(copiedId)) {
        sessionStorage.removeItem(REFRESH_KEY);
        sessionStorage.removeItem(TAB_KEY);
      }
      if (cancelled) return;
      const id = sessionStorage.getItem(TAB_KEY) ?? newTabId();
      sessionStorage.setItem(TAB_KEY, id);
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(TAB_CHANNEL);
        channel.onmessage = (event: MessageEvent<TabMessage>) => {
          if (event.data?.type === 'who' && event.data.id === id) channel?.postMessage({ type: 'here', id } satisfies TabMessage);
        };
      }
      if (sessionStorage.getItem(REFRESH_KEY)) await refresh().catch(() => undefined);
      if (!cancelled) setReady(true);
    })();
    return () => { cancelled = true; channel?.close(); };
  }, [refresh]);

  const login = useCallback(async (email: string, password: string, unlockToken?: string) => {
    const session = await apiRequest<LoginResponse>('/auth/login', {
      email, password, ...(unlockToken ? { unlock_token: unlockToken } : {}),
    });
    applySession(session);
    return session.user;
  }, [applySession]);

  const logout = useCallback(async () => {
    let token = sessionStorage.getItem(REFRESH_KEY);
    try {
      if (token && !accessToken.current) {
        await refresh();
        token = sessionStorage.getItem(REFRESH_KEY);
      }
      if (token && accessToken.current) {
        try { await apiRequest<void>('/auth/logout', { refresh_token: token }, accessToken.current); }
        catch (error) {
          if (!(error instanceof ApiError) || error.status !== 401) throw error;
          await refresh();
          token = sessionStorage.getItem(REFRESH_KEY);
          if (token && accessToken.current) {
            await apiRequest<void>('/auth/logout', { refresh_token: token }, accessToken.current);
          }
        }
      }
    } finally {
      setSignedOut(true);
      clearSession();
    }
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

  return <AuthContext.Provider value={{ ready, user, signedOut, login, logout, request }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('AuthProvider is missing');
  return context;
}
