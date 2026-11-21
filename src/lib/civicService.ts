import { supabase } from '../../supabase';
import type {
  ActivityCategory,
  AiAnalysis,
  AiPhotoAssessmentResult,
  AnonymizedTrendDigest,
  AppNotification,
  Assignment,
  AuditLog,
  AuthorityEmailLog,
  AuthorityEmailStatus,
  CitizenFeedback,
  CitizenNotificationStatus,
  CivicActivity,
  CivicReport,
  Department,
  DepartmentEmailSetting,
  DuplicateCandidate,
  IssueCategory,
  IssuePriority,
  NgoOrganization,
  OperationalAlertCandidate,
  OperationalAlertRecord,
  PublicCivicActivity,
  PublicDepartmentPerformance,
  PublicMonthlyTrend,
  PublicReportSummary,
  PublicTransparencyOverview,
  PublicUpdateDigestItem,
  ReportUpdate,
  SlaPolicy,
  SlaScopeType,
  TemporaryUploadResult,
  TrendIntelligenceResult,
  UploadedImageMetadata,
  UserPrivateContact,
  UserProfile,
  UserRole,
  VolunteerProfile,
  WorkerAvailabilityStatus,
  WorkerInvite,
} from '../types/civic';

const DATA_CHANGED_EVENT = 'civicfix:data-changed';

export function emitCivicDataChanged(scope = 'all'): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(DATA_CHANGED_EVENT, { detail: { scope } }));
  }
}

async function resolveAccessToken(explicitToken?: string): Promise<string> {
  if (explicitToken && explicitToken.trim()) {
    return explicitToken.trim();
  }
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new Error('Authentication required. Please sign in to continue.');
  }
  return token;
}

export function makeId(prefix: string): string {
  const raw =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${raw}`;
}

export function makeTrackingCode(): string {
  const year = new Date().getFullYear();
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    const num = 100000 + (arr[0] % 900000);
    return `CF-${year}-${num}`;
  }
  const num = Math.floor(100000 + Math.random() * 900000);
  return `CF-${year}-${num}`;
}

export function sanitizeString(val: string, maxLen: number): string {
  return String(val || '').trim().slice(0, maxLen);
}

export function formatFriendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.error === 'string') {
      return parsed.path
        ? `Operation (${parsed.operationType || 'access'}) on ${parsed.path} failed: ${parsed.error}`
        : parsed.error;
    }
  } catch {
    // Not JSON
  }
  return raw;
}

export function toTimestampMs(ts: any): number {
  if (!ts) return 0;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : 0;
  if (typeof ts?.toMillis === 'function') return ts.toMillis();
  if (typeof ts?.toDate === 'function') return ts.toDate().getTime();
  const parsed = Date.parse(String(ts));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function buildApiUrl(endpoint: string): string {
  const cleanPath = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const configuredBase =
    typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL
      ? String(import.meta.env.VITE_API_BASE_URL).trim().replace(/\/+$/, '')
      : '';
  if (configuredBase) {
    return `${configuredBase}${cleanPath}`;
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${cleanPath}`;
  }
  return cleanPath;
}

function getCivicClientHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Accept: 'application/json',
    'X-CivicFix-Client': 'web',
    ...(extra || {}),
  };
}

async function safeFetchApi(
  url: string,
  init: RequestInit,
  endpointLabel: string
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    throw new Error(
      `Network connection interrupted while reaching ${endpointLabel}. Please check your internet connection and retry.`
    );
  }
}

