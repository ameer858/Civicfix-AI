import {
  CATEGORY_LABELS,
  type AiAnalysis,
  type AnonymizedTrendDigest,
  type Assignment,
  type CitywideDuplicatePair,
  type CivicReport,
  type DashboardIntelligence,
  type Department,
  type DepartmentPerformanceMetric,
  type HotspotCluster,
  type HotspotClusteringResult,
  type IssueCategory,
  type IssuePriority,
  type PriorityFactor,
  type PriorityIntelligenceResult,
  type ReportUpdate,
  type TrendBucket,
} from '../types/civic';

export function toMillis(ts: any): number {
  if (!ts) return 0;
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts?.toMillis === 'function') return ts.toMillis();
  if (typeof ts?.toDate === 'function') return ts.toDate().getTime();
  if (typeof ts?.seconds === 'number') {
    return ts.seconds * 1000 + Math.round((ts.nanoseconds || 0) / 1e6);
  }
  const parsed = Date.parse(String(ts));
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function isValidCoordinate(lat: unknown, lng: unknown): boolean {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  if (lat === 0 && lng === 0) return false;
  return true;
}

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'near',
  'from',
  'have',
  'been',
  'there',
  'here',
  'issue',
  'report',
]);

export function tokenizeText(text: string): Set<string> {
  const tokens = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  return new Set(tokens);
}

export function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenizeText(a);
  const setB = tokenizeText(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function formatDurationHours(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours) || hours < 0) return 'N/A';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const days = hours / 24;
  return `${days.toFixed(1)}d`;
}

function getResolutionMillisForReport(
  report: CivicReport,
  updatesByReport: Map<string, ReportUpdate[]>
): number | null {
  const createdMs = toMillis(report.createdAt);
  if (!createdMs) return null;

  const updates = updatesByReport.get(report.id) || [];
  const resolvedUpd = updates
    .filter((u) => u.toStatus === 'resolved' || u.toStatus === 'citizen_confirmed')
    .map((u) => toMillis(u.createdAt))
    .filter((ms) => ms >= createdMs)
    .sort((a, b) => a - b)[0];

  if (resolvedUpd) return resolvedUpd;

  if (report.status === 'resolved' || report.status === 'citizen_confirmed') {
    const updatedMs = toMillis(report.updatedAt);
    if (updatedMs >= createdMs) return updatedMs;
  }
  return null;
}

function startOfWeekUtc(ms: number): number {
  const d = new Date(ms);
  const day = d.getUTCDay();
  const diff = (day + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff);
}

function startOfMonthUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function computeDashboardIntelligence(
  reports: CivicReport[],
  departments: Department[],
  reportUpdates: ReportUpdate[],
  nowMs = Date.now()
): DashboardIntelligence {
  const updatesByReport = new Map<string, ReportUpdate[]>();
  for (const upd of reportUpdates) {
    const list = updatesByReport.get(upd.reportId) || [];
    list.push(upd);
    updatesByReport.set(upd.reportId, list);
  }

  let pendingReports = 0;
  let verifiedReports = 0;
  let inProgressReports = 0;
  let resolvedReports = 0;
  let reopenedReports = 0;
  let rejectedReports = 0;

  const resolutionHoursList: number[] = [];

  for (const r of reports) {
    if (r.status === 'submitted' || r.status === 'under_review') {
      pendingReports++;
    } else if (r.status === 'verified') {
      verifiedReports++;
    } else if (r.status === 'assigned' || r.status === 'in_progress') {
      inProgressReports++;
    } else if (r.status === 'resolved' || r.status === 'citizen_confirmed') {
      resolvedReports++;
    } else if (r.status === 'reopened') {
      reopenedReports++;
    } else if (r.status === 'rejected') {
      rejectedReports++;
    }

    if (r.status === 'resolved' || r.status === 'citizen_confirmed') {
      const createdMs = toMillis(r.createdAt);
      const resolvedMs = getResolutionMillisForReport(r, updatesByReport);
      if (createdMs && resolvedMs && resolvedMs >= createdMs) {
        resolutionHoursList.push((resolvedMs - createdMs) / (1000 * 60 * 60));
      }
    }
  }

  const avgResolutionHours =
    resolutionHoursList.length > 0
      ? Number(
          (resolutionHoursList.reduce((acc, h) => acc + h, 0) / resolutionHoursList.length).toFixed(1)
        )
      : null;

  const totalReports = reports.length;
  const categoryDistribution = (Object.keys(CATEGORY_LABELS) as IssueCategory[]).map((category) => {
    const count = reports.filter((r) => r.category === category).length;
    return {
      category,
      label: CATEGORY_LABELS[category],
      count,
      sharePct: totalReports > 0 ? Math.round((count / totalReports) * 100) : 0,
    };
  });

  const activeDepts = departments.filter((d) => d.active || reports.some((r) => r.departmentId === d.id));
  const departmentWorkload = activeDepts.map((d) => {
    const deptReports = reports.filter((r) => r.departmentId === d.id);
    const resolved = deptReports.filter(
      (r) => r.status === 'resolved' || r.status === 'citizen_confirmed'
    ).length;
    const open = deptReports.filter(
      (r) => r.status !== 'resolved' && r.status !== 'citizen_confirmed' && r.status !== 'rejected'
    ).length;
    return {
      departmentId: d.id,
      departmentName: d.name,
      departmentCode: d.code,
      total: deptReports.length,
      open,
      resolved,
    };
  });

  const unassignedCount = reports.filter((r) => !r.departmentId).length;
  if (unassignedCount > 0) {
    const unassignedReports = reports.filter((r) => !r.departmentId);
    departmentWorkload.push({
      departmentId: '__unassigned__',
      departmentName: 'Unassigned / Pending Verification',
      departmentCode: 'PEND',
      total: unassignedCount,
      open: unassignedReports.filter((r) => r.status !== 'rejected').length,
      resolved: 0,
    });
  }

  // Last 8 weeks trends
  const currentWeekStart = startOfWeekUtc(nowMs);
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const weeklyTrends: TrendBucket[] = [];
  for (let i = 7; i >= 0; i--) {
    const start = currentWeekStart - i * weekMs;
    const end = start + weekMs;
    const d = new Date(start);
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

    let submitted = 0;
    let resolved = 0;
    let reopened = 0;
    for (const r of reports) {
      const cMs = toMillis(r.createdAt);
      if (cMs >= start && cMs < end) submitted++;
      const resMs = getResolutionMillisForReport(r, updatesByReport);
      if (resMs && resMs >= start && resMs < end) resolved++;
      if (r.status === 'reopened') {
        const uMs = toMillis(r.updatedAt);
        if (uMs >= start && uMs < end) reopened++;
      }
    }
    weeklyTrends.push({ key: `w_${start}`, label, submitted, resolved, reopened });
  }

  // Last 6 months trends
  const nowDate = new Date(nowMs);
  const monthlyTrends: TrendBucket[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() - i, 1));
    const start = startOfMonthUtc(d.getTime());
    const nextMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const label = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });

    let submitted = 0;
    let resolved = 0;
    let reopened = 0;
    for (const r of reports) {
      const cMs = toMillis(r.createdAt);
      if (cMs >= start && cMs < nextMonth) submitted++;
      const resMs = getResolutionMillisForReport(r, updatesByReport);
      if (resMs && resMs >= start && resMs < nextMonth) resolved++;
      if (r.status === 'reopened') {
        const uMs = toMillis(r.updatedAt);
        if (uMs >= start && uMs < nextMonth) reopened++;
      }
    }
    monthlyTrends.push({ key: `m_${start}`, label, submitted, resolved, reopened });
  }

  return {
    totalReports,
    pendingReports,
    verifiedReports,
    inProgressReports,
    resolvedReports,
    reopenedReports,
    rejectedReports,
    avgResolutionHours,
    resolutionSampleSize: resolutionHoursList.length,
    categoryDistribution,
    departmentWorkload,
    weeklyTrends,
    monthlyTrends,
  };
}

