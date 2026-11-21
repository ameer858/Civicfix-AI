import crypto from 'node:crypto';
import { getSupabaseAdminClient } from '../supabaseClient.ts';
import {
  getEmailTransportStatus,
  sendAuthorityComplaintEmail,
  sendCitizenSubmissionReceiptEmail,
  type EmailTransportStatus,
} from './emailService.ts';
import type { CivicImageAssessment } from './geminiService.ts';

export type UserRole = 'citizen' | 'admin' | 'officer' | 'worker';

export interface AuthenticatedUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  name: string;
  photoUrl: string;
  role: UserRole;
  departmentId: string;
  idToken: string;
}

export const ALL_WORKER_AVAILABILITY_STATUSES = [
  'available',
  'assigned',
  'on_duty',
  'busy',
  'completed_shift',
  'unavailable',
] as const;

export type WorkerAvailabilityStatus = (typeof ALL_WORKER_AVAILABILITY_STATUSES)[number];

export function isWorkerAvailabilityStatus(val: string): val is WorkerAvailabilityStatus {
  return (ALL_WORKER_AVAILABILITY_STATUSES as readonly string[]).includes(val);
}

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

export function isUuid(val: unknown): val is string {
  return typeof val === 'string' && UUID_REGEX.test(val.trim());
}

export function normalizeUserRole(raw: unknown): UserRole {
  return raw === 'admin' || raw === 'officer' || raw === 'worker' || raw === 'citizen'
    ? raw
    : 'citizen';
}

export function sanitizeText(val: unknown, maxLen: number): string {
  return String(val ?? '').trim().slice(0, maxLen);
}

export function makeServerId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function makeWorkerInviteId(email: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(email.trim().toLowerCase())
    .digest('hex')
    .slice(0, 20);
  return `inv_${hash}`;
}

export const CANONICAL_STARTER_DEPARTMENTS: Array<{
  id: string;
  name: string;
  code: string;
  description: string;
  categories: string[];
}> = [
  {
    id: 'dept_roads_infrastructure',
    name: 'Public Works Department',
    code: 'PWD',
    description: 'Roadway damage, pothole repairs, bridges, sidewalks, and general public infrastructure.',
    categories: ['pothole', 'damaged_infrastructure', 'other'],
  },
  {
    id: 'dept_sanitation',
    name: 'Sanitation Department',
    code: 'SAN',
    description: 'Garbage collection, illegal dumping clearance, overflowing public bins, and street sweeping.',
    categories: ['garbage'],
  },
  {
    id: 'dept_electrical',
    name: 'Electricity Department',
    code: 'ELEC',
    description: 'Streetlight outages, traffic signal faults, electrical poles, and public illumination.',
    categories: ['streetlight'],
  },
  {
    id: 'dept_water_supply',
    name: 'Water Supply Department',
    code: 'WATER',
    description: 'Water main leakage, broken supply pipelines, hydrants, and potable pressure failures.',
    categories: ['water_leakage'],
  },
  {
    id: 'dept_drainage',
    name: 'Drainage Department',
    code: 'DRAIN',
    description: 'Clogged storm drains, stormwater channels, culverts, and localized street flooding.',
    categories: ['drainage'],
  },
  {
    id: 'dept_parks',
    name: 'Parks Department',
    code: 'PARKS',
    description: 'Public park damage, playground equipment hazards, fallen park trees, and green spaces.',
    categories: ['public_park_damage'],
  },
];

export const CATEGORY_LABEL_SERVER_MAP: Record<string, string> = {
  pothole: 'Pothole & Road Surface',
  garbage: 'Garbage & Waste',
  streetlight: 'Broken Streetlight',
  water_leakage: 'Water Leakage',
  drainage: 'Drainage Blockage',
  damaged_infrastructure: 'Damaged Infrastructure',
  public_park_damage: 'Public Park Damage',
  other: 'Other Civic Issue',
};

export const PRIORITY_LABEL_SERVER_MAP: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

const ALLOWED_REPORT_CATEGORIES = new Set([
  'pothole',
  'garbage',
  'streetlight',
  'water_leakage',
  'drainage',
  'damaged_infrastructure',
  'public_park_damage',
  'other',
]);

const DUMMY_EMAIL_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'test.com',
  'test.org',
  'test.net',
  'localhost',
  'invalid',
  'fake.com',
  'dummy.com',
  'mailinator.com',
  'tempmail.com',
  'placeholder.com',
  'your-domain.com',
  'domain.com',
  'sample.com',
  'acme.com',
  'civicfix.local',
]);

const DUMMY_EMAIL_PATTERNS = [
  /^dummy/i,
  /^fake/i,
  /^placeholder/i,
  /^test@/i,
  /^sample@/i,
  /@test\./i,
  /@example\./i,
  /\.local$/i,
  /\.invalid$/i,
  /\.test$/i,
  /\.example$/i,
];

export function validateNonDummyEmail(
  raw: string,
  allowEmpty = false
): { valid: boolean; email: string; error?: string } {
  const cleaned = String(raw || '').trim().toLowerCase().slice(0, 200);
  if (!cleaned) {
    if (allowEmpty) return { valid: true, email: '' };
    return { valid: false, email: '', error: 'Authority email address is required.' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(cleaned)) {
    return { valid: false, email: cleaned, error: `Invalid email address format: "${cleaned}".` };
  }
  const domain = cleaned.split('@')[1] || '';
  if (
    DUMMY_EMAIL_DOMAINS.has(domain) ||
    DUMMY_EMAIL_PATTERNS.some((re) => re.test(cleaned))
  ) {
    return {
      valid: false,
      email: cleaned,
      error: `Placeholder or dummy email addresses (${cleaned}) are not permitted. Enter a real municipal authority email.`,
    };
  }
  return { valid: true, email: cleaned };
}

export function resolveTargetDepartmentForCategory(category: string): {
  id: string;
  name: string;
} {
  const match = CANONICAL_STARTER_DEPARTMENTS.find((d) => d.categories.includes(category));
  return match
    ? { id: match.id, name: match.name }
    : { id: 'dept_roads_infrastructure', name: 'Public Works Department' };
}

export function resolveCanonicalDeptName(departmentId: string): string {
  if (!departmentId) return '';
  const match = CANONICAL_STARTER_DEPARTMENTS.find((d) => d.id === departmentId);
  return match ? match.name : '';
}

function asObj(val: unknown): Record<string, any> {
  return val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, any>) : {};
}

