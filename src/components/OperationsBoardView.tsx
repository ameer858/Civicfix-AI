import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Clock,
  Info,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  SlidersHorizontal,
  UserCheck,
  Wrench,
} from 'lucide-react';
import {
  acknowledgeOperationalAlert,
  escalateOverdueReport,
  formatFriendlyError,
  saveSlaPolicy,
  syncOperationalAlertsAndEscalations,
} from '../lib/civicService';
import {
  categorizeOperationsBoard,
  DEFAULT_SLA_TARGETS,
  evaluateOperationalAlerts,
  formatDurationDelta,
} from '../lib/operationsEngine';
import { formatTimestamp } from './WorkflowTimeline';
import { PriorityIndicator, StatusIndicator } from './StatusBadge';
import { useLanguage } from '../context/LanguageContext';
import type { TranslationKey } from '../i18n/types';
import {
  CATEGORY_LABELS,
  type Assignment,
  type CivicReport,
  type DeadlineEvaluation,
  type Department,
  type IssueCategory,
  type OperationalAlertKind,
  type OperationalAlertRecord,
  type SlaPolicy,
  type SlaScopeType,
  type UserProfile,
  type UserRole,
  type WorkerAvailabilityStatus,
} from '../types/civic';

interface OperationsBoardViewProps {
  reports: CivicReport[];
  assignments: Assignment[];
  departments: Department[];
  staffUsers: UserProfile[];
  slaPolicies: SlaPolicy[];
  operationalAlerts: OperationalAlertRecord[];
  profile: UserProfile;
  effectiveRole: UserRole;
  getIdToken: () => Promise<string>;
  onSelectReport: (reportId: string) => void;
}

type LaneKey =
  | 'all_active'
  | 'newlySubmitted'
  | 'awaitingVerification'
  | 'unassigned'
  | 'assignedTasks'
  | 'inProgressTasks'
  | 'overdueTasks'
  | 'completedAwaitingVerification';

const LANE_META: Array<{
  key: Exclude<LaneKey, 'all_active'>;
  labelKey: TranslationKey;
  descKey: TranslationKey;
  accent: string;
}> = [
  {
    key: 'newlySubmitted',
    labelKey: 'ops.lane.newlySubmitted',
    descKey: 'ops.lane.newlySubmittedDesc',
    accent: 'text-slate-900',
  },
  {
    key: 'awaitingVerification',
    labelKey: 'ops.lane.awaitingVerification',
    descKey: 'ops.lane.awaitingVerificationDesc',
    accent: 'text-amber-700',
  },
  {
    key: 'unassigned',
    labelKey: 'ops.lane.unassigned',
    descKey: 'ops.lane.unassignedDesc',
    accent: 'text-blue-700',
  },
  {
    key: 'assignedTasks',
    labelKey: 'ops.lane.assignedTasks',
    descKey: 'ops.lane.assignedTasksDesc',
    accent: 'text-indigo-700',
  },
  {
    key: 'inProgressTasks',
    labelKey: 'ops.lane.inProgressTasks',
    descKey: 'ops.lane.inProgressTasksDesc',
    accent: 'text-blue-800',
  },
  {
    key: 'overdueTasks',
    labelKey: 'ops.lane.overdueTasks',
    descKey: 'ops.lane.overdueTasksDesc',
    accent: 'text-rose-700',
  },
  {
    key: 'completedAwaitingVerification',
    labelKey: 'ops.lane.completedAwaitingVerification',
    descKey: 'ops.lane.completedAwaitingVerificationDesc',
    accent: 'text-emerald-700',
  },
];

const ALERT_KIND_KEYS: Record<OperationalAlertKind, TranslationKey> = {
  high_priority_report: 'ops.alertKind.high_priority_report',
  unassigned_task: 'ops.alertKind.unassigned_task',
  deadline_approaching: 'ops.alertKind.deadline_approaching',
  deadline_overdue: 'ops.alertKind.deadline_overdue',
  worker_obstacle: 'ops.alertKind.worker_obstacle',
  completion_awaiting_verification: 'ops.alertKind.completion_awaiting_verification',
  reopened_report: 'ops.alertKind.reopened_report',
  authority_email_missing: 'ops.alertKind.authority_email_missing',
};

