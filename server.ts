import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import {
  CANONICAL_STARTER_DEPARTMENTS,
  attachVerifiedAiAnalysisServerSide,
  createVerifiedCivicReportServerSide,
  requireAuth,
  requireRole,
  fetchAccessibleReportsForDuplicates,
  fetchAccessibleReportsForUser,
  fetchPublicActivitiesFromSupabase,
  fetchPublicReportByTrackingCodeFromSupabase,
  fetchPublicReportsFromSupabase,
  fetchSingleReportForUser,
  initializeUserAndBootstrapAdmin,
  listDepartmentEmailSettingsForAdmin,
  processReportAuthorityEmailRouting,
  registerWorkerInviteAsAdmin,
  resolveTargetDepartmentForCategory,
  saveDepartmentEmailSettingAsAdmin,
  updateUserRoleAsAdmin,
  updateWorkerOperationalProfile,
  verifyReportTransitionAuthorization,
  type AuthenticatedRequest,
  type UserRole,
  type VerifiedUploadMetadataInput,
  type WorkerAvailabilityStatus,
} from './server/supabaseAuth.ts';
import {
  analyzeCivicIssueImage,
  analyzeMunicipalTrendsWithGemini,
  refineDuplicateMatchWithGemini,
  type CivicImageAssessment,
} from './server/geminiService.ts';
import { getEmailTransportStatus, sendTestAuthorityEmail } from './server/emailService.ts';
import {
  deleteCloudinaryAsset,
  fetchCloudinaryImageBuffer,
  isCloudinaryConfigured,
  uploadImageBufferToCloudinary,
} from './server/cloudinaryService.ts';
import { isSupabaseServerConfigured } from './supabaseClient.ts';
import {
  acknowledgeOperationalAlertSupabase,
  adminSaveDepartmentSupabase,
  ensureCanonicalDepartmentsExist,
  executeReportWorkflowActionSupabase,
  fetchCitizenContactForAdminSupabase,
  fetchReportDetailBundleSupabase,
  fetchWorkspaceSnapshotSupabase,
  joinCivicActivitySupabase,
  markNotificationsReadSupabase,
  publishCivicActivitySupabase,
  registerNgoOrganizationSupabase,
  reviewCivicActivitySupabase,
  reviewNgoOrganizationSupabase,
  saveSlaPolicySupabase,
  submitCivicActivityCompletionSupabase,
  syncMissingPublicReportsSupabase,
  syncOperationalAlertsSupabase,
  updateWorkerLocationSharingSupabase,
  upsertVolunteerProfileSupabase,
  withdrawFromCivicActivitySupabase,
} from './server/supabaseDb.ts';

const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_REPORT_PHOTOS = 5;
const TEMP_UPLOAD_TTL_MS = 10 * 60 * 1000; // 10 minutes max temporary RAM retention for instant AI analysis
const MAX_TEMP_UPLOADS_IN_MEMORY = 50;
const RETENTION_NOTICE =
  'Uploaded photographs are hosted securely on Cloudinary and processed temporarily in server memory for Gemini AI visual analysis.';

const ALLOWED_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function normalizeImageMimeType(mimeType: string): string {
  const lower = String(mimeType || '').trim().toLowerCase();
  return lower === 'image/jpg' ? 'image/jpeg' : lower;
}

function detectImageTypeFromMagicBytes(buf: Buffer): { mimeType: string; ext: string } | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF followed by valid JPEG marker byte (>= C0)
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff && buf[3] >= 0xc0) {
    return { mimeType: 'image/jpeg', ext: 'jpg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A (+ IHDR if >= 16 bytes)
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    if (buf.length >= 16 && buf.subarray(12, 16).toString('ascii') !== 'IHDR') {
      return null;
    }
    return { mimeType: 'image/png', ext: 'png' };
  }
  // WebP: RIFF .... WEBP followed by valid WebP chunk FourCC (VP8 , VP8L, VP8X)
  if (
    buf.length >= 16 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    const chunkHeader = buf.subarray(12, 16).toString('ascii');
    if (chunkHeader === 'VP8 ' || chunkHeader === 'VP8L' || chunkHeader === 'VP8X') {
      return { mimeType: 'image/webp', ext: 'webp' };
    }
  }
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
  },
});

interface TempUploadEntry {
  uploadId: string;
  buffer: Buffer;
  mimeType: string;
  ext: string;
  fileName: string;
  sizeBytes: number;
  folder: 'reports' | 'evidence';
  uploadedByUid: string;
  uploadedAtIso: string;
  expiresAtMs: number;
}

interface ValidatedUploadMetaEntry {
  uploadId: string;
  ownerUid: string;
  folder: 'reports' | 'evidence';
  metadata: VerifiedUploadMetadataInput;
  expiresAtMs: number;
}

interface VerifiedAiAssessmentEntry {
  analysisToken: string;
  ownerUid: string;
  assessment: CivicImageAssessment & {
    suggestedDepartmentId: string;
    suggestedDepartmentName: string;
  };
  expiresAtMs: number;
}

interface CompletedSubmissionEntry {
  fingerprint: string;
  outcome: Record<string, any>;
  expiresAtMs: number;
}

const SESSION_META_TTL_MS = 2 * 60 * 60 * 1000;
const tempUploads = new Map<string, TempUploadEntry>();
const validatedUploadMetadata = new Map<string, ValidatedUploadMetaEntry>();
const verifiedAiAssessments = new Map<string, VerifiedAiAssessmentEntry>();
const completedReportSubmissions = new Map<string, CompletedSubmissionEntry>();
const inFlightReportSubmissions = new Map<string, Promise<Record<string, any>>>();

function purgeTempUpload(uploadId: string): boolean {
  const entry = tempUploads.get(uploadId);
  if (!entry) return false;
  try {
    entry.buffer.fill(0);
  } catch {
    // Ignore buffer wipe errors
  }
  tempUploads.delete(uploadId);
  return true;
}

function purgeExpiredTempUploads(): void {
  const now = Date.now();
  for (const [id, entry] of tempUploads.entries()) {
    if (entry.expiresAtMs <= now) {
      purgeTempUpload(id);
    }
  }
  for (const [id, meta] of validatedUploadMetadata.entries()) {
    if (meta.expiresAtMs <= now) {
      validatedUploadMetadata.delete(id);
    }
  }
  for (const [tok, aiEntry] of verifiedAiAssessments.entries()) {
    if (aiEntry.expiresAtMs <= now) {
      verifiedAiAssessments.delete(tok);
    }
  }
  for (const [key, entry] of completedReportSubmissions.entries()) {
    if (entry.expiresAtMs <= now) {
      completedReportSubmissions.delete(key);
    }
  }
}

const sweepTimer = setInterval(purgeExpiredTempUploads, 60_000);
if (typeof sweepTimer.unref === 'function') {
  sweepTimer.unref();
}

function issueVerifiedAiAssessment(
  ownerUid: string,
  assessment: CivicImageAssessment
): CivicImageAssessment & {
  suggestedDepartmentId: string;
  suggestedDepartmentName: string;
  analysisToken: string;
} {
  purgeExpiredTempUploads();
  if (verifiedAiAssessments.size >= 300) {
    const oldestKey = verifiedAiAssessments.keys().next().value;
    if (oldestKey) verifiedAiAssessments.delete(oldestKey);
  }
  const targetDept = resolveTargetDepartmentForCategory(assessment.suggestedCategory);
  const enriched = {
    ...assessment,
    suggestedDepartmentId: targetDept.id,
    suggestedDepartmentName: targetDept.name,
  };
  const analysisToken = `ait_${crypto.randomUUID().replace(/-/g, '')}`;
  verifiedAiAssessments.set(analysisToken, {
    analysisToken,
    ownerUid,
    assessment: enriched,
    expiresAtMs: Date.now() + SESSION_META_TTL_MS,
  });
  return {
    ...enriched,
    analysisToken,
  };
}

function haversineDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

