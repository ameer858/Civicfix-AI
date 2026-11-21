import nodemailer from 'nodemailer';

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

export interface EmailValidationResult {
  valid: boolean;
  email: string;
  error?: string;
}

export function validateNonDummyEmail(raw: string, allowEmpty = false): EmailValidationResult {
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
  if (DUMMY_EMAIL_DOMAINS.has(domain) || DUMMY_EMAIL_PATTERNS.some((re) => re.test(cleaned))) {
    return {
      valid: false,
      email: cleaned,
      error: `Placeholder or dummy email addresses (${cleaned}) are not permitted. Enter a real verified authority email.`,
    };
  }

  return { valid: true, email: cleaned };
}

export interface EmailTransportStatus {
  configured: boolean;
  provider: 'smtp' | 'resend' | 'none';
  senderAddress: string;
  detail: string;
}

export function getEmailTransportStatus(): EmailTransportStatus {
  const resendKey = (process.env.RESEND_API_KEY || '').trim();
  let smtpHost = (process.env.SMTP_HOST || '').trim();
  const smtpUser = (process.env.SMTP_USER || '').trim();
  const smtpPass = (process.env.SMTP_PASS || '').trim();
  const smtpFrom = (process.env.SMTP_FROM || '').trim();

  if (resendKey && !resendKey.startsWith('MY_')) {
    const sender = smtpFrom || 'CivicFix AI <onboarding@resend.dev>';
    const usingSandbox = sender.toLowerCase().includes('onboarding@resend.dev');
    return {
      configured: true,
      provider: 'resend',
      senderAddress: sender,
      detail: usingSandbox
        ? 'Resend HTTP email transport active (onboarding@resend.dev). Note: Resend sandbox sender only delivers to your verified Resend account email unless SMTP_FROM uses a verified domain.'
        : 'Resend HTTP email transport configured.',
    };
  }

  // Auto-infer Gmail SMTP host when Gmail credentials are provided without explicit SMTP_HOST
  if ((!smtpHost || smtpHost.startsWith('MY_')) && smtpUser && smtpPass && /@(gmail|googlemail)\.com$/i.test(smtpUser)) {
    smtpHost = 'smtp.gmail.com';
  }

  if (smtpHost && !smtpHost.startsWith('MY_') && smtpUser && smtpPass) {
    return {
      configured: true,
      provider: 'smtp',
      senderAddress: smtpFrom || `CivicFix AI <${smtpUser}>`,
      detail: `SMTP transport configured via ${smtpHost}.`,
    };
  }

  return {
    configured: false,
    provider: 'none',
    senderAddress: '',
    detail:
      'Live SMTP or Resend credentials are not configured in server environment variables. Configure RESEND_API_KEY or SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM in Settings > Secrets to dispatch real emails.',
  };
}

function resolveSmtpConfig() {
  let smtpHost = (process.env.SMTP_HOST || '').trim();
  const smtpUser = (process.env.SMTP_USER || '').trim();
  const smtpPass = (process.env.SMTP_PASS || '').trim();
  if ((!smtpHost || smtpHost.startsWith('MY_')) && smtpUser && smtpPass && /@(gmail|googlemail)\.com$/i.test(smtpUser)) {
    smtpHost = 'smtp.gmail.com';
  }
  const defaultPort = smtpHost === 'smtp.gmail.com' ? 465 : 587;
  const rawPort = Number(process.env.SMTP_PORT || defaultPort);
  const smtpPort = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : defaultPort;
  const rawSecure = String(process.env.SMTP_SECURE || '').trim().toLowerCase();
  const smtpSecure = rawSecure ? rawSecure === 'true' : smtpPort === 465;

  return { smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass };
}