export function computeCitywideDuplicatePairs(
  reports: CivicReport[],
  aiAnalyses: AiAnalysis[]
): CitywideDuplicatePair[] {
  const aiByReportId = new Map<string, string>();
  for (const a of aiAnalyses) {
    if (a.reportId && a.factualDescription) {
      aiByReportId.set(a.reportId, a.factualDescription);
    }
  }

  const pairs: CitywideDuplicatePair[] = [];
  const activeReports = reports.filter((r) => r.status !== 'rejected');

  for (let i = 0; i < activeReports.length; i++) {
    for (let j = i + 1; j < activeReports.length; j++) {
      const a = activeReports[i];
      const b = activeReports[j];

      const validA = isValidCoordinate(a.latitude, a.longitude);
      const validB = isValidCoordinate(b.latitude, b.longitude);
      const distanceMeters =
        validA && validB ? haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude) : null;

      const geoScore =
        distanceMeters === null
          ? 0
          : distanceMeters <= 50
            ? 1.0
            : distanceMeters <= 200
              ? 0.85
              : distanceMeters <= 500
                ? 0.6
                : distanceMeters <= 1500
                  ? 0.3
                  : 0;

      const categoryMatch = a.category === b.category ? 1 : 0;
      const textSimilarity = jaccardSimilarity(`${a.title} ${a.description}`, `${b.title} ${b.description}`);
      const aiDescA = aiByReportId.get(a.id) || '';
      const aiDescB = aiByReportId.get(b.id) || '';
      const hasBothAi = Boolean(aiDescA && aiDescB);
      const aiImageSimilarity = hasBothAi ? jaccardSimilarity(aiDescA, aiDescB) : 0;

      const aMs = toMillis(a.createdAt) || Date.now();
      const bMs = toMillis(b.createdAt) || Date.now();
      const timeDeltaHours = Math.round(Math.abs(aMs - bMs) / (1000 * 60 * 60));
      const timeScore =
        timeDeltaHours <= 48 ? 1.0 : timeDeltaHours <= 168 ? 0.75 : timeDeltaHours <= 720 ? 0.45 : 0.15;

      const matchScore = Number(
        (hasBothAi
          ? geoScore * 0.36 + categoryMatch * 0.22 + textSimilarity * 0.2 + aiImageSimilarity * 0.12 + timeScore * 0.1
          : geoScore * 0.42 + categoryMatch * 0.25 + textSimilarity * 0.23 + timeScore * 0.1
        ).toFixed(2)
      );

      const qualifies =
        matchScore >= 0.36 ||
        (distanceMeters !== null && distanceMeters <= 180 && categoryMatch === 1) ||
        (aiImageSimilarity >= 0.35 && categoryMatch === 1);

      if (!qualifies) continue;

      const reasons: string[] = [];
      if (distanceMeters !== null && distanceMeters <= 500) {
        reasons.push(`${distanceMeters}m apart`);
      }
      if (categoryMatch === 1) {
        reasons.push(`Same category (${CATEGORY_LABELS[a.category]})`);
      }
      if (textSimilarity >= 0.18) {
        reasons.push(`${Math.round(textSimilarity * 100)}% text overlap`);
      }
      if (aiImageSimilarity >= 0.18) {
        reasons.push(`${Math.round(aiImageSimilarity * 100)}% AI image-description overlap`);
      }
      if (timeDeltaHours <= 168) {
        reasons.push(`Submitted ${timeDeltaHours}h apart`);
      }

      const [first, second] = a.id <= b.id ? [a, b] : [b, a];
      pairs.push({
        pairId: `${first.id}__${second.id}`,
        reportAId: first.id,
        reportATrackingCode: first.trackingCode,
        reportATitle: first.title,
        reportAStatus: first.status,
        reportBId: second.id,
        reportBTrackingCode: second.trackingCode,
        reportBTitle: second.title,
        reportBStatus: second.status,
        category: first.category,
        distanceMeters,
        textSimilarity: Number(textSimilarity.toFixed(2)),
        aiImageSimilarity: Number(aiImageSimilarity.toFixed(2)),
        timeDeltaHours,
        matchScore,
        reasons: reasons.length > 0 ? reasons : ['Comparable issue metadata'],
        reportAAiDescription: aiByReportId.get(first.id) || undefined,
        reportBAiDescription: aiByReportId.get(second.id) || undefined,
      });
    }
  }

  return pairs.sort((x, y) => y.matchScore - x.matchScore).slice(0, 40);
}

