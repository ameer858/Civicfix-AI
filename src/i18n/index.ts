import { en, type TranslationKey } from './en';
import { ml } from './ml';
import { ta } from './ta';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_OPTIONS,
  LANGUAGE_STORAGE_KEY,
  type LanguageCode,
  type LanguageOption,
  type TranslationParams,
} from './types';
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

export {
  DEFAULT_LANGUAGE,
  LANGUAGE_OPTIONS,
  LANGUAGE_STORAGE_KEY,
  type LanguageCode,
  type LanguageOption,
  type TranslationKey,
  type TranslationParams,
};

export const translations: Record<LanguageCode, Record<TranslationKey, string>> = {
  en,
  ml,
  ta,
};

let activeLanguageStore: LanguageCode = DEFAULT_LANGUAGE;

export function isValidLanguageCode(value: unknown): value is LanguageCode {
  return value === 'en' || value === 'ml' || value === 'ta';
}

export function getStoredLanguage(): LanguageCode {
  if (typeof window === 'undefined') return DEFAULT_LANGUAGE;
  try {
    const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (isValidLanguageCode(saved)) {
      return saved;
    }
  } catch {
    // Ignore storage read errors in restricted environments
  }
  return DEFAULT_LANGUAGE;
}

export function setActiveLanguageStore(lang: LanguageCode): void {
  activeLanguageStore = lang;
}

export function getActiveLanguage(): LanguageCode {
  return activeLanguageStore;
}

export function getLanguageOption(lang: LanguageCode): LanguageOption {
  return LANGUAGE_OPTIONS.find((opt) => opt.code === lang) || LANGUAGE_OPTIONS[0];
}

export function translate(
  lang: LanguageCode,
  key: TranslationKey,
  params?: TranslationParams
): string {
  const dict = translations[lang] || translations.en;
  let text = dict[key] ?? translations.en[key] ?? key;

  if (params) {
    for (const [paramKey, paramValue] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(paramValue));
    }
  }

  return text;
}

export function translateStatus(lang: LanguageCode, status: ReportStatus | string): string {
  const key = `status.${status}` as TranslationKey;
  if (key in translations.en) {
    return translate(lang, key);
  }
  return status;
}

export function translatePriority(lang: LanguageCode, priority: IssuePriority | string): string {
  const key = `priority.${priority}` as TranslationKey;
  if (key in translations.en) {
    return translate(lang, key);
  }
  return priority;
}

export function translateCategory(lang: LanguageCode, category: IssueCategory | string): string {
  const key = `category.${category}` as TranslationKey;
  if (key in translations.en) {
    return translate(lang, key);
  }
  return category;
}

export function translateRole(lang: LanguageCode, role: UserRole | string): string {
  const key = `role.${role}` as TranslationKey;
  if (key in translations.en) {
    return translate(lang, key);
  }
  return role;
}

export function translateAvailability(
  lang: LanguageCode,
  status: WorkerAvailabilityStatus | string | undefined
): string {
  if (!status) return translate(lang, 'availability.available');
  const key = `availability.${status}` as TranslationKey;
  if (key in translations.en) {
    return translate(lang, key);
  }
  return status;
}

export function translateAssignmentStatus(
  lang: LanguageCode,
  status: Assignment['status'] | string
): string {
  const key = `assignmentStatus.${status}` as TranslationKey;
  if (key in translations.en) {
    return translate(lang, key);
  }
  return status;
}

export function translateActivityCategory(
  lang: LanguageCode,
  category: ActivityCategory | string
): string {
  const key = `activityCategory.${category}` as TranslationKey;
  if (key in translations.en) {
    return translate(lang, key);
  }
  return category;
}

export function translateActivityStatus(lang: LanguageCode, status: string): string {
  const key = `activityStatus.${status}` as TranslationKey;
  if (key in translations.en) {
    return translate(lang, key);
  }
  return status;
}

export function translateNotificationType(
  lang: LanguageCode,
  type: AppNotificationType | string
): string {
  const key = `notifType.${type}` as TranslationKey;
  if (key in translations.en) {
    return translate(lang, key);
  }
  return type;
}

