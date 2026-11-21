import {
  CATEGORY_LABELS,
  PRIORITY_LABELS,
  type Assignment,
  type CivicReport,
  type DeadlineEvaluation,
  type DeadlineHealth,
  type Department,
  type DepartmentOperationsWorkload,
  type IssueCategory,
  type OperationalAlertCandidate,
  type OperationsBoardBuckets,
  type SlaPolicy,
  type UserProfile,
  type WorkerAvailabilityStatus,
  type WorkerRecommendation,
  type WorkerWorkloadSummary,
  type WorkforceAvailabilitySummary,
} from '../types/civic';

export const DEFAULT_SLA_TARGETS = {
  ackTargetHours: 4,
  assignTargetHours: 12,
  resolveTargetHours: 48,
};

export function toEpochMs(ts: any): number {
  if (!ts) return 0;
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts?.toMillis === 'function') return ts.toMillis();
  if (typeof ts?.toDate === 'function') return ts.toDate().getTime();
  if (typeof ts?._seconds === 'number') return ts._seconds * 1000;
  const parsed = Date.parse(String(ts));
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function formatDurationDelta(ms: number): string {
  const absMs = Math.abs(ms);
  const totalMinutes = Math.floor(absMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const mins = totalMinutes % 60;

  let span = '';
  if (days > 0) {
    span = `${days}d ${hours}h`;
  } else if (hours > 0) {
    span = `${hours}h ${mins}m`;
  } else {
    span = `${Math.max(1, mins)}m`;
  }
  return ms < 0 ? `Overdue by ${span}` : `${span} left`;
}

export function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function hasValidCoords(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

/**
 * Resolves the most specific administrative SLA response target policy:
 * 1. department + category
 * 2. department only
 * 3. category only
 * 4. global policy
 * 5. built-in default (4h ack / 12h assign / 48h resolve)
 */
export function resolveSlaPolicy(
  departmentId: string,
  category: IssueCategory,
  policies: SlaPolicy[]
): {
  ackTargetHours: number;
  assignTargetHours: number;
  resolveTargetHours: number;
  escalationRole: 'officer' | 'admin';
  policyLabel: string;
} {
  const deptCat = policies.find(
    (p) => p.scopeType === 'department_category' && p.departmentId === departmentId && p.category === category
  );
  if (deptCat) {
    return {
      ackTargetHours: deptCat.ackTargetHours,
      assignTargetHours: deptCat.assignTargetHours,
      resolveTargetHours: deptCat.resolveTargetHours,
      escalationRole: deptCat.escalationRole || 'officer',
      policyLabel: `${deptCat.departmentName || departmentId} · ${CATEGORY_LABELS[category]}`,
    };
  }

  const deptOnly = policies.find(
    (p) => p.scopeType === 'department' && p.departmentId === departmentId && !p.category
  );
  if (deptOnly) {
    return {
      ackTargetHours: deptOnly.ackTargetHours,
      assignTargetHours: deptOnly.assignTargetHours,
      resolveTargetHours: deptOnly.resolveTargetHours,
      escalationRole: deptOnly.escalationRole || 'officer',
      policyLabel: `${deptOnly.departmentName || departmentId} Department Target`,
    };
  }

  const catOnly = policies.find(
    (p) => p.scopeType === 'category' && p.category === category && !p.departmentId
  );
  if (catOnly) {
    return {
      ackTargetHours: catOnly.ackTargetHours,
      assignTargetHours: catOnly.assignTargetHours,
      resolveTargetHours: catOnly.resolveTargetHours,
      escalationRole: catOnly.escalationRole || 'officer',
      policyLabel: `${CATEGORY_LABELS[category]} Target`,
    };
  }

  const globalPolicy = policies.find((p) => p.scopeType === 'global');
  if (globalPolicy) {
    return {
      ackTargetHours: globalPolicy.ackTargetHours,
      assignTargetHours: globalPolicy.assignTargetHours,
      resolveTargetHours: globalPolicy.resolveTargetHours,
      escalationRole: globalPolicy.escalationRole || 'officer',
      policyLabel: 'Municipal Global Target',
    };
  }

  return {
    ...DEFAULT_SLA_TARGETS,
    escalationRole: 'officer',
    policyLabel: 'Default Administrative Target',
  };
}

function classifyDeadlineHealth(remainingMs: number, targetMs: number, met: boolean): DeadlineHealth {
  if (met) return 'met';
  if (remainingMs < 0) return 'overdue';
  if (targetMs > 0 && remainingMs <= targetMs * 0.25) return 'approaching';
  return 'on_track';
}

export function evaluateReportDeadlines(
  report: CivicReport,
  assignment: Assignment | null | undefined,
  policies: SlaPolicy[],
  nowMs: number = Date.now()
): DeadlineEvaluation {
  const createdMs = toEpochMs(report.createdAt) || nowMs;
  const resolvedPolicy = resolveSlaPolicy(report.departmentId || '', report.category, policies);

  // Critical and High priority tasks tighten administrative targets transparently unless overridden
  const priorityMultiplier =
    report.priority === 'critical' ? 0.5 : report.priority === 'high' ? 0.75 : 1;

  const ackTargetMs = Math.max(1, resolvedPolicy.ackTargetHours * priorityMultiplier) * 3600_000;
  const assignTargetMs = Math.max(2, resolvedPolicy.assignTargetHours * priorityMultiplier) * 3600_000;
  let resolveTargetMs = Math.max(4, resolvedPolicy.resolveTargetHours * priorityMultiplier) * 3600_000;

  const ackDeadlineMs = createdMs + ackTargetMs;
  const assignDeadlineMs = createdMs + assignTargetMs;
  let resolveDeadlineMs = createdMs + resolveTargetMs;

  const customDeadlineRaw = assignment?.deadlineIso || report.deadlineIso || '';
  const customDeadlineMs = customDeadlineRaw ? Date.parse(customDeadlineRaw) : NaN;
  const hasCustomDeadline = Number.isFinite(customDeadlineMs) && customDeadlineMs > createdMs;
  if (hasCustomDeadline) {
    resolveDeadlineMs = customDeadlineMs;
    resolveTargetMs = Math.max(3600_000, customDeadlineMs - createdMs);
  }

  const isTerminalOrResolved =
    report.status === 'resolved' ||
    report.status === 'citizen_confirmed' ||
    report.status === 'rejected';

  const ackMet =
    report.status !== 'submitted' || Boolean(report.acknowledgedAtIso || assignment?.acknowledgedAtIso);
  const assignMet =
    Boolean(report.assignedWorkerId) ||
    ['assigned', 'in_progress', 'resolved', 'citizen_confirmed', 'rejected'].includes(report.status);
  const resolveMet = isTerminalOrResolved;

  const ackRemainingMs = ackDeadlineMs - nowMs;
  const assignRemainingMs = assignDeadlineMs - nowMs;
  const resolveRemainingMs = resolveDeadlineMs - nowMs;

  const ackHealth = classifyDeadlineHealth(ackRemainingMs, ackTargetMs, ackMet);
  const assignHealth = classifyDeadlineHealth(assignRemainingMs, assignTargetMs, assignMet);
  const resolveHealth = classifyDeadlineHealth(resolveRemainingMs, resolveTargetMs, resolveMet);

  const overdueStages: Array<'acknowledge' | 'assign' | 'resolve'> = [];
  if (ackHealth === 'overdue') overdueStages.push('acknowledge');
  if (assignHealth === 'overdue') overdueStages.push('assign');
  if (resolveHealth === 'overdue') overdueStages.push('resolve');

  let activeStage: DeadlineEvaluation['activeStage'] = 'completed';
  let activeRemainingMs = 0;

  if (!ackMet) {
    activeStage = 'acknowledge';
    activeRemainingMs = ackRemainingMs;
  } else if (!assignMet) {
    activeStage = 'assign';
    activeRemainingMs = assignRemainingMs;
  } else if (!resolveMet) {
    activeStage = 'resolve';
    activeRemainingMs = resolveRemainingMs;
  }

  const isOverdue = overdueStages.length > 0;
  const isApproaching =
    !isOverdue &&
    (ackHealth === 'approaching' || assignHealth === 'approaching' || resolveHealth === 'approaching');

  const basePolicyLabel =
    priorityMultiplier < 1
      ? `${resolvedPolicy.policyLabel} (${PRIORITY_LABELS[report.priority]} priority scaling)`
      : resolvedPolicy.policyLabel;

  return {
    reportId: report.id,
    policyLabel: hasCustomDeadline ? `${basePolicyLabel} · Custom Task Deadline` : basePolicyLabel,
    ackTargetMs,
    assignTargetMs,
    resolveTargetMs,
    ackDeadlineMs,
    assignDeadlineMs,
    resolveDeadlineMs,
    ackRemainingMs,
    assignRemainingMs,
    resolveRemainingMs,
    ackHealth,
    assignHealth,
    resolveHealth,
    activeStage,
    activeRemainingMs,
    activeRemainingLabel:
      activeStage === 'completed'
        ? report.status === 'rejected'
          ? 'Closed (Rejected)'
          : 'Completed'
        : formatDurationDelta(activeRemainingMs),
    isApproaching,
    isOverdue,
    overdueStages,
  };
}

export function isReportAwaitingSupervisorVerification(
  report: CivicReport,
  assignment?: Assignment | null
): boolean {
  if (report.status === 'citizen_confirmed' || report.status === 'rejected') return false;
  if (report.awaitingSupervisorVerification === true) return true;
  if (assignment?.status === 'evidence_submitted' && report.status !== 'resolved') return true;
  // Backward compatibility for legacy Milestone 4 reports marked resolved before supervisor gate
  if (report.status === 'resolved' && assignment?.status === 'evidence_submitted' && !report.supervisorVerifiedAtIso) {
    return true;
  }
  return false;
}

export function categorizeOperationsBoard(
  reports: CivicReport[],
  assignments: Assignment[],
  policies: SlaPolicy[],
  nowMs: number = Date.now(),
  departments: Department[] = [],
  users: UserProfile[] = []
): OperationsBoardBuckets {
  const latestAssignmentByReportId = new Map<string, Assignment>();
  for (const a of assignments) {
    const prev = latestAssignmentByReportId.get(a.reportId);
    if (!prev || toEpochMs(a.updatedAt) >= toEpochMs(prev.updatedAt)) {
      latestAssignmentByReportId.set(a.reportId, a);
    }
  }

  const newlySubmitted: CivicReport[] = [];
  const awaitingVerification: CivicReport[] = [];
  const unassigned: CivicReport[] = [];
  const assignedTasks: CivicReport[] = [];
  const inProgressTasks: CivicReport[] = [];
  const overdueTasks: CivicReport[] = [];
  const completedAwaitingVerification: CivicReport[] = [];
  const deadlineByReportId: Record<string, DeadlineEvaluation> = {};

  let totalActiveCount = 0;
  let completedCount = 0;

  const deptBucketMap = new Map<string, DepartmentOperationsWorkload>();
  for (const d of departments.filter((dep) => dep.active)) {
    deptBucketMap.set(d.id, {
      departmentId: d.id,
      departmentName: d.name,
      departmentCode: d.code,
      totalActive: 0,
      unassigned: 0,
      assigned: 0,
      inProgress: 0,
      overdue: 0,
      awaitingVerification: 0,
      completed: 0,
    });
  }

  const ensureDeptBucket = (report: CivicReport): DepartmentOperationsWorkload => {
    const key = report.departmentId || '__unassigned_intake__';
    let b = deptBucketMap.get(key);
    if (!b) {
      b = {
        departmentId: key,
        departmentName: report.departmentId
          ? report.departmentName || report.departmentId
          : 'Unassigned Intake Queue',
        departmentCode: report.departmentId
          ? (report.departmentName || report.departmentId).slice(0, 6).toUpperCase()
          : 'INTAKE',
        totalActive: 0,
        unassigned: 0,
        assigned: 0,
        inProgress: 0,
        overdue: 0,
        awaitingVerification: 0,
        completed: 0,
      };
      deptBucketMap.set(key, b);
    }
    return b;
  };

  for (const report of reports) {
    const asg = latestAssignmentByReportId.get(report.id);
    const deadline = evaluateReportDeadlines(report, asg, policies, nowMs);
    deadlineByReportId[report.id] = deadline;

    const deptBucket = ensureDeptBucket(report);
    const isCompleted = report.status === 'resolved' || report.status === 'citizen_confirmed';
    const isRejected = report.status === 'rejected';
    const isActive = !isCompleted && !isRejected;

    if (isCompleted) {
      completedCount += 1;
      deptBucket.completed += 1;
    } else if (isActive) {
      totalActiveCount += 1;
      deptBucket.totalActive += 1;
    }

    if (deadline.isOverdue) {
      overdueTasks.push(report);
      if (isActive) deptBucket.overdue += 1;
    }

    if (isReportAwaitingSupervisorVerification(report, asg)) {
      completedAwaitingVerification.push(report);
      if (isActive) deptBucket.awaitingVerification += 1;
      continue;
    }

    if (report.status === 'submitted') {
      newlySubmitted.push(report);
    } else if (report.status === 'under_review' || report.status === 'reopened') {
      awaitingVerification.push(report);
    } else if (report.status === 'verified' || (report.status === 'assigned' && !report.assignedWorkerId)) {
      unassigned.push(report);
      deptBucket.unassigned += 1;
    } else if (report.status === 'assigned') {
      assignedTasks.push(report);
      deptBucket.assigned += 1;
    } else if (report.status === 'in_progress') {
      inProgressTasks.push(report);
      deptBucket.inProgress += 1;
    }
  }

  const workforceAvailabilitySummary: WorkforceAvailabilitySummary = {
    totalWorkers: 0,
    available: 0,
    assigned: 0,
    on_duty: 0,
    busy: 0,
    completed_shift: 0,
    unavailable: 0,
  };
  const workerWorkloads = computeWorkerWorkloads(users, reports, assignments);
  for (const w of workerWorkloads) {
    workforceAvailabilitySummary.totalWorkers += 1;
    workforceAvailabilitySummary[w.availability] += 1;
  }

  return {
    newlySubmitted,
    awaitingVerification,
    unassigned,
    assignedTasks,
    inProgressTasks,
    overdueTasks,
    completedAwaitingVerification,
    totalActiveCount,
    completedCount,
    departmentWorkloadBreakdown: Array.from(deptBucketMap.values()),
    workforceAvailabilitySummary,
    deadlineByReportId,
  };
}

export function computeWorkerWorkloads(
  users: UserProfile[],
  reports: CivicReport[],
  assignments: Assignment[]
): WorkerWorkloadSummary[] {
  const workers = users.filter((u) => u.active && u.role === 'worker');

  const assignmentByReportId = new Map<string, Assignment>();
  for (const asg of assignments) {
    const prev = assignmentByReportId.get(asg.reportId);
    if (!prev || toEpochMs(asg.updatedAt) >= toEpochMs(prev.updatedAt)) {
      assignmentByReportId.set(asg.reportId, asg);
    }
  }

  return workers.map((worker) => {
    const assignedReports = reports.filter((r) => r.assignedWorkerId === worker.uid);
    const activeOpen = assignedReports.filter(
      (r) => r.status === 'assigned' || r.status === 'in_progress'
    );
    const awaitingVer = activeOpen.filter((r) =>
      isReportAwaitingSupervisorVerification(r, assignmentByReportId.get(r.id))
    );
    const inProgress = activeOpen.filter(
      (r) => r.status === 'in_progress' && !isReportAwaitingSupervisorVerification(r, assignmentByReportId.get(r.id))
    );
    const completed = assignedReports.filter(
      (r) => r.status === 'resolved' || r.status === 'citizen_confirmed'
    );
    const obstacles = activeOpen.filter((r) => Boolean(r.hasActiveObstacle));
    const maxTasks = Math.max(1, worker.maxActiveTasks || 5);

    const configuredAvailability: WorkerAvailabilityStatus =
      worker.availabilityStatus ||
      (activeOpen.length >= maxTasks ? 'busy' : activeOpen.length > 0 ? 'assigned' : 'available');

    return {
      worker,
      availability: configuredAvailability,
      activeTasks: activeOpen.length,
      inProgressTasks: inProgress.length,
      awaitingVerificationTasks: awaitingVer.length,
      completedTasks: completed.length,
      obstacleTasks: obstacles.length,
      maxActiveTasks: maxTasks,
      assignedReports,
    };
  });
}

/**
 * Module 3: Transparent Smart Task Assignment Ranker.
 * Computes an explainable score based on:
 * - Department responsibility
 * - Worker availability
 * - Current workload vs capacity
 * - Task priority suitability
 * - Explicit work zone or active site proximity (never continuous tracking)
 * Always requires human officer/admin confirmation before assignment.
 */
export function recommendWorkersForReport(
  report: CivicReport,
  users: UserProfile[],
  reports: CivicReport[],
  assignments: Assignment[],
  departments: Department[]
): WorkerRecommendation[] {
  const workloads = computeWorkerWorkloads(users, reports, assignments);
  const reportDept = departments.find((d) => d.id === report.departmentId);
  const reportZone = (report.wardOrZone || report.addressText || '').toLowerCase();

  const ranked = workloads.map((summary): WorkerRecommendation => {
    const { worker, availability, activeTasks, completedTasks, maxActiveTasks, assignedReports } = summary;
    const reasons: string[] = [];

    // 1. Department responsibility (0 - 35 pts)
    let departmentScore = 5;
    if (report.departmentId && worker.departmentId === report.departmentId) {
      departmentScore = 35;
      reasons.push(`Assigned to ${reportDept?.name || worker.departmentName || 'target department'}`);
    } else if (!worker.departmentId) {
      departmentScore = 15;
      reasons.push('Unrestricted municipal pool worker');
    } else {
      reasons.push(`Different department (${worker.departmentName || worker.departmentId})`);
    }

    // 2. Availability (0 - 25 pts)
    let availabilityScore = 0;
    const eligible = availability !== 'unavailable' && availability !== 'completed_shift';
    if (availability === 'available') {
      availabilityScore = 25;
      reasons.push('Marked Available');
    } else if (availability === 'on_duty') {
      availabilityScore = 23;
      reasons.push('On Duty & field ready');
    } else if (availability === 'assigned') {
      availabilityScore = 15;
      reasons.push('Currently Assigned (has active task)');
    } else if (availability === 'busy') {
      availabilityScore = 10;
      reasons.push('Marked Busy (reduced capacity)');
    } else if (availability === 'completed_shift') {
      availabilityScore = 0;
      reasons.push('Completed Shift for today');
    } else {
      availabilityScore = 0;
      reasons.push(
        worker.availabilityNote
          ? `Unavailable: ${worker.availabilityNote}`
          : 'Temporarily marked Unavailable'
      );
    }

    // 3. Workload balance (0 - 20 pts)
    const loadRatio = Math.min(1, activeTasks / Math.max(1, maxActiveTasks));
    const workloadScore = Math.round((1 - loadRatio) * 20);
    reasons.push(`Active workload: ${activeTasks}/${maxActiveTasks} tasks (${completedTasks} completed)`);

    // 4. Task priority alignment (0 - 10 pts)
    let priorityScore = 6;
    if (report.priority === 'critical' || report.priority === 'high') {
      if (availability === 'available' && activeTasks <= 1) {
        priorityScore = 10;
        reasons.push(`Low queue suitable for ${PRIORITY_LABELS[report.priority]} priority`);
      } else if (activeTasks >= 3) {
        priorityScore = 2;
        reasons.push(`Higher active load for ${PRIORITY_LABELS[report.priority]} urgency`);
      }
    } else {
      priorityScore = 8;
    }

    // 5. Location / explicit work zone alignment (0 - 10 pts) — NO continuous tracking
    let locationScore = 4;
    if (worker.workZone && reportZone && reportZone.includes(worker.workZone.toLowerCase())) {
      locationScore = 10;
      reasons.push(`Declared work zone matches "${worker.workZone}"`);
    } else if (hasValidCoords(report.latitude, report.longitude)) {
      const activeWithCoords = assignedReports.filter(
        (r) =>
          (r.status === 'assigned' || r.status === 'in_progress') &&
          hasValidCoords(r.latitude, r.longitude)
      );
      if (activeWithCoords.length > 0) {
        const minKm = Math.min(
          ...activeWithCoords.map((r) =>
            haversineDistanceKm(report.latitude, report.longitude, r.latitude, r.longitude)
          )
        );
        if (minKm <= 1.5) {
          locationScore = 10;
          reasons.push(`Already assigned to active site ${minKm.toFixed(1)} km away`);
        } else if (minKm <= 5) {
          locationScore = 7;
          reasons.push(`Active task site within ${minKm.toFixed(1)} km`);
        } else {
          locationScore = 3;
          reasons.push(`Nearest active site is ${minKm.toFixed(1)} km away`);
        }
      } else {
        locationScore = 6;
        reasons.push('No conflicting distant active task coordinates');
      }
    }

    const total = Math.max(
      0,
      Math.min(100, departmentScore + availabilityScore + workloadScore + priorityScore + locationScore)
    );

    return {
      worker,
      score: eligible ? total : Math.min(15, total),
      eligible,
      availability,
      activeTasks,
      completedTasks,
      reasons,
      breakdown: {
        departmentScore,
        availabilityScore,
        workloadScore,
        priorityScore,
        locationScore,
      },
    };
  });

  return ranked.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return a.activeTasks - b.activeTasks;
  });
}

