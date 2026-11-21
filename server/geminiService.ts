import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const ALLOWED_CATEGORIES = [
  'pothole',
  'garbage',
  'streetlight',
  'water_leakage',
  'drainage',
  'damaged_infrastructure',
  'public_park_damage',
  'other',
] as const;

const ALLOWED_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
const ALLOWED_QUALITIES = ['clear', 'partially_obscured', 'unclear', 'insufficient'] as const;

export type AllowedCategory = (typeof ALLOWED_CATEGORIES)[number];
export type AllowedPriority = (typeof ALLOWED_PRIORITIES)[number];
export type AllowedQuality = (typeof ALLOWED_QUALITIES)[number];

export interface CivicImageAssessment {
  detectedIssue: string;
  suggestedCategory: AllowedCategory;
  factualDescription: string;
  visibleEvidence: string[];
  suggestedPriority: AllowedPriority;
  priorityExplanation: string;
  recommendedAction: string;
  confidenceScore: number;
  imageQualityStatus: AllowedQuality;
  requiresHumanReview: boolean;
  reviewReason: string;
  category: AllowedCategory;
  imageDescription: string;
  confidence: number;
  uncertaintyReason: string;
  humanReviewRequired: boolean;
  advisoryOnly: true;
  modelUsed: string;
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const GEMINI_PRIMARY_IMAGE_TIMEOUT_MS = 18_000;
const GEMINI_FALLBACK_IMAGE_TIMEOUT_MS = 20_000;
const GEMINI_DUPLICATE_TIMEOUT_MS = 15_000;
const GEMINI_TREND_TIMEOUT_MS = 45_000;

function isTransientGeminiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('Gemini AI request timed out')) {
    return false;
  }
  return (
    msg.includes('503') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('fetch failed')
  );
}

function shouldFallbackImageModel(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes('GEMINI_API_KEY is not configured') ||
    msg.includes('API_KEY_INVALID') ||
    msg.includes('PERMISSION_DENIED') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('429') ||
    msg.includes('INVALID_ARGUMENT')
  ) {
    return false;
  }
  return (
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('abort') ||
    msg.includes('503') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('NOT_FOUND') ||
    msg.includes('404') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('fetch failed')
  );
}