const PRIORITY_RANK: Record<IssuePriority, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function clusterHotspots(
  reports: CivicReport[],
  filters: {
    category?: IssueCategory | 'all';
    priority?: IssuePriority | 'all';
    dateFromIso?: string;
    dateToIso?: string;
  } = {},
  radiusMeters = 350
): HotspotClusteringResult {
  const fromMs = filters.dateFromIso ? Date.parse(filters.dateFromIso) : NaN;
  const toMs = filters.dateToIso ? Date.parse(filters.dateToIso) + 24 * 60 * 60 * 1000 - 1 : NaN;

  const filtered = reports.filter((r) => {
    if (filters.category && filters.category !== 'all' && r.category !== filters.category) return false;
    if (filters.priority && filters.priority !== 'all' && r.priority !== filters.priority) return false;
    const cMs = toMillis(r.createdAt);
    if (!Number.isNaN(fromMs) && cMs > 0 && cMs < fromMs) return false;
    if (!Number.isNaN(toMs) && cMs > 0 && cMs > toMs) return false;
    return true;
  });

  const validLocationReports: CivicReport[] = [];
  const missingLocationReports: CivicReport[] = [];

  for (const r of filtered) {
    if (isValidCoordinate(r.latitude, r.longitude)) {
      validLocationReports.push(r);
    } else {
      missingLocationReports.push(r);
    }
  }

  const clusters: HotspotCluster[] = [];
  const assigned = new Set<string>();

  for (let i = 0; i < validLocationReports.length; i++) {
    const seed = validLocationReports[i];
    if (assigned.has(seed.id)) continue;

    const members: CivicReport[] = [seed];
    assigned.add(seed.id);

    if (radiusMeters > 0) {
      for (let j = 0; j < validLocationReports.length; j++) {
        const candidate = validLocationReports[j];
        if (assigned.has(candidate.id)) continue;
        const dist = haversineMeters(seed.latitude, seed.longitude, candidate.latitude, candidate.longitude);
        if (dist <= radiusMeters) {
          members.push(candidate);
          assigned.add(candidate.id);
        }
      }
    }

    const centroidLat = members.reduce((acc, m) => acc + m.latitude, 0) / members.length;
    const centroidLng = members.reduce((acc, m) => acc + m.longitude, 0) / members.length;

    const categoryCounts = new Map<IssueCategory, number>();
    let highestPriority: IssuePriority = 'low';
    for (const m of members) {
      categoryCounts.set(m.category, (categoryCounts.get(m.category) || 0) + 1);
      if (PRIORITY_RANK[m.priority] > PRIORITY_RANK[highestPriority]) {
        highestPriority = m.priority;
      }
    }

    let dominantCategory: IssueCategory = seed.category;
    let bestCatCount = -1;
    for (const [cat, count] of categoryCounts.entries()) {
      if (count > bestCatCount) {
        bestCatCount = count;
        dominantCategory = cat;
      }
    }

    const zones = members.map((m) => m.wardOrZone || m.addressText).filter(Boolean);
    const areaLabel = zones[0] || `${centroidLat.toFixed(4)}, ${centroidLng.toFixed(4)}`;
    const isRecurringZone = members.length >= 2 || members.some((m) => m.status === 'reopened');

    clusters.push({
      clusterId: `cluster_${seed.id}`,
      centroidLat: Number(centroidLat.toFixed(6)),
      centroidLng: Number(centroidLng.toFixed(6)),
      reportCount: members.length,
      isRecurringZone,
      dominantCategory,
      highestPriority,
      areaLabel,
      reports: members,
    });
  }

  clusters.sort((a, b) => b.reportCount - a.reportCount);

  return {
    validLocationReports,
    missingLocationReports,
    clusters,
  };
}