const CANONICAL_DEPARTMENT_NAME_MAP: Record<string, TranslationKey> = {
  dept_roads_infrastructure: 'dept.dept_roads_infrastructure',
  'public works department': 'dept.dept_roads_infrastructure',
  'roads & infrastructure': 'dept.dept_roads_infrastructure',
  'roads & public works': 'dept.dept_roads_infrastructure',
  'public works & roads': 'dept.dept_roads_infrastructure',
  dept_sanitation: 'dept.dept_sanitation',
  'sanitation department': 'dept.dept_sanitation',
  'sanitation & solid waste': 'dept.dept_sanitation',
  'sanitation & waste management': 'dept.dept_sanitation',
  dept_electrical: 'dept.dept_electrical',
  'electricity department': 'dept.dept_electrical',
  'electrical & streetlighting': 'dept.dept_electrical',
  'street lighting & electrical': 'dept.dept_electrical',
  dept_water_supply: 'dept.dept_water_supply',
  'water supply department': 'dept.dept_water_supply',
  'water supply & pipelines': 'dept.dept_water_supply',
  dept_drainage: 'dept.dept_drainage',
  'drainage department': 'dept.dept_drainage',
  'drainage & stormwater': 'dept.dept_drainage',
  dept_parks: 'dept.dept_parks',
  'parks department': 'dept.dept_parks',
  'parks & public spaces': 'dept.dept_parks',
};

export function translateDepartmentName(
  lang: LanguageCode,
  departmentIdOrName?: string | null,
  fallbackName?: string | null
): string {
  const idKey = (departmentIdOrName || '').trim().toLowerCase();
  if (idKey && CANONICAL_DEPARTMENT_NAME_MAP[idKey]) {
    return translate(lang, CANONICAL_DEPARTMENT_NAME_MAP[idKey]);
  }
  const nameKey = (fallbackName || '').trim().toLowerCase();
  if (nameKey && CANONICAL_DEPARTMENT_NAME_MAP[nameKey]) {
    return translate(lang, CANONICAL_DEPARTMENT_NAME_MAP[nameKey]);
  }
  return fallbackName || departmentIdOrName || translate(lang, 'common.unassigned');
}

export function translateErrorMessage(lang: LanguageCode, message?: string | null): string {
  if (!message) return translate(lang, 'error.generic');
  const lower = message.toLowerCase();

  if (lower.includes('invalid login credentials') || lower.includes('incorrect email address or password')) {
    return translate(lang, 'auth.invalidCredentials');
  }
  if (lower.includes('email not confirmed') || lower.includes('confirm your email address')) {
    return translate(lang, 'auth.emailNotConfirmed');
  }
  if (lower.includes('user already registered') || lower.includes('already exists')) {
    return translate(lang, 'auth.userExists');
  }
  if (lower.includes('password should be at least') || lower.includes('password must be at least 6')) {
    return translate(lang, 'auth.passwordTooShort');
  }
  if (lower.includes('rate limit') || lower.includes('too many')) {
    return translate(lang, 'auth.rateLimit');
  }
  if (lower.includes('deactivated by an administrator')) {
    return translate(lang, 'auth.accountDeactivated');
  }
  if (lower.includes('session has expired')) {
    return translate(lang, 'auth.sessionExpired');
  }
  if (lower.includes('must be signed in')) {
    return translate(lang, 'auth.mustSignIn');
  }
  if (lower.includes('popup') && lower.includes('blocked')) {
    return translate(lang, 'error.popupBlocked');
  }
  if (lower.includes('popup') && (lower.includes('closed') || lower.includes('cancel'))) {
    return translate(lang, 'error.popupClosed');
  }
  if (
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('network error') ||
    lower.includes('network connection')
  ) {
    return translate(lang, 'error.network');
  }
  if (lower.includes('permission denied') || lower.includes('forbidden') || lower.includes('unauthorized')) {
    return translate(lang, 'error.permissionDenied');
  }

  return message;
}
