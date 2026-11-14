// Edit these two values to review an older batch of mail.
const REVIEW_NEWER_THAN_DAYS = 0;
const REVIEW_OLDER_THAN_DAYS = 7;
const CLEANUP_TIME_ZONE = 'America/Los_Angeles';
const CLEANUP_START_HOUR = 17;
const CLEANUP_END_HOUR = 6;

const DAY_MS = 24 * 60 * 60 * 1000;
const SEARCH = '{application applications applied applying candidate candidates candidacy position role job interview hiring} {forward proceed selected rejected declined unsuccessful filled offer advance continue progress invite continuing moving advancing}';
const PROTECTED_LABELS = new Set(['STARRED', 'SENT', 'DRAFT', 'SPAM', 'TRASH']);
const REVIEW_KEY = 'reviewedRejections';
const START_KEY = 'cleanupStarted';
const CHECKPOINT_KEY = 'cleanupThrough';
const MAX_CANDIDATES = 350;
const MAX_REVIEWED = 100;
const OVERLAP_MS = 6 * 60 * 60 * 1000;
const LOCK_TIMEOUT_MS = 10 * 1000;
// Pace requests below 6,000 units/minute, allowing some quota headroom.
const GMAIL_MS_PER_QUOTA_UNIT = 13;

// Classification patterns: explicit rejection wording plus context and exclusions.
const CONDITIONAL = /\b(?:with (?:your (?:job )?application|your candidacy|you)|offer you (?:the|this) (?:position|role|job)) (?:unless|until|without|before|if|at this stage unless)\b/;
const DIRECT_APPLICATION = /\b(?:your (?:job )?application|your candidacy|your (?:recent |initial )?interview|thank you for (?:applying|interviewing)|you applied for)\b/;
const JOB_CONTEXT = /\b(?:your (?:job )?application|your candidacy|your (?:recent |initial )?interview|your interest in|thank you for (?:applying|interviewing)|you applied for|(?:this|the|our|open) (?:position|role|job opening)|(?:other|another|qualified) candidates?|hiring (?:team|process|decision|manager))\b/;
// Also recognize named roles, such as "the Full Stack Engineer position at Mastech".
const EMPLOYMENT_CONTEXT = /\b(?:job (?:application|opening|opportunity|interview)|(?:the|this|our|open) (?:position|role)|(?:the|this|our|open) (?:[\w+#/&-]+ ){1,12}(?:position|role) at|hiring (?:team|process|decision|manager)|recruit(?:er|ing|ment)|talent acquisition|(?:other|another) candidates?|(?:your|an) (?:recent |initial )?(?:job )?interview)\b/;
const NON_JOB_APPLICATION = /\b(?:rental|apartment|mortgage|loan|credit card|scholarship|grant|visa|passport|college|university) application\b|\b(?:admissions (?:office|team|committee|decision)|application for admission)\b/;
const RECRUITING_PLATFORM = /(?:^|\.)(?:greenhouse\.io|lever\.co|myworkday\.com|myworkdayjobs\.com|smartrecruiters\.com|ashbyhq\.com|icims\.com|workablemail\.com|bamboohr\.com)$/;
const REJECTION_RULES = [
  ['Not moving forward', /\b(?:will not|won't|cannot|can't|unable to|decided not to|have chosen not to|are not|are unable to) (?:be )?(?:mov(?:e|ing)|proceed(?:ing)|continu(?:e|ing)|progress(?:ing)|advanc(?:e|ing)) (?:forward |further )?with (?:your (?:job )?application|your candidacy|you|your (?:job )?interview)\b|\byour (?:job )?application (?:will not|won't) (?:be moving forward|move forward|proceed|be considered further)\b/],
  ['Selected another candidate', /\b(?:we(?: have|'ve)? (?:decided|chosen) to (?:move forward|proceed|continue) with (?:other candidates|another candidate)|we (?:will be|are) moving forward with (?:another candidate|other candidates)|we(?: have|'ve)? selected (?:another candidate|other candidates)|we(?: have|'ve)? offered (?:the|this) (?:position|role) to another candidate)\b/],
  ['Application declined', /\b(?:your (?:job )?application (?:has been|was|is) (?:rejected|declined|unsuccessful|not selected)|your candidacy (?:has been|was) (?:declined|rejected)|you (?:were not|have not been|weren't) selected (?:to (?:move forward|proceed)|for (?:this|the) (?:position|role|job|interview))|we (?:regret|are sorry) to inform you that (?:your (?:job )?application (?:was|has been|is) unsuccessful|you (?:were not|have not been) selected))\b/],
  ['No offer for this application', /\b(?:we (?:will not|won't|are unable to|cannot|can't) (?:be able to )?offer you (?:the|this) (?:position|role|job)|we(?: have|'ve)? decided not to offer you (?:the|this) (?:position|role|job))\b/],
  ['Hiring team filled the role', /\b(?:the|this) (?:position|role|job opening) (?:has been|was|is now) filled\b/],
  ['No interview for this application', /\b(?:we (?:will not|won't|are unable to) (?:be able to )?(?:offer|schedule|invite you to) (?:you )?an interview|we(?: have|'ve)? decided not to invite you (?:for|to) an interview)\b/],
];
const ACTIVE_STEP = /\b(?:we(?: would|'d) like to (?:invite|schedule|set up|arrange|move forward|proceed|offer you|discuss|speak with you|talk with you)|you(?: have|'ve) been selected|we are (?:pleased|excited|happy) to (?:offer|invite)|please (?:schedule|resubmit|reapply using|confirm your availability|share your availability|send (?:us )?your availability|provide your availability|complete (?:the|this|your) (?:assessment|background check|paperwork))|(?:are you|would you be) available|(?:schedule|book|confirm|reschedule) (?:your|an|the|a) (?:interview|screening|call)|(?:interview invitation|offer letter|job offer|right to represent|export compliance|work authorization|background check|onboarding paperwork)|we (?:are|will be) (?:still )?(?:reviewing|considering) your application)\b/;
const FORWARDED_SUBJECT = /^(?:\s*(?:fwd?|fw)\s*:)/i;

// Public functions available in the Apps Script function dropdown.
function previewRejections() {
  withLock_(() => {
    const props = PropertiesService.getUserProperties();
    props.deleteProperty(REVIEW_KEY);
    const now = Date.now();
    const from = now - REVIEW_OLDER_THAN_DAYS * DAY_MS;
    const to = now - REVIEW_NEWER_THAN_DAYS * DAY_MS;
    const matches = scan_(from, to);
    if (matches.length > MAX_REVIEWED) {
      throw new Error(`More than ${MAX_REVIEWED} matches. Narrow the two review day settings and preview again.`);
    }
    props.setProperty(REVIEW_KEY, JSON.stringify({
      expires: now + DAY_MS,
      ids: matches.map(({id}) => id),
    }));
    console.log('Preview found %s match(es). Mailbox unchanged.', matches.length);
    for (const match of matches) {
      console.log(JSON.stringify({
        date: new Date(match.received).toISOString(),
        subject: match.subject,
        reason: match.reason,
      }));
    }
  });
}

function trashReviewedRejections() {
  withLock_(() => {
    const props = PropertiesService.getUserProperties();
    const review = JSON.parse(props.getProperty(REVIEW_KEY) || 'null');
    if (!review || review.expires <= Date.now()) {
      throw new Error('Run previewRejections first. A preview expires after 24 hours.');
    }
    const count = trashMatches_(review.ids);
    props.deleteProperty(REVIEW_KEY);
    console.log('Moved %s reviewed message(s) to Trash.', count);
  });
}

function enableHourlyCleanup() {
  withLock_(() => {
    const props = PropertiesService.getUserProperties();
    if (!props.getProperty(START_KEY)) {
      const now = String(Date.now());
      props.setProperties({[START_KEY]: now, [CHECKPOINT_KEY]: now});
    }
    const exists = ScriptApp.getProjectTriggers().some(isCleanupTrigger_);
    if (!exists) {
      ScriptApp.newTrigger('hourlyCleanup').timeBased().everyHours(1).create();
    }
    console.log('Hourly cleanup enabled for mail received after activation, from 5 PM to before 6 AM Los Angeles time.');
  });
}

function disableHourlyCleanup() {
  withLock_(() => {
    const props = PropertiesService.getUserProperties();
    props.deleteProperty(START_KEY);
    props.deleteProperty(CHECKPOINT_KEY);
    for (const trigger of ScriptApp.getProjectTriggers().filter(isCleanupTrigger_)) {
      ScriptApp.deleteTrigger(trigger);
    }
    console.log('Hourly cleanup disabled.');
  });
}

function hourlyCleanup() {
  withLock_(() => {
    const props = PropertiesService.getUserProperties();
    const start = Number(props.getProperty(START_KEY));
    if (!start) return;
    if (!isCleanupWindow_()) {
      console.log('Cleanup deferred until 5 PM Los Angeles time.');
      return;
    }

    const through = Number(props.getProperty(CHECKPOINT_KEY)) || start;
    const from = Math.max(start, through - OVERLAP_MS);
    const to = Math.min(Date.now(), through + DAY_MS);
    if (from >= to) return;

    const matches = scan_(from, to);
    const count = trashMatches_(matches.map(({id}) => id), isCleanupWindow_);
    // Keep the period available for retry if the overnight window ended mid-run.
    if (isCleanupWindow_()) props.setProperty(CHECKPOINT_KEY, String(to));
    console.log('Moved %s message(s) to Trash.', count);
  });
}

function isCleanupWindow_() {
  const hour = Number(Utilities.formatDate(new Date(Date.now()), CLEANUP_TIME_ZONE, 'H'));
  return hour >= CLEANUP_START_HOUR || hour < CLEANUP_END_HOUR;
}

function isCleanupTrigger_(trigger) {
  return trigger.getHandlerFunction() === 'hourlyCleanup';
}

function withLock_(work) {
  const lock = LockService.getUserLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    work();
  } finally {
    lock.releaseLock();
  }
}

// Scan first, then recheck each match immediately before moving it to Trash.
function scan_(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new Error('Set the older review boundary higher than the newer boundary.');
  }
  // Widen Gmail's seconds-based query, then enforce exact millisecond bounds.
  const q = `after:${Math.floor(from / 1000) - 1} before:${Math.ceil(to / 1000) + 1} -in:sent -in:drafts -is:starred ${SEARCH}`;
  const matches = [];
  const seen = new Set();
  let pageToken;
  do {
    const page = gmailRequest_(5, () => Gmail.Users.Messages.list('me', {
      q, maxResults: 100, ...(pageToken ? {pageToken} : {}),
    }));
    for (const {id} of page.messages || []) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (seen.size > MAX_CANDIDATES) {
        throw new Error(`Scan exceeded ${MAX_CANDIDATES} candidates before any message was moved. For a historical preview, narrow the review days.`);
      }
      const match = readMatch_(id);
      if (match && match.received >= from && match.received < to) matches.push(match);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return matches;
}

function trashMatches_(ids, canTrash = () => true) {
  let count = 0;
  for (const id of ids) {
    if (!canTrash()) break;
    // Recheck labels and content in case a message was starred after the preview.
    if (!readMatch_(id)) continue;
    gmailRequest_(20, () => {
      // Recheck after the read and quota delay in case the window just ended.
      if (!canTrash()) return;
      Gmail.Users.Messages.trash('me', id);
      count++;
    });
  }
  return count;
}

function gmailRequest_(quotaUnits, request) {
  Utilities.sleep(quotaUnits * GMAIL_MS_PER_QUOTA_UNIT);
  try {
    return request();
  } catch (error) {
    if (/quota exceeded|rate.?limit|too many requests/i.test(String(error))) {
      throw new Error('Gmail rate limit reached. Wait at least one minute, then retry. For previews, use a smaller review range. Original error: ' + String(error));
    }
    throw error;
  }
}

function readMatch_(id) {
  let message;
  try {
    message = gmailRequest_(60, () => Gmail.Users.Messages.get('me', id, {format: 'full'}));
  } catch (error) {
    if (/\b(?:404|requested entity was not found)\b/i.test(String(error))) return null;
    throw error;
  }
  if ((message.labelIds || []).some(label => PROTECTED_LABELS.has(label))) return null;
  const headers = message.payload?.headers || [];
  const subject = headerValue_(headers, 'subject');
  const sender = headerValue_(headers, 'from');
  if (/^\[Job Mail (?:Summary|Reminder)\]/i.test(subject) || FORWARDED_SUBJECT.test(subject)) return null;
  let alternatives;
  try {
    alternatives = messageText_(message.payload);
  } catch (error) {
    // Preserve the entire message: an unreadable alternative may contain a next step.
    console.log('Skipped message %s: body could not be decoded. %s', id, String(error));
    return null;
  }
  const reason = rejectionReason_(subject, alternatives, sender);
  const received = Number(message.internalDate);
  return reason && received > 0 ? {id, received, subject, reason} : null;
}

// MIME parsing ignores attachments and preserves both body alternatives.
function headerValue_(headers, name) {
  return headers.find(header => header.name.toLowerCase() === name)?.value || '';
}

function messageText_(payload) {
  const parts = [];
  collectText_(payload, parts);
  const plain = parts.filter(part => part.type === 'text/plain').map(part => part.text).join('\n');
  const html = parts.filter(part => part.type === 'text/html').map(part => htmlText_(part.text)).join('\n');
  // Check both alternatives for active next steps. Gmail usually sends the same text in both.
  return [plain, html].filter(Boolean);
}

function collectText_(part, parts) {
  if (!part || part.filename || part.mimeType === 'message/rfc822') return;
  if ((part.headers || []).some(header =>
    header.name.toLowerCase() === 'content-disposition' && /^attachment\b/i.test(header.value))) return;
  const type = part.mimeType;
  if (['text/plain', 'text/html'].includes(type) && part.body?.data) {
    parts.push({type, text: decodeTextPart_(part)});
  }
  for (const child of part.parts || []) collectText_(child, parts);
}

function decodeTextPart_(part) {
  const contentType = headerValue_(part.headers || [], 'content-type');
  const charset = contentType.match(/charset=["']?([\w-]+)/i)?.[1] || 'UTF-8';
  const blob = Utilities.newBlob(bodyBytes_(part.body.data));
  try {
    return blob.getDataAsString(charset);
  } catch {
    return blob.getDataAsString('UTF-8');
  }
}

function bodyBytes_(data) {
  // Advanced Gmail can return already-decoded bytes rather than a base64 string.
  if (Array.isArray(data)) {
    if (!data.every(byte => Number.isInteger(byte) && byte >= -128 && byte <= 255)) {
      throw new Error('Invalid body byte array.');
    }
    return data.map(byte => byte > 127 ? byte - 256 : byte);
  }
  if (typeof data !== 'string') {
    throw new Error('Unsupported body data type: ' + typeof data);
  }
  // Normalize the alphabet and restore padding before using Apps Script's decoder.
  const encoded = data.replace(/\s/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(encoded)) {
    throw new Error('Invalid base64 body characters.');
  }
  const unpadded = encoded.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) {
    throw new Error('Invalid base64 body length.');
  }
  const padded = unpadded + '='.repeat((4 - unpadded.length % 4) % 4);
  return Utilities.base64DecodeWebSafe(padded);
}

function htmlText_(html) {
  return html
    .split(/<(?:blockquote\b|\w+\b[^>]*\b(?:class|id)\s*=\s*["'][^"']*(?:gmail_quote|yahoo_quoted|divRplyFwdMsg))/i)[0]
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[^]*?-->/g, '')
    .replace(/<br\b[^>]*>|<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|ensp|emsp|zwnj|zwj);|&#(?:160|8203);/gi, ' ')
    .replace(/&(?:apos|rsquo);|&#(?:39|8217|x27|x2019);/gi, "'")
    .replace(/&amp;/gi, '&');
}

// Remove quoted history before testing the current message's wording.
function normalizeText_(text) {
  return text.normalize('NFKC').toLowerCase()
    .replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
}

function currentBodyText_(text) {
  return normalizeText_(text
    .split(/^\s*(?:on .+wrote:|-+\s*(?:original message|forwarded message)\s*-+|begin forwarded message:|from:\s*.+@)/im)[0]
    .replace(/^\s*>.*$/gm, ''));
}

function rejectionReason_(subject, alternatives, sender = '') {
  const cleanSubject = normalizeText_(subject);
  const bodies = alternatives.map(currentBodyText_).filter(Boolean);
  const messageContext = [cleanSubject, ...bodies].join(' ');
  if (!bodies.length || ACTIVE_STEP.test(messageContext)) return null;
  if (bodies.some(body => CONDITIONAL.test(body))) return null;
  if (NON_JOB_APPLICATION.test(messageContext)) return null;
  const domain = sender.trim().toLowerCase().match(/@([a-z0-9.-]+)>?$/)?.[1] || '';
  const fromRecruitingPlatform = RECRUITING_PLATFORM.test(domain);

  for (const body of bodies) {
    const context = `${cleanSubject} ${body}`;
    if (!JOB_CONTEXT.test(context)) continue;
    if (!fromRecruitingPlatform && !EMPLOYMENT_CONTEXT.test(context)) continue;
    const rule = REJECTION_RULES.find(([, pattern]) => pattern.test(body));
    if (!rule) continue;
    const [reason] = rule;
    if (reason === 'Hiring team filled the role' && !DIRECT_APPLICATION.test(context)) continue;
    return reason;
  }
  return null;
}