export function computeDepartmentPerformance(
  departments: Department[],
  reports: CivicReport[],
  assignments: Assignment[],
  reportUpdates: ReportUpdate[],
  sla: { ackSlaHours: number; resolveSlaHours: number } = { ackSlaHours: 24, resolveSlaHours: 72 },
  nowMs = Date.now()
): DepartmentPerformanceMetric[] {
  const updatesByReport = new Map<string, ReportUpdate[]>();
  for (const u of reportUpdates) {
    const arr = updatesByReport.get(u.reportId) || [];
    arr.push(u);
    updatesByReport.set(u.reportId, arr);
  }

  const assignmentByReport = new Map<string, Assignment>();
  for (const a of assignments) {
    const existing = assignmentByReport.get(a.reportId);
    if (!existing || toMillis(a.createdAt) < toMillis(existing.createdAt)) {
      assignmentByReport.set(a.reportId, a);
    }
  }

  const relevantDepts = departments.filter(
    (d) => d.active || reports.some((r) => r.departmentId === d.id)
  );

  return relevantDepts.map((dept) => {
    const deptReports = reports.filter((r) => r.departmentId === dept.id);
    const assignedCount = deptReports.length;

    const ackHoursList: number[] = [];
    const resolveHoursList: number[] = [];
    let pendingWorkload = 0;
    let overdueCount = 0;
    let outcomeEligible = 0;
    let confirmedCount = 0;

    for (const r of deptReports) {
      const updates = (updatesByReport.get(r.id) || [])
        .slice()
        .sort((a, b) => toMillis(a.createdAt) - toMillis(b.createdAt));

      const asg = assignmentByReport.get(r.id);
      const dispatchBaseMs =
        toMillis(asg?.createdAt) ||
        updates.find((u) => u.toStatus === 'verified')?.createdAt &&
          toMillis(updates.find((u) => u.toStatus === 'verified')?.createdAt) ||
        toMillis(r.createdAt);

      // Acknowledge = first transition to assigned / in_progress / resolved / rejected after dispatch
      const firstAckUpdate = updates.find(
        (u) =>
          (u.toStatus === 'assigned' ||
            u.toStatus === 'in_progress' ||
            u.toStatus === 'resolved') &&
          toMillis(u.createdAt) >= dispatchBaseMs
      );
      if (dispatchBaseMs && firstAckUpdate) {
        const ackMs = toMillis(firstAckUpdate.createdAt);
        if (ackMs >= dispatchBaseMs) {
          ackHoursList.push((ackMs - dispatchBaseMs) / (1000 * 60 * 60));
        }
      }

      const resolvedMs = getResolutionMillisForReport(r, updatesByReport);
      const createdMs = toMillis(r.createdAt);
      if (
        (r.status === 'resolved' || r.status === 'citizen_confirmed') &&
        createdMs &&
        resolvedMs &&
        resolvedMs >= createdMs
      ) {
        resolveHoursList.push((resolvedMs - createdMs) / (1000 * 60 * 60));
      }

      const isOpen =
        r.status !== 'resolved' && r.status !== 'citizen_confirmed' && r.status !== 'rejected';
      if (isOpen) {
        pendingWorkload++;
        const refMs = dispatchBaseMs || createdMs;
        if (refMs > 0) {
          const openHours = (nowMs - refMs) / (1000 * 60 * 60);
          if (openHours > sla.resolveSlaHours) {
            overdueCount++;
          } else if (
            (r.status === 'verified' || r.status === 'submitted' || r.status === 'reopened') &&
            openHours > sla.ackSlaHours
          ) {
            overdueCount++;
          }
        }
      }

      if (r.status === 'resolved' || r.status === 'citizen_confirmed' || r.status === 'reopened') {
        outcomeEligible++;
        if (r.status === 'citizen_confirmed') {
          confirmedCount++;
        }
      }
    }

    const avgAcknowledgeHours =
      ackHoursList.length > 0
        ? Number((ackHoursList.reduce((a, b) => a + b, 0) / ackHoursList.length).toFixed(1))
        : null;

    const avgResolutionHours =
      resolveHoursList.length > 0
        ? Number((resolveHoursList.reduce((a, b) => a + b, 0) / resolveHoursList.length).toFixed(1))
        : null;

    const confirmationRatePct =
      outcomeEligible > 0 ? Math.round((confirmedCount / outcomeEligible) * 100) : null;

    return {
      departmentId: dept.id,
      departmentName: dept.name,
      departmentCode: dept.code,
      assignedCount,
      ackSampleSize: ackHoursList.length,
      avgAcknowledgeHours,
      resolvedSampleSize: resolveHoursList.length,
      avgResolutionHours,
      pendingWorkload,
      overdueCount,
      confirmationSampleSize: outcomeEligible,
      confirmationRatePct,
      insufficientSample: assignedCount < 3,
    };
  });
}

