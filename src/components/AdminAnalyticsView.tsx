import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Building2,
  CheckCircle2,
  CopyCheck,
  Download,
  FileText,
  Gauge,
  Loader2,
  MapPin,
  Plus,
  Printer,
  Shield,
  Sparkles,
  Star,
  TrendingUp,
  Users,
} from 'lucide-react';
import {
  adminSaveDepartment,
  adminUpdateUserRole,
  detectDuplicatesViaServer,
  generateTrendIntelligenceViaServer,
} from '../lib/civicService';
import {
  buildAnonymizedTrendDigest,
  computeCitywideDuplicatePairs,
  computeDashboardIntelligence,
  computeDepartmentPerformance,
  computePriorityRecommendation,
  filterGovernanceReports,
  formatDurationHours,
  generateGovernanceCsv,
} from '../lib/intelligenceEngine';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { HotspotMapView } from './HotspotMapView';
import { PriorityIndicator, StatusIndicator } from './StatusBadge';
import { formatTimestamp } from './WorkflowTimeline';
import {
  CATEGORY_LABELS,
  STATUS_LABELS,
  type AiAnalysis,
  type Assignment,
  type CitizenFeedback,
  type CivicReport,
  type Department,
  type DuplicateCandidate,
  type DuplicateReviewDecision,
  type IssueCategory,
  type ReportStatus,
  type ReportUpdate,
  type TrendIntelligenceResult,
  type UserProfile,
  type UserRole,
} from '../types/civic';

type AdminSubTab =
  | 'overview'
  | 'sla'
  | 'hotspots'
  | 'duplicates'
  | 'ai_trends'
  | 'priority'
  | 'governance'
  | 'departments'
  | 'users';

interface AdminAnalyticsViewProps {
  reports: CivicReport[];
  departments: Department[];
  users: UserProfile[];
  feedbacks?: CitizenFeedback[];
  aiAnalyses?: AiAnalysis[];
  reportUpdates?: ReportUpdate[];
  assignments?: Assignment[];
  onSelectReport?: (reportId: string) => void;
}

