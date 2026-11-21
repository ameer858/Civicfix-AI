import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import type { Session, User as SupabaseUser } from '@supabase/supabase-js';
import { supabase } from '../../supabase';
import { clearGmailOAuthSession, requestGmailSendAccessToken } from '../lib/gmailOAuth';
import { formatFriendlyError, initializeAuthenticatedProfile } from '../lib/civicService';
import { getActiveLanguage, translate, translateErrorMessage } from '../i18n';
import type { UserProfile, UserRole } from '../types/civic';

interface SignUpParams {
  email: string;
  password: string;
  displayName: string;
}

interface AuthContextValue {
  user: SupabaseUser | null;
  session: Session | null;
  profile: UserProfile | null;
  effectiveRole: UserRole;
  previewRole: UserRole | null;
  setPreviewRole: (role: UserRole | null) => void;
  loading: boolean;
  signingIn: boolean;
  connectingGmail: boolean;
  gmailConnected: boolean;
  authError: string | null;
  authNotice: string | null;
  clearAuthFeedback: () => void;
  bootstrapNotice: string | null;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (params: SignUpParams) => Promise<{ needsEmailConfirmation: boolean }>;
  refreshProfile: () => Promise<void>;
  connectGmail: () => Promise<string | null>;
  getGmailAccessToken: () => string | null;
  invalidateGmailToken: () => void;
  signOut: () => Promise<void>;
  getAccessToken: (forceRefresh?: boolean) => Promise<string>;
  getIdToken: (forceRefresh?: boolean) => Promise<string>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Strictly in-memory Gmail OAuth access token (never persisted to localStorage/sessionStorage)
let cachedGmailAccessToken: string | null = null;
let cachedGmailTokenUid: string | null = null;
let cachedGmailExpiresAtMs = 0;

function clearCachedGmailToken() {
  cachedGmailAccessToken = null;
  cachedGmailTokenUid = null;
  cachedGmailExpiresAtMs = 0;
}

function mapSupabaseAuthError(message: string): string {
  return translateErrorMessage(getActiveLanguage(), message);
}

function mapRealtimeProfileRow(row: Record<string, any>, fallback: UserProfile | null): UserProfile {
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const rawRole = row.role;
  const role: UserRole =
    rawRole === 'admin' || rawRole === 'officer' || rawRole === 'worker' || rawRole === 'citizen'
      ? rawRole
      : fallback?.role || 'citizen';

  return {
    uid: typeof row.id === 'string' ? row.id : fallback?.uid || '',
    displayName:
      (typeof row.full_name === 'string' && row.full_name.trim()) ||
      fallback?.displayName ||
      'Civic User',
    role,
    departmentId: typeof row.department_id === 'string' ? row.department_id : '',
    departmentName:
      typeof meta.departmentName === 'string'
        ? meta.departmentName
        : fallback?.departmentName || '',
    active: row.is_active !== false,
    availabilityStatus:
      typeof meta.availabilityStatus === 'string'
        ? meta.availabilityStatus
        : fallback?.availabilityStatus,
    availabilityNote:
      typeof meta.availabilityNote === 'string'
        ? meta.availabilityNote
        : fallback?.availabilityNote,
    workZone: typeof meta.workZone === 'string' ? meta.workZone : fallback?.workZone,
    employeeId: typeof meta.employeeId === 'string' ? meta.employeeId : fallback?.employeeId,
    supervisorId: typeof meta.supervisorId === 'string' ? meta.supervisorId : fallback?.supervisorId,
    supervisorName:
      typeof meta.supervisorName === 'string' ? meta.supervisorName : fallback?.supervisorName,
    maxActiveTasks:
      typeof meta.maxActiveTasks === 'number' ? meta.maxActiveTasks : fallback?.maxActiveTasks,
    claimedInviteId:
      typeof meta.claimedInviteId === 'string'
        ? meta.claimedInviteId
        : fallback?.claimedInviteId,
    createdAt: row.created_at || fallback?.createdAt || new Date().toISOString(),
    updatedAt: row.updated_at || new Date().toISOString(),
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SupabaseUser | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [previewRole, setPreviewRoleState] = useState<UserRole | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [connectingGmail, setConnectingGmail] = useState(false);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [bootstrapNotice, setBootstrapNotice] = useState<string | null>(null);

  const tokenExpiryTimerRef = useRef<number | null>(null);
  const currentUserRef = useRef<SupabaseUser | null>(null);
  const loadedProfileUidRef = useRef<string | null>(null);
  const syncSeqRef = useRef<number>(0);

  currentUserRef.current = user;

  const clearExpiryTimer = useCallback(() => {
    if (tokenExpiryTimerRef.current !== null) {
      window.clearTimeout(tokenExpiryTimerRef.current);
      tokenExpiryTimerRef.current = null;
    }
  }, []);

  const clearAuthFeedback = useCallback(() => {
    setAuthError(null);
    setAuthNotice(null);
  }, []);

  const cacheGmailTokenInMemory = useCallback(
    (uid: string, accessToken: string, expiresInSec: number) => {
      clearExpiryTimer();
      const ttlMs = Math.max(60, expiresInSec - 30) * 1000;
      cachedGmailAccessToken = accessToken;
      cachedGmailTokenUid = uid;
      cachedGmailExpiresAtMs = Date.now() + ttlMs;
      setGmailConnected(true);
      tokenExpiryTimerRef.current = window.setTimeout(() => {
        clearCachedGmailToken();
        setGmailConnected(false);
      }, ttlMs);
    },
    [clearExpiryTimer]
  );

  const syncSessionProfile = useCallback(
    async (nextSession: Session | null, options: { silentIfLoaded?: boolean } = {}) => {
      const seq = ++syncSeqRef.current;

      setSession(nextSession);
      const nextUser = nextSession?.user ?? null;
      setUser(nextUser);

      if (!nextSession || !nextUser) {
        loadedProfileUidRef.current = null;
        setPreviewRoleState(null);
        clearExpiryTimer();
        clearCachedGmailToken();
        setGmailConnected(false);
        void clearGmailOAuthSession();
        setProfile(null);
        setBootstrapNotice(null);
        setLoading(false);
        return;
      }

      if (cachedGmailTokenUid && cachedGmailTokenUid !== nextUser.id) {
        clearExpiryTimer();
        clearCachedGmailToken();
        setGmailConnected(false);
      } else if (
        cachedGmailAccessToken &&
        cachedGmailTokenUid === nextUser.id &&
        Date.now() < cachedGmailExpiresAtMs
      ) {
        setGmailConnected(true);
      }

      const alreadyLoadedSameUser = loadedProfileUidRef.current === nextUser.id;
      if (options.silentIfLoaded && alreadyLoadedSameUser) {
        setLoading(false);
        return;
      }

      if (!alreadyLoadedSameUser) {
        setPreviewRoleState(null);
        setLoading(true);
      }
      setAuthError(null);

      try {
        let accessToken = nextSession.access_token;
        let initResult;
        try {
          initResult = await initializeAuthenticatedProfile(accessToken);
        } catch (firstErr: unknown) {
          const msg = firstErr instanceof Error ? firstErr.message.toLowerCase() : '';
          if (msg.includes('401') || msg.includes('authentication') || msg.includes('expired')) {
            const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
            if (refreshErr || !refreshed.session?.access_token) {
              throw firstErr;
            }
            accessToken = refreshed.session.access_token;
            if (seq === syncSeqRef.current) {
              setSession(refreshed.session);
              setUser(refreshed.session.user);
            }
            initResult = await initializeAuthenticatedProfile(accessToken);
          } else {
            throw firstErr;
          }
        }

        if (seq !== syncSeqRef.current) return;

        loadedProfileUidRef.current = nextUser.id;
        setProfile(initResult.profile);
        setBootstrapNotice(initResult.bootstrapNotice);
        setAuthNotice(null);
      } catch (err: unknown) {
        if (seq !== syncSeqRef.current) return;
        loadedProfileUidRef.current = null;
        setProfile(null);
        setBootstrapNotice(null);
        setAuthError(
          translateErrorMessage(getActiveLanguage(), formatFriendlyError(err)) ||
            translate(getActiveLanguage(), 'auth.profileInitFailed')
        );
        await supabase.auth.signOut().catch(() => {});
      } finally {
        if (seq === syncSeqRef.current) {
          setLoading(false);
        }
      }
    },
    [clearExpiryTimer]
  );

  // Restore persisted session on mount and subscribe to Supabase auth state changes
  useEffect(() => {
    let active = true;

    void supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          setAuthError(mapSupabaseAuthError(error.message));
          setLoading(false);
          return;
        }
        void syncSessionProfile(data.session);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setAuthError(translateErrorMessage(getActiveLanguage(), formatFriendlyError(err)));
        setLoading(false);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return;
      if (event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') {
        void syncSessionProfile(nextSession, { silentIfLoaded: true });
      } else {
        void syncSessionProfile(nextSession);
      }
    });

    return () => {
      active = false;
      clearExpiryTimer();
      subscription.unsubscribe();
    };
  }, [clearExpiryTimer, syncSessionProfile]);

  // Monitor live changes to the authenticated user's row in Supabase `profiles`
  useEffect(() => {
    if (!user?.id) return;

    const channel = supabase
      .channel(`profile-sync-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'profiles',
          filter: `id=eq.${user.id}`,
        },
        (payload) => {
          const nextRow = payload.new as Record<string, any> | null;
          if (!nextRow) return;
          if (nextRow.is_active === false) {
            setAuthError(translate(getActiveLanguage(), 'auth.accountDeactivated'));
            void supabase.auth.signOut().catch(() => {});
            return;
          }
          setProfile((prev) => mapRealtimeProfileRow(nextRow, prev));
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [user?.id]);

  const setPreviewRole = useCallback(
    (nextRole: UserRole | null) => {
      if (profile?.role !== 'admin') {
        setPreviewRoleState(null);
        return;
      }
      setPreviewRoleState(nextRole === 'admin' ? null : nextRole);
    },
    [profile?.role]
  );

  const effectiveRole: UserRole =
    profile?.role === 'admin' && previewRole ? previewRole : profile?.role || 'citizen';

  const signInWithEmail = useCallback(async (email: string, password: string) => {
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !password) {
      setAuthError(translate(getActiveLanguage(), 'auth.missingCredentials'));
      return;
    }

    setAuthError(null);
    setAuthNotice(null);
    setSigningIn(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: cleanEmail,
        password,
      });
      if (error) {
        setAuthError(mapSupabaseAuthError(error.message));
      }
    } catch (err: unknown) {
      setAuthError(
        translateErrorMessage(getActiveLanguage(), formatFriendlyError(err)) ||
          translate(getActiveLanguage(), 'auth.signInFailed')
      );
    } finally {
      setSigningIn(false);
    }
  }, []);

  const signUpWithEmail = useCallback(
    async ({ email, password, displayName }: SignUpParams): Promise<{ needsEmailConfirmation: boolean }> => {
      const cleanEmail = email.trim().toLowerCase();
      const cleanName = displayName.trim();
      if (!cleanName || cleanName.length < 2) {
        setAuthError(translate(getActiveLanguage(), 'auth.fullNameRequired'));
        return { needsEmailConfirmation: false };
      }
      if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        setAuthError(translate(getActiveLanguage(), 'auth.invalidEmail'));
        return { needsEmailConfirmation: false };
      }
      if (password.length < 6) {
        setAuthError(translate(getActiveLanguage(), 'auth.passwordTooShort'));
        return { needsEmailConfirmation: false };
      }

      setAuthError(null);
      setAuthNotice(null);
      setSigningIn(true);
      try {
        // Never allow client-supplied roles in signup metadata; server enforces citizen default & invites
        const { data, error } = await supabase.auth.signUp({
          email: cleanEmail,
          password,
          options: {
            data: {
              full_name: cleanName.slice(0, 100),
            },
          },
        });

        if (error) {
          setAuthError(mapSupabaseAuthError(error.message));
          return { needsEmailConfirmation: false };
        }

        if (data.user && !data.session) {
          setAuthNotice(
            translate(getActiveLanguage(), 'auth.signupConfirmNotice', { email: cleanEmail })
          );
          return { needsEmailConfirmation: true };
        }

        return { needsEmailConfirmation: false };
      } catch (err: unknown) {
        setAuthError(
          translateErrorMessage(getActiveLanguage(), formatFriendlyError(err)) ||
            translate(getActiveLanguage(), 'auth.signUpFailed')
        );
        return { needsEmailConfirmation: false };
      } finally {
        setSigningIn(false);
      }
    },
    []
  );

  const getAccessToken = useCallback(async (forceRefresh = false): Promise<string> => {
    if (forceRefresh) {
      const { data, error } = await supabase.auth.refreshSession();
      if (error || !data.session?.access_token) {
        throw new Error(translate(getActiveLanguage(), 'auth.sessionExpired'));
      }
      return data.session.access_token;
    }

    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.access_token) {
      throw new Error(translate(getActiveLanguage(), 'auth.mustSignIn'));
    }

    const expiresAtMs = (data.session.expires_at ?? 0) * 1000;
    if (expiresAtMs > 0 && expiresAtMs - Date.now() < 30_000) {
      const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
      if (!refreshErr && refreshed.session?.access_token) {
        return refreshed.session.access_token;
      }
    }

    return data.session.access_token;
  }, []);

  const refreshProfile = useCallback(async () => {
    const token = await getAccessToken();
    const initResult = await initializeAuthenticatedProfile(token);
    setProfile(initResult.profile);
    setBootstrapNotice(initResult.bootstrapNotice);
  }, [getAccessToken]);

  const connectGmail = useCallback(async (): Promise<string | null> => {
    setConnectingGmail(true);
    try {
      const currentUser = currentUserRef.current;
      const { accessToken, expiresInSec } = await requestGmailSendAccessToken(
        currentUser?.email || undefined
      );
      const uid = currentUser?.id;
      if (uid) {
        cacheGmailTokenInMemory(uid, accessToken, expiresInSec);
      }
      return accessToken;
    } finally {
      setConnectingGmail(false);
    }
  }, [cacheGmailTokenInMemory]);

  const getGmailAccessToken = useCallback((): string | null => {
    const uid = currentUserRef.current?.id;
    if (
      !uid ||
      !cachedGmailAccessToken ||
      cachedGmailTokenUid !== uid ||
      Date.now() >= cachedGmailExpiresAtMs
    ) {
      return null;
    }
    return cachedGmailAccessToken;
  }, []);

  const invalidateGmailToken = useCallback(() => {
    clearExpiryTimer();
    clearCachedGmailToken();
    setGmailConnected(false);
  }, [clearExpiryTimer]);

  const signOut = useCallback(async () => {
    setAuthError(null);
    setAuthNotice(null);
    setBootstrapNotice(null);
    setPreviewRoleState(null);
    loadedProfileUidRef.current = null;
    setProfile(null);
    setUser(null);
    setSession(null);
    clearExpiryTimer();
    clearCachedGmailToken();
    setGmailConnected(false);
    await clearGmailOAuthSession();
    await supabase.auth.signOut();
  }, [clearExpiryTimer]);

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        profile,
        effectiveRole,
        previewRole,
        setPreviewRole,
        loading,
        signingIn,
        connectingGmail,
        gmailConnected,
        authError,
        authNotice,
        clearAuthFeedback,
        bootstrapNotice,
        signInWithEmail,
        signUpWithEmail,
        refreshProfile,
        connectGmail,
        getGmailAccessToken,
        invalidateGmailToken,
        signOut,
        getAccessToken,
        getIdToken: getAccessToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
