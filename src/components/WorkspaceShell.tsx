import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  CheckCircle2,
  ClipboardList,
  FilePlus2,
  HeartHandshake,
  Info,
  ListChecks,
  Loader2,
  LogOut,
  Mail,
  Menu,
  Search,
  Users,
  X,
} from 'lucide-react';
import {
  CANONICAL_STARTER_DEPARTMENTS,
  fetchWorkspaceSnapshotViaApi,
  markAllNotificationsRead,
  markNotificationRead,
  seedStarterDepartmentsIfEmpty,
  subscribeToCivicRealtime,
  syncMissingPublicReports,
  syncOperationalAlertsAndEscalations,
  validateNonDummyEmailClient,
} from '../lib/civicService';
import {
  evaluateOperationalAlerts,
  isReportAwaitingSupervisorVerification,
} from '../lib/operationsEngine';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { LanguageSelector } from './LanguageSelector';
import { StatusIndicator, PriorityIndicator } from './StatusBadge';
import { formatTimestamp } from './WorkflowTimeline';
import { ReportSubmissionForm, type SubmissionRoutingInfo } from './ReportSubmissionForm';
import { ReportDetailView } from './ReportDetailView';
import { AdminAnalyticsView } from './AdminAnalyticsView';
import { OperationsBoardView } from './OperationsBoardView';
import { WorkforceManagementView } from './WorkforceManagementView';
import { AuthorityEmailSettingsView } from './AuthorityEmailSettingsView';
import { CommunityNgoView } from './CommunityNgoView';
import {
  CATEGORY_LABELS,
  STATUS_LABELS,
  type AiAnalysis,
  type AppNotification,
  type Assignment,
  type AuthorityEmailLog,
  type CitizenFeedback,
  type CivicActivity,
  type CivicReport,
  type Department,
  type DepartmentEmailSetting,
  type IssueCategory,
  type NgoOrganization,
  type OperationalAlertRecord,
  type ReportStatus,
  type ReportUpdate,
  type SlaPolicy,
  type UserProfile,
  type UserRole,
  type VolunteerProfile,
  type WorkerInvite,
} from '../types/civic';

type NavTab =
  | 'reports'
  | 'operations'
  | 'workforce'
  | 'submit'
  | 'assignments'
  | 'community'
  | 'analytics'
  | 'authority_emails'
  | 'notifications';

const ROLE_LABELS: Record<UserRole, string> = {
  citizen: 'Citizen',
  officer: 'Department Officer',
  worker: 'Field Worker',
  admin: 'Administrator',
};