async function callWithTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      fn(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error(`Gemini AI request timed out after ${Math.round(timeoutMs / 1000)}s.`));
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    if (timedOut) {
      throw new Error(`Gemini AI request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function analyzeCivicIssueImage(
  imageBuffer: Buffer,
  mimeType: string,
  userHint?: string
): Promise<CivicImageAssessment> {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new Error('Invalid image buffer provided for AI analysis.');
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
    throw new Error(`Unsupported image MIME type for AI analysis: ${mimeType}`);
  }

  const ai = getGeminiClient();
  const base64Data = imageBuffer.toString('base64');

  const systemInstruction = `You are a municipal civic infrastructure triage assistant.
Analyze ONLY what is visibly observable in the uploaded photograph.
Never claim unverified facts or make official enforcement decisions.
Your output is strictly advisory for human staff and citizens.

Rules:
1. Choose the single closest civic category from: pothole, garbage, streetlight, water_leakage, drainage, damaged_infrastructure, public_park_damage, other.
2. Provide a short 3-8 word label in detectedIssue summarizing the visible problem.
3. Write a concise, strictly factual description of what is visible in the photo (1-2 sentences). Mention uncertainty if lighting, angle, distance, or blur obscures key details.
4. List 1-4 concise, objective visibleEvidence clues directly observed in the image (for example: "Standing muddy water covering right lane", "Cracked asphalt edge with exposed gravel").
5. Suggest a priority level (low, medium, high, critical) and briefly explain the reasoning based on visible public safety impact or active hazard.
6. Provide a concise recommendedAction for municipal inspection or repair crews.
7. Provide a calibrated confidenceScore between 0.0 and 1.0 reflecting how clearly the photo depicts a civic issue.
8. Classify imageQualityStatus as clear, partially_obscured, unclear, or insufficient.
9. Set requiresHumanReview to true whenever confidenceScore < 0.72, imageQualityStatus is not clear, the subject is ambiguous/indoor/unrelated to public infrastructure, or safety severity is critical.`;

  const promptText = userHint
    ? `Assess this civic issue photograph. Optional reporter context (unverified): "${userHint.slice(0, 300)}"`
    : 'Assess this civic issue photograph and return structured advisory triage metadata.';

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      detectedIssue: {
        type: Type.STRING,
        description: 'Concise 3-8 word label for the visible civic issue.',
      },
      suggestedCategory: {
        type: Type.STRING,
        enum: [...ALLOWED_CATEGORIES],
        description: 'Suggested civic issue category based on visible evidence.',
      },
      factualDescription: {
        type: Type.STRING,
        description: 'Short factual description of what is visibly present in the photograph.',
      },
      visibleEvidence: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'List of concrete visual clues observed directly in the photograph.',
      },
      suggestedPriority: {
        type: Type.STRING,
        enum: [...ALLOWED_PRIORITIES],
        description: 'Advisory urgency level.',
      },
      priorityExplanation: {
        type: Type.STRING,
        description: 'Concise factual rationale for the suggested priority.',
      },
      recommendedAction: {
        type: Type.STRING,
        description: 'Recommended municipal inspection or repair action.',
      },
      confidenceScore: {
        type: Type.NUMBER,
        description: 'Calibrated confidence score from 0.0 to 1.0.',
      },
      imageQualityStatus: {
        type: Type.STRING,
        enum: [...ALLOWED_QUALITIES],
        description: 'Visual clarity assessment of the uploaded photograph.',
      },
      requiresHumanReview: {
        type: Type.BOOLEAN,
        description: 'True when human review is needed due to low confidence, unclear imagery, or high risk.',
      },
      reviewReason: {
        type: Type.STRING,
        description: 'Explanation of uncertainty, image limitations, or why human verification is recommended.',
      },
    },
    required: [
      'detectedIssue',
      'suggestedCategory',
      'factualDescription',
      'visibleEvidence',
      'suggestedPriority',
      'priorityExplanation',
      'recommendedAction',
      'confidenceScore',
      'imageQualityStatus',
      'requiresHumanReview',
      'reviewReason',
    ],
  };

  const invokeGemini = (targetModel: 'gemini-3.1-flash-lite' | 'gemini-4-hydrogen', timeoutMs: number) =>
    callWithTimeout(
      (abortSignal) =>
        ai.models.generateContent({
          model: targetModel,
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType,
                  data: base64Data,
                },
              },
              { text: promptText },
            ],
          },
          config: {
            abortSignal,
            thinkingConfig: {
              thinkingLevel:
                targetModel === 'gemini-3.1-flash-lite'
                  ? ThinkingLevel.MINIMAL
                  : ThinkingLevel.LOW,
            },
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema,
          },
        }),
      timeoutMs
    );

  let modelName: 'gemini-3.1-flash-lite' | 'gemini-4-hydrogen' = 'gemini-3.1-flash-lite';
  let response;
  try {
    response = await invokeGemini('gemini-3.1-flash-lite', GEMINI_PRIMARY_IMAGE_TIMEOUT_MS);
  } catch (firstErr) {
    if (shouldFallbackImageModel(firstErr)) {
      modelName = 'gemini-4-hydrogen';
      response = await invokeGemini('gemini-4-hydrogen', GEMINI_FALLBACK_IMAGE_TIMEOUT_MS);
    } else {
      throw firstErr;
    }
  }

  const rawText = (response.text ?? '').trim();
  if (!rawText) {
    throw new Error('Gemini returned an empty response for image analysis.');
  }

  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('Gemini returned invalid JSON structure for image analysis.');
  }

  const rawDescription = String(parsed.factualDescription || '').trim();
  if (!rawDescription) {
    throw new Error('Gemini did not return a factual visual description for the uploaded image.');
  }

  const rawPriorityExplanation = String(parsed.priorityExplanation || '').trim();
  if (!rawPriorityExplanation) {
    throw new Error('Gemini did not return a priority rationale for the uploaded image.');
  }

  const category: AllowedCategory = ALLOWED_CATEGORIES.includes(parsed.suggestedCategory)
    ? parsed.suggestedCategory
    : 'other';
  const priority: AllowedPriority = ALLOWED_PRIORITIES.includes(parsed.suggestedPriority)
    ? parsed.suggestedPriority
    : 'medium';
  const quality: AllowedQuality = ALLOWED_QUALITIES.includes(parsed.imageQualityStatus)
    ? parsed.imageQualityStatus
    : 'unclear';
  const rawConf = Number(parsed.confidenceScore);
  const confidence = Number.isFinite(rawConf) ? Math.max(0, Math.min(1, rawConf)) : 0.4;
  const lowConfidenceOrUnclear = confidence < 0.72 || quality !== 'clear';
  const requiresHumanReview = Boolean(parsed.requiresHumanReview) || lowConfidenceOrUnclear;

  const visibleEvidence = Array.isArray(parsed.visibleEvidence)
    ? parsed.visibleEvidence
        .map((item: unknown) => String(item || '').trim().slice(0, 220))
        .filter(Boolean)
        .slice(0, 8)
    : [];

  let reviewReason = String(parsed.reviewReason || '').trim();
  if (lowConfidenceOrUnclear && !reviewReason) {
    reviewReason = 'Confidence is below threshold or image clarity is limited; human verification is required before action.';
  } else if (!reviewReason) {
    reviewReason = 'Advisory AI triage only; human verification confirms final classification.';
  }

  const detectedIssue =
    String(parsed.detectedIssue || '').trim().slice(0, 160) ||
    `${category.replace(/_/g, ' ')} observation`;
  const recommendedAction =
    String(parsed.recommendedAction || '').trim().slice(0, 550) ||
    'Schedule municipal field inspection to verify site conditions.';
  const trimmedDescription = rawDescription.slice(0, 950);
  const trimmedPriorityExplanation = rawPriorityExplanation.slice(0, 550);
  const clampedConfidence = Number(confidence.toFixed(2));
  const trimmedReviewReason = reviewReason.slice(0, 480);

  return {
    detectedIssue,
    suggestedCategory: category,
    factualDescription: trimmedDescription,
    visibleEvidence,
    suggestedPriority: priority,
    priorityExplanation: trimmedPriorityExplanation,
    recommendedAction,
    confidenceScore: clampedConfidence,
    imageQualityStatus: quality,
    requiresHumanReview,
    reviewReason: trimmedReviewReason,
    category,
    imageDescription: trimmedDescription,
    confidence: clampedConfidence,
    uncertaintyReason: trimmedReviewReason,
    humanReviewRequired: requiresHumanReview,
    advisoryOnly: true,
    modelUsed: modelName,
  };
}

export async function refineDuplicateMatchWithGemini(
  target: { title: string; description: string; category: string; aiDescription?: string },
  candidates: Array<{
    reportId: string;
    title: string;
    description: string;
    category: string;
    aiDescription?: string;
  }>
): Promise<Record<string, { semanticScore: number; reason: string }>> {
  if (candidates.length === 0) return {};
  try {
    const ai = getGeminiClient();
    const response = await callWithTimeout(
      (abortSignal) =>
        ai.models.generateContent({
          model: 'gemini-3.1-flash-lite',
          contents: JSON.stringify({ target, candidates }),
          config: {
            abortSignal,
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
            systemInstruction:
              'Compare a target civic issue report (including any available image-analysis description) against candidate nearby reports. Return a semantic similarity score (0.0 to 1.0) and a brief factual reason why they might refer to the same physical issue. Never claim certainty.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                matches: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      reportId: { type: Type.STRING },
                      semanticScore: { type: Type.NUMBER },
                      reason: { type: Type.STRING },
                    },
                    required: ['reportId', 'semanticScore', 'reason'],
                  },
                },
              },
              required: ['matches'],
            },
          },
        }),
      GEMINI_DUPLICATE_TIMEOUT_MS
    );
    const parsed = JSON.parse((response.text ?? '{"matches":[]}').trim());
    const out: Record<string, { semanticScore: number; reason: string }> = {};
    if (Array.isArray(parsed.matches)) {
      for (const m of parsed.matches) {
        if (m.reportId) {
          out[m.reportId] = {
            semanticScore: Math.max(0, Math.min(1, Number(m.semanticScore ?? 0))),
            reason: String(m.reason || '').slice(0, 220),
          };
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

export interface MunicipalTrendDigestInput {
  totalReports: number;
  statusBreakdown: Record<string, number>;
  categoryBreakdown: Array<{ category: string; count: number; openCount: number; reopenedCount: number }>;
  zoneBreakdown: Array<{ zone: string; count: number; categories: string[] }>;
  departmentBreakdown: Array<{ department: string; assigned: number; resolved: number; pending: number }>;
  weeklyCounts: Array<{ label: string; submitted: number; resolved: number }>;
  monthlyCounts: Array<{ label: string; submitted: number; resolved: number }>;
  anonymizedSamples: Array<{
    trackingCode: string;
    category: string;
    priority: string;
    status: string;
    zone: string;
    ageHours: number;
    summary: string;
    aiSummary?: string;
  }>;
}

export interface GeminiTrendAnalysisOutput {
  observedSummary: string;
  frequentlyReportedIssues: string[];
  emergingPatterns: string[];
  areasWithIncreasingComplaints: string[];
  recurringInfrastructureProblems: string[];
  preventiveMaintenancePriorities: Array<{
    title: string;
    rationale: string;
    urgency: 'low' | 'medium' | 'high';
  }>;
  administratorRecommendations: string[];
}

export async function analyzeMunicipalTrendsWithGemini(
  digest: MunicipalTrendDigestInput
): Promise<{ result: GeminiTrendAnalysisOutput; modelUsed: string }> {
  const ai = getGeminiClient();

  const systemInstruction = `You are a municipal infrastructure analytics advisor.
You receive ONLY aggregated, anonymized civic issue summaries from the Supabase PostgreSQL civic database.
Your task is to distinguish strictly between observed factual patterns in the supplied dataset and AI hypotheses/advisory recommendations.

Rules:
1. NEVER invent counts, neighborhoods, dates, metrics, or external events not present in the input payload.
2. If totalReports is small (< 5), explicitly note in observedSummary and patterns that the sample size is limited and trends are preliminary.
3. Keep all items concise, operational, and actionable for city administrators.
4. Do not reference or infer private citizen identities.`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      observedSummary: {
        type: Type.STRING,
        description: 'Factual summary of observed report counts, categories, and statuses strictly from the dataset.',
      },
      frequentlyReportedIssues: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Factual most common civic issues observed.',
      },
      emergingPatterns: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Advisory patterns across time windows, categories, or AI visual descriptions.',
      },
      areasWithIncreasingComplaints: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Wards, zones, or street corridors showing concentrated or rising complaints in the data.',
      },
      recurringInfrastructureProblems: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Infrastructure categories with repeat or reopened incidents.',
      },
      preventiveMaintenancePriorities: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            rationale: { type: Type.STRING },
            urgency: { type: Type.STRING, enum: ['low', 'medium', 'high'] },
          },
          required: ['title', 'rationale', 'urgency'],
        },
        description: 'Advisory preventive maintenance actions grounded in observed data.',
      },
      administratorRecommendations: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Concrete operational recommendations for municipal administrators.',
      },
    },
    required: [
      'observedSummary',
      'frequentlyReportedIssues',
      'emergingPatterns',
      'areasWithIncreasingComplaints',
      'recurringInfrastructureProblems',
      'preventiveMaintenancePriorities',
      'administratorRecommendations',
    ],
  };

  const invoke = (targetModel: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite', timeoutMs: number) =>
    callWithTimeout(
      (abortSignal) =>
        ai.models.generateContent({
          model: targetModel,
          contents: `Analyze this anonymized municipal dataset and produce structured governance intelligence:\n${JSON.stringify(digest)}`,
          config: {
            abortSignal,
            thinkingConfig: {
              thinkingLevel:
                targetModel === 'gemini-3.1-flash-lite'
                  ? ThinkingLevel.MINIMAL
                  : ThinkingLevel.LOW,
            },
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema,
          },
        }),
      timeoutMs
    );

  let modelName: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite' = 'gemini-4-hydrogen';
  let response;
  try {
    response = await invoke('gemini-4-hydrogen', 25_000);
  } catch (firstErr) {
    if (shouldFallbackImageModel(firstErr) || isTransientGeminiError(firstErr)) {
      modelName = 'gemini-3.1-flash-lite';
      response = await invoke('gemini-3.1-flash-lite', Math.min(25_000, GEMINI_TREND_TIMEOUT_MS));
    } else {
      throw firstErr;
    }
  }

  const rawText = (response.text ?? '').trim();
  if (!rawText) {
    throw new Error('Gemini returned an empty response for trend intelligence.');
  }

  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('Gemini returned invalid JSON for trend intelligence.');
  }

  const normalizeStrings = (arr: unknown, maxItems = 6): string[] =>
    Array.isArray(arr)
      ? arr
          .map((v) => String(v || '').trim().slice(0, 280))
          .filter(Boolean)
          .slice(0, maxItems)
      : [];

  const normalizePriorities = (
    arr: unknown
  ): Array<{ title: string; rationale: string; urgency: 'low' | 'medium' | 'high' }> => {
    if (!Array.isArray(arr)) return [];
    return arr
      .slice(0, 5)
      .map((item: any) => {
        const u = item?.urgency;
        const urgency: 'low' | 'medium' | 'high' =
          u === 'high' || u === 'low' || u === 'medium' ? u : 'medium';
        return {
          title: String(item?.title || 'Maintenance check').trim().slice(0, 140),
          rationale: String(item?.rationale || '').trim().slice(0, 280),
          urgency,
        };
      })
      .filter((p) => p.title && p.rationale);
  };

  return {
    modelUsed: modelName,
    result: {
      observedSummary: String(parsed.observedSummary || '').trim().slice(0, 500),
      frequentlyReportedIssues: normalizeStrings(parsed.frequentlyReportedIssues),
      emergingPatterns: normalizeStrings(parsed.emergingPatterns),
      areasWithIncreasingComplaints: normalizeStrings(parsed.areasWithIncreasingComplaints),
      recurringInfrastructureProblems: normalizeStrings(parsed.recurringInfrastructureProblems),
      preventiveMaintenancePriorities: normalizePriorities(parsed.preventiveMaintenancePriorities),
      administratorRecommendations: normalizeStrings(parsed.administratorRecommendations),
    },
  };
}