export function computePriorityRecommendation(
  report: CivicReport,
  allReports: CivicReport[],
  aiAnalysis?: AiAnalysis | null,
  updates: ReportUpdate[] = [],
  nowMs = Date.now()
): PriorityIntelligenceResult {
  const combinedText = `${report.title} ${report.description} ${aiAnalysis?.factualDescription || ''}`.toLowerCase();

  // 1. Public safety implications (0 - 30 pts)
  let safetyPoints = 8;
  const criticalSafetyTerms = [
    'live wire',
    'electric shock',
    'sparks',
    'collapse',
    'collapsed',
    'sinkhole',
    'gas',
    'fire',
    'open manhole',
    'missing manhole',
    'flooded intersection',
    'live cable',
  ];
  const moderateSafetyTerms = [
    'dark',
    'no light',
    'accident',
    'slippery',
    'deep hole',
    'blocking road',
    'traffic',
    'school',
    'hospital',
    'pedestrian',
    'sewage',
    'overflow',
  ];
  const hitCritical = criticalSafetyTerms.filter((t) => combinedText.includes(t));
  const hitModerate = moderateSafetyTerms.filter((t) => combinedText.includes(t));
  let safetyObs = 'No acute life-safety keywords explicitly noted.';
  if (hitCritical.length > 0) {
    safetyPoints = 30;
    safetyObs = `Critical safety terms detected: ${hitCritical.slice(0, 3).join(', ')}.`;
  } else if (hitModerate.length > 0) {
    safetyPoints = 20;
    safetyObs = `Public hazard indicators present: ${hitModerate.slice(0, 3).join(', ')}.`;
  }

  // 2. Number of affected people if known (0 - 15 pts)
  let peoplePoints = 5;
  let peopleObs = 'Affected population count not stated in submission (baseline score).';
  const countMatch = combinedText.match(/\b(\d{1,4})\s+(people|residents|families|households|commuters|students|homes|houses)\b/);
  if (countMatch) {
    const num = Number(countMatch[1]);
    if (num >= 50) {
      peoplePoints = 15;
      peopleObs = `Report cites ~${num} ${countMatch[2]} impacted.`;
    } else if (num >= 10) {
      peoplePoints = 11;
      peopleObs = `Report cites ~${num} ${countMatch[2]} impacted.`;
    } else {
      peoplePoints = 8;
      peopleObs = `Report cites ${num} ${countMatch[2]} impacted.`;
    }
  } else if (/\b(entire street|whole block|neighborhood|market|main road|highway|school zone|hospital)\b/.test(combinedText)) {
    peoplePoints = 12;
    peopleObs = 'Text references a high-footfall or multi-household corridor.';
  }

  // 3. Issue type baseline (0 - 20 pts)
  const categoryScoreMap: Record<IssueCategory, number> = {
    water_leakage: 17,
    drainage: 16,
    streetlight: 14,
    pothole: 15,
    damaged_infrastructure: 16,
    public_park_damage: 13,
    garbage: 11,
    other: 10,
  };
  const issuePoints = categoryScoreMap[report.category] ?? 10;
  const issueObs = `${CATEGORY_LABELS[report.category]} category baseline urgency weight.`;

  // 4. Report recurrence (0 - 20 pts)
  const nearbySameCategory = allReports.filter((other) => {
    if (other.id === report.id) return false;
    if (other.category !== report.category) return false;
    if (isValidCoordinate(report.latitude, report.longitude) && isValidCoordinate(other.latitude, other.longitude)) {
      return haversineMeters(report.latitude, report.longitude, other.latitude, other.longitude) <= 400;
    }
    if (report.wardOrZone && other.wardOrZone) {
      return report.wardOrZone.trim().toLowerCase() === other.wardOrZone.trim().toLowerCase();
    }
    return false;
  }).length;

  const reopenEvents =
    (report.status === 'reopened' ? 1 : 0) +
    updates.filter((u) => u.toStatus === 'reopened').length;

  let recurrencePoints = 0;
  if (reopenEvents > 0) recurrencePoints += 12;
  if (nearbySameCategory >= 2) recurrencePoints += 10;
  else if (nearbySameCategory === 1) recurrencePoints += 6;
  recurrencePoints = Math.min(20, recurrencePoints);
  const recurrenceObs =
    reopenEvents > 0 || nearbySameCategory > 0
      ? `${nearbySameCategory} nearby same-category report(s) · ${reopenEvents} reopen event(s).`
      : 'No nearby repeat complaints or reopen events detected.';

  // 5. Duration unresolved (0 - 15 pts)
  const createdMs = toMillis(report.createdAt);
  const isClosed =
    report.status === 'resolved' ||
    report.status === 'citizen_confirmed' ||
    report.status === 'rejected';
  const unresolvedHours = createdMs > 0 && !isClosed ? Math.max(0, (nowMs - createdMs) / (1000 * 60 * 60)) : 0;
  let durationPoints = 0;
  if (!isClosed && createdMs > 0) {
    if (unresolvedHours >= 168) durationPoints = 15;
    else if (unresolvedHours >= 72) durationPoints = 11;
    else if (unresolvedHours >= 24) durationPoints = 6;
    else durationPoints = 2;
  }
  const durationObs = isClosed
    ? `Status is ${report.status.replace('_', ' ')} (no active aging penalty).`
    : createdMs > 0
      ? `Unresolved for ${formatDurationHours(unresolvedHours)}.`
      : 'Submission timestamp unavailable.';

  const factors: PriorityFactor[] = [
    { id: 'public_safety', label: 'Public Safety Impact', points: safetyPoints, maxPoints: 30, observation: safetyObs },
    { id: 'affected_people', label: 'Affected Population', points: peoplePoints, maxPoints: 15, observation: peopleObs },
    { id: 'issue_type', label: 'Issue Type Baseline', points: issuePoints, maxPoints: 20, observation: issueObs },
    { id: 'recurrence', label: 'Recurrence & Reopens', points: recurrencePoints, maxPoints: 20, observation: recurrenceObs },
    { id: 'duration_unresolved', label: 'Unresolved Duration', points: durationPoints, maxPoints: 15, observation: durationObs },
  ];

  const urgencyScore = Math.min(
    100,
    factors.reduce((acc, f) => acc + f.points, 0)
  );

  let recommendedPriority: IssuePriority = 'low';
  if (urgencyScore >= 72 || safetyPoints >= 30) {
    recommendedPriority = 'critical';
  } else if (urgencyScore >= 52) {
    recommendedPriority = 'high';
  } else if (urgencyScore >= 34) {
    recommendedPriority = 'medium';
  }

  const topReasons = factors
    .filter((f) => f.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 2)
    .map((f) => f.observation);

  return {
    reportId: report.id,
    trackingCode: report.trackingCode,
    currentPriority: report.priority,
    recommendedPriority,
    differsFromCurrent: report.priority !== recommendedPriority,
    urgencyScore,
    factors,
    rationaleSummary: `Advisory score ${urgencyScore}/100: ${topReasons.join(' ')}`,
  };
}