/**
 * Module 7: Deterministic, deduplicated Operational Alerts generator.
 * Each candidate has a unique, deterministic `alertKey` used as the document ID suffix
 * so repeated evaluations never create duplicate notifications for the same event.
 */
export function evaluateOperationalAlerts(
  reports: CivicReport[],
  assignments: Assignment[],
  policies: SlaPolicy[],
  staffUsers: UserProfile[],
  nowMs: number = Date.now()
): OperationalAlertCandidate[] {
  const candidates: OperationalAlertCandidate[] = [];
  const adminUids = staffUsers.filter((u) => u.active && u.role === 'admin').map((u) => u.uid);

  const assignmentByReportId = new Map<string, Assignment>();
  for (const a of assignments) {
    const prev = assignmentByReportId.get(a.reportId);
    if (!prev || toEpochMs(a.updatedAt) >= toEpochMs(prev.updatedAt)) {
      assignmentByReportId.set(a.reportId, a);
    }
  }

  const getStaffRecipients = (report: CivicReport): string[] => {
    const set = new Set<string>([...adminUids, ...(report.authorizedOfficerIds || [])]);
    return Array.from(set).filter(Boolean).slice(0, 10);
  };

  for (const report of reports) {
    if (report.status === 'citizen_confirmed' || report.status === 'rejected') continue;
    const asg = assignmentByReportId.get(report.id);
    const recipients = getStaffRecipients(report);
    if (recipients.length === 0) continue;

    // 1. New high-priority / critical report
    if (
      (report.priority === 'high' || report.priority === 'critical') &&
      (report.status === 'submitted' || report.status === 'under_review')
    ) {
      candidates.push({
        alertKey: `high_priority_${report.id}`,
        kind: 'high_priority_report',
        reportId: report.id,
        trackingCode: report.trackingCode,
        departmentId: report.departmentId || '',
        authorizedOfficerIds: report.authorizedOfficerIds || [],
        recipientIds: recipients,
        severity: report.priority === 'critical' ? 'critical' : 'warning',
        notificationType: 'review_needed',
        title: `${PRIORITY_LABELS[report.priority]} priority report: ${report.trackingCode}`,
        message: `"${report.title}" at ${report.addressText} requires immediate triage.`,
      });
    }

    // 2. Unassigned verified task waiting for worker dispatch
    if (report.status === 'verified' && !report.assignedWorkerId) {
      candidates.push({
        alertKey: `unassigned_${report.id}`,
        kind: 'unassigned_task',
        reportId: report.id,
        trackingCode: report.trackingCode,
        departmentId: report.departmentId || '',
        authorizedOfficerIds: report.authorizedOfficerIds || [],
        recipientIds: recipients,
        severity: report.priority === 'critical' || report.priority === 'high' ? 'warning' : 'info',
        notificationType: 'assignment',
        title: `Unassigned verified task: ${report.trackingCode}`,
        message: `"${report.title}" (${report.departmentName || 'Department'}) needs field worker dispatch.`,
      });
    }

    // 3 & 4. Deadline approaching or overdue (+ supervisor escalation)
    const evalResult = evaluateReportDeadlines(report, asg, policies, nowMs);
    if (evalResult.isOverdue && evalResult.activeStage !== 'completed') {
      const stage = evalResult.overdueStages[evalResult.overdueStages.length - 1] || 'resolve';
      candidates.push({
        alertKey: `deadline_overdue_${stage}_${report.id}`,
        kind: 'deadline_overdue',
        reportId: report.id,
        trackingCode: report.trackingCode,
        departmentId: report.departmentId || '',
        authorizedOfficerIds: report.authorizedOfficerIds || [],
        recipientIds: recipients,
        severity: 'critical',
        notificationType: 'deadline_overdue',
        title: `SLA target overdue (${stage}): ${report.trackingCode}`,
        message: `"${report.title}" exceeded its administrative ${stage} target (${evalResult.activeRemainingLabel}). Escalated to supervisor review.`,
      });
    } else if (evalResult.isApproaching && evalResult.activeStage !== 'completed') {
      candidates.push({
        alertKey: `deadline_approaching_${evalResult.activeStage}_${report.id}`,
        kind: 'deadline_approaching',
        reportId: report.id,
        trackingCode: report.trackingCode,
        departmentId: report.departmentId || '',
        authorizedOfficerIds: report.authorizedOfficerIds || [],
        recipientIds: recipients,
        severity: 'warning',
        notificationType: 'deadline_warning',
        title: `SLA target approaching: ${report.trackingCode}`,
        message: `"${report.title}" (${evalResult.activeStage} stage) has ${evalResult.activeRemainingLabel}.`,
      });
    }

    // 5. Worker-reported obstacles
    if (report.hasActiveObstacle && report.obstaclesEncountered) {
      const obsHash = report.obstaclesEncountered.trim().length;
      candidates.push({
        alertKey: `obstacle_${report.id}_${obsHash}`,
        kind: 'worker_obstacle',
        reportId: report.id,
        trackingCode: report.trackingCode,
        departmentId: report.departmentId || '',
        authorizedOfficerIds: report.authorizedOfficerIds || [],
        recipientIds: recipients,
        severity: 'warning',
        notificationType: 'obstacle',
        title: `Field obstacle reported: ${report.trackingCode}`,
        message: `${report.assignedWorkerName || 'Field worker'} flagged an obstacle: ${report.obstaclesEncountered.slice(0, 200)}`,
      });
    }

    // 6. Completion awaiting supervisor verification
    if (isReportAwaitingSupervisorVerification(report, asg)) {
      candidates.push({
        alertKey: `verification_needed_${report.id}_${report.completedAtIso || 'pending'}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
        kind: 'completion_awaiting_verification',
        reportId: report.id,
        trackingCode: report.trackingCode,
        departmentId: report.departmentId || '',
        authorizedOfficerIds: report.authorizedOfficerIds || [],
        recipientIds: recipients,
        severity: 'info',
        notificationType: 'review_needed',
        title: `Completion awaiting verification: ${report.trackingCode}`,
        message: `${report.assignedWorkerName || 'Field worker'} submitted completion details for "${report.title}".`,
      });
    }

    // 7. Reopened reports
    if (report.status === 'reopened') {
      candidates.push({
        alertKey: `reopened_${report.id}_${(report.reopenReason || '').length}`,
        kind: 'reopened_report',
        reportId: report.id,
        trackingCode: report.trackingCode,
        departmentId: report.departmentId || '',
        authorizedOfficerIds: report.authorizedOfficerIds || [],
        recipientIds: recipients,
        severity: 'critical',
        notificationType: 'review_needed',
        title: `Reopened report requires supervisor review: ${report.trackingCode}`,
        message: report.reopenReason
          ? `Citizen reopened "${report.title}": ${report.reopenReason.slice(0, 200)}`
          : `Citizen reopened "${report.title}" as unresolved.`,
      });
    }
  }

  return candidates;
}