function tokenize(text: string): Set<string> {
  const stopWords = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'near', 'from', 'have', 'been', 'there', 'here']);
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w));
  return new Set(tokens);
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function scrubLogText(input: string): string {
  return input
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_KEY]')
    .replace(/ya29\.[0-9A-Za-z_.-]{20,}/g, '[REDACTED_GMAIL_TOKEN]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

function extractGmailAccessToken(req: express.Request): string | undefined {
  const raw = req.header('x-gmail-access-token');
  if (!raw || typeof raw !== 'string') return undefined;
  const cleaned = raw.trim();
  if (!cleaned || cleaned.length > 2048 || /[\r\n]/.test(cleaned)) return undefined;
  return cleaned;
}

function extractGeminiError(err: unknown): { status: number; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (raw.includes('GEMINI_API_KEY is not configured')) {
    return { status: 424, message: 'Server Gemini API key is not configured in environment secrets.' };
  }
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('abort')) {
    return { status: 408, message: 'Gemini AI analysis timed out. Please try again.' };
  }
  if (raw.includes('RESOURCE_EXHAUSTED') || raw.includes('429') || lower.includes('quota')) {
    return { status: 429, message: 'Gemini API quota exceeded. Please try again later or upgrade quota.' };
  }
  if (raw.includes('API_KEY_INVALID') || raw.includes('PERMISSION_DENIED') || raw.includes('403')) {
    return { status: 401, message: 'Gemini API key permission denied or invalid. Please check Settings > Secrets.' };
  }
  if (raw.includes('NOT_FOUND') || raw.includes('404')) {
    return { status: 500, message: 'Configured Gemini model is unavailable or not found.' };
  }
  if (
    raw.includes('INVALID_ARGUMENT') ||
    raw.includes('400') ||
    lower.includes('unsupported image') ||
    lower.includes('invalid image') ||
    lower.includes('unable to process')
  ) {
    return {
      status: 400,
      message: 'Gemini could not process the uploaded image. Please use a clear JPEG, PNG, or WebP photograph.',
    };
  }
  return { status: 500, message: `AI analysis error: ${scrubLogText(raw)}` };
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  // CORS & cache-safety headers + structured logging + proxy 403 HTML shield for all /api requests
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization,Content-Type,Accept,X-Gmail-Access-Token,X-CivicFix-Client'
      );
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    const startMs = Date.now();
    const originHeader = String(req.headers.origin || '-');
    const forwardedHost = String(req.headers['x-forwarded-host'] || '-');
    const baseContentType = String(req.headers['content-type'] || '-')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const hasBearer = /^Bearer\s+.+$/i.test(String(req.headers.authorization || ''));
    const clientHeader = String(req.header('x-civicfix-client') || '-');
    const isProxiedWebClient =
      clientHeader === 'web' || Boolean(req.header('x-forwarded-host'));

    console.log(
      `[API REQ] ${req.method} ${req.originalUrl} | origin=${originHeader} | forwardedHost=${forwardedHost} | contentType=${baseContentType || '-'} | hasBearer=${hasBearer} | client=${clientHeader}`
    );

    const originalJson = res.json.bind(res);
    let capturedError: string | null = null;
    let remappedFrom403 = false;

    res.json = ((body: any) => {
      const normalizeErrorBody = (rawBody: any, statusCode: number) => {
        if (
          statusCode >= 400 &&
          rawBody &&
          typeof rawBody === 'object' &&
          !Array.isArray(rawBody) &&
          !('success' in rawBody)
        ) {
          return { success: false, ...rawBody };
        }
        return rawBody;
      };

      if (res.statusCode === 403 && isProxiedWebClient) {
        // Preview Nginx has `proxy_intercept_errors on; error_page 403 = /forbidden.html;`
        // Emit 422 JSON with X-CivicFix-Original-Status so Nginx never replaces Express JSON errors with 403 HTML.
        remappedFrom403 = true;
        res.status(422);
        res.setHeader('X-CivicFix-Original-Status', '403');
        const nextBody =
          body && typeof body === 'object' && !Array.isArray(body)
            ? { success: false, ...body, httpStatus: 403, originalStatus: 403 }
            : { success: false, data: body, httpStatus: 403, originalStatus: 403 };
        if (typeof nextBody.error === 'string') {
          capturedError = scrubLogText(nextBody.error);
        }
        return originalJson(nextBody);
      }
      const finalBody = normalizeErrorBody(body, res.statusCode);
      if (res.statusCode >= 400 && finalBody && typeof finalBody.error === 'string') {
        capturedError = scrubLogText(finalBody.error);
      }
      return originalJson(finalBody);
    }) as typeof res.json;

    res.on('finish', () => {
      const durationMs = Date.now() - startMs;
      const authReq = req as AuthenticatedRequest;
      const uid = authReq.user?.uid || 'anon';
      const role = authReq.user?.role || '-';
      const remapTag = remappedFrom403 ? ' (shielded 403->422)' : '';
      const baseLog = `[API RES] ${req.method} ${req.originalUrl} -> ${res.statusCode}${remapTag} (${durationMs}ms) | uid=${uid} | role=${role}`;
      if (res.statusCode >= 400 || capturedError) {
        console.error(`${baseLog} | error=${capturedError || 'HTTP error'}`);
      } else {
        console.log(baseLog);
      }
    });

    next();
  });

  app.get('/api/health', (_req, res) => {
    const geminiConfigured = Boolean(
      process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
    );
    const cloudinaryConfigured = isCloudinaryConfigured();
    const emailStatus = getEmailTransportStatus();
    res.json({
      ok: true,
      service: 'civicfix-ai',
      geminiConfigured,
      cloudinaryConfigured,
      emailConfigured: emailStatus.configured,
      emailProvider: emailStatus.provider,
      emailFromConfigured: Boolean(emailStatus.senderAddress),
      supabaseAuthConfigured: isSupabaseServerConfigured(),
      supabaseDbConfigured: isSupabaseServerConfigured(),
      databaseBackend: 'supabase_postgresql',
      uploadMode: cloudinaryConfigured ? 'cloudinary' : 'unconfigured',
      permanentImageStorage: cloudinaryConfigured,
      retentionNotice: RETENTION_NOTICE,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/uploads/status', requireAuth, (_req, res) => {
    purgeExpiredTempUploads();
    const cloudinaryConfigured = isCloudinaryConfigured();
    res.status(200).json({
      ok: true,
      mode: cloudinaryConfigured ? 'cloudinary' : 'unconfigured',
      cloudinaryConfigured,
      permanentRetention: cloudinaryConfigured,
      maxBytes: MAX_UPLOAD_BYTES,
      maxPhotosPerReport: MAX_REPORT_PHOTOS,
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      retentionNotice: RETENTION_NOTICE,
    });
  });

  // ------------------------------------------------------------------
  // 0a. Public Transparency & Tracking ID Endpoints (Zero PII)
  // ------------------------------------------------------------------
  app.get('/api/public/transparency', async (_req, res) => {
    try {
      const [publicReports, publicActivities] = await Promise.all([
        fetchPublicReportsFromSupabase(300),
        fetchPublicActivitiesFromSupabase(50).catch(() => []),
      ]);

      const totalSubmitted = publicReports.length;
      const underReview = publicReports.filter((r) =>
        r.status === 'submitted' || r.status === 'under_review' || r.status === 'reopened'
      ).length;
      const inProgress = publicReports.filter((r) =>
        r.status === 'verified' || r.status === 'assigned' || r.status === 'in_progress'
      ).length;
      const resolved = publicReports.filter((r) =>
        r.status === 'resolved' || r.status === 'citizen_confirmed'
      ).length;
      const rejected = publicReports.filter((r) => r.status === 'rejected').length;

      const allResolutionHoursSamples: number[] = [];
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
          resolutionHoursSamples: number[];
        }
      >();

      for (const dept of CANONICAL_STARTER_DEPARTMENTS) {
        deptMap.set(dept.id, {
          departmentId: dept.id,
          departmentName: dept.name,
          departmentCode: dept.code,
          total: 0,
          underReview: 0,
          inProgress: 0,
          resolved: 0,
          resolutionHoursSamples: [],
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
            resolutionHoursSamples: [],
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
          const startMs = Date.parse(r.createdAtIso);
          const endMs = Date.parse(r.supervisorVerifiedAtIso || r.completedAtIso || r.updatedAtIso);
          if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
            const hrs = (endMs - startMs) / (1000 * 60 * 60);
            bucket.resolutionHoursSamples.push(hrs);
            allResolutionHoursSamples.push(hrs);
          }
        }
      }

      const overallAvgResolutionHours =
        allResolutionHoursSamples.length > 0
          ? Number(
              (
                allResolutionHoursSamples.reduce((acc, v) => acc + v, 0) /
                allResolutionHoursSamples.length
              ).toFixed(1)
            )
          : null;

      // Build last 6 calendar months analytics strictly from real public_reports
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const now = new Date();
      const monthlyMap = new Map<string, { key: string; label: string; submitted: number; resolved: number }>();
      for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const label = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
        monthlyMap.set(key, { key, label, submitted: 0, resolved: 0 });
      }
      for (const r of publicReports) {
        const createdMs = Date.parse(r.createdAtIso);
        if (Number.isFinite(createdMs)) {
          const cd = new Date(createdMs);
          const cKey = `${cd.getFullYear()}-${String(cd.getMonth() + 1).padStart(2, '0')}`;
          const mBucket = monthlyMap.get(cKey);
          if (mBucket) mBucket.submitted += 1;
        }
        if (r.status === 'resolved' || r.status === 'citizen_confirmed') {
          const resMs = Date.parse(r.supervisorVerifiedAtIso || r.completedAtIso || r.updatedAtIso);
          if (Number.isFinite(resMs)) {
            const rd = new Date(resMs);
            const rKey = `${rd.getFullYear()}-${String(rd.getMonth() + 1).padStart(2, '0')}`;
            const mBucket = monthlyMap.get(rKey);
            if (mBucket) mBucket.resolved += 1;
          }
        }
      }
      const monthlyTrends = Array.from(monthlyMap.values());

      // Sanitized recent public complaint updates (Zero PII)
      const recentPublicUpdates: Array<{
        reportId: string;
        trackingCode: string;
        title: string;
        category: string;
        departmentName: string;
        areaLabel: string;
        status: string;
        stage: string;
        timestampIso: string;
        summary: string;
      }> = [];
      for (const r of publicReports) {
        const events = Array.isArray(r.timelineEvents) ? r.timelineEvents : [];
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
            timestampIso: latest.timestampIso || r.updatedAtIso,
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
            timestampIso: r.updatedAtIso,
            summary: `Complaint currently at stage: ${r.status.replace(/_/g, ' ')}.`,
          });
        }
      }
      recentPublicUpdates.sort((a, b) => Date.parse(b.timestampIso) - Date.parse(a.timestampIso));

      const departmentPerformance = Array.from(deptMap.values()).map((d) => {
        const avgResolutionHours =
          d.resolutionHoursSamples.length > 0
            ? Number(
                (
                  d.resolutionHoursSamples.reduce((acc, v) => acc + v, 0) /
                  d.resolutionHoursSamples.length
                ).toFixed(1)
              )
            : null;
        const resolutionRatePct = d.total > 0 ? Math.round((d.resolved / d.total) * 100) : null;
        return {
          departmentId: d.departmentId,
          departmentName: d.departmentName,
          departmentCode: d.departmentCode,
          total: d.total,
          underReview: d.underReview,
          inProgress: d.inProgress,
          resolved: d.resolved,
          resolutionRatePct,
          avgResolutionHours,
        };
      });

      const resolutionHistory = publicReports
        .filter((r) => r.status === 'resolved' || r.status === 'citizen_confirmed')
        .slice(0, 25);

      res.json({
        totalSubmitted,
        underReview,
        inProgress,
        resolved,
        rejected,
        overallAvgResolutionHours,
        monthlyTrends,
        recentPublicUpdates: recentPublicUpdates.slice(0, 12),
        publicActivities: publicActivities.slice(0, 12),
        departmentPerformance,
        resolutionHistory,
        generatedAtIso: new Date().toISOString(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to load public transparency metrics.';
      res.status(500).json({ error: msg });
    }
  });

  app.get('/api/public/track/:trackingCode', async (req, res) => {
    try {
      const rawCode = String(req.params.trackingCode || '').trim().toUpperCase();
      if (!/^[A-Z0-9-]{4,32}$/.test(rawCode)) {
        res.status(400).json({
          error: 'Please enter a valid Tracking ID (for example, CF-2026-123456).',
        });
        return;
      }

      const report = await fetchPublicReportByTrackingCodeFromSupabase(rawCode);
      if (!report) {
        res.status(404).json({
          error: `No civic report was found for Tracking ID "${rawCode}".`,
        });
        return;
      }

      res.json({ report });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to look up Tracking ID.';
      res.status(500).json({ error: msg });
    }
  });

  // ------------------------------------------------------------------
  // 0. Server-Side Profile Initialization & Admin Authorization Endpoints
  // ------------------------------------------------------------------
  app.post('/api/auth/initialize', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const result = await initializeUserAndBootstrapAdmin(req.user!);
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to initialize user profile.';
      const isPermDenied = msg.includes('PERMISSION_DENIED') || msg.includes('(403)');
      res.status(isPermDenied ? 422 : 500).json({
        error: scrubLogText(msg),
        ...(isPermDenied ? { code: 'DATABASE_PERMISSION_DENIED', upstreamStatus: 403 } : {}),
      });
    }
  });

  app.post(
    '/api/admin/users/:targetUid/role',
    requireAuth,
    requireRole(['admin']),
    async (req: AuthenticatedRequest, res) => {
      try {
        const targetUid = String(req.params.targetUid || '').trim();
        const role = String(req.body?.role || '') as UserRole;
        const departmentId = typeof req.body?.departmentId === 'string' ? req.body.departmentId : '';
        const active = typeof req.body?.active === 'boolean' ? req.body.active : true;

        const updatedUser = await updateUserRoleAsAdmin(req.user!, {
          targetUid,
          role,
          departmentId,
          active,
        });
        res.json({ ok: true, user: updatedUser });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to update user role.';
        const isPermDenied = msg.includes('PERMISSION_DENIED') || msg.includes('(403)');
        const status =
          msg.includes('Invalid') || msg.includes('cannot') || msg.includes('does not exist')
            ? 400
            : msg.includes('not found')
              ? 404
              : isPermDenied
                ? 422
                : 500;
        res.status(status).json({
          error: scrubLogText(msg),
          ...(isPermDenied ? { code: 'DATABASE_PERMISSION_DENIED', upstreamStatus: 403 } : {}),
        });
      }
    }
  );

  app.post(
    '/api/admin/workers/invite',
    requireAuth,
    requireRole(['admin', 'officer']),
    async (req: AuthenticatedRequest, res) => {
      try {
        const email = String(req.body?.email || '').trim();
        const displayName = String(req.body?.displayName || '').trim();
        const role = req.body?.role === 'officer' ? 'officer' : 'worker';
        const departmentId = String(req.body?.departmentId || '').trim();
        const workZone = typeof req.body?.workZone === 'string' ? req.body.workZone : '';
        const employeeId = typeof req.body?.employeeId === 'string' ? req.body.employeeId : '';
        const supervisorId = typeof req.body?.supervisorId === 'string' ? req.body.supervisorId : '';
        const supervisorName = typeof req.body?.supervisorName === 'string' ? req.body.supervisorName : '';
        const availabilityStatus = String(req.body?.availabilityStatus || 'available') as WorkerAvailabilityStatus;

        const invite = await registerWorkerInviteAsAdmin(req.user!, {
          email,
          displayName,
          role,
          departmentId,
          workZone,
          employeeId,
          supervisorId,
          supervisorName,
          availabilityStatus,
        });
        res.status(201).json({ ok: true, invite });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to register field worker.';
        const isPermDenied = msg.includes('PERMISSION_DENIED') || msg.includes('(403)');
        const status =
          msg.includes('required') ||
          msg.includes('Invalid') ||
          msg.includes('does not exist') ||
          msg.includes('must have Officer or Administrator role')
            ? 400
            : msg.includes('Only administrators') ||
                msg.includes('Department supervisors can only')
              ? 403
              : isPermDenied
                ? 422
                : 500;
        res.status(status).json({
          error: scrubLogText(msg),
          ...(isPermDenied ? { code: 'DATABASE_PERMISSION_DENIED', upstreamStatus: 403 } : {}),
        });
      }
    }
  );

  app.post(
    '/api/workers/:targetUid/availability',
    requireAuth,
    async (req: AuthenticatedRequest, res) => {
      try {
        const targetUid = String(req.params.targetUid || '').trim();
        const availabilityStatus =
          typeof req.body?.availabilityStatus === 'string'
            ? (req.body.availabilityStatus as WorkerAvailabilityStatus)
            : undefined;
        const availabilityNote =
          typeof req.body?.availabilityNote === 'string' ? req.body.availabilityNote : undefined;
        const workZone = typeof req.body?.workZone === 'string' ? req.body.workZone : undefined;
        const employeeId = typeof req.body?.employeeId === 'string' ? req.body.employeeId : undefined;
        const supervisorId = typeof req.body?.supervisorId === 'string' ? req.body.supervisorId : undefined;
        const supervisorName =
          typeof req.body?.supervisorName === 'string' ? req.body.supervisorName : undefined;
        const maxActiveTasks =
          typeof req.body?.maxActiveTasks === 'number' ? req.body.maxActiveTasks : undefined;
        const departmentId =
          typeof req.body?.departmentId === 'string' ? req.body.departmentId : undefined;

        const user = await updateWorkerOperationalProfile(req.user!, {
          targetUid,
          availabilityStatus,
          availabilityNote,
          workZone,
          employeeId,
          supervisorId,
          supervisorName,
          maxActiveTasks,
          departmentId,
        });
        res.json({ ok: true, user });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to update worker operational profile.';
        const status =
          msg.includes('Only administrators')
            ? 403
            : msg.includes('not found')
              ? 404
              : msg.includes('Invalid') ||
                  msg.includes('does not exist') ||
                  msg.includes('must have Officer or Administrator role')
                ? 400
                : 500;
        res.status(status).json({ error: msg });
      }
    }
  );

  // ------------------------------------------------------------------
  // 0b. Department Authority Email Configuration & Automated Routing
  // ------------------------------------------------------------------
  app.get(
    '/api/admin/department-emails',
    requireAuth,
    requireRole(['admin']),
    async (req: AuthenticatedRequest, res) => {
      try {
        const result = await listDepartmentEmailSettingsForAdmin(req.user!);
        res.json({
          transport: {
            configured: result.transport.configured,
            provider: result.transport.provider,
            fromAddress: result.transport.senderAddress,
            notice: result.transport.detail,
            senderAddress: result.transport.senderAddress,
            detail: result.transport.detail,
          },
          settings: result.settings,
          logs: result.logs,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to load department authority email settings.';
        const status = msg.includes('Only authorized administrators') ? 403 : 500;
        res.status(status).json({ error: msg });
      }
    }
  );

  const handleSaveDepartmentEmailSetting = async (req: AuthenticatedRequest, res: express.Response) => {
    try {
      const departmentId = String(req.params.departmentId || '').trim();
      const saved = await saveDepartmentEmailSettingAsAdmin(req.user!, departmentId, {
        departmentName: String(req.body?.departmentName || ''),
        officialAuthorityEmail: String(req.body?.officialAuthorityEmail || ''),
        seniorAuthorityEmail: String(req.body?.seniorAuthorityEmail || ''),
        notificationEnabled: req.body?.notificationEnabled !== false,
        departmentContactPerson: String(req.body?.departmentContactPerson || ''),
      });
      res.json({ ok: true, setting: saved });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save department authority email settings.';
      const status = msg.includes('Only authorized administrators')
        ? 403
        : msg.includes('Invalid') || msg.includes('not permitted') || msg.includes('at least 2')
          ? 400
          : 500;
      res.status(status).json({ error: msg });
    }
  };

  app.post(
    '/api/admin/department-emails/test',
    requireAuth,
    requireRole(['admin']),
    async (req: AuthenticatedRequest, res) => {
      try {
        const toEmail = String(req.body?.toEmail || '').trim();
        const departmentName = String(req.body?.departmentName || 'Municipal Department').trim();
        const gmailAccessToken = extractGmailAccessToken(req);
        const result = await sendTestAuthorityEmail({
          to: toEmail,
          departmentName,
          actorName: req.user?.name || req.user?.email || 'Administrator',
          gmailAccessToken,
          gmailSenderEmail: req.user?.email || undefined,
        });
        if (!result.sent) {
          const status = result.provider === 'none' ? 400 : 502;
          res.status(status).json({ ok: false, ...result, error: result.message });
          return;
        }
        res.status(200).json({ ok: true, ...result });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to send test authority email.';
        res.status(500).json({ ok: false, error: scrubLogText(msg) });
      }
    }
  );

  app.put(
    '/api/admin/department-emails/:departmentId',
    requireAuth,
    requireRole(['admin']),
    handleSaveDepartmentEmailSetting
  );
  app.post(
    '/api/admin/department-emails/:departmentId',
    requireAuth,
    requireRole(['admin']),
    handleSaveDepartmentEmailSetting
  );

  app.post('/api/reports/:reportId/notify-authority', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const reportId = String(req.params.reportId || '').trim();
      const gmailAccessToken = extractGmailAccessToken(req);
      const outcome = await processReportAuthorityEmailRouting(req.user!, reportId, { gmailAccessToken });
      res.json(outcome);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to process department authority notification.';
      const isPermDenied = msg.includes('PERMISSION_DENIED') || msg.includes('(403)');
      const status = msg.includes('not found')
        ? 404
        : msg.includes('Invalid')
          ? 400
          : msg.includes('Only the submitting citizen')
            ? 403
            : isPermDenied
              ? 422
              : 500;
      res.status(status).json({
        error: scrubLogText(msg),
        ...(isPermDenied ? { code: 'DATABASE_PERMISSION_DENIED', upstreamStatus: 403 } : {}),
      });
    }
  });

  // ------------------------------------------------------------------
  // 1. Signed Server-Side Cloudinary Upload (+ Short-Lived AI Buffer)
  // ------------------------------------------------------------------
  app.post(['/api/uploads', '/api/uploads/'], requireAuth, (req: AuthenticatedRequest, res) => {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.includes('multipart/form-data')) {
      res.status(415).json({
        success: false,
        error: 'Unsupported Media Type: multipart/form-data Content-Type is required.',
      });
      return;
    }

    upload.single('image')(req, res, async (multerErr) => {
      try {
        if (multerErr) {
          if (multerErr instanceof multer.MulterError) {
            if (multerErr.code === 'LIMIT_FILE_SIZE') {
              res.status(413).json({
                success: false,
                error: 'File too large. Maximum allowed image size is 5 MB.',
              });
              return;
            }
            if (multerErr.code === 'LIMIT_FILE_COUNT' || multerErr.code === 'LIMIT_UNEXPECTED_FILE') {
              res.status(400).json({
                success: false,
                error: 'Upload one photograph at a time using field name "image".',
              });
              return;
            }
          }
          res.status(400).json({
            success: false,
            error: multerErr.message || 'Invalid file upload payload.',
          });
          return;
        }

        const rawExistingCount = req.body?.existingCount;
        const existingCount =
          rawExistingCount === undefined || rawExistingCount === '' ? 0 : Number(rawExistingCount);
        if (!Number.isInteger(existingCount) || existingCount < 0) {
          res.status(400).json({ success: false, error: 'Invalid existingCount value.' });
          return;
        }
        if (existingCount >= MAX_REPORT_PHOTOS) {
          res.status(400).json({
            success: false,
            error: `Maximum of ${MAX_REPORT_PHOTOS} photographs per report reached.`,
          });
          return;
        }

        const rawFolder =
          typeof req.body?.folder === 'string' && req.body.folder.trim()
            ? req.body.folder.trim()
            : 'reports';
        if (rawFolder !== 'reports' && rawFolder !== 'evidence') {
          res.status(400).json({
            success: false,
            error: 'Invalid upload folder. Allowed values are "reports" or "evidence".',
          });
          return;
        }

        const file = req.file;
        if (!file || file.size === 0) {
          res.status(400).json({ success: false, error: 'No valid image file provided.' });
          return;
        }

        if (file.size > MAX_UPLOAD_BYTES) {
          res.status(413).json({
            success: false,
            error: 'File too large. Maximum allowed image size is 5 MB.',
          });
          return;
        }

        const normalizedDeclaredMime = normalizeImageMimeType(file.mimetype);
        if (!ALLOWED_MIME_TO_EXT[normalizedDeclaredMime]) {
          res.status(415).json({
            success: false,
            error: 'Unsupported file type. Only JPG, JPEG, PNG, and WebP images are allowed.',
          });
          return;
        }

        const detected = detectImageTypeFromMagicBytes(file.buffer);
        if (!detected || detected.mimeType !== normalizedDeclaredMime) {
          res.status(415).json({
            success: false,
            error: 'File content validation failed: file header does not match declared JPG, JPEG, PNG, or WebP format.',
          });
          return;
        }

        if (!isCloudinaryConfigured()) {
          res.status(503).json({
            success: false,
            error: 'Cloudinary image storage is not configured on the server. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.',
          });
          return;
        }

        purgeExpiredTempUploads();
        if (tempUploads.size >= MAX_TEMP_UPLOADS_IN_MEMORY) {
          const oldestKey = tempUploads.keys().next().value;
          if (oldestKey) purgeTempUpload(oldestKey);
        }

        const uploadId = `cld_${crypto.randomUUID().replace(/-/g, '')}`;
        const safeFilename = `${uploadId}.${detected.ext}`;
        const cleanOriginal =
          path
            .basename(file.originalname || safeFilename)
            .replace(/[^a-zA-Z0-9._-]/g, '_')
            .slice(0, 120) || safeFilename;

        // Upload verified buffer to Cloudinary (signed server-side upload)
        const cloudResult = await uploadImageBufferToCloudinary(file.buffer, {
          folder: rawFolder,
          uid: req.user!.uid,
          fileName: cleanOriginal,
          mimeType: detected.mimeType,
        });

        const uploadedAtMs = Date.now();
        const uploadedAtIso = new Date(uploadedAtMs).toISOString();
        const expiresAtMs = uploadedAtMs + TEMP_UPLOAD_TTL_MS;
        const expiresAtIso = new Date(expiresAtMs).toISOString();

        // Keep short-lived in-memory buffer for immediate Gemini AI analysis; purged after analysis or expiry.
        const memoryBuffer = Buffer.from(file.buffer);
        const metadataRecord: VerifiedUploadMetadataInput = {
          url: cloudResult.secureUrl,
          publicId: cloudResult.publicId,
          fileName: cleanOriginal,
          mimeType: detected.mimeType,
          sizeBytes: memoryBuffer.length,
          storageProvider: 'cloudinary',
          storagePath: cloudResult.publicId,
          uploadedBy: req.user!.uid,
          uploadedAtIso,
        };

        tempUploads.set(uploadId, {
          uploadId,
          buffer: memoryBuffer,
          mimeType: detected.mimeType,
          ext: detected.ext,
          fileName: cleanOriginal,
          sizeBytes: memoryBuffer.length,
          folder: rawFolder,
          uploadedByUid: req.user!.uid,
          uploadedAtIso,
          expiresAtMs,
        });

        if (validatedUploadMetadata.size >= 300) {
          const oldestMetaKey = validatedUploadMetadata.keys().next().value;
          if (oldestMetaKey) validatedUploadMetadata.delete(oldestMetaKey);
        }
        validatedUploadMetadata.set(uploadId, {
          uploadId,
          ownerUid: req.user!.uid,
          folder: rawFolder,
          metadata: metadataRecord,
          expiresAtMs: uploadedAtMs + SESSION_META_TTL_MS,
        });

        console.log(
          `[POST /api/uploads cloudinary] uid=${req.user!.uid} folder=${rawFolder} mime=${detected.mimeType} sizeBytes=${memoryBuffer.length} uploadId=${uploadId} publicId=${cloudResult.publicId}`
        );

        res.status(201).json({
          success: true,
          ok: true,
          imageUrl: metadataRecord.url,
          publicId: metadataRecord.publicId,
          uploadId,
          temporaryUploadId: uploadId,
          temporaryOnly: false,
          retentionPolicy: 'cloudinary_persistent',
          retentionNotice: RETENTION_NOTICE,
          expiresAtIso,
          url: metadataRecord.url,
          secureUrl: metadataRecord.url,
          fileName: metadataRecord.fileName,
          storagePath: metadataRecord.storagePath,
          mimeType: metadataRecord.mimeType,
          sizeBytes: metadataRecord.sizeBytes,
          storageProvider: metadataRecord.storageProvider,
          uploadedBy: metadataRecord.uploadedBy,
          uploadedAtIso: metadataRecord.uploadedAtIso,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? scrubLogText(err.message) : 'Failed to upload photograph to Cloudinary.';
        console.error('[POST /api/uploads cloudinary error]', msg);
        res.status(502).json({
          success: false,
          error: msg,
        });
      } finally {
        if (req.file?.buffer) {
          try {
            req.file.buffer.fill(0);
          } catch {
            // Ignore buffer wipe errors
          }
        }
      }
    });
  });

  app.delete('/api/uploads/:uploadId', requireAuth, async (req: AuthenticatedRequest, res) => {
    purgeExpiredTempUploads();
    const uploadId = String(req.params.uploadId || '').trim();
    if (!/^(tmp|cld)_[a-zA-Z0-9_-]{8,80}$/.test(uploadId)) {
      res.status(400).json({ error: 'Invalid upload identifier.' });
      return;
    }
    const existing = tempUploads.get(uploadId);
    const metaEntry = validatedUploadMetadata.get(uploadId);
    if (existing && existing.uploadedByUid !== req.user!.uid) {
      res.status(403).json({ error: 'You do not own this upload reference.' });
      return;
    }
    if (metaEntry && metaEntry.ownerUid !== req.user!.uid) {
      res.status(403).json({ error: 'You do not own this upload reference.' });
      return;
    }
    let cloudinaryDeleted = false;
    if (metaEntry?.metadata?.storageProvider === 'cloudinary' && metaEntry.metadata.publicId) {
      cloudinaryDeleted = await deleteCloudinaryAsset(metaEntry.metadata.publicId);
    }
    if (metaEntry) {
      validatedUploadMetadata.delete(uploadId);
    }
    const tempCleaned = purgeTempUpload(uploadId);
    res.status(200).json({ ok: true, cleanedUp: tempCleaned || cloudinaryDeleted, cloudinaryDeleted });
  });

  app.all(['/api/uploads', '/api/uploads/'], (_req, res) => {
    res.status(405).json({
      success: false,
      error: 'Method not allowed. Use POST /api/uploads with multipart/form-data.',
    });
  });

  // ------------------------------------------------------------------
  // 2. Server-Side Gemini AI Visual Issue Assessment (Cleans Temp Buffer)
  // ------------------------------------------------------------------
  app.post(['/api/ai/analyze-image', '/api/ai/analyze-image/'], requireAuth, (req: AuthenticatedRequest, res) => {
    purgeExpiredTempUploads();
    const contentType = String(req.headers['content-type'] || '').toLowerCase();

    if (!contentType.includes('multipart/form-data')) {
      (async () => {
        const uploadId = typeof req.body?.uploadId === 'string' ? req.body.uploadId.trim() : '';
        let canPurge = false;
        let fetchedBuffer: Buffer | null = null;
        try {
          if (!uploadId || !/^(tmp|cld)_[a-zA-Z0-9_-]{8,80}$/.test(uploadId)) {
            res.status(400).json({
              error: 'Please provide a valid uploadId or send the image file via multipart/form-data.',
            });
            return;
          }

          const tempEntry = tempUploads.get(uploadId);
          const metaEntry = validatedUploadMetadata.get(uploadId);

          if (tempEntry && tempEntry.uploadedByUid !== req.user!.uid) {
            res.status(403).json({ error: 'You are not authorized to analyze another user\'s upload reference.' });
            return;
          }
          if (metaEntry && metaEntry.ownerUid !== req.user!.uid) {
            res.status(403).json({ error: 'You are not authorized to analyze another user\'s upload reference.' });
            return;
          }

          let imageBuffer: Buffer;
          let mimeType: string;
          if (tempEntry) {
            canPurge = true;
            imageBuffer = tempEntry.buffer;
            mimeType = tempEntry.mimeType;
          } else if (metaEntry && metaEntry.metadata.url.startsWith('https://')) {
            const downloaded = await fetchCloudinaryImageBuffer(metaEntry.metadata.url);
            fetchedBuffer = downloaded.buffer;
            imageBuffer = downloaded.buffer;
            mimeType = metaEntry.metadata.mimeType || downloaded.mimeType;
          } else {
            res.status(404).json({
              error: 'Uploaded photograph reference expired. Please re-select the image to analyze.',
            });
            return;
          }

          const userHint = typeof req.body?.userHint === 'string' ? req.body.userHint : undefined;
          const assessment = await analyzeCivicIssueImage(imageBuffer, mimeType, userHint);
          const payload = issueVerifiedAiAssessment(req.user!.uid, assessment);
          res.status(200).json({
            ...payload,
            temporaryDataCleanedUp: true,
          });
        } catch (err) {
          const mapped = extractGeminiError(err);
          console.error('[AI analyze-image uploadId branch error]', mapped.status, scrubLogText(mapped.message));
          res.status(mapped.status).json({ error: mapped.message });
        } finally {
          if (fetchedBuffer) {
            try {
              fetchedBuffer.fill(0);
            } catch {
              // Ignore buffer wipe errors
            }
          }
          if (canPurge && uploadId) {
            purgeTempUpload(uploadId);
          }
        }
      })();
      return;
    }

    upload.single('image')(req, res, async (multerErr) => {
      if (multerErr) {
        if (multerErr instanceof multer.MulterError) {
          if (multerErr.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({ error: 'File too large for AI analysis. Maximum allowed image size is 5 MB.' });
            return;
          }
          if (multerErr.code === 'LIMIT_FILE_COUNT' || multerErr.code === 'LIMIT_UNEXPECTED_FILE') {
            res.status(400).json({ error: 'Send one image using multipart field name "image".' });
            return;
          }
        }
        res.status(400).json({ error: multerErr.message || 'Image upload failed.' });
        return;
      }

      const uploadIdToClean =
        typeof req.body?.uploadId === 'string' ? req.body.uploadId.trim() : '';

      try {
        if (!req.file || req.file.size === 0) {
          res.status(400).json({ error: 'Please upload a valid civic issue photograph (JPEG, PNG, WebP <= 5 MB).' });
          return;
        }
        const normalizedAiMime = normalizeImageMimeType(req.file.mimetype);
        const detected = detectImageTypeFromMagicBytes(req.file.buffer);
        if (!detected || !ALLOWED_MIME_TO_EXT[normalizedAiMime] || detected.mimeType !== normalizedAiMime) {
          res.status(415).json({
            success: false,
            error: 'Unsupported or invalid image file. Only verified JPG, JPEG, PNG, or WebP images are accepted.',
          });
          return;
        }

        const userHint = typeof req.body?.userHint === 'string' ? req.body.userHint : undefined;
        const assessment = await analyzeCivicIssueImage(req.file.buffer, detected.mimeType, userHint);
        const payload = issueVerifiedAiAssessment(req.user!.uid, assessment);
        res.status(200).json({
          ...payload,
          temporaryDataCleanedUp: true,
        });
      } catch (err) {
        const mapped = extractGeminiError(err);
        console.error('[AI analyze-image multipart error]', mapped.status, scrubLogText(mapped.message));
        res.status(mapped.status).json({ error: mapped.message });
      } finally {
        if (req.file?.buffer) {
          try {
            req.file.buffer.fill(0);
          } catch {
            // Ignore buffer wipe errors
          }
        }
        if (uploadIdToClean) {
          const entry = tempUploads.get(uploadIdToClean);
          if (entry && entry.uploadedByUid === req.user!.uid) {
            purgeTempUpload(uploadIdToClean);
          }
        }
      }
    });
  });

  app.all(['/api/ai/analyze-image', '/api/ai/analyze-image/'], (_req, res) => {
    res.status(405).json({ error: 'Method not allowed. Use POST /api/ai/analyze-image.' });
  });

  // ------------------------------------------------------------------
  // 2b. Server-Authoritative Report Retrieval, Submission & AI Attachment
  // ------------------------------------------------------------------
  app.get(['/api/reports', '/api/reports/'], requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const rawLimit = Number(req.query?.limit || 50);
      const limitCount = Number.isFinite(rawLimit) ? rawLimit : 50;
      console.log(
        `[GET /api/reports stage] uid=${req.user!.uid} role=${req.user!.role} limit=${limitCount}`
      );
      const result = await fetchAccessibleReportsForUser(req.user!, limitCount);
      res.status(200).json({
        ok: true,
        scope: result.scope,
        count: result.reports.length,
        reports: result.reports,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to retrieve civic reports.';
      const isPermDenied = msg.includes('PERMISSION_DENIED') || msg.includes('(403)');
      const status = isPermDenied ? 422 : 500;
      console.error('[GET /api/reports error]', status, scrubLogText(msg));
      res.status(status).json({
        error: scrubLogText(msg),
        ...(isPermDenied ? { code: 'DATABASE_PERMISSION_DENIED', upstreamStatus: 403 } : {}),
      });
    }
  });

  app.get('/api/reports/:reportId', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const reportId = String(req.params.reportId || '').trim();
      const report = await fetchSingleReportForUser(req.user!, reportId);
      if (!report) {
        res.status(404).json({ error: `Civic report "${reportId}" was not found.` });
        return;
      }
      res.status(200).json({ ok: true, report });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to retrieve civic report.';
      const isPermDenied = msg.includes('PERMISSION_DENIED') || msg.includes('(403)');
      const status = msg.includes('Invalid report')
        ? 400
        : msg.includes('not authorized')
          ? 403
          : isPermDenied
            ? 422
            : 500;
      console.error('[GET /api/reports/:reportId error]', status, scrubLogText(msg));
      res.status(status).json({
        error: scrubLogText(msg),
        ...(isPermDenied ? { code: 'DATABASE_PERMISSION_DENIED', upstreamStatus: 403 } : {}),
      });
    }
  });

  app.post(['/api/reports', '/api/reports/'], requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      purgeExpiredTempUploads();
      const user = req.user!;
      const body = req.body || {};

      // Reject any client attempt to embed raw base64 / data: or blob: URLs (real Cloudinary URLs are resolved from server-verified uploadIds)
      const rawImageUrls = Array.isArray(body.imageUrls) ? body.imageUrls : [];
      if (
        rawImageUrls.some(
          (u: unknown) => typeof u === 'string' && /^(data:|blob:)/i.test(u.trim())
        )
      ) {
        res.status(400).json({
          error: 'Raw base64 or blob image payloads cannot be stored in civic reports.',
        });
        return;
      }

      // Idempotency guard: prevent duplicate reports when users retry after transient errors
      const rawIdempotencyKey =
        typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
      const hasValidIdempotencyKey = /^[a-zA-Z0-9_-]{8,128}$/.test(rawIdempotencyKey);
      const scopedIdempotencyKey = hasValidIdempotencyKey ? `${user.uid}:${rawIdempotencyKey}` : '';
      const requestFingerprint = crypto
        .createHash('sha256')
        .update(
          JSON.stringify({
            title: String(body.title || '').trim(),
            description: String(body.description || '').trim(),
            category: String(body.category || '').trim(),
            addressText: String(body.addressText || '').trim(),
            latitude: Number(body.latitude),
            longitude: Number(body.longitude),
          })
        )
        .digest('hex');

      if (scopedIdempotencyKey) {
        const cached = completedReportSubmissions.get(scopedIdempotencyKey);
        if (cached && cached.fingerprint === requestFingerprint) {
          res.status(200).json({
            ok: true,
            idempotentReplay: true,
            ...cached.outcome,
          });
          return;
        }
        const inFlight = inFlightReportSubmissions.get(scopedIdempotencyKey);
        if (inFlight) {
          const outcome = await inFlight;
          res.status(200).json({
            ok: true,
            idempotentReplay: true,
            ...outcome,
          });
          return;
        }
      }

      const rawUploadIds: string[] = Array.isArray(body.uploadIds)
        ? body.uploadIds.map((v: unknown) => String(v || '').trim()).filter(Boolean)
        : [];
      if (rawUploadIds.length > MAX_REPORT_PHOTOS) {
        res.status(400).json({ error: `Maximum of ${MAX_REPORT_PHOTOS} photographs per report allowed.` });
        return;
      }

      const uniqueUploadIds = Array.from(new Set(rawUploadIds));
      const verifiedUploads: VerifiedUploadMetadataInput[] = [];
      for (const uploadId of uniqueUploadIds) {
        if (!/^(tmp|cld)_[a-zA-Z0-9_-]{8,80}$/.test(uploadId)) {
          res.status(400).json({ error: `Invalid upload identifier: ${uploadId}` });
          return;
        }
        const metaEntry = validatedUploadMetadata.get(uploadId);
        if (!metaEntry || metaEntry.folder !== 'reports') {
          res.status(400).json({
            error: 'One or more uploaded photograph validations expired. Please re-select the photograph and try again.',
          });
          return;
        }
        if (metaEntry.ownerUid !== user.uid) {
          res.status(403).json({ error: 'You are not authorized to attach another user\'s uploaded photograph.' });
          return;
        }
        verifiedUploads.push(metaEntry.metadata);
        // Release any remaining temporary RAM buffer for this upload immediately
        purgeTempUpload(uploadId);
      }

      // Resolve server-verified AI analysis by cryptographic token (never trust raw client AI JSON)
      const analysisToken = typeof body.analysisToken === 'string' ? body.analysisToken.trim() : '';
      let verifiedAi: (CivicImageAssessment & {
        suggestedDepartmentId: string;
        suggestedDepartmentName: string;
      }) | null = null;
      if (analysisToken) {
        const aiEntry = verifiedAiAssessments.get(analysisToken);
        if (!aiEntry) {
          res.status(400).json({
            error: 'AI analysis session expired or invalid. Please re-run AI analysis or submit without stale AI metadata.',
          });
          return;
        }
        if (aiEntry.ownerUid !== user.uid) {
          res.status(403).json({ error: 'You cannot attach another user\'s AI analysis token.' });
          return;
        }
        verifiedAi = aiEntry.assessment;
      }

      console.log(
        `[POST /api/reports stage] uid=${user.uid} role=${user.role} uploadIds=${uniqueUploadIds.length} hasAnalysisToken=${Boolean(analysisToken)}`
      );

      const gmailAccessToken = extractGmailAccessToken(req);
      const executeCreation = createVerifiedCivicReportServerSide(
        user,
        {
          title: String(body.title || ''),
          description: String(body.description || ''),
          category: String(body.category || ''),
          addressText: String(body.addressText || ''),
          wardOrZone: typeof body.wardOrZone === 'string' ? body.wardOrZone : '',
          latitude: Number(body.latitude),
          longitude: Number(body.longitude),
          uploads: verifiedUploads,
          verifiedAi,
        },
        { gmailAccessToken }
      );

      if (scopedIdempotencyKey) {
        inFlightReportSubmissions.set(scopedIdempotencyKey, executeCreation);
      }

      let outcome;
      try {
        outcome = await executeCreation;
      } finally {
        if (scopedIdempotencyKey) {
          inFlightReportSubmissions.delete(scopedIdempotencyKey);
        }
      }

      if (scopedIdempotencyKey) {
        if (completedReportSubmissions.size >= 300) {
          const oldestKey = completedReportSubmissions.keys().next().value;
          if (oldestKey) completedReportSubmissions.delete(oldestKey);
        }
        completedReportSubmissions.set(scopedIdempotencyKey, {
          fingerprint: requestFingerprint,
          outcome,
          expiresAtMs: Date.now() + SESSION_META_TTL_MS,
        });
      }

      // Clean up temporary upload metadata & consumed AI token after successful save
      for (const uploadId of uniqueUploadIds) {
        validatedUploadMetadata.delete(uploadId);
      }
      if (analysisToken) {
        verifiedAiAssessments.delete(analysisToken);
      }

      console.log(
        `[POST /api/reports committed] uid=${user.uid} reportId=${outcome.reportId} dept=${outcome.departmentId} uploads=${verifiedUploads.length}`
      );

      res.status(201).json({
        ok: true,
        ...outcome,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to submit civic report.';
      const isPermDenied = msg.includes('PERMISSION_DENIED') || msg.includes('(403)');
      const status = msg.includes('Verified Google email')
        ? 403
        : isPermDenied
          ? 422
          : msg.includes('must be') ||
              msg.includes('Unsupported') ||
              msg.includes('Invalid') ||
              msg.includes('maximum')
            ? 400
            : 500;
      console.error('[POST /api/reports error]', status, scrubLogText(msg));
      res.status(status).json({
        error: scrubLogText(msg),
        ...(isPermDenied ? { code: 'DATABASE_PERMISSION_DENIED', upstreamStatus: 403 } : {}),
      });
    }
  });

  app.post('/api/reports/:reportId/ai-analysis', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      purgeExpiredTempUploads();
      const user = req.user!;
      const reportId = String(req.params.reportId || '').trim();
      const analysisToken = typeof req.body?.analysisToken === 'string' ? req.body.analysisToken.trim() : '';
      if (!analysisToken) {
        res.status(400).json({ error: 'Verified server analysisToken is required.' });
        return;
      }
      const aiEntry = verifiedAiAssessments.get(analysisToken);
      if (!aiEntry) {
        res.status(400).json({ error: 'AI analysis token expired or invalid. Please re-analyze the photograph.' });
        return;
      }
      if (aiEntry.ownerUid !== user.uid) {
        res.status(403).json({ error: 'Unauthorized AI analysis token.' });
        return;
      }

      const result = await attachVerifiedAiAnalysisServerSide(user, {
        reportId,
        verifiedAi: aiEntry.assessment,
      });
      verifiedAiAssessments.delete(analysisToken);

      res.status(200).json({ ok: true, ...result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to attach AI analysis to report.';
      const isPermDenied = msg.includes('PERMISSION_DENIED') || msg.includes('(403)');
      const status = msg.includes('not found')
        ? 404
        : msg.includes('Only the reporting citizen')
          ? 403
          : isPermDenied
            ? 422
            : msg.includes('already attached')
              ? 409
              : msg.includes('Invalid')
                ? 400
                : 500;
      res.status(status).json({
        error: scrubLogText(msg),
        ...(isPermDenied ? { code: 'DATABASE_PERMISSION_DENIED', upstreamStatus: 403 } : {}),
      });
    }
  });

  // ------------------------------------------------------------------
  // 3. Server-Side Duplicate Report Detection (Advisory Only)
  // ------------------------------------------------------------------
  app.post('/api/ai/detect-duplicates', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const {
        reportId = '',
        title = '',
        description = '',
        aiDescription = '',
        category = 'other',
        latitude = 0,
        longitude = 0,
        createdAtIso,
      } = req.body || {};

      if (
        typeof latitude !== 'number' ||
        typeof longitude !== 'number' ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude)
      ) {
        res.status(400).json({ error: 'Valid numeric latitude and longitude are required.' });
        return;
      }

      const targetHasValidCoords =
        latitude >= -90 &&
        latitude <= 90 &&
        longitude >= -180 &&
        longitude <= 180 &&
        !(latitude === 0 && longitude === 0);

      const targetTimeMs = createdAtIso ? Date.parse(createdAtIso) : Date.now();
      const targetText = `${title} ${description}`.trim();
      const targetAiText = String(aiDescription || '').trim();

      const accessibleReports = await fetchAccessibleReportsForDuplicates(user);

      const scored = accessibleReports
        .filter((r) => r.id !== reportId)
        .map((candidate) => {
          const candHasValidCoords =
            Number.isFinite(candidate.latitude) &&
            Number.isFinite(candidate.longitude) &&
            candidate.latitude >= -90 &&
            candidate.latitude <= 90 &&
            candidate.longitude >= -180 &&
            candidate.longitude <= 180 &&
            !(candidate.latitude === 0 && candidate.longitude === 0);

          const distanceMeters =
            targetHasValidCoords && candHasValidCoords
              ? haversineDistanceMeters(latitude, longitude, candidate.latitude, candidate.longitude)
              : -1;

          const geoScore =
            distanceMeters < 0
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

          const categoryMatch = candidate.category === category ? 1 : 0;
          const textSimilarity = jaccardSimilarity(targetText, `${candidate.title} ${candidate.description}`);
          const aiImageSimilarity =
            targetAiText && candidate.aiDescription
              ? jaccardSimilarity(targetAiText, candidate.aiDescription)
              : 0;
          const hasBothAi = Boolean(targetAiText && candidate.aiDescription);

          const candidateMs = Date.parse(candidate.createdAtIso) || targetTimeMs;
          const timeDeltaHours = Math.round(Math.abs(targetTimeMs - candidateMs) / (1000 * 60 * 60));
          const timeScore = timeDeltaHours <= 48 ? 1.0 : timeDeltaHours <= 168 ? 0.75 : timeDeltaHours <= 720 ? 0.45 : 0.15;

          const overallScore = Number(
            (hasBothAi
              ? geoScore * 0.36 +
                categoryMatch * 0.22 +
                textSimilarity * 0.2 +
                aiImageSimilarity * 0.12 +
                timeScore * 0.1
              : geoScore * 0.42 +
                categoryMatch * 0.25 +
                textSimilarity * 0.23 +
                timeScore * 0.1
            ).toFixed(2)
          );

          const reasons: string[] = [];
          if (distanceMeters >= 0 && distanceMeters <= 250) reasons.push(`within ${distanceMeters}m`);
          if (categoryMatch) reasons.push('same category');
          if (textSimilarity >= 0.2) reasons.push(`${Math.round(textSimilarity * 100)}% text overlap`);
          if (aiImageSimilarity >= 0.2) reasons.push(`${Math.round(aiImageSimilarity * 100)}% AI image-note overlap`);
          if (timeDeltaHours <= 168) reasons.push(`reported ${timeDeltaHours}h apart`);

          return {
            reportId: candidate.id,
            trackingCode: candidate.trackingCode,
            title: candidate.title,
            description: candidate.description,
            aiDescription: candidate.aiDescription,
            category: candidate.category,
            status: candidate.status,
            addressText: candidate.addressText,
            distanceMeters: distanceMeters >= 0 ? distanceMeters : 999999,
            textSimilarity: Number(textSimilarity.toFixed(2)),
            aiImageSimilarity: Number(aiImageSimilarity.toFixed(2)),
            timeDeltaHours,
            overallScore,
            scoreBreakdown: {
              geoScore: Number(geoScore.toFixed(2)),
              categoryMatch,
              textSimilarity: Number(textSimilarity.toFixed(2)),
              aiImageSimilarity: Number(aiImageSimilarity.toFixed(2)),
              timeScore: Number(timeScore.toFixed(2)),
            },
            matchReason: reasons.length > 0 ? reasons.join(' · ') : 'Regional category similarity',
            createdAtIso: candidate.createdAtIso,
          };
        })
        .filter(
          (c) =>
            c.overallScore >= 0.32 ||
            (c.distanceMeters <= 150 && c.category === category) ||
            (c.aiImageSimilarity >= 0.35 && c.category === category)
        )
        .sort((a, b) => b.overallScore - a.overallScore)
        .slice(0, 5);

      // Optional Gemini semantic refinement for top candidates when API key is available
      if (scored.length > 0 && process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY') {
        const semanticMap = await refineDuplicateMatchWithGemini(
          { title, description, category, aiDescription: targetAiText || undefined },
          scored.slice(0, 3).map((s) => ({
            reportId: s.reportId,
            title: s.title,
            description: s.description,
            category: s.category,
            aiDescription: s.aiDescription || undefined,
          }))
        );
        for (const item of scored) {
          const sem = semanticMap[item.reportId];
          if (sem) {
            const blended = Number(Math.min(0.99, item.overallScore * 0.75 + sem.semanticScore * 0.25).toFixed(2));
            item.overallScore = blended;
            if (sem.reason) {
              item.matchReason = `${item.matchReason} · ${sem.reason}`;
            }
          }
        }
        scored.sort((a, b) => b.overallScore - a.overallScore);
      }

      res.json({
        advisoryOnly: true,
        scope: user.role === 'citizen' ? 'personal_reports_only' : 'authorized_staff_records',
        candidates: scored.map(({ description: _desc, ...rest }) => rest),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Duplicate analysis failed.';
      res.status(500).json({ error: msg });
    }
  });

  // ------------------------------------------------------------------
  // 3b. Server-Side Gemini AI Trend Intelligence (Admin Only, Anonymized)
  // ------------------------------------------------------------------
  app.post(
    '/api/ai/trend-intelligence',
    requireAuth,
    requireRole(['admin']),
    async (req: AuthenticatedRequest, res) => {
      try {
        const body = req.body;
        if (!body || typeof body !== 'object' || typeof body.totalReports !== 'number') {
          res.status(400).json({ error: 'Valid aggregated trend digest payload is required.' });
          return;
        }

        const totalReports = Math.max(0, Math.round(body.totalReports));
        const categoryBreakdown = Array.isArray(body.categoryBreakdown) ? body.categoryBreakdown.slice(0, 15) : [];
        const statusBreakdown =
          body.statusBreakdown && typeof body.statusBreakdown === 'object' ? body.statusBreakdown : {};
        const reopenedCount = Number(statusBreakdown.reopened || 0);
        const topCategories = categoryBreakdown
          .map((c: any) => ({
            category: String(c?.category || 'other'),
            count: Number(c?.count || 0),
          }))
          .filter((c: { category: string; count: number }) => c.count > 0)
          .sort((a: { count: number }, b: { count: number }) => b.count - a.count)
          .slice(0, 5);

        if (totalReports === 0) {
          res.status(200).json({
            observedFacts: {
              totalReports: 0,
              topCategories: [],
              reopenedCount: 0,
              lowSampleWarning: true,
              summary: 'No civic reports exist in Supabase PostgreSQL yet to derive municipal trends.',
            },
            frequentlyReportedIssues: [],
            emergingPatterns: [],
            areasWithIncreasingComplaints: [],
            recurringInfrastructureProblems: [],
            preventiveMaintenancePriorities: [],
            administratorRecommendations: [
              'Collect initial citizen submissions before running AI trend intelligence.',
            ],
            advisoryNotice:
              'Observed metrics reflect live database counts. No AI patterns can be generated without records.',
            generatedAtIso: new Date().toISOString(),
            modelUsed: 'deterministic-empty-guard',
          });
          return;
        }

        const sanitizedSamples = Array.isArray(body.anonymizedSamples)
          ? body.anonymizedSamples.slice(0, 60).map((s: any) => ({
              trackingCode: scrubLogText(String(s?.trackingCode || '')).slice(0, 40),
              category: String(s?.category || 'other').slice(0, 40),
              priority: String(s?.priority || 'medium').slice(0, 20),
              status: String(s?.status || 'submitted').slice(0, 30),
              zone: scrubLogText(String(s?.zone || 'Unspecified zone')).slice(0, 80),
              ageHours: Math.max(0, Math.round(Number(s?.ageHours || 0))),
              summary: scrubLogText(String(s?.summary || '')).slice(0, 200),
              aiSummary: s?.aiSummary ? scrubLogText(String(s.aiSummary)).slice(0, 180) : undefined,
            }))
          : [];

        const digest = {
          totalReports,
          statusBreakdown,
          categoryBreakdown: categoryBreakdown.map((c: any) => ({
            category: String(c?.category || 'other').slice(0, 40),
            count: Number(c?.count || 0),
            openCount: Number(c?.openCount || 0),
            reopenedCount: Number(c?.reopenedCount || 0),
          })),
          zoneBreakdown: Array.isArray(body.zoneBreakdown)
            ? body.zoneBreakdown.slice(0, 25).map((z: any) => ({
                zone: scrubLogText(String(z?.zone || 'Unspecified')).slice(0, 80),
                count: Number(z?.count || 0),
                categories: Array.isArray(z?.categories)
                  ? z.categories.map((cat: any) => String(cat).slice(0, 40)).slice(0, 10)
                  : [],
              }))
            : [],
          departmentBreakdown: Array.isArray(body.departmentBreakdown)
            ? body.departmentBreakdown.slice(0, 20).map((d: any) => ({
                department: scrubLogText(String(d?.department || 'Unassigned')).slice(0, 80),
                assigned: Number(d?.assigned || 0),
                resolved: Number(d?.resolved || 0),
                pending: Number(d?.pending || 0),
              }))
            : [],
          weeklyCounts: Array.isArray(body.weeklyCounts) ? body.weeklyCounts.slice(0, 12) : [],
          monthlyCounts: Array.isArray(body.monthlyCounts) ? body.monthlyCounts.slice(0, 12) : [],
          anonymizedSamples: sanitizedSamples,
        };

        const { result, modelUsed } = await analyzeMunicipalTrendsWithGemini(digest);

        res.status(200).json({
          observedFacts: {
            totalReports,
            topCategories,
            reopenedCount,
            lowSampleWarning: totalReports < 5,
            summary: result.observedSummary,
          },
          frequentlyReportedIssues: result.frequentlyReportedIssues,
          emergingPatterns: result.emergingPatterns,
          areasWithIncreasingComplaints: result.areasWithIncreasingComplaints,
          recurringInfrastructureProblems: result.recurringInfrastructureProblems,
          preventiveMaintenancePriorities: result.preventiveMaintenancePriorities,
          administratorRecommendations: result.administratorRecommendations,
          advisoryNotice:
            'Observed counts reflect live Supabase PostgreSQL records. Patterns, preventive priorities, and recommendations are advisory Gemini AI interpretations requiring human engineering review. Zero citizen PII was transmitted.',
          generatedAtIso: new Date().toISOString(),
          modelUsed,
        });
      } catch (err: unknown) {
        const mapped = extractGeminiError(err);
        console.error('[AI trend-intelligence error]', mapped.status, scrubLogText(mapped.message));
        res.status(mapped.status).json({ error: mapped.message });
      }
    }
  );

  // ------------------------------------------------------------------
  // 4. Server-Side Workflow Transition & Authorization Validator
  // ------------------------------------------------------------------
  app.post('/api/reports/validate-transition', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const {
        reportId,
        fromStatus,
        toStatus,
        reason,
        action,
        rating,
        departmentId,
        officerId,
        workerId,
        expectedWorkerId,
        deadlineIso,
        supervisorId,
      } = req.body || {};

      const allowedTransitions: Record<string, Record<string, Array<UserRole>>> = {
        submitted: {
          submitted: ['admin', 'officer'],
          under_review: ['admin', 'officer'],
          verified: ['admin'],
          rejected: ['admin'],
        },
        under_review: {
          under_review: ['admin', 'officer', 'citizen'],
          verified: ['admin'],
          rejected: ['admin', 'officer'],
        },
        verified: {
          verified: ['admin', 'officer'],
          under_review: ['admin', 'officer'],
          assigned: ['admin', 'officer'],
          rejected: ['admin', 'officer'],
        },
        assigned: {
          assigned: ['admin', 'officer', 'worker'],
          in_progress: ['admin', 'officer', 'worker'],
          resolved: ['admin', 'officer'],
          rejected: ['admin', 'officer'],
        },
        in_progress: {
          assigned: ['admin', 'officer'],
          in_progress: ['admin', 'officer', 'worker'],
          resolved: ['admin', 'officer'],
          rejected: ['admin', 'officer'],
        },
        resolved: {
          resolved: ['admin', 'officer'],
          citizen_confirmed: ['citizen', 'admin'],
          reopened: ['citizen', 'admin'],
          in_progress: ['admin', 'officer'],
          rejected: ['admin'],
        },
        citizen_confirmed: {
          citizen_confirmed: ['citizen', 'admin'],
        },
        reopened: {
          reopened: ['admin', 'officer'],
          under_review: ['admin', 'officer'],
          verified: ['admin'],
          assigned: ['admin', 'officer'],
          in_progress: ['admin', 'officer', 'worker'],
          rejected: ['admin', 'officer'],
        },
      };

      const nextMap = allowedTransitions[fromStatus];
      if (!nextMap || !nextMap[toStatus]) {
        res.status(400).json({ valid: false, error: `Invalid status transition from '${fromStatus}' to '${toStatus}'.` });
        return;
      }

      if (fromStatus === 'citizen_confirmed' && action !== 'submit_feedback') {
        res.status(400).json({
          valid: false,
          error: 'Closed confirmed reports can only accept post-confirmation citizen feedback.',
        });
        return;
      }

      if (action === 'submit_feedback') {
        if (fromStatus !== 'citizen_confirmed' || toStatus !== 'citizen_confirmed') {
          res.status(400).json({
            valid: false,
            error: 'Citizen feedback can only be submitted after resolution is confirmed.',
          });
          return;
        }
        if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
          res.status(400).json({
            valid: false,
            error: 'Citizen feedback rating must be an integer between 1 and 5.',
          });
          return;
        }
      }

      if (!nextMap[toStatus].includes(user.role)) {
        res.status(403).json({
          valid: false,
          error: `Role '${user.role}' cannot transition a report from '${fromStatus}' to '${toStatus}'.`,
        });
        return;
      }

      // Action-specific RBAC guards (prevent unauthorized roles from privileged actions)
      if (
        (action === 'verify' || action === 'assign_department' || action === 'correct_ai') &&
        user.role !== 'admin'
      ) {
        res.status(403).json({
          valid: false,
          error: `Only authorized administrators can perform '${action}'. Current role: '${user.role}'.`,
        });
        return;
      }

      if (
        (action === 'request_more_info' ||
          action === 'approve_completion' ||
          action === 'reject_evidence' ||
          action === 'return_in_progress' ||
          action === 'escalate_overdue') &&
        user.role !== 'admin' &&
        user.role !== 'officer'
      ) {
        res.status(403).json({
          valid: false,
          error: `Role '${user.role}' is not authorized to perform '${action}'.`,
        });
        return;
      }

      if (action === 'assign_worker' && user.role !== 'admin' && user.role !== 'officer') {
        res.status(403).json({
          valid: false,
          error: `Role '${user.role}' cannot dispatch field workers.`,
        });
        return;
      }

      if (
        (toStatus === 'rejected' ||
          toStatus === 'reopened' ||
          action === 'request_more_info' ||
          action === 'reject_evidence' ||
          action === 'return_in_progress' ||
          action === 'worker_obstacle' ||
          action === 'worker_request_assistance' ||
          action === 'citizen_clarification') &&
        (!reason || String(reason).trim().length < 3)
      ) {
        res.status(400).json({
          valid: false,
          error: `A clear explanation (at least 3 characters) is required for '${action || toStatus}'.`,
        });
        return;
      }

      if (
        (action === 'worker_submit_verification' || action === 'worker_progress') &&
        (!reason || String(reason).trim().length < 5)
      ) {
        res.status(400).json({
          valid: false,
          error: 'Field workers must provide a clear work or completion description (at least 5 characters).',
        });
        return;
      }

      const authCheck = await verifyReportTransitionAuthorization(user, {
        reportId: typeof reportId === 'string' ? reportId : undefined,
        fromStatus: String(fromStatus),
        toStatus: String(toStatus),
        action: typeof action === 'string' ? action : undefined,
        departmentId: typeof departmentId === 'string' ? departmentId : undefined,
        officerId: typeof officerId === 'string' ? officerId : undefined,
        workerId: typeof workerId === 'string' ? workerId : undefined,
        expectedWorkerId: typeof expectedWorkerId === 'string' ? expectedWorkerId : undefined,
        deadlineIso: typeof deadlineIso === 'string' ? deadlineIso : undefined,
        supervisorId: typeof supervisorId === 'string' ? supervisorId : undefined,
      });

      if (!authCheck.ok) {
        res.status(authCheck.statusCode).json({
          valid: false,
          error: authCheck.error || 'Workflow authorization check failed.',
        });
        return;
      }

      res.json({ valid: true, actorRole: user.role, fromStatus, toStatus, action: action || null });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to validate report workflow transition.';
      res.status(500).json({ valid: false, error: msg });
    }
  });

  // ------------------------------------------------------------------
  // 4b. Supabase PostgreSQL Workspace, Workflow, SLA, Alerts & Civic Community Routes
  // ------------------------------------------------------------------
  app.get('/api/workspace', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const snapshot = await fetchWorkspaceSnapshotSupabase(req.user!);
      res.json({ ok: true, ...snapshot });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load workspace snapshot.';
      res.status(500).json({ error: scrubLogText(msg) });
    }
  });

  app.get('/api/reports/:reportId/detail', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const reportId = String(req.params.reportId || '').trim();
      const bundle = await fetchReportDetailBundleSupabase(req.user!, reportId);
      if (!bundle) {
        res.status(404).json({ error: 'Civic report not found.' });
        return;
      }
      res.json({ ok: true, ...bundle });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load report details.';
      const status = msg.includes('PERMISSION_DENIED') || msg.includes('not authorized')
        ? 403
        : msg.includes('Invalid')
          ? 400
          : 500;
      res.status(status).json({ error: scrubLogText(msg) });
    }
  });

  app.post('/api/reports/:reportId/workflow', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const reportId = String(req.params.reportId || '').trim();
      const body = req.body || {};
      const result = await executeReportWorkflowActionSupabase(req.user!, reportId, body);
      res.json({ ...result, ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to execute report workflow action.';
      const status =
        msg.includes('not found') || msg.includes('does not exist')
          ? 404
          : msg.includes('Only ') || msg.includes('not authorized') || msg.includes('PERMISSION_DENIED')
            ? 403
            : msg.includes('Invalid') || msg.includes('required') || msg.includes('must') || msg.includes('already') || msg.includes('cannot')
              ? 400
              : 500;
      res.status(status).json({ error: scrubLogText(msg) });
    }
  });

  app.get(
    '/api/admin/citizens/:reporterId/contact',
    requireAuth,
    requireRole(['admin']),
    async (req: AuthenticatedRequest, res) => {
      try {
        const reporterId = String(req.params.reporterId || '').trim();
        const contact = await fetchCitizenContactForAdminSupabase(req.user!, reporterId);
        res.json({ ok: true, contact });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to fetch citizen contact.';
        res.status(msg.includes('Only administrators') ? 403 : 500).json({ error: scrubLogText(msg) });
      }
    }
  );

  app.post(
    '/api/admin/departments/seed',
    requireAuth,
    requireRole(['admin']),
    async (req: AuthenticatedRequest, res) => {
      try {
        await ensureCanonicalDepartmentsExist(req.user!.uid);
        res.json({ ok: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to seed departments.';
        res.status(500).json({ error: scrubLogText(msg) });
      }
    }
  );

  app.post(
    '/api/admin/departments',
    requireAuth,
    requireRole(['admin']),
    async (req: AuthenticatedRequest, res) => {
      try {
        const department = await adminSaveDepartmentSupabase(req.user!, {
          id: typeof req.body?.id === 'string' ? req.body.id : undefined,
          name: String(req.body?.name || ''),
          code: String(req.body?.code || ''),
          description: String(req.body?.description || ''),
          categories: Array.isArray(req.body?.categories) ? req.body.categories : [],
          officerIds: Array.isArray(req.body?.officerIds) ? req.body.officerIds : [],
          active: req.body?.active !== false,
        });
        res.json({ ok: true, department });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to save department.';
        res.status(msg.includes('Only administrators') ? 403 : 400).json({ error: scrubLogText(msg) });
      }
    }
  );

  app.post(
    '/api/admin/public-reports/sync',
    requireAuth,
    requireRole(['admin']),
    async (req: AuthenticatedRequest, res) => {
      try {
        const synced = await syncMissingPublicReportsSupabase(req.user!);
        res.json({ ok: true, synced });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to sync public reports.';
        res.status(500).json({ error: scrubLogText(msg) });
      }
    }
  );

  app.post(
    '/api/assignments/:assignmentId/location',
    requireAuth,
    async (req: AuthenticatedRequest, res) => {
      try {
        const assignmentId = String(req.params.assignmentId || '').trim();
        await updateWorkerLocationSharingSupabase(req.user!, assignmentId, {
          active: Boolean(req.body?.active),
          lat: typeof req.body?.lat === 'number' ? req.body.lat : undefined,
          lng: typeof req.body?.lng === 'number' ? req.body.lng : undefined,
        });
        res.json({ ok: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to update location sharing.';
        const status = msg.includes('not found') ? 404 : msg.includes('Only the assigned') ? 403 : 400;
        res.status(status).json({ error: scrubLogText(msg) });
      }
    }
  );

  app.post('/api/notifications/read', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const ids = Array.isArray(req.body?.notificationIds)
        ? req.body.notificationIds.map((v: unknown) => String(v || '').trim()).filter(Boolean)
        : [];
      await markNotificationsReadSupabase(req.user!, ids);
      res.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to mark notifications read.';
      res.status(500).json({ error: scrubLogText(msg) });
    }
  });

  app.post(
    '/api/admin/sla-policies',
    requireAuth,
    requireRole(['admin']),
    async (req: AuthenticatedRequest, res) => {
      try {
        const policyId = await saveSlaPolicySupabase(req.user!, {
          scopeType: req.body?.scopeType || 'global',
          departmentId: String(req.body?.departmentId || ''),
          departmentName: typeof req.body?.departmentName === 'string' ? req.body.departmentName : '',
          category: String(req.body?.category || ''),
          ackTargetHours: Number(req.body?.ackTargetHours || 4),
          assignTargetHours: Number(req.body?.assignTargetHours || 12),
          resolveTargetHours: Number(req.body?.resolveTargetHours || 48),
          escalationRole: req.body?.escalationRole === 'officer' ? 'officer' : 'admin',
        });
        res.json({ ok: true, policyId });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to save SLA policy.';
        res.status(msg.includes('Only administrators') ? 403 : 400).json({ error: scrubLogText(msg) });
      }
    }
  );

  app.post(
    '/api/operational-alerts/sync',
    requireAuth,
    requireRole(['admin', 'officer']),
    async (req: AuthenticatedRequest, res) => {
      try {
        const candidates = Array.isArray(req.body?.candidates) ? req.body.candidates : [];
        const created = await syncOperationalAlertsSupabase(req.user!, candidates);
        res.json({ ok: true, created });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to sync operational alerts.';
        res.status(500).json({ error: scrubLogText(msg) });
      }
    }
  );

  app.post(
    '/api/operational-alerts/:alertId/acknowledge',
    requireAuth,
    requireRole(['admin', 'officer']),
    async (req: AuthenticatedRequest, res) => {
      try {
        const alertId = String(req.params.alertId || '').trim();
        await acknowledgeOperationalAlertSupabase(req.user!, alertId);
        res.json({ ok: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to acknowledge alert.';
        res.status(msg.includes('Only staff') ? 403 : 400).json({ error: scrubLogText(msg) });
      }
    }
  );

  app.post('/api/ngos', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const ngoId = await registerNgoOrganizationSupabase(req.user!, {
        name: String(req.body?.name || ''),
        registrationNumber: String(req.body?.registrationNumber || ''),
        focusAreas: Array.isArray(req.body?.focusAreas) ? req.body.focusAreas : [],
        operatingCityOrWard: String(req.body?.operatingCityOrWard || ''),
        description: String(req.body?.description || ''),
        contactEmail: String(req.body?.contactEmail || ''),
        contactPhone: typeof req.body?.contactPhone === 'string' ? req.body.contactPhone : '',
      });
      res.status(201).json({ ok: true, ngoId });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to register NGO organization.';
      res.status(400).json({ error: scrubLogText(msg) });
    }
  });

  app.post(
    '/api/ngos/:ngoId/review',
    requireAuth,
    requireRole(['admin']),
    async (req: AuthenticatedRequest, res) => {
      try {
        const ngoId = String(req.params.ngoId || '').trim();
        const decision = req.body?.decision === 'approved' ? 'approved' : 'rejected';
        await reviewNgoOrganizationSupabase(req.user!, ngoId, {
          decision,
          reviewNote: String(req.body?.reviewNote || ''),
        });
        res.json({ ok: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to review NGO organization.';
        res.status(msg.includes('not found') ? 404 : 400).json({ error: scrubLogText(msg) });
      }
    }
  );

  app.put('/api/volunteer-profile', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      await upsertVolunteerProfileSupabase(req.user!, {
        skills: Array.isArray(req.body?.skills) ? req.body.skills : [],
        serviceArea: String(req.body?.serviceArea || ''),
        availability: String(req.body?.availability || ''),
        active: req.body?.active !== false,
      });
      res.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save volunteer profile.';
      res.status(400).json({ error: scrubLogText(msg) });
    }
  });

  app.post('/api/activities', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const activityId = await publishCivicActivitySupabase(req.user!, {
        ngoId: String(req.body?.ngoId || ''),
        title: String(req.body?.title || ''),
        description: String(req.body?.description || ''),
        category: String(req.body?.category || 'community_cleanup'),
        locationLabel: String(req.body?.locationLabel || ''),
        wardOrZone: typeof req.body?.wardOrZone === 'string' ? req.body.wardOrZone : '',
        scheduledDateIso: String(req.body?.scheduledDateIso || ''),
        maxVolunteers: Number(req.body?.maxVolunteers || 25),
        relatedReportId: typeof req.body?.relatedReportId === 'string' ? req.body.relatedReportId : '',
      });
      res.status(201).json({ ok: true, activityId });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to publish civic activity.';
      const status = msg.includes('not found') ? 404 : msg.includes('Only the NGO') ? 403 : 400;
      res.status(status).json({ error: scrubLogText(msg) });
    }
  });

  app.post(
    '/api/activities/:activityId/review',
    requireAuth,
    requireRole(['admin']),
    async (req: AuthenticatedRequest, res) => {
      try {
        const activityId = String(req.params.activityId || '').trim();
        const decision = req.body?.decision === 'approved' ? 'approved' : 'rejected';
        await reviewCivicActivitySupabase(req.user!, activityId, {
          decision,
          reviewNote: String(req.body?.reviewNote || ''),
        });
        res.json({ ok: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to review civic activity.';
        res.status(msg.includes('not found') ? 404 : 400).json({ error: scrubLogText(msg) });
      }
    }
  );

  app.post('/api/activities/:activityId/complete', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const activityId = String(req.params.activityId || '').trim();
      await submitCivicActivityCompletionSupabase(req.user!, activityId, {
        completionSummary: String(req.body?.completionSummary || ''),
        completionPhotoMetadata: Array.isArray(req.body?.completionPhotoMetadata)
          ? req.body.completionPhotoMetadata
          : [],
      });
      res.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to submit activity completion.';
      const status = msg.includes('not found') ? 404 : msg.includes('Only the organizing') ? 403 : 400;
      res.status(status).json({ error: scrubLogText(msg) });
    }
  });

  app.post('/api/activities/:activityId/join', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const activityId = String(req.params.activityId || '').trim();
      await joinCivicActivitySupabase(
        req.user!,
        activityId,
        typeof req.body?.note === 'string' ? req.body.note : ''
      );
      res.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to join civic activity.';
      const status = msg.includes('not found') ? 404 : 400;
      res.status(status).json({ error: scrubLogText(msg) });
    }
  });

  app.post('/api/activities/:activityId/withdraw', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const activityId = String(req.params.activityId || '').trim();
      await withdrawFromCivicActivitySupabase(req.user!, activityId);
      res.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to withdraw from civic activity.';
      res.status(400).json({ error: scrubLogText(msg) });
    }
  });

  // ------------------------------------------------------------------
  // 5. Guarantee Structured JSON for Unmatched /api Routes & API Errors
  // ------------------------------------------------------------------
  app.use('/api', (req, res) => {
    res.status(404).json({
      success: false,
      error: `API endpoint not found: ${req.method} ${req.originalUrl}`,
    });
  });

  app.use(
    '/api',
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      if (res.headersSent) return;
      if (err instanceof SyntaxError && 'body' in err) {
        res.status(400).json({ success: false, error: 'Malformed JSON request body.' });
        return;
      }
      if (err instanceof multer.MulterError) {
        const isSize = err.code === 'LIMIT_FILE_SIZE';
        res.status(isSize ? 413 : 400).json({
          success: false,
          error: isSize
            ? 'File too large. Maximum allowed image size is 5 MB.'
            : err.message || 'Invalid multipart upload payload.',
        });
        return;
      }
      const status = typeof err?.status === 'number' && err.status >= 400 ? err.status : 500;
      res.status(status).json({
        success: false,
        error: err instanceof Error ? scrubLogText(err.message) : 'Unexpected server error.',
      });
    }
  );

  // Explicit pre-Vite / static guard so no /api request can ever fall through to HTML
  app.use((req, res, next) => {
    if (
      req.path === '/api' ||
      req.path.startsWith('/api/') ||
      req.originalUrl === '/api' ||
      req.originalUrl.startsWith('/api/') ||
      req.originalUrl.startsWith('/api?')
    ) {
      res.status(404).json({
        success: false,
        error: `API endpoint not found: ${req.method} ${req.originalUrl}`,
      });
      return;
    }
    next();
  });

  // ------------------------------------------------------------------
  // 6. Vite Middleware (Dev) or Static Assets (Production)
  // ------------------------------------------------------------------
  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (req, res) => {
      if (req.path === '/api' || req.path.startsWith('/api/')) {
        res.status(404).json({
          success: false,
          error: `API endpoint not found: ${req.method} ${req.originalUrl}`,
        });
        return;
      }
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : undefined,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CivicFix AI server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start CivicFix AI server:', err);
  process.exit(1);
});