function asStrArray(val: unknown): string[] {
  return Array.isArray(val) ? val.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

function scrubPublicText(raw: string): string {
  return String(raw || '')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[redacted]')
    .replace(/\b\+?\d[\d\s().-]{7,}\d\b/g, '[redacted]')
    .trim()
    .slice(0, 260);
}

function derivePublicAreaLabel(wardOrZone: string, addressText: string): string {
  if (wardOrZone.trim()) return wardOrZone.trim().slice(0, 120);
  const parts = String(addressText || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    return parts.slice(-2).join(', ').replace(/\b\d{1,5}\s+/g, '').trim().slice(0, 120) || 'Municipal Service Area';
  }
  return (addressText || '').replace(/\b\d{1,5}\s+/g, '').trim().slice(0, 120) || 'Municipal Service Area';
}

// ------------------------------------------------------------------
// Shared Server Domain Interfaces
// ------------------------------------------------------------------

export interface ServerUserProfile {
  uid: string;
  displayName: string;
  role: UserRole;
  departmentId: string;
  departmentName: string;
  active: boolean;
  availabilityStatus?: WorkerAvailabilityStatus;
  availabilityNote?: string;
  workZone?: string;
  employeeId?: string;
  supervisorId?: string;
  supervisorName?: string;
  maxActiveTasks?: number;
  claimedInviteId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServerWorkerInvite {
  id: string;
  email: string;
  displayName: string;
  role: 'worker' | 'officer';
  departmentId: string;
  departmentName: string;
  workZone?: string;
  employeeId?: string;
  supervisorId?: string;
  supervisorName?: string;
  availabilityStatus: WorkerAvailabilityStatus;
  invitedByUid: string;
  claimed: boolean;
  claimedByUid?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServerDepartmentEmailSetting {
  departmentId: string;
  departmentName: string;
  officialAuthorityEmail: string;
  seniorAuthorityEmail: string;
  notificationEnabled: boolean;
  departmentContactPerson: string;
  emailVerified: boolean;
  updatedById: string;
  updatedByName: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServerAuthorityEmailLog {
  id: string;
  reportId: string;
  trackingCode: string;
  category: string;
  departmentId: string;
  departmentName: string;
  recipientEmail: string;
  ccEmail?: string;
  status: string;
  citizenNotificationStatus: string;
  statusNote: string;
  transportUsed: string;
  actorId: string;
  createdAt: string;
}

export interface ServerPublicTimelineEvent {
  stage: string;
  timestampIso: string;
  summary: string;
}

export interface ServerPublicReportSummary {
  id: string;
  trackingCode: string;
  title: string;
  category: string;
  priority: string;
  status: string;
  wardOrZone?: string;
  areaLabel: string;
  departmentId: string;
  departmentName?: string;
  resolutionSummary?: string;
  workStartedAtIso?: string;
  completedAtIso?: string;
  supervisorVerifiedAtIso?: string;
  timelineEvents: ServerPublicTimelineEvent[];
  createdAtIso: string;
  updatedAtIso: string;
}

export interface ServerPublicActivitySummary {
  id: string;
  ngoId: string;
  ngoName: string;
  title: string;
  description: string;
  category: string;
  locationLabel: string;
  wardOrZone?: string;
  scheduledDateIso: string;
  maxVolunteers: number;
  participantCount: number;
  status: 'approved' | 'completed';
  completionSummary?: string;
  completionPhotoCount?: number;
  createdAtIso: string;
  updatedAtIso: string;
}

export interface VerifiedUploadMetadataInput {
  url: string;
  publicId?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageProvider: 'cloudinary' | 'server_validated';
  storagePath: string;
  uploadedBy: string;
  uploadedAtIso: string;
}

export interface ServerCreateReportInput {
  title: string;
  description: string;
  category: string;
  addressText: string;
  wardOrZone?: string;
  latitude: number;
  longitude: number;
  uploads: VerifiedUploadMetadataInput[];
  verifiedAi: (CivicImageAssessment & {
    suggestedDepartmentId: string;
    suggestedDepartmentName: string;
  }) | null;
}

export interface ServerCivicReportRecord {
  id: string;
  trackingCode: string;
  reporterId: string;
  reporterName: string;
  title: string;
  description: string;
  category: string;
  priority: string;
  priorityRecommendation?: string;
  status: string;
  addressText: string;
  wardOrZone?: string;
  latitude: number;
  longitude: number;
  imageUrls: string[];
  imageMetadata: VerifiedUploadMetadataInput[];
  resolutionImageUrls: string[];
  resolutionImageMetadata: VerifiedUploadMetadataInput[];
  departmentId: string;
  departmentName?: string;
  authorizedOfficerIds: string[];
  assignedWorkerId: string;
  assignedWorkerName?: string;
  aiAnalysisId?: string;
  rejectionReason?: string;
  reopenReason?: string;
  resolutionNotes?: string;
  awaitingSupervisorVerification?: boolean;
  supervisorVerifiedAtIso?: string;
  supervisorVerifiedById?: string;
  supervisorVerifiedByName?: string;
  workStartedAtIso?: string;
  completedAtIso?: string;
  materialsUsed?: string;
  obstaclesEncountered?: string;
  hasActiveObstacle?: boolean;
  acknowledgedAtIso?: string;
  escalatedAtIso?: string;
  escalatedToId?: string;
  workerCheckInLabel?: string;
  workerCheckInLat?: number;
  workerCheckInLng?: number;
  deadlineIso?: string;
  supervisorId?: string;
  supervisorName?: string;
  reassignedAtIso?: string;
  delayExplanation?: string;
  assistanceRequestedAtIso?: string;
  assistanceRequestNote?: string;
  authorityEmailStatus?: string;
  authorityEmailStatusNote?: string;
  authorityEmailSentAtIso?: string;
  citizenNotificationStatus?: string;
  citizenNotificationStatusNote?: string;
  citizenNotifiedAtIso?: string;
  createdAt: string;
  updatedAt: string;
}

// ------------------------------------------------------------------
// Row <-> Domain Object Mappers for All 21 Supabase Tables
// ------------------------------------------------------------------

export function mapProfileRow(row: Record<string, any>): ServerUserProfile {
  const meta = asObj(row.metadata);
  const role = normalizeUserRole(row.role);
  const departmentId = typeof row.department_id === 'string' ? row.department_id : '';
  const departmentName =
    (typeof meta.departmentName === 'string' && meta.departmentName) ||
    resolveCanonicalDeptName(departmentId);
  const displayName =
    (typeof row.full_name === 'string' && row.full_name.trim()) ||
    (typeof row.email === 'string' && row.email.includes('@') ? row.email.split('@')[0] : '') ||
    'Civic User';
  const nowIso = new Date().toISOString();

  const profile: ServerUserProfile = {
    uid: String(row.id),
    displayName,
    role,
    departmentId,
    departmentName,
    active: row.is_active !== false,
    createdAt: row.created_at || nowIso,
    updatedAt: row.updated_at || nowIso,
  };

  if (typeof meta.availabilityStatus === 'string' && isWorkerAvailabilityStatus(meta.availabilityStatus)) {
    profile.availabilityStatus = meta.availabilityStatus;
  }
  if (typeof meta.availabilityNote === 'string' && meta.availabilityNote) {
    profile.availabilityNote = meta.availabilityNote;
  }
  if (typeof meta.workZone === 'string' && meta.workZone) profile.workZone = meta.workZone;
  if (typeof meta.employeeId === 'string' && meta.employeeId) profile.employeeId = meta.employeeId;
  if (typeof meta.supervisorId === 'string' && meta.supervisorId) profile.supervisorId = meta.supervisorId;
  if (typeof meta.supervisorName === 'string' && meta.supervisorName) {
    profile.supervisorName = meta.supervisorName;
  }
  if (typeof meta.maxActiveTasks === 'number') profile.maxActiveTasks = meta.maxActiveTasks;
  if (typeof meta.claimedInviteId === 'string' && meta.claimedInviteId) {
    profile.claimedInviteId = meta.claimedInviteId;
  }

  return profile;
}

export function mapDepartmentRow(row: Record<string, any>) {
  const meta = asObj(row.metadata);
  const canonical = CANONICAL_STARTER_DEPARTMENTS.find((d) => d.id === row.id);
  const nowIso = new Date().toISOString();
  return {
    id: String(row.id),
    name: String(row.name || canonical?.name || row.id),
    code: String(meta.code || canonical?.code || String(row.name || row.id).slice(0, 6).toUpperCase()),
    description: typeof row.description === 'string' ? row.description : canonical?.description || '',
    categories: asStrArray(row.categories).length > 0 ? asStrArray(row.categories) : canonical?.categories || [],
    officerIds: asStrArray(row.officer_ids),
    active: row.is_active !== false,
    createdAt: row.created_at || nowIso,
    updatedAt: row.updated_at || nowIso,
  };
}

export function mapReportRow(row: Record<string, any>): ServerCivicReportRecord {
  const meta = asObj(row.metadata);
  const nowIso = new Date().toISOString();
  const deptId = typeof row.department_id === 'string' ? row.department_id : '';
  const trackingCode =
    typeof meta.trackingCode === 'string' && meta.trackingCode
      ? meta.trackingCode
      : `CF-${new Date(row.created_at || nowIso).getFullYear()}-${String(row.id).slice(-6).toUpperCase()}`;

  return {
    id: String(row.id),
    trackingCode,
    reporterId: String(row.user_id || meta.reporterId || row.firebase_uid || ''),
    reporterName: String(meta.reporterName || 'Citizen Reporter'),
    title: String(row.title || 'Civic Issue'),
    description: String(row.description || ''),
    category: String(row.category || 'other'),
    priority: String(row.priority || 'medium'),
    priorityRecommendation: typeof meta.priorityRecommendation === 'string' ? meta.priorityRecommendation : undefined,
    status: String(row.status || 'submitted'),
    addressText: String(row.address || ''),
    wardOrZone: typeof meta.wardOrZone === 'string' ? meta.wardOrZone : '',
    latitude: typeof row.latitude === 'number' ? row.latitude : Number(row.latitude || 0),
    longitude: typeof row.longitude === 'number' ? row.longitude : Number(row.longitude || 0),
    imageUrls: asStrArray(row.image_urls),
    imageMetadata: Array.isArray(row.image_metadata) ? row.image_metadata : [],
    resolutionImageUrls: asStrArray(row.resolution_image_urls),
    resolutionImageMetadata: Array.isArray(row.resolution_image_metadata) ? row.resolution_image_metadata : [],
    departmentId: deptId,
    departmentName:
      (typeof meta.departmentName === 'string' && meta.departmentName) ||
      resolveCanonicalDeptName(deptId) ||
      undefined,
    authorizedOfficerIds: asStrArray(meta.authorizedOfficerIds),
    assignedWorkerId: typeof meta.assignedWorkerId === 'string' ? meta.assignedWorkerId : '',
    assignedWorkerName: typeof meta.assignedWorkerName === 'string' ? meta.assignedWorkerName : undefined,
    aiAnalysisId: typeof meta.aiAnalysisId === 'string' && meta.aiAnalysisId ? meta.aiAnalysisId : undefined,
    rejectionReason: typeof meta.rejectionReason === 'string' ? meta.rejectionReason : undefined,
    reopenReason: typeof meta.reopenReason === 'string' ? meta.reopenReason : undefined,
    resolutionNotes: typeof meta.resolutionNotes === 'string' ? meta.resolutionNotes : undefined,
    awaitingSupervisorVerification:
      typeof meta.awaitingSupervisorVerification === 'boolean' ? meta.awaitingSupervisorVerification : undefined,
    supervisorVerifiedAtIso:
      typeof meta.supervisorVerifiedAtIso === 'string' ? meta.supervisorVerifiedAtIso : undefined,
    supervisorVerifiedById:
      typeof meta.supervisorVerifiedById === 'string' ? meta.supervisorVerifiedById : undefined,
    supervisorVerifiedByName:
      typeof meta.supervisorVerifiedByName === 'string' ? meta.supervisorVerifiedByName : undefined,
    workStartedAtIso: typeof meta.workStartedAtIso === 'string' ? meta.workStartedAtIso : undefined,
    completedAtIso: typeof meta.completedAtIso === 'string' ? meta.completedAtIso : undefined,
    materialsUsed: typeof meta.materialsUsed === 'string' ? meta.materialsUsed : undefined,
    obstaclesEncountered:
      typeof meta.obstaclesEncountered === 'string' ? meta.obstaclesEncountered : undefined,
    hasActiveObstacle: typeof meta.hasActiveObstacle === 'boolean' ? meta.hasActiveObstacle : undefined,
    acknowledgedAtIso: typeof meta.acknowledgedAtIso === 'string' ? meta.acknowledgedAtIso : undefined,
    escalatedAtIso: typeof meta.escalatedAtIso === 'string' ? meta.escalatedAtIso : undefined,
    escalatedToId: typeof meta.escalatedToId === 'string' ? meta.escalatedToId : undefined,
    workerCheckInLabel: typeof meta.workerCheckInLabel === 'string' ? meta.workerCheckInLabel : undefined,
    workerCheckInLat: typeof meta.workerCheckInLat === 'number' ? meta.workerCheckInLat : undefined,
    workerCheckInLng: typeof meta.workerCheckInLng === 'number' ? meta.workerCheckInLng : undefined,
    deadlineIso: typeof meta.deadlineIso === 'string' ? meta.deadlineIso : undefined,
    supervisorId: typeof meta.supervisorId === 'string' ? meta.supervisorId : undefined,
    supervisorName: typeof meta.supervisorName === 'string' ? meta.supervisorName : undefined,
    reassignedAtIso: typeof meta.reassignedAtIso === 'string' ? meta.reassignedAtIso : undefined,
    delayExplanation: typeof meta.delayExplanation === 'string' ? meta.delayExplanation : undefined,
    assistanceRequestedAtIso:
      typeof meta.assistanceRequestedAtIso === 'string' ? meta.assistanceRequestedAtIso : undefined,
    assistanceRequestNote:
      typeof meta.assistanceRequestNote === 'string' ? meta.assistanceRequestNote : undefined,
    authorityEmailStatus:
      typeof meta.authorityEmailStatus === 'string' ? meta.authorityEmailStatus : undefined,
    authorityEmailStatusNote:
      typeof meta.authorityEmailStatusNote === 'string' ? meta.authorityEmailStatusNote : undefined,
    authorityEmailSentAtIso:
      typeof meta.authorityEmailSentAtIso === 'string' ? meta.authorityEmailSentAtIso : undefined,
    citizenNotificationStatus:
      typeof meta.citizenNotificationStatus === 'string' ? meta.citizenNotificationStatus : undefined,
    citizenNotificationStatusNote:
      typeof meta.citizenNotificationStatusNote === 'string' ? meta.citizenNotificationStatusNote : undefined,
    citizenNotifiedAtIso:
      typeof meta.citizenNotifiedAtIso === 'string' ? meta.citizenNotifiedAtIso : undefined,
    createdAt: row.created_at || nowIso,
    updatedAt: row.updated_at || nowIso,
  };
}

export function mapAssignmentRow(row: Record<string, any>) {
  const meta = asObj(row.metadata);
  const nowIso = new Date().toISOString();
  const deptId = typeof row.department_id === 'string' ? row.department_id : '';
  return {
    id: String(row.id),
    reportId: String(row.report_id || ''),
    trackingCode: String(meta.trackingCode || ''),
    reportTitle: String(meta.reportTitle || ''),
    departmentId: deptId,
    departmentName: String(meta.departmentName || resolveCanonicalDeptName(deptId) || 'Department'),
    assignedById: String(row.assigned_by || ''),
    authorizedOfficerIds: asStrArray(row.authorized_officer_ids),
    workerId: String(row.worker_id || meta.workerId || ''),
    workerName: typeof meta.workerName === 'string' ? meta.workerName : '',
    status: String(row.status || 'pending_worker'),
    priority: typeof meta.priority === 'string' ? meta.priority : undefined,
    deadlineIso: typeof meta.deadlineIso === 'string' ? meta.deadlineIso : undefined,
    supervisorId: typeof meta.supervisorId === 'string' ? meta.supervisorId : undefined,
    supervisorName: typeof meta.supervisorName === 'string' ? meta.supervisorName : undefined,
    instructions: typeof row.notes === 'string' ? row.notes : typeof meta.instructions === 'string' ? meta.instructions : undefined,
    reassignedFromWorkerId: typeof meta.reassignedFromWorkerId === 'string' ? meta.reassignedFromWorkerId : undefined,
    reassignedFromWorkerName: typeof meta.reassignedFromWorkerName === 'string' ? meta.reassignedFromWorkerName : undefined,
    reassignedCount: typeof meta.reassignedCount === 'number' ? meta.reassignedCount : undefined,
    reassignmentReason: typeof meta.reassignmentReason === 'string' ? meta.reassignmentReason : undefined,
    acknowledgedAtIso: typeof meta.acknowledgedAtIso === 'string' ? meta.acknowledgedAtIso : undefined,
    workStartedAtIso: row.started_at || (typeof meta.workStartedAtIso === 'string' ? meta.workStartedAtIso : undefined),
    completedAtIso: row.completed_at || (typeof meta.completedAtIso === 'string' ? meta.completedAtIso : undefined),
    supervisorVerifiedAtIso: typeof meta.supervisorVerifiedAtIso === 'string' ? meta.supervisorVerifiedAtIso : undefined,
    supervisorVerifiedById: typeof meta.supervisorVerifiedById === 'string' ? meta.supervisorVerifiedById : undefined,
    materialsUsed: typeof meta.materialsUsed === 'string' ? meta.materialsUsed : undefined,
    obstaclesEncountered: typeof meta.obstaclesEncountered === 'string' ? meta.obstaclesEncountered : undefined,
    delayExplanation: typeof meta.delayExplanation === 'string' ? meta.delayExplanation : undefined,
    assistanceRequestedAtIso: typeof meta.assistanceRequestedAtIso === 'string' ? meta.assistanceRequestedAtIso : undefined,
    assistanceRequestNote: typeof meta.assistanceRequestNote === 'string' ? meta.assistanceRequestNote : undefined,
    workerLocationSharingActive:
      typeof meta.workerLocationSharingActive === 'boolean' ? meta.workerLocationSharingActive : undefined,
    workerLocationLat: typeof meta.workerLocationLat === 'number' ? meta.workerLocationLat : undefined,
    workerLocationLng: typeof meta.workerLocationLng === 'number' ? meta.workerLocationLng : undefined,
    workerLocationUpdatedAtIso:
      typeof meta.workerLocationUpdatedAtIso === 'string' ? meta.workerLocationUpdatedAtIso : undefined,
    recommendationScore: typeof meta.recommendationScore === 'number' ? meta.recommendationScore : undefined,
    recommendationReason: typeof meta.recommendationReason === 'string' ? meta.recommendationReason : undefined,
    createdAt: row.created_at || nowIso,
    updatedAt: row.updated_at || nowIso,
  };
}

export function mapReportUpdateRow(row: Record<string, any>) {
  const meta = asObj(row.metadata);
  const nowIso = new Date().toISOString();
  return {
    id: String(row.id),
    reportId: String(row.report_id || ''),
    reporterId: String(meta.reporterId || ''),
    authorizedOfficerIds: asStrArray(row.authorized_officer_ids),
    assignedWorkerId: String(meta.assignedWorkerId || ''),
    actorId: String(row.user_id || meta.actorId || ''),
    actorName: String(meta.actorName || 'Civic User'),
    actorRole: normalizeUserRole(meta.actorRole),
    fromStatus: String(row.previous_status || ''),
    toStatus: String(row.new_status || ''),
    note: String(row.notes || row.message || ''),
    evidenceUrls: asStrArray(row.evidence_urls),
    createdAt: row.created_at || nowIso,
  };
}

export function mapAiAnalysisRow(row: Record<string, any>) {
  const meta = asObj(row.metadata);
  const raw = asObj(row.raw_response);
  const nowIso = new Date().toISOString();
  const visibleEvidence = Array.isArray(row.visible_evidence)
    ? row.visible_evidence.filter((x: unknown): x is string => typeof x === 'string')
    : [];
  const recs = Array.isArray(row.recommendations)
    ? row.recommendations.filter((x: unknown): x is string => typeof x === 'string')
    : [];
  const detected = Array.isArray(row.detected_issues)
    ? row.detected_issues.filter((x: unknown): x is string => typeof x === 'string')
    : [];

  return {
    id: String(row.id),
    reportId: String(row.report_id || ''),
    reporterId: String(meta.reporterId || ''),
    authorizedOfficerIds: asStrArray(row.authorized_officer_ids),
    detectedIssue: String(meta.detectedIssue || detected[0] || raw.detectedIssue || ''),
    suggestedCategory: String(row.category || raw.suggestedCategory || 'other'),
    factualDescription: String(row.summary || raw.factualDescription || ''),
    visibleEvidence,
    suggestedPriority: String(row.priority || raw.suggestedPriority || 'medium'),
    priorityExplanation: String(meta.priorityExplanation || raw.priorityExplanation || ''),
    suggestedDepartmentId: typeof meta.suggestedDepartmentId === 'string' ? meta.suggestedDepartmentId : undefined,
    suggestedDepartmentName: typeof meta.suggestedDepartmentName === 'string' ? meta.suggestedDepartmentName : undefined,
    recommendedAction: String(meta.recommendedAction || recs[0] || raw.recommendedAction || ''),
    confidenceScore: typeof row.confidence === 'number' ? row.confidence : Number(row.confidence || 0),
    imageQualityStatus: String(meta.imageQualityStatus || raw.imageQualityStatus || 'clear'),
    requiresHumanReview: Boolean(meta.requiresHumanReview ?? raw.requiresHumanReview ?? false),
    reviewReason: typeof meta.reviewReason === 'string' ? meta.reviewReason : String(raw.reviewReason || ''),
    advisoryOnly: true,
    modelUsed: String(meta.modelUsed || raw.modelUsed || 'gemini'),
    createdAt: row.created_at || nowIso,
  };
}

export function mapCitizenFeedbackRow(row: Record<string, any>) {
  const meta = asObj(row.metadata);
  const nowIso = new Date().toISOString();
  return {
    id: String(row.id),
    reportId: String(row.report_id || ''),
    citizenId: String(row.user_id || meta.citizenId || ''),
    authorizedOfficerIds: asStrArray(row.authorized_officer_ids),
    outcome: meta.outcome === 'reopened' ? 'reopened' : 'confirmed',
    rating: typeof row.rating === 'number' ? row.rating : Number(row.rating || 5),
    comment: String(row.feedback || ''),
    createdAt: row.created_at || nowIso,
  };
}

export function mapNotificationRow(row: Record<string, any>) {
  const nowIso = new Date().toISOString();
  return {
    id: String(row.id),
    recipientId: String(row.user_id || ''),
    reportId: String(row.related_report_id || ''),
    title: String(row.title || 'CivicFix Notification'),
    message: String(row.message || ''),
    type: String(row.type || 'status_change'),
    read: Boolean(row.is_read),
    createdAt: row.created_at || nowIso,
  };
}

export function mapAuditLogRow(row: Record<string, any>) {
  const meta = asObj(row.metadata);
  const nowIso = new Date().toISOString();
  return {
    id: String(row.id),
    reportId: String(row.entity_id || meta.reportId || ''),
    trackingCode: String(meta.trackingCode || ''),
    departmentId: String(meta.departmentId || ''),
    authorizedOfficerIds: asStrArray(row.authorized_officer_ids),
    assignedWorkerId: String(meta.assignedWorkerId || ''),
    actorId: String(row.user_id || meta.actorId || ''),
    actorName: String(meta.actorName || 'System'),
    actorRole: normalizeUserRole(meta.actorRole),
    action: String(row.action || 'update'),
    summary: String(row.description || meta.summary || ''),
    details: typeof meta.details === 'string' ? meta.details : undefined,
    createdAt: row.created_at || nowIso,
  };
}

export function mapSlaPolicyRow(row: Record<string, any>) {
  const meta = asObj(row.metadata);
  const nowIso = new Date().toISOString();
  const deptId = typeof row.department_id === 'string' ? row.department_id : '';
  return {
    id: String(row.id),
    scopeType: (meta.scopeType || 'global') as 'global' | 'department' | 'category' | 'department_category',
    departmentId: deptId,
    departmentName: String(meta.departmentName || resolveCanonicalDeptName(deptId) || ''),
    category: String(row.category || ''),
    ackTargetHours: typeof meta.ackTargetHours === 'number' ? meta.ackTargetHours : Number(row.response_time_hours || 4),
    assignTargetHours: typeof meta.assignTargetHours === 'number' ? meta.assignTargetHours : 12,
    resolveTargetHours: typeof meta.resolveTargetHours === 'number' ? meta.resolveTargetHours : Number(row.resolution_time_hours || 48),
    escalationRole: meta.escalationRole === 'officer' ? 'officer' : 'admin',
    updatedById: String(meta.updatedById || ''),
    createdAt: row.created_at || nowIso,
    updatedAt: row.updated_at || nowIso,
  };
}

export function mapOperationalAlertRow(row: Record<string, any>) {
  const meta = asObj(row.metadata);
  const nowIso = new Date().toISOString();
  const sevRaw = String(row.severity || 'warning');
  const severity = sevRaw === 'critical' || sevRaw === 'warning' || sevRaw === 'info' ? sevRaw : 'warning';
  return {
    id: String(row.id),
    alertKey: String(meta.alertKey || row.id),
    kind: String(row.alert_type || meta.kind || 'high_priority_report'),
    reportId: String(row.related_report_id || ''),
    trackingCode: String(meta.trackingCode || ''),
    departmentId: String(row.department_id || ''),
    authorizedOfficerIds: asStrArray(row.authorized_officer_ids),
    recipientIds: asStrArray(row.recipient_ids),
    severity,
    title: String(row.title || ''),
    message: String(row.message || ''),
    acknowledged: row.status === 'acknowledged' || row.status === 'resolved' || Boolean(row.resolved_at),
    createdAt: row.created_at || nowIso,
    updatedAt: row.updated_at || nowIso,
  };
}

export function mapWorkerInviteRow(row: Record<string, any>): ServerWorkerInvite {
  const meta = asObj(row.metadata);
  const nowIso = new Date().toISOString();
  const deptId = typeof row.department_id === 'string' ? row.department_id : '';
  const rawAvail = typeof meta.availabilityStatus === 'string' ? meta.availabilityStatus : 'available';
  return {
    id: String(row.id),
    email: String(row.email || '').toLowerCase(),
    displayName: String(row.full_name || meta.displayName || 'Field Worker'),
    role: row.role === 'officer' ? 'officer' : 'worker',
    departmentId: deptId,
    departmentName: String(meta.departmentName || resolveCanonicalDeptName(deptId)),
    workZone: typeof meta.workZone === 'string' ? meta.workZone : undefined,
    employeeId: typeof meta.employeeId === 'string' ? meta.employeeId : undefined,
    supervisorId: typeof meta.supervisorId === 'string' ? meta.supervisorId : undefined,
    supervisorName: typeof meta.supervisorName === 'string' ? meta.supervisorName : undefined,
    availabilityStatus: isWorkerAvailabilityStatus(rawAvail) ? rawAvail : 'available',
    invitedByUid: String(row.invited_by || ''),
    claimed: row.status === 'accepted' || Boolean(row.accepted_at),
    claimedByUid: typeof meta.claimedByUid === 'string' ? meta.claimedByUid : undefined,
    createdAt: row.created_at || nowIso,
    updatedAt: row.accepted_at || row.created_at || nowIso,
  };
}

export function mapDeptEmailSettingRow(row: Record<string, any>): ServerDepartmentEmailSetting {
  const meta = asObj(row.metadata);
  const ccList = asStrArray(row.cc_emails);
  const deptId = String(row.department_id || '');
  const officialEmail = String(row.recipient_email || '');
  const nowIso = new Date().toISOString();
  return {
    departmentId: deptId,
    departmentName: String(meta.departmentName || resolveCanonicalDeptName(deptId) || deptId),
    officialAuthorityEmail: officialEmail,
    seniorAuthorityEmail: ccList[0] || String(meta.seniorAuthorityEmail || ''),
    notificationEnabled: row.is_enabled !== false,
    departmentContactPerson: String(meta.departmentContactPerson || ''),
    emailVerified: Boolean(meta.emailVerified ?? Boolean(officialEmail)),
    updatedById: String(meta.updatedById || ''),
    updatedByName: String(meta.updatedByName || ''),
    createdAt: row.created_at || nowIso,
    updatedAt: row.updated_at || nowIso,
  };
}

export function mapAuthorityEmailLogRow(row: Record<string, any>): ServerAuthorityEmailLog {
  const meta = asObj(row.metadata);
  const nowIso = new Date().toISOString();
  const deptId = String(row.department_id || '');
  return {
    id: String(row.id),
    reportId: String(row.report_id || ''),
    trackingCode: String(meta.trackingCode || ''),
    category: String(meta.category || 'other'),
    departmentId: deptId,
    departmentName: String(meta.departmentName || resolveCanonicalDeptName(deptId) || ''),
    recipientEmail: String(row.recipient_email || ''),
    ccEmail: typeof meta.ccEmail === 'string' && meta.ccEmail ? meta.ccEmail : undefined,
    status: String(row.status || 'pending'),
    citizenNotificationStatus: String(meta.citizenNotificationStatus || 'sent'),
    statusNote: String(row.error_message || meta.statusNote || row.subject || ''),
    transportUsed: String(meta.transportUsed || 'none'),
    actorId: String(meta.actorId || ''),
    createdAt: row.created_at || nowIso,
  };
}

export function mapNgoRow(row: Record<string, any>) {
  const meta = asObj(row.metadata);
  const nowIso = new Date().toISOString();
  const statusRaw = String(row.status || 'pending');
  const verificationStatus =
    statusRaw === 'approved' || statusRaw === 'rejected' ? statusRaw : 'pending';
  return {
    id: String(row.id),
    ownerUid: String(meta.ownerUid || ''),
    ownerName: String(meta.ownerName || 'NGO Coordinator'),
    name: String(row.name || ''),
    registrationNumber: String(meta.registrationNumber || ''),
    focusAreas: asStrArray(row.focus_areas),
    operatingCityOrWard: String(row.address || meta.operatingCityOrWard || ''),
    description: String(row.description || ''),
    verificationStatus,
    reviewedByUid: typeof meta.reviewedByUid === 'string' ? meta.reviewedByUid : undefined,
    reviewedByName: typeof meta.reviewedByName === 'string' ? meta.reviewedByName : undefined,
    reviewNote: typeof meta.reviewNote === 'string' ? meta.reviewNote : undefined,
    createdAt: row.created_at || nowIso,
    updatedAt: row.updated_at || nowIso,
  };
}

export function mapVolunteerProfileRow(row: Record<string, any>) {
  const meta = asObj(row.metadata);
  const nowIso = new Date().toISOString();
  return {
    uid: String(row.id),
    displayName: String(row.full_name || 'Volunteer'),
    skills: asStrArray(row.skills),
    serviceArea: String(meta.serviceArea || ''),
    availability: String(row.availability_status || meta.availability || 'Weekends'),
    active: meta.active !== false,
    joinedActivityCount: typeof row.total_activities === 'number' ? row.total_activities : 0,
    createdAt: row.created_at || nowIso,
    updatedAt: row.updated_at || nowIso,
  };
}

export function mapCivicActivityRow(row: Record<string, any>) {
  const meta = asObj(row.metadata);
  const nowIso = new Date().toISOString();
  const statusRaw = String(row.status || 'pending_approval');
  const status =
    statusRaw === 'approved' || statusRaw === 'completed' || statusRaw === 'rejected'
      ? statusRaw
      : 'pending_approval';
  return {
    id: String(row.id),
    ngoId: String(row.organization_id || meta.ngoId || ''),
    ngoName: String(meta.ngoName || 'Municipal NGO Partner'),
    createdByUid: String(row.created_by || meta.createdByUid || ''),
    title: String(row.title || ''),
    description: String(row.description || ''),
    category: String(row.category || row.activity_type || 'other'),
    locationLabel: String(row.location || ''),
    wardOrZone: typeof meta.wardOrZone === 'string' ? meta.wardOrZone : '',
    scheduledDateIso: String(row.scheduled_at || meta.scheduledDateIso || nowIso),
    maxVolunteers: typeof meta.maxVolunteers === 'number' ? meta.maxVolunteers : 25,
    participantCount: typeof row.participant_count === 'number' ? row.participant_count : 0,
    relatedReportId: typeof meta.relatedReportId === 'string' ? meta.relatedReportId : '',
    status,
    reviewNote: typeof meta.reviewNote === 'string' ? meta.reviewNote : '',
    reviewedByUid: typeof meta.reviewedByUid === 'string' ? meta.reviewedByUid : '',
    completionSummary: typeof meta.completionSummary === 'string' ? meta.completionSummary : '',
    completionPhotoMetadata: Array.isArray(row.completion_photo_metadata)
      ? row.completion_photo_metadata
      : [],
    completionSubmittedAtIso: String(row.completed_at || meta.completionSubmittedAtIso || ''),
    createdAt: row.created_at || nowIso,
    updatedAt: row.updated_at || nowIso,
  };
}

export function mapPublicReportRow(row: Record<string, any>): ServerPublicReportSummary {
  const nowIso = new Date().toISOString();
  const teRaw = row.timeline_events;
  const meta = !Array.isArray(teRaw) && teRaw && typeof teRaw === 'object' ? asObj(teRaw.meta || teRaw) : {};
  const eventsRaw: any[] = Array.isArray(teRaw)
    ? teRaw
    : Array.isArray(teRaw?.events)
      ? teRaw.events
      : [];
  const timelineEvents: ServerPublicTimelineEvent[] = eventsRaw
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({
      stage: String(e.stage || row.status || 'submitted'),
      timestampIso: String(e.timestampIso || row.updated_at || nowIso),
      summary: String(e.summary || ''),
    }));

  const deptId = String(row.department_id || '');
  return {
    id: String(row.id),
    trackingCode: String(meta.trackingCode || `CF-${String(row.id).slice(-6).toUpperCase()}`),
    title: String(row.title || 'Civic Issue'),
    category: String(row.category || 'other'),
    priority: String(row.priority || 'medium'),
    status: String(row.status || 'submitted'),
    wardOrZone: typeof meta.wardOrZone === 'string' && meta.wardOrZone ? meta.wardOrZone : undefined,
    areaLabel: String(row.address || meta.areaLabel || 'Municipal Service Area'),
    departmentId: deptId,
    departmentName: String(meta.departmentName || resolveCanonicalDeptName(deptId) || ''),
    resolutionSummary:
      (typeof row.description === 'string' && row.description) ||
      (typeof meta.resolutionSummary === 'string' ? meta.resolutionSummary : undefined),
    workStartedAtIso: typeof meta.workStartedAtIso === 'string' ? meta.workStartedAtIso : undefined,
    completedAtIso: typeof meta.completedAtIso === 'string' ? meta.completedAtIso : undefined,
    supervisorVerifiedAtIso:
      typeof meta.supervisorVerifiedAtIso === 'string' ? meta.supervisorVerifiedAtIso : undefined,
    timelineEvents,
    createdAtIso: row.created_at || nowIso,
    updatedAtIso: row.updated_at || nowIso,
  };
}

export function mapPublicActivityRow(row: Record<string, any>): ServerPublicActivitySummary {
  const nowIso = new Date().toISOString();
  const meta = asObj(row.timeline_events);
  return {
    id: String(row.id),
    ngoId: String(meta.ngoId || ''),
    ngoName: String(meta.ngoName || 'Municipal NGO Partner'),
    title: String(row.title || ''),
    description: String(row.description || ''),
    category: String(row.category || row.activity_type || 'other'),
    locationLabel: String(row.location || ''),
    wardOrZone: typeof meta.wardOrZone === 'string' && meta.wardOrZone ? meta.wardOrZone : undefined,
    scheduledDateIso: String(row.scheduled_at || nowIso),
    maxVolunteers: typeof meta.maxVolunteers === 'number' ? meta.maxVolunteers : 25,
    participantCount: typeof row.participant_count === 'number' ? row.participant_count : 0,
    status: row.status === 'completed' ? 'completed' : 'approved',
    completionSummary: typeof meta.completionSummary === 'string' ? meta.completionSummary : undefined,
    completionPhotoCount:
      typeof meta.completionPhotoCount === 'number'
        ? meta.completionPhotoCount
        : Array.isArray(row.completion_photo_urls)
          ? row.completion_photo_urls.length
          : 0,
    createdAtIso: row.created_at || nowIso,
    updatedAtIso: row.updated_at || nowIso,
  };
}

// ------------------------------------------------------------------
// Starter Departments & Helpers
// ------------------------------------------------------------------

let canonicalSeededOnce = false;

export async function ensureCanonicalDepartmentsExist(adminUid?: string): Promise<void> {
  if (canonicalSeededOnce && !adminUid) return;
  const supabase = getSupabaseAdminClient();
  const { data: existingRows, error } = await supabase
    .from('departments')
    .select('id, name, officer_ids, is_active, metadata');
  if (error) {
    throw new Error(`Failed to read departments from Supabase: ${error.message}`);
  }

  const existingMap = new Map<string, any>();
  for (const r of existingRows || []) {
    existingMap.set(String(r.id), r);
  }

  const nowIso = new Date().toISOString();
  const upserts: Array<Record<string, any>> = [];
  for (const d of CANONICAL_STARTER_DEPARTMENTS) {
    const existing = existingMap.get(d.id);
    if (!existing) {
      upserts.push({
        id: d.id,
        name: d.name,
        description: d.description,
        categories: d.categories,
        officer_ids: adminUid && isUuid(adminUid) ? [adminUid] : [],
        is_active: true,
        metadata: { code: d.code },
        created_at: nowIso,
        updated_at: nowIso,
      });
    } else if (!existing.is_active) {
      await supabase
        .from('departments')
        .update({ is_active: true, updated_at: nowIso })
        .eq('id', d.id);
    }
  }

  if (upserts.length > 0) {
    const { error: upsertErr } = await supabase
      .from('departments')
      .upsert(upserts, { onConflict: 'id' });
    if (upsertErr) {
      console.warn('Canonical department seed warning:', upsertErr.message);
    }
  }
  canonicalSeededOnce = true;
}

export async function syncPublicReportProjection(
  report: ServerCivicReportRecord,
  options?: {
    eventStage?: string;
    eventSummary?: string;
    resolutionSummary?: string;
  }
): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const nowIso = new Date().toISOString();
  const { data: existing } = await supabase
    .from('public_reports')
    .select('timeline_events, description')
    .eq('id', report.id)
    .maybeSingle();

  const existingTe = existing?.timeline_events;
  const prevEvents: ServerPublicTimelineEvent[] = Array.isArray(existingTe)
    ? existingTe
    : Array.isArray(existingTe?.events)
      ? existingTe.events
      : [];

  const events = [...prevEvents];
  if (options?.eventStage && options?.eventSummary) {
    events.push({
      stage: options.eventStage,
      timestampIso: nowIso,
      summary: scrubPublicText(options.eventSummary),
    });
  } else if (events.length === 0) {
    events.push({
      stage: report.status,
      timestampIso: report.createdAt || nowIso,
      summary: 'Civic issue reported to municipal intake.',
    });
  }

  const areaLabel = derivePublicAreaLabel(report.wardOrZone || '', report.addressText || '');
  const resolutionSummary =
    options?.resolutionSummary !== undefined
      ? scrubPublicText(options.resolutionSummary)
      : existing?.description || scrubPublicText(report.resolutionNotes || '');

  const payload = {
    id: report.id,
    title: scrubPublicText(report.title).slice(0, 160),
    description: resolutionSummary,
    category: report.category,
    priority: report.priority,
    status: report.status,
    department_id: report.departmentId || null,
    address: areaLabel,
    latitude: null, // zero exact residential GPS exposure in public projection
    longitude: null,
    image_urls: [],
    timeline_events: {
      meta: {
        trackingCode: report.trackingCode,
        departmentName: report.departmentName || resolveCanonicalDeptName(report.departmentId),
        wardOrZone: report.wardOrZone || '',
        areaLabel,
        resolutionSummary,
        workStartedAtIso: report.workStartedAtIso || '',
        completedAtIso: report.completedAtIso || '',
        supervisorVerifiedAtIso: report.supervisorVerifiedAtIso || '',
      },
      events: events.slice(-25),
    },
    created_at: report.createdAt || nowIso,
    updated_at: nowIso,
  };

  await supabase.from('public_reports').upsert(payload, { onConflict: 'id' });
}

async function insertNotificationSafe(params: {
  id?: string;
  recipientId: string;
  reportId?: string;
  title: string;
  message: string;
  type: string;
}): Promise<void> {
  if (!isUuid(params.recipientId)) return;
  const supabase = getSupabaseAdminClient();
  const id = params.id || makeServerId('ntf');
  await supabase
    .from('notifications')
    .upsert(
      {
        id,
        user_id: params.recipientId,
        related_report_id: params.reportId || null,
        title: sanitizeText(params.title, 140),
        message: sanitizeText(params.message, 500),
        type: sanitizeText(params.type, 64),
        is_read: false,
        metadata: {},
        created_at: new Date().toISOString(),
      },
      { onConflict: 'id', ignoreDuplicates: true }
    );
}

async function insertReportUpdateSafe(params: {
  reportId: string;
  reporterId: string;
  authorizedOfficerIds: string[];
  assignedWorkerId: string;
  actorId: string;
  actorName: string;
  actorRole: UserRole;
  fromStatus: string;
  toStatus: string;
  note: string;
  evidenceUrls?: string[];
}): Promise<string> {
  const supabase = getSupabaseAdminClient();
  const id = makeServerId('upd');
  const { error } = await supabase.from('report_updates').insert({
    id,
    report_id: params.reportId,
    user_id: params.actorId,
    previous_status: params.fromStatus,
    new_status: params.toStatus,
    message: sanitizeText(params.note, 1000),
    notes: sanitizeText(params.note, 1000),
    evidence_urls: (params.evidenceUrls || []).slice(0, 5),
    authorized_officer_ids: (params.authorizedOfficerIds || []).slice(0, 10),
    metadata: {
      reporterId: params.reporterId,
      assignedWorkerId: params.assignedWorkerId || '',
      actorId: params.actorId,
      actorName: sanitizeText(params.actorName, 100),
      actorRole: params.actorRole,
    },
    created_at: new Date().toISOString(),
  });
  if (error) {
    throw new Error(`Failed to record report update: ${error.message}`);
  }
  return id;
}

async function insertAuditLogSafe(params: {
  reportId: string;
  trackingCode: string;
  departmentId: string;
  authorizedOfficerIds: string[];
  assignedWorkerId: string;
  actorId: string;
  actorName: string;
  actorRole: UserRole;
  action: string;
  summary: string;
  details?: string;
}): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const id = makeServerId('aud');
  await supabase.from('audit_logs').insert({
    id,
    user_id: isUuid(params.actorId) ? params.actorId : null,
    action: sanitizeText(params.action, 80),
    entity_type: 'report',
    entity_id: params.reportId,
    description: sanitizeText(params.summary, 400),
    authorized_officer_ids: (params.authorizedOfficerIds || []).slice(0, 10),
    metadata: {
      reportId: params.reportId,
      trackingCode: params.trackingCode,
      departmentId: params.departmentId,
      assignedWorkerId: params.assignedWorkerId || '',
      actorId: params.actorId,
      actorName: sanitizeText(params.actorName, 100),
      actorRole: params.actorRole,
      summary: sanitizeText(params.summary, 400),
      details: params.details ? sanitizeText(params.details, 600) : undefined,
    },
    created_at: new Date().toISOString(),
  });
}

// ------------------------------------------------------------------
// Public Transparency & Tracking Queries (Zero PII)
// ------------------------------------------------------------------

export async function fetchPublicReportsFromSupabase(limit = 300): Promise<ServerPublicReportSummary[]> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from('public_reports')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(Math.max(1, Math.min(500, limit)));

  if (error) {
    throw new Error(`Failed to fetch public reports: ${error.message}`);
  }

  if (data && data.length > 0) {
    return data.map(mapPublicReportRow);
  }

  // Fallback: derive zero-PII summaries directly from reports if public_reports hasn't been synced yet
  const { data: reportRows } = await supabase
    .from('reports')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(Math.max(1, Math.min(300, limit)));

  return (reportRows || []).map((row) => {
    const r = mapReportRow(row);
    return {
      id: r.id,
      trackingCode: r.trackingCode,
      title: scrubPublicText(r.title),
      category: r.category,
      priority: r.priority,
      status: r.status,
      wardOrZone: r.wardOrZone || undefined,
      areaLabel: derivePublicAreaLabel(r.wardOrZone || '', r.addressText),
      departmentId: r.departmentId,
      departmentName: r.departmentName || resolveCanonicalDeptName(r.departmentId),
      resolutionSummary: r.resolutionNotes ? scrubPublicText(r.resolutionNotes) : undefined,
      workStartedAtIso: r.workStartedAtIso,
      completedAtIso: r.completedAtIso,
      supervisorVerifiedAtIso: r.supervisorVerifiedAtIso,
      timelineEvents: [
        {
          stage: r.status,
          timestampIso: r.updatedAt,
          summary: `Complaint currently at stage: ${r.status.replace(/_/g, ' ')}.`,
        },
      ],
      createdAtIso: r.createdAt,
      updatedAtIso: r.updatedAt,
    };
  });
}