export function filterGovernanceReports(
  reports: CivicReport[],
  filters: {
    dateFromIso?: string;
    dateToIso?: string;
    departmentId?: string;
    category?: IssueCategory | 'all';
  }
): CivicReport[] {
  const fromMs = filters.dateFromIso ? Date.parse(filters.dateFromIso) : NaN;
  const toMs = filters.dateToIso ? Date.parse(filters.dateToIso) + 24 * 60 * 60 * 1000 - 1 : NaN;

  return reports.filter((r) => {
    if (filters.departmentId && filters.departmentId !== 'all') {
      if (filters.departmentId === '__unassigned__') {
        if (r.departmentId) return false;
      } else if (r.departmentId !== filters.departmentId) {
        return false;
      }
    }
    if (filters.category && filters.category !== 'all' && r.category !== filters.category) {
      return false;
    }
    const cMs = toMillis(r.createdAt);
    if (!Number.isNaN(fromMs) && cMs > 0 && cMs < fromMs) return false;
    if (!Number.isNaN(toMs) && cMs > 0 && cMs > toMs) return false;
    return true;
  });
}

function escapeCsvCell(val: unknown): string {
  const str = String(val ?? '').replace(/\r?\n/g, ' ');
  if (/[",]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generates an anonymized governance CSV export with ZERO citizen PII
 * (no reporterName, no reporterId, no emails, no phone numbers).
 */
export function generateGovernanceCsv(
  reports: CivicReport[],
  reportUpdates: ReportUpdate[]
): string {
  const updatesByReport = new Map<string, ReportUpdate[]>();
  for (const u of reportUpdates) {
    const arr = updatesByReport.get(u.reportId) || [];
    arr.push(u);
    updatesByReport.set(u.reportId, arr);
  }

  const headers = [
    'Tracking ID',
    'Title',
    'Category',
    'Priority',
    'Status',
    'Department',
    'Ward / Zone',
    'Latitude',
    'Longitude',
    'Submitted At (ISO)',
    'Updated At (ISO)',
    'Resolution Time (Hours)',
  ];

  const rows = reports.map((r) => {
    const createdMs = toMillis(r.createdAt);
    const updatedMs = toMillis(r.updatedAt);
    const resolvedMs = getResolutionMillisForReport(r, updatesByReport);
    const resolutionHours =
      createdMs && resolvedMs && resolvedMs >= createdMs
        ? ((resolvedMs - createdMs) / (1000 * 60 * 60)).toFixed(1)
        : '';

    const validCoord = isValidCoordinate(r.latitude, r.longitude);

    return [
      r.trackingCode,
      r.title,
      CATEGORY_LABELS[r.category] || r.category,
      r.priority,
      r.status,
      r.departmentName || 'Unassigned',
      r.wardOrZone || 'Unspecified',
      validCoord ? r.latitude.toFixed(5) : '',
      validCoord ? r.longitude.toFixed(5) : '',
      createdMs ? new Date(createdMs).toISOString() : '',
      updatedMs ? new Date(updatedMs).toISOString() : '',
      resolutionHours,
    ]
      .map(escapeCsvCell)
      .join(',');
  });

  return [headers.map(escapeCsvCell).join(','), ...rows].join('\n');
}

function scrubPiiText(text: string): string {
  return String(text || '')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[redacted]')
    .replace(/\b\+?\d[\d\s\-().]{7,}\d\b/g, '[redacted]')
    .trim();
}

export function buildAnonymizedTrendDigest(
  reports: CivicReport[],
  aiAnalyses: AiAnalysis[],
  departments: Department[],
  reportUpdates: ReportUpdate[],
  nowMs = Date.now()
): AnonymizedTrendDigest {
  const dash = computeDashboardIntelligence(reports, departments, reportUpdates, nowMs);
  const aiByReport = new Map<string, AiAnalysis>();
  for (const a of aiAnalyses) {
    if (a.reportId) aiByReport.set(a.reportId, a);
  }

  const statusBreakdown: Record<string, number> = {};
  for (const r of reports) {
    statusBreakdown[r.status] = (statusBreakdown[r.status] || 0) + 1;
  }

  const categoryBreakdown = (Object.keys(CATEGORY_LABELS) as IssueCategory[]).map((cat) => {
    const list = reports.filter((r) => r.category === cat);
    return {
      category: CATEGORY_LABELS[cat],
      count: list.length,
      openCount: list.filter(
        (r) => r.status !== 'resolved' && r.status !== 'citizen_confirmed' && r.status !== 'rejected'
      ).length,
      reopenedCount: list.filter((r) => r.status === 'reopened').length,
    };
  });

  const zoneMap = new Map<string, { count: number; categories: Set<string> }>();
  for (const r of reports) {
    const zone = scrubPiiText(r.wardOrZone || r.addressText || 'Unspecified zone').slice(0, 64);
    const entry = zoneMap.get(zone) || { count: 0, categories: new Set<string>() };
    entry.count++;
    entry.categories.add(CATEGORY_LABELS[r.category] || r.category);
    zoneMap.set(zone, entry);
  }

  const zoneBreakdown = Array.from(zoneMap.entries())
    .map(([zone, val]) => ({
      zone,
      count: val.count,
      categories: Array.from(val.categories),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const anonymizedSamples = reports.slice(0, 45).map((r) => {
    const cMs = toMillis(r.createdAt);
    const ageHours = cMs > 0 ? Math.max(0, Math.round((nowMs - cMs) / (1000 * 60 * 60))) : 0;
    const ai = aiByReport.get(r.id);
    return {
      trackingCode: r.trackingCode,
      category: CATEGORY_LABELS[r.category] || r.category,
      priority: r.priority,
      status: r.status,
      zone: scrubPiiText(r.wardOrZone || r.addressText || 'Unspecified').slice(0, 60),
      ageHours,
      summary: scrubPiiText(`${r.title}: ${r.description}`).slice(0, 180),
      aiSummary: ai?.factualDescription
        ? scrubPiiText(ai.factualDescription).slice(0, 150)
        : undefined,
    };
  });

  return {
    generatedAtIso: new Date(nowMs).toISOString(),
    totalReports: reports.length,
    statusBreakdown,
    categoryBreakdown,
    zoneBreakdown,
    departmentBreakdown: dash.departmentWorkload.map((d) => ({
      department: d.departmentName,
      assigned: d.total,
      resolved: d.resolved,
      pending: d.open,
    })),
    weeklyCounts: dash.weeklyTrends.map((w) => ({
      label: w.label,
      submitted: w.submitted,
      resolved: w.resolved,
    })),
    monthlyCounts: dash.monthlyTrends.map((m) => ({
      label: m.label,
      submitted: m.submitted,
      resolved: m.resolved,
    })),
    anonymizedSamples,
  };
}
