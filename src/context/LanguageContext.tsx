import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  getLanguageOption,
  getStoredLanguage,
  isValidLanguageCode,
  setActiveLanguageStore,
  translate,
  translateActivityCategory,
  translateActivityStatus,
  translateAssignmentStatus,
  translateAvailability,
  translateCategory,
  translateDepartmentName,
  translateErrorMessage,
  translateNotificationType,
  translatePriority,
  translateRole,
  translateStatus,
  type LanguageCode,
  type TranslationKey,
  type TranslationParams,
} from '../i18n';
import type {
  ActivityCategory,
  AppNotificationType,
  Assignment,
  IssueCategory,
  IssuePriority,
  ReportStatus,
  UserRole,
  WorkerAvailabilityStatus,
} from '../types/civic';

interface LanguageContextValue {
  language: LanguageCode;
  locale: string;
  setLanguage: (lang: LanguageCode) => void;
  t: (key: TranslationKey, params?: TranslationParams) => string;
  tStatus: (status: ReportStatus | string) => string;
  tPriority: (priority: IssuePriority | string) => string;
  tCategory: (category: IssueCategory | string) => string;
  tRole: (role: UserRole | string) => string;
  tAvailability: (status?: WorkerAvailabilityStatus | string) => string;
  tAssignmentStatus: (status: Assignment['status'] | string) => string;
  tActivityCategory: (category: ActivityCategory | string) => string;
  tActivityStatus: (status: string) => string;
  tNotificationType: (type: AppNotificationType | string) => string;
  tDepartmentName: (departmentIdOrName?: string | null, fallbackName?: string | null) => string;
  tError: (message?: string | null) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<LanguageCode>(() => {
    const initial = getStoredLanguage();
    setActiveLanguageStore(initial);
    return initial;
  });

  useEffect(() => {
    setActiveLanguageStore(language);
    if (typeof document !== 'undefined') {
      document.documentElement.lang = language;
    }
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // Ignore storage persistence errors
    }
  }, [language]);

  // Sync language across browser tabs if changed in another tab
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === LANGUAGE_STORAGE_KEY && isValidLanguageCode(e.newValue)) {
        setLanguageState(e.newValue);
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const setLanguage = useCallback((nextLang: LanguageCode) => {
    const safeLang = isValidLanguageCode(nextLang) ? nextLang : DEFAULT_LANGUAGE;
    setActiveLanguageStore(safeLang);
    setLanguageState(safeLang);
  }, []);

  const locale = getLanguageOption(language).locale;

  const value = useMemo<LanguageContextValue>(
    () => ({
      language,
      locale,
      setLanguage,
      t: (key, params) => translate(language, key, params),
      tStatus: (status) => translateStatus(language, status),
      tPriority: (priority) => translatePriority(language, priority),
      tCategory: (category) => translateCategory(language, category),
      tRole: (role) => translateRole(language, role),
      tAvailability: (status) => translateAvailability(language, status),
      tAssignmentStatus: (status) => translateAssignmentStatus(language, status),
      tActivityCategory: (category) => translateActivityCategory(language, category),
      tActivityStatus: (status) => translateActivityStatus(language, status),
      tNotificationType: (type) => translateNotificationType(language, type),
      tDepartmentName: (departmentIdOrName, fallbackName) =>
        translateDepartmentName(language, departmentIdOrName, fallbackName),
      tError: (message) => translateErrorMessage(language, message),
    }),
    [language, locale, setLanguage]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    throw new Error('useLanguage must be used within LanguageProvider');
  }
  return ctx;
}