export async function fetchPublicReportByTrackingCodeFromSupabase(
  trackingCode: string
): Promise<ServerPublicReportSummary | null> {
  const cleanCode = trackingCode.trim().toUpperCase().slice(0, 32);
  if (!/^[A-Z0-9-]{4,32}$/.test(cleanCode)) return null;

  const supabase = getSupabaseAdminClient();

  // 1. Check reports by metadata->>trackingCode (authoritative)
  const { data: reportRow } = await supabase
    .from('reports')
    .select('*')
    .eq('metadata->>trackingCode', cleanCode)
    .limit(1)
    .maybeSingle();

  if (reportRow) {
    const report = mapReportRow(reportRow);
    const { data: pubRow } = await supabase
      .from('public_reports')
      .select('*')
      .eq('id', report.id)
      .maybeSingle();

    if (pubRow) {
      const mapped = mapPublicReportRow(pubRow);
      mapped.trackingCode = report.trackingCode;
      return mapped;
    }

    // Build zero-PII summary + public timeline from report_updates
    const { data: updRows } = await supabase
      .from('report_updates')
      .select('new_status, created_at, notes')
      .eq('report_id', report.id)
      .order('created_at', { ascending: true })
      .limit(25);

    const timelineEvents: ServerPublicTimelineEvent[] = (updRows || []).map((u) => ({
      stage: String(u.new_status || report.status),
      timestampIso: u.created_at || report.updatedAt,
      summary: scrubPublicText(String(u.notes || 'Status updated.')),
    }));

    return {
      id: report.id,
      trackingCode: report.trackingCode,
      title: scrubPublicText(report.title),
      category: report.category,
      priority: report.priority,
      status: report.status,
      wardOrZone: report.wardOrZone || undefined,
      areaLabel: derivePublicAreaLabel(report.wardOrZone || '', report.addressText),
      departmentId: report.departmentId,
      departmentName: report.departmentName || resolveCanonicalDeptName(report.departmentId),
      resolutionSummary: report.resolutionNotes ? scrubPublicText(report.resolutionNotes) : undefined,
      workStartedAtIso: report.workStartedAtIso,
      completedAtIso: report.completedAtIso,
      supervisorVerifiedAtIso: report.supervisorVerifiedAtIso,
      timelineEvents,
      createdAtIso: report.createdAt,
      updatedAtIso: report.updatedAt,
    };
  }

  // 2. Fallback: scan public_reports timeline_events->meta->>trackingCode
  const { data: pubMatch } = await supabase
    .from('public_reports')
    .select('*')
    .eq('timeline_events->meta->>trackingCode', cleanCode)
    .limit(1)
    .maybeSingle();

  return pubMatch ? mapPublicReportRow(pubMatch) : null;
}

export async function fetchPublicActivitiesFromSupabase(
  limit = 50
): Promise<ServerPublicActivitySummary[]> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from('public_activities')
    .select('*')
    .in('status', ['approved', 'completed'])
    .order('updated_at', { ascending: false })
    .limit(Math.max(1, Math.min(200, limit)));

  if (!error && data && data.length > 0) {
    return data.map(mapPublicActivityRow);
  }

  // Fallback to approved/completed civic_activities if public_activities is empty
  const { data: actRows } = await supabase
    .from('civic_activities')
    .select('*')
    .in('status', ['approved', 'completed'])
    .order('updated_at', { ascending: false })
    .limit(Math.max(1, Math.min(200, limit)));

  return (actRows || []).map((row) => {
    const a = mapCivicActivityRow(row);
    return {
      id: a.id,
      ngoId: a.ngoId,
      ngoName: a.ngoName,
      title: a.title,
      description: a.description,
      category: a.category,
      locationLabel: a.locationLabel,
      wardOrZone: a.wardOrZone || undefined,
      scheduledDateIso: a.scheduledDateIso,
      maxVolunteers: a.maxVolunteers,
      participantCount: a.participantCount,
      status: a.status === 'completed' ? 'completed' : 'approved',
      completionSummary: a.completionSummary || undefined,
      completionPhotoCount: a.completionPhotoMetadata.length,
      createdAtIso: a.createdAt,
      updatedAtIso: a.updatedAt,
    };
  });
}

// ------------------------------------------------------------------
// Report Retrieval, Authorization, Creation & AI Attachment
// ------------------------------------------------------------------

export function canUserAccessReport(user: AuthenticatedUser, report: ServerCivicReportRecord): boolean {
  if (user.role === 'admin') return true;
  if (user.role === 'officer') {
    return (
      report.authorizedOfficerIds.includes(user.uid) ||
      (Boolean(user.departmentId) && report.departmentId === user.departmentId)
    );
  }
  if (user.role === 'worker') {
    return report.assignedWorkerId === user.uid;
  }
  return report.reporterId === user.uid;
}

export async function fetchAccessibleReportsForUserSupabase(
  user: AuthenticatedUser,
  limitCount = 200
): Promise<{ scope: string; reports: ServerCivicReportRecord[] }> {
  const supabase = getSupabaseAdminClient();
  const safeLimit = Math.max(1, Math.min(500, Math.round(limitCount || 200)));

  let query = supabase
    .from('reports')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(safeLimit);

  if (user.role === 'citizen') {
    query = query.eq('user_id', user.uid);
  } else if (user.role === 'worker') {
    query = query.eq('metadata->>assignedWorkerId', user.uid);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to fetch civic reports from Supabase: ${error.message}`);
  }

  let mapped = (data || []).map(mapReportRow);
  if (user.role === 'officer') {
    mapped = mapped.filter((r) => canUserAccessReport(user, r));
  }

  const scope =
    user.role === 'admin'
      ? 'all_municipal_reports'
      : user.role === 'officer'
        ? 'department_authorized_reports'
        : user.role === 'worker'
          ? 'assigned_worker_tasks'
          : 'personal_reports_only';

  return { scope, reports: mapped };
}

export async function fetchSingleReportForUserSupabase(
  user: AuthenticatedUser,
  reportId: string
): Promise<ServerCivicReportRecord | null> {
  if (!SAFE_ID_REGEX.test(reportId)) {
    throw new Error('Invalid report ID.');
  }
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from('reports')
    .select('*')
    .eq('id', reportId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch report from Supabase: ${error.message}`);
  }
  if (!data) return null;

  const report = mapReportRow(data);
  if (!canUserAccessReport(user, report)) {
    throw new Error('You are not authorized to access this civic report.');
  }
  return report;
}

export async function fetchAccessibleReportsForDuplicatesSupabase(user: AuthenticatedUser): Promise<
  Array<{
    id: string;
    trackingCode: string;
    title: string;
    description: string;
    aiAnalysisId?: string;
    aiDescription?: string;
    category: string;
    status: string;
    addressText: string;
    latitude: number;
    longitude: number;
    createdAtIso: string;
  }>
> {
  const { reports } = await fetchAccessibleReportsForUserSupabase(user, 100);
  const aiIds = reports.map((r) => r.aiAnalysisId).filter((id): id is string => Boolean(id));
  const aiMap = new Map<string, string>();
  if (aiIds.length > 0) {
    const supabase = getSupabaseAdminClient();
    const { data: aiRows } = await supabase
      .from('ai_analyses')
      .select('id, summary')
      .in('id', aiIds);
    for (const a of aiRows || []) {
      if (a.id && a.summary) aiMap.set(String(a.id), String(a.summary));
    }
  }

  return reports.map((r) => ({
    id: r.id,
    trackingCode: r.trackingCode,
    title: r.title,
    description: r.description,
    aiAnalysisId: r.aiAnalysisId,
    aiDescription: r.aiAnalysisId ? aiMap.get(r.aiAnalysisId) || '' : '',
    category: r.category,
    status: r.status,
    addressText: r.addressText,
    latitude: r.latitude,
    longitude: r.longitude,
    createdAtIso: r.createdAt,
  }));
}