function toMillis(ts: any): number {
  if (!ts) return 0;
  if (typeof ts?.toMillis === 'function') return ts.toMillis();
  if (typeof ts?.toDate === 'function') return ts.toDate().getTime();
  const parsed = Date.parse(String(ts));
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function WorkspaceShell() {
  const {
    user,
    profile,
    effectiveRole,
    previewRole,
    setPreviewRole,
    bootstrapNotice,
    gmailConnected,
    connectingGmail,
    connectGmail,
    getIdToken,
    signOut,
  } = useAuth();
  const {
    t,
    tRole,
    tStatus,
    tCategory,
    tAssignmentStatus,
    tNotificationType,
    tDepartmentName,
    tError,
    locale,
  } = useLanguage();
  const [gmailSidebarError, setGmailSidebarError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<NavTab>('reports');
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [reports, setReports] = useState<CivicReport[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [staffUsers, setStaffUsers] = useState<UserProfile[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [slaPolicies, setSlaPolicies] = useState<SlaPolicy[]>([]);
  const [operationalAlerts, setOperationalAlerts] = useState<OperationalAlertRecord[]>([]);
  const [workerInvites, setWorkerInvites] = useState<WorkerInvite[]>([]);
  const [allFeedbacks, setAllFeedbacks] = useState<CitizenFeedback[]>([]);
  const [allAiAnalyses, setAllAiAnalyses] = useState<AiAnalysis[]>([]);
  const [allReportUpdates, setAllReportUpdates] = useState<ReportUpdate[]>([]);
  const [departmentEmailSettings, setDepartmentEmailSettings] = useState<DepartmentEmailSetting[]>([]);
  const [authorityEmailLogs, setAuthorityEmailLogs] = useState<AuthorityEmailLog[]>([]);
  const [ngoOrganizations, setNgoOrganizations] = useState<NgoOrganization[]>([]);
  const [volunteerProfile, setVolunteerProfile] = useState<VolunteerProfile | null>(null);
  const [civicActivities, setCivicActivities] = useState<CivicActivity[]>([]);
  const [joinedActivityIds, setJoinedActivityIds] = useState<Set<string>>(new Set());

  const [markingAllRead, setMarkingAllRead] = useState(false);
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);
  const [submissionConfirmation, setSubmissionConfirmation] = useState<{
    reportId: string;
    trackingCode: string;
    routingInfo?: SubmissionRoutingInfo;
  } | null>(null);
  const syncedAlertKeysRef = useRef<Set<string>>(new Set());
  const syncedPublicReportsRef = useRef<boolean>(false);

  // Filters & search
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<ReportStatus | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<IssueCategory | 'all'>('all');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (window.location.hash) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, []);

  useEffect(() => {
    if (!profile) return;
    let active = true;
    setDataLoading(true);
    setDataError(null);

    const realRole = profile.role;

    const loadWorkspace = async (isInitial: boolean) => {
      try {
        if (isInitial && realRole === 'admin') {
          await seedStarterDepartmentsIfEmpty(profile.uid).catch(() => {});
        }
        const token = await getIdToken().catch(() => null);
        if (!active) return;
        const snapshot = await fetchWorkspaceSnapshotViaApi(token || undefined);
        if (!active) return;

        const sortedDepts = [...snapshot.departments].sort((a, b) => a.name.localeCompare(b.name));
        const sortedReports = [...snapshot.reports].sort(
          (a, b) => toMillis(b.updatedAt) - toMillis(a.updatedAt)
        );
        const sortedAssignments = [...snapshot.assignments].sort(
          (a, b) => toMillis(b.updatedAt) - toMillis(a.updatedAt)
        );
        const sortedStaff = [...snapshot.staffUsers].sort((a, b) =>
          a.displayName.localeCompare(b.displayName)
        );
        const sortedNotifs = [...snapshot.notifications].sort(
          (a, b) => toMillis(b.createdAt) - toMillis(a.createdAt)
        );
        const sortedAlerts = [...snapshot.operationalAlerts].sort(
          (a, b) => toMillis(b.createdAt) - toMillis(a.createdAt)
        );
        const sortedInvites = [...snapshot.workerInvites].sort(
          (a, b) => toMillis(b.createdAt) - toMillis(a.createdAt)
        );
        const sortedFeedbacks = [...snapshot.allFeedbacks].sort(
          (a, b) => toMillis(b.createdAt) - toMillis(a.createdAt)
        );
        const sortedUpdates = [...snapshot.allReportUpdates].sort(
          (a, b) => toMillis(a.createdAt) - toMillis(b.createdAt)
        );
        const sortedEmailSettings = [...snapshot.departmentEmailSettings].sort((a, b) =>
          a.departmentName.localeCompare(b.departmentName)
        );
        const sortedEmailLogs = [...snapshot.authorityEmailLogs].sort(
          (a, b) => toMillis(b.createdAt) - toMillis(a.createdAt)
        );
        const sortedNgos = [...snapshot.ngoOrganizations].sort(
          (a, b) => toMillis(b.createdAt) - toMillis(a.createdAt)
        );
        const sortedActivities = [...snapshot.civicActivities].sort(
          (a, b) => toMillis(b.createdAt) - toMillis(a.createdAt)
        );

        setDepartments(sortedDepts);
        setReports(sortedReports);
        setAssignments(sortedAssignments);
        setStaffUsers(sortedStaff.length > 0 ? sortedStaff : [profile]);
        setNotifications(sortedNotifs);
        setSlaPolicies(snapshot.slaPolicies);
        setOperationalAlerts(sortedAlerts);
        setWorkerInvites(sortedInvites);
        setAllFeedbacks(sortedFeedbacks);
        setAllAiAnalyses(snapshot.allAiAnalyses);
        setAllReportUpdates(sortedUpdates);
        setDepartmentEmailSettings(sortedEmailSettings);
        setAuthorityEmailLogs(sortedEmailLogs);
        setNgoOrganizations(sortedNgos);
        setVolunteerProfile(snapshot.volunteerProfile);
        setCivicActivities(sortedActivities);
        setJoinedActivityIds(new Set(snapshot.joinedActivityIds));
        setDataError(null);
        setDataLoading(false);

        if (realRole === 'admin' && !syncedPublicReportsRef.current && sortedReports.length > 0) {
          syncedPublicReportsRef.current = true;
          syncMissingPublicReports(sortedReports).catch(() => {});
        }
      } catch (err: unknown) {
        if (!active) return;
        setDataLoading(false);
        setDataError(
          err instanceof Error ? tError(err.message) : t('workspace.loadFailed')
        );
      }
    };

    void loadWorkspace(true);

    const unsubscribeRealtime = subscribeToCivicRealtime(
      `workspace_${profile.uid}`,
      [
        'reports',
        'assignments',
        'notifications',
        'departments',
        'profiles',
        'worker_invites',
        'operational_alerts',
        'sla_policies',
        'department_email_settings',
        'authority_email_logs',
        'ngo_organizations',
        'civic_activities',
        'activity_participants',
        'volunteer_profiles',
      ],
      () => {
        if (active) void loadWorkspace(false);
      }
    );

    const pollTimer = window.setInterval(() => {
      if (active) void loadWorkspace(false);
    }, 30_000);

    return () => {
      active = false;
      unsubscribeRealtime();
      window.clearInterval(pollTimer);
    };
  }, [profile?.uid, profile?.role, getIdToken]);

  // Automatic deduplicated operational alert sync for Admin/Officer
  useEffect(() => {
    if (!profile || dataLoading) return;
    if (profile.role !== 'admin' && profile.role !== 'officer') return;
    if (reports.length === 0) return;

    const candidates = evaluateOperationalAlerts(
      reports,
      assignments,
      slaPolicies,
      staffUsers
    );
    const existingIds = new Set(operationalAlerts.map((a) => a.id));
    const unseen = candidates.filter((c) => {
      const safeId = c.alertKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
      return !existingIds.has(safeId) && !syncedAlertKeysRef.current.has(safeId);
    });
    if (unseen.length === 0) return;

    for (const c of unseen) {
      syncedAlertKeysRef.current.add(c.alertKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120));
    }
    syncOperationalAlertsAndEscalations({
      candidates: unseen,
      existingAlerts: operationalAlerts,
    }).catch(() => {});
  }, [profile, dataLoading, reports, assignments, slaPolicies, staffUsers, operationalAlerts]);

  // Scope visible reports according to effectiveRole (so Admin Role Preview works authentically)
  const roleScopedReports = useMemo(() => {
    if (!profile) return [];
    if (effectiveRole === 'admin') return reports;
    if (effectiveRole === 'citizen') {
      return reports.filter((r) => r.reporterId === profile.uid);
    }
    if (effectiveRole === 'worker') {
      return reports.filter((r) => r.assignedWorkerId === profile.uid);
    }
    if (effectiveRole === 'officer') {
      return reports.filter(
        (r) =>
          r.authorizedOfficerIds.includes(profile.uid) ||
          (profile.departmentId && r.departmentId === profile.departmentId)
      );
    }
    return reports;
  }, [reports, profile, effectiveRole]);

  const roleScopedAssignments = useMemo(() => {
    if (!profile) return [];
    if (effectiveRole === 'admin') return assignments;
    if (effectiveRole === 'worker') {
      return assignments.filter((a) => a.workerId === profile.uid);
    }
    if (effectiveRole === 'officer') {
      return assignments.filter(
        (a) =>
          a.authorizedOfficerIds.includes(profile.uid) ||
          (profile.departmentId && a.departmentId === profile.departmentId)
      );
    }
    return [];
  }, [assignments, profile, effectiveRole]);

  const navItems = useMemo(() => {
    const unread = notifications.filter((n) => !n.read).length;
    const notifLabel =
      unread > 0 ? t('nav.notificationsCount', { count: unread }) : t('nav.notifications');
    if (effectiveRole === 'citizen') {
      return [
        { id: 'reports' as NavTab, label: t('nav.myReports'), Icon: ClipboardList },
        { id: 'submit' as NavTab, label: t('nav.submitIssue'), Icon: FilePlus2 },
        { id: 'community' as NavTab, label: t('nav.ngoVolunteers'), Icon: HeartHandshake },
        {
          id: 'notifications' as NavTab,
          label: notifLabel,
          Icon: Bell,
        },
      ];
    }
    if (effectiveRole === 'worker') {
      return [
        { id: 'reports' as NavTab, label: t('nav.assignedTasks'), Icon: ClipboardList },
        { id: 'workforce' as NavTab, label: t('nav.fieldStatusTasks'), Icon: Users },
        { id: 'assignments' as NavTab, label: t('nav.assignments'), Icon: ListChecks },
        { id: 'community' as NavTab, label: t('nav.ngoVolunteers'), Icon: HeartHandshake },
        {
          id: 'notifications' as NavTab,
          label: notifLabel,
          Icon: Bell,
        },
      ];
    }
    if (effectiveRole === 'officer') {
      return [
        { id: 'reports' as NavTab, label: t('nav.departmentQueue'), Icon: ClipboardList },
        { id: 'operations' as NavTab, label: t('nav.operationsBoard'), Icon: Activity },
        { id: 'workforce' as NavTab, label: t('nav.fieldWorkforce'), Icon: Users },
        { id: 'assignments' as NavTab, label: t('nav.assignments'), Icon: ListChecks },
        { id: 'community' as NavTab, label: t('nav.ngoVolunteers'), Icon: HeartHandshake },
        {
          id: 'notifications' as NavTab,
          label: notifLabel,
          Icon: Bell,
        },
      ];
    }
    // Admin full dashboard
    return [
      { id: 'reports' as NavTab, label: t('nav.allReports'), Icon: ClipboardList },
      { id: 'operations' as NavTab, label: t('nav.operationsBoard'), Icon: Activity },
      { id: 'workforce' as NavTab, label: t('nav.fieldWorkforce'), Icon: Users },
      { id: 'submit' as NavTab, label: t('nav.submitIssue'), Icon: FilePlus2 },
      { id: 'assignments' as NavTab, label: t('nav.assignments'), Icon: ListChecks },
      { id: 'community' as NavTab, label: t('nav.ngoVolunteers'), Icon: HeartHandshake },
      { id: 'analytics' as NavTab, label: t('nav.analyticsGovernance'), Icon: BarChart3 },
      { id: 'authority_emails' as NavTab, label: t('nav.authorityEmails'), Icon: Mail },
      {
        id: 'notifications' as NavTab,
        label: notifLabel,
        Icon: Bell,
      },
    ];
  }, [effectiveRole, notifications, t]);

  useEffect(() => {
    if (!navItems.some((item) => item.id === activeTab)) {
      setActiveTab('reports');
      setSelectedReportId(null);
    }
  }, [navItems, activeTab]);

  const selectedReport = useMemo(
    () => reports.find((r) => r.id === selectedReportId) || null,
    [reports, selectedReportId]
  );

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications]
  );

  const latestAssignmentByReportId = useMemo(() => {
    const map = new Map<string, Assignment>();
    for (const a of assignments) {
      if (!map.has(a.reportId)) map.set(a.reportId, a);
    }
    return map;
  }, [assignments]);

  const filteredReports = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return roleScopedReports.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (categoryFilter !== 'all' && r.category !== categoryFilter) return false;
      if (q) {
        const hay = `${r.trackingCode} ${r.title} ${r.addressText} ${r.departmentName || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [roleScopedReports, searchQuery, statusFilter, categoryFilter]);

  const kpis = useMemo(() => {
    const total = roleScopedReports.length;
    const pendingReview = roleScopedReports.filter(
      (r) => r.status === 'submitted' || r.status === 'under_review' || r.status === 'reopened'
    ).length;
    const activeField = roleScopedReports.filter(
      (r) => r.status === 'verified' || r.status === 'assigned' || r.status === 'in_progress'
    ).length;
    const completed = roleScopedReports.filter(
      (r) => r.status === 'resolved' || r.status === 'citizen_confirmed'
    ).length;
    return { total, pendingReview, activeField, completed };
  }, [roleScopedReports]);

  const unconfiguredAuthorityCount = useMemo(() => {
    if (profile?.role !== 'admin') return 0;
    const settingsMap = new Map(departmentEmailSettings.map((s) => [s.departmentId, s]));
    const deptIds = new Set<string>([
      ...CANONICAL_STARTER_DEPARTMENTS.map((d) => d.id),
      ...departments.filter((d) => d.active).map((d) => d.id),
    ]);
    let missing = 0;
    for (const id of deptIds) {
      const s = settingsMap.get(id);
      if (!s || !s.officialAuthorityEmail || !validateNonDummyEmailClient(s.officialAuthorityEmail, false).valid) {
        missing += 1;
      }
    }
    return missing;
  }, [profile?.role, departmentEmailSettings, departments]);

  const handleNavClick = (tab: NavTab) => {
    if (tab === 'submit') {
      setSubmissionConfirmation(null);
    }
    setActiveTab(tab);
    setSelectedReportId(null);
    setMobileNavOpen(false);
  };

  const viewTitle =
    effectiveRole === 'citizen'
      ? t('workspace.viewTitleCitizen')
      : effectiveRole === 'officer'
        ? t('workspace.viewTitleOfficer')
        : effectiveRole === 'worker'
          ? t('workspace.viewTitleWorker')
          : t('workspace.viewTitleAdmin');

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Mobile Sidebar Backdrop */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 bg-slate-900/40 z-30 lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      {/* Left Sidebar (256px) */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-white border-r border-slate-200 flex flex-col transition-transform duration-200 lg:static lg:translate-x-0 ${
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <span className="text-lg font-bold tracking-tight text-slate-900">CivicFix AI</span>
            <p className="text-[11px] font-medium text-blue-700 mt-0.5">
              {t('workspace.roleDashboard', { role: tRole(effectiveRole) })}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setMobileNavOpen(false)}
            aria-label={t('workspace.closeNav')}
            className="lg:hidden p-1 text-slate-500 hover:text-slate-900"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 p-3 space-y-1 overflow-y-auto" aria-label={t('workspace.primaryNavAria')}>
          {navItems.map((item) => {
            const Icon = item.Icon;
            const isActive = activeTab === item.id && !selectedReport;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavClick(item.id)}
                className={`w-full min-h-[42px] flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left ${
                  isActive
                    ? 'bg-blue-50 text-blue-800 border border-blue-200'
                    : 'text-slate-700 hover:bg-slate-100 border border-transparent'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Admin Role Preview Switcher + User Footer */}
        <div className="p-4 border-t border-slate-200 space-y-3">
          {profile?.role === 'admin' && (
            <div className="space-y-1">
              <label
                htmlFor="admin-role-preview"
                className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider"
              >
                {t('workspace.adminRolePreview')}
              </label>
              <select
                id="admin-role-preview"
                value={previewRole || 'admin'}
                onChange={(e) => {
                  const val = e.target.value as UserRole;
                  setPreviewRole(val === 'admin' ? null : val);
                  setSelectedReportId(null);
                }}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-800"
              >
                <option value="admin">{t('workspace.adminFullAccess')}</option>
                <option value="citizen">{t('workspace.citizenView')}</option>
                <option value="officer">{t('workspace.officerView')}</option>
                <option value="worker">{t('workspace.workerView')}</option>
              </select>
            </div>
          )}

          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-900 truncate">
              {profile?.displayName || t('common.civicUser')}
            </p>
            <p className="text-xs text-slate-500 truncate">
              {user?.email || tRole(profile?.role || 'citizen')}
            </p>
          </div>

          <div className="space-y-1.5">
            <button
              type="button"
              disabled={connectingGmail}
              onClick={async () => {
                setGmailSidebarError(null);
                try {
                  await connectGmail();
                } catch (err: unknown) {
                  setGmailSidebarError(
                    err instanceof Error ? tError(err.message) : t('workspace.gmailConnectFailed')
                  );
                }
              }}
              className={`w-full min-h-[38px] inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap ${
                gmailConnected
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                  : 'border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100'
              } disabled:opacity-60`}
            >
              {connectingGmail ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden="true" />
              ) : gmailConnected ? (
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <Mail className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              )}
              <span>
                {connectingGmail
                  ? t('workspace.connectingGmail')
                  : gmailConnected
                    ? t('workspace.gmailConnected')
                    : t('workspace.connectGmail')}
              </span>
            </button>
            {gmailSidebarError && (
              <p role="alert" className="text-[11px] text-rose-700 leading-snug">
                {gmailSidebarError}
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={signOut}
            className="w-full min-h-[38px] inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{t('workspace.signOut')}</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-3 sm:px-6 py-3 flex items-center justify-between gap-2 sm:gap-4">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label={t('workspace.openNav')}
              className="lg:hidden p-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 shrink-0"
            >
              <Menu className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0 truncate">
              <span className="font-medium text-slate-500 hidden sm:inline">CivicFix AI</span>
              <span className="text-slate-300 hidden sm:inline" aria-hidden="true">
                /
              </span>
              <span className="font-semibold text-slate-900 truncate">
                {selectedReport
                  ? selectedReport.trackingCode
                  : navItems.find((n) => n.id === activeTab)?.label || viewTitle}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <LanguageSelector compact />

            <button
              type="button"
              onClick={() => handleNavClick('notifications')}
              aria-label={t('workspace.openNotifications')}
              className="relative inline-flex items-center p-2 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 transition-colors shrink-0"
            >
              <Bell className="w-4 h-4" />
              {unreadCount > 0 && (
                <span className="ml-1 font-mono tabular-nums text-xs font-semibold text-blue-700">
                  {unreadCount}
                </span>
              )}
            </button>

            {(effectiveRole === 'citizen' || effectiveRole === 'admin') && (
              <button
                type="button"
                onClick={() => handleNavClick('submit')}
                className="inline-flex items-center gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-medium transition-colors whitespace-nowrap shrink-0"
              >
                <FilePlus2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden xs:inline sm:inline">{t('workspace.reportIssue')}</span>
              </button>
            )}
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 max-w-7xl w-full mx-auto">
          {bootstrapNotice && (
            <div
              role="status"
              className="mb-6 p-3.5 rounded-xl bg-blue-50 border border-blue-200 text-xs sm:text-sm text-blue-950 flex items-start gap-2.5"
            >
              <Info className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{bootstrapNotice}</span>
            </div>
          )}

          {dataError && (
            <div className="mb-6 p-3.5 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-800 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{dataError}</span>
            </div>
          )}

          {profile?.role === 'admin' &&
            effectiveRole === 'admin' &&
            activeTab !== 'authority_emails' &&
            !dataLoading &&
            unconfiguredAuthorityCount > 0 && (
              <div
                role="status"
                className="mb-6 p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-950 flex flex-wrap items-center justify-between gap-3"
              >
                <div className="flex items-start gap-2.5 text-xs sm:text-sm">
                  <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>
                    {t('workspace.unconfiguredAuthorityBanner', {
                      count: unconfiguredAuthorityCount,
                    })}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleNavClick('authority_emails')}
                  className="px-3 py-1.5 rounded-lg bg-amber-800 text-white text-xs font-medium hover:bg-amber-900 whitespace-nowrap shrink-0"
                >
                  {t('workspace.configureAuthorityEmails')}
                </button>
              </div>
            )}

          {submissionConfirmation && activeTab !== 'submit' && (() => {
            const emailWarning =
              submissionConfirmation.routingInfo &&
              (submissionConfirmation.routingInfo.authorityEmailStatus === 'not_configured' ||
                submissionConfirmation.routingInfo.authorityEmailStatus === 'smtp_not_configured' ||
                submissionConfirmation.routingInfo.authorityEmailStatus === 'failed');
            return (
              <div
                role="status"
                className={`mb-6 p-4 rounded-xl border flex flex-wrap items-start justify-between gap-3 ${
                  emailWarning
                    ? 'bg-amber-50 border-amber-200 text-amber-950'
                    : 'bg-emerald-50 border-emerald-200 text-emerald-950'
                }`}
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  {emailWarning ? (
                    <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
                  ) : (
                    <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" aria-hidden="true" />
                  )}
                  <div className="space-y-1 text-sm">
                    <div className="font-semibold flex flex-wrap items-center gap-2">
                      <span>{t('workspace.reportSubmittedSuccess')}</span>
                      <span
                        className={`font-mono text-xs px-2 py-0.5 rounded bg-white border ${
                          emailWarning
                            ? 'border-amber-300 text-amber-900'
                            : 'border-emerald-300 text-emerald-900'
                        }`}
                      >
                        {t('common.trackingId')}: {submissionConfirmation.trackingCode}
                      </span>
                    </div>
                    <p className={`text-xs ${emailWarning ? 'text-amber-900' : 'text-emerald-900'}`}>
                      {submissionConfirmation.routingInfo
                        ? `${t('workspace.routingSummary', {
                            dept: tDepartmentName(
                              submissionConfirmation.routingInfo.departmentId,
                              submissionConfirmation.routingInfo.departmentName
                            ),
                            notifStatus: submissionConfirmation.routingInfo.citizenNotificationStatus,
                            emailStatus:
                              submissionConfirmation.routingInfo.authorityEmailStatus === 'not_configured'
                                ? t('workspace.authorityEmailNotConfiguredAlert')
                                : submissionConfirmation.routingInfo.authorityEmailStatus === 'sent'
                                  ? t('workspace.authorityEmailSent')
                                  : submissionConfirmation.routingInfo.authorityEmailStatusNote,
                          })}${
                            submissionConfirmation.routingInfo.citizenEmailSent &&
                            submissionConfirmation.routingInfo.citizenEmailNote
                              ? ` · ${submissionConfirmation.routingInfo.citizenEmailNote}`
                              : ''
                          }`
                        : t('workspace.reportSubmittedFallback')}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {selectedReportId !== submissionConfirmation.reportId && (
                    <button
                      type="button"
                      onClick={() => {
                        setActiveTab('reports');
                        setSelectedReportId(submissionConfirmation.reportId);
                      }}
                      className={`px-3 py-1.5 rounded-lg text-white text-xs font-medium ${
                        emailWarning
                          ? 'bg-amber-800 hover:bg-amber-900'
                          : 'bg-emerald-700 hover:bg-emerald-800'
                      }`}
                    >
                      {t('workspace.viewReport')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setSubmissionConfirmation(null)}
                    aria-label={t('workspace.dismissConfirmation')}
                    className={`p-1 ${
                      emailWarning
                        ? 'text-amber-700 hover:text-amber-950'
                        : 'text-emerald-700 hover:text-emerald-950'
                    }`}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })()}

          {selectedReport ? (
            <ReportDetailView
              key={selectedReport.id}
              report={selectedReport}
              allReports={roleScopedReports}
              assignments={roleScopedAssignments}
              slaPolicies={slaPolicies}
              departments={departments}
              staffUsers={staffUsers}
              onBack={() => setSelectedReportId(null)}
              onSelectReport={(id) => setSelectedReportId(id)}
            />
          ) : activeTab === 'operations' && profile && (effectiveRole === 'admin' || effectiveRole === 'officer') ? (
            <OperationsBoardView
              reports={roleScopedReports}
              assignments={roleScopedAssignments}
              departments={departments}
              staffUsers={staffUsers}
              slaPolicies={slaPolicies}
              operationalAlerts={operationalAlerts}
              profile={profile}
              effectiveRole={effectiveRole}
              getIdToken={getIdToken}
              onSelectReport={(id) => setSelectedReportId(id)}
            />
          ) : activeTab === 'workforce' && profile && effectiveRole !== 'citizen' ? (
            <WorkforceManagementView
              profile={profile}
              effectiveRole={effectiveRole}
              reports={roleScopedReports}
              assignments={roleScopedAssignments}
              departments={departments}
              staffUsers={staffUsers}
              workerInvites={workerInvites}
              slaPolicies={slaPolicies}
              getIdToken={getIdToken}
              onSelectReport={(id) => setSelectedReportId(id)}
            />
          ) : activeTab === 'submit' ? (
            <ReportSubmissionForm
              departments={departments}
              onSubmitted={(newId, trackingCode, routingInfo) => {
                setSubmissionConfirmation({ reportId: newId, trackingCode, routingInfo });
                setActiveTab('reports');
                setSelectedReportId(newId);
              }}
              onCancel={() => handleNavClick('reports')}
            />
          ) : activeTab === 'community' && profile ? (
            <CommunityNgoView
              profile={profile}
              effectiveRole={effectiveRole}
              reports={roleScopedReports}
              ngos={ngoOrganizations}
              volunteerProfile={volunteerProfile}
              activities={civicActivities}
              joinedActivityIds={joinedActivityIds}
              getIdToken={getIdToken}
              onMembershipChanged={(activityId, joined) => {
                setJoinedActivityIds((prev) => {
                  const next = new Set(prev);
                  if (joined) next.add(activityId);
                  else next.delete(activityId);
                  return next;
                });
              }}
            />
          ) : activeTab === 'analytics' && effectiveRole === 'admin' ? (
            <AdminAnalyticsView
              reports={reports}
              departments={departments}
              users={staffUsers}
              feedbacks={allFeedbacks}
              aiAnalyses={allAiAnalyses}
              reportUpdates={allReportUpdates}
              assignments={assignments}
              onSelectReport={(id) => {
                setActiveTab('reports');
                setSelectedReportId(id);
              }}
            />
          ) : activeTab === 'authority_emails' && effectiveRole === 'admin' ? (
            <AuthorityEmailSettingsView
              departments={departments}
              settingsFromStore={departmentEmailSettings}
              logsFromStore={authorityEmailLogs}
              getIdToken={getIdToken}
              onSelectReport={(id) => {
                setActiveTab('reports');
                setSelectedReportId(id);
              }}
            />
          ) : activeTab === 'assignments' && effectiveRole !== 'citizen' ? (
            <section className="space-y-4">
              <div className="border-b border-slate-200 pb-4">
                <h1 className="text-2xl font-semibold text-slate-900">{t('workspace.assignmentsTitle')}</h1>
                <p className="text-sm text-slate-600 mt-1">
                  {t('workspace.assignmentsSubtitle')}
                </p>
              </div>
              {roleScopedAssignments.length === 0 ? (
                <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-2">
                  <ListChecks className="w-8 h-8 text-slate-300 mx-auto" aria-hidden="true" />
                  <p className="text-sm font-medium text-slate-900">{t('workspace.noAssignmentsTitle')}</p>
                  <p className="text-xs text-slate-500">
                    {t('workspace.noAssignmentsDesc')}
                  </p>
                </div>
              ) : (
                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-xs text-slate-600">
                          <th className="py-3 px-5 font-medium">{t('workspace.colTrackingIssue')}</th>
                          <th className="py-3 px-4 font-medium">{t('common.department')}</th>
                          <th className="py-3 px-4 font-medium">{t('workspace.colFieldWorker')}</th>
                          <th className="py-3 px-4 font-medium">{t('common.status')}</th>
                          <th className="py-3 px-5 font-medium text-right">{t('common.updated')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {roleScopedAssignments.map((asg) => (
                          <tr
                            key={asg.id}
                            onClick={() => setSelectedReportId(asg.reportId)}
                            className="hover:bg-slate-50 cursor-pointer"
                          >
                            <td className="py-3 px-5">
                              <span className="font-mono text-xs text-blue-700 font-medium">
                                {asg.trackingCode}
                              </span>
                              <div className="font-medium text-slate-900 truncate max-w-md">
                                {asg.reportTitle}
                              </div>
                            </td>
                            <td className="py-3 px-4 text-xs text-slate-700 whitespace-nowrap">
                              {tDepartmentName(asg.departmentId, asg.departmentName)}
                            </td>
                            <td className="py-3 px-4 text-xs text-slate-700 whitespace-nowrap">
                              {asg.workerName || t('assignmentStatus.pending_worker')}
                            </td>
                            <td className="py-3 px-4 text-xs font-medium text-slate-800 whitespace-nowrap">
                              {tAssignmentStatus(asg.status)}
                            </td>
                            <td className="py-3 px-5 text-right font-mono text-xs tabular-nums text-slate-500 whitespace-nowrap">
                              {formatTimestamp(asg.updatedAt, locale)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>
          ) : activeTab === 'notifications' ? (
            <section className="space-y-4">
              <div className="border-b border-slate-200 pb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h1 className="text-2xl font-semibold text-slate-900">{t('workspace.notificationsTitle')}</h1>
                  <p className="text-sm text-slate-600 mt-1">
                    {t('workspace.notificationsSubtitle')}
                  </p>
                </div>
                {unreadCount > 0 && (
                  <button
                    type="button"
                    disabled={markingAllRead}
                    onClick={async () => {
                      setMarkingAllRead(true);
                      try {
                        const unreadIds = notifications.filter((n) => !n.read).map((n) => n.id);
                        await markAllNotificationsRead(unreadIds);
                      } finally {
                        setMarkingAllRead(false);
                      }
                    }}
                    className="px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {markingAllRead
                      ? t('workspace.markingRead')
                      : t('workspace.markAllRead', { count: unreadCount })}
                  </button>
                )}
              </div>

              {notifications.length === 0 ? (
                <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-2">
                  <Bell className="w-8 h-8 text-slate-300 mx-auto" aria-hidden="true" />
                  <p className="text-sm font-medium text-slate-900">{t('workspace.allCaughtUp')}</p>
                  <p className="text-xs text-slate-500">
                    {t('workspace.noNotificationsDesc')}
                  </p>
                </div>
              ) : (
                <ul className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
                  {notifications.map((n) => (
                    <li
                      key={n.id}
                      className={`p-4 flex flex-wrap items-center justify-between gap-3 ${
                        n.read ? 'bg-white' : 'bg-blue-50/40'
                      }`}
                    >
                      <div className="space-y-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-semibold text-slate-900">{n.title}</span>
                          <span className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-[10px] font-medium text-slate-600 whitespace-nowrap">
                            {tNotificationType(n.type)}
                          </span>
                          {!n.read && (
                            <span className="text-xs font-medium text-blue-700">
                              {t('workspace.unread')}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-600">{n.message}</p>
                        <p className="text-xs font-mono tabular-nums text-slate-400">
                          {formatTimestamp(n.createdAt, locale)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {!n.read && (
                          <button
                            type="button"
                            onClick={() => markNotificationRead(n.id)}
                            className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            {t('workspace.markRead')}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            if (!n.read) markNotificationRead(n.id);
                            setSelectedReportId(n.reportId);
                          }}
                          className="px-3 py-1.5 rounded-lg bg-blue-700 text-white text-xs font-medium hover:bg-blue-800"
                        >
                          {t('workspace.viewReport')}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : (
            /* Default Role-Scoped Reports Table */
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
                <div>
                  <h1 className="text-2xl font-bold tracking-tight text-slate-900">{viewTitle}</h1>
                  <p className="text-sm text-slate-600 mt-0.5">
                    {effectiveRole === 'citizen'
                      ? t('workspace.viewDescCitizen')
                      : effectiveRole === 'officer'
                        ? t('workspace.viewDescOfficer')
                        : effectiveRole === 'worker'
                          ? t('workspace.viewDescWorker')
                          : t('workspace.viewDescAdmin')}
                  </p>
                </div>
              </div>

              {/* KPI Strip */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <p className="text-xs text-slate-500">{t('workspace.kpiTotalReports')}</p>
                  <p className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900">
                    {kpis.total}
                  </p>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <p className="text-xs text-slate-500">{t('workspace.kpiPendingReview')}</p>
                  <p className="mt-1 text-2xl font-bold font-mono tabular-nums text-amber-700">
                    {kpis.pendingReview}
                  </p>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <p className="text-xs text-slate-500">{t('workspace.kpiDispatched')}</p>
                  <p className="mt-1 text-2xl font-bold font-mono tabular-nums text-blue-700">
                    {kpis.activeField}
                  </p>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <p className="text-xs text-slate-500">{t('workspace.kpiResolvedConfirmed')}</p>
                  <p className="mt-1 text-2xl font-bold font-mono tabular-nums text-emerald-700">
                    {kpis.completed}
                  </p>
                </div>
              </div>

              {/* Search & Filter Toolbar */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center gap-3">
                <div className="relative flex-1 min-w-[220px]">
                  <Search
                    className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2"
                    aria-hidden="true"
                  />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={t('workspace.searchPlaceholder')}
                    className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>

                <select
                  aria-label={t('workspace.filterByStatus')}
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as ReportStatus | 'all')}
                  className="px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white text-slate-800"
                >
                  <option value="all">{t('common.allStatuses')}</option>
                  {(Object.keys(STATUS_LABELS) as ReportStatus[]).map((st) => (
                    <option key={st} value={st}>
                      {tStatus(st)}
                    </option>
                  ))}
                </select>

                <select
                  aria-label={t('workspace.filterByCategory')}
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value as IssueCategory | 'all')}
                  className="px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white text-slate-800"
                >
                  <option value="all">{t('common.allCategories')}</option>
                  {(Object.keys(CATEGORY_LABELS) as IssueCategory[]).map((cat) => (
                    <option key={cat} value={cat}>
                      {tCategory(cat)}
                    </option>
                  ))}
                </select>

                {(searchQuery || statusFilter !== 'all' || categoryFilter !== 'all') && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setStatusFilter('all');
                      setCategoryFilter('all');
                    }}
                    className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    {t('common.resetFilters')}
                  </button>
                )}
              </div>

              {/* Reports Table */}
              {dataLoading ? (
                <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
                  {[1, 2, 3, 4].map((row) => (
                    <div key={row} className="p-4 flex items-center justify-between gap-4 animate-pulse">
                      <div className="space-y-2 flex-1">
                        <div className="h-3.5 w-32 bg-slate-200 rounded" />
                        <div className="h-4 w-72 bg-slate-200 rounded" />
                      </div>
                      <div className="h-6 w-24 bg-slate-200 rounded" />
                    </div>
                  ))}
                </div>
              ) : filteredReports.length === 0 ? (
                <div className="bg-white border border-slate-200 rounded-xl p-12 text-center space-y-3">
                  <CheckCircle2 className="w-8 h-8 text-slate-300 mx-auto" aria-hidden="true" />
                  <div className="space-y-1">
                    <h2 className="text-base font-semibold text-slate-900">
                      {t('workspace.noMatchingReports')}
                    </h2>
                    <p className="text-sm text-slate-500 max-w-md mx-auto">
                      {roleScopedReports.length === 0
                        ? effectiveRole === 'citizen'
                          ? t('workspace.submitFirstReportHint')
                          : t('workspace.emptyQueueHint')
                        : t('workspace.adjustFiltersHint')}
                    </p>
                  </div>
                  {(effectiveRole === 'citizen' || effectiveRole === 'admin') &&
                    roleScopedReports.length === 0 && (
                      <button
                        type="button"
                        onClick={() => handleNavClick('submit')}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-700 text-white text-sm font-medium hover:bg-blue-800"
                      >
                        <FilePlus2 className="w-4 h-4" aria-hidden="true" />
                        <span>{t('nav.submitIssue')}</span>
                      </button>
                    )}
                </div>
              ) : (
                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-xs text-slate-600">
                          <th className="py-3 px-5 font-medium">{t('workspace.colIssueLocation')}</th>
                          <th className="py-3 px-4 font-medium">{t('common.category')}</th>
                          <th className="py-3 px-4 font-medium">{t('common.department')}</th>
                          <th className="py-3 px-4 font-medium">{t('common.priority')}</th>
                          <th className="py-3 px-4 font-medium">{t('common.status')}</th>
                          <th className="py-3 px-5 font-medium text-right">{t('common.submitted')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {filteredReports.map((r) => (
                          <tr
                            key={r.id}
                            tabIndex={0}
                            role="button"
                            aria-label={`${r.trackingCode}: ${r.title}`}
                            onClick={() => setSelectedReportId(r.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                setSelectedReportId(r.id);
                              }
                            }}
                            className="hover:bg-slate-50 focus:bg-blue-50/40 focus:outline-none cursor-pointer transition-colors"
                          >
                            <td className="py-3 px-5">
                              <div className="flex items-center gap-2 text-xs text-slate-500">
                                <span className="font-mono tabular-nums font-medium text-slate-700">
                                  {r.trackingCode}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span className="truncate max-w-[200px]">{r.addressText}</span>
                              </div>
                              <div className="font-medium text-slate-900 mt-0.5 truncate max-w-md">
                                {r.title}
                              </div>
                              {r.rejectionReason && (
                                <p className="text-[11px] text-rose-700 mt-0.5 truncate max-w-md">
                                  {t('workspace.rejectionReason', { reason: r.rejectionReason })}
                                </p>
                              )}
                              {!r.rejectionReason && r.status === 'reopened' && r.reopenReason && (
                                <p className="text-[11px] text-orange-700 mt-0.5 truncate max-w-md">
                                  {t('workspace.reopenedReason', { reason: r.reopenReason })}
                                </p>
                              )}
                            </td>
                            <td className="py-3 px-4 text-xs text-slate-700 whitespace-nowrap">
                              <div>{tCategory(r.category)}</div>
                              {r.aiAnalysisId && (
                                <div className="text-[11px] text-blue-700">
                                  {t('workspace.aiTriageAttached')}
                                </div>
                              )}
                            </td>
                            <td className="py-3 px-4 text-xs text-slate-700 whitespace-nowrap">
                              {r.departmentName || r.departmentId
                                ? tDepartmentName(r.departmentId, r.departmentName)
                                : t('common.unassigned')}
                            </td>
                            <td className="py-3 px-4">
                              <PriorityIndicator priority={r.priority} />
                            </td>
                            <td className="py-3 px-4">
                              <div className="space-y-1">
                                <StatusIndicator status={r.status} />
                                {isReportAwaitingSupervisorVerification(
                                  r,
                                  latestAssignmentByReportId.get(r.id)
                                ) && (
                                  <div className="text-[11px] font-medium text-emerald-700">
                                    {t('workspace.needsSupervisorSignOff')}
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className="py-3 px-5 text-right font-mono text-xs tabular-nums whitespace-nowrap">
                              <div className="text-slate-700">{formatTimestamp(r.createdAt, locale)}</div>
                              <div className="text-[11px] text-slate-400">
                                {t('workspace.updatedAt', {
                                  time: formatTimestamp(r.updatedAt, locale),
                                })}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