function DeadlinePill({ evaluation }: { evaluation?: DeadlineEvaluation }) {
  if (!evaluation) return null;
  if (evaluation.activeStage === 'completed') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-800 text-[11px] font-mono tabular-nums">
        <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
        {evaluation.activeRemainingLabel}
      </span>
    );
  }
  if (evaluation.isOverdue) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-rose-300 bg-rose-50 text-rose-800 text-[11px] font-mono tabular-nums font-semibold">
        <AlertOctagon className="w-3 h-3" aria-hidden="true" />
        {evaluation.activeRemainingLabel} ({evaluation.activeStage})
      </span>
    );
  }
  if (evaluation.isApproaching) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-amber-300 bg-amber-50 text-amber-900 text-[11px] font-mono tabular-nums font-medium">
        <Clock className="w-3 h-3" aria-hidden="true" />
        {evaluation.activeRemainingLabel} ({evaluation.activeStage})
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-800 text-[11px] font-mono tabular-nums">
      <Clock className="w-3 h-3" aria-hidden="true" />
      {evaluation.activeRemainingLabel} ({evaluation.activeStage})
    </span>
  );
}

export function OperationsBoardView({
  reports,
  assignments,
  departments,
  staffUsers,
  slaPolicies,
  operationalAlerts,
  profile,
  effectiveRole,
  getIdToken,
  onSelectReport,
}: OperationsBoardViewProps) {
  const { t, tCategory, tAvailability, tDepartmentName, tRole, tError } = useLanguage();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [selectedLane, setSelectedLane] = useState<LaneKey>('all_active');
  const [searchText, setSearchText] = useState('');
  const [deptFilter, setDeptFilter] = useState<string>('all');
  const [showSlaConfig, setShowSlaConfig] = useState(false);

  // Alert center state
  const [alertFilter, setAlertFilter] = useState<'unacknowledged' | 'all'>('unacknowledged');
  const [alertKindFilter, setAlertKindFilter] = useState<OperationalAlertKind | 'all'>('all');
  const [syncingAlerts, setSyncingAlerts] = useState(false);
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null);

  // Escalation action state
  const [escalatingId, setEscalatingId] = useState<string | null>(null);

  // SLA policy editor state
  const [policyScope, setPolicyScope] = useState<SlaScopeType>('department');
  const [policyDeptId, setPolicyDeptId] = useState(departments[0]?.id || '');
  const [policyCategory, setPolicyCategory] = useState<IssueCategory>('pothole');
  const [ackHours, setAckHours] = useState(String(DEFAULT_SLA_TARGETS.ackTargetHours));
  const [assignHours, setAssignHours] = useState(String(DEFAULT_SLA_TARGETS.assignTargetHours));
  const [resolveHours, setResolveHours] = useState(String(DEFAULT_SLA_TARGETS.resolveTargetHours));
  const [escalationRole, setEscalationRole] = useState<'officer' | 'admin'>('officer');
  const [savingPolicy, setSavingPolicy] = useState(false);

  const [bannerMsg, setBannerMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!policyDeptId && departments.length > 0) {
      setPolicyDeptId(departments[0].id);
    }
  }, [departments, policyDeptId]);

  const board = useMemo(
    () =>
      categorizeOperationsBoard(
        reports,
        assignments,
        slaPolicies,
        nowMs,
        departments,
        staffUsers
      ),
    [reports, assignments, slaPolicies, nowMs, departments, staffUsers]
  );

  const laneCounts: Record<Exclude<LaneKey, 'all_active'>, number> = {
    newlySubmitted: board.newlySubmitted.length,
    awaitingVerification: board.awaitingVerification.length,
    unassigned: board.unassigned.length,
    assignedTasks: board.assignedTasks.length,
    inProgressTasks: board.inProgressTasks.length,
    overdueTasks: board.overdueTasks.length,
    completedAwaitingVerification: board.completedAwaitingVerification.length,
  };

  const visibleReports = useMemo(() => {
    let base: CivicReport[] = [];
    if (selectedLane === 'all_active') {
      base = reports.filter(
        (r) => r.status !== 'citizen_confirmed' && r.status !== 'rejected' && r.status !== 'resolved'
      );
      // Include legacy resolved awaiting supervisor verification
      for (const r of board.completedAwaitingVerification) {
        if (!base.some((x) => x.id === r.id)) base.push(r);
      }
    } else {
      base = board[selectedLane];
    }

    const q = searchText.trim().toLowerCase();
    return base.filter((r) => {
      if (deptFilter !== 'all' && r.departmentId !== deptFilter) return false;
      if (q) {
        const hay = `${r.trackingCode} ${r.title} ${r.addressText} ${r.assignedWorkerName || ''} ${r.departmentName || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [selectedLane, reports, board, searchText, deptFilter]);

  const filteredAlerts = useMemo(() => {
    return operationalAlerts.filter((a) => {
      if (alertFilter === 'unacknowledged' && a.acknowledged) return false;
      if (alertKindFilter !== 'all' && a.kind !== alertKindFilter) return false;
      return true;
    });
  }, [operationalAlerts, alertFilter, alertKindFilter]);

  const unacknowledgedAlertCount = useMemo(
    () => operationalAlerts.filter((a) => !a.acknowledged).length,
    [operationalAlerts]
  );

  const handleSyncAlerts = async () => {
    setBannerMsg(null);
    setSyncingAlerts(true);
    try {
      const candidates = evaluateOperationalAlerts(
        reports,
        assignments,
        slaPolicies,
        staffUsers,
        Date.now()
      );
      const created = await syncOperationalAlertsAndEscalations({
        candidates,
        existingAlerts: operationalAlerts,
      });
      setBannerMsg({
        type: 'success',
        text:
          created > 0
            ? t('ops.alertsSynced', { count: created })
            : t('ops.alertsUpToDate'),
      });
    } catch (err) {
      setBannerMsg({ type: 'error', text: tError(formatFriendlyError(err)) });
    } finally {
      setSyncingAlerts(false);
    }
  };

  const handleQuickEscalate = async (report: CivicReport, e: React.MouseEvent) => {
    e.stopPropagation();
    setBannerMsg(null);
    setEscalatingId(report.id);
    try {
      const token = await getIdToken();
      const dl = board.deadlineByReportId[report.id];
      const supervisor =
        staffUsers.find((u) => u.active && u.role === 'officer' && u.departmentId === report.departmentId) ||
        staffUsers.find((u) => u.active && u.role === 'admin') ||
        null;
      await escalateOverdueReport({
        report,
        actor: profile,
        supervisor,
        reason: dl
          ? `Administrative ${dl.activeStage} target exceeded (${dl.activeRemainingLabel}). Escalated from Operations Board.`
          : 'Administrative response target exceeded. Escalated from Operations Board.',
        idToken: token,
      });
      setBannerMsg({
        type: 'success',
        text: t('ops.escalatedSuccess', {
          code: report.trackingCode,
          target: supervisor?.displayName || t('ops.supervisorReview'),
        }),
      });
    } catch (err) {
      setBannerMsg({ type: 'error', text: tError(formatFriendlyError(err)) });
    } finally {
      setEscalatingId(null);
    }
  };

  const handleSavePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    setBannerMsg(null);
    setSavingPolicy(true);
    try {
      const dept = departments.find((d) => d.id === policyDeptId);
      const needsDept = policyScope === 'department' || policyScope === 'department_category';
      const needsCat = policyScope === 'category' || policyScope === 'department_category';
      await saveSlaPolicy({
        scopeType: policyScope,
        departmentId: needsDept ? policyDeptId : '',
        departmentName: needsDept ? dept?.name || policyDeptId : '',
        category: needsCat ? policyCategory : '',
        ackTargetHours: Number(ackHours) || DEFAULT_SLA_TARGETS.ackTargetHours,
        assignTargetHours: Number(assignHours) || DEFAULT_SLA_TARGETS.assignTargetHours,
        resolveTargetHours: Number(resolveHours) || DEFAULT_SLA_TARGETS.resolveTargetHours,
        escalationRole,
        actorUid: profile.uid,
      });
      setBannerMsg({
        type: 'success',
        text: t('ops.slaPolicySaved'),
      });
    } catch (err) {
      setBannerMsg({ type: 'error', text: tError(formatFriendlyError(err)) });
    } finally {
      setSavingPolicy(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & SLA Config Toggle */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
            {t('ops.commandTitle')}
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            {t('ops.commandSubtitle')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleSyncAlerts}
            disabled={syncingAlerts}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncingAlerts ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>{syncingAlerts ? t('ops.checkingAlerts') : t('ops.runAlertSync')}</span>
          </button>

          {effectiveRole === 'admin' && (
            <button
              type="button"
              onClick={() => setShowSlaConfig((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium border transition-colors ${
                showSlaConfig
                  ? 'bg-blue-700 text-white border-blue-700'
                  : 'bg-white text-slate-800 border-slate-300 hover:bg-slate-50'
              }`}
            >
              <Settings2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{showSlaConfig ? t('ops.hideSlaTargets') : t('ops.configureTargets')}</span>
            </button>
          )}
        </div>
      </div>

      {/* Mandatory Administrative vs Statutory SLA Disclosure */}
      <div className="p-3.5 rounded-xl bg-slate-100 border border-slate-200 text-xs text-slate-700 flex items-start gap-2.5">
        <Info className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" aria-hidden="true" />
        <p>
          <strong>{t('ops.disclosureLabel')}</strong> {t('ops.disclosureBody')}
        </p>
      </div>

      {bannerMsg && (
        <div
          role={bannerMsg.type === 'error' ? 'alert' : 'status'}
          className={`p-3.5 rounded-lg border text-sm flex items-center gap-2 ${
            bannerMsg.type === 'error'
              ? 'bg-rose-50 border-rose-200 text-rose-800'
              : 'bg-emerald-50 border-emerald-200 text-emerald-900'
          }`}
        >
          {bannerMsg.type === 'error' ? (
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
          )}
          <span>{bannerMsg.text}</span>
        </div>
      )}

      {/* Admin SLA Configuration Drawer */}
      {effectiveRole === 'admin' && showSlaConfig && (
        <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-blue-700" aria-hidden="true" />
            <h2 className="text-base font-semibold text-slate-900">
              {t('ops.slaConfigHeading')}
            </h2>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <form onSubmit={handleSavePolicy} className="lg:col-span-6 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t('ops.policyScope')}
                  </label>
                  <select
                    value={policyScope}
                    onChange={(e) => setPolicyScope(e.target.value as SlaScopeType)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white"
                  >
                    <option value="global">{t('ops.scopeGlobal')}</option>
                    <option value="department">{t('ops.scopeDepartment')}</option>
                    <option value="category">{t('ops.scopeCategory')}</option>
                    <option value="department_category">{t('ops.scopeDeptCategory')}</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t('ops.escalationTargetRole')}
                  </label>
                  <select
                    value={escalationRole}
                    onChange={(e) => setEscalationRole(e.target.value as 'officer' | 'admin')}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white"
                  >
                    <option value="officer">{tRole('officer')}</option>
                    <option value="admin">{t('ops.municipalAdmin')}</option>
                  </select>
                </div>

                {(policyScope === 'department' || policyScope === 'department_category') && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      {t('common.department')}
                    </label>
                    <select
                      value={policyDeptId}
                      onChange={(e) => setPolicyDeptId(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white"
                    >
                      {departments.map((d) => (
                        <option key={d.id} value={d.id}>
                          {tDepartmentName(d.id, d.name)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {(policyScope === 'category' || policyScope === 'department_category') && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      {t('ops.issueCategory')}
                    </label>
                    <select
                      value={policyCategory}
                      onChange={(e) => setPolicyCategory(e.target.value as IssueCategory)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white"
                    >
                      {(Object.keys(CATEGORY_LABELS) as IssueCategory[]).map((cat) => (
                        <option key={cat} value={cat}>
                          {tCategory(cat)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t('ops.ackHrs')}
                  </label>
                  <input
                    type="number"
                    min="0.5"
                    max="720"
                    step="0.5"
                    value={ackHours}
                    onChange={(e) => setAckHours(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t('ops.assignHrs')}
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="720"
                    step="1"
                    value={assignHours}
                    onChange={(e) => setAssignHours(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t('ops.resolveHrs')}
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="2160"
                    step="1"
                    value={resolveHours}
                    onChange={(e) => setResolveHours(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono tabular-nums"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={savingPolicy}
                className="px-4 py-2 rounded-lg bg-blue-700 text-white text-xs font-medium hover:bg-blue-800 disabled:opacity-50"
              >
                {savingPolicy ? t('ops.savingPolicy') : t('ops.saveTargetPolicy')}
              </button>
            </form>

            <div className="lg:col-span-6 space-y-2">
              <h3 className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
                {t('ops.activePolicies', { count: slaPolicies.length })}
              </h3>
              <div className="border border-slate-200 rounded-lg divide-y divide-slate-200 max-h-60 overflow-y-auto bg-slate-50/50">
                {slaPolicies.length === 0 ? (
                  <div className="p-4 text-xs text-slate-600">
                    {t('ops.noPoliciesHint', {
                      ack: DEFAULT_SLA_TARGETS.ackTargetHours,
                      assign: DEFAULT_SLA_TARGETS.assignTargetHours,
                      resolve: DEFAULT_SLA_TARGETS.resolveTargetHours,
                    })}
                  </div>
                ) : (
                  slaPolicies.map((p) => (
                    <div key={p.id} className="p-3 text-xs flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-900 truncate">
                          {p.scopeType === 'global'
                            ? t('ops.globalTarget')
                            : p.scopeType === 'department'
                              ? t('ops.deptScopeLabel', {
                                  name: tDepartmentName(p.departmentId, p.departmentName || p.departmentId),
                                })
                              : p.scopeType === 'category'
                                ? t('ops.categoryScopeLabel', {
                                    name: p.category ? tCategory(p.category as IssueCategory) : '',
                                  })
                                : `${tDepartmentName(p.departmentId, p.departmentName || p.departmentId)} · ${p.category ? tCategory(p.category as IssueCategory) : ''}`}
                        </p>
                        <p className="text-slate-500">
                          {t('ops.escalatesTo', { role: tRole(p.escalationRole) })}
                        </p>
                      </div>
                      <div className="font-mono tabular-nums text-slate-800 shrink-0">
                        {p.ackTargetHours}h / {p.assignTargetHours}h / {p.resolveTargetHours}h
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Executive Operations KPI Strip */}
      <section aria-label={t('ops.commandTitle')} className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs text-slate-500">{t('ops.kpiTotalActive')}</p>
          <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-slate-900">
            {board.totalActiveCount}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs text-slate-500">{t('ops.kpiUnassigned')}</p>
          <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-blue-700">
            {board.unassigned.length}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs text-slate-500">{t('ops.kpiAssignedTasks')}</p>
          <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-indigo-700">
            {board.assignedTasks.length}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs text-slate-500">{t('ops.kpiInProgress')}</p>
          <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-sky-700">
            {board.inProgressTasks.length}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs text-slate-500">{t('ops.kpiOverdueTasks')}</p>
          <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-rose-700">
            {board.overdueTasks.length}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs text-slate-500">{t('ops.kpiCompleted')}</p>
          <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-emerald-700">
            {board.completedCount}
          </p>
        </div>
      </section>

      {/* Department Workload & Field Workforce Availability Breakdown */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900">{t('ops.deptWorkloadTitle')}</h2>
            <span className="text-xs font-mono tabular-nums text-slate-500">
              {t('ops.activeUnits', { count: board.departmentWorkloadBreakdown.length })}
            </span>
          </div>
          {board.departmentWorkloadBreakdown.length === 0 ? (
            <p className="text-xs text-slate-500 py-3">
              {t('ops.noDeptWorkload')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 pr-3 font-medium">{t('common.department')}</th>
                    <th className="py-2 px-2 font-medium text-right">{t('common.active')}</th>
                    <th className="py-2 px-2 font-medium text-right">{t('ops.kpiUnassigned')}</th>
                    <th className="py-2 px-2 font-medium text-right">{t('ops.kpiInProgress')}</th>
                    <th className="py-2 px-2 font-medium text-right">{t('ops.colOverdue')}</th>
                    <th className="py-2 pl-2 font-medium text-right">{t('ops.colCompleted')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                  {board.departmentWorkloadBreakdown.map((dept) => (
                    <tr key={dept.departmentId} className="hover:bg-slate-50">
                      <td className="py-2 pr-3 font-sans font-medium text-slate-800">
                        {tDepartmentName(dept.departmentId, dept.departmentName)}
                      </td>
                      <td className="py-2 px-2 text-right text-slate-900">{dept.totalActive}</td>
                      <td className="py-2 px-2 text-right text-blue-700">{dept.unassigned}</td>
                      <td className="py-2 px-2 text-right text-sky-700">{dept.inProgress}</td>
                      <td className="py-2 px-2 text-right text-rose-700 font-semibold">
                        {dept.overdue}
                      </td>
                      <td className="py-2 pl-2 text-right text-emerald-700">{dept.completed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900">{t('ops.workforceAvailTitle')}</h2>
            <span className="text-xs font-mono tabular-nums text-slate-500">
              {t('ops.workersCount', { count: board.workforceAvailabilitySummary.totalWorkers })}
            </span>
          </div>
          {board.workforceAvailabilitySummary.totalWorkers === 0 ? (
            <p className="text-xs text-slate-500 py-3">
              {t('ops.noWorkersHint')}
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {(
                [
                  { key: 'available', tone: 'text-emerald-800 bg-emerald-50 border-emerald-200' },
                  { key: 'assigned', tone: 'text-indigo-800 bg-indigo-50 border-indigo-200' },
                  { key: 'on_duty', tone: 'text-blue-800 bg-blue-50 border-blue-200' },
                  { key: 'busy', tone: 'text-amber-900 bg-amber-50 border-amber-200' },
                  { key: 'completed_shift', tone: 'text-slate-700 bg-slate-100 border-slate-200' },
                  { key: 'unavailable', tone: 'text-rose-800 bg-rose-50 border-rose-200' },
                ] as Array<{ key: WorkerAvailabilityStatus; tone: string }>
              ).map(({ key, tone }) => (
                <div key={key} className={`rounded-lg border p-2.5 ${tone}`}>
                  <p className="text-[11px] font-medium truncate">
                    {tAvailability(key)}
                  </p>
                  <p className="mt-0.5 text-lg font-semibold font-mono tabular-nums">
                    {board.workforceAvailabilitySummary[key]}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* 7 Real-Time Operations Queue Filter Lanes */}
      <section className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        {LANE_META.map((lane) => {
          const count = laneCounts[lane.key];
          const isSelected = selectedLane === lane.key;
          const label = t(lane.labelKey);
          const shortDesc = t(lane.descKey);
          return (
            <button
              key={lane.key}
              type="button"
              onClick={() => setSelectedLane(isSelected ? 'all_active' : lane.key)}
              title={shortDesc}
              className={`text-left p-4 rounded-xl border transition-colors ${
                isSelected
                  ? 'bg-blue-50 border-blue-400 ring-1 ring-blue-400'
                  : 'bg-white border-slate-200 hover:border-slate-300'
              }`}
            >
              <p className="text-xs font-medium text-slate-600 truncate">{label}</p>
              <p className={`mt-1.5 text-2xl font-semibold font-mono tabular-nums ${lane.accent}`}>
                {count}
              </p>
              <p className="text-[11px] text-slate-500 mt-1 line-clamp-2 leading-snug">
                {shortDesc}
              </p>
            </button>
          );
        })}
      </section>

      {/* Main Operations Queue + Operational Alerts Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Left 8 cols: Live Operations Queue Table */}
        <section className="xl:col-span-8 space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-slate-900">
                {selectedLane === 'all_active'
                  ? t('ops.allActiveOperations')
                  : t(LANE_META.find((l) => l.key === selectedLane)!.labelKey)}
              </span>
              <span className="text-xs font-mono tabular-nums text-slate-500">
                {t('ops.shownCount', { count: visibleReports.length })}
              </span>
              {selectedLane !== 'all_active' && (
                <button
                  type="button"
                  onClick={() => setSelectedLane('all_active')}
                  className="text-xs text-blue-700 hover:underline font-medium"
                >
                  {t('ops.showAllActive')}
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 flex-1 justify-end">
              <div className="relative min-w-[200px] flex-1 max-w-xs">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
                <input
                  type="text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder={t('ops.filterPlaceholder')}
                  className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-slate-300 text-xs"
                />
              </div>
              <select
                aria-label={t('ops.filterByDeptAria')}
                value={deptFilter}
                onChange={(e) => setDeptFilter(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs bg-white"
              >
                <option value="all">{t('common.allDepartments')}</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {tDepartmentName(d.id, d.name)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {visibleReports.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-2">
              <CheckCircle2 className="w-8 h-8 text-slate-300 mx-auto" aria-hidden="true" />
              <p className="text-sm font-medium text-slate-900">{t('ops.noQueueItems')}</p>
              <p className="text-xs text-slate-500">
                {t('ops.noQueueHint')}
              </p>
            </div>
          ) : (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="divide-y divide-slate-200">
                {visibleReports.map((r) => {
                  const dl = board.deadlineByReportId[r.id];
                  const isAwaitingSup = board.completedAwaitingVerification.some((x) => x.id === r.id);
                  return (
                    <div
                      key={r.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => onSelectReport(r.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelectReport(r.id);
                        }
                      }}
                      className="p-4 hover:bg-slate-50 cursor-pointer transition-colors space-y-2"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="font-mono tabular-nums font-semibold text-slate-800">
                              {r.trackingCode}
                            </span>
                            <span className="text-slate-400">·</span>
                            <span className="text-slate-600">{tCategory(r.category)}</span>
                            {r.departmentName && (
                              <>
                                <span className="text-slate-400">·</span>
                                <span className="text-slate-700 font-medium">
                                  {tDepartmentName(r.departmentId, r.departmentName)}
                                </span>
                              </>
                            )}
                          </div>
                          <p className="text-sm font-semibold text-slate-900">{r.title}</p>
                          <p className="text-xs text-slate-500 truncate">{r.addressText}</p>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                          <PriorityIndicator priority={r.priority} />
                          <StatusIndicator status={r.status} />
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <DeadlinePill evaluation={dl} />

                          {isAwaitingSup && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-emerald-300 bg-emerald-50 text-emerald-900 text-[11px] font-medium">
                              <UserCheck className="w-3 h-3" aria-hidden="true" />
                              {t('workspace.needsSupervisorSignOff')}
                            </span>
                          )}

                          {r.hasActiveObstacle && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-amber-300 bg-amber-50 text-amber-900 text-[11px] font-medium">
                              <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                              {t('ops.obstacleFlagged')}
                            </span>
                          )}

                          {r.assignedWorkerName ? (
                            <span className="inline-flex items-center gap-1 text-[11px] text-slate-600">
                              <Wrench className="w-3 h-3 text-slate-400" aria-hidden="true" />
                              {r.assignedWorkerName}{' '}
                              {r.acknowledgedAtIso ? t('ops.acceptedTag') : t('ops.pendingAcceptanceTag')}
                              {r.supervisorName ? ` · ${t('ops.supShort', { name: r.supervisorName })}` : ''}
                            </span>
                          ) : (
                            <span className="text-[11px] text-slate-500">{t('ops.noWorkerAssigned')}</span>
                          )}
                          {r.deadlineIso && (
                            <span className="text-[11px] font-mono tabular-nums text-slate-600">
                              {t('ops.dueAt', { time: formatTimestamp(r.deadlineIso) })}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          {r.escalatedAtIso ? (
                            <span className="text-[11px] font-mono text-rose-700">
                              {t('ops.escalatedAt', { time: formatTimestamp(r.escalatedAtIso) })}
                            </span>
                          ) : dl?.isOverdue ? (
                            <button
                              type="button"
                              disabled={escalatingId === r.id}
                              onClick={(e) => handleQuickEscalate(r, e)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-rose-300 bg-rose-50 text-rose-800 text-[11px] font-medium hover:bg-rose-100 disabled:opacity-50"
                            >
                              <ShieldAlert className="w-3 h-3" aria-hidden="true" />
                              <span>{escalatingId === r.id ? t('ops.escalating') : t('ops.escalate')}</span>
                            </button>
                          ) : null}
                          <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                            {dl ? formatDurationDelta(dl.resolveRemainingMs) : ''}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        {/* Right 4 cols: Operational Alerts Center */}
        <aside className="xl:col-span-4 space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <BellRing className="w-4 h-4 text-blue-700" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-slate-900">
                  {t('ops.alertsCountHeader', { count: unacknowledgedAlertCount })}
                </h2>
              </div>
              <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded border border-slate-200 text-[11px]">
                <button
                  type="button"
                  onClick={() => setAlertFilter('unacknowledged')}
                  className={`px-2 py-0.5 rounded font-medium ${
                    alertFilter === 'unacknowledged' ? 'bg-white text-slate-900' : 'text-slate-600'
                  }`}
                >
                  {t('common.active')}
                </button>
                <button
                  type="button"
                  onClick={() => setAlertFilter('all')}
                  className={`px-2 py-0.5 rounded font-medium ${
                    alertFilter === 'all' ? 'bg-white text-slate-900' : 'text-slate-600'
                  }`}
                >
                  {t('common.all')}
                </button>
              </div>
            </div>

            <select
              aria-label={t('ops.filterAlertsAria')}
              value={alertKindFilter}
              onChange={(e) => setAlertKindFilter(e.target.value as OperationalAlertKind | 'all')}
              className="w-full px-3 py-1.5 rounded-lg border border-slate-300 text-xs bg-white"
            >
              <option value="all">{t('ops.allEventTriggers')}</option>
              {(Object.keys(ALERT_KIND_KEYS) as OperationalAlertKind[]).map((k) => (
                <option key={k} value={k}>
                  {t(ALERT_KIND_KEYS[k])}
                </option>
              ))}
            </select>

            {filteredAlerts.length === 0 ? (
              <div className="p-6 text-center rounded-lg border border-slate-200 bg-slate-50 space-y-1">
                <CheckCircle2 className="w-6 h-6 text-emerald-600 mx-auto" aria-hidden="true" />
                <p className="text-xs font-medium text-slate-800">{t('ops.noMatchingAlerts')}</p>
                <p className="text-[11px] text-slate-500">
                  {t('ops.noMatchingAlertsDesc')}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-slate-200 border border-slate-200 rounded-lg max-h-[600px] overflow-y-auto">
                {filteredAlerts.map((alert) => {
                  const severityClass =
                    alert.severity === 'critical'
                      ? 'bg-rose-50/50'
                      : alert.severity === 'warning'
                        ? 'bg-amber-50/40'
                        : 'bg-white';
                  return (
                    <li key={alert.id} className={`p-3.5 space-y-2 ${severityClass}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <span className="text-[11px] font-medium text-slate-500">
                            {t(ALERT_KIND_KEYS[alert.kind])}
                          </span>
                          <p className="text-xs font-semibold text-slate-900 leading-snug">
                            {alert.title}
                          </p>
                        </div>
                        <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded border border-slate-200 bg-white text-slate-700 shrink-0">
                          {alert.severity}
                        </span>
                      </div>

                      <p className="text-xs text-slate-700 leading-relaxed">{alert.message}</p>

                      <div className="flex items-center justify-between gap-2 pt-1">
                        <span className="text-[11px] font-mono tabular-nums text-slate-400">
                          {formatTimestamp(alert.createdAt)}
                        </span>
                        <div className="flex items-center gap-1.5">
                          {!alert.acknowledged && (
                            <button
                              type="button"
                              disabled={acknowledgingId === alert.id}
                              onClick={async () => {
                                setAcknowledgingId(alert.id);
                                try {
                                  await acknowledgeOperationalAlert(alert.id);
                                } catch (err) {
                                  setBannerMsg({ type: 'error', text: tError(formatFriendlyError(err)) });
                                } finally {
                                  setAcknowledgingId(null);
                                }
                              }}
                              className="px-2 py-1 rounded border border-slate-300 bg-white text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                            >
                              {acknowledgingId === alert.id ? '...' : t('ops.acknowledge')}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onSelectReport(alert.reportId)}
                            className="px-2 py-1 rounded bg-blue-700 text-white text-[11px] font-medium hover:bg-blue-800"
                          >
                            {t('common.open')}
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