export async function createVerifiedCivicReportSupabase(
  caller: AuthenticatedUser,
  input: ServerCreateReportInput,
  options?: { gmailAccessToken?: string }
): Promise<{
  reportId: string;
  trackingCode: string;
  departmentId: string;
  departmentName: string;
  priority: string;
  aiAnalysisId: string;
  authorityEmailStatus: string;
  authorityEmailStatusNote: string;
  authorityEmailSentAtIso?: string;
  citizenNotificationStatus: string;
  citizenEmailSent: boolean;
  citizenEmailNote: string;
}> {
  await ensureCanonicalDepartmentsExist();

  const title = sanitizeText(input.title, 160);
  const description = sanitizeText(input.description, 2000);
  const category = sanitizeText(input.category, 64);
  const addressText = sanitizeText(input.addressText, 240);
  const wardOrZone = sanitizeText(input.wardOrZone || '', 80);

  if (title.length < 4) throw new Error('Report title must be at least 4 characters.');
  if (description.length < 10) throw new Error('Report description must be at least 10 characters.');
  if (!ALLOWED_REPORT_CATEGORIES.has(category)) {
    throw new Error(`Unsupported civic report category: "${category}".`);
  }
  if (addressText.length < 3) throw new Error('Location address must be at least 3 characters.');

  const safeLat = Number.isFinite(input.latitude) ? Math.max(-90, Math.min(90, input.latitude)) : 0;
  const safeLng = Number.isFinite(input.longitude) ? Math.max(-180, Math.min(180, input.longitude)) : 0;
  const uploads = Array.isArray(input.uploads) ? input.uploads.slice(0, 5) : [];

  const supabase = getSupabaseAdminClient();
  const { data: deptRows } = await supabase.from('departments').select('*').eq('is_active', true);
  let targetDept = (deptRows || []).find((d) => asStrArray(d.categories).includes(category));
  const fallbackCanonical = resolveTargetDepartmentForCategory(category);
  const departmentId = targetDept ? String(targetDept.id) : fallbackCanonical.id;
  const departmentName = targetDept ? String(targetDept.name) : fallbackCanonical.name;
  const authorizedOfficerIds = targetDept ? asStrArray(targetDept.officer_ids).slice(0, 10) : [];

  const { data: callerProfile } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', caller.uid)
    .maybeSingle();
  const reporterName = sanitizeText(callerProfile?.full_name || caller.name || 'Citizen Reporter', 100);

  const reportId = makeServerId('rep');
  const year = new Date().getFullYear();
  const trackingCode = `CF-${year}-${100000 + crypto.randomInt(900000)}`;
  const nowIso = new Date().toISOString();

  const priority = input.verifiedAi?.suggestedPriority || 'medium';
  const aiAnalysisId = input.verifiedAi ? makeServerId('ai') : '';

  const imageUrls = uploads.map((u) => u.url);
  const reportMetadata: Record<string, any> = {
    trackingCode,
    reporterId: caller.uid,
    reporterName,
    wardOrZone,
    departmentName,
    authorizedOfficerIds,
    assignedWorkerId: '',
    assignedWorkerName: '',
    aiAnalysisId: aiAnalysisId || undefined,
    priorityRecommendation: input.verifiedAi?.suggestedPriority || undefined,
    authorityEmailStatus: 'pending',
    authorityEmailStatusNote: 'Queued for municipal authority routing.',
    citizenNotificationStatus: 'sent',
    citizenNotificationStatusNote: 'In-app confirmation created.',
    citizenNotifiedAtIso: nowIso,
  };

  const { data: insertedReport, error: repErr } = await supabase
    .from('reports')
    .insert({
      id: reportId,
      user_id: caller.uid,
      title,
      description,
      category,
      priority,
      status: 'submitted',
      department_id: departmentId,
      address: addressText,
      latitude: safeLat,
      longitude: safeLng,
      image_urls: imageUrls,
      image_metadata: uploads,
      resolution_image_urls: [],
      resolution_image_metadata: [],
      ai_analysis: input.verifiedAi || null,
      metadata: reportMetadata,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select('*')
    .single();

  if (repErr || !insertedReport) {
    throw new Error(`Failed to persist civic report in Supabase: ${repErr?.message || 'Unknown error'}`);
  }

  if (input.verifiedAi && aiAnalysisId) {
    await supabase.from('ai_analyses').insert({
      id: aiAnalysisId,
      report_id: reportId,
      category: input.verifiedAi.suggestedCategory,
      priority: input.verifiedAi.suggestedPriority,
      confidence: input.verifiedAi.confidenceScore,
      summary: sanitizeText(input.verifiedAi.factualDescription, 2000),
      detected_issues: input.verifiedAi.detectedIssue ? [input.verifiedAi.detectedIssue] : [],
      recommendations: input.verifiedAi.recommendedAction ? [input.verifiedAi.recommendedAction] : [],
      visible_evidence: Array.isArray(input.verifiedAi.visibleEvidence) ? input.verifiedAi.visibleEvidence : [],
      authorized_officer_ids: authorizedOfficerIds,
      raw_response: input.verifiedAi,
      metadata: {
        reporterId: caller.uid,
        detectedIssue: input.verifiedAi.detectedIssue,
        priorityExplanation: input.verifiedAi.priorityExplanation,
        suggestedDepartmentId: input.verifiedAi.suggestedDepartmentId,
        suggestedDepartmentName: input.verifiedAi.suggestedDepartmentName,
        recommendedAction: input.verifiedAi.recommendedAction,
        imageQualityStatus: input.verifiedAi.imageQualityStatus,
        requiresHumanReview: input.verifiedAi.requiresHumanReview,
        reviewReason: input.verifiedAi.reviewReason,
        modelUsed: input.verifiedAi.modelUsed,
        advisoryOnly: true,
      },
      created_at: nowIso,
    });
  }

  const mappedReport = mapReportRow(insertedReport);

  await insertReportUpdateSafe({
    reportId,
    reporterId: caller.uid,
    authorizedOfficerIds,
    assignedWorkerId: '',
    actorId: caller.uid,
    actorName: reporterName,
    actorRole: caller.role,
    fromStatus: 'submitted',
    toStatus: 'submitted',
    note: input.verifiedAi
      ? `Report submitted with ${uploads.length} photo(s) and Gemini AI visual triage (${input.verifiedAi.suggestedCategory}, ${input.verifiedAi.suggestedPriority}).`
      : `Report submitted with ${uploads.length} photo(s).`,
    evidenceUrls: [],
  });

  await insertNotificationSafe({
    recipientId: caller.uid,
    reportId,
    title: `Report ${trackingCode} submitted`,
    message: `Your report "${title}" was routed to ${departmentName}.`,
    type: 'status_change',
  });

  await syncPublicReportProjection(mappedReport, {
    eventStage: 'submitted',
    eventSummary: `Civic issue submitted and routed to ${departmentName}.`,
  });

  // Process department authority email routing
  let authorityEmailStatus = 'pending';
  let authorityEmailStatusNote = 'Queued for municipal authority routing.';
  let authorityEmailSentAtIso: string | undefined;
  let citizenNotificationStatus = 'sent';
  let citizenEmailSent = false;
  let citizenEmailNote = 'In-app confirmation delivered.';

  try {
    const routing = await processReportAuthorityEmailRoutingSupabase(caller, reportId, {
      gmailAccessToken: options?.gmailAccessToken,
    });
    authorityEmailStatus = routing.authorityEmailStatus;
    authorityEmailStatusNote = routing.authorityEmailStatusNote;
    authorityEmailSentAtIso = routing.authorityEmailSentAtIso;
    citizenNotificationStatus = routing.citizenNotificationStatus;
  } catch (routeErr) {
    authorityEmailStatus = 'failed';
    authorityEmailStatusNote =
      routeErr instanceof Error ? routeErr.message.slice(0, 300) : 'Authority email routing failed.';
  }

  // Send citizen confirmation receipt email if transport/Gmail available
  if (caller.email && validateNonDummyEmail(caller.email, false).valid) {
    try {
      const citizenMail = await sendCitizenSubmissionReceiptEmail({
        to: caller.email,
        citizenName: reporterName,
        trackingCode,
        reportTitle: title,
        categoryLabel: CATEGORY_LABEL_SERVER_MAP[category] || category,
        departmentName,
        addressText,
        gmailAccessToken: options?.gmailAccessToken,
        gmailSenderEmail: caller.email,
      });
      citizenEmailSent = citizenMail.sent;
      citizenEmailNote = citizenMail.note;
    } catch {
      citizenEmailSent = false;
    }
  }

  return {
    reportId,
    trackingCode,
    departmentId,
    departmentName,
    priority,
    aiAnalysisId,
    authorityEmailStatus,
    authorityEmailStatusNote,
    authorityEmailSentAtIso,
    citizenNotificationStatus,
    citizenEmailSent,
    citizenEmailNote,
  };
}

export async function attachVerifiedAiAnalysisSupabase(
  caller: AuthenticatedUser,
  params: {
    reportId: string;
    verifiedAi: CivicImageAssessment & {
      suggestedDepartmentId: string;
      suggestedDepartmentName: string;
    };
  }
): Promise<{ analysisId: string; reportId: string }> {
  if (!SAFE_ID_REGEX.test(params.reportId)) {
    throw new Error('Invalid report ID.');
  }
  const supabase = getSupabaseAdminClient();
  const { data: row, error } = await supabase
    .from('reports')
    .select('*')
    .eq('id', params.reportId)
    .maybeSingle();

  if (error || !row) {
    throw new Error(`Civic report "${params.reportId}" was not found.`);
  }
  const report = mapReportRow(row);
  if (
    report.reporterId !== caller.uid &&
    caller.role !== 'admin' &&
    !(caller.role === 'officer' && canUserAccessReport(caller, report))
  ) {
    throw new Error('Only the reporting citizen or authorized staff can attach AI analysis.');
  }

  const analysisId = makeServerId('ai');
  const nowIso = new Date().toISOString();

  const { error: aiErr } = await supabase.from('ai_analyses').insert({
    id: analysisId,
    report_id: report.id,
    category: params.verifiedAi.suggestedCategory,
    priority: params.verifiedAi.suggestedPriority,
    confidence: params.verifiedAi.confidenceScore,
    summary: sanitizeText(params.verifiedAi.factualDescription, 2000),
    detected_issues: params.verifiedAi.detectedIssue ? [params.verifiedAi.detectedIssue] : [],
    recommendations: params.verifiedAi.recommendedAction ? [params.verifiedAi.recommendedAction] : [],
    visible_evidence: Array.isArray(params.verifiedAi.visibleEvidence) ? params.verifiedAi.visibleEvidence : [],
    authorized_officer_ids: report.authorizedOfficerIds,
    raw_response: params.verifiedAi,
    metadata: {
      reporterId: report.reporterId,
      detectedIssue: params.verifiedAi.detectedIssue,
      priorityExplanation: params.verifiedAi.priorityExplanation,
      suggestedDepartmentId: params.verifiedAi.suggestedDepartmentId,
      suggestedDepartmentName: params.verifiedAi.suggestedDepartmentName,
      recommendedAction: params.verifiedAi.recommendedAction,
      imageQualityStatus: params.verifiedAi.imageQualityStatus,
      requiresHumanReview: params.verifiedAi.requiresHumanReview,
      reviewReason: params.verifiedAi.reviewReason,
      modelUsed: params.verifiedAi.modelUsed,
      advisoryOnly: true,
    },
    created_at: nowIso,
  });

  if (aiErr) {
    throw new Error(`Failed to save AI analysis: ${aiErr.message}`);
  }

  const nextMeta = {
    ...asObj(row.metadata),
    aiAnalysisId: analysisId,
    priorityRecommendation: params.verifiedAi.suggestedPriority,
  };
  await supabase
    .from('reports')
    .update({
      ai_analysis: params.verifiedAi,
      metadata: nextMeta,
      updated_at: nowIso,
    })
    .eq('id', report.id);

  return { analysisId, reportId: report.id };
}

// ------------------------------------------------------------------
// Transition Authorization Validator
// ------------------------------------------------------------------

export async function verifyReportTransitionAuthorizationSupabase(
  user: AuthenticatedUser,
  params: {
    reportId?: string;
    fromStatus: string;
    toStatus: string;
    action?: string;
    departmentId?: string;
    officerId?: string;
    workerId?: string;
    expectedWorkerId?: string;
    deadlineIso?: string;
    supervisorId?: string;
  }
): Promise<{ ok: boolean; statusCode: number; error?: string }> {
  const supabase = getSupabaseAdminClient();
  const {
    reportId,
    fromStatus,
    action,
    departmentId,
    officerId,
    workerId,
    expectedWorkerId,
    deadlineIso,
    supervisorId,
  } = params;

  if (reportId) {
    if (!SAFE_ID_REGEX.test(reportId)) {
      return { ok: false, statusCode: 400, error: 'Invalid reportId format.' };
    }
    const { data: row, error } = await supabase
      .from('reports')
      .select('*')
      .eq('id', reportId)
      .maybeSingle();

    if (error || !row) {
      return { ok: false, statusCode: 404, error: `Target report "${reportId}" was not found.` };
    }

    const report = mapReportRow(row);
    if (report.status !== fromStatus) {
      return {
        ok: false,
        statusCode: 409,
        error: `Stale report state: current status is '${report.status}', not '${fromStatus}'.`,
      };
    }

    if (user.role === 'citizen') {
      if (report.reporterId !== user.uid) {
        return {
          ok: false,
          statusCode: 403,
          error: 'Citizens can only take actions on reports they submitted themselves.',
        };
      }
      if (action === 'submit_feedback') {
        const { data: existingFb } = await supabase
          .from('citizen_feedback')
          .select('id, metadata')
          .eq('report_id', reportId)
          .eq('user_id', user.uid);
        if ((existingFb || []).some((f) => asObj(f.metadata).outcome !== 'reopened')) {
          return { ok: false, statusCode: 409, error: 'Feedback has already been submitted for this report.' };
        }
      }
    } else if (user.role === 'worker') {
      if (report.assignedWorkerId !== user.uid) {
        return {
          ok: false,
          statusCode: 403,
          error: 'Field workers can only update tasks explicitly assigned to them.',
        };
      }
    } else if (user.role === 'officer') {
      if (!canUserAccessReport(user, report)) {
        return {
          ok: false,
          statusCode: 403,
          error: 'Officers can only manage reports assigned to their department.',
        };
      }
    }

    if (
      action === 'assign_worker' &&
      typeof expectedWorkerId === 'string' &&
      expectedWorkerId !== report.assignedWorkerId
    ) {
      return {
        ok: false,
        statusCode: 409,
        error: 'Assignment conflict: another supervisor already modified this task assignment. Please refresh.',
      };
    }
  }

  if (departmentId) {
    const { data: deptRow } = await supabase
      .from('departments')
      .select('id, is_active')
      .eq('id', departmentId)
      .maybeSingle();
    if (!deptRow) {
      return { ok: false, statusCode: 400, error: `Department "${departmentId}" does not exist.` };
    }
  }

  if (officerId && isUuid(officerId)) {
    const { data: offRow } = await supabase
      .from('profiles')
      .select('id, role, is_active')
      .eq('id', officerId)
      .maybeSingle();
    if (!offRow || (offRow.role !== 'officer' && offRow.role !== 'admin')) {
      return { ok: false, statusCode: 400, error: 'Selected officer does not have Officer or Admin role.' };
    }
    if (offRow.is_active === false) {
      return { ok: false, statusCode: 400, error: 'Selected officer account is inactive.' };
    }
  }

  if (supervisorId && isUuid(supervisorId)) {
    const { data: supRow } = await supabase
      .from('profiles')
      .select('id, role, is_active')
      .eq('id', supervisorId)
      .maybeSingle();
    if (!supRow || (supRow.role !== 'officer' && supRow.role !== 'admin')) {
      return { ok: false, statusCode: 400, error: 'Selected supervisor must have Officer or Admin role.' };
    }
  }

  if (workerId) {
    if (!isUuid(workerId)) {
      return { ok: false, statusCode: 400, error: 'Invalid worker ID.' };
    }
    const { data: workerRow } = await supabase
      .from('profiles')
      .select('id, role, is_active, metadata')
      .eq('id', workerId)
      .maybeSingle();
    if (!workerRow) {
      return { ok: false, statusCode: 400, error: 'Selected field worker does not exist.' };
    }
    if (workerRow.role !== 'worker') {
      return { ok: false, statusCode: 400, error: 'Selected user does not have Field Worker role.' };
    }
    if (workerRow.is_active === false) {
      return { ok: false, statusCode: 400, error: 'Selected field worker account is inactive.' };
    }
    if (asObj(workerRow.metadata).availabilityStatus === 'unavailable') {
      return { ok: false, statusCode: 400, error: 'Selected field worker is currently marked Unavailable.' };
    }
  }

  if (deadlineIso && Number.isNaN(Date.parse(deadlineIso))) {
    return { ok: false, statusCode: 400, error: 'Invalid deadline timestamp format.' };
  }

  return { ok: true, statusCode: 200 };
}

// ------------------------------------------------------------------
// Department Authority Email Settings & Routing (Supabase)
// ------------------------------------------------------------------

export async function listDepartmentEmailSettingsForAdminSupabase(
  caller: AuthenticatedUser
): Promise<{
  transport: EmailTransportStatus;
  settings: ServerDepartmentEmailSetting[];
  logs: ServerAuthorityEmailLog[];
}> {
  if (caller.role !== 'admin') {
    throw new Error('Only authorized administrators can view department authority email configuration.');
  }
  await ensureCanonicalDepartmentsExist(caller.uid);
  const supabase = getSupabaseAdminClient();

  const [{ data: deptRows }, { data: settingRows }, { data: logRows }] = await Promise.all([
    supabase.from('departments').select('id, name, is_active').eq('is_active', true),
    supabase.from('department_email_settings').select('*'),
    supabase
      .from('authority_email_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  const settingMap = new Map<string, ServerDepartmentEmailSetting>();
  for (const r of settingRows || []) {
    const mapped = mapDeptEmailSettingRow(r);
    settingMap.set(mapped.departmentId, mapped);
  }

  const activeDepts = new Map<string, string>();
  for (const d of CANONICAL_STARTER_DEPARTMENTS) activeDepts.set(d.id, d.name);
  for (const d of deptRows || []) {
    if (d.id && d.name) activeDepts.set(String(d.id), String(d.name));
  }

  const nowIso = new Date().toISOString();
  const settings: ServerDepartmentEmailSetting[] = [];
  for (const [deptId, deptName] of activeDepts.entries()) {
    const existing = settingMap.get(deptId);
    if (existing) {
      settings.push({ ...existing, departmentName: existing.departmentName || deptName });
    } else {
      settings.push({
        departmentId: deptId,
        departmentName: deptName,
        officialAuthorityEmail: '',
        seniorAuthorityEmail: '',
        notificationEnabled: true,
        departmentContactPerson: '',
        emailVerified: false,
        updatedById: '',
        updatedByName: '',
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
  }

  const logs = (logRows || []).map(mapAuthorityEmailLogRow);

  return {
    transport: getEmailTransportStatus(),
    settings,
    logs,
  };
}

export async function saveDepartmentEmailSettingAsAdminSupabase(
  caller: AuthenticatedUser,
  departmentId: string,
  params: {
    departmentName: string;
    officialAuthorityEmail: string;
    seniorAuthorityEmail: string;
    notificationEnabled: boolean;
    departmentContactPerson: string;
  }
): Promise<ServerDepartmentEmailSetting> {
  if (caller.role !== 'admin') {
    throw new Error('Only authorized administrators can update department authority email configuration.');
  }
  if (!SAFE_ID_REGEX.test(departmentId)) {
    throw new Error('Invalid department ID.');
  }
  await ensureCanonicalDepartmentsExist(caller.uid);

  const officialCheck = validateNonDummyEmail(params.officialAuthorityEmail, true);
  if (!officialCheck.valid) {
    throw new Error(officialCheck.error || 'Invalid official authority email.');
  }
  const seniorCheck = validateNonDummyEmail(params.seniorAuthorityEmail, true);
  if (!seniorCheck.valid) {
    throw new Error(seniorCheck.error || 'Invalid senior authority email.');
  }

  const cleanName = sanitizeText(params.departmentName, 120);
  if (cleanName.length < 2) {
    throw new Error('Department Name must be at least 2 characters.');
  }
  const cleanContact = sanitizeText(params.departmentContactPerson, 120);
  const notificationEnabled = Boolean(params.notificationEnabled);
  const emailVerified = Boolean(officialCheck.email && officialCheck.valid);
  const nowIso = new Date().toISOString();

  const supabase = getSupabaseAdminClient();
  const { data: saved, error } = await supabase
    .from('department_email_settings')
    .upsert(
      {
        department_id: departmentId,
        recipient_email: officialCheck.email || null,
        cc_emails: seniorCheck.email ? [seniorCheck.email] : [],
        is_enabled: notificationEnabled,
        metadata: {
          departmentName: cleanName,
          seniorAuthorityEmail: seniorCheck.email,
          departmentContactPerson: cleanContact,
          emailVerified,
          updatedById: caller.uid,
          updatedByName: sanitizeText(caller.name || caller.email || caller.uid, 100),
        },
        updated_at: nowIso,
      },
      { onConflict: 'department_id' }
    )
    .select('*')
    .single();

  if (error || !saved) {
    throw new Error(`Failed to save department email setting: ${error?.message || 'Unknown error'}`);
  }

  return mapDeptEmailSettingRow(saved);
}

export async function processReportAuthorityEmailRoutingSupabase(
  caller: AuthenticatedUser,
  reportId: string,
  options?: { gmailAccessToken?: string }
): Promise<{
  reportId: string;
  departmentId: string;
  departmentName: string;
  authorityEmailStatus: string;
  authorityEmailStatusNote: string;
  authorityEmailSentAtIso?: string;
  citizenNotificationStatus: string;
  adminAlerted: boolean;
}> {
  if (!SAFE_ID_REGEX.test(reportId)) {
    throw new Error('Invalid report ID.');
  }
  const supabase = getSupabaseAdminClient();
  const { data: reportRow, error: repErr } = await supabase
    .from('reports')
    .select('*')
    .eq('id', reportId)
    .maybeSingle();

  if (repErr || !reportRow) {
    throw new Error('Target civic report was not found.');
  }

  const report = mapReportRow(reportRow);
  if (report.reporterId !== caller.uid && caller.role !== 'admin') {
    throw new Error('Only the submitting citizen or an administrator can trigger initial department routing.');
  }

  const resolvedDept = resolveTargetDepartmentForCategory(report.category);
  const targetDeptId = report.departmentId || resolvedDept.id;
  let targetDeptName = report.departmentName || resolvedDept.name;

  const retryableStatuses = new Set(['pending', 'not_configured', 'smtp_not_configured', 'failed']);
  if (
    report.authorityEmailStatus &&
    !retryableStatuses.has(report.authorityEmailStatus) &&
    caller.role !== 'admin'
  ) {
    return {
      reportId,
      departmentId: targetDeptId,
      departmentName: targetDeptName,
      authorityEmailStatus: report.authorityEmailStatus,
      authorityEmailStatusNote: report.authorityEmailStatusNote || 'Authority email status already recorded.',
      authorityEmailSentAtIso: report.authorityEmailSentAtIso,
      citizenNotificationStatus: report.citizenNotificationStatus || 'sent',
      adminAlerted: false,
    };
  }

  const { data: settingRow } = await supabase
    .from('department_email_settings')
    .select('*')
    .eq('department_id', targetDeptId)
    .maybeSingle();

  const setting = settingRow ? mapDeptEmailSettingRow(settingRow) : null;
  if (setting?.departmentName) targetDeptName = setting.departmentName;

  let aiSummary = '';
  if (report.aiAnalysisId) {
    const { data: aiRow } = await supabase
      .from('ai_analyses')
      .select('summary')
      .eq('id', report.aiAnalysisId)
      .maybeSingle();
    if (aiRow?.summary) aiSummary = String(aiRow.summary);
  }

  const officialEmailCheck = validateNonDummyEmail(setting?.officialAuthorityEmail || '', false);
  const seniorEmailCheck = validateNonDummyEmail(setting?.seniorAuthorityEmail || '', true);

  let finalStatus: string;
  let finalNote: string;
  let sentAtIso: string | undefined;
  let transportUsed: 'smtp' | 'resend' | 'gmail' | 'none' = 'none';
  let needsAdminAlert = false;

  if (!setting || !setting.officialAuthorityEmail || !officialEmailCheck.valid || !setting.emailVerified) {
    finalStatus = 'not_configured';
    finalNote =
      'Authority email not configured for this department. Configure a verified official email in Authority Emails.';
    needsAdminAlert = true;
  } else if (!setting.notificationEnabled) {
    finalStatus = 'disabled';
    finalNote = `Email notifications disabled for ${targetDeptName}.`;
  } else {
    const ccEmail =
      seniorEmailCheck.valid &&
      seniorEmailCheck.email &&
      seniorEmailCheck.email.toLowerCase() !== officialEmailCheck.email.toLowerCase()
        ? seniorEmailCheck.email
        : undefined;

    const dispatchOutcome = await sendAuthorityComplaintEmail({
      to: officialEmailCheck.email,
      cc: ccEmail,
      trackingCode: report.trackingCode,
      reportId,
      reportTitle: report.title,
      categoryLabel: CATEGORY_LABEL_SERVER_MAP[report.category] || report.category,
      priorityLabel: PRIORITY_LABEL_SERVER_MAP[report.priority] || report.priority,
      departmentName: targetDeptName,
      departmentContactPerson: setting.departmentContactPerson || undefined,
      addressText: report.addressText,
      wardOrZone: report.wardOrZone || '',
      latitude: report.latitude,
      longitude: report.longitude,
      description: report.description,
      reporterName: report.reporterName,
      submittedAtIso: report.createdAt,
      aiSummary: aiSummary || undefined,
      gmailAccessToken: options?.gmailAccessToken,
      gmailSenderEmail: caller.email || undefined,
    });
    finalStatus = dispatchOutcome.status;
    finalNote = dispatchOutcome.statusNote.slice(0, 400);
    sentAtIso = dispatchOutcome.sentAtIso;
    transportUsed = dispatchOutcome.transportUsed;
    if (!dispatchOutcome.sent) needsAdminAlert = true;
  }

  const nowIso = new Date().toISOString();
  const nextMeta = {
    ...asObj(reportRow.metadata),
    authorityEmailStatus: finalStatus,
    authorityEmailStatusNote: finalNote,
    ...(sentAtIso ? { authorityEmailSentAtIso: sentAtIso } : {}),
  };

  await supabase
    .from('reports')
    .update({ metadata: nextMeta, updated_at: nowIso })
    .eq('id', reportId);

  const logId = makeServerId('ael');
  await supabase.from('authority_email_logs').insert({
    id: logId,
    report_id: reportId,
    department_id: targetDeptId,
    recipient_email: officialEmailCheck.valid ? officialEmailCheck.email : null,
    subject: `[CivicFix ${report.trackingCode}] ${report.title}`.slice(0, 200),
    status: finalStatus,
    error_message: finalNote,
    sent_at: sentAtIso || null,
    metadata: {
      trackingCode: report.trackingCode,
      category: report.category,
      departmentName: targetDeptName,
      ccEmail: seniorEmailCheck.valid ? seniorEmailCheck.email : undefined,
      citizenNotificationStatus: report.citizenNotificationStatus || 'sent',
      statusNote: finalNote,
      transportUsed,
      actorId: caller.uid,
    },
    created_at: nowIso,
  });

  let adminAlerted = false;
  if (needsAdminAlert) {
    const [{ data: adminProfiles }, { data: deptRow }] = await Promise.all([
      supabase.from('profiles').select('id').eq('role', 'admin').eq('is_active', true),
      supabase.from('departments').select('officer_ids').eq('id', targetDeptId).maybeSingle(),
    ]);
    const deptOfficers = asStrArray(deptRow?.officer_ids);
    const recipients = Array.from(
      new Set([...(adminProfiles || []).map((p) => String(p.id)), ...deptOfficers])
    )
      .filter((id) => isUuid(id))
      .slice(0, 10);

    if (recipients.length > 0) {
      const alertId = `alt_email_${targetDeptId}_${reportId}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
      const alertTitle =
        finalStatus === 'not_configured'
          ? `Authority email not configured: ${targetDeptName}`
          : `Authority email alert (${report.trackingCode})`;
      const alertMsg =
        finalStatus === 'not_configured'
          ? `Report ${report.trackingCode} was routed to ${targetDeptName}, but no verified authority email is configured.`
          : `Report ${report.trackingCode} (${targetDeptName}): ${finalNote}`.slice(0, 480);

      await supabase
        .from('operational_alerts')
        .upsert(
          {
            id: alertId,
            title: alertTitle.slice(0, 140),
            message: alertMsg,
            alert_type: 'authority_email_missing',
            severity: finalStatus === 'not_configured' ? 'critical' : 'warning',
            related_report_id: reportId,
            department_id: targetDeptId,
            recipient_ids: recipients,
            authorized_officer_ids: deptOfficers.slice(0, 10),
            status: 'active',
            metadata: { alertKey: alertId, trackingCode: report.trackingCode, kind: 'authority_email_missing' },
            created_at: nowIso,
            updated_at: nowIso,
          },
          { onConflict: 'id', ignoreDuplicates: true }
        );

      for (const uid of recipients.slice(0, 4)) {
        await insertNotificationSafe({
          id: `ntf_aem_${reportId}_${uid}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120),
          recipientId: uid,
          reportId,
          title: alertTitle,
          message: alertMsg,
          type: 'authority_email_alert',
        });
      }
      adminAlerted = true;
    }
  }

  return {
    reportId,
    departmentId: targetDeptId,
    departmentName: targetDeptName,
    authorityEmailStatus: finalStatus,
    authorityEmailStatusNote: finalNote,
    authorityEmailSentAtIso: sentAtIso,
    citizenNotificationStatus: report.citizenNotificationStatus || 'sent',
    adminAlerted,
  };
}

// ------------------------------------------------------------------
// Workforce, Role & Invite Management (Supabase)
// ------------------------------------------------------------------

export async function registerWorkerInviteSupabase(
  caller: AuthenticatedUser,
  params: {
    email: string;
    displayName: string;
    role: 'worker' | 'officer';
    departmentId: string;
    workZone?: string;
    employeeId?: string;
    supervisorId?: string;
    supervisorName?: string;
    availabilityStatus?: WorkerAvailabilityStatus;
  }
): Promise<ServerWorkerInvite> {
  if (caller.role !== 'admin' && caller.role !== 'officer') {
    throw new Error('Only administrators or department officers can register authorized field workers.');
  }
  if (caller.role === 'officer' && params.role !== 'worker') {
    throw new Error('Department supervisors can only register Field Workers.');
  }
  const cleanEmail = sanitizeText(params.email, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new Error('A valid staff email address is required.');
  }
  const cleanName = sanitizeText(params.displayName, 100);
  if (cleanName.length < 2) throw new Error('Staff full name must be at least 2 characters.');

  const cleanDeptId = sanitizeText(params.departmentId, 128);
  if (!cleanDeptId) throw new Error('A valid municipal department is required.');
  if (caller.role === 'officer' && caller.departmentId && caller.departmentId !== cleanDeptId) {
    throw new Error('Department supervisors can only invite workers to their own department.');
  }

  await ensureCanonicalDepartmentsExist();
  const supabase = getSupabaseAdminClient();
  const { data: deptRow } = await supabase
    .from('departments')
    .select('id, name')
    .eq('id', cleanDeptId)
    .maybeSingle();
  if (!deptRow) {
    throw new Error(`Department "${cleanDeptId}" does not exist.`);
  }

  let resolvedSupName = sanitizeText(params.supervisorName || '', 100);
  const cleanSupId = sanitizeText(params.supervisorId || '', 128);
  if (cleanSupId && isUuid(cleanSupId)) {
    const { data: supRow } = await supabase
      .from('profiles')
      .select('id, role, full_name')
      .eq('id', cleanSupId)
      .maybeSingle();
    if (!supRow || (supRow.role !== 'officer' && supRow.role !== 'admin')) {
      throw new Error('Selected supervisor must have Officer or Administrator role.');
    }
    if (!resolvedSupName && supRow.full_name) resolvedSupName = String(supRow.full_name);
  }

  const inviteId = makeWorkerInviteId(cleanEmail);
  const nowIso = new Date().toISOString();
  const safeAvail =
    params.availabilityStatus && isWorkerAvailabilityStatus(params.availabilityStatus)
      ? params.availabilityStatus
      : 'available';

  const { data: saved, error } = await supabase
    .from('worker_invites')
    .upsert(
      {
        id: inviteId,
        email: cleanEmail,
        full_name: cleanName,
        department_id: cleanDeptId,
        role: params.role,
        invited_by: isUuid(caller.uid) ? caller.uid : null,
        status: 'pending',
        metadata: {
          displayName: cleanName,
          departmentName: String(deptRow.name),
          workZone: sanitizeText(params.workZone || '', 120),
          employeeId: sanitizeText(params.employeeId || '', 64),
          supervisorId: cleanSupId,
          supervisorName: resolvedSupName,
          availabilityStatus: safeAvail,
        },
        created_at: nowIso,
      },
      { onConflict: 'id' }
    )
    .select('*')
    .single();

  if (error || !saved) {
    throw new Error(`Failed to register worker invite: ${error?.message || 'Unknown error'}`);
  }
  return mapWorkerInviteRow(saved);
}

export async function updateWorkerOperationalProfileSupabase(
  caller: AuthenticatedUser,
  params: {
    targetUid: string;
    availabilityStatus?: WorkerAvailabilityStatus;
    availabilityNote?: string;
    workZone?: string;
    employeeId?: string;
    supervisorId?: string;
    supervisorName?: string;
    maxActiveTasks?: number;
    departmentId?: string;
  }
): Promise<ServerUserProfile> {
  const targetUid = sanitizeText(params.targetUid, 128);
  if (!isUuid(targetUid)) {
    throw new Error('Invalid target user ID.');
  }

  const isSelf = caller.uid === targetUid;
  if (!isSelf && caller.role !== 'admin' && caller.role !== 'officer') {
    throw new Error('Only administrators, department officers, or the worker themselves can update operational availability.');
  }

  const supabase = getSupabaseAdminClient();
  const { data: targetRow, error: fetchErr } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', targetUid)
    .maybeSingle();

  if (fetchErr || !targetRow) {
    throw new Error(`User "${targetUid}" was not found.`);
  }

  const existingMeta = asObj(targetRow.metadata);
  const nextMeta = { ...existingMeta };
  let nextDeptId: string | null = targetRow.department_id || null;

  if (params.availabilityStatus !== undefined) {
    if (!isWorkerAvailabilityStatus(params.availabilityStatus)) {
      throw new Error('Invalid worker availability status.');
    }
    nextMeta.availabilityStatus = params.availabilityStatus;
  }
  if (params.availabilityNote !== undefined) {
    nextMeta.availabilityNote = sanitizeText(params.availabilityNote, 240);
  }
  if (params.workZone !== undefined) {
    nextMeta.workZone = sanitizeText(params.workZone, 120);
  }

  if (caller.role === 'admin' || caller.role === 'officer') {
    if (params.employeeId !== undefined) nextMeta.employeeId = sanitizeText(params.employeeId, 64);
    if (params.maxActiveTasks !== undefined && Number.isFinite(params.maxActiveTasks)) {
      nextMeta.maxActiveTasks = Math.max(1, Math.min(20, Math.round(params.maxActiveTasks)));
    }
    if (params.supervisorId !== undefined) {
      const cleanSup = sanitizeText(params.supervisorId, 128);
      if (cleanSup && isUuid(cleanSup)) {
        const { data: supRow } = await supabase
          .from('profiles')
          .select('id, role, full_name')
          .eq('id', cleanSup)
          .maybeSingle();
        if (!supRow || (supRow.role !== 'officer' && supRow.role !== 'admin')) {
          throw new Error('Selected supervisor must have Officer or Administrator role.');
        }
        nextMeta.supervisorId = cleanSup;
        nextMeta.supervisorName = sanitizeText(params.supervisorName || supRow.full_name || '', 100);
      } else {
        nextMeta.supervisorId = '';
        nextMeta.supervisorName = '';
      }
    }
    if (params.departmentId !== undefined && caller.role === 'admin') {
      const cleanDept = sanitizeText(params.departmentId, 128);
      if (cleanDept) {
        const { data: deptRow } = await supabase
          .from('departments')
          .select('id, name')
          .eq('id', cleanDept)
          .maybeSingle();
        if (!deptRow) throw new Error(`Department "${cleanDept}" does not exist.`);
        nextDeptId = cleanDept;
        nextMeta.departmentName = String(deptRow.name);
      } else {
        nextDeptId = null;
        nextMeta.departmentName = '';
      }
    }
  }

  const { data: updated, error: updErr } = await supabase
    .from('profiles')
    .update({
      department_id: nextDeptId,
      metadata: nextMeta,
      updated_at: new Date().toISOString(),
    })
    .eq('id', targetUid)
    .select('*')
    .single();

  if (updErr || !updated) {
    throw new Error(`Failed to update worker operational profile: ${updErr?.message || 'Unknown error'}`);
  }
  return mapProfileRow(updated);
}

export async function updateUserRoleAsAdminSupabase(
  adminUser: AuthenticatedUser,
  params: {
    targetUid: string;
    role: UserRole;
    departmentId: string;
    active: boolean;
  }
): Promise<ServerUserProfile> {
  if (adminUser.role !== 'admin') {
    throw new Error('Only authorized administrators can update user roles.');
  }
  const { targetUid, role, departmentId, active } = params;
  if (!isUuid(targetUid)) {
    throw new Error('Invalid target user ID.');
  }
  if (!['citizen', 'admin', 'officer', 'worker'].includes(role)) {
    throw new Error(`Invalid role "${role}".`);
  }
  if (targetUid === adminUser.uid && (role !== 'admin' || !active)) {
    throw new Error('Administrators cannot demote or deactivate their own active administrator account.');
  }

  const supabase = getSupabaseAdminClient();
  const { data: targetRow, error: fetchErr } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', targetUid)
    .maybeSingle();

  if (fetchErr || !targetRow) {
    throw new Error(`User "${targetUid}" was not found.`);
  }

  const cleanDeptId = sanitizeText(departmentId, 128);
  let resolvedDeptName = '';
  if (cleanDeptId) {
    const { data: deptRow } = await supabase
      .from('departments')
      .select('id, name, officer_ids')
      .eq('id', cleanDeptId)
      .maybeSingle();
    if (!deptRow) {
      throw new Error(`Department "${cleanDeptId}" does not exist.`);
    }
    resolvedDeptName = String(deptRow.name);
    if (role === 'officer') {
      const existingOfficers = asStrArray(deptRow.officer_ids);
      if (!existingOfficers.includes(targetUid)) {
        await supabase
          .from('departments')
          .update({
            officer_ids: [...existingOfficers, targetUid].slice(0, 15),
            updated_at: new Date().toISOString(),
          })
          .eq('id', cleanDeptId);
      }
    }
  }

  const existingMeta = asObj(targetRow.metadata);
  const nowIso = new Date().toISOString();
  const { data: updatedRow, error: updErr } = await supabase
    .from('profiles')
    .update({
      role,
      department_id: cleanDeptId || null,
      is_active: Boolean(active),
      metadata: {
        ...existingMeta,
        departmentName: resolvedDeptName,
      },
      updated_at: nowIso,
    })
    .eq('id', targetUid)
    .select('*')
    .single();

  if (updErr || !updatedRow) {
    throw new Error(`Failed to update user role: ${updErr?.message || 'Unknown error'}`);
  }

  // Sync admins marker table
  if (role === 'admin' && active) {
    await supabase
      .from('admins')
      .upsert(
        {
          id: targetUid,
          full_name: updatedRow.full_name,
          email: updatedRow.email,
          is_active: true,
          metadata: { grantedBy: adminUser.uid },
        },
        { onConflict: 'id' }
      );
  } else {
    await supabase.from('admins').delete().eq('id', targetUid);
  }

  return mapProfileRow(updatedRow);
}

// ------------------------------------------------------------------
// Role-Scoped Workspace Snapshot & Report Detail Bundle
// ------------------------------------------------------------------

export async function fetchWorkspaceSnapshotSupabase(user: AuthenticatedUser) {
  const supabase = getSupabaseAdminClient();
  const role = user.role;

  if (role === 'admin') {
    await ensureCanonicalDepartmentsExist(user.uid).catch(() => {});
  }

  const [
    deptRes,
    reportsRes,
    notifRes,
    slaRes,
    volRes,
    myPartRes,
  ] = await Promise.all([
    supabase.from('departments').select('*').order('name', { ascending: true }),
    fetchAccessibleReportsForUserSupabase(user, 300),
    supabase
      .from('notifications')
      .select('*')
      .eq('user_id', user.uid)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase.from('sla_policies').select('*').eq('is_active', true),
    supabase.from('volunteer_profiles').select('*').eq('id', user.uid).maybeSingle(),
    supabase
      .from('activity_participants')
      .select('activity_id, status')
      .eq('volunteer_id', user.uid)
      .eq('status', 'joined'),
  ]);

  const departments = (deptRes.data || []).map(mapDepartmentRow);
  const reports = reportsRes.reports;
  const notifications = (notifRes.data || []).map(mapNotificationRow);
  const slaPolicies = (slaRes.data || []).map(mapSlaPolicyRow);
  const volunteerProfile = volRes.data ? mapVolunteerProfileRow(volRes.data) : null;
  const joinedActivityIds = (myPartRes.data || [])
    .map((p) => String(p.activity_id || ''))
    .filter(Boolean);

  // Assignments (Admin, Officer, Worker)
  let assignments: any[] = [];
  if (role !== 'citizen') {
    let asgQuery = supabase
      .from('assignments')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(300);
    if (role === 'worker') {
      asgQuery = asgQuery.eq('worker_id', user.uid);
    }
    const { data: asgRows } = await asgQuery;
    assignments = (asgRows || []).map(mapAssignmentRow);
    if (role === 'officer') {
      assignments = assignments.filter(
        (a) =>
          a.authorizedOfficerIds.includes(user.uid) ||
          (Boolean(user.departmentId) && a.departmentId === user.departmentId)
      );
    }
  }

  // Staff directory (Admin sees all profiles, Officers see workers & officers)
  let staffUsers: ServerUserProfile[] = [];
  if (role === 'admin' || role === 'officer') {
    let uQuery = supabase.from('profiles').select('*').order('full_name', { ascending: true });
    if (role === 'officer') {
      uQuery = uQuery.in('role', ['worker', 'officer']);
    }
    const { data: uRows } = await uQuery;
    staffUsers = (uRows || []).map(mapProfileRow);
  } else {
    const { data: selfRow } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.uid)
      .maybeSingle();
    if (selfRow) staffUsers = [mapProfileRow(selfRow)];
  }

  // Operational alerts (Admin & Officer)
  let operationalAlerts: any[] = [];
  if (role === 'admin' || role === 'officer') {
    const { data: alertRows } = await supabase
      .from('operational_alerts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    operationalAlerts = (alertRows || []).map(mapOperationalAlertRow);
    if (role === 'officer') {
      operationalAlerts = operationalAlerts.filter(
        (a) =>
          a.recipientIds.includes(user.uid) ||
          a.authorizedOfficerIds.includes(user.uid) ||
          (Boolean(user.departmentId) && a.departmentId === user.departmentId)
      );
    }
  }

  // Admin-only governance & email collections
  let allFeedbacks: any[] = [];
  let allAiAnalyses: any[] = [];
  let allReportUpdates: any[] = [];
  let workerInvites: ServerWorkerInvite[] = [];
  let departmentEmailSettings: ServerDepartmentEmailSetting[] = [];
  let authorityEmailLogs: ServerAuthorityEmailLog[] = [];

  if (role === 'admin') {
    const [fbR, aiR, updR, invR, emailSetR, emailLogR] = await Promise.all([
      supabase.from('citizen_feedback').select('*').order('created_at', { ascending: false }).limit(300),
      supabase.from('ai_analyses').select('*').order('created_at', { ascending: false }).limit(300),
      supabase.from('report_updates').select('*').order('created_at', { ascending: true }).limit(500),
      supabase.from('worker_invites').select('*').order('created_at', { ascending: false }).limit(200),
      supabase.from('department_email_settings').select('*'),
      supabase.from('authority_email_logs').select('*').order('created_at', { ascending: false }).limit(100),
    ]);
    allFeedbacks = (fbR.data || []).map(mapCitizenFeedbackRow);
    allAiAnalyses = (aiR.data || []).map(mapAiAnalysisRow);
    allReportUpdates = (updR.data || []).map(mapReportUpdateRow);
    workerInvites = (invR.data || []).map(mapWorkerInviteRow);
    departmentEmailSettings = (emailSetR.data || [])
      .map(mapDeptEmailSettingRow)
      .sort((a, b) => a.departmentName.localeCompare(b.departmentName));
    authorityEmailLogs = (emailLogR.data || []).map(mapAuthorityEmailLogRow);
  }

  // NGO & Civic Activities (role-scoped)
  const [{ data: ngoRows }, { data: actRows }] = await Promise.all([
    supabase.from('ngo_organizations').select('*').order('created_at', { ascending: false }).limit(200),
    supabase.from('civic_activities').select('*').order('created_at', { ascending: false }).limit(200),
  ]);

  let ngoOrganizations = (ngoRows || []).map(mapNgoRow);
  let civicActivities = (actRows || []).map(mapCivicActivityRow);
  if (role !== 'admin') {
    ngoOrganizations = ngoOrganizations.filter(
      (n) => n.verificationStatus === 'approved' || n.ownerUid === user.uid
    );
    civicActivities = civicActivities.filter(
      (a) => a.status === 'approved' || a.status === 'completed' || a.createdByUid === user.uid
    );
  }

  return {
    departments,
    reports,
    assignments,
    staffUsers,
    notifications,
    slaPolicies,
    operationalAlerts,
    workerInvites,
    allFeedbacks,
    allAiAnalyses,
    allReportUpdates,
    departmentEmailSettings,
    authorityEmailLogs,
    ngoOrganizations,
    volunteerProfile,
    civicActivities,
    joinedActivityIds,
  };
}

export async function fetchReportDetailBundleSupabase(
  user: AuthenticatedUser,
  reportId: string
) {
  const report = await fetchSingleReportForUserSupabase(user, reportId);
  if (!report) return null;

  const supabase = getSupabaseAdminClient();
  const role = user.role;

  const [updRes, auditRes, asgRes, aiRes, fbRes] = await Promise.all([
    supabase
      .from('report_updates')
      .select('*')
      .eq('report_id', reportId)
      .order('created_at', { ascending: false }),
    role === 'admin' || role === 'officer'
      ? supabase
          .from('audit_logs')
          .select('*')
          .eq('entity_id', reportId)
          .order('created_at', { ascending: false })
      : Promise.resolve({ data: [] }),
    role !== 'citizen'
      ? supabase
          .from('assignments')
          .select('*')
          .eq('report_id', reportId)
          .order('updated_at', { ascending: false })
      : Promise.resolve({ data: [] }),
    role !== 'worker' && report.aiAnalysisId
      ? supabase.from('ai_analyses').select('*').eq('id', report.aiAnalysisId).maybeSingle()
      : role !== 'worker'
        ? supabase
            .from('ai_analyses')
            .select('*')
            .eq('report_id', reportId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    role !== 'worker'
      ? supabase
          .from('citizen_feedback')
          .select('*')
          .eq('report_id', reportId)
          .order('created_at', { ascending: false })
      : Promise.resolve({ data: [] }),
  ]);

  let assignments = (asgRes.data || []).map(mapAssignmentRow);
  if (role === 'worker') {
    assignments = assignments.filter((a) => a.workerId === user.uid);
  }

  let feedbacks = (fbRes.data || []).map(mapCitizenFeedbackRow);
  if (role === 'citizen') {
    feedbacks = feedbacks.filter((f) => f.citizenId === user.uid);
  }

  return {
    report,
    updates: (updRes.data || []).map(mapReportUpdateRow),
    auditLogs: (auditRes.data || []).map(mapAuditLogRow),
    latestAssignment: assignments[0] || null,
    aiAnalysis: aiRes.data ? mapAiAnalysisRow(aiRes.data) : null,
    feedbacks,
  };
}

export async function fetchCitizenContactForAdminSupabase(
  caller: AuthenticatedUser,
  reporterId: string
) {
  if (caller.role !== 'admin') {
    throw new Error('Only authorized administrators can view private citizen contact details.');
  }
  if (!isUuid(reporterId)) return null;
  const supabase = getSupabaseAdminClient();
  const { data } = await supabase
    .from('profiles')
    .select('id, email, phone, avatar_url, updated_at')
    .eq('id', reporterId)
    .maybeSingle();

  if (!data) return null;
  return {
    uid: String(data.id),
    email: String(data.email || ''),
    phone: String(data.phone || ''),
    photoUrl: String(data.avatar_url || ''),
    updatedAt: data.updated_at || new Date().toISOString(),
  };
}

// ------------------------------------------------------------------
// Server-Authoritative Report Workflow Mutations (All 21 Tables)
// ------------------------------------------------------------------

async function loadReportRowForAction(user: AuthenticatedUser, reportId: string) {
  if (!SAFE_ID_REGEX.test(reportId)) throw new Error('Invalid report ID.');
  const supabase = getSupabaseAdminClient();
  const { data: row, error } = await supabase
    .from('reports')
    .select('*')
    .eq('id', reportId)
    .maybeSingle();
  if (error || !row) throw new Error(`Report "${reportId}" was not found.`);
  const report = mapReportRow(row);
  if (!canUserAccessReport(user, report)) {
    throw new Error('You are not authorized to modify this civic report.');
  }
  return { row, report };
}

export async function executeReportWorkflowActionSupabase(
  actor: AuthenticatedUser,
  reportId: string,
  payload: Record<string, any>
): Promise<{ ok: true; report: ServerCivicReportRecord }> {
  const action = String(payload.action || '');
  const supabase = getSupabaseAdminClient();
  const { row, report } = await loadReportRowForAction(actor, reportId);
  const meta = { ...asObj(row.metadata) };
  const nowIso = new Date().toISOString();
  const actorName = sanitizeText(actor.name || actor.email || 'Civic User', 100);

  if (action === 'under_review') {
    if (actor.role !== 'admin' && actor.role !== 'officer') {
      throw new Error('Only administrators or department officers can move reports to Under Review.');
    }
    const { data: updated, error } = await supabase
      .from('reports')
      .update({ status: 'under_review', updated_at: nowIso })
      .eq('id', report.id)
      .select('*')
      .single();
    if (error || !updated) throw new Error(error?.message || 'Update failed.');
    const nextReport = mapReportRow(updated);
    const isReopened = report.status === 'reopened';

    await insertReportUpdateSafe({
      reportId: report.id,
      reporterId: report.reporterId,
      authorizedOfficerIds: report.authorizedOfficerIds,
      assignedWorkerId: report.assignedWorkerId,
      actorId: actor.uid,
      actorName,
      actorRole: actor.role,
      fromStatus: report.status,
      toStatus: 'under_review',
      note: 'Submission opened for verification and duplicate review.',
    });
    await insertNotificationSafe({
      recipientId: report.reporterId,
      reportId: report.id,
      title: isReopened
        ? `Reopened report ${report.trackingCode} is under review`
        : `Report ${report.trackingCode} is under review`,
      message: isReopened
        ? `Your reopened report "${report.title}" is being reviewed by municipal staff.`
        : `An administrator is reviewing "${report.title}".`,
      type: 'status_change',
    });
    await syncPublicReportProjection(nextReport, {
      eventStage: 'under_review',
      eventSummary: isReopened
        ? 'Reopened report is under municipal review.'
        : 'Submission opened for verification review.',
    });
    return { ok: true, report: nextReport };
  }

  if (action === 'request_more_info') {
    if (actor.role !== 'admin' && actor.role !== 'officer') {
      throw new Error('Only administrators or officers can request additional information.');
    }
    const cleanReason = sanitizeText(payload.reason, 600);
    if (cleanReason.length < 3) throw new Error('Explanation must be at least 3 characters.');

    const { data: updated, error } = await supabase
      .from('reports')
      .update({ status: 'under_review', updated_at: nowIso })
      .eq('id', report.id)
      .select('*')
      .single();
    if (error || !updated) throw new Error(error?.message || 'Update failed.');
    const nextReport = mapReportRow(updated);

    await insertReportUpdateSafe({
      reportId: report.id,
      reporterId: report.reporterId,
      authorizedOfficerIds: report.authorizedOfficerIds,
      assignedWorkerId: report.assignedWorkerId,
      actorId: actor.uid,
      actorName,
      actorRole: actor.role,
      fromStatus: report.status,
      toStatus: 'under_review',
      note: `More information requested: ${cleanReason}`,
    });
    await insertNotificationSafe({
      recipientId: report.reporterId,
      reportId: report.id,
      title: `More information needed for ${report.trackingCode}`,
      message: cleanReason.slice(0, 480),
      type: 'review_needed',
    });
    await syncPublicReportProjection(nextReport, {
      eventStage: 'under_review',
      eventSummary: 'Additional clarification requested from intake.',
    });
    return { ok: true, report: nextReport };
  }

  if (action === 'citizen_clarification') {
    if (report.reporterId !== actor.uid && actor.role !== 'admin') {
      throw new Error('Only the submitting citizen can provide clarification.');
    }
    const cleanNote = sanitizeText(payload.clarification, 800);
    if (cleanNote.length < 3) throw new Error('Clarification must be at least 3 characters.');

    await insertReportUpdateSafe({
      reportId: report.id,
      reporterId: report.reporterId,
      authorizedOfficerIds: report.authorizedOfficerIds,
      assignedWorkerId: report.assignedWorkerId,
      actorId: actor.uid,
      actorName,
      actorRole: 'citizen',
      fromStatus: report.status,
      toStatus: 'under_review',
      note: `Citizen clarification: ${cleanNote}`,
    });
    for (const offId of report.authorizedOfficerIds.slice(0, 3)) {
      await insertNotificationSafe({
        recipientId: offId,
        reportId: report.id,
        title: `Citizen added info for ${report.trackingCode}`,
        message: cleanNote.slice(0, 300),
        type: 'review_needed',
      });
    }
    return { ok: true, report };
  }

  if (action === 'verify') {
    if (actor.role !== 'admin') {
      throw new Error('Only authorized administrators can verify civic reports.');
    }
    const nextCategory =
      payload.categoryOverride && ALLOWED_REPORT_CATEGORIES.has(String(payload.categoryOverride))
        ? String(payload.categoryOverride)
        : report.category;
    const nextPriority =
      ['low', 'medium', 'high', 'critical'].includes(String(payload.priorityOverride))
        ? String(payload.priorityOverride)
        : report.priority;
    const verificationNote = sanitizeText(payload.verificationNote || '', 500);

    const { data: updated, error } = await supabase
      .from('reports')
      .update({
        status: 'verified',
        category: nextCategory,
        priority: nextPriority,
        updated_at: nowIso,
      })
      .eq('id', report.id)
      .select('*')
      .single();
    if (error || !updated) throw new Error(error?.message || 'Verification failed.');
    const nextReport = mapReportRow(updated);

    const noteParts = [`Verified by Admin ${actorName}.`, verificationNote].filter(Boolean);
    await insertReportUpdateSafe({
      reportId: report.id,
      reporterId: report.reporterId,
      authorizedOfficerIds: report.authorizedOfficerIds,
      assignedWorkerId: report.assignedWorkerId,
      actorId: actor.uid,
      actorName,
      actorRole: 'admin',
      fromStatus: report.status,
      toStatus: 'verified',
      note: noteParts.join(' '),
    });
    await insertAuditLogSafe({
      reportId: report.id,
      trackingCode: report.trackingCode,
      departmentId: report.departmentId,
      authorizedOfficerIds: report.authorizedOfficerIds,
      assignedWorkerId: report.assignedWorkerId,
      actorId: actor.uid,
      actorName,
      actorRole: 'admin',
      action: 'verify_report',
      summary: noteParts.join(' '),
    });
    await insertNotificationSafe({
      recipientId: report.reporterId,
      reportId: report.id,
      title: `Report ${report.trackingCode} verified`,
      message: `Your report "${report.title}" has been verified and queued for department dispatch.`,
      type: 'status_change',
    });
    await syncPublicReportProjection(nextReport, {
      eventStage: 'verified',
      eventSummary: 'Report verified for municipal dispatch.',
    });
    return { ok: true, report: nextReport };
  }

  if (action === 'assign_department') {
    if (actor.role !== 'admin') {
      throw new Error('Only authorized administrators can assign departments.');
    }
    const departmentId = sanitizeText(payload.departmentId, 128);
    const { data: deptRow } = await supabase
      .from('departments')
      .select('*')
      .eq('id', departmentId)
      .maybeSingle();
    if (!deptRow) throw new Error(`Department "${departmentId}" does not exist.`);

    const assignedOfficerId = sanitizeText(payload.assignedOfficerId || '', 128);
    let assignedOfficerName = '';
    if (assignedOfficerId && isUuid(assignedOfficerId)) {
      const { data: offRow } = await supabase
        .from('profiles')
        .select('id, role, full_name')
        .eq('id', assignedOfficerId)
        .maybeSingle();
      if (!offRow || (offRow.role !== 'officer' && offRow.role !== 'admin')) {
        throw new Error('Selected officer must have Officer or Admin role.');
      }
      assignedOfficerName = String(offRow.full_name || '');
    }

    const existingOfficers = asStrArray(deptRow.officer_ids);
    const officerIds = Array.from(
      new Set([...(assignedOfficerId ? [assignedOfficerId] : []), ...existingOfficers])
    ).slice(0, 10);

    if (assignedOfficerId && !existingOfficers.includes(assignedOfficerId)) {
      await supabase
        .from('departments')
        .update({ officer_ids: officerIds, updated_at: nowIso })
        .eq('id', departmentId);
    }

    const nextCategory =
      payload.categoryOverride && ALLOWED_REPORT_CATEGORIES.has(String(payload.categoryOverride))
        ? String(payload.categoryOverride)
        : report.category;
    const nextPriority =
      ['low', 'medium', 'high', 'critical'].includes(String(payload.priorityOverride))
        ? String(payload.priorityOverride)
        : report.priority;
    const cleanInstructions = sanitizeText(
      payload.instructions ||
        `Verified and routed to ${deptRow.name}${assignedOfficerName ? ` (Officer: ${assignedOfficerName})` : ''}.`,
      800
    );

    const nextMeta = {
      ...meta,
      departmentName: String(deptRow.name),
      authorizedOfficerIds: officerIds,
    };

    const { data: updated, error } = await supabase
      .from('reports')
      .update({
        status: 'verified',
        category: nextCategory,
        priority: nextPriority,
        department_id: departmentId,
        metadata: nextMeta,
        updated_at: nowIso,
      })
      .eq('id', report.id)
      .select('*')
      .single();
    if (error || !updated) throw new Error(error?.message || 'Department assignment failed.');
    const nextReport = mapReportRow(updated);

    if (report.aiAnalysisId) {
      await supabase
        .from('ai_analyses')
        .update({ authorized_officer_ids: officerIds })
        .eq('id', report.aiAnalysisId);
    }

    const assignmentId = makeServerId('asg');
    await supabase.from('assignments').insert({
      id: assignmentId,
      report_id: report.id,
      worker_id: isUuid(report.assignedWorkerId) ? report.assignedWorkerId : null,
      department_id: departmentId,
      status: 'pending_worker',
      assigned_by: actor.uid,
      assigned_at: nowIso,
      authorized_officer_ids: officerIds,
      notes: cleanInstructions,
      metadata: {
        trackingCode: report.trackingCode,
        reportTitle: report.title,
        departmentName: String(deptRow.name),
        workerName: report.assignedWorkerName || '',
        instructions: cleanInstructions,
      },
      created_at: nowIso,
      updated_at: nowIso,
    });

    await insertReportUpdateSafe({
      reportId: report.id,
      reporterId: report.reporterId,
      authorizedOfficerIds: officerIds,
      assignedWorkerId: report.assignedWorkerId,
      actorId: actor.uid,
      actorName,
      actorRole: 'admin',
      fromStatus: report.status,
      toStatus: 'verified',
      note: `Verified and assigned to ${deptRow.name}. ${cleanInstructions}`,
    });
    await insertAuditLogSafe({
      reportId: report.id,
      trackingCode: report.trackingCode,
      departmentId,
      authorizedOfficerIds: officerIds,
      assignedWorkerId: report.assignedWorkerId,
      actorId: actor.uid,
      actorName,
      actorRole: 'admin',
      action: 'assign_department',
      summary: `Assigned to ${deptRow.name}`,
    });
    await insertNotificationSafe({
      recipientId: report.reporterId,
      reportId: report.id,
      title: `Report ${report.trackingCode} assigned to ${deptRow.name}`,
      message: `Your issue has been verified and routed to ${deptRow.name} for dispatch.`,
      type: 'status_change',
    });
    for (const offId of officerIds.slice(0, 3)) {
      if (offId === actor.uid) continue;
      await insertNotificationSafe({
        recipientId: offId,
        reportId: report.id,
        title: `New department dispatch: ${report.trackingCode}`,
        message: `"${report.title}" was assigned to ${deptRow.name}.`,
        type: 'assignment',
      });
    }
    await syncPublicReportProjection(nextReport, {
      eventStage: 'verified',
      eventSummary: `Verified and assigned to ${deptRow.name}.`,
    });
    return { ok: true, report: nextReport };
  }

  if (action === 'assign_worker') {
    if (actor.role !== 'admin' && actor.role !== 'officer') {
      throw new Error('Only administrators or officers can dispatch field workers.');
    }
    const workerId = sanitizeText(payload.workerId, 128);
    const authCheck = await verifyReportTransitionAuthorizationSupabase(actor, {
      reportId: report.id,
      fromStatus: report.status,
      toStatus: 'assigned',
      action: 'assign_worker',
      workerId,
      expectedWorkerId: typeof payload.expectedWorkerId === 'string' ? payload.expectedWorkerId : undefined,
      deadlineIso: typeof payload.deadlineIso === 'string' ? payload.deadlineIso : undefined,
      supervisorId: typeof payload.supervisorId === 'string' ? payload.supervisorId : undefined,
    });
    if (!authCheck.ok) throw new Error(authCheck.error || 'Worker dispatch denied.');

    const { data: workerRow } = await supabase
      .from('profiles')
      .select('id, full_name')
      .eq('id', workerId)
      .single();
    const workerName = sanitizeText(workerRow?.full_name || payload.workerName || 'Field Worker', 100);

    const isReassigning = Boolean(report.assignedWorkerId && report.assignedWorkerId !== workerId);
    const cleanReassignmentReason = sanitizeText(payload.reassignmentReason || '', 500);
    if (isReassigning && cleanReassignmentReason.length < 3) {
      throw new Error('Please provide a clear reassignment reason (at least 3 characters).');
    }

    const effectivePriority =
      ['low', 'medium', 'high', 'critical'].includes(String(payload.priorityOverride))
        ? String(payload.priorityOverride)
        : report.priority;
    const cleanDeadline = payload.deadlineIso ? sanitizeText(payload.deadlineIso, 64) : undefined;
    const effectiveSupervisorId = sanitizeText(payload.supervisorId || actor.uid, 128);
    const effectiveSupervisorName = sanitizeText(payload.supervisorName || actorName, 100);
    const cleanInstructions = sanitizeText(
      payload.instructions || 'Proceed to site and document resolution.',
      800
    );

    const nextMeta: Record<string, any> = {
      ...meta,
      assignedWorkerId: workerId,
      assignedWorkerName: workerName,
      supervisorId: effectiveSupervisorId,
      supervisorName: effectiveSupervisorName,
      ...(cleanDeadline ? { deadlineIso: cleanDeadline } : {}),
      ...(isReassigning ? { reassignedAtIso: nowIso } : {}),
    };

    const { data: updated, error } = await supabase
      .from('reports')
      .update({
        status: 'assigned',
        priority: effectivePriority,
        metadata: nextMeta,
        updated_at: nowIso,
      })
      .eq('id', report.id)
      .select('*')
      .single();
    if (error || !updated) throw new Error(error?.message || 'Worker assignment failed.');
    const nextReport = mapReportRow(updated);

    const { data: existingAsgs } = await supabase
      .from('assignments')
      .select('*')
      .eq('report_id', report.id);
    const openAsgs = (existingAsgs || []).filter((a) => a.status !== 'approved');

    const recScore =
      typeof payload.recommendationScore === 'number' && Number.isFinite(payload.recommendationScore)
        ? Math.max(0, Math.min(100, Math.round(payload.recommendationScore)))
        : undefined;
    const recReason = payload.recommendationReason ? sanitizeText(payload.recommendationReason, 400) : undefined;

    if (openAsgs.length === 0) {
      await supabase.from('assignments').insert({
        id: makeServerId('asg'),
        report_id: report.id,
        worker_id: workerId,
        department_id: report.departmentId || null,
        status: 'assigned',
        assigned_by: actor.uid,
        assigned_at: nowIso,
        authorized_officer_ids: report.authorizedOfficerIds,
        notes: cleanInstructions,
        metadata: {
          trackingCode: report.trackingCode,
          reportTitle: report.title,
          departmentName: report.departmentName || 'Department',
          workerName,
          priority: effectivePriority,
          supervisorId: effectiveSupervisorId,
          supervisorName: effectiveSupervisorName,
          instructions: cleanInstructions,
          ...(cleanDeadline ? { deadlineIso: cleanDeadline } : {}),
          ...(isReassigning
            ? {
                reassignedFromWorkerId: report.assignedWorkerId,
                reassignedFromWorkerName: report.assignedWorkerName || '',
                reassignedCount: 1,
                reassignmentReason: cleanReassignmentReason,
              }
            : {}),
          ...(recScore !== undefined ? { recommendationScore: recScore } : {}),
          ...(recReason ? { recommendationReason: recReason } : {}),
        },
        created_at: nowIso,
        updated_at: nowIso,
      });
    } else {
      for (const asg of openAsgs) {
        const prevMeta = asObj(asg.metadata);
        const prevCount = typeof prevMeta.reassignedCount === 'number' ? prevMeta.reassignedCount : 0;
        await supabase
          .from('assignments')
          .update({
            worker_id: workerId,
            status: 'assigned',
            assigned_at: nowIso,
            notes: cleanInstructions,
            metadata: {
              ...prevMeta,
              workerName,
              priority: effectivePriority,
              supervisorId: effectiveSupervisorId,
              supervisorName: effectiveSupervisorName,
              instructions: cleanInstructions,
              ...(cleanDeadline ? { deadlineIso: cleanDeadline } : {}),
              ...(isReassigning
                ? {
                    reassignedFromWorkerId: report.assignedWorkerId,
                    reassignedFromWorkerName: report.assignedWorkerName || '',
                    reassignedCount: Math.min(50, prevCount + 1),
                    reassignmentReason: cleanReassignmentReason,
                  }
                : {}),
              ...(recScore !== undefined ? { recommendationScore: recScore } : {}),
              ...(recReason ? { recommendationReason: recReason } : {}),
            },
            updated_at: nowIso,
          })
          .eq('id', asg.id);
      }
    }

    const noteParts = [
      isReassigning
        ? `Reassigned from ${report.assignedWorkerName || report.assignedWorkerId} to ${workerName}. Reason: ${cleanReassignmentReason}.`
        : `Assigned to field worker ${workerName}.`,
      recScore !== undefined ? `Smart recommendation score: ${recScore}/100.` : '',
      cleanDeadline ? `Deadline: ${cleanDeadline}.` : '',
      cleanInstructions,
    ].filter(Boolean);

    await insertReportUpdateSafe({
      reportId: report.id,
      reporterId: report.reporterId,
      authorizedOfficerIds: report.authorizedOfficerIds,
      assignedWorkerId: workerId,
      actorId: actor.uid,
      actorName,
      actorRole: actor.role,
      fromStatus: report.status,
      toStatus: 'assigned',
      note: noteParts.join(' '),
    });
    await insertAuditLogSafe({
      reportId: report.id,
      trackingCode: report.trackingCode,
      departmentId: report.departmentId,
      authorizedOfficerIds: report.authorizedOfficerIds,
      assignedWorkerId: workerId,
      actorId: actor.uid,
      actorName,
      actorRole: actor.role,
      action: isReassigning ? 'reassign_worker' : 'assign_worker',
      summary: noteParts.join(' '),
    });
    await insertNotificationSafe({
      recipientId: workerId,
      reportId: report.id,
      title: isReassigning
        ? `Task reassigned to you: ${report.trackingCode}`
        : `New field task assigned: ${report.trackingCode}`,
      message: `${report.title} at ${report.addressText}`,
      type: isReassigning ? 'reassignment' : 'assignment',
    });
    if (isReassigning && report.assignedWorkerId) {
      await insertNotificationSafe({
        recipientId: report.assignedWorkerId,
        reportId: report.id,
        title: `Task reassigned: ${report.trackingCode}`,
        message: `"${report.title}" was reassigned to ${workerName}. Reason: ${cleanReassignmentReason}`,
        type: 'reassignment',
      });
    }
    await insertNotificationSafe({
      recipientId: report.reporterId,
      reportId: report.id,
      title: `Field crew assigned to ${report.trackingCode}`,
      message: `${workerName} has been dispatched for "${report.title}".`,
      type: 'status_change',
    });
    await syncPublicReportProjection(nextReport, {
      eventStage: 'assigned',
      eventSummary: `Field team dispatched by ${report.departmentName || 'municipal department'}.`,
    });
    return { ok: true, report: nextReport };
  }

  if (action === 'worker_acknowledge') {
    if (actor.role !== 'worker' && actor.role !== 'admin' && actor.role !== 'officer') {
      throw new Error('Not authorized to acknowledge field tasks.');
    }
    const nextMeta = { ...meta, acknowledgedAtIso: nowIso };
    const { data: updated, error } = await supabase
      .from('reports')
      .update({ metadata: nextMeta, updated_at: nowIso })
      .eq('id', report.id)
      .select('*')
      .single();
    if (error || !updated) throw new Error(error?.message || 'Acknowledge failed.');

    const { data: asgs } = await supabase
      .from('assignments')
      .select('id, metadata')
      .eq('report_id', report.id);
    for (const a of asgs || []) {
      await supabase
        .from('assignments')
        .update({
          metadata: { ...asObj(a.metadata), acknowledgedAtIso: nowIso },
          updated_at: nowIso,
        })
        .eq('id', a.id);
    }

    await insertReportUpdateSafe({
      reportId: report.id,
      reporterId: report.reporterId,
      authorizedOfficerIds: report.authorizedOfficerIds,
      assignedWorkerId: report.assignedWorkerId || actor.uid,
      actorId: actor.uid,
      actorName,
      actorRole: actor.role,
      fromStatus: report.status,
      toStatus: report.status,
      note: `Field worker ${actorName} acknowledged task assignment at ${nowIso}.`,
    });
    for (const offId of report.authorizedOfficerIds.slice(0, 3)) {
      if (offId === actor.uid) continue;
      await insertNotificationSafe({
        recipientId: offId,
        reportId: report.id,
        title: `Task acknowledged: ${report.trackingCode}`,
        message: `${actorName} accepted assignment for "${report.title}".`,
        type: 'assignment',
      });
    }
    return { ok: true, report: mapReportRow(updated) };
  }

  if (action === 'worker_field_update') {
    const mode = payload.mode as 'progress' | 'obstacle' | 'ready_for_verification';
    const cleanNote = sanitizeText(payload.workNote, 1000);
    const cleanObstacle = sanitizeText(payload.obstaclesEncountered || '', 600);
    const cleanMaterials = sanitizeText(payload.materialsUsed || '', 500);
    const cleanDelay = sanitizeText(payload.delayExplanation || '', 600);

    if (mode === 'obstacle' && cleanObstacle.length < 3 && cleanNote.length < 3) {
      throw new Error('Please describe the field obstacle encountered (at least 3 characters).');
    }
    if (mode !== 'obstacle' && cleanNote.length < 5) {
      throw new Error('Please provide a clear field work or completion description (at least 5 characters).');
    }

    const effectiveStartIso = sanitizeText(payload.workStartedAtIso || report.workStartedAtIso || nowIso, 64);
    const effectiveCompletedIso =
      mode === 'ready_for_verification'
        ? sanitizeText(payload.completedAtIso || nowIso, 64)
        : report.completedAtIso;

    const newUrls = asStrArray(payload.resolutionImageUrls);
    const combinedImages = Array.from(new Set([...report.resolutionImageUrls, ...newUrls])).slice(0, 5);
    const newMetaArr = Array.isArray(payload.resolutionImageMetadata) ? payload.resolutionImageMetadata : [];
    const mergedMetaMap = new Map<string, any>();
    for (const item of [...report.resolutionImageMetadata, ...newMetaArr]) {
      if (item?.url) mergedMetaMap.set(item.url, item);
    }
    const combinedResMeta = Array.from(mergedMetaMap.values()).slice(0, 5);

    const nextMeta: Record<string, any> = {
      ...meta,
      workStartedAtIso: effectiveStartIso,
      acknowledgedAtIso: report.acknowledgedAtIso || nowIso,
      ...(cleanNote ? { resolutionNotes: cleanNote } : {}),
      ...(cleanMaterials ? { materialsUsed: cleanMaterials } : {}),
      ...(cleanDelay ? { delayExplanation: cleanDelay } : {}),
    };

    if (mode === 'obstacle') {
      nextMeta.obstaclesEncountered = cleanObstacle || cleanNote;
      nextMeta.hasActiveObstacle = true;
      nextMeta.awaitingSupervisorVerification = false;
    } else if (mode === 'ready_for_verification') {
      nextMeta.awaitingSupervisorVerification = true;
      nextMeta.completedAtIso = effectiveCompletedIso;
      nextMeta.hasActiveObstacle = false;
      if (cleanObstacle) nextMeta.obstaclesEncountered = cleanObstacle;
    } else {
      nextMeta.awaitingSupervisorVerification = false;
      if (payload.clearActiveObstacle) nextMeta.hasActiveObstacle = false;
      else if (cleanObstacle) nextMeta.obstaclesEncountered = cleanObstacle;
    }

    if (payload.workerCheckInLabel) {
      nextMeta.workerCheckInLabel = sanitizeText(payload.workerCheckInLabel, 160);
    }
    if (
      typeof payload.workerCheckInLat === 'number' &&
      typeof payload.workerCheckInLng === 'number' &&
      Number.isFinite(payload.workerCheckInLat) &&
      Number.isFinite(payload.workerCheckInLng)
    ) {
      nextMeta.workerCheckInLat = payload.workerCheckInLat;
      nextMeta.workerCheckInLng = payload.workerCheckInLng;
    }

    const { data: updated, error } = await supabase
      .from('reports')
      .update({
        status: 'in_progress',
        resolution_image_urls: combinedImages,
        resolution_image_metadata: combinedResMeta,
        metadata: nextMeta,
        updated_at: nowIso,
      })
      .eq('id', report.id)
      .select('*')
      .single();
    if (error || !updated) throw new Error(error?.message || 'Field update failed.');
    const nextReport = mapReportRow(updated);

    const { data: asgs } = await supabase
      .from('assignments')
      .select('*')
      .eq('report_id', report.id);
    for (const a of asgs || []) {
      if (a.status === 'approved') continue;
      const prevA = asObj(a.metadata);
      await supabase
        .from('assignments')
        .update({
          status: mode === 'ready_for_verification' ? 'evidence_submitted' : 'in_progress',
          started_at: a.started_at || effectiveStartIso,
          completed_at: effectiveCompletedIso || a.completed_at,
          evidence_urls: combinedImages,
          metadata: {
            ...prevA,
            acknowledgedAtIso: prevA.acknowledgedAtIso || nowIso,
            workStartedAtIso: effectiveStartIso,
            ...(effectiveCompletedIso ? { completedAtIso: effectiveCompletedIso } : {}),
            ...(cleanMaterials ? { materialsUsed: cleanMaterials } : {}),
            ...(cleanDelay ? { delayExplanation: cleanDelay } : {}),
            ...(mode === 'obstacle' || cleanObstacle
              ? { obstaclesEncountered: cleanObstacle || cleanNote }
              : {}),
          },
          updated_at: nowIso,
        })
        .eq('id', a.id);
    }

    const auditSegments = [
      mode === 'ready_for_verification'
        ? `Work completed and submitted for supervisor verification (Started: ${effectiveStartIso}, Completed: ${effectiveCompletedIso}).`
        : mode === 'obstacle'
          ? `Field obstacle flagged: ${cleanObstacle || cleanNote}.`
          : report.status === 'assigned'
            ? `Field work started (${effectiveStartIso}).`
            : 'Field progress logged.',
      cleanNote,
      cleanMaterials ? `Materials/Resources: ${cleanMaterials}.` : '',
      mode !== 'obstacle' && cleanObstacle ? `Obstacles noted: ${cleanObstacle}.` : '',
      cleanDelay ? `Delay explanation: ${cleanDelay}.` : '',
    ].filter(Boolean);

    await insertReportUpdateSafe({
      reportId: report.id,
      reporterId: report.reporterId,
      authorizedOfficerIds: report.authorizedOfficerIds,
      assignedWorkerId: report.assignedWorkerId,
      actorId: actor.uid,
      actorName,
      actorRole: actor.role,
      fromStatus: report.status,
      toStatus: 'in_progress',
      note: auditSegments.join(' '),
      evidenceUrls: newUrls.slice(0, 5),
    });

    if (mode !== 'ready_for_verification') {
      const isStarting = report.status === 'assigned' || report.status === 'reopened';
      await insertNotificationSafe({
        recipientId: report.reporterId,
        reportId: report.id,
        title:
          mode === 'obstacle'
            ? `Field obstacle noted on ${report.trackingCode}`
            : isStarting
              ? `Work began on ${report.trackingCode}`
              : `Work progress updated on ${report.trackingCode}`,
        message:
          mode === 'obstacle'
            ? `Field crew reported a delay/obstacle on "${report.title}". Supervisors have been alerted.`
            : `${actorName} updated field progress on "${report.title}".`,
        type: 'status_change',
      });
    }

    for (const offId of report.authorizedOfficerIds.slice(0, 4)) {
      if (offId === actor.uid) continue;
      await insertNotificationSafe({
        recipientId: offId,
        reportId: report.id,
        title:
          mode === 'ready_for_verification'
            ? `Verification needed: ${report.trackingCode}`
            : mode === 'obstacle'
              ? `Field obstacle alert: ${report.trackingCode}`
              : `Task in progress: ${report.trackingCode}`,
        message: (mode === 'obstacle' ? cleanObstacle || cleanNote : cleanNote).slice(0, 260),
        type:
          mode === 'ready_for_verification'
            ? 'review_needed'
            : mode === 'obstacle'
              ? 'obstacle'
              : 'status_change',
      });
    }

    await syncPublicReportProjection(nextReport, {
      eventStage: 'in_progress',
      eventSummary:
        mode === 'ready_for_verification'
          ? 'Field work completed and submitted for supervisor sign-off.'
          : mode === 'obstacle'
            ? 'Field obstacle flagged during active work.'
            : 'Field repair work in progress.',
    });
    return { ok: true, report: nextReport };
  }

  if (action === 'worker_request_assistance') {
    const cleanNote = sanitizeText(payload.note, 500);
    if (cleanNote.length < 3) {
      throw new Error('Please describe the assistance or resources needed (at least 3 characters).');
    }
    const nextMeta = {
      ...meta,
      assistanceRequestedAtIso: nowIso,
      assistanceRequestNote: cleanNote,
    };
    const { data: updated, error } = await supabase
      .from('reports')
      .update({ metadata: nextMeta, updated_at: nowIso })
      .eq('id', report.id)
      .select('*')
      .single();
    if (error || !updated) throw new Error(error?.message || 'Assistance request failed.');

    const { data: asgs } = await supabase.from('assignments').select('id, status, metadata').eq('report_id', report.id);
    for (const a of asgs || []) {
      if (a.status === 'approved') continue;
      await supabase
        .from('assignments')
        .update({
          metadata: { ...asObj(a.metadata), assistanceRequestedAtIso: nowIso, assistanceRequestNote: cleanNote },
          updated_at: nowIso,
        })
        .eq('id', a.id);
    }

    await insertReportUpdateSafe({
      reportId: report.id,
      reporterId: report.reporterId,
      authorizedOfficerIds: report.authorizedOfficerIds,
      assignedWorkerId: report.assignedWorkerId,
      actorId: actor.uid,
      actorName,
      actorRole: actor.role,
      fromStatus: report.status,
      toStatus: report.status,
      note: `Field worker requested supervisor assistance: ${cleanNote}`,
    });
    const supTargets = Array.from(
      new Set([...(report.supervisorId ? [report.supervisorId] : []), ...report.authorizedOfficerIds])
    ).slice(0, 4);
    for (const supId of supTargets) {
      if (supId === actor.uid) continue;
      await insertNotificationSafe({
        recipientId: supId,
        reportId: report.id,
        title: `Supervisor assistance requested: ${report.trackingCode}`,
        message: cleanNote,
        type: 'assistance_request',
      });
    }
    return { ok: true, report: mapReportRow(updated) };
  }

  if (action === 'review_evidence') {
    if (actor.role !== 'admin' && actor.role !== 'officer') {
      throw new Error('Only supervisors or administrators can verify completion evidence.');
    }
    const decision = payload.decision as 'approve' | 'reject_evidence' | 'return_in_progress';
    const targetStatus = decision === 'approve' ? 'resolved' : 'in_progress';
    const cleanReason = sanitizeText(payload.reason || 'Supervisor verified completed field work.', 500);

    const nextMeta: Record<string, any> = {
      ...meta,
      awaitingSupervisorVerification: false,
      ...(decision === 'approve'
        ? {
            supervisorVerifiedAtIso: nowIso,
            supervisorVerifiedById: actor.uid,
            supervisorVerifiedByName: actorName,
          }
        : { rejectionReason: cleanReason }),
    };

    const { data: updated, error } = await supabase
      .from('reports')
      .update({ status: targetStatus, metadata: nextMeta, updated_at: nowIso })
      .eq('id', report.id)
      .select('*')
      .single();
    if (error || !updated) throw new Error(error?.message || 'Evidence review failed.');
    const nextReport = mapReportRow(updated);

    const { data: asgs } = await supabase.from('assignments').select('id, metadata').eq('report_id', report.id);
    for (const a of asgs || []) {
      await supabase
        .from('assignments')
        .update({
          status: decision === 'approve' ? 'approved' : 'in_progress',
          metadata: {
            ...asObj(a.metadata),
            ...(decision === 'approve'
              ? { supervisorVerifiedAtIso: nowIso, supervisorVerifiedById: actor.uid }
              : {}),
          },
          updated_at: nowIso,
        })
        .eq('id', a.id);
    }

    const note =
      decision === 'approve'
        ? `Supervisor ${actorName} verified completed work at ${nowIso}. ${cleanReason}`
        : `Supervisor returned task to In Progress (${decision === 'reject_evidence' ? 'incomplete work rejected' : 'rework requested'}). Reason: ${cleanReason}`;

    await insertReportUpdateSafe({
      reportId: report.id,
      reporterId: report.reporterId,
      authorizedOfficerIds: report.authorizedOfficerIds,
      assignedWorkerId: report.assignedWorkerId,
      actorId: actor.uid,
      actorName,
      actorRole: actor.role,
      fromStatus: report.status,
      toStatus: targetStatus,
      note,
    });
    await insertAuditLogSafe({
      reportId: report.id,
      trackingCode: report.trackingCode,
      departmentId: report.departmentId,
      authorizedOfficerIds: report.authorizedOfficerIds,
      assignedWorkerId: report.assignedWorkerId,
      actorId: actor.uid,
      actorName,
      actorRole: actor.role,
      action: decision === 'approve' ? 'approve_completion' : decision,
      summary: note,
    });

    if (decision !== 'approve' && report.assignedWorkerId) {
      await insertNotificationSafe({
        recipientId: report.assignedWorkerId,
        reportId: report.id,
        title: `Work returned to In Progress: ${report.trackingCode}`,
        message: cleanReason.slice(0, 260),
        type: 'review_needed',
      });
    } else if (decision === 'approve') {
      await insertNotificationSafe({
        recipientId: report.reporterId,
        reportId: report.id,
        title: `Work verified & resolved: ${report.trackingCode}`,
        message: `Supervisor ${actorName} verified the completed repair for "${report.title}". Please confirm resolution or reopen if needed.`,
        type: 'status_change',
      });
    }

    await syncPublicReportProjection(nextReport, {
      resolutionSummary:
        decision === 'approve'
          ? report.resolutionNotes || cleanReason || 'Field repair verified and resolved.'
          : 'Returned for additional field follow-up.',
      eventStage: targetStatus,
      eventSummary:
        decision === 'approve'
          ? 'Supervisor verified completed repair and marked report resolved.'
          : 'Supervisor returned task to In Progress for follow-up.',
    });
    return { ok: true, report: nextReport };
  }

  if (action === 'reject') {
    if (actor.role !== 'admin' && actor.role !== 'officer') {
      throw new Error('Only administrators or officers can reject reports.');
    }
    const cleanReason = sanitizeText(payload.reason, 500);
    if (cleanReason.length < 3) throw new Error('Rejection reason must be at least 3 characters.');

    const nextMeta = { ...meta, rejectionReason: cleanReason };
    const { data: updated, error } = await supabase
      .from('reports')
      .update({ status: 'rejected', metadata: nextMeta, updated_at: nowIso })
      .eq('id', report.id)
      .select('*')
      .single();
    if (error || !updated) throw new Error(error?.message || 'Rejection failed.');
    const nextReport = mapReportRow(updated);

    await insertReportUpdateSafe({
      reportId: report.id,
      reporterId: report.reporterId,
      authorizedOfficerIds: report.authorizedOfficerIds,
      assignedWorkerId: report.assignedWorkerId,
      actorId: actor.uid,
      actorName,
      actorRole: actor.role,
      fromStatus: report.status,
      toStatus: 'rejected',
      note: `Report rejected. Reason: ${cleanReason}`,
    });
    await insertNotificationSafe({
      recipientId: report.reporterId,
      reportId: report.id,
      title: `Report ${report.trackingCode} was closed/rejected`,
      message: `Reason: ${cleanReason.slice(0, 260)}`,
      type: 'status_change',
    });
    await syncPublicReportProjection(nextReport, {
      resolutionSummary: `Closed during review: ${cleanReason}`,
      eventStage: 'rejected',
      eventSummary: 'Report closed during municipal review.',
    });
    return { ok: true, report: nextReport };
  }

  if (action === 'citizen_confirm_or_reopen') {
    if (report.reporterId !== actor.uid && actor.role !== 'admin') {
      throw new Error('Only the citizen who submitted this report can confirm or reopen it.');
    }
    const outcome = payload.outcome === 'reopened' ? 'reopened' : 'confirmed';
    const cleanComment = sanitizeText(payload.comment || '', 1000);
    if (outcome === 'reopened' && cleanComment.length < 3) {
      throw new Error('Please explain why this issue remains unresolved (at least 3 characters).');
    }
    const nextStatus = outcome === 'confirmed' ? 'citizen_confirmed' : 'reopened';
    const nextMeta = {
      ...meta,
      ...(outcome === 'reopened' ? { reopenReason: cleanComment.slice(0, 500) } : {}),
    };

    const { data: updated, error } = await supabase
      .from('reports')
      .update({ status: nextStatus, metadata: nextMeta, updated_at: nowIso })
      .eq('id', report.id)
      .select('*')
      .single();
    if (error || !updated) throw new Error(error?.message || 'Status update failed.');
    const nextReport = mapReportRow(updated);

    const updId = await insertReportUpdateSafe({
      reportId: report.id,
      reporterId: report.reporterId,
      authorizedOfficerIds: report.authorizedOfficerIds,
      assignedWorkerId: report.assignedWorkerId,
      actorId: actor.uid,
      actorName,
      actorRole: 'citizen',
      fromStatus: report.status,
      toStatus: nextStatus,
      note:
        outcome === 'confirmed'
          ? cleanComment
            ? `Citizen confirmed resolution: "${cleanComment}"`
            : 'Citizen confirmed that the civic issue is satisfactorily resolved.'
          : `Citizen reopened report. Reason: ${cleanComment}`,
    });

    if (outcome === 'reopened') {
      await supabase.from('citizen_feedback').insert({
        id: `fb_reopen_${report.id}_${updId}`,
        report_id: report.id,
        user_id: actor.uid,
        rating: 1,
        feedback: cleanComment,
        authorized_officer_ids: report.authorizedOfficerIds.slice(0, 10),
        metadata: { outcome: 'reopened', citizenId: actor.uid },
        created_at: nowIso,
      });
    }

    for (const offId of report.authorizedOfficerIds.slice(0, 5)) {
      if (offId === actor.uid) continue;
      await insertNotificationSafe({
        recipientId: offId,
        reportId: report.id,
        title:
          outcome === 'confirmed'
            ? `Citizen confirmed ${report.trackingCode}`
            : `Reopened report requires attention: ${report.trackingCode}`,
        message:
          outcome === 'confirmed'
            ? (cleanComment || 'Citizen confirmed the completed repair.').slice(0, 260)
            : `Citizen reported issue unresolved: ${cleanComment.slice(0, 260)}`,
        type: outcome === 'confirmed' ? 'feedback' : 'review_needed',
      });
    }

    await syncPublicReportProjection(nextReport, {
      resolutionSummary:
        outcome === 'confirmed'
          ? 'Citizen confirmed issue resolution.'
          : `Reopened by citizen: ${cleanComment}`,
      eventStage: nextStatus,
      eventSummary:
        outcome === 'confirmed'
          ? 'Citizen confirmed that the civic issue is satisfactorily resolved.'
          : 'Citizen reopened report for follow-up review.',
    });
    return { ok: true, report: nextReport };
  }

  if (action === 'submit_feedback') {
    if (report.reporterId !== actor.uid && actor.role !== 'admin') {
      throw new Error('Only the submitting citizen can submit feedback.');
    }
    if (report.status !== 'citizen_confirmed') {
      throw new Error('Please confirm resolution first before submitting feedback.');
    }
    const cleanRating = Math.max(1, Math.min(5, Math.round(Number(payload.rating || 5))));
    const cleanComment = sanitizeText(payload.comment || '', 1000);
    const storedComment = cleanComment || 'Citizen confirmed resolution without additional written feedback.';

    const { data: prior } = await supabase
      .from('citizen_feedback')
      .select('id, metadata')
      .eq('report_id', report.id)
      .eq('user_id', actor.uid);
    if ((prior || []).some((p) => asObj(p.metadata).outcome !== 'reopened')) {
      throw new Error('Feedback has already been submitted for this report.');
    }

    const fbId = `fb_confirmed_${report.id}_${actor.uid}`;
    const { error: fbErr } = await supabase.from('citizen_feedback').insert({
      id: fbId,
      report_id: report.id,
      user_id: actor.uid,
      rating: cleanRating,
      feedback: storedComment,
      authorized_officer_ids: report.authorizedOfficerIds.slice(0, 10),
      metadata: { outcome: 'confirmed', citizenId: actor.uid },
      created_at: nowIso,
    });
    if (fbErr) throw new Error(`Failed to save feedback: ${fbErr.message}`);

    await insertReportUpdateSafe({
      reportId: report.id,
      reporterId: report.reporterId,
      authorizedOfficerIds: report.authorizedOfficerIds,
      assignedWorkerId: report.assignedWorkerId,
      actorId: actor.uid,
      actorName,
      actorRole: 'citizen',
      fromStatus: 'citizen_confirmed',
      toStatus: 'citizen_confirmed',
      note: cleanComment
        ? `Citizen rated resolution ${cleanRating}/5: "${cleanComment}"`
        : `Citizen submitted ${cleanRating}/5 resolution rating.`,
    });
    return { ok: true, report };
  }

  if (action === 'escalate_overdue') {
    if (actor.role !== 'admin' && actor.role !== 'officer') {
      throw new Error('Only administrators or officers can escalate overdue tasks.');
    }
    const cleanReason = sanitizeText(
      payload.reason || 'Administrative SLA target exceeded — escalated to supervisor.',
      500
    );
    const supervisorUid = sanitizeText(
      payload.supervisorId || report.authorizedOfficerIds[0] || actor.uid,
      128
    );
    const supervisorName = sanitizeText(payload.supervisorName || supervisorUid, 100);

    const nextMeta = { ...meta, escalatedAtIso: nowIso, escalatedToId: supervisorUid };
    const { data: updated, error } = await supabase
      .from('reports')
      .update({ metadata: nextMeta, updated_at: nowIso })
      .eq('id', report.id)
      .select('*')
      .single();
    if (error || !updated) throw new Error(error?.message || 'Escalation failed.');

    await insertReportUpdateSafe({
      reportId: report.id,
      reporterId: report.reporterId,
      authorizedOfficerIds: report.authorizedOfficerIds,
      assignedWorkerId: report.assignedWorkerId,
      actorId: actor.uid,
      actorName,
      actorRole: actor.role,
      fromStatus: report.status,
      toStatus: report.status,
      note: `Escalated overdue task to supervisor ${supervisorName} at ${nowIso}. ${cleanReason}`,
    });
    await insertNotificationSafe({
      recipientId: supervisorUid,
      reportId: report.id,
      title: `Escalated overdue report: ${report.trackingCode}`,
      message: cleanReason.slice(0, 480),
      type: 'escalation',
    });
    return { ok: true, report: mapReportRow(updated) };
  }

  throw new Error(`Unsupported report workflow action: "${action}".`);
}

// ------------------------------------------------------------------
// Worker Location Sharing, Departments, Notifications, SLA & Alerts
// ------------------------------------------------------------------

export async function updateWorkerLocationSharingSupabase(
  actor: AuthenticatedUser,
  assignmentId: string,
  params: { active: boolean; lat?: number; lng?: number }
): Promise<void> {
  if (!SAFE_ID_REGEX.test(assignmentId)) throw new Error('Invalid task assignment identifier.');
  const supabase = getSupabaseAdminClient();
  const { data: row } = await supabase
    .from('assignments')
    .select('id, worker_id, metadata')
    .eq('id', assignmentId)
    .maybeSingle();
  if (!row) throw new Error('Task assignment not found.');
  if (actor.role !== 'admin' && row.worker_id !== actor.uid) {
    throw new Error('Only the assigned worker can update location sharing for this assignment.');
  }

  const nowIso = new Date().toISOString();
  const nextMeta: Record<string, any> = {
    ...asObj(row.metadata),
    workerLocationSharingActive: Boolean(params.active),
    workerLocationUpdatedAtIso: nowIso,
  };
  if (
    params.active &&
    typeof params.lat === 'number' &&
    typeof params.lng === 'number' &&
    Number.isFinite(params.lat) &&
    Number.isFinite(params.lng)
  ) {
    nextMeta.workerLocationLat = params.lat;
    nextMeta.workerLocationLng = params.lng;
  }

  const { error } = await supabase
    .from('assignments')
    .update({ metadata: nextMeta, updated_at: nowIso })
    .eq('id', assignmentId);
  if (error) throw new Error(`Failed to update location sharing: ${error.message}`);
}

export async function adminSaveDepartmentSupabase(
  actor: AuthenticatedUser,
  params: {
    id?: string;
    name: string;
    code: string;
    description: string;
    categories: string[];
    officerIds: string[];
    active: boolean;
  }
) {
  if (actor.role !== 'admin') {
    throw new Error('Only administrators can create or update municipal departments.');
  }
  const deptId = params.id && SAFE_ID_REGEX.test(params.id) ? params.id : makeServerId('dept');
  const nowIso = new Date().toISOString();
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from('departments')
    .upsert(
      {
        id: deptId,
        name: sanitizeText(params.name, 120),
        description: sanitizeText(params.description, 500),
        categories: (params.categories || []).slice(0, 10),
        officer_ids: (params.officerIds || []).slice(0, 15),
        is_active: Boolean(params.active),
        metadata: { code: sanitizeText((params.code || '').toUpperCase(), 24) },
        updated_at: nowIso,
      },
      { onConflict: 'id' }
    )
    .select('*')
    .single();
  if (error || !data) throw new Error(`Failed to save department: ${error?.message || 'Unknown error'}`);
  return mapDepartmentRow(data);
}

export async function markNotificationsReadSupabase(
  user: AuthenticatedUser,
  notificationIds: string[]
): Promise<void> {
  const ids = Array.from(new Set(notificationIds.filter((id) => SAFE_ID_REGEX.test(id))));
  if (ids.length === 0) return;
  const supabase = getSupabaseAdminClient();
  const nowIso = new Date().toISOString();
  await supabase
    .from('notifications')
    .update({ is_read: true, read_at: nowIso })
    .eq('user_id', user.uid)
    .in('id', ids);
}

export async function saveSlaPolicySupabase(
  actor: AuthenticatedUser,
  params: {
    scopeType: 'global' | 'department' | 'category' | 'department_category';
    departmentId: string;
    departmentName?: string;
    category: string;
    ackTargetHours: number;
    assignTargetHours: number;
    resolveTargetHours: number;
    escalationRole: 'officer' | 'admin';
  }
): Promise<string> {
  if (actor.role !== 'admin') {
    throw new Error('Only administrators can configure SLA policies.');
  }
  const safeDept = (params.departmentId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeCat = (params.category || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const policyId =
    params.scopeType === 'global'
      ? 'sla_global'
      : params.scopeType === 'department'
        ? `sla_dept_${safeDept}`
        : params.scopeType === 'category'
          ? `sla_cat_${safeCat}`
          : `sla_dept_${safeDept}__${safeCat}`;

  const ackH = Math.max(0.5, Math.min(720, Number(params.ackTargetHours) || 4));
  const assignH = Math.max(1, Math.min(720, Number(params.assignTargetHours) || 12));
  const resolveH = Math.max(1, Math.min(2160, Number(params.resolveTargetHours) || 48));
  const deptFk =
    params.scopeType === 'global' || params.scopeType === 'category' || !params.departmentId
      ? null
      : params.departmentId;
  const catCol =
    params.scopeType === 'global' || params.scopeType === 'department' ? null : params.category || null;

  const supabase = getSupabaseAdminClient();
  const nowIso = new Date().toISOString();
  const { error } = await supabase.from('sla_policies').upsert(
    {
      id: policyId,
      category: catCol,
      priority: 'all',
      response_time_hours: Math.round(ackH),
      resolution_time_hours: Math.round(resolveH),
      department_id: deptFk,
      is_active: true,
      metadata: {
        scopeType: params.scopeType,
        departmentName: sanitizeText(params.departmentName || '', 120),
        ackTargetHours: ackH,
        assignTargetHours: assignH,
        resolveTargetHours: resolveH,
        escalationRole: params.escalationRole === 'officer' ? 'officer' : 'admin',
        updatedById: actor.uid,
      },
      updated_at: nowIso,
    },
    { onConflict: 'id' }
  );
  if (error) throw new Error(`Failed to save SLA policy: ${error.message}`);
  return policyId;
}

export async function syncOperationalAlertsSupabase(
  actor: AuthenticatedUser,
  candidates: Array<{
    alertKey: string;
    kind: string;
    reportId: string;
    trackingCode: string;
    departmentId: string;
    authorizedOfficerIds: string[];
    recipientIds: string[];
    severity: 'info' | 'warning' | 'critical';
    notificationType: string;
    title: string;
    message: string;
  }>
): Promise<number> {
  if (actor.role !== 'admin' && actor.role !== 'officer') return 0;
  const supabase = getSupabaseAdminClient();
  let createdCount = 0;
  const nowIso = new Date().toISOString();

  for (const c of (candidates || []).slice(0, 30)) {
    const alertId = String(c.alertKey || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
    if (!SAFE_ID_REGEX.test(alertId) || !SAFE_ID_REGEX.test(c.reportId)) continue;

    const { data: existing } = await supabase
      .from('operational_alerts')
      .select('id')
      .eq('id', alertId)
      .maybeSingle();
    if (existing) continue;

    const recipients = Array.from(new Set(c.recipientIds || []))
      .filter((uid) => isUuid(uid))
      .slice(0, 10);
    if (recipients.length === 0) continue;

    const { error } = await supabase.from('operational_alerts').insert({
      id: alertId,
      title: sanitizeText(c.title, 140),
      message: sanitizeText(c.message, 500),
      alert_type: sanitizeText(c.kind, 64),
      severity: c.severity || 'warning',
      related_report_id: c.reportId,
      department_id: c.departmentId || null,
      recipient_ids: recipients,
      authorized_officer_ids: (c.authorizedOfficerIds || []).slice(0, 10),
      status: 'active',
      metadata: {
        alertKey: alertId,
        kind: c.kind,
        trackingCode: sanitizeText(c.trackingCode || 'CF-0000', 32),
      },
      created_at: nowIso,
      updated_at: nowIso,
    });

    if (!error) {
      createdCount++;
      for (const uid of recipients.slice(0, 4)) {
        await insertNotificationSafe({
          id: `ntf_${alertId}_${uid}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120),
          recipientId: uid,
          reportId: c.reportId,
          title: c.title,
          message: c.message,
          type: c.notificationType || 'deadline_warning',
        });
      }
    }
  }
  return createdCount;
}

export async function acknowledgeOperationalAlertSupabase(
  actor: AuthenticatedUser,
  alertId: string
): Promise<void> {
  if (actor.role !== 'admin' && actor.role !== 'officer') {
    throw new Error('Only staff can acknowledge operational alerts.');
  }
  if (!SAFE_ID_REGEX.test(alertId)) throw new Error('Invalid alert ID.');
  const supabase = getSupabaseAdminClient();
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from('operational_alerts')
    .update({ status: 'acknowledged', resolved_at: nowIso, updated_at: nowIso })
    .eq('id', alertId);
  if (error) throw new Error(`Failed to acknowledge alert: ${error.message}`);
}

export async function syncMissingPublicReportsSupabase(actor: AuthenticatedUser): Promise<number> {
  if (actor.role !== 'admin') return 0;
  const supabase = getSupabaseAdminClient();
  const [{ data: repRows }, { data: pubRows }] = await Promise.all([
    supabase.from('reports').select('*').limit(300),
    supabase.from('public_reports').select('id').limit(500),
  ]);
  const existingIds = new Set((pubRows || []).map((p) => String(p.id)));
  let synced = 0;
  for (const r of repRows || []) {
    if (!existingIds.has(String(r.id))) {
      await syncPublicReportProjection(mapReportRow(r));
      synced++;
    }
  }
  return synced;
}

// ------------------------------------------------------------------
// NGO, Volunteer & Civic Activities (Supabase)
// ------------------------------------------------------------------

export async function registerNgoOrganizationSupabase(
  owner: AuthenticatedUser,
  params: {
    name: string;
    registrationNumber: string;
    focusAreas: string[];
    operatingCityOrWard: string;
    description: string;
    contactEmail: string;
    contactPhone?: string;
  }
): Promise<string> {
  const ngoId = makeServerId('ngo');
  const cleanName = sanitizeText(params.name, 120);
  const cleanReg = sanitizeText(params.registrationNumber, 80);
  const cleanArea = sanitizeText(params.operatingCityOrWard, 120);
  const cleanDesc = sanitizeText(params.description, 1000);
  const cleanEmail = sanitizeText(params.contactEmail, 200);
  const cleanPhone = sanitizeText(params.contactPhone || '', 32);
  const focusAreas = (params.focusAreas || []).map((s) => sanitizeText(s, 60)).filter(Boolean).slice(0, 8);

  if (cleanName.length < 2) throw new Error('NGO name must be at least 2 characters.');
  if (cleanReg.length < 2) throw new Error('Registration number must be at least 2 characters.');
  if (focusAreas.length === 0) throw new Error('Select at least one civic focus area.');
  if (cleanArea.length < 2) throw new Error('Operating ward or city is required.');
  if (cleanDesc.length < 10) throw new Error('Description must be at least 10 characters.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new Error('Please provide a valid NGO contact email.');
  }

  const supabase = getSupabaseAdminClient();
  const nowIso = new Date().toISOString();
  const { error } = await supabase.from('ngo_organizations').insert({
    id: ngoId,
    name: cleanName,
    description: cleanDesc,
    email: cleanEmail,
    phone: cleanPhone || null,
    address: cleanArea,
    focus_areas: focusAreas,
    status: 'pending',
    metadata: {
      ownerUid: owner.uid,
      ownerName: sanitizeText(owner.name || 'NGO Coordinator', 100),
      registrationNumber: cleanReg,
      operatingCityOrWard: cleanArea,
    },
    created_at: nowIso,
    updated_at: nowIso,
  });
  if (error) throw new Error(`Failed to register NGO organization: ${error.message}`);
  return ngoId;
}

export async function reviewNgoOrganizationSupabase(
  admin: AuthenticatedUser,
  ngoId: string,
  params: { decision: 'approved' | 'rejected'; reviewNote: string }
): Promise<void> {
  if (admin.role !== 'admin') throw new Error('Only administrators can verify NGO organizations.');
  if (!SAFE_ID_REGEX.test(ngoId)) throw new Error('Invalid NGO ID.');
  const supabase = getSupabaseAdminClient();
  const { data: row } = await supabase.from('ngo_organizations').select('metadata').eq('id', ngoId).maybeSingle();
  if (!row) throw new Error('NGO organization not found.');

  const nextMeta = {
    ...asObj(row.metadata),
    reviewedByUid: admin.uid,
    reviewedByName: sanitizeText(admin.name || 'Administrator', 100),
    reviewNote: sanitizeText(
      params.reviewNote || (params.decision === 'approved' ? 'Verified municipal NGO partner.' : 'Verification declined.'),
      500
    ),
  };
  const { error } = await supabase
    .from('ngo_organizations')
    .update({ status: params.decision, metadata: nextMeta, updated_at: new Date().toISOString() })
    .eq('id', ngoId);
  if (error) throw new Error(`Failed to review NGO organization: ${error.message}`);
}

export async function upsertVolunteerProfileSupabase(
  user: AuthenticatedUser,
  params: { skills: string[]; serviceArea: string; availability: string; active: boolean }
): Promise<void> {
  const cleanArea = sanitizeText(params.serviceArea, 120);
  const cleanAvail = sanitizeText(params.availability, 120);
  const cleanSkills = (params.skills || []).map((s) => sanitizeText(s, 60)).filter(Boolean).slice(0, 8);
  if (cleanArea.length < 2) throw new Error('Service area must be at least 2 characters.');
  if (cleanAvail.length < 2) throw new Error('Availability details must be at least 2 characters.');

  const supabase = getSupabaseAdminClient();
  const nowIso = new Date().toISOString();
  const { data: existing } = await supabase
    .from('volunteer_profiles')
    .select('id, total_activities, metadata')
    .eq('id', user.uid)
    .maybeSingle();

  const { error } = await supabase.from('volunteer_profiles').upsert(
    {
      id: user.uid,
      full_name: sanitizeText(user.name || 'Volunteer', 100),
      email: user.email || null,
      skills: cleanSkills,
      availability_status: cleanAvail,
      total_activities: existing?.total_activities || 0,
      metadata: {
        ...asObj(existing?.metadata),
        serviceArea: cleanArea,
        availability: cleanAvail,
        active: Boolean(params.active),
      },
      updated_at: nowIso,
    },
    { onConflict: 'id' }
  );
  if (error) throw new Error(`Failed to save volunteer profile: ${error.message}`);
}

export async function publishCivicActivitySupabase(
  actor: AuthenticatedUser,
  params: {
    ngoId: string;
    title: string;
    description: string;
    category: string;
    locationLabel: string;
    wardOrZone?: string;
    scheduledDateIso: string;
    maxVolunteers: number;
    relatedReportId?: string;
  }
): Promise<string> {
  const supabase = getSupabaseAdminClient();
  const { data: ngoRow } = await supabase
    .from('ngo_organizations')
    .select('*')
    .eq('id', params.ngoId)
    .maybeSingle();
  if (!ngoRow) throw new Error('NGO organization not found.');
  if (ngoRow.status !== 'approved') {
    throw new Error('Your NGO must be verified by an administrator before publishing civic activities.');
  }
  const ngoMeta = asObj(ngoRow.metadata);
  if (actor.role !== 'admin' && ngoMeta.ownerUid !== actor.uid) {
    throw new Error('Only the NGO owner or an administrator can publish activities for this organization.');
  }

  const activityId = makeServerId('act');
  const cleanTitle = sanitizeText(params.title, 160);
  const cleanDesc = sanitizeText(params.description, 2000);
  const cleanLoc = sanitizeText(params.locationLabel, 180);
  const cleanDate = sanitizeText(params.scheduledDateIso, 64);
  const safeMax = Math.max(1, Math.min(500, Math.round(params.maxVolunteers || 25)));
  if (cleanTitle.length < 3) throw new Error('Activity title must be at least 3 characters.');
  if (cleanDesc.length < 10) throw new Error('Activity description must be at least 10 characters.');
  if (cleanLoc.length < 2) throw new Error('Activity location is required.');
  if (cleanDate.length < 4) throw new Error('Scheduled date and time are required.');

  const nowIso = new Date().toISOString();
  const scheduledTs = Number.isNaN(Date.parse(cleanDate)) ? nowIso : new Date(cleanDate).toISOString();
  const { error } = await supabase.from('civic_activities').insert({
    id: activityId,
    title: cleanTitle,
    description: cleanDesc,
    organization_id: ngoRow.id,
    activity_type: params.category,
    category: params.category,
    location: cleanLoc,
    scheduled_at: scheduledTs,
    status: 'pending_approval',
    participant_count: 0,
    completion_photo_urls: [],
    completion_photo_metadata: [],
    created_by: actor.uid,
    metadata: {
      ngoId: ngoRow.id,
      ngoName: String(ngoRow.name),
      createdByUid: actor.uid,
      wardOrZone: sanitizeText(params.wardOrZone || '', 80),
      scheduledDateIso: cleanDate,
      maxVolunteers: safeMax,
      relatedReportId: sanitizeText(params.relatedReportId || '', 128),
    },
    created_at: nowIso,
    updated_at: nowIso,
  });
  if (error) throw new Error(`Failed to publish civic activity: ${error.message}`);
  return activityId;
}

export async function reviewCivicActivitySupabase(
  admin: AuthenticatedUser,
  activityId: string,
  params: { decision: 'approved' | 'rejected'; reviewNote: string }
): Promise<void> {
  if (admin.role !== 'admin') {
    throw new Error('Only administrators can approve or reject civic activities.');
  }
  const supabase = getSupabaseAdminClient();
  const { data: row } = await supabase.from('civic_activities').select('*').eq('id', activityId).maybeSingle();
  if (!row) throw new Error('Civic activity not found.');

  const nowIso = new Date().toISOString();
  const nextMeta = {
    ...asObj(row.metadata),
    reviewedByUid: admin.uid,
    reviewNote: sanitizeText(
      params.reviewNote || (params.decision === 'approved' ? 'Approved for public volunteer participation.' : 'Activity declined.'),
      500
    ),
  };

  const { data: updated, error } = await supabase
    .from('civic_activities')
    .update({ status: params.decision, metadata: nextMeta, updated_at: nowIso })
    .eq('id', activityId)
    .select('*')
    .single();
  if (error || !updated) throw new Error(error?.message || 'Failed to review activity.');

  if (params.decision === 'approved') {
    const mapped = mapCivicActivityRow(updated);
    await supabase.from('public_activities').upsert(
      {
        id: mapped.id,
        title: mapped.title,
        description: mapped.description,
        activity_type: mapped.category,
        category: mapped.category,
        location: mapped.locationLabel,
        scheduled_at: updated.scheduled_at,
        status: 'approved',
        participant_count: mapped.participantCount,
        completion_photo_urls: [],
        timeline_events: {
          ngoId: mapped.ngoId,
          ngoName: mapped.ngoName,
          wardOrZone: mapped.wardOrZone || '',
          maxVolunteers: mapped.maxVolunteers,
          completionSummary: '',
          completionPhotoCount: 0,
        },
        created_at: mapped.createdAt,
        updated_at: nowIso,
      },
      { onConflict: 'id' }
    );
  }
}

export async function submitCivicActivityCompletionSupabase(
  actor: AuthenticatedUser,
  activityId: string,
  params: { completionSummary: string; completionPhotoMetadata: any[] }
): Promise<void> {
  const cleanSummary = sanitizeText(params.completionSummary, 1000);
  if (cleanSummary.length < 10) {
    throw new Error('Completion summary must be at least 10 characters.');
  }
  const supabase = getSupabaseAdminClient();
  const { data: row } = await supabase.from('civic_activities').select('*').eq('id', activityId).maybeSingle();
  if (!row) throw new Error('Civic activity not found.');
  if (actor.role !== 'admin' && row.created_by !== actor.uid) {
    throw new Error('Only the organizing NGO coordinator or an administrator can submit completion evidence.');
  }

  const photos = Array.isArray(params.completionPhotoMetadata) ? params.completionPhotoMetadata.slice(0, 5) : [];
  const photoUrls = photos.map((p) => String(p?.url || '')).filter(Boolean);
  const nowIso = new Date().toISOString();
  const nextMeta = {
    ...asObj(row.metadata),
    completionSummary: cleanSummary,
    completionSubmittedAtIso: nowIso,
  };

  const { error } = await supabase
    .from('civic_activities')
    .update({
      status: 'completed',
      completed_at: nowIso,
      completion_photo_urls: photoUrls,
      completion_photo_metadata: photos,
      metadata: nextMeta,
      updated_at: nowIso,
    })
    .eq('id', activityId);
  if (error) throw new Error(`Failed to complete civic activity: ${error.message}`);

  const { data: pub } = await supabase
    .from('public_activities')
    .select('id, timeline_events')
    .eq('id', activityId)
    .maybeSingle();
  if (pub) {
    await supabase
      .from('public_activities')
      .update({
        status: 'completed',
        completed_at: nowIso,
        completion_photo_urls: photoUrls,
        timeline_events: {
          ...asObj(pub.timeline_events),
          completionSummary: cleanSummary,
          completionPhotoCount: photos.length,
        },
        updated_at: nowIso,
      })
      .eq('id', activityId);
  }
}

export async function joinCivicActivitySupabase(
  user: AuthenticatedUser,
  activityId: string,
  note?: string
): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const { data: actRow } = await supabase.from('civic_activities').select('*').eq('id', activityId).maybeSingle();
  if (!actRow) throw new Error('Civic activity not found.');
  const act = mapCivicActivityRow(actRow);
  if (act.status !== 'approved') {
    throw new Error('Only approved activities are open for volunteer registration.');
  }
  if (act.participantCount >= act.maxVolunteers) {
    throw new Error('This activity has reached its maximum volunteer capacity.');
  }

  const partId = `${activityId}_${user.uid}`;
  const { data: existingPart } = await supabase
    .from('activity_participants')
    .select('id, status')
    .eq('id', partId)
    .maybeSingle();
  if (existingPart && existingPart.status === 'joined') {
    throw new Error('You have already joined this activity.');
  }

  const nowIso = new Date().toISOString();
  const { error: partErr } = await supabase.from('activity_participants').upsert(
    {
      id: partId,
      activity_id: activityId,
      volunteer_id: user.uid,
      status: 'joined',
      joined_at: nowIso,
      notes: sanitizeText(note || '', 300),
      metadata: { volunteerName: sanitizeText(user.name || 'Citizen Volunteer', 100) },
      updated_at: nowIso,
    },
    { onConflict: 'id' }
  );
  if (partErr) throw new Error(`Failed to join activity: ${partErr.message}`);

  const nextCount = Math.min(act.maxVolunteers, act.participantCount + 1);
  await Promise.all([
    supabase
      .from('civic_activities')
      .update({ participant_count: nextCount, updated_at: nowIso })
      .eq('id', activityId),
    supabase
      .from('public_activities')
      .update({ participant_count: nextCount, updated_at: nowIso })
      .eq('id', activityId),
  ]);

  const { data: vol } = await supabase
    .from('volunteer_profiles')
    .select('id, total_activities')
    .eq('id', user.uid)
    .maybeSingle();
  if (vol) {
    await supabase
      .from('volunteer_profiles')
      .update({ total_activities: (vol.total_activities || 0) + 1, updated_at: nowIso })
      .eq('id', user.uid);
  }
}

export async function withdrawFromCivicActivitySupabase(
  user: AuthenticatedUser,
  activityId: string
): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const partId = `${activityId}_${user.uid}`;
  const nowIso = new Date().toISOString();

  await supabase
    .from('activity_participants')
    .update({ status: 'withdrawn', withdrawn_at: nowIso, updated_at: nowIso })
    .eq('id', partId)
    .eq('volunteer_id', user.uid);

  const { data: actRow } = await supabase
    .from('civic_activities')
    .select('participant_count')
    .eq('id', activityId)
    .maybeSingle();
  const nextCount = Math.max(0, (actRow?.participant_count || 1) - 1);

  await Promise.all([
    supabase
      .from('civic_activities')
      .update({ participant_count: nextCount, updated_at: nowIso })
      .eq('id', activityId),
    supabase
      .from('public_activities')
      .update({ participant_count: nextCount, updated_at: nowIso })
      .eq('id', activityId),
  ]);
}