export function AdminAnalyticsView({
  reports,
  departments,
  users,
  feedbacks = [],
  aiAnalyses = [],
  reportUpdates = [],
  assignments = [],
  onSelectReport,
}: AdminAnalyticsViewProps) {
  const { profile, getIdToken } = useAuth();
  const { t, locale, tStatus, tPriority, tCategory, tRole, tDepartmentName, tError } = useLanguage();
  const [activeTab, setActiveTab] = useState<AdminSubTab>('overview');

  // Module 5: Configurable SLA thresholds
  const [ackSlaHours, setAckSlaHours] = useState(24);
  const [resolveSlaHours, setResolveSlaHours] = useState(72);

  // Module 2: Duplicate review state (advisory human triage, never auto-merges or deletes)
  const [duplicateDecisions, setDuplicateDecisions] = useState<
    Record<string, DuplicateReviewDecision>
  >({});
  const [geminiPairLoadingId, setGeminiPairLoadingId] = useState<string | null>(null);
  const [geminiPairResult, setGeminiPairResult] = useState<
    Record<string, { candidate: DuplicateCandidate | null; checkedAtIso: string; note: string }>
  >({});

  // Module 4: AI Trend Intelligence state
  const [trendLoading, setTrendLoading] = useState(false);
  const [trendResult, setTrendResult] = useState<TrendIntelligenceResult | null>(null);
  const [trendError, setTrendError] = useState<string | null>(null);

  // Module 6: Priority Intelligence queue filter
  const [onlyMismatchedPriority, setOnlyMismatchedPriority] = useState(false);

  // Module 7: Governance Reports filters
  const [govDateFrom, setGovDateFrom] = useState('');
  const [govDateTo, setGovDateTo] = useState('');
  const [govDeptId, setGovDeptId] = useState<string>('all');
  const [govCategory, setGovCategory] = useState<IssueCategory | 'all'>('all');

  // Preserved Department & User admin form state
  const [deptName, setDeptName] = useState('');
  const [deptCode, setDeptCode] = useState('');
  const [deptDesc, setDeptDesc] = useState('');
  const [deptCategories, setDeptCategories] = useState<IssueCategory[]>(['pothole']);
  const [savingDept, setSavingDept] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Live Supabase PostgreSQL Intelligence Computations
  const dashboardStats = useMemo(
    () => computeDashboardIntelligence(reports, departments, reportUpdates),
    [reports, departments, reportUpdates]
  );

  const duplicatePairs = useMemo(
    () => computeCitywideDuplicatePairs(reports, aiAnalyses),
    [reports, aiAnalyses]
  );

  const departmentSlaMetrics = useMemo(
    () =>
      computeDepartmentPerformance(departments, reports, assignments, reportUpdates, {
        ackSlaHours: Math.max(1, ackSlaHours || 24),
        resolveSlaHours: Math.max(1, resolveSlaHours || 72),
      }),
    [departments, reports, assignments, reportUpdates, ackSlaHours, resolveSlaHours]
  );

  const aiByReportId = useMemo(() => {
    const map = new Map<string, AiAnalysis>();
    for (const a of aiAnalyses) {
      if (a.reportId) map.set(a.reportId, a);
    }
    return map;
  }, [aiAnalyses]);

  const updatesByReportId = useMemo(() => {
    const map = new Map<string, ReportUpdate[]>();
    for (const u of reportUpdates) {
      const list = map.get(u.reportId) || [];
      list.push(u);
      map.set(u.reportId, list);
    }
    return map;
  }, [reportUpdates]);

  const priorityRecommendations = useMemo(() => {
    const unresolved = reports.filter(
      (r) =>
        r.status !== 'resolved' &&
        r.status !== 'citizen_confirmed' &&
        r.status !== 'rejected'
    );
    return unresolved
      .map((r) => ({
        report: r,
        intel: computePriorityRecommendation(
          r,
          reports,
          aiByReportId.get(r.id) || null,
          updatesByReportId.get(r.id) || []
        ),
      }))
      .sort((a, b) => b.intel.urgencyScore - a.intel.urgencyScore);
  }, [reports, aiByReportId, updatesByReportId]);

  const visiblePriorityQueue = useMemo(
    () =>
      onlyMismatchedPriority
        ? priorityRecommendations.filter((item) => item.intel.differsFromCurrent)
        : priorityRecommendations,
    [priorityRecommendations, onlyMismatchedPriority]
  );

  const governanceFilteredReports = useMemo(
    () =>
      filterGovernanceReports(reports, {
        dateFromIso: govDateFrom || undefined,
        dateToIso: govDateTo || undefined,
        departmentId: govDeptId,
        category: govCategory,
      }),
    [reports, govDateFrom, govDateTo, govDeptId, govCategory]
  );

  const governanceSummaryStats = useMemo(
    () =>
      computeDashboardIntelligence(governanceFilteredReports, departments, reportUpdates),
    [governanceFilteredReports, departments, reportUpdates]
  );

  // Aggregate Citizen Feedback Metrics (Preserved)
  const confirmedFeedbacks = feedbacks.filter((f) => f.outcome === 'confirmed');
  const reopenedDisagreements = feedbacks.filter((f) => f.outcome === 'reopened');
  const averageRating =
    confirmedFeedbacks.length > 0
      ? (
          confirmedFeedbacks.reduce((acc, f) => acc + f.rating, 0) /
          confirmedFeedbacks.length
        ).toFixed(1)
      : null;
  const positiveRatingsCount = confirmedFeedbacks.filter((f) => f.rating >= 4).length;
  const satisfactionRate =
    confirmedFeedbacks.length > 0
      ? Math.round((positiveRatingsCount / confirmedFeedbacks.length) * 100)
      : null;
  const ratingBreakdown = [5, 4, 3, 2, 1].map((stars) => ({
    stars,
    count: confirmedFeedbacks.filter((f) => f.rating === stars).length,
  }));
  const maxRatingBucket = Math.max(1, ...ratingBreakdown.map((b) => b.count));
  const reportById = new Map(reports.map((r) => [r.id, r]));

  const maxWeeklyVal = Math.max(
    1,
    ...dashboardStats.weeklyTrends.map((w) => Math.max(w.submitted, w.resolved))
  );
  const maxMonthlyVal = Math.max(
    1,
    ...dashboardStats.monthlyTrends.map((m) => Math.max(m.submitted, m.resolved))
  );
  const maxCategoryCount = Math.max(
    1,
    ...dashboardStats.categoryDistribution.map((c) => c.count)
  );

  const statusCounts = (Object.keys(STATUS_LABELS) as ReportStatus[]).map((st) => ({
    key: st,
    label: tStatus(st),
    count: reports.filter((r) => r.status === st).length,
  }));

  const handleCreateDepartment = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setFeedbackMsg(null);
    if (deptName.trim().length < 2 || deptCode.trim().length < 2) {
      setErrorMsg(t('analytics.errDeptFields'));
      return;
    }
    try {
      setSavingDept(true);
      await adminSaveDepartment({
        name: deptName,
        code: deptCode,
        description: deptDesc,
        categories: deptCategories.length > 0 ? deptCategories : ['other'],
        officerIds: profile ? [profile.uid] : [],
        active: true,
      });
      setDeptName('');
      setDeptCode('');
      setDeptDesc('');
      setFeedbackMsg(t('analytics.deptSaved'));
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? tError(err.message) : t('error.generic'));
    } finally {
      setSavingDept(false);
    }
  };

  const handleRoleUpdate = async (
    targetUser: UserProfile,
    newRole: UserRole,
    newDeptId: string,
    active: boolean
  ) => {
    if (!profile) return;
    setErrorMsg(null);
    setFeedbackMsg(null);
    try {
      const idToken = await getIdToken();
      await adminUpdateUserRole({
        targetUser,
        role: newRole,
        departmentId: newDeptId,
        active,
        idToken,
      });
      setFeedbackMsg(t('analytics.msgPermissionsUpdated', { name: targetUser.displayName }));
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? tError(err.message) : t('error.generic'));
    }
  };

  const handleRunGeminiDuplicateCheck = async (pairId: string, reportA: CivicReport, reportBId: string) => {
    setGeminiPairLoadingId(pairId);
    setErrorMsg(null);
    try {
      const token = await getIdToken();
      const aiA = aiByReportId.get(reportA.id);
      const res = await detectDuplicatesViaServer(
        {
          reportId: reportA.id,
          title: reportA.title,
          description: reportA.description,
          aiDescription: aiA?.factualDescription,
          category: reportA.category,
          latitude: reportA.latitude,
          longitude: reportA.longitude,
        },
        token
      );
      const matched = res.candidates.find((c) => c.reportId === reportBId) || null;
      setGeminiPairResult((prev) => ({
        ...prev,
        [pairId]: {
          candidate: matched,
          checkedAtIso: new Date().toISOString(),
          note: matched
            ? matched.matchReason
            : t('analytics.geminiInsufficientSim'),
        },
      }));
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? tError(err.message) : t('error.generic'));
    } finally {
      setGeminiPairLoadingId(null);
    }
  };

  const handleGenerateTrendIntelligence = async () => {
    setTrendLoading(true);
    setTrendError(null);
    try {
      const token = await getIdToken();
      const digest = buildAnonymizedTrendDigest(reports, aiAnalyses, departments, reportUpdates);
      const res = await generateTrendIntelligenceViaServer(digest, token);
      setTrendResult(res);
    } catch (err: unknown) {
      setTrendError(
        err instanceof Error ? tError(err.message) : t('error.generic')
      );
    } finally {
      setTrendLoading(false);
    }
  };

  const handleDownloadGovernanceCsv = () => {
    const csvContent = generateGovernanceCsv(governanceFilteredReports, reportUpdates);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `civicfix-governance-report-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const subTabs: Array<{ id: AdminSubTab; label: string; Icon: typeof BarChart3 }> = [
    { id: 'overview', label: t('analytics.subTabOverview'), Icon: BarChart3 },
    { id: 'sla', label: t('analytics.subTabSla'), Icon: Gauge },
    { id: 'hotspots', label: t('analytics.subTabHotspots'), Icon: MapPin },
    {
      id: 'duplicates',
      label: t('analytics.subTabDuplicates', { count: duplicatePairs.length }),
      Icon: CopyCheck,
    },
    { id: 'ai_trends', label: t('analytics.subTabAiTrends'), Icon: TrendingUp },
    {
      id: 'priority',
      label: t('analytics.subTabPriority', { count: priorityRecommendations.length }),
      Icon: Sparkles,
    },
    { id: 'governance', label: t('analytics.subTabGovernance'), Icon: FileText },
    { id: 'departments', label: t('analytics.subTabDepartments', { count: departments.length }), Icon: Building2 },
    { id: 'users', label: t('analytics.subTabUsers', { count: users.length }), Icon: Users },
  ];

  return (
    <div className="space-y-6">
      {/* Header & Navigation */}
      <div className="space-y-4 border-b border-slate-200 pb-4 no-print">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
            {t('analytics.title')}
          </h1>
          <p className="text-sm text-slate-600 mt-0.5">
            {t('analytics.subtitle')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200">
          {subTabs.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                activeTab === id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>

      {feedbackMsg && (
        <div className="no-print p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{feedbackMsg}</span>
        </div>
      )}
      {errorMsg && (
        <div className="no-print p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800">
          {errorMsg}
        </div>
      )}

      {/* MODULE 1 — INTELLIGENCE DASHBOARD */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Primary 7 Operational KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-[11px] text-slate-500">{t('analytics.kpiTotal')}</p>
              <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-slate-900">
                {dashboardStats.totalReports}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-[11px] text-slate-500">{t('analytics.kpiPending')}</p>
              <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-amber-700">
                {dashboardStats.pendingReports}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-[11px] text-slate-500">{t('analytics.kpiVerified')}</p>
              <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-blue-700">
                {dashboardStats.verifiedReports}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-[11px] text-slate-500">{t('analytics.kpiInProgress')}</p>
              <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-indigo-700">
                {dashboardStats.inProgressReports}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-[11px] text-slate-500">{t('analytics.kpiResolved')}</p>
              <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-emerald-700">
                {dashboardStats.resolvedReports}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-[11px] text-slate-500">{t('analytics.kpiReopened')}</p>
              <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-orange-700">
                {dashboardStats.reopenedReports}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4 col-span-2 sm:col-span-2 lg:col-span-1">
              <p className="text-[11px] text-slate-500">{t('analytics.kpiAvgResolution')}</p>
              <p className="mt-1 text-xl font-semibold font-mono tabular-nums text-slate-900">
                {formatDurationHours(dashboardStats.avgResolutionHours)}
              </p>
              <p className="text-[10px] font-mono tabular-nums text-slate-400">
                {t('analytics.resolvedSample', { count: dashboardStats.resolutionSampleSize })}
              </p>
            </div>
          </div>

          {/* Weekly & Monthly Trends */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">
                    {t('analytics.weeklyChartTitle')}
                  </h2>
                  <p className="text-xs text-slate-500">
                    {t('analytics.weeklyChartDesc')}
                  </p>
                </div>
                <div className="flex items-center gap-3 text-[11px] text-slate-600 shrink-0">
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-xs bg-blue-700 inline-block" />
                    {t('common.submitted')}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-xs bg-emerald-600 inline-block" />
                    {t('analytics.kpiResolved')}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-8 gap-2 items-end h-40 pt-4 border-b border-slate-200 pb-2">
                {dashboardStats.weeklyTrends.map((bucket) => {
                  const subPct = Math.round((bucket.submitted / maxWeeklyVal) * 100);
                  const resPct = Math.round((bucket.resolved / maxWeeklyVal) * 100);
                  return (
                    <div key={bucket.key} className="flex flex-col items-center gap-1 h-full justify-end">
                      <div className="flex items-end gap-1 h-28 w-full justify-center">
                        <div
                          title={`${bucket.label}: ${bucket.submitted} ${t('common.submitted')}`}
                          className="w-2.5 bg-blue-700 rounded-t"
                          style={{ height: `${bucket.submitted === 0 ? 2 : Math.max(8, subPct)}%` }}
                        />
                        <div
                          title={`${bucket.label}: ${bucket.resolved} ${t('analytics.kpiResolved')}`}
                          className="w-2.5 bg-emerald-600 rounded-t"
                          style={{ height: `${bucket.resolved === 0 ? 2 : Math.max(8, resPct)}%` }}
                        />
                      </div>
                      <span className="text-[10px] font-mono tabular-nums text-slate-500 truncate max-w-full">
                        {bucket.label}
                      </span>
                      <span className="text-[10px] font-mono tabular-nums text-slate-700">
                        {bucket.submitted}/{bucket.resolved}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">
                    {t('analytics.monthlyChartTitle')}
                  </h2>
                  <p className="text-xs text-slate-500">
                    {t('analytics.monthlyChartDesc')}
                  </p>
                </div>
                <span className="text-[11px] font-mono tabular-nums text-slate-500">
                  {t('analytics.subResShort')}
                </span>
              </div>

              <div className="grid grid-cols-6 gap-3 items-end h-40 pt-4 border-b border-slate-200 pb-2">
                {dashboardStats.monthlyTrends.map((bucket) => {
                  const subPct = Math.round((bucket.submitted / maxMonthlyVal) * 100);
                  const resPct = Math.round((bucket.resolved / maxMonthlyVal) * 100);
                  return (
                    <div key={bucket.key} className="flex flex-col items-center gap-1 h-full justify-end">
                      <div className="flex items-end gap-1.5 h-28 w-full justify-center">
                        <div
                          title={`${bucket.label}: ${bucket.submitted} ${t('common.submitted')}`}
                          className="w-3 bg-blue-700 rounded-t"
                          style={{ height: `${bucket.submitted === 0 ? 2 : Math.max(8, subPct)}%` }}
                        />
                        <div
                          title={`${bucket.label}: ${bucket.resolved} ${t('analytics.kpiResolved')}`}
                          className="w-3 bg-emerald-600 rounded-t"
                          style={{ height: `${bucket.resolved === 0 ? 2 : Math.max(8, resPct)}%` }}
                        />
                      </div>
                      <span className="text-[10px] font-mono tabular-nums text-slate-500">
                        {bucket.label}
                      </span>
                      <span className="text-[10px] font-mono tabular-nums text-slate-700">
                        {bucket.submitted}/{bucket.resolved}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          {/* Category Distribution + Workflow Stage Breakdown */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <h2 className="text-sm font-semibold text-slate-900">
                {t('analytics.categoryDistTitle')}
              </h2>
              <div className="space-y-3">
                {dashboardStats.categoryDistribution.map((c) => {
                  const pct = Math.round((c.count / maxCategoryCount) * 100);
                  return (
                    <div key={c.category} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-slate-700 font-medium">{tCategory(c.category)}</span>
                        <span className="font-mono tabular-nums text-slate-900 font-semibold">
                          {c.count} ({c.sharePct}%)
                        </span>
                      </div>
                      <div className="h-2.5 w-full rounded bg-slate-100 overflow-hidden">
                        <div
                          className="h-full rounded bg-blue-700 transition-all duration-300"
                          style={{ width: `${c.count === 0 ? 0 : Math.max(4, pct)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <h2 className="text-sm font-semibold text-slate-900">
                {t('analytics.stageDistTitle')}
              </h2>
              <div className="divide-y divide-slate-200">
                {statusCounts.map((s) => (
                  <div key={s.key} className="py-2 flex items-center justify-between text-xs">
                    <span className="text-slate-700">{s.label}</span>
                    <span className="font-mono tabular-nums font-semibold text-slate-900">
                      {s.count}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          {/* Department Workload Breakdown */}
          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">
                {t('analytics.deptWorkloadOverview')}
              </h2>
              <button
                type="button"
                onClick={() => setActiveTab('sla')}
                className="text-xs font-medium text-blue-700 hover:underline"
              >
                {t('analytics.openSlaMetrics')}
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs text-slate-600">
                    <th className="py-3 px-6 font-medium">{t('common.department')}</th>
                    <th className="py-3 px-4 font-medium">{t('analytics.colCode')}</th>
                    <th className="py-3 px-4 font-medium text-right">{t('analytics.colTotalAssigned')}</th>
                    <th className="py-3 px-4 font-medium text-right">{t('analytics.colOpenWorkload')}</th>
                    <th className="py-3 px-6 font-medium text-right">{t('analytics.colResolvedConfirmed')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {dashboardStats.departmentWorkload.map((dw) => (
                    <tr key={dw.departmentId} className="hover:bg-slate-50/70">
                      <td className="py-3 px-6 font-medium text-slate-900">
                        {tDepartmentName(dw.departmentId, dw.departmentName)}
                      </td>
                      <td className="py-3 px-4 font-mono text-xs text-slate-600">
                        {dw.departmentCode}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-900">
                        {dw.total}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-amber-700">
                        {dw.open}
                      </td>
                      <td className="py-3 px-6 text-right font-mono tabular-nums text-emerald-700 font-medium">
                        {dw.resolved}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Preserved Aggregate Citizen Satisfaction & Feedback Analytics */}
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-4">
              <div className="flex items-center gap-2">
                <Star className="w-4 h-4 text-amber-500" aria-hidden="true" />
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">
                    {t('analytics.aggSatisfactionTitle')}
                  </h2>
                  <p className="text-xs text-slate-500">
                    {t('analytics.aggSatisfactionDesc')}
                  </p>
                </div>
              </div>
              <span className="text-xs font-mono tabular-nums text-slate-500">
                {t('analytics.totalRecords', { count: feedbacks.length })}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
                <p className="text-xs text-slate-500">{t('analytics.avgRating')}</p>
                <p className="mt-1 text-xl font-semibold font-mono tabular-nums text-slate-900">
                  {averageRating !== null ? `${averageRating} / 5.0` : t('analytics.noRatings')}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
                <p className="text-xs text-slate-500">{t('analytics.confirmedRatings')}</p>
                <p className="mt-1 text-xl font-semibold font-mono tabular-nums text-emerald-700">
                  {confirmedFeedbacks.length}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
                <p className="text-xs text-slate-500">{t('analytics.positiveScore')}</p>
                <p className="mt-1 text-xl font-semibold font-mono tabular-nums text-blue-700">
                  {satisfactionRate !== null ? `${satisfactionRate}%` : '—'}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
                <p className="text-xs text-slate-500">{t('analytics.reopenedDisagreements')}</p>
                <p className="mt-1 text-xl font-semibold font-mono tabular-nums text-orange-700">
                  {reopenedDisagreements.length}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-5 space-y-2.5">
                <h3 className="text-xs font-semibold text-slate-700">
                  {t('analytics.ratingDistribution')}
                </h3>
                {ratingBreakdown.map((bucket) => {
                  const pct = Math.round((bucket.count / maxRatingBucket) * 100);
                  return (
                    <div key={bucket.stars} className="flex items-center gap-3 text-xs">
                      <span className="w-16 font-mono tabular-nums text-slate-700 shrink-0">
                        {t('analytics.starsCount', { n: bucket.stars })}
                      </span>
                      <div className="flex-1 h-2.5 rounded bg-slate-100 overflow-hidden">
                        <div
                          className="h-full rounded bg-amber-500 transition-all duration-300"
                          style={{ width: `${bucket.count === 0 ? 0 : Math.max(4, pct)}%` }}
                        />
                      </div>
                      <span className="w-8 text-right font-mono tabular-nums text-slate-900 font-medium">
                        {bucket.count}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="lg:col-span-7 space-y-2.5">
                <h3 className="text-xs font-semibold text-slate-700">
                  {t('analytics.recentFeedbackTitle')}
                </h3>
                {feedbacks.length === 0 ? (
                  <p className="text-xs text-slate-500 py-4 border border-slate-200 rounded-lg px-4 bg-slate-50">
                    {t('analytics.noFeedbackRecorded')}
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-200 border border-slate-200 rounded-lg bg-slate-50/50 px-4 max-h-64 overflow-y-auto">
                    {feedbacks.slice(0, 12).map((fb) => {
                      const linkedReport = reportById.get(fb.reportId);
                      return (
                        <li key={fb.id} className="py-2.5 text-xs space-y-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="font-mono tabular-nums font-semibold text-slate-900">
                                {linkedReport?.trackingCode || fb.reportId}
                              </span>
                              <span
                                className={`px-1.5 py-0.5 rounded text-[11px] font-medium border ${
                                  fb.outcome === 'confirmed'
                                    ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                    : 'bg-orange-50 text-orange-800 border-orange-200'
                                }`}
                              >
                                {fb.outcome === 'confirmed'
                                  ? t('analytics.confirmedWithScore', { rating: fb.rating })
                                  : tStatus('reopened')}
                              </span>
                            </div>
                            <span className="font-mono tabular-nums text-slate-400">
                              {formatTimestamp(fb.createdAt)}
                            </span>
                          </div>
                          <p className="text-slate-700">{fb.comment}</p>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </section>
        </div>
      )}

      {/* MODULE 5 — DEPARTMENT PERFORMANCE & SLA */}
      {activeTab === 'sla' && (
        <div className="space-y-6">
          <section className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-1 max-w-2xl">
              <h2 className="text-sm font-semibold text-slate-900">
                {t('analytics.deptSlaTitle')}
              </h2>
              <p className="text-xs text-slate-600">
                {t('analytics.deptSlaDesc')}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('analytics.ackSlaHours')}
                </label>
                <input
                  type="number"
                  min={1}
                  max={720}
                  value={ackSlaHours}
                  onChange={(e) => setAckSlaHours(Math.max(1, Number(e.target.value) || 24))}
                  className="w-28 px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-mono tabular-nums bg-white"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('analytics.resolveSlaHours')}
                </label>
                <input
                  type="number"
                  min={1}
                  max={2160}
                  value={resolveSlaHours}
                  onChange={(e) => setResolveSlaHours(Math.max(1, Number(e.target.value) || 72))}
                  className="w-28 px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-mono tabular-nums bg-white"
                />
              </div>
            </div>
          </section>

          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <th className="py-3 px-5 font-medium">{t('common.department')}</th>
                    <th className="py-3 px-4 font-medium text-right">{t('analytics.colAssigned')}</th>
                    <th className="py-3 px-4 font-medium text-right">{t('analytics.colAvgAck')}</th>
                    <th className="py-3 px-4 font-medium text-right">{t('analytics.colAvgResolve')}</th>
                    <th className="py-3 px-4 font-medium text-right">{t('analytics.colPending')}</th>
                    <th className="py-3 px-4 font-medium text-right">{t('analytics.colOverdueSla')}</th>
                    <th className="py-3 px-4 font-medium text-right">{t('analytics.colCitizenConfirm')}</th>
                    <th className="py-3 px-5 font-medium">{t('analytics.colSampleValidity')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {departmentSlaMetrics.map((m) => (
                    <tr key={m.departmentId} className="hover:bg-slate-50">
                      <td className="py-3 px-5">
                        <div className="font-medium text-slate-900 text-sm">
                          {tDepartmentName(m.departmentId, m.departmentName)}
                        </div>
                        <div className="font-mono text-[11px] text-slate-500">{m.departmentCode}</div>
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-slate-900">
                        n={m.assignedCount}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                        {formatDurationHours(m.avgAcknowledgeHours)}
                        <div className="text-[10px] text-slate-400">n={m.ackSampleSize}</div>
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                        {formatDurationHours(m.avgResolutionHours)}
                        <div className="text-[10px] text-slate-400">n={m.resolvedSampleSize}</div>
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-blue-700 font-medium">
                        {m.pendingWorkload}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold">
                        <span className={m.overdueCount > 0 ? 'text-rose-700' : 'text-slate-500'}>
                          {m.overdueCount}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-emerald-700 font-medium">
                        {m.confirmationRatePct !== null ? `${m.confirmationRatePct}%` : '—'}
                        <div className="text-[10px] text-slate-400">n={m.confirmationSampleSize}</div>
                      </td>
                      <td className="py-3 px-5">
                        {m.insufficientSample ? (
                          <span className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded whitespace-nowrap">
                            {t('analytics.lowSampleBadge')}
                          </span>
                        ) : (
                          <span className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded whitespace-nowrap">
                            {t('analytics.comparableBadge', { count: m.assignedCount })}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* MODULE 3 — CIVIC HOTSPOT ANALYSIS */}
      {activeTab === 'hotspots' && (
        <HotspotMapView reports={reports} onSelectReport={onSelectReport} />
      )}

      {/* MODULE 2 — INTELLIGENT DUPLICATE DETECTION */}
      {activeTab === 'duplicates' && (
        <div className="space-y-6">
          <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CopyCheck className="w-4 h-4 text-blue-700" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-slate-900">
                  {t('analytics.dupAuditTitle')}
                </h2>
              </div>
              <span className="text-xs font-mono tabular-nums text-slate-500">
                {t('analytics.candidatePairsCount', { count: duplicatePairs.length })}
              </span>
            </div>
            <p className="text-xs text-slate-600">
              {t('analytics.dupAuditDesc')}
            </p>
          </section>

          {duplicatePairs.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-2">
              <CheckCircle2 className="w-8 h-8 text-emerald-500 mx-auto" aria-hidden="true" />
              <p className="text-sm font-medium text-slate-900">{t('analytics.noDuplicates')}</p>
              <p className="text-xs text-slate-500">
                {t('analytics.noDupPairsDesc')}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {duplicatePairs.map((pair) => {
                const decision = duplicateDecisions[pair.pairId] || 'pending_review';
                const geminiCheck = geminiPairResult[pair.pairId];
                const reportA = reportById.get(pair.reportAId);
                return (
                  <section
                    key={pair.pairId}
                    className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-mono tabular-nums font-semibold text-blue-800 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded">
                          {t('analytics.similarityPct', { pct: Math.round(pair.matchScore * 100) })}
                        </span>
                        <span className="font-medium text-slate-800">
                          {tCategory(pair.category)}
                        </span>
                        {pair.distanceMeters !== null && (
                          <span className="font-mono tabular-nums text-slate-500">
                            · {t('analytics.metersApart', { m: pair.distanceMeters })}
                          </span>
                        )}
                        <span className="font-mono tabular-nums text-slate-500">
                          · {t('analytics.hoursApart', { h: pair.timeDeltaHours })}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          aria-label={`${pair.reportATrackingCode} / ${pair.reportBTrackingCode}`}
                          value={decision}
                          onChange={(e) =>
                            setDuplicateDecisions((prev) => ({
                              ...prev,
                              [pair.pairId]: e.target.value as DuplicateReviewDecision,
                            }))
                          }
                          className="px-2.5 py-1 rounded border border-slate-300 text-xs bg-white"
                        >
                          <option value="pending_review">{t('analytics.dupPendingReview')}</option>
                          <option value="confirmed_related">{t('analytics.dupConfirmedRelated')}</option>
                          <option value="dismissed_distinct">{t('analytics.dupDismissedDistinct')}</option>
                        </select>

                        {reportA && (
                          <button
                            type="button"
                            disabled={geminiPairLoadingId === pair.pairId}
                            onClick={() =>
                              handleRunGeminiDuplicateCheck(pair.pairId, reportA, pair.reportBId)
                            }
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                          >
                            {geminiPairLoadingId === pair.pairId ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Sparkles className="w-3 h-3 text-blue-700" />
                            )}
                            <span>{t('analytics.verifyWithGemini')}</span>
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                      <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono tabular-nums font-semibold text-slate-900">
                            {pair.reportATrackingCode}
                          </span>
                          <StatusIndicator status={pair.reportAStatus} />
                        </div>
                        <p className="font-medium text-slate-900">{pair.reportATitle}</p>
                        {pair.reportAAiDescription && (
                          <p className="text-[11px] text-slate-600">
                            {t('analytics.aiImageNote')} {pair.reportAAiDescription}
                          </p>
                        )}
                        {onSelectReport && (
                          <button
                            type="button"
                            onClick={() => onSelectReport(pair.reportAId)}
                            className="text-blue-700 font-medium hover:underline pt-1"
                          >
                            {t('analytics.inspectReportA')}
                          </button>
                        )}
                      </div>

                      <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono tabular-nums font-semibold text-slate-900">
                            {pair.reportBTrackingCode}
                          </span>
                          <StatusIndicator status={pair.reportBStatus} />
                        </div>
                        <p className="font-medium text-slate-900">{pair.reportBTitle}</p>
                        {pair.reportBAiDescription && (
                          <p className="text-[11px] text-slate-600">
                            {t('analytics.aiImageNote')} {pair.reportBAiDescription}
                          </p>
                        )}
                        {onSelectReport && (
                          <button
                            type="button"
                            onClick={() => onSelectReport(pair.reportBId)}
                            className="text-blue-700 font-medium hover:underline pt-1"
                          >
                            {t('analytics.inspectReportB')}
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="text-xs text-slate-600 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-medium text-slate-800">{t('analytics.similaritySignals')}</span>
                      <span>{pair.reasons.join(' · ')}</span>
                      <span className="font-mono tabular-nums text-slate-400">
                        {t('analytics.textImageSim', {
                          text: Math.round(pair.textSimilarity * 100),
                          img: Math.round(pair.aiImageSimilarity * 100),
                        })}
                      </span>
                    </div>

                    {geminiCheck && (
                      <div className="p-3 rounded-lg bg-blue-50/70 border border-blue-200 text-xs text-blue-950">
                        <span className="font-semibold">{t('analytics.geminiCrossCheck')} </span>
                        <span>{geminiCheck.note}</span>
                        {geminiCheck.candidate && (
                          <span className="font-mono tabular-nums ml-2">
                            {t('analytics.blendedPct', {
                              pct: Math.round(geminiCheck.candidate.overallScore * 100),
                            })}
                          </span>
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* MODULE 4 — AI TREND INTELLIGENCE */}
      {activeTab === 'ai_trends' && (
        <div className="space-y-6">
          <section className="bg-white border border-slate-200 rounded-xl p-6 flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1 max-w-2xl">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-blue-700" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-slate-900">
                  {t('analytics.aiTrendTitle')}
                </h2>
              </div>
              <p className="text-xs text-slate-600">
                {t('analytics.aiTrendDesc')}
              </p>
            </div>

            <button
              type="button"
              disabled={trendLoading}
              onClick={handleGenerateTrendIntelligence}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-700 text-white text-xs font-medium hover:bg-blue-800 disabled:opacity-60 whitespace-nowrap shrink-0"
            >
              {trendLoading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>{t('analytics.analyzingTrends')}</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>
                    {trendResult ? t('analytics.refreshBriefing') : t('analytics.generateBriefing')}
                  </span>
                </>
              )}
            </button>
          </section>

          {trendError && (
            <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800">
              {trendError}
            </div>
          )}

          {!trendResult && !trendLoading && (
            <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-2">
              <TrendingUp className="w-8 h-8 text-slate-300 mx-auto" aria-hidden="true" />
              <p className="text-sm font-medium text-slate-900">
                {t('analytics.briefingEmptyTitle')}
              </p>
              <p className="text-xs text-slate-500 max-w-lg mx-auto">
                {t('analytics.briefingEmptyDesc', { count: reports.length })}
              </p>
            </div>
          )}

          {trendResult && (
            <div className="space-y-6">
              {/* Observed Facts Banner (Distinct from AI Hypotheses) */}
              <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
                  <div className="flex items-center gap-2">
                    <Shield className="w-4 h-4 text-emerald-700" aria-hidden="true" />
                    <h3 className="text-sm font-semibold text-slate-900">
                      {t('analytics.observedFacts')}
                    </h3>
                  </div>
                  <span className="text-[11px] font-mono tabular-nums text-slate-500">
                    {t('analytics.generatedMeta', {
                      time: new Date(trendResult.generatedAtIso).toLocaleString(locale),
                      model: trendResult.modelUsed,
                    })}
                  </span>
                </div>

                {trendResult.observedFacts.lowSampleWarning && (
                  <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                    <span>
                      {t('analytics.lowSampleWarning', {
                        count: trendResult.observedFacts.totalReports,
                      })}
                    </span>
                  </div>
                )}

                <p className="text-sm text-slate-800">{trendResult.observedFacts.summary}</p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-mono tabular-nums text-slate-600">
                  <span>
                    {t('analytics.reportsAnalyzed', { count: trendResult.observedFacts.totalReports })}
                  </span>
                  <span>
                    {t('analytics.reopenedIncidents', { count: trendResult.observedFacts.reopenedCount })}
                  </span>
                  {trendResult.observedFacts.topCategories.length > 0 && (
                    <span>
                      {t('analytics.topCategories')}{' '}
                      {trendResult.observedFacts.topCategories
                        .map((c) => `${c.category} (${c.count})`)
                        .join(', ')}
                    </span>
                  )}
                </div>
              </section>

              {/* Advisory Notice */}
              <div className="p-3.5 rounded-xl bg-blue-50/80 border border-blue-200 text-xs text-blue-950">
                <span className="font-semibold">{t('analytics.aiAdvisoryNoticeLabel')} </span>
                {trendResult.advisoryNotice}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-2.5">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {t('analytics.frequentlyReported')}
                  </h3>
                  <ul className="space-y-1.5 text-xs text-slate-700 list-disc pl-4">
                    {trendResult.frequentlyReportedIssues.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </section>

                <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-2.5">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {t('analytics.emergingPatterns')}
                  </h3>
                  <ul className="space-y-1.5 text-xs text-slate-700 list-disc pl-4">
                    {trendResult.emergingPatterns.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </section>

                <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-2.5">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {t('analytics.concentratedAreas')}
                  </h3>
                  <ul className="space-y-1.5 text-xs text-slate-700 list-disc pl-4">
                    {trendResult.areasWithIncreasingComplaints.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </section>

                <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-2.5">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {t('analytics.recurringInfra')}
                  </h3>
                  <ul className="space-y-1.5 text-xs text-slate-700 list-disc pl-4">
                    {trendResult.recurringInfrastructureProblems.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </section>
              </div>

              {/* Preventive Maintenance Priorities & Admin Recommendations */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <section className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                  <h3 className="text-sm font-semibold text-slate-900">
                    {t('analytics.preventivePriorities')}
                  </h3>
                  <div className="divide-y divide-slate-200">
                    {trendResult.preventiveMaintenancePriorities.map((p, idx) => (
                      <div key={idx} className="py-2.5 text-xs space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-slate-900">{p.title}</span>
                          <span
                            className={`px-2 py-0.5 rounded font-medium border ${
                              p.urgency === 'high'
                                ? 'bg-rose-50 text-rose-800 border-rose-200'
                                : p.urgency === 'medium'
                                  ? 'bg-amber-50 text-amber-800 border-amber-200'
                                  : 'bg-slate-50 text-slate-700 border-slate-200'
                            }`}
                          >
                            {tPriority(p.urgency)}
                          </span>
                        </div>
                        <p className="text-slate-600">{p.rationale}</p>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                  <h3 className="text-sm font-semibold text-slate-900">
                    {t('analytics.adminRecommendations')}
                  </h3>
                  <ul className="space-y-2 text-xs text-slate-700 list-decimal pl-4">
                    {trendResult.administratorRecommendations.map((rec, idx) => (
                      <li key={idx}>{rec}</li>
                    ))}
                  </ul>
                </section>
              </div>
            </div>
          )}
        </div>
      )}

      {/* MODULE 6 — EXPLAINABLE PRIORITY INTELLIGENCE */}
      {activeTab === 'priority' && (
        <div className="space-y-6">
          <section className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1 max-w-2xl">
              <h2 className="text-sm font-semibold text-slate-900">
                {t('analytics.priorityQueueTitle')}
              </h2>
              <p className="text-xs text-slate-600">
                {t('analytics.priorityQueueDesc')}
              </p>
            </div>

            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={onlyMismatchedPriority}
                onChange={(e) => setOnlyMismatchedPriority(e.target.checked)}
                className="rounded border-slate-300 text-blue-700"
              />
              <span>
                {t('analytics.onlyMismatched', {
                  count: priorityRecommendations.filter((i) => i.intel.differsFromCurrent).length,
                })}
              </span>
            </label>
          </section>

          {visiblePriorityQueue.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-2">
              <CheckCircle2 className="w-8 h-8 text-emerald-500 mx-auto" aria-hidden="true" />
              <p className="text-sm font-medium text-slate-900">
                {t('analytics.noPriorityMatches')}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {visiblePriorityQueue.map(({ report: rep, intel }) => (
                <section
                  key={rep.id}
                  className="bg-white border border-slate-200 rounded-xl p-5 space-y-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-mono tabular-nums font-semibold text-slate-600">
                          {rep.trackingCode}
                        </span>
                        <StatusIndicator status={rep.status} />
                        <span className="text-slate-500">{tCategory(rep.category)}</span>
                      </div>
                      <h3 className="text-sm font-semibold text-slate-900 truncate">{rep.title}</h3>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 shrink-0 text-xs">
                      <div className="text-right">
                        <span className="block text-[10px] text-slate-500">
                          {t('analytics.currentLabel')}
                        </span>
                        <PriorityIndicator priority={intel.currentPriority} />
                      </div>
                      <span className="text-slate-300" aria-hidden="true">→</span>
                      <div className="text-right">
                        <span className="block text-[10px] text-slate-500">
                          {t('analytics.suggestedScore', { score: intel.urgencyScore })}
                        </span>
                        <PriorityIndicator priority={intel.recommendedPriority} />
                      </div>
                      {onSelectReport && (
                        <button
                          type="button"
                          onClick={() => onSelectReport(rep.id)}
                          className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-blue-700 hover:bg-blue-50 whitespace-nowrap"
                        >
                          {t('analytics.reviewSetPriority')}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 pt-2 border-t border-slate-100 text-[11px]">
                    {intel.factors.map((f) => (
                      <div key={f.id} className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
                        <div className="flex items-center justify-between font-medium text-slate-800">
                          <span className="truncate">{f.label}</span>
                          <span className="font-mono tabular-nums text-blue-800 shrink-0">
                            {f.points}/{f.maxPoints}
                          </span>
                        </div>
                        <p className="text-slate-600 leading-snug">{f.observation}</p>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      )}

      {/* MODULE 7 — MUNICIPAL GOVERNANCE REPORTS & EXPORTS */}
      {activeTab === 'governance' && (
        <div className="space-y-6">
          <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 no-print">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  {t('analytics.govFiltersTitle')}
                </h2>
                <p className="text-xs text-slate-600">
                  {t('analytics.govFiltersDesc')}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleDownloadGovernanceCsv}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-700 text-white text-xs font-medium hover:bg-blue-800 whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{t('analytics.exportCsvNoPii')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap"
                >
                  <Printer className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{t('analytics.printSummary')}</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('map.fromDate')}
                </label>
                <input
                  type="date"
                  value={govDateFrom}
                  onChange={(e) => setGovDateFrom(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-mono bg-white"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('map.toDate')}
                </label>
                <input
                  type="date"
                  value={govDateTo}
                  onChange={(e) => setGovDateTo(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-mono bg-white"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('common.department')}
                </label>
                <select
                  value={govDeptId}
                  onChange={(e) => setGovDeptId(e.target.value)}
                  className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white"
                >
                  <option value="all">{t('common.allDepartments')}</option>
                  <option value="__unassigned__">{t('analytics.unassignedPendingVerify')}</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {tDepartmentName(d.id, d.name)} ({d.code})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('common.category')}
                </label>
                <select
                  value={govCategory}
                  onChange={(e) => setGovCategory(e.target.value as IssueCategory | 'all')}
                  className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white"
                >
                  <option value="all">{t('common.allCategories')}</option>
                  {(Object.keys(CATEGORY_LABELS) as IssueCategory[]).map((cat) => (
                    <option key={cat} value={cat}>
                      {tCategory(cat)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          {/* Printable Executive Governance Summary */}
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="border-b border-slate-200 pb-4 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">
                  {t('analytics.execSummaryTitle')}
                </h2>
                <p className="text-xs text-slate-500">
                  {t('analytics.windowLabel', {
                    from: govDateFrom || t('analytics.allEarliest'),
                    to: govDateTo || t('analytics.present'),
                  })}
                </p>
              </div>
              <span className="font-mono tabular-nums text-xs text-slate-500">
                {t('analytics.generatedDate', { date: new Date().toISOString().slice(0, 10) })}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="p-3.5 rounded-lg border border-slate-200 bg-slate-50">
                <p className="text-[11px] text-slate-500">{t('analytics.matchingReports')}</p>
                <p className="mt-1 text-xl font-semibold font-mono tabular-nums text-slate-900">
                  {governanceSummaryStats.totalReports}
                </p>
              </div>
              <div className="p-3.5 rounded-lg border border-slate-200 bg-slate-50">
                <p className="text-[11px] text-slate-500">{t('analytics.colResolvedConfirmed')}</p>
                <p className="mt-1 text-xl font-semibold font-mono tabular-nums text-emerald-700">
                  {governanceSummaryStats.resolvedReports}
                </p>
              </div>
              <div className="p-3.5 rounded-lg border border-slate-200 bg-slate-50">
                <p className="text-[11px] text-slate-500">{t('analytics.kpiReopened')}</p>
                <p className="mt-1 text-xl font-semibold font-mono tabular-nums text-orange-700">
                  {governanceSummaryStats.reopenedReports}
                </p>
              </div>
              <div className="p-3.5 rounded-lg border border-slate-200 bg-slate-50">
                <p className="text-[11px] text-slate-500">{t('analytics.avgResolutionTime')}</p>
                <p className="mt-1 text-xl font-semibold font-mono tabular-nums text-slate-900">
                  {formatDurationHours(governanceSummaryStats.avgResolutionHours)}
                </p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <th className="py-2.5 px-3 font-medium">{t('common.trackingId')}</th>
                    <th className="py-2.5 px-3 font-medium">{t('analytics.colIssueTitle')}</th>
                    <th className="py-2.5 px-3 font-medium">{t('common.category')}</th>
                    <th className="py-2.5 px-3 font-medium">{t('common.priority')}</th>
                    <th className="py-2.5 px-3 font-medium">{t('common.status')}</th>
                    <th className="py-2.5 px-3 font-medium">{t('common.department')}</th>
                    <th className="py-2.5 px-3 font-medium text-right">{t('common.submitted')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {governanceFilteredReports.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-6 text-center text-slate-500">
                        {t('analytics.noGovMatches')}
                      </td>
                    </tr>
                  ) : (
                    governanceFilteredReports.map((r) => (
                      <tr key={r.id}>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-slate-700">
                          {r.trackingCode}
                        </td>
                        <td className="py-2.5 px-3 font-medium text-slate-900">{r.title}</td>
                        <td className="py-2.5 px-3 text-slate-600">
                          {tCategory(r.category)}
                        </td>
                        <td className="py-2.5 px-3 text-slate-700">
                          {tPriority(r.priority)}
                        </td>
                        <td className="py-2.5 px-3 text-slate-700">{tStatus(r.status)}</td>
                        <td className="py-2.5 px-3 text-slate-600">
                          {r.departmentName
                            ? tDepartmentName(r.departmentId, r.departmentName)
                            : t('common.unassigned')}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-500">
                          {formatTimestamp(r.createdAt)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* PRESERVED: DEPARTMENTS MANAGEMENT */}
      {activeTab === 'departments' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Plus className="w-4 h-4 text-blue-700" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-slate-900">{t('analytics.addNewDept')}</h2>
            </div>
            <form onSubmit={handleCreateDepartment} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('analytics.deptName')}
                </label>
                <input
                  type="text"
                  required
                  value={deptName}
                  onChange={(e) => setDeptName(e.target.value)}
                  placeholder={t('analytics.deptNamePlaceholder')}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('analytics.shortCode')}
                </label>
                <input
                  type="text"
                  required
                  maxLength={16}
                  value={deptCode}
                  onChange={(e) => setDeptCode(e.target.value)}
                  placeholder={t('analytics.shortCodePlaceholder')}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono uppercase"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('analytics.deptDescription')}
                </label>
                <textarea
                  rows={2}
                  value={deptDesc}
                  onChange={(e) => setDeptDesc(e.target.value)}
                  placeholder={t('analytics.deptDescPlaceholder')}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                />
              </div>
              <div>
                <span className="block text-xs font-medium text-slate-700 mb-1.5">
                  {t('analytics.handledCategories')}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {(Object.keys(CATEGORY_LABELS) as IssueCategory[]).map((cat) => {
                    const selected = deptCategories.includes(cat);
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() =>
                          setDeptCategories((prev) =>
                            prev.includes(cat)
                              ? prev.filter((c) => c !== cat)
                              : [...prev, cat]
                          )
                        }
                        className={`px-2.5 py-1 rounded text-xs border transition-colors ${
                          selected
                            ? 'bg-blue-700 text-white border-blue-700'
                            : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        {tCategory(cat)}
                      </button>
                    );
                  })}
                </div>
              </div>
              <button
                type="submit"
                disabled={savingDept}
                className="w-full py-2.5 px-4 rounded-lg bg-blue-700 text-white text-sm font-medium hover:bg-blue-800 disabled:opacity-60"
              >
                {savingDept ? t('common.saving') : t('analytics.createDepartment')}
              </button>
            </form>
          </section>

          <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200">
              <h2 className="text-sm font-semibold text-slate-900">
                {t('analytics.activeDeptsHeading')}
              </h2>
            </div>
            <ul className="divide-y divide-slate-200">
              {departments
                .filter((d) => d.active)
                .map((d) => (
                  <li key={d.id} className="p-5 space-y-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-semibold text-slate-900 text-sm">
                        {tDepartmentName(d.id, d.name)}{' '}
                        <span className="font-mono text-xs text-slate-500">({d.code})</span>
                      </span>
                      <span className="text-xs text-slate-500 font-mono tabular-nums">
                        {t('analytics.officersCount', { count: d.officerIds.length })}
                      </span>
                    </div>
                    {d.description && (
                      <p className="text-xs text-slate-600">{d.description}</p>
                    )}
                    <p className="text-xs text-slate-500">
                      {t('analytics.categoriesPrefix')}{' '}
                      {d.categories.map((c) => tCategory(c)).join(' · ')}
                    </p>
                  </li>
                ))}
            </ul>
          </section>
        </div>
      )}

      {/* PRESERVED: USERS & ROLES MANAGEMENT */}
      {activeTab === 'users' && (
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-blue-700" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-slate-900">
                {t('analytics.userPermissionsHeading')}
              </h2>
            </div>
            <span className="text-xs text-slate-500">
              {t('analytics.piiIsolatedNote')}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs text-slate-600">
                  <th className="py-3 px-6 font-medium">{t('analytics.colUser')}</th>
                  <th className="py-3 px-4 font-medium">{t('analytics.colRole')}</th>
                  <th className="py-3 px-4 font-medium">{t('analytics.colDeptAffiliation')}</th>
                  <th className="py-3 px-6 font-medium text-right">{t('common.status')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {users.map((u) => (
                  <tr key={u.uid} className="hover:bg-slate-50/70">
                    <td className="py-3 px-6">
                      <div className="font-medium text-slate-900">{u.displayName}</div>
                      <div className="text-xs font-mono text-slate-500">{u.uid.slice(0, 12)}...</div>
                    </td>
                    <td className="py-3 px-4">
                      <select
                        value={u.role}
                        onChange={(e) =>
                          handleRoleUpdate(
                            u,
                            e.target.value as UserRole,
                            u.departmentId,
                            u.active
                          )
                        }
                        className="px-2.5 py-1.5 rounded border border-slate-300 text-xs bg-white"
                      >
                        <option value="citizen">{tRole('citizen')}</option>
                        <option value="worker">{tRole('worker')}</option>
                        <option value="officer">{tRole('officer')}</option>
                        <option value="admin">{tRole('admin')}</option>
                      </select>
                    </td>
                    <td className="py-3 px-4">
                      <select
                        value={u.departmentId || ''}
                        onChange={(e) =>
                          handleRoleUpdate(u, u.role, e.target.value, u.active)
                        }
                        className="px-2.5 py-1.5 rounded border border-slate-300 text-xs bg-white max-w-[220px]"
                      >
                        <option value="">{t('analytics.noneUnassigned')}</option>
                        {departments.map((d) => (
                          <option key={d.id} value={d.id}>
                            {tDepartmentName(d.id, d.name)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3 px-6 text-right">
                      <button
                        type="button"
                        onClick={() =>
                          handleRoleUpdate(u, u.role, u.departmentId, !u.active)
                        }
                        className={`px-2.5 py-1 rounded text-xs font-medium border ${
                          u.active
                            ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                            : 'bg-slate-100 text-slate-600 border-slate-200'
                        }`}
                      >
                        {u.active ? t('common.active') : t('analytics.suspended')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