function encodeMimeHeaderValue(val: string): string {
  const clean = String(val || '').replace(/[\r\n]+/g, ' ').trim();
  if (!clean) return '';
  if (/^[\x20-\x7e]+$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf-8').toString('base64')}?=`;
}

function wrapBase64(b64: string): string {
  return b64.replace(/(.{76})/g, '$1\r\n');
}

function buildRawMimeMessage(args: {
  from?: string;
  to: string;
  cc?: string;
  subject: string;
  textBody: string;
  htmlBody: string;
}): string {
  const boundary = `civicfix_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const dedupedCc =
    args.cc && args.cc.trim().toLowerCase() !== args.to.trim().toLowerCase()
      ? args.cc.trim()
      : '';
  const headers: string[] = [
    ...(args.from ? [`From: ${args.from}`] : []),
    `To: ${args.to.trim()}`,
    ...(dedupedCc ? [`Cc: ${dedupedCc}`] : []),
    `Subject: ${encodeMimeHeaderValue(args.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  const textB64 = wrapBase64(Buffer.from(args.textBody, 'utf-8').toString('base64'));
  const htmlB64 = wrapBase64(Buffer.from(args.htmlBody, 'utf-8').toString('base64'));

  const mime = [
    ...headers,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    textB64,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    htmlB64,
    `--${boundary}--`,
    '',
  ].join('\r\n');

  return Buffer.from(mime, 'utf-8').toString('base64url');
}

async function dispatchViaGmailApi(
  accessToken: string,
  args: {
    from?: string;
    to: string;
    cc?: string;
    subject: string;
    textBody: string;
    htmlBody: string;
  }
): Promise<{
  sent: boolean;
  provider: 'gmail';
  error?: string;
  sentAtIso?: string;
}> {
  const raw = buildRawMimeMessage(args);
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  if (!res.ok) {
    const errText = await res.text();
    let detail = errText.slice(0, 220);
    let reason = '';
    try {
      const parsed = JSON.parse(errText);
      if (parsed?.error?.message) detail = String(parsed.error.message);
      if (Array.isArray(parsed?.error?.errors) && parsed.error.errors[0]?.reason) {
        reason = String(parsed.error.errors[0].reason);
      }
    } catch {
      // ignore
    }
    if (reason === 'accessNotConfigured' || detail.includes('has not been used in project')) {
      return {
        sent: false,
        provider: 'gmail',
        error: `Gmail API is not enabled in the Google Cloud project (${detail}).`.slice(0, 320),
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        sent: false,
        provider: 'gmail',
        error: `Gmail permission expired or insufficient (${res.status}). Reconnect Gmail and allow email sending. (${detail})`.slice(0, 320),
      };
    }
    return {
      sent: false,
      provider: 'gmail',
      error: `Gmail API (${res.status}): ${detail}`.slice(0, 320),
    };
  }

  return {
    sent: true,
    provider: 'gmail',
    sentAtIso: new Date().toISOString(),
  };
}

async function dispatchEmailViaConfiguredTransport(args: {
  to: string;
  cc?: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  gmailAccessToken?: string;
  gmailSenderEmail?: string;
}): Promise<{
  sent: boolean;
  provider: 'smtp' | 'resend' | 'gmail' | 'none';
  error?: string;
  sentAtIso?: string;
}> {
  const transport = getEmailTransportStatus();
  const cleanGmailToken = (args.gmailAccessToken || '').trim();
  const dedupedCc =
    args.cc && args.cc.trim().toLowerCase() !== args.to.trim().toLowerCase()
      ? args.cc.trim()
      : undefined;

  if (!transport.configured && !cleanGmailToken) {
    return {
      sent: false,
      provider: 'none',
      error: transport.detail,
    };
  }

  try {
    if (transport.configured && transport.provider === 'resend') {
      const resendKey = (process.env.RESEND_API_KEY || '').trim();
      const bodyPayload: Record<string, any> = {
        from: transport.senderAddress,
        to: [args.to],
        subject: args.subject,
        text: args.textBody,
        html: args.htmlBody,
      };
      if (dedupedCc) {
        bodyPayload.cc = [dedupedCc];
      }
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bodyPayload),
      });
      if (!res.ok) {
        const errText = await res.text();
        let detail = errText.slice(0, 220);
        try {
          const parsed = JSON.parse(errText);
          if (parsed?.message) detail = String(parsed.message);
        } catch {
          // ignore
        }
        throw new Error(`Resend API (${res.status}): ${detail}`);
      }
      return {
        sent: true,
        provider: 'resend',
        sentAtIso: new Date().toISOString(),
      };
    }

    if (transport.configured && transport.provider === 'smtp') {
      const { smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass } = resolveSmtpConfig();
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      });

      await transporter.sendMail({
        from: transport.senderAddress,
        to: args.to,
        cc: dedupedCc,
        subject: args.subject,
        text: args.textBody,
        html: args.htmlBody,
      });

      return {
        sent: true,
        provider: 'smtp',
        sentAtIso: new Date().toISOString(),
      };
    }

    if (cleanGmailToken) {
      return await dispatchViaGmailApi(cleanGmailToken, {
        to: args.to,
        cc: dedupedCc,
        subject: args.subject,
        textBody: args.textBody,
        htmlBody: args.htmlBody,
      });
    }

    return {
      sent: false,
      provider: 'none',
      error: transport.detail,
    };
  } catch (err: unknown) {
    if (transport.configured && cleanGmailToken) {
      const gmailFallback = await dispatchViaGmailApi(cleanGmailToken, {
        to: args.to,
        cc: dedupedCc,
        subject: args.subject,
        textBody: args.textBody,
        htmlBody: args.htmlBody,
      }).catch((gErr) => ({
        sent: false,
        provider: 'gmail' as const,
        error: gErr instanceof Error ? gErr.message : String(gErr),
      }));
      if (gmailFallback.sent) {
        return gmailFallback;
      }
    }
    const rawMsg = err instanceof Error ? err.message : String(err);
    return {
      sent: false,
      provider: transport.configured ? transport.provider : cleanGmailToken ? 'gmail' : 'none',
      error: rawMsg.slice(0, 320),
    };
  }
}

