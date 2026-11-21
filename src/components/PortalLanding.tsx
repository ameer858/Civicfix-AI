import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  BarChart3,
  Building2,
  Calendar,
  CheckCircle2,
  Clock,
  FileText,
  HeartHandshake,
  Loader2,
  Lock,
  Mail,
  MapPin,
  Search,
  ShieldCheck,
  User as UserIcon,
  Wrench,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import {
  computePublicTransparencyOverview,
  fetchPublicTransparencyViaApi,
  trackPublicReportByCode,
} from '../lib/civicService';
import civicHeroImg from '../assets/images/civic_city_infrastructure_1794561758501.jpg';
import { LanguageSelector } from './LanguageSelector';
import { PriorityIndicator, StatusIndicator } from './StatusBadge';
import { formatTimestamp } from './WorkflowTimeline';
import {
  WORKFLOW_STAGES,
  type PublicReportSummary,
  type PublicTransparencyOverview,
  type ReportStatus,
} from '../types/civic';

export function PortalLanding() {
  const {
    signInWithEmail,
    signUpWithEmail,
    authError,
    authNotice,
    clearAuthFeedback,
    signingIn,
  } = useAuth();
  const {
    t,
    tCategory,
    tStatus,
    tActivityCategory,
    tActivityStatus,
    tDepartmentName,
    tError,
    locale,
  } = useLanguage();
  const [imageFailed, setImageFailed] = useState(false);

  // Supabase Email/Password Authentication UI state
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authConfirmPassword, setAuthConfirmPassword] = useState('');
  const [authDisplayName, setAuthDisplayName] = useState('');
  const [localAuthError, setLocalAuthError] = useState<string | null>(null);

  // Public Transparency overview (Zero PII)
  const [transparency, setTransparency] = useState<PublicTransparencyOverview | null>(null);
  const [transparencyLoading, setTransparencyLoading] = useState(true);

  // Public Tracking ID lookup
  const [trackingQuery, setTrackingQuery] = useState('');
  const [trackingLoading, setTrackingLoading] = useState(false);
  const [trackingError, setTrackingError] = useState<string | null>(null);
  const [trackedReport, setTrackedReport] = useState<PublicReportSummary | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const switchAuthMode = (nextMode: 'signin' | 'signup') => {
    setAuthMode(nextMode);
    setLocalAuthError(null);
    clearAuthFeedback();
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalAuthError(null);

    const trimmedEmail = authEmail.trim();
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setLocalAuthError(t('auth.invalidEmail'));
      return;
    }
    if (!authPassword || authPassword.length < 6) {
      setLocalAuthError(t('auth.passwordTooShort'));
      return;
    }

    if (authMode === 'signup') {
      if (authDisplayName.trim().length < 2) {
        setLocalAuthError(t('auth.fullNameRequired'));
        return;
      }
      if (authPassword !== authConfirmPassword) {
        setLocalAuthError(t('auth.passwordsMismatch'));
        return;
      }
      const res = await signUpWithEmail({
        email: trimmedEmail,
        password: authPassword,
        displayName: authDisplayName.trim(),
      });
      if (res.needsEmailConfirmation) {
        setAuthMode('signin');
        setAuthPassword('');
        setAuthConfirmPassword('');
      }
      return;
    }

    await signInWithEmail(trimmedEmail, authPassword);
  };

  useEffect(() => {
    let active = true;

    async function loadTransparency() {
      setTransparencyLoading(true);
      try {
        const apiData = await fetchPublicTransparencyViaApi();
        if (active) {
          setTransparency(apiData);
        }
      } catch {
        if (active) {
          setTransparency(computePublicTransparencyOverview([], []));
        }
      } finally {
        if (active) setTransparencyLoading(false);
      }
    }

    void loadTransparency();
    return () => {
      active = false;
    };
  }, []);

  const handleTrackLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    setTrackingError(null);
    setHasSearched(true);
    const trimmed = trackingQuery.trim();
    if (!trimmed) {
      setTrackingError(t('landing.trackEmptyError'));
      setTrackedReport(null);
      return;
    }

    try {
      setTrackingLoading(true);
      const result = await trackPublicReportByCode(trimmed);
      setTrackedReport(result);
      if (!result) {
        setTrackingError(t('landing.trackNotFound', { code: trimmed.toUpperCase() }));
      }
    } catch (err: unknown) {
      setTrackedReport(null);
      setTrackingError(
        err instanceof Error ? tError(err.message) : t('landing.trackLookupFailed')
      );
    } finally {
      setTrackingLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Three-Zone Top Bar */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3.5 flex items-center justify-between gap-2 sm:gap-4">
          <a href="#top" className="text-base sm:text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            CivicFix AI
          </a>

          <nav className="hidden lg:flex items-center gap-5 text-sm text-slate-600">
            <a href="#roles" className="hover:text-slate-900 transition-colors whitespace-nowrap">
              {t('landing.navDashboards')}
            </a>
            <a href="#transparency" className="hover:text-slate-900 transition-colors whitespace-nowrap">
              {t('landing.navTransparency')}
            </a>
            <a href="#track" className="hover:text-slate-900 transition-colors whitespace-nowrap">
              {t('landing.navTrack')}
            </a>
            <a href="#workflow" className="hover:text-slate-900 transition-colors whitespace-nowrap">
              {t('landing.navWorkflow')}
            </a>
            <a href="#ai-triage" className="hover:text-slate-900 transition-colors whitespace-nowrap">
              {t('landing.navAiTriage')}
            </a>
          </nav>

          <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
            <LanguageSelector />
            <a
              href="#auth-panel"
              onClick={() => switchAuthMode('signin')}
              className="px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg bg-blue-700 text-white text-xs sm:text-sm font-medium hover:bg-blue-800 transition-colors whitespace-nowrap shrink-0"
            >
              {t('landing.signIn')}
            </a>
          </div>
        </div>
      </header>

      <main id="top" className="flex-1">
        {/* Hero Split Section */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 py-10 lg:py-16">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
            <div className="lg:col-span-7 flex flex-col justify-center space-y-6">
              <div className="space-y-4">
                <p className="text-xs font-medium text-blue-700 tracking-wide">
                  {t('landing.heroEyebrow')}
                </p>
                <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-slate-900 [text-wrap:balance] leading-[1.18]">
                  {t('landing.heroTitle')}
                </h1>
                <p className="text-base text-slate-600 max-w-2xl leading-relaxed">
                  {t('landing.heroSubtitle')}
                </p>
              </div>

              {/* Supabase Email / Password Authentication Card */}
              <div
                id="auth-panel"
                className="bg-white border border-slate-200 rounded-xl p-5 max-w-xl shadow-xs space-y-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
                  <div className="inline-flex rounded-lg bg-slate-100 p-1">
                    <button
                      type="button"
                      onClick={() => switchAuthMode('signin')}
                      className={`px-3.5 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                        authMode === 'signin'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {t('landing.signIn')}
                    </button>
                    <button
                      type="button"
                      onClick={() => switchAuthMode('signup')}
                      className={`px-3.5 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                        authMode === 'signup'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {t('landing.createAccount')}
                    </button>
                  </div>
                  <span className="text-[11px] font-medium text-slate-500">
                    {t('landing.authMethodBadge')}
                  </span>
                </div>

                {(localAuthError || authError) && (
                  <div
                    role="alert"
                    className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800"
                  >
                    {tError(localAuthError || authError)}
                  </div>
                )}

                {authNotice && (
                  <div
                    role="status"
                    className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900"
                  >
                    {authNotice}
                  </div>
                )}

                <form onSubmit={handleAuthSubmit} className="space-y-3">
                  {authMode === 'signup' && (
                    <div>
                      <label
                        htmlFor="auth-fullname"
                        className="block text-xs font-medium text-slate-700 mb-1"
                      >
                        {t('landing.fullName')}
                      </label>
                      <div className="relative">
                        <UserIcon
                          className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2"
                          aria-hidden="true"
                        />
                        <input
                          id="auth-fullname"
                          type="text"
                          required
                          autoComplete="name"
                          value={authDisplayName}
                          onChange={(e) => setAuthDisplayName(e.target.value)}
                          placeholder={t('landing.fullNamePlaceholder')}
                          className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                        />
                      </div>
                    </div>
                  )}

                  <div>
                    <label
                      htmlFor="auth-email"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      {t('landing.emailAddress')}
                    </label>
                    <div className="relative">
                      <Mail
                        className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2"
                        aria-hidden="true"
                      />
                      <input
                        id="auth-email"
                        type="email"
                        required
                        autoComplete="email"
                        value={authEmail}
                        onChange={(e) => setAuthEmail(e.target.value)}
                        placeholder={t('landing.emailPlaceholder')}
                        className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                      />
                    </div>
                  </div>

                  <div className={authMode === 'signup' ? 'grid grid-cols-1 sm:grid-cols-2 gap-3' : ''}>
                    <div>
                      <label
                        htmlFor="auth-password"
                        className="block text-xs font-medium text-slate-700 mb-1"
                      >
                        {t('landing.password')}
                      </label>
                      <div className="relative">
                        <Lock
                          className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2"
                          aria-hidden="true"
                        />
                        <input
                          id="auth-password"
                          type="password"
                          required
                          minLength={6}
                          autoComplete={authMode === 'signin' ? 'current-password' : 'new-password'}
                          value={authPassword}
                          onChange={(e) => setAuthPassword(e.target.value)}
                          placeholder={t('landing.passwordPlaceholder')}
                          className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                        />
                      </div>
                    </div>

                    {authMode === 'signup' && (
                      <div>
                        <label
                          htmlFor="auth-confirm-password"
                          className="block text-xs font-medium text-slate-700 mb-1"
                        >
                          {t('landing.confirmPassword')}
                        </label>
                        <div className="relative">
                          <Lock
                            className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2"
                            aria-hidden="true"
                          />
                          <input
                            id="auth-confirm-password"
                            type="password"
                            required
                            minLength={6}
                            autoComplete="new-password"
                            value={authConfirmPassword}
                            onChange={(e) => setAuthConfirmPassword(e.target.value)}
                            placeholder={t('landing.confirmPasswordPlaceholder')}
                            className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5 pt-1">
                    <button
                      type="submit"
                      disabled={signingIn}
                      className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-blue-700 text-white text-sm font-medium hover:bg-blue-800 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
                    >
                      {signingIn ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                          <span>
                            {authMode === 'signin'
                              ? t('landing.signingIn')
                              : t('landing.creatingAccount')}
                          </span>
                        </>
                      ) : (
                        <>
                          <span>
                            {authMode === 'signin'
                              ? t('landing.signIn')
                              : t('landing.createCitizenAccount')}
                          </span>
                          <ArrowRight className="w-4 h-4" aria-hidden="true" />
                        </>
                      )}
                    </button>

                    <a
                      href="#track"
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-slate-300 bg-white text-slate-800 text-sm font-medium hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                    >
                      <Search className="w-4 h-4 text-blue-700" aria-hidden="true" />
                      <span>{t('landing.trackById')}</span>
                    </a>

                    <a
                      href="#transparency"
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-slate-300 bg-white text-slate-800 text-sm font-medium hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                    >
                      <span>{t('landing.navTransparency')}</span>
                    </a>
                  </div>
                </form>

                <p className="text-[11px] text-slate-500 leading-relaxed">
                  {t('landing.registrationNote')}
                </p>
              </div>

              <p className="text-xs text-slate-500">
                {t('landing.authFooterNote')}
              </p>
            </div>

            <div className="lg:col-span-5">
              <div className="h-full min-h-[280px] rounded-xl border border-slate-200 bg-white overflow-hidden">
                {!imageFailed ? (
                  <img
                    src={civicHeroImg}
                    alt={t('landing.heroImageAlt')}
                    onError={() => setImageFailed(true)}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full min-h-[280px] bg-slate-100 flex flex-col items-center justify-center p-6 text-center">
                    <MapPin className="w-8 h-8 text-slate-400 mb-2" aria-hidden="true" />
                    <p className="text-sm font-medium text-slate-700">
                      {t('landing.heroFallbackTitle')}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Full-width 4-column summary row below hero split */}
          <div id="roles" className="mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
              <FileText className="w-5 h-5 text-blue-700" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-slate-900">{t('landing.roleCitizenTitle')}</h2>
              <p className="text-xs text-slate-600 leading-relaxed">
                {t('landing.roleCitizenDesc')}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
              <ShieldCheck className="w-5 h-5 text-blue-700" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-slate-900">{t('landing.roleAdminTitle')}</h2>
              <p className="text-xs text-slate-600 leading-relaxed">
                {t('landing.roleAdminDesc')}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
              <CheckCircle2 className="w-5 h-5 text-blue-700" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-slate-900">{t('landing.roleOfficerTitle')}</h2>
              <p className="text-xs text-slate-600 leading-relaxed">
                {t('landing.roleOfficerDesc')}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
              <Wrench className="w-5 h-5 text-blue-700" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-slate-900">{t('landing.roleWorkerTitle')}</h2>
              <p className="text-xs text-slate-600 leading-relaxed">
                {t('landing.roleWorkerDesc')}
              </p>
            </div>
          </div>
        </section>

        {/* Public Complaint Tracking by Tracking ID */}
        <section id="track" className="border-t border-slate-200 bg-white py-12">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 space-y-6">
            <div className="max-w-2xl space-y-1.5">
              <p className="text-xs font-semibold text-blue-700">{t('landing.trackEyebrow')}</p>
              <h2 className="text-2xl font-semibold text-slate-900 tracking-tight">
                {t('landing.trackTitle')}
              </h2>
              <p className="text-sm text-slate-600">
                {t('landing.trackSubtitle')}
              </p>
            </div>

            <form onSubmit={handleTrackLookup} className="flex flex-wrap items-center gap-3 max-w-xl">
              <div className="relative flex-1 min-w-[220px]">
                <Search
                  className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2"
                  aria-hidden="true"
                />
                <input
                  type="text"
                  value={trackingQuery}
                  onChange={(e) => setTrackingQuery(e.target.value)}
                  placeholder={t('landing.trackPlaceholder')}
                  aria-label={t('common.trackingId')}
                  className="w-full pl-9 pr-3 py-2.5 rounded-lg border border-slate-300 bg-white text-sm font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
              <button
                type="submit"
                disabled={trackingLoading}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-blue-700 text-white text-sm font-medium hover:bg-blue-800 disabled:opacity-50"
              >
                {trackingLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    <span>{t('common.searching')}</span>
                  </>
                ) : (
                  <span>{t('landing.trackButton')}</span>
                )}
              </button>
            </form>

            {trackingError && (
              <div
                role="alert"
                className="p-3.5 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-800 max-w-2xl"
              >
                {trackingError}
              </div>
            )}

            {hasSearched && trackedReport && (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-6 space-y-4 max-w-3xl">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-mono tabular-nums text-blue-700 font-semibold">
                      {trackedReport.trackingCode}
                    </p>
                    <h3 className="text-lg font-semibold text-slate-900 mt-0.5">
                      {trackedReport.title}
                    </h3>
                    <p className="text-xs text-slate-600 mt-1">
                      {tCategory(trackedReport.category)} · {trackedReport.areaLabel}
                      {trackedReport.departmentName
                        ? ` · ${tDepartmentName(trackedReport.departmentId, trackedReport.departmentName)}`
                        : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <PriorityIndicator priority={trackedReport.priority} />
                    <StatusIndicator status={trackedReport.status} />
                  </div>
                </div>

                {trackedReport.resolutionSummary && (
                  <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-950">
                    <span className="font-semibold">{t('landing.resolutionSummary')} </span>
                    <span>{trackedReport.resolutionSummary}</span>
                  </div>
                )}

                {trackedReport.timelineEvents && trackedReport.timelineEvents.length > 0 && (
                  <div className="space-y-2 pt-2 border-t border-slate-200">
                    <p className="text-xs font-semibold text-slate-700">
                      {t('landing.publicActivityTimeline')}
                    </p>
                    <ul className="space-y-2">
                      {trackedReport.timelineEvents.map((ev, idx) => (
                        <li
                          key={`${ev.stage}-${idx}`}
                          className="flex items-start justify-between gap-4 text-xs bg-white border border-slate-200 rounded-lg px-3 py-2"
                        >
                          <div>
                            <span className="font-semibold text-slate-900">
                              {tStatus(ev.stage as ReportStatus)}
                            </span>
                            <span className="text-slate-600"> — {ev.summary}</span>
                          </div>
                          <span className="font-mono tabular-nums text-slate-400 shrink-0">
                            {formatTimestamp(ev.timestampIso, locale)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Public Transparency Dashboard */}
        <section id="transparency" className="border-t border-slate-200 bg-slate-50 py-12">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="space-y-1">
                <p className="text-xs font-semibold text-blue-700">{t('landing.transparencyEyebrow')}</p>
                <h2 className="text-2xl font-semibold text-slate-900 tracking-tight">
                  {t('landing.transparencyTitle')}
                </h2>
                <p className="text-sm text-slate-600">
                  {t('landing.transparencySubtitle')}
                </p>
              </div>
            </div>

            {transparencyLoading && !transparency ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {[1, 2, 3, 4].map((n) => (
                  <div key={n} className="bg-white border border-slate-200 rounded-xl p-5 animate-pulse space-y-2">
                    <div className="h-3 w-28 bg-slate-200 rounded" />
                    <div className="h-7 w-16 bg-slate-200 rounded" />
                  </div>
                ))}
              </div>
            ) : transparency ? (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                  <div className="bg-white border border-slate-200 rounded-xl p-5">
                    <p className="text-xs text-slate-500">{t('landing.kpiTotalSubmitted')}</p>
                    <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-slate-900">
                      {transparency.totalSubmitted}
                    </p>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-xl p-5">
                    <p className="text-xs text-slate-500">{t('landing.kpiUnderReview')}</p>
                    <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-amber-700">
                      {transparency.underReview}
                    </p>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-xl p-5">
                    <p className="text-xs text-slate-500">{t('landing.kpiInProgress')}</p>
                    <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-blue-700">
                      {transparency.inProgress}
                    </p>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-xl p-5">
                    <p className="text-xs text-slate-500">{t('landing.kpiResolved')}</p>
                    <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-emerald-700">
                      {transparency.resolved}
                    </p>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-xl p-5">
                    <p className="text-xs text-slate-500">{t('landing.kpiAvgResolution')}</p>
                    <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-slate-900">
                      {transparency.overallAvgResolutionHours !== null
                        ? `${transparency.overallAvgResolutionHours}h`
                        : '—'}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                  {/* Department Performance */}
                  <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
                    <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-2">
                      <Building2 className="w-4 h-4 text-blue-700" aria-hidden="true" />
                      <h3 className="text-sm font-semibold text-slate-900">
                        {t('landing.deptPerfTitle')}
                      </h3>
                    </div>
                    {transparency.departmentPerformance.length === 0 ? (
                      <div className="p-6 text-xs text-slate-500">
                        {t('landing.deptPerfEmpty')}
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse text-xs">
                          <thead>
                            <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                              <th className="py-2.5 px-4 font-medium">{t('common.department')}</th>
                              <th className="py-2.5 px-3 font-medium text-right">{t('landing.colTotal')}</th>
                              <th className="py-2.5 px-3 font-medium text-right">{t('landing.colInProgress')}</th>
                              <th className="py-2.5 px-3 font-medium text-right">{t('landing.colResolved')}</th>
                              <th className="py-2.5 px-4 font-medium text-right">{t('landing.colAvgResolution')}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-200">
                            {transparency.departmentPerformance.map((d) => (
                              <tr key={d.departmentId}>
                                <td className="py-2.5 px-4 font-medium text-slate-900">
                                  {tDepartmentName(d.departmentId, d.departmentName)}
                                </td>
                                <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                                  {d.total}
                                </td>
                                <td className="py-2.5 px-3 text-right font-mono tabular-nums text-blue-700">
                                  {d.inProgress}
                                </td>
                                <td className="py-2.5 px-3 text-right font-mono tabular-nums text-emerald-700">
                                  {d.resolved}
                                </td>
                                <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-600">
                                  {d.avgResolutionHours !== null ? `${d.avgResolutionHours}h` : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  {/* Resolution History */}
                  <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl overflow-hidden">
                    <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-2">
                      <Clock className="w-4 h-4 text-emerald-700" aria-hidden="true" />
                      <h3 className="text-sm font-semibold text-slate-900">
                        {t('landing.recentResolutionsTitle')}
                      </h3>
                    </div>
                    {transparency.resolutionHistory.length === 0 ? (
                      <div className="p-6 text-xs text-slate-500">
                        {t('landing.recentResolutionsEmpty')}
                      </div>
                    ) : (
                      <ul className="divide-y divide-slate-200">
                        {transparency.resolutionHistory.slice(0, 6).map((item) => (
                          <li key={item.id} className="px-5 py-3 space-y-1">
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <span className="font-mono tabular-nums font-medium text-blue-700">
                                {item.trackingCode}
                              </span>
                              <StatusIndicator status={item.status} />
                            </div>
                            <p className="text-xs font-medium text-slate-900 truncate">{item.title}</p>
                            <p className="text-[11px] text-slate-500 truncate">
                              {item.departmentName
                                ? tDepartmentName(item.departmentId, item.departmentName)
                                : t('common.municipalTeam')}{' '}
                              · {item.areaLabel}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                {/* Monthly Complaint Analytics & Recent Public Updates */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                  <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl overflow-hidden">
                    <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-2">
                      <BarChart3 className="w-4 h-4 text-blue-700" aria-hidden="true" />
                      <h3 className="text-sm font-semibold text-slate-900">
                        {t('landing.monthlyAnalyticsTitle')}
                      </h3>
                    </div>
                    {!transparency.monthlyTrends || transparency.monthlyTrends.length === 0 ? (
                      <div className="p-6 text-xs text-slate-500">
                        {t('landing.monthlyAnalyticsEmpty')}
                      </div>
                    ) : (
                      <div className="p-5 space-y-3">
                        {(() => {
                          const maxVol = Math.max(
                            1,
                            ...transparency.monthlyTrends.map((m) => Math.max(m.submitted, m.resolved))
                          );
                          return transparency.monthlyTrends.map((m) => (
                            <div key={m.key} className="space-y-1">
                              <div className="flex items-center justify-between text-xs gap-2">
                                <span className="font-medium text-slate-800">{m.label}</span>
                                <span className="font-mono tabular-nums text-slate-600">
                                  {t('landing.monthlySummary', {
                                    submitted: m.submitted,
                                    resolved: m.resolved,
                                  })}
                                </span>
                              </div>
                              <div className="grid grid-cols-2 gap-1.5">
                                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-blue-600 rounded-full"
                                    style={{ width: `${Math.round((m.submitted / maxVol) * 100)}%` }}
                                  />
                                </div>
                                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-emerald-600 rounded-full"
                                    style={{ width: `${Math.round((m.resolved / maxVol) * 100)}%` }}
                                  />
                                </div>
                              </div>
                            </div>
                          ));
                        })()}
                      </div>
                    )}
                  </div>

                  <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
                    <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-2">
                      <FileText className="w-4 h-4 text-blue-700" aria-hidden="true" />
                      <h3 className="text-sm font-semibold text-slate-900">
                        {t('landing.recentUpdatesTitle')}
                      </h3>
                    </div>
                    {!transparency.recentPublicUpdates || transparency.recentPublicUpdates.length === 0 ? (
                      <div className="p-6 text-xs text-slate-500">
                        {t('landing.recentUpdatesEmpty')}
                      </div>
                    ) : (
                      <ul className="divide-y divide-slate-200">
                        {transparency.recentPublicUpdates.slice(0, 6).map((upd) => (
                          <li key={`${upd.reportId}-${upd.stage}`} className="px-5 py-3 space-y-1">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="font-mono tabular-nums font-medium text-blue-700">
                                  {upd.trackingCode}
                                </span>
                                <span className="font-medium text-slate-900 truncate">
                                  {upd.title}
                                </span>
                              </div>
                              <StatusIndicator status={upd.status} />
                            </div>
                            <p className="text-xs text-slate-600 line-clamp-2">{upd.summary}</p>
                            <p className="text-[11px] text-slate-400">
                              {tDepartmentName(upd.departmentName, upd.departmentName)} · {upd.areaLabel} ·{' '}
                              {formatTimestamp(upd.timestampIso, locale)}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                {/* Public NGO & Volunteer Civic Activities */}
                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <HeartHandshake className="w-4 h-4 text-blue-700" aria-hidden="true" />
                      <h3 className="text-sm font-semibold text-slate-900">
                        {t('landing.communityTitle')}
                      </h3>
                    </div>
                    <span className="text-[11px] text-slate-500">
                      {t('landing.communityHint')}
                    </span>
                  </div>
                  {!transparency.publicActivities || transparency.publicActivities.length === 0 ? (
                    <div className="p-6 text-xs text-slate-500">
                      {t('landing.communityEmpty')}
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-5">
                      {transparency.publicActivities.slice(0, 6).map((act) => (
                        <div
                          key={act.id}
                          className="border border-slate-200 rounded-lg p-4 bg-slate-50/70 space-y-2 flex flex-col justify-between"
                        >
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between gap-2 text-[11px]">
                              <span className="font-medium text-blue-700">
                                {tActivityCategory(act.category)}
                              </span>
                              <span
                                className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                  act.status === 'completed'
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : 'bg-blue-100 text-blue-800'
                                }`}
                              >
                                {tActivityStatus(act.status)}
                              </span>
                            </div>
                            <h4 className="text-sm font-semibold text-slate-900 line-clamp-1">
                              {act.title}
                            </h4>
                            <p className="text-xs text-slate-600 line-clamp-2">{act.description}</p>
                            {act.status === 'completed' && act.completionSummary && (
                              <p className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-2 py-1 line-clamp-2">
                                {t('landing.outcomeLabel')} {act.completionSummary}
                              </p>
                            )}
                          </div>
                          <div className="pt-2 border-t border-slate-200 text-[11px] text-slate-500 space-y-0.5">
                            <p className="font-medium text-slate-700 truncate">{act.ngoName}</p>
                            <p className="flex items-center gap-1 truncate">
                              <MapPin className="w-3 h-3 shrink-0" aria-hidden="true" />
                              <span>{act.locationLabel}</span>
                            </p>
                            <p className="flex items-center justify-between gap-2">
                              <span className="inline-flex items-center gap-1">
                                <Calendar className="w-3 h-3 shrink-0" aria-hidden="true" />
                                <span>{formatTimestamp(act.scheduledDateIso, locale)}</span>
                              </span>
                              <span className="font-mono tabular-nums text-slate-700">
                                {t('landing.volunteersCount', {
                                  joined: act.participantCount,
                                  max: act.maxVolunteers,
                                })}
                              </span>
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </div>
        </section>

        {/* Workflow & AI Transparency Section */}
        <section id="workflow" className="border-t border-slate-200 bg-white py-12">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 grid grid-cols-1 lg:grid-cols-2 gap-10">
            <div className="space-y-3">
              <h2 className="text-xl font-semibold text-slate-900">
                {t('landing.workflowTitle')}
              </h2>
              <p className="text-sm text-slate-600 leading-relaxed">
                {t('landing.workflowDesc')}
              </p>
              <p className="text-xs font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3.5 leading-relaxed">
                {WORKFLOW_STAGES.map((stage) => tStatus(stage)).join(' → ')}
              </p>
            </div>

            <div id="ai-triage" className="space-y-3">
              <h2 className="text-xl font-semibold text-slate-900">
                {t('landing.aiTriageTitle')}
              </h2>
              <p className="text-sm text-slate-600 leading-relaxed">
                {t('landing.aiTriageDesc')}
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-white py-5">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-500">
          <span>CivicFix AI</span>
          <span>{t('landing.footerSecurity')}</span>
        </div>
      </footer>
    </div>
  );
}