async function parseJsonResponse<T = Record<string, any>>(
  res: Response,
  endpointLabel: string
): Promise<T> {
  const rawText = await res.text();
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const trimmed = rawText.trimStart();

  if (
    (res.redirected && (res.url.includes('__cookie_check') || res.url.includes('auth-bridge'))) ||
    rawText.includes('Cookie check')
  ) {
    throw new Error(
      `Session verification cookie expired while calling ${endpointLabel}. Please refresh the page or open the app in a new tab and try again.`
    );
  }

  if (res.status === 404 && (trimmed.startsWith('<') || !contentType.includes('application/json'))) {
    throw new Error(
      `Backend endpoint not found (HTTP 404) for ${endpointLabel}. Verify the API server is running and route exists.`
    );
  }

  if (res.status === 403 && (trimmed.startsWith('<') || !contentType.includes('application/json'))) {
    throw new Error(
      `Upstream preview or deployment gateway returned HTTP 403 HTML for ${endpointLabel} before the request reached the CivicFix backend. Open the app URL directly in a standalone browser tab or verify access permissions.`
    );
  }

  if (trimmed.startsWith('<') || !contentType.includes('application/json')) {
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new Error(
        `Backend service temporarily unavailable for ${endpointLabel} (HTTP ${res.status}). Please retry in a moment.`
      );
    }
    throw new Error(
      `Expected JSON from ${endpointLabel} but received ${contentType || 'HTML/unknown response'} (HTTP ${res.status}). Verify the backend API route is reachable.`
    );
  }

  let parsed: any;
  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch {
    throw new Error(`Invalid JSON payload returned by ${endpointLabel} (HTTP ${res.status}).`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Unexpected response structure returned by ${endpointLabel} (HTTP ${res.status}).`);
  }

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(parsed?.error || `Backend endpoint or resource not found (HTTP 404) at ${endpointLabel}.`);
    }
    throw new Error(parsed?.error || `Request to ${endpointLabel} failed (HTTP ${res.status}).`);
  }

  return parsed as T;
}

async function authedJsonRequest<T = Record<string, any>>(
  endpoint: string,
  options: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: Record<string, any>;
    idToken?: string;
    extraHeaders?: Record<string, string>;
  }
): Promise<T> {
  const token = await resolveAccessToken(options.idToken);
  const headers = getCivicClientHeaders({
    Authorization: `Bearer ${token}`,
    ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(options.extraHeaders || {}),
  });

  const res = await safeFetchApi(
    buildApiUrl(endpoint),
    {
      method: options.method,
      credentials: 'same-origin',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    },
    endpoint
  );

  return parseJsonResponse<T>(res, endpoint);
}

// ------------------------------------------------------------------
// Workspace, Detail & Realtime Subscriptions (Supabase PostgreSQL)
// ------------------------------------------------------------------

export interface WorkspaceSnapshotData {
  departments: Department[];
  reports: CivicReport[];
  assignments: Assignment[];
  staffUsers: UserProfile[];
  notifications: AppNotification[];
  slaPolicies: SlaPolicy[];
  operationalAlerts: OperationalAlertRecord[];
  workerInvites: WorkerInvite[];
  allFeedbacks: CitizenFeedback[];
  allAiAnalyses: AiAnalysis[];
  allReportUpdates: ReportUpdate[];
  departmentEmailSettings: DepartmentEmailSetting[];
  authorityEmailLogs: AuthorityEmailLog[];
  ngoOrganizations: NgoOrganization[];
  volunteerProfile: VolunteerProfile | null;
  civicActivities: CivicActivity[];
  joinedActivityIds: string[];
}

export async function fetchWorkspaceSnapshotViaApi(
  idToken?: string
): Promise<WorkspaceSnapshotData> {
  const data = await authedJsonRequest<Partial<WorkspaceSnapshotData>>('/api/workspace', {
    method: 'GET',
    idToken,
  });

  return {
    departments: Array.isArray(data.departments) ? data.departments : [],
    reports: Array.isArray(data.reports) ? data.reports : [],
    assignments: Array.isArray(data.assignments) ? data.assignments : [],
    staffUsers: Array.isArray(data.staffUsers) ? data.staffUsers : [],
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
    slaPolicies: Array.isArray(data.slaPolicies) ? data.slaPolicies : [],
    operationalAlerts: Array.isArray(data.operationalAlerts) ? data.operationalAlerts : [],
    workerInvites: Array.isArray(data.workerInvites) ? data.workerInvites : [],
    allFeedbacks: Array.isArray(data.allFeedbacks) ? data.allFeedbacks : [],
    allAiAnalyses: Array.isArray(data.allAiAnalyses) ? data.allAiAnalyses : [],
    allReportUpdates: Array.isArray(data.allReportUpdates) ? data.allReportUpdates : [],
    departmentEmailSettings: Array.isArray(data.departmentEmailSettings)
      ? data.departmentEmailSettings
      : [],
    authorityEmailLogs: Array.isArray(data.authorityEmailLogs) ? data.authorityEmailLogs : [],
    ngoOrganizations: Array.isArray(data.ngoOrganizations) ? data.ngoOrganizations : [],
    volunteerProfile: data.volunteerProfile || null,
    civicActivities: Array.isArray(data.civicActivities) ? data.civicActivities : [],
    joinedActivityIds: Array.isArray(data.joinedActivityIds) ? data.joinedActivityIds : [],
  };
}

export interface ReportDetailBundleData {
  report: CivicReport;
  updates: ReportUpdate[];
  auditLogs: AuditLog[];
  latestAssignment: Assignment | null;
  aiAnalysis: AiAnalysis | null;
  feedbacks: CitizenFeedback[];
}

export async function fetchReportDetailViaApi(
  reportId: string,
  idToken?: string
): Promise<ReportDetailBundleData | null> {
  const token = await resolveAccessToken(idToken);
  const res = await safeFetchApi(
    buildApiUrl(`/api/reports/${encodeURIComponent(reportId)}/detail`),
    {
      method: 'GET',
      credentials: 'same-origin',
      headers: getCivicClientHeaders({
        Authorization: `Bearer ${token}`,
      }),
    },
    `/api/reports/${reportId}/detail`
  );
  if (res.status === 404) return null;
  const data = await parseJsonResponse<Partial<ReportDetailBundleData>>(
    res,
    `/api/reports/${reportId}/detail`
  );
  if (!data.report) return null;
  return {
    report: data.report,
    updates: Array.isArray(data.updates) ? data.updates : [],
    auditLogs: Array.isArray(data.auditLogs) ? data.auditLogs : [],
    latestAssignment: data.latestAssignment || null,
    aiAnalysis: data.aiAnalysis || null,
    feedbacks: Array.isArray(data.feedbacks) ? data.feedbacks : [],
  };
}

/**
 * Subscribes to Supabase Realtime `postgres_changes` across the specified tables
 * AND local mutation events so views update both instantaneously and across users.
 */
export function subscribeToCivicRealtime(
  channelName: string,
  tables: string[],
  onChange: () => void,
  debounceMs = 350
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const scheduleRefresh = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!disposed) onChange();
    }, debounceMs);
  };

  const handleLocalEvent = () => scheduleRefresh();
  if (typeof window !== 'undefined') {
    window.addEventListener(DATA_CHANGED_EVENT, handleLocalEvent);
  }

  let channel: ReturnType<typeof supabase.channel> | null = null;
  try {
    channel = supabase.channel(`${channelName}_${Date.now()}`);
    for (const table of tables) {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        () => scheduleRefresh()
      );
    }
    channel.subscribe();
  } catch {
    // Fallback cleanly to local events + periodic sync if Realtime is unavailable
  }

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    if (typeof window !== 'undefined') {
      window.removeEventListener(DATA_CHANGED_EVENT, handleLocalEvent);
    }
    if (channel) {
      try {
        void supabase.removeChannel(channel);
      } catch {
        // Ignore teardown errors
      }
    }
  };
}

// ------------------------------------------------------------------
// Profile Initialization & Basic Report Listing
// ------------------------------------------------------------------

export interface InitializeProfileOutcome {
  profile: UserProfile;
  isAdmin: boolean;
  bootstrapApplied: boolean;
  bootstrapPendingServerConfig: boolean;
  bootstrapNotice: string | null;
}

export async function initializeAuthenticatedProfile(
  idToken: string
): Promise<InitializeProfileOutcome> {
  const data = await authedJsonRequest<{
    profile?: UserProfile;
    isAdmin?: boolean;
    bootstrapApplied?: boolean;
    bootstrapPendingServerConfig?: boolean;
    bootstrapNotice?: string | null;
    error?: string;
  }>('/api/auth/initialize', {
    method: 'POST',
    body: {},
    idToken,
  });

  if (!data.profile) {
    throw new Error(data.error || 'Profile initialization failed.');
  }

  return {
    profile: data.profile,
    isAdmin: Boolean(data.isAdmin),
    bootstrapApplied: Boolean(data.bootstrapApplied),
    bootstrapPendingServerConfig: Boolean(data.bootstrapPendingServerConfig),
    bootstrapNotice: data.bootstrapNotice || null,
  };
}

export async function fetchReportsViaApi(
  idToken: string,
  limitCount = 50
): Promise<{ scope: string; count: number; reports: CivicReport[] }> {
  const data = await authedJsonRequest<{
    ok?: boolean;
    scope?: string;
    count?: number;
    reports?: CivicReport[];
  }>(`/api/reports?limit=${encodeURIComponent(String(limitCount))}`, {
    method: 'GET',
    idToken,
  });
  return {
    scope: data.scope || 'personal_reports_only',
    count:
      typeof data.count === 'number'
        ? data.count
        : Array.isArray(data.reports)
          ? data.reports.length
          : 0,
    reports: Array.isArray(data.reports) ? data.reports : [],
  };
}

// ------------------------------------------------------------------
// Canonical Departments & Email Validation Helpers
// ------------------------------------------------------------------

export const CANONICAL_STARTER_DEPARTMENTS: Array<{
  id: string;
  name: string;
  code: string;
  description: string;
  categories: IssueCategory[];
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

export function resolveDepartmentForCategory(
  category: IssueCategory,
  departments?: Department[]
): { departmentId: string; departmentName: string } {
  if (Array.isArray(departments) && departments.length > 0) {
    const activeMatch = departments.find(
      (d) => d.active && Array.isArray(d.categories) && d.categories.includes(category)
    );
    if (activeMatch) {
      return { departmentId: activeMatch.id, departmentName: activeMatch.name };
    }
  }
  const canonical =
    CANONICAL_STARTER_DEPARTMENTS.find((d) => d.categories.includes(category)) ||
    CANONICAL_STARTER_DEPARTMENTS[0];
  return { departmentId: canonical.id, departmentName: canonical.name };
}

const CLIENT_DUMMY_EMAIL_DOMAINS = new Set([
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

const CLIENT_DUMMY_EMAIL_PATTERNS = [
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

export function validateNonDummyEmailClient(
  raw: string,
  allowEmpty = false
): { valid: boolean; email: string; error?: string } {
  const cleaned = String(raw || '').trim().toLowerCase().slice(0, 200);
  if (!cleaned) {
    if (allowEmpty) {
      return { valid: true, email: '' };
    }
    return { valid: false, email: '', error: 'Authority email not configured.' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(cleaned)) {
    return {
      valid: false,
      email: cleaned,
      error: `Invalid email address format: "${cleaned}".`,
    };
  }
  const domain = cleaned.split('@')[1] || '';
  if (
    CLIENT_DUMMY_EMAIL_DOMAINS.has(domain) ||
    CLIENT_DUMMY_EMAIL_PATTERNS.some((re) => re.test(cleaned))
  ) {
    return {
      valid: false,
      email: cleaned,
      error: `Placeholder or dummy email addresses (${cleaned}) are not permitted. Enter a real verified authority email.`,
    };
  }
  return { valid: true, email: cleaned };
}

// ------------------------------------------------------------------
// Department Email Settings & Outbound Email APIs
// ------------------------------------------------------------------

export interface EmailTransportStatusClient {
  configured: boolean;
  provider: 'smtp' | 'resend' | 'none';
  fromAddress: string;
  notice: string;
  senderAddress?: string;
  detail?: string;
}

export async function fetchAdminDepartmentEmailSettingsViaServer(idToken: string): Promise<{
  transport: EmailTransportStatusClient;
  settings: DepartmentEmailSetting[];
  logs: AuthorityEmailLog[];
}> {
  const data = await authedJsonRequest<{
    transport?: Partial<EmailTransportStatusClient>;
    settings?: DepartmentEmailSetting[];
    logs?: AuthorityEmailLog[];
  }>('/api/admin/department-emails', {
    method: 'GET',
    idToken,
  });

  const rawTransport = data.transport || {};
  const fromAddress = rawTransport.fromAddress || rawTransport.senderAddress || '';
  const notice =
    rawTransport.notice ||
    rawTransport.detail ||
    'Email transport status retrieved from server.';

  return {
    transport: {
      configured: Boolean(rawTransport.configured),
      provider: rawTransport.provider || 'none',
      fromAddress,
      notice,
      senderAddress: rawTransport.senderAddress || fromAddress,
      detail: rawTransport.detail || notice,
    },
    settings: Array.isArray(data.settings) ? data.settings : [],
    logs: Array.isArray(data.logs) ? data.logs : [],
  };
}

export async function saveDepartmentEmailSettingViaServer(
  departmentId: string,
  payload: {
    departmentName: string;
    officialAuthorityEmail: string;
    seniorAuthorityEmail: string;
    notificationEnabled: boolean;
    departmentContactPerson: string;
  },
  idToken: string
): Promise<DepartmentEmailSetting> {
  const data = await authedJsonRequest<{ setting?: DepartmentEmailSetting; error?: string }>(
    `/api/admin/department-emails/${encodeURIComponent(departmentId)}`,
    {
      method: 'PUT',
      body: payload,
      idToken,
    }
  );
  if (!data.setting) {
    throw new Error(data.error || 'Failed to save department authority email configuration.');
  }
  emitCivicDataChanged('department_emails');
  return data.setting;
}

export interface ServerEmailTransportInfo {
  emailConfigured: boolean;
  emailProvider: 'smtp' | 'resend' | 'none';
}

export async function fetchServerEmailTransportStatus(): Promise<ServerEmailTransportInfo> {
  try {
    const res = await fetch(buildApiUrl('/api/health'), {
      method: 'GET',
      credentials: 'same-origin',
      headers: getCivicClientHeaders(),
    });
    if (!res.ok) {
      return { emailConfigured: false, emailProvider: 'none' };
    }
    const data = (await res.json()) as {
      emailConfigured?: boolean;
      emailProvider?: 'smtp' | 'resend' | 'none';
    };
    return {
      emailConfigured: Boolean(data.emailConfigured),
      emailProvider: data.emailProvider || 'none',
    };
  } catch {
    return { emailConfigured: false, emailProvider: 'none' };
  }
}

export async function sendTestAuthorityEmailViaServer(
  payload: { toEmail: string; departmentName?: string },
  idToken: string,
  gmailAccessToken?: string | null
): Promise<{
  ok: boolean;
  sent: boolean;
  provider: 'smtp' | 'resend' | 'gmail' | 'none';
  senderAddress: string;
  message: string;
}> {
  return authedJsonRequest('/api/admin/department-emails/test', {
    method: 'POST',
    body: payload,
    idToken,
    extraHeaders: gmailAccessToken ? { 'X-Gmail-Access-Token': gmailAccessToken } : undefined,
  });
}

export async function retryAuthorityEmailViaServer(
  reportId: string,
  idToken: string,
  gmailAccessToken?: string | null
): Promise<{
  reportId: string;
  departmentId: string;
  departmentName: string;
  authorityEmailStatus: AuthorityEmailStatus;
  authorityEmailStatusNote: string;
  authorityEmailSentAtIso?: string;
  citizenNotificationStatus: CitizenNotificationStatus;
}> {
  const result = await authedJsonRequest<{
    reportId: string;
    departmentId: string;
    departmentName: string;
    authorityEmailStatus: AuthorityEmailStatus;
    authorityEmailStatusNote: string;
    authorityEmailSentAtIso?: string;
    citizenNotificationStatus: CitizenNotificationStatus;
  }>(`/api/reports/${encodeURIComponent(reportId)}/notify-authority`, {
    method: 'POST',
    body: {},
    idToken,
    extraHeaders: gmailAccessToken ? { 'X-Gmail-Access-Token': gmailAccessToken } : undefined,
  });
  emitCivicDataChanged('reports');
  return result;
}

export async function seedStarterDepartmentsIfEmpty(_adminUid: string): Promise<void> {
  await authedJsonRequest('/api/admin/departments/seed', {
    method: 'POST',
    body: {},
  });
  emitCivicDataChanged('departments');
}

export async function fetchCitizenContactForAdmin(
  reporterId: string
): Promise<UserPrivateContact | null> {
  if (!reporterId || !/^[a-zA-Z0-9_-]{1,128}$/.test(reporterId)) return null;
  try {
    const data = await authedJsonRequest<{ contact?: UserPrivateContact | null }>(
      `/api/admin/citizens/${encodeURIComponent(reporterId)}/contact`,
      { method: 'GET' }
    );
    return data.contact || null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// Cloudinary Uploads & Gemini AI Endpoints (Preserved)
// ------------------------------------------------------------------

export interface UploadProgressInfo {
  percent: number;
  stage: 'validating' | 'temporary_upload' | 'complete';
  message: string;
}

export type UploadedPhotoResult = TemporaryUploadResult;

interface ServerUploadResponse {
  success?: boolean;
  ok?: boolean;
  uploadId?: string;
  temporaryUploadId?: string;
  temporaryOnly?: boolean;
  retentionNotice?: string;
  expiresAtIso?: string;
  imageUrl?: string;
  url?: string;
  secureUrl?: string;
  publicId?: string;
  fileName?: string;
  storagePath?: string;
  mimeType?: string;
  sizeBytes?: number;
  storageProvider?: 'cloudinary' | 'server_validated';
  uploadedBy?: string;
  uploadedAtIso?: string;
  error?: string;
}

const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const ALLOWED_IMAGE_EXTENSIONS = /\.(jpe?g|png|webp)$/i;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_PHOTOS_PER_REPORT = 5;

function normalizeClientImageMime(file: File): string {
  const raw = String(file.type || '').trim().toLowerCase();
  if (raw === 'image/jpg') return 'image/jpeg';
  if (raw) return raw;
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.webp')) return 'image/webp';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  return '';
}

function isCrossOriginUrl(targetUrl: string): boolean {
  try {
    if (typeof window === 'undefined' || !window.location?.origin) return false;
    return new URL(targetUrl, window.location.origin).origin !== window.location.origin;
  } catch {
    return false;
  }
}

class CookieRedirectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CookieRedirectError';
  }
}

function validateParsedUploadPayload(parsed: any, status: number): ServerUploadResponse {
  if (status < 200 || status >= 300 || parsed?.success === false) {
    throw new Error(parsed?.error || `Image upload failed (HTTP ${status}).`);
  }
  const resolvedImageUrl = parsed?.imageUrl || parsed?.secureUrl || parsed?.url;
  const resolvedPublicId = parsed?.publicId || parsed?.storagePath;
  if (
    typeof resolvedImageUrl !== 'string' ||
    !resolvedImageUrl.startsWith('https://') ||
    typeof resolvedPublicId !== 'string' ||
    !resolvedPublicId.trim()
  ) {
    throw new Error('Upload response did not include a valid Cloudinary imageUrl and publicId.');
  }
  return parsed as ServerUploadResponse;
}

function postMultipartWithProgress(
  url: string,
  formData: FormData,
  idToken: string,
  onUploadPercent: (pct: number) => void
): Promise<ServerUploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.withCredentials = isCrossOriginUrl(url);
    xhr.setRequestHeader('Authorization', `Bearer ${idToken}`);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('X-CivicFix-Client', 'web');
    xhr.timeout = 45000;

    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable && evt.total > 0) {
        onUploadPercent(Math.round((evt.loaded / evt.total) * 100));
      }
    };

    xhr.onload = () => {
      const contentType = (xhr.getResponseHeader('content-type') || '').toLowerCase();
      const bodyText = xhr.responseText || '';
      const trimmed = bodyText.trimStart();
      const responseUrl = xhr.responseURL || '';

      if (
        responseUrl.includes('__cookie_check') ||
        responseUrl.includes('auth-bridge') ||
        bodyText.includes('Cookie check') ||
        bodyText.includes('Action required to load your app')
      ) {
        reject(
          new CookieRedirectError(
            'Upload request was redirected to session cookie verification. Please refresh the page or open the app in a standalone browser tab and try again.'
          )
        );
        return;
      }

      if (xhr.status === 404 && (trimmed.startsWith('<') || !contentType.includes('application/json'))) {
        reject(
          new Error(
            'Upload endpoint not found (HTTP 404). Verify backend POST /api/uploads route is available.'
          )
        );
        return;
      }

      if (xhr.status === 403 && (trimmed.startsWith('<') || !contentType.includes('application/json'))) {
        reject(
          new Error(
            'Upstream preview or deployment gateway returned HTTP 403 HTML for /api/uploads. Open the app URL directly in a standalone browser tab and retry.'
          )
        );
        return;
      }

      if (trimmed.startsWith('<') || !contentType.includes('application/json')) {
        if (xhr.status === 502 || xhr.status === 503 || xhr.status === 504) {
          reject(
            new Error(
              `Upload service is temporarily unavailable (HTTP ${xhr.status}). Please retry in a few seconds.`
            )
          );
          return;
        }
        const titleMatch = bodyText.match(/<title[^>]*>([^<]{1,80})<\/title>/i);
        const htmlHint = titleMatch?.[1]?.trim() ? ` (${titleMatch[1].trim()})` : '';
        reject(
          new Error(
            `Upload endpoint returned non-JSON response (${contentType || 'HTML'}${htmlHint}, HTTP ${xhr.status}).`
          )
        );
        return;
      }

      let parsed: any;
      try {
        parsed = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        reject(new Error(`Server returned unreadable JSON response (HTTP ${xhr.status}).`));
        return;
      }

      try {
        resolve(validateParsedUploadPayload(parsed, xhr.status));
      } catch (err) {
        reject(err);
      }
    };

    xhr.onerror = () => reject(new Error('Network error while uploading photograph to /api/uploads.'));
    xhr.ontimeout = () =>
      reject(new Error('Photograph upload timed out. Please check your connection and retry.'));

    xhr.send(formData);
  });
}

async function postMultipartViaFetch(
  url: string,
  formData: FormData,
  idToken: string
): Promise<ServerUploadResponse> {
  const res = await safeFetchApi(
    url,
    {
      method: 'POST',
      credentials: isCrossOriginUrl(url) ? 'include' : 'same-origin',
      headers: getCivicClientHeaders({
        Authorization: `Bearer ${idToken}`,
      }),
      body: formData,
    },
    '/api/uploads'
  );

  const rawText = await res.text();
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const trimmed = rawText.trimStart();

  if (
    (res.redirected && (res.url.includes('__cookie_check') || res.url.includes('auth-bridge'))) ||
    rawText.includes('Cookie check') ||
    rawText.includes('Action required to load your app')
  ) {
    throw new CookieRedirectError(
      'Preview session cookie verification expired in this embedded frame. Open in a standalone tab or refresh and retry your upload.'
    );
  }

  if (trimmed.startsWith('<') || !contentType.includes('application/json')) {
    const titleMatch = rawText.match(/<title[^>]*>([^<]{1,80})<\/title>/i);
    const htmlHint = titleMatch?.[1]?.trim() ? ` (${titleMatch[1].trim()})` : '';
    throw new Error(
      `Upload endpoint returned non-JSON response (${contentType || 'HTML'}${htmlHint}, HTTP ${res.status}).`
    );
  }

  let parsed: any;
  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch {
    throw new Error(`Server returned unreadable JSON response (HTTP ${res.status}).`);
  }

  return validateParsedUploadPayload(parsed, res.status);
}

export async function uploadValidatedImage(
  file: File,
  idToken: string,
  storageFolder: 'reports' | 'evidence',
  options?: {
    existingCount?: number;
    onProgress?: (progress: UploadProgressInfo) => void;
  }
): Promise<UploadedPhotoResult> {
  const existingCount = options?.existingCount ?? 0;
  if (existingCount >= MAX_PHOTOS_PER_REPORT) {
    throw new Error(`Maximum of ${MAX_PHOTOS_PER_REPORT} photographs per report reached.`);
  }
  const normalizedMime = normalizeClientImageMime(file);
  if (!ALLOWED_IMAGE_MIME_TYPES.includes(normalizedMime) && !ALLOWED_IMAGE_EXTENSIONS.test(file.name)) {
    throw new Error(
      `"${file.name}" has unsupported format (${file.type || 'unknown'}). Only JPG, JPEG, PNG, and WebP images are allowed.`
    );
  }
  if (file.size <= 0) {
    throw new Error(`"${file.name}" is empty (0 bytes).`);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`"${file.name}" exceeds the 5 MB per-image upload limit.`);
  }
  const token = await resolveAccessToken(idToken);

  const reportProgress = options?.onProgress;
  reportProgress?.({
    percent: 10,
    stage: 'validating',
    message: `Validating ${file.name} before Cloudinary upload...`,
  });

  const buildUploadFormData = () => {
    const fd = new FormData();
    fd.append('image', file);
    fd.append('folder', storageFolder);
    fd.append('existingCount', String(existingCount));
    return fd;
  };

  const uploadUrl = buildApiUrl('/api/uploads');
  let serverData: ServerUploadResponse;
  try {
    serverData = await postMultipartWithProgress(
      uploadUrl,
      buildUploadFormData(),
      token,
      (pct) => {
        reportProgress?.({
          percent: Math.min(92, Math.max(15, Math.round(15 + pct * 0.77))),
          stage: 'temporary_upload',
          message: `Uploading ${file.name} to Cloudinary (${pct}%)...`,
        });
      }
    );
  } catch (err) {
    if (err instanceof CookieRedirectError) {
      serverData = await postMultipartViaFetch(uploadUrl, buildUploadFormData(), token);
    } else {
      throw err;
    }
  }

  reportProgress?.({
    percent: 100,
    stage: 'complete',
    message: `${serverData.fileName || file.name} uploaded to Cloudinary.`,
  });

  const resolvedUrl = serverData.imageUrl || serverData.secureUrl || serverData.url || '';
  if (!resolvedUrl.startsWith('https://')) {
    throw new Error('Upload succeeded without a valid HTTPS Cloudinary image URL.');
  }
  const resolvedPublicId = serverData.publicId || serverData.storagePath || '';
  const resolvedProvider: 'cloudinary' | 'server_validated' =
    serverData.storageProvider === 'cloudinary' || resolvedUrl.startsWith('https://res.cloudinary.com/')
      ? 'cloudinary'
      : 'server_validated';
  const resolvedUploadId = serverData.uploadId || serverData.temporaryUploadId || resolvedPublicId;

  return {
    uploadId: resolvedUploadId,
    temporaryOnly: Boolean(serverData.temporaryOnly),
    retentionNotice:
      serverData.retentionNotice ||
      'Uploaded photographs are hosted securely on Cloudinary and processed temporarily in server memory for Gemini AI visual analysis.',
    expiresAtIso: serverData.expiresAtIso,
    url: resolvedUrl,
    publicId: resolvedPublicId || undefined,
    fileName: serverData.fileName || file.name,
    mimeType: serverData.mimeType || normalizedMime || 'image/jpeg',
    sizeBytes: serverData.sizeBytes || file.size,
    storageProvider: resolvedProvider,
    storagePath: serverData.storagePath || resolvedPublicId,
    uploadedBy: serverData.uploadedBy,
    uploadedAtIso: serverData.uploadedAtIso || new Date().toISOString(),
  };
}

export async function deleteTemporaryUpload(uploadId: string, idToken: string): Promise<void> {
  if (!uploadId) return;
  try {
    const token = await resolveAccessToken(idToken);
    await fetch(buildApiUrl(`/api/uploads/${encodeURIComponent(uploadId)}`), {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: getCivicClientHeaders({
        Authorization: `Bearer ${token}`,
      }),
    });
  } catch {
    // Non-blocking cleanup
  }
}

async function prepareImageForAiAnalysis(
  file: File
): Promise<{ blob: Blob; fileName: string }> {
  if (
    typeof document === 'undefined' ||
    typeof Image === 'undefined' ||
    typeof URL === 'undefined'
  ) {
    return { blob: file, fileName: file.name };
  }

  const MAX_ANALYSIS_DIMENSION = 1024;
  const MAX_DIRECT_BYTES = 350 * 1024;

  let objectUrl = '';
  try {
    objectUrl = URL.createObjectURL(file);
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('Image decode failed'));
      element.src = objectUrl;
    });

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (
      width > 0 &&
      height > 0 &&
      width <= MAX_ANALYSIS_DIMENSION &&
      height <= MAX_ANALYSIS_DIMENSION &&
      file.size <= MAX_DIRECT_BYTES
    ) {
      return { blob: file, fileName: file.name };
    }

    const scale = Math.min(1, MAX_ANALYSIS_DIMENSION / Math.max(width || 1, height || 1));
    const targetWidth = Math.max(1, Math.round((width || MAX_ANALYSIS_DIMENSION) * scale));
    const targetHeight = Math.max(1, Math.round((height || MAX_ANALYSIS_DIMENSION) * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { blob: file, fileName: file.name };
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetWidth, targetHeight);
    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

    const compressedBlob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.8);
    });

    if (compressedBlob && compressedBlob.size > 0 && compressedBlob.size < file.size) {
      const baseName = file.name.replace(/\.[^.]+$/, '') || 'civic-photo';
      return { blob: compressedBlob, fileName: `${baseName}-analysis.jpg` };
    }
    return { blob: file, fileName: file.name };
  } catch {
    return { blob: file, fileName: file.name };
  } finally {
    if (objectUrl) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // ignore
      }
    }
  }
}

export async function analyzeImageViaServer(
  file: File | null,
  uploadId: string | null,
  idToken: string,
  userHint?: string
): Promise<AiPhotoAssessmentResult> {
  const token = await resolveAccessToken(idToken);
  const prepared = file ? await prepareImageForAiAnalysis(file) : null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 75_000);
  let response: Response;

  try {
    if (prepared) {
      const formData = new FormData();
      formData.append('image', prepared.blob, prepared.fileName);
      if (uploadId) formData.append('uploadId', uploadId);
      if (userHint) formData.append('userHint', userHint);
      response = await safeFetchApi(
        buildApiUrl('/api/ai/analyze-image'),
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: getCivicClientHeaders({
            Authorization: `Bearer ${token}`,
          }),
          body: formData,
          signal: controller.signal,
        },
        '/api/ai/analyze-image'
      );
    } else if (uploadId) {
      response = await safeFetchApi(
        buildApiUrl('/api/ai/analyze-image'),
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: getCivicClientHeaders({
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({ uploadId, userHint }),
          signal: controller.signal,
        },
        '/api/ai/analyze-image'
      );
    } else {
      throw new Error('An image file or temporary upload ID is required for AI analysis.');
    }
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('AI image analysis timed out after 75 seconds. Please try again.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  const parsed = await parseJsonResponse<AiPhotoAssessmentResult>(response, '/api/ai/analyze-image');
  if (
    !parsed.factualDescription ||
    typeof parsed.factualDescription !== 'string' ||
    !parsed.suggestedCategory ||
    !parsed.suggestedPriority
  ) {
    throw new Error('Invalid AI analysis response: missing required visual assessment fields.');
  }
  return {
    ...parsed,
    visibleEvidence: Array.isArray(parsed.visibleEvidence) ? parsed.visibleEvidence : [],
  };
}

export async function detectDuplicatesViaServer(
  params: {
    reportId?: string;
    title: string;
    description: string;
    aiDescription?: string;
    category: IssueCategory;
    latitude: number;
    longitude: number;
    createdAtIso?: string;
  },
  idToken: string
): Promise<{ advisoryOnly: boolean; scope: string; candidates: DuplicateCandidate[] }> {
  return authedJsonRequest('/api/ai/detect-duplicates', {
    method: 'POST',
    body: params,
    idToken,
  });
}

export async function generateTrendIntelligenceViaServer(
  digest: AnonymizedTrendDigest,
  idToken: string
): Promise<TrendIntelligenceResult> {
  return authedJsonRequest('/api/ai/trend-intelligence', {
    method: 'POST',
    body: digest,
    idToken,
  });
}

// ------------------------------------------------------------------
// Public Transparency & Tracking ID (Zero PII)
// ------------------------------------------------------------------

export async function syncMissingPublicReports(_reports: CivicReport[]): Promise<number> {
  const data = await authedJsonRequest<{ synced?: number }>('/api/admin/public-reports/sync', {
    method: 'POST',
    body: {},
  });
  return typeof data.synced === 'number' ? data.synced : 0;
}

export function computePublicTransparencyOverview(
  publicReports: PublicReportSummary[],
  publicActivities: PublicCivicActivity[] = []
): PublicTransparencyOverview {
  const totalSubmitted = publicReports.length;
  const underReview = publicReports.filter(
    (r) => r.status === 'submitted' || r.status === 'under_review' || r.status === 'reopened'
  ).length;
  const inProgress = publicReports.filter(
    (r) => r.status === 'verified' || r.status === 'assigned' || r.status === 'in_progress'
  ).length;
  const resolved = publicReports.filter(
    (r) => r.status === 'resolved' || r.status === 'citizen_confirmed'
  ).length;
  const rejected = publicReports.filter((r) => r.status === 'rejected').length;

  const allHoursSamples: number[] = [];
  const deptMap = new Map<
    string,
    {
      departmentId: string;
      departmentName: string;
      departmentCode: string;
      total: number;
      underReview: number;
      inProgress: number;
      resolved: number;
      hoursSamples: number[];
    }
  >();

  for (const d of CANONICAL_STARTER_DEPARTMENTS) {
    deptMap.set(d.id, {
      departmentId: d.id,
      departmentName: d.name,
      departmentCode: d.code,
      total: 0,
      underReview: 0,
      inProgress: 0,
      resolved: 0,
      hoursSamples: [],
    });
  }

  for (const r of publicReports) {
    if (!r.departmentId) continue;
    let bucket = deptMap.get(r.departmentId);
    if (!bucket) {
      bucket = {
        departmentId: r.departmentId,
        departmentName: r.departmentName || r.departmentId,
        departmentCode: (r.departmentName || r.departmentId).slice(0, 6).toUpperCase(),
        total: 0,
        underReview: 0,
        inProgress: 0,
        resolved: 0,
        hoursSamples: [],
      };
      deptMap.set(r.departmentId, bucket);
    }
    bucket.total += 1;
    if (r.status === 'submitted' || r.status === 'under_review' || r.status === 'reopened') {
      bucket.underReview += 1;
    } else if (r.status === 'verified' || r.status === 'assigned' || r.status === 'in_progress') {
      bucket.inProgress += 1;
    } else if (r.status === 'resolved' || r.status === 'citizen_confirmed') {
      bucket.resolved += 1;
      const startMs = r.createdAtIso ? Date.parse(r.createdAtIso) : toTimestampMs(r.createdAt);
      const endMs = r.supervisorVerifiedAtIso
        ? Date.parse(r.supervisorVerifiedAtIso)
        : r.completedAtIso
          ? Date.parse(r.completedAtIso)
          : r.updatedAtIso
            ? Date.parse(r.updatedAtIso)
            : toTimestampMs(r.updatedAt);
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs > 0 && endMs >= startMs) {
        const hrs = (endMs - startMs) / (1000 * 60 * 60);
        bucket.hoursSamples.push(hrs);
        allHoursSamples.push(hrs);
      }
    }
  }

  const overallAvgResolutionHours =
    allHoursSamples.length > 0
      ? Number((allHoursSamples.reduce((a, b) => a + b, 0) / allHoursSamples.length).toFixed(1))
      : null;

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const now = new Date();
  const monthlyMap = new Map<string, PublicMonthlyTrend>();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
    monthlyMap.set(key, { key, label, submitted: 0, resolved: 0 });
  }
  for (const r of publicReports) {
    const createdMs = r.createdAtIso ? Date.parse(r.createdAtIso) : toTimestampMs(r.createdAt);
    if (createdMs > 0) {
      const cd = new Date(createdMs);
      const cKey = `${cd.getFullYear()}-${String(cd.getMonth() + 1).padStart(2, '0')}`;
      const m = monthlyMap.get(cKey);
      if (m) m.submitted += 1;
    }
    if (r.status === 'resolved' || r.status === 'citizen_confirmed') {
      const resMs = r.supervisorVerifiedAtIso
        ? Date.parse(r.supervisorVerifiedAtIso)
        : r.completedAtIso
          ? Date.parse(r.completedAtIso)
          : r.updatedAtIso
            ? Date.parse(r.updatedAtIso)
            : toTimestampMs(r.updatedAt);
      if (resMs > 0) {
        const rd = new Date(resMs);
        const rKey = `${rd.getFullYear()}-${String(rd.getMonth() + 1).padStart(2, '0')}`;
        const m = monthlyMap.get(rKey);
        if (m) m.resolved += 1;
      }
    }
  }

  const recentPublicUpdates: PublicUpdateDigestItem[] = [];
  for (const r of publicReports) {
    const events = Array.isArray(r.timelineEvents) ? r.timelineEvents : [];
    const fallbackIso =
      r.updatedAtIso ||
      (toTimestampMs(r.updatedAt) ? new Date(toTimestampMs(r.updatedAt)).toISOString() : new Date().toISOString());
    if (events.length > 0) {
      const latest = events[events.length - 1];
      recentPublicUpdates.push({
        reportId: r.id,
        trackingCode: r.trackingCode,
        title: r.title,
        category: r.category,
        departmentName: r.departmentName || 'Municipal Team',
        areaLabel: r.areaLabel,
        status: r.status,
        stage: latest.stage,
        timestampIso: latest.timestampIso || fallbackIso,
        summary: latest.summary,
      });
    } else {
      recentPublicUpdates.push({
        reportId: r.id,
        trackingCode: r.trackingCode,
        title: r.title,
        category: r.category,
        departmentName: r.departmentName || 'Municipal Team',
        areaLabel: r.areaLabel,
        status: r.status,
        stage: r.status,
        timestampIso: fallbackIso,
        summary: `Complaint currently at stage: ${r.status.replace(/_/g, ' ')}.`,
      });
    }
  }
  recentPublicUpdates.sort((a, b) => Date.parse(b.timestampIso) - Date.parse(a.timestampIso));

  const departmentPerformance: PublicDepartmentPerformance[] = Array.from(deptMap.values()).map((d) => ({
    departmentId: d.departmentId,
    departmentName: d.departmentName,
    departmentCode: d.departmentCode,
    total: d.total,
    underReview: d.underReview,
    inProgress: d.inProgress,
    resolved: d.resolved,
    resolutionRatePct: d.total > 0 ? Math.round((d.resolved / d.total) * 100) : null,
    avgResolutionHours:
      d.hoursSamples.length > 0
        ? Number((d.hoursSamples.reduce((a, b) => a + b, 0) / d.hoursSamples.length).toFixed(1))
        : null,
  }));

  const sortedHistory = [...publicReports]
    .filter((r) => r.status === 'resolved' || r.status === 'citizen_confirmed')
    .sort((a, b) => {
      const aMs = a.updatedAtIso ? Date.parse(a.updatedAtIso) : toTimestampMs(a.updatedAt);
      const bMs = b.updatedAtIso ? Date.parse(b.updatedAtIso) : toTimestampMs(b.updatedAt);
      return bMs - aMs;
    })
    .slice(0, 25);

  return {
    totalSubmitted,
    underReview,
    inProgress,
    resolved,
    rejected,
    overallAvgResolutionHours,
    monthlyTrends: Array.from(monthlyMap.values()),
    recentPublicUpdates: recentPublicUpdates.slice(0, 12),
    publicActivities: publicActivities.slice(0, 12),
    departmentPerformance,
    resolutionHistory: sortedHistory,
    generatedAtIso: new Date().toISOString(),
  };
}

export async function fetchPublicTransparencyViaApi(): Promise<PublicTransparencyOverview> {
  const res = await safeFetchApi(
    buildApiUrl('/api/public/transparency'),
    {
      method: 'GET',
      credentials: 'same-origin',
      headers: getCivicClientHeaders(),
    },
    '/api/public/transparency'
  );
  return parseJsonResponse<PublicTransparencyOverview>(res, '/api/public/transparency');
}

export async function trackPublicReportByCode(
  trackingCode: string
): Promise<PublicReportSummary | null> {
  const cleanCode = trackingCode.trim().toUpperCase().slice(0, 32);
  if (!/^[A-Z0-9-]{4,32}$/.test(cleanCode)) {
    throw new Error('Please enter a valid Tracking ID (for example, CF-2026-123456).');
  }

  const res = await safeFetchApi(
    buildApiUrl(`/api/public/track/${encodeURIComponent(cleanCode)}`),
    {
      method: 'GET',
      credentials: 'same-origin',
      headers: getCivicClientHeaders(),
    },
    `/api/public/track/${cleanCode}`
  );
  if (res.status === 404) {
    return null;
  }
  const data = await parseJsonResponse<{ report?: PublicReportSummary }>(
    res,
    `/api/public/track/${cleanCode}`
  );
  return data.report || null;
}

// ------------------------------------------------------------------
// Report Creation & Server-Authoritative Workflow Operations
// ------------------------------------------------------------------

export async function createCivicReport(params: {
  reporter: UserProfile;
  title: string;
  description: string;
  category: IssueCategory;
  priority: IssuePriority;
  addressText: string;
  wardOrZone: string;
  latitude: number;
  longitude: number;
  imageUrls: string[];
  imageMetadata?: UploadedImageMetadata[];
  uploadIds?: string[];
  aiAssessment: AiPhotoAssessmentResult | null;
  departments?: Department[];
  idToken?: string;
  gmailAccessToken?: string | null;
  idempotencyKey?: string;
}): Promise<{
  reportId: string;
  trackingCode: string;
  departmentId: string;
  departmentName: string;
  authorityEmailStatus: AuthorityEmailStatus;
  authorityEmailStatusNote: string;
  citizenNotificationStatus: CitizenNotificationStatus;
  citizenEmailSent?: boolean;
  citizenEmailNote?: string;
}> {
  const token = await resolveAccessToken(params.idToken);

  const safeLat = Number.isFinite(params.latitude) ? Math.max(-90, Math.min(90, params.latitude)) : 0;
  const safeLng = Number.isFinite(params.longitude) ? Math.max(-180, Math.min(180, params.longitude)) : 0;
  const uploadIds = Array.isArray(params.uploadIds)
    ? params.uploadIds.filter((id) => typeof id === 'string' && id.trim().length > 0).slice(0, MAX_PHOTOS_PER_REPORT)
    : [];

  const data = await authedJsonRequest<{
    reportId?: string;
    trackingCode?: string;
    departmentId?: string;
    departmentName?: string;
    authorityEmailStatus?: AuthorityEmailStatus;
    authorityEmailStatusNote?: string;
    citizenNotificationStatus?: CitizenNotificationStatus;
    citizenEmailSent?: boolean;
    citizenEmailNote?: string;
  }>('/api/reports', {
    method: 'POST',
    idToken: token,
    extraHeaders: params.gmailAccessToken
      ? { 'X-Gmail-Access-Token': params.gmailAccessToken }
      : undefined,
    body: {
      title: sanitizeString(params.title, 160),
      description: sanitizeString(params.description, 2000),
      category: params.category,
      addressText: sanitizeString(params.addressText, 240),
      wardOrZone: sanitizeString(params.wardOrZone || '', 80),
      latitude: safeLat,
      longitude: safeLng,
      uploadIds,
      analysisToken: params.aiAssessment?.analysisToken || '',
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    },
  });

  if (!data.reportId || !data.trackingCode) {
    throw new Error('Server did not return a valid report ID and tracking code.');
  }

  emitCivicDataChanged('reports');

  return {
    reportId: data.reportId,
    trackingCode: data.trackingCode,
    departmentId:
      data.departmentId || resolveDepartmentForCategory(params.category, params.departments).departmentId,
    departmentName:
      data.departmentName || resolveDepartmentForCategory(params.category, params.departments).departmentName,
    authorityEmailStatus: data.authorityEmailStatus || 'pending',
    authorityEmailStatusNote:
      data.authorityEmailStatusNote || 'Queued for department authority routing.',
    citizenNotificationStatus: data.citizenNotificationStatus || 'sent',
    citizenEmailSent: Boolean(data.citizenEmailSent),
    citizenEmailNote: data.citizenEmailNote,
  };
}

async function postWorkflowAction(
  reportId: string,
  payload: Record<string, any>,
  idToken?: string
): Promise<void> {
  await authedJsonRequest(`/api/reports/${encodeURIComponent(reportId)}/workflow`, {
    method: 'POST',
    body: payload,
    idToken,
  });
  emitCivicDataChanged('reports');
}

export async function adminTransitionToUnderReview(
  report: CivicReport,
  _actor: UserProfile,
  idToken: string
): Promise<void> {
  await postWorkflowAction(report.id, { action: 'under_review' }, idToken);
}

export async function adminRequestMoreInformation(params: {
  report: CivicReport;
  actor: UserProfile;
  reason: string;
  idToken: string;
}): Promise<void> {
  await postWorkflowAction(
    params.report.id,
    {
      action: 'request_more_info',
      reason: sanitizeString(params.reason, 600),
    },
    params.idToken
  );
}

export async function citizenProvideAdditionalInfo(params: {
  report: CivicReport;
  citizen: UserProfile;
  clarification: string;
  idToken: string;
}): Promise<void> {
  await postWorkflowAction(
    params.report.id,
    {
      action: 'citizen_clarification',
      clarification: sanitizeString(params.clarification, 800),
    },
    params.idToken
  );
}

export async function adminVerifyReport(params: {
  report: CivicReport;
  actor: UserProfile;
  categoryOverride?: IssueCategory;
  priorityOverride?: IssuePriority;
  verificationNote?: string;
  idToken: string;
}): Promise<void> {
  await postWorkflowAction(
    params.report.id,
    {
      action: 'verify',
      categoryOverride: params.categoryOverride,
      priorityOverride: params.priorityOverride,
      verificationNote: params.verificationNote,
    },
    params.idToken
  );
}

export async function adminVerifyAndAssignDepartment(params: {
  report: CivicReport;
  department: Department;
  assignedOfficer?: UserProfile | null;
  actor: UserProfile;
  categoryOverride?: IssueCategory;
  priorityOverride?: IssuePriority;
  instructions: string;
  idToken: string;
}): Promise<void> {
  await postWorkflowAction(
    params.report.id,
    {
      action: 'assign_department',
      departmentId: params.department.id,
      assignedOfficerId: params.assignedOfficer?.uid || undefined,
      categoryOverride: params.categoryOverride,
      priorityOverride: params.priorityOverride,
      instructions: params.instructions,
    },
    params.idToken
  );
}

export async function officerAssignWorker(params: {
  report: CivicReport;
  worker: UserProfile;
  actor: UserProfile;
  instructions: string;
  priorityOverride?: IssuePriority;
  deadlineIso?: string;
  supervisor?: UserProfile | null;
  reassignmentReason?: string;
  expectedWorkerId?: string;
  recommendationScore?: number;
  recommendationReason?: string;
  idToken: string;
}): Promise<void> {
  await postWorkflowAction(
    params.report.id,
    {
      action: 'assign_worker',
      workerId: params.worker.uid,
      instructions: params.instructions,
      priorityOverride: params.priorityOverride,
      deadlineIso: params.deadlineIso,
      supervisorId: params.supervisor?.uid || undefined,
      supervisorName: params.supervisor?.displayName || undefined,
      reassignmentReason: params.reassignmentReason,
      expectedWorkerId: params.expectedWorkerId,
      recommendationScore: params.recommendationScore,
      recommendationReason: params.recommendationReason,
    },
    params.idToken
  );
}

export async function workerAcknowledgeTask(params: {
  report: CivicReport;
  actor: UserProfile;
  idToken: string;
}): Promise<void> {
  await postWorkflowAction(params.report.id, { action: 'worker_acknowledge' }, params.idToken);
}

export async function workerSubmitFieldUpdate(params: {
  report: CivicReport;
  actor: UserProfile;
  mode: 'progress' | 'obstacle' | 'ready_for_verification';
  workNote: string;
  workStartedAtIso?: string;
  completedAtIso?: string;
  materialsUsed?: string;
  obstaclesEncountered?: string;
  delayExplanation?: string;
  clearActiveObstacle?: boolean;
  workerCheckInLabel?: string;
  workerCheckInLat?: number;
  workerCheckInLng?: number;
  resolutionImageUrls?: string[];
  resolutionImageMetadata?: UploadedImageMetadata[];
  idToken: string;
}): Promise<void> {
  await postWorkflowAction(
    params.report.id,
    {
      action: 'worker_field_update',
      mode: params.mode,
      workNote: params.workNote,
      workStartedAtIso: params.workStartedAtIso,
      completedAtIso: params.completedAtIso,
      materialsUsed: params.materialsUsed,
      obstaclesEncountered: params.obstaclesEncountered,
      delayExplanation: params.delayExplanation,
      clearActiveObstacle: params.clearActiveObstacle,
      workerCheckInLabel: params.workerCheckInLabel,
      workerCheckInLat: params.workerCheckInLat,
      workerCheckInLng: params.workerCheckInLng,
      resolutionImageUrls: params.resolutionImageUrls,
      resolutionImageMetadata: params.resolutionImageMetadata,
    },
    params.idToken
  );
}

export async function workerUpdateTaskStatus(params: {
  report: CivicReport;
  actor: UserProfile;
  nextStatus: 'in_progress' | 'resolved';
  workNote: string;
  resolutionImageUrls?: string[];
  resolutionImageMetadata?: UploadedImageMetadata[];
  idToken: string;
}): Promise<void> {
  return workerSubmitFieldUpdate({
    report: params.report,
    actor: params.actor,
    mode: params.nextStatus === 'resolved' ? 'ready_for_verification' : 'progress',
    workNote: params.workNote,
    resolutionImageUrls: params.resolutionImageUrls,
    resolutionImageMetadata: params.resolutionImageMetadata,
    idToken: params.idToken,
  });
}

export async function workerRequestSupervisorAssistance(params: {
  report: CivicReport;
  actor: UserProfile;
  note: string;
  idToken: string;
}): Promise<void> {
  await postWorkflowAction(
    params.report.id,
    {
      action: 'worker_request_assistance',
      note: params.note,
    },
    params.idToken
  );
}

export async function workerUpdateLocationSharing(params: {
  assignmentId: string;
  active: boolean;
  lat?: number;
  lng?: number;
}): Promise<void> {
  await authedJsonRequest(`/api/assignments/${encodeURIComponent(params.assignmentId)}/location`, {
    method: 'POST',
    body: {
      active: Boolean(params.active),
      lat: params.lat,
      lng: params.lng,
    },
  });
  emitCivicDataChanged('assignments');
}

export async function staffReviewResolutionEvidence(params: {
  report: CivicReport;
  actor: UserProfile;
  decision: 'approve' | 'reject_evidence' | 'return_in_progress';
  reason: string;
  idToken: string;
}): Promise<void> {
  await postWorkflowAction(
    params.report.id,
    {
      action: 'review_evidence',
      decision: params.decision,
      reason: params.reason,
    },
    params.idToken
  );
}

export async function staffRejectReport(params: {
  report: CivicReport;
  actor: UserProfile;
  reason: string;
  idToken: string;
}): Promise<void> {
  await postWorkflowAction(
    params.report.id,
    {
      action: 'reject',
      reason: params.reason,
    },
    params.idToken
  );
}

export async function citizenConfirmOrReopenReport(params: {
  report: CivicReport;
  citizen: UserProfile;
  outcome: 'confirmed' | 'reopened';
  comment?: string;
  idToken: string;
}): Promise<void> {
  await postWorkflowAction(
    params.report.id,
    {
      action: 'citizen_confirm_or_reopen',
      outcome: params.outcome,
      comment: params.comment || '',
    },
    params.idToken
  );
}

export async function submitCitizenFeedback(params: {
  report: CivicReport;
  citizen: UserProfile;
  rating: number;
  comment: string;
  idToken: string;
}): Promise<void> {
  await postWorkflowAction(
    params.report.id,
    {
      action: 'submit_feedback',
      rating: params.rating,
      comment: params.comment,
    },
    params.idToken
  );
}

export async function adminSaveDepartment(params: {
  id?: string;
  name: string;
  code: string;
  description: string;
  categories: IssueCategory[];
  officerIds: string[];
  active: boolean;
}): Promise<void> {
  await authedJsonRequest('/api/admin/departments', {
    method: 'POST',
    body: params,
  });
  emitCivicDataChanged('departments');
}

export async function adminUpdateUserRole(params: {
  targetUser: UserProfile;
  role: UserRole;
  departmentId: string;
  active: boolean;
  idToken: string;
}): Promise<UserProfile> {
  const data = await authedJsonRequest<{ user?: UserProfile; error?: string }>(
    `/api/admin/users/${encodeURIComponent(params.targetUser.uid)}/role`,
    {
      method: 'POST',
      idToken: params.idToken,
      body: {
        role: params.role,
        departmentId: params.departmentId,
        active: params.active,
      },
    }
  );
  if (!data.user) {
    throw new Error(data.error || 'Role update failed.');
  }
  emitCivicDataChanged('users');
  return data.user;
}

export async function attachAiAnalysisToReport(
  report: CivicReport,
  assessment: AiPhotoAssessmentResult,
  idToken?: string
): Promise<string> {
  if (!assessment.analysisToken) {
    throw new Error('Verified AI analysis token missing. Please re-analyze the photograph.');
  }
  const data = await authedJsonRequest<{ analysisId?: string }>(
    `/api/reports/${encodeURIComponent(report.id)}/ai-analysis`,
    {
      method: 'POST',
      idToken,
      body: {
        analysisToken: assessment.analysisToken,
      },
    }
  );
  if (!data.analysisId) {
    throw new Error('Backend did not return an AI analysis ID.');
  }
  emitCivicDataChanged('reports');
  return data.analysisId;
}

export async function markNotificationRead(notificationId: string): Promise<void> {
  await authedJsonRequest('/api/notifications/read', {
    method: 'POST',
    body: { notificationIds: [notificationId] },
  });
  emitCivicDataChanged('notifications');
}

export async function markAllNotificationsRead(notificationIds: string[]): Promise<void> {
  const uniqueIds = Array.from(new Set(notificationIds.filter(Boolean)));
  if (uniqueIds.length === 0) return;
  await authedJsonRequest('/api/notifications/read', {
    method: 'POST',
    body: { notificationIds: uniqueIds },
  });
  emitCivicDataChanged('notifications');
}

// ------------------------------------------------------------------
// Workforce, SLA Policies, Escalation & Alert Services
// ------------------------------------------------------------------

export async function adminRegisterWorkerInvite(params: {
  email: string;
  displayName: string;
  role: 'worker' | 'officer';
  departmentId: string;
  workZone?: string;
  employeeId?: string;
  supervisorId?: string;
  supervisorName?: string;
  availabilityStatus?: WorkerAvailabilityStatus;
  idToken: string;
}): Promise<WorkerInvite> {
  const data = await authedJsonRequest<{ invite?: WorkerInvite; error?: string }>(
    '/api/admin/workers/invite',
    {
      method: 'POST',
      idToken: params.idToken,
      body: {
        email: params.email,
        displayName: params.displayName,
        role: params.role,
        departmentId: params.departmentId,
        workZone: params.workZone || '',
        employeeId: params.employeeId || '',
        supervisorId: params.supervisorId || '',
        supervisorName: params.supervisorName || '',
        availabilityStatus: params.availabilityStatus || 'available',
      },
    }
  );
  if (!data.invite) {
    throw new Error(data.error || 'Failed to register authorized field worker.');
  }
  emitCivicDataChanged('worker_invites');
  return data.invite;
}

export async function updateWorkerAvailability(params: {
  targetUid: string;
  availabilityStatus?: WorkerAvailabilityStatus;
  availabilityNote?: string;
  workZone?: string;
  employeeId?: string;
  supervisorId?: string;
  supervisorName?: string;
  maxActiveTasks?: number;
  departmentId?: string;
  idToken: string;
}): Promise<UserProfile> {
  const data = await authedJsonRequest<{ user?: UserProfile; error?: string }>(
    `/api/workers/${encodeURIComponent(params.targetUid)}/availability`,
    {
      method: 'POST',
      idToken: params.idToken,
      body: {
        availabilityStatus: params.availabilityStatus,
        availabilityNote: params.availabilityNote,
        workZone: params.workZone,
        employeeId: params.employeeId,
        supervisorId: params.supervisorId,
        supervisorName: params.supervisorName,
        maxActiveTasks: params.maxActiveTasks,
        departmentId: params.departmentId,
      },
    }
  );
  if (!data.user) {
    throw new Error(data.error || 'Failed to update worker availability.');
  }
  emitCivicDataChanged('users');
  return data.user;
}

export async function saveSlaPolicy(params: {
  scopeType: SlaScopeType;
  departmentId: string;
  departmentName?: string;
  category: IssueCategory | '';
  ackTargetHours: number;
  assignTargetHours: number;
  resolveTargetHours: number;
  escalationRole: 'officer' | 'admin';
  actorUid: string;
}): Promise<string> {
  const data = await authedJsonRequest<{ policyId?: string }>('/api/admin/sla-policies', {
    method: 'POST',
    body: {
      scopeType: params.scopeType,
      departmentId: params.departmentId,
      departmentName: params.departmentName || '',
      category: params.category,
      ackTargetHours: params.ackTargetHours,
      assignTargetHours: params.assignTargetHours,
      resolveTargetHours: params.resolveTargetHours,
      escalationRole: params.escalationRole,
    },
  });
  emitCivicDataChanged('sla_policies');
  return data.policyId || 'sla_global';
}

export async function escalateOverdueReport(params: {
  report: CivicReport;
  actor: UserProfile;
  supervisor: UserProfile | null;
  reason: string;
  idToken: string;
}): Promise<void> {
  await postWorkflowAction(
    params.report.id,
    {
      action: 'escalate_overdue',
      supervisorId: params.supervisor?.uid || undefined,
      supervisorName: params.supervisor?.displayName || undefined,
      reason: params.reason,
    },
    params.idToken
  );
}

export async function syncOperationalAlertsAndEscalations(params: {
  candidates: OperationalAlertCandidate[];
  existingAlerts: OperationalAlertRecord[];
}): Promise<number> {
  const existingKeys = new Set(params.existingAlerts.map((a) => a.id));
  const missing = params.candidates.filter(
    (c) => !existingKeys.has(c.alertKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120))
  );
  if (missing.length === 0) return 0;

  const data = await authedJsonRequest<{ created?: number }>('/api/operational-alerts/sync', {
    method: 'POST',
    body: { candidates: missing },
  });
  if ((data.created || 0) > 0) {
    emitCivicDataChanged('operational_alerts');
  }
  return typeof data.created === 'number' ? data.created : 0;
}

export async function acknowledgeOperationalAlert(alertId: string): Promise<void> {
  await authedJsonRequest(`/api/operational-alerts/${encodeURIComponent(alertId)}/acknowledge`, {
    method: 'POST',
    body: {},
  });
  emitCivicDataChanged('operational_alerts');
}

// ------------------------------------------------------------------
// NGO & Volunteer Community Participation Operations
// ------------------------------------------------------------------

export async function registerNgoOrganization(params: {
  owner: UserProfile;
  name: string;
  registrationNumber: string;
  focusAreas: string[];
  operatingCityOrWard: string;
  description: string;
  contactEmail: string;
  contactPhone?: string;
}): Promise<string> {
  const data = await authedJsonRequest<{ ngoId?: string }>('/api/ngos', {
    method: 'POST',
    body: {
      name: params.name,
      registrationNumber: params.registrationNumber,
      focusAreas: params.focusAreas,
      operatingCityOrWard: params.operatingCityOrWard,
      description: params.description,
      contactEmail: params.contactEmail,
      contactPhone: params.contactPhone || '',
    },
  });
  emitCivicDataChanged('ngo_organizations');
  return data.ngoId || '';
}

export async function reviewNgoOrganization(params: {
  ngo: NgoOrganization;
  admin: UserProfile;
  decision: 'approved' | 'rejected';
  reviewNote: string;
}): Promise<void> {
  await authedJsonRequest(`/api/ngos/${encodeURIComponent(params.ngo.id)}/review`, {
    method: 'POST',
    body: {
      decision: params.decision,
      reviewNote: params.reviewNote,
    },
  });
  emitCivicDataChanged('ngo_organizations');
}

export async function upsertVolunteerProfile(params: {
  user: UserProfile;
  existingProfile: VolunteerProfile | null;
  skills: string[];
  serviceArea: string;
  availability: string;
  active: boolean;
}): Promise<void> {
  await authedJsonRequest('/api/volunteer-profile', {
    method: 'PUT',
    body: {
      skills: params.skills,
      serviceArea: params.serviceArea,
      availability: params.availability,
      active: params.active,
    },
  });
  emitCivicDataChanged('volunteer_profiles');
}

export async function publishCivicActivity(params: {
  ngo: NgoOrganization;
  actor: UserProfile;
  title: string;
  description: string;
  category: ActivityCategory;
  locationLabel: string;
  wardOrZone?: string;
  scheduledDateIso: string;
  maxVolunteers: number;
  relatedReportId?: string;
}): Promise<string> {
  const data = await authedJsonRequest<{ activityId?: string }>('/api/activities', {
    method: 'POST',
    body: {
      ngoId: params.ngo.id,
      title: params.title,
      description: params.description,
      category: params.category,
      locationLabel: params.locationLabel,
      wardOrZone: params.wardOrZone || '',
      scheduledDateIso: params.scheduledDateIso,
      maxVolunteers: params.maxVolunteers,
      relatedReportId: params.relatedReportId || '',
    },
  });
  emitCivicDataChanged('civic_activities');
  return data.activityId || '';
}

export async function reviewCivicActivity(params: {
  activity: CivicActivity;
  admin: UserProfile;
  decision: 'approved' | 'rejected';
  reviewNote: string;
}): Promise<void> {
  await authedJsonRequest(`/api/activities/${encodeURIComponent(params.activity.id)}/review`, {
    method: 'POST',
    body: {
      decision: params.decision,
      reviewNote: params.reviewNote,
    },
  });
  emitCivicDataChanged('civic_activities');
}

export async function submitCivicActivityCompletion(params: {
  activity: CivicActivity;
  completionSummary: string;
  completionPhotoMetadata: UploadedImageMetadata[];
}): Promise<void> {
  await authedJsonRequest(`/api/activities/${encodeURIComponent(params.activity.id)}/complete`, {
    method: 'POST',
    body: {
      completionSummary: params.completionSummary,
      completionPhotoMetadata: params.completionPhotoMetadata,
    },
  });
  emitCivicDataChanged('civic_activities');
}

export async function joinCivicActivity(params: {
  activity: CivicActivity;
  user: UserProfile;
  volunteerProfile: VolunteerProfile | null;
  note?: string;
}): Promise<void> {
  await authedJsonRequest(`/api/activities/${encodeURIComponent(params.activity.id)}/join`, {
    method: 'POST',
    body: { note: params.note || '' },
  });
  emitCivicDataChanged('civic_activities');
}

export async function withdrawFromCivicActivity(params: {
  activity: CivicActivity;
  user: UserProfile;
}): Promise<void> {
  await authedJsonRequest(`/api/activities/${encodeURIComponent(params.activity.id)}/withdraw`, {
    method: 'POST',
    body: {},
  });
  emitCivicDataChanged('civic_activities');
}
