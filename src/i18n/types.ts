export type LanguageCode = 'en' | 'ml' | 'ta';

export interface LanguageOption {
  code: LanguageCode;
  nativeLabel: string;
  englishLabel: string;
  shortLabel: string;
  locale: string;
}

export const DEFAULT_LANGUAGE: LanguageCode = 'en';
export const LANGUAGE_STORAGE_KEY = 'civicfix_language';

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  {
    code: 'en',
    nativeLabel: 'English',
    englishLabel: 'English',
    shortLabel: 'EN',
    locale: 'en-IN',
  },
  {
    code: 'ml',
    nativeLabel: 'മലയാളം',
    englishLabel: 'Malayalam',
    shortLabel: 'മലയാളം',
    locale: 'ml-IN',
  },
  {
    code: 'ta',
    nativeLabel: 'தமிழ்',
    englishLabel: 'Tamil',
    shortLabel: 'தமிழ்',
    locale: 'ta-IN',
  },
];

export type TranslationParams = Record<string, string | number>;
export type { TranslationKey } from './en';