export interface ComplaintAuthorityEmailPayload {
  to: string;
  cc?: string;
  trackingCode: string;
  reportId: string;
  reportTitle: string;
  categoryLabel: string;
  priorityLabel: string;
  departmentName: string;
  departmentContactPerson?: string;
  addressText: string;
  wardOrZone?: string;
  latitude: number;
  longitude: number;
  description: string;
  reporterName: string;
  submittedAtIso: string;
  aiSummary?: string;
  gmailAccessToken?: string;
  gmailSenderEmail?: string;
}

export interface ComplaintEmailDispatchOutcome {
  sent: boolean;
  status: 'sent' | 'smtp_not_configured' | 'failed';
  transportUsed: 'smtp' | 'resend' | 'gmail' | 'none';
  statusNote: string;
  sentAtIso?: string;
}

function escapeHtml(text: string): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function sendAuthorityComplaintEmail(
  payload: ComplaintAuthorityEmailPayload
): Promise<ComplaintEmailDispatchOutcome> {
  const transport = getEmailTransportStatus();
  const hasGmailFallback = Boolean((payload.gmailAccessToken || '').trim());
  if (!transport.configured && !hasGmailFallback) {
    return {
      sent: false,
      status: 'smtp_not_configured',
      transportUsed: 'none',
      statusNote: 'Email transport (SMTP/Resend) not configured on server; connect Gmail or configure server transport to send.',
    };
  }

  const subject = `[CivicFix AI] [${payload.priorityLabel.toUpperCase()}] New ${payload.categoryLabel} Complaint (${payload.trackingCode})`;
  const coords = `${payload.latitude.toFixed(5)}, ${payload.longitude.toFixed(5)}`;
  const recipientGreeting = payload.departmentContactPerson
    ? `Dear ${payload.departmentContactPerson},`
    : `Dear ${payload.departmentName} Authority,`;

  const textBody = [
    recipientGreeting,
    '',
    `A new citizen civic issue has been routed to ${payload.departmentName}.`,
    '',
    `Tracking ID: ${payload.trackingCode}`,
    `Title: ${payload.reportTitle}`,
    `Category: ${payload.categoryLabel}`,
    `Priority: ${payload.priorityLabel}`,
    `Location: ${payload.addressText}${payload.wardOrZone ? ` (${payload.wardOrZone})` : ''}`,
    `Coordinates: ${coords}`,
    `Submitted By: ${payload.reporterName}`,
    `Submitted At: ${payload.submittedAtIso}`,
    '',
    'Description:',
    payload.description,
    payload.aiSummary ? `\nAdvisory AI Triage Summary:\n${payload.aiSummary}` : '',
    '',
    'Please log in to the CivicFix AI Operations Console to verify and dispatch a field team.',
  ]
    .filter(Boolean)
    .join('\n');

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #0f172a; max-width: 640px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;">
      <div style="background: #1d4ed8; color: #ffffff; padding: 18px 24px;">
        <div style="font-size: 12px; letter-spacing: 0.05em; text-transform: uppercase; opacity: 0.9;">CivicFix AI · Automated Department Routing</div>
        <h2 style="margin: 6px 0 0 0; font-size: 18px;">${escapeHtml(payload.trackingCode)} — ${escapeHtml(payload.reportTitle)}</h2>
      </div>
      <div style="padding: 20px 24px; background: #ffffff; font-size: 14px; line-height: 1.55;">
        <p style="margin-top: 0;">${escapeHtml(recipientGreeting)}</p>
        <p>A new civic complaint has been automatically routed to <strong>${escapeHtml(payload.departmentName)}</strong>.</p>
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px;">
          <tr><td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0; color: #475569; width: 150px;">Tracking ID</td><td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0; font-weight: 600;">${escapeHtml(payload.trackingCode)}</td></tr>
          <tr><td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0; color: #475569;">Category</td><td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0;">${escapeHtml(payload.categoryLabel)}</td></tr>
          <tr><td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0; color: #475569;">Priority</td><td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0;">${escapeHtml(payload.priorityLabel)}</td></tr>
          <tr><td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0; color: #475569;">Location</td><td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0;">${escapeHtml(payload.addressText)}${payload.wardOrZone ? ` · ${escapeHtml(payload.wardOrZone)}` : ''}</td></tr>
          <tr><td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0; color: #475569;">Coordinates</td><td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0; font-family: monospace;">${escapeHtml(coords)}</td></tr>
          <tr><td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0; color: #475569;">Citizen Reporter</td><td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0;">${escapeHtml(payload.reporterName)}</td></tr>
        </table>
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 14px; margin-bottom: 14px;">
          <div style="font-size: 12px; font-weight: 600; color: #475569; margin-bottom: 4px;">Citizen Description</div>
          <div style="white-space: pre-wrap;">${escapeHtml(payload.description)}</div>
        </div>
        ${
          payload.aiSummary
            ? `<div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; font-size: 13px;">
                 <div style="font-size: 12px; font-weight: 600; color: #1e40af; margin-bottom: 4px;">Advisory AI Assessment</div>
                 <div>${escapeHtml(payload.aiSummary)}</div>
               </div>`
            : ''
        }
        <p style="font-size: 12px; color: #64748b; margin-bottom: 0;">Sent automatically by CivicFix AI Municipal Governance Platform.</p>
      </div>
    </div>
  `.trim();

  const res = await dispatchEmailViaConfiguredTransport({
    to: payload.to,
    cc: payload.cc,
    subject,
    textBody,
    htmlBody,
    gmailAccessToken: payload.gmailAccessToken,
    gmailSenderEmail: payload.gmailSenderEmail,
  });

  if (!res.sent) {
    return {
      sent: false,
      status: res.provider === 'none' ? 'smtp_not_configured' : 'failed',
      transportUsed: res.provider,
      statusNote: `Email delivery failed: ${res.error || 'Unknown transport error'}`.slice(0, 380),
    };
  }

  return {
    sent: true,
    status: 'sent',
    transportUsed: res.provider,
    statusNote: `Dispatched to ${payload.departmentName} (${payload.to}) via ${res.provider.toUpperCase()}.`,
    sentAtIso: res.sentAtIso,
  };
}

export async function sendCitizenSubmissionReceiptEmail(payload: {
  to: string;
  citizenName: string;
  trackingCode: string;
  reportTitle: string;
  departmentName: string;
  categoryLabel: string;
  addressText: string;
  gmailAccessToken?: string;
  gmailSenderEmail?: string;
}): Promise<{ sent: boolean; provider: 'smtp' | 'resend' | 'gmail' | 'none'; note: string }> {
  const emailCheck = validateNonDummyEmail(payload.to, false);
  if (!emailCheck.valid) {
    return { sent: false, provider: 'none', note: emailCheck.error || 'Invalid citizen email.' };
  }
  const transport = getEmailTransportStatus();
  const hasGmailFallback = Boolean((payload.gmailAccessToken || '').trim());
  if (!transport.configured && !hasGmailFallback) {
    return { sent: false, provider: 'none', note: 'Email transport not configured.' };
  }

  const subject = `[CivicFix AI] Report Received — Tracking ID ${payload.trackingCode}`;
  const textBody = [
    `Hello ${payload.citizenName || 'Citizen'},`,
    '',
    `Your civic issue report has been received and saved in CivicFix AI.`,
    `Tracking ID: ${payload.trackingCode}`,
    `Title: ${payload.reportTitle}`,
    `Category: ${payload.categoryLabel}`,
    `Routed Department: ${payload.departmentName}`,
    `Location: ${payload.addressText}`,
    '',
    'You can use your Tracking ID anytime on the CivicFix AI Public Transparency Portal to follow progress.',
  ].join('\n');

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #0f172a; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;">
      <div style="background: #1d4ed8; color: #ffffff; padding: 16px 22px;">
        <div style="font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; opacity: 0.9;">CivicFix AI · Citizen Submission Receipt</div>
        <h2 style="margin: 6px 0 0 0; font-size: 17px;">Tracking ID: ${escapeHtml(payload.trackingCode)}</h2>
      </div>
      <div style="padding: 18px 22px; background: #ffffff; font-size: 14px; line-height: 1.55;">
        <p style="margin-top: 0;">Hello ${escapeHtml(payload.citizenName || 'Citizen')},</p>
        <p>Your civic issue report <strong>${escapeHtml(payload.reportTitle)}</strong> has been recorded and routed to <strong>${escapeHtml(payload.departmentName)}</strong>.</p>
        <p style="font-size: 13px; color: #475569;">Location: ${escapeHtml(payload.addressText)}</p>
        <p style="font-size: 12px; color: #64748b; margin-bottom: 0;">Use Tracking ID <strong>${escapeHtml(payload.trackingCode)}</strong> in the Public Transparency Portal to monitor updates.</p>
      </div>
    </div>
  `.trim();

  const res = await dispatchEmailViaConfiguredTransport({
    to: emailCheck.email,
    subject,
    textBody,
    htmlBody,
    gmailAccessToken: payload.gmailAccessToken,
    gmailSenderEmail: payload.gmailSenderEmail,
  });

  return {
    sent: res.sent,
    provider: res.provider,
    note: res.sent
      ? `Receipt sent to ${emailCheck.email} via ${res.provider.toUpperCase()}.`
      : res.error || 'Unable to dispatch citizen receipt email.',
  };
}

export async function sendTestAuthorityEmail(params: {
  to: string;
  departmentName?: string;
  actorName?: string;
  gmailAccessToken?: string;
  gmailSenderEmail?: string;
}): Promise<{
  sent: boolean;
  provider: 'smtp' | 'resend' | 'gmail' | 'none';
  senderAddress: string;
  message: string;
}> {
  const emailCheck = validateNonDummyEmail(params.to, false);
  if (!emailCheck.valid) {
    return {
      sent: false,
      provider: 'none',
      senderAddress: '',
      message: emailCheck.error || 'Please enter a valid recipient email address.',
    };
  }

  const transport = getEmailTransportStatus();
  const cleanGmailToken = (params.gmailAccessToken || '').trim();
  if (!transport.configured && !cleanGmailToken) {
    return {
      sent: false,
      provider: 'none',
      senderAddress: '',
      message: transport.detail,
    };
  }

  const activeProviderLabel = transport.configured ? transport.provider.toUpperCase() : 'GMAIL';
  const activeSenderAddress = transport.configured
    ? transport.senderAddress
    : params.gmailSenderEmail || 'Connected Gmail Account';
  const deptLabel = (params.departmentName || 'Municipal Department').trim();
  const actor = (params.actorName || 'Administrator').trim();
  const nowIso = new Date().toISOString();

  const res = await dispatchEmailViaConfiguredTransport({
    to: emailCheck.email,
    subject: `[CivicFix AI] Test Authority Email Verification (${deptLabel})`,
    textBody: [
      `Hello,`,
      '',
      `This is a live test email from CivicFix AI confirming outbound email delivery for ${deptLabel}.`,
      `Triggered by: ${actor}`,
      `Transport: ${activeProviderLabel}`,
      `Sender: ${activeSenderAddress}`,
      `Timestamp: ${nowIso}`,
    ].join('\n'),
    htmlBody: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #0f172a; max-width: 560px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;">
        <div style="background: #0f172a; color: #ffffff; padding: 16px 20px;">
          <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.85;">CivicFix AI · Delivery Verification</div>
          <h2 style="margin: 6px 0 0 0; font-size: 17px;">Outbound Email Transport Active</h2>
        </div>
        <div style="padding: 18px 20px; background: #ffffff; font-size: 14px; line-height: 1.5;">
          <p style="margin-top: 0;">This test confirms CivicFix AI can deliver live emails to <strong>${escapeHtml(emailCheck.email)}</strong> for <strong>${escapeHtml(deptLabel)}</strong>.</p>
          <p style="font-size: 12px; color: #475569;">Provider: ${escapeHtml(activeProviderLabel)} · Sender: ${escapeHtml(activeSenderAddress)}<br/>Triggered by ${escapeHtml(actor)} at ${escapeHtml(nowIso)}</p>
        </div>
      </div>
    `.trim(),
    gmailAccessToken: cleanGmailToken || undefined,
    gmailSenderEmail: params.gmailSenderEmail,
  });

  return {
    sent: res.sent,
    provider: res.provider,
    senderAddress: activeSenderAddress,
    message: res.sent
      ? `Test email delivered successfully to ${emailCheck.email} via ${res.provider.toUpperCase()}.`
      : `Test email delivery failed: ${res.error || 'Unknown error'}`,
  };
}
