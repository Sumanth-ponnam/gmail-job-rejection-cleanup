// Summary emails use the same timezone as overnight cleanup.
const SUMMARY_ENABLED_KEY = 'applicationSummariesEnabled';
const SUMMARY_THROUGH_KEY = 'applicationSummaryThrough';
const SUMMARY_SLOT_KEY = 'applicationSummarySlot';
const SUMMARY_SEARCH = '{application applications applied applying candidacy candidate candidates interview screening assessment hiring recruiter recruiting position role "job offer"}';
const SUMMARY_SUBJECT_PREFIX = '[Job Mail Summary]';
const MAX_SUMMARY_CANDIDATES = 200;
const MAX_SUMMARY_DETAILS = 30;
const SUMMARY_SCAN_TIMEOUT_MS = 4 * 60 * 1000;
const SUMMARY_SCHEDULE = [
  {handler: 'morningApplicationSummary', hour: 7},
  {handler: 'eveningApplicationSummary', hour: 17},
];

function enableApplicationSummaries() {
  withLock_(() => {
    const handlers = new Set(ScriptApp.getProjectTriggers().map(trigger => trigger.getHandlerFunction()));
    for (const {handler, hour} of SUMMARY_SCHEDULE) {
      if (handlers.has(handler)) continue;
      ScriptApp.newTrigger(handler).timeBased().atHour(hour).nearMinute(0)
        .everyDays(1).inTimezone(CLEANUP_TIME_ZONE).create();
    }
    PropertiesService.getUserProperties().setProperty(SUMMARY_ENABLED_KEY, 'true');
    console.log('Summary emails enabled around 7 AM and 5 PM, %s.', CLEANUP_TIME_ZONE);
  });
}

function disableApplicationSummaries() {
  withLock_(() => {
    PropertiesService.getUserProperties().deleteProperty(SUMMARY_ENABLED_KEY);
    const handlers = new Set(SUMMARY_SCHEDULE.map(({handler}) => handler));
    for (const trigger of ScriptApp.getProjectTriggers()) {
      if (handlers.has(trigger.getHandlerFunction())) ScriptApp.deleteTrigger(trigger);
    }
    console.log('Summary emails disabled.');
  });
}

function morningApplicationSummary() {
  sendApplicationSummary_('Morning');
}

function eveningApplicationSummary() {
  sendApplicationSummary_('Evening');
}

// Preview reads mail and logs the report without sending or advancing its checkpoint.
function previewApplicationSummary() {
  withLock_(() => {
    const report = applicationSummaryReport_();
    console.log(summaryEmail_(report, 'Preview').body);
  });
}

function sendApplicationSummaryNow() {
  sendApplicationSummary_('Manual');
}

function sendApplicationSummary_(period) {
  withLock_(() => {
    const props = PropertiesService.getUserProperties();
    const scheduled = period !== 'Manual';
    if (scheduled && props.getProperty(SUMMARY_ENABLED_KEY) !== 'true') return;
    const slot = summaryDate_(Date.now(), 'yyyy-MM-dd') + ':' + period;
    if (scheduled && props.getProperty(SUMMARY_SLOT_KEY) === slot) return;

    const report = applicationSummaryReport_();
    const recipient = gmailRequest_(1, () => Gmail.Users.getProfile('me')).emailAddress;
    if (!recipient) throw new Error('Gmail did not return a summary recipient.');
    const email = summaryEmail_(report, period, recipient);
    MailApp.sendEmail({to: recipient, ...email, name: 'Job Mail Summary'});
    // Only acknowledge the period once the send call succeeds.
    props.setProperty(SUMMARY_THROUGH_KEY, String(report.to));
    if (scheduled) props.setProperty(SUMMARY_SLOT_KEY, slot);
    console.log('%s summary sent: %s classified message(s), %s unreadable.',
      period, report.updates.length, report.unreadable);
  });
}

function applicationSummaryReport_() {
  const to = Date.now();
  const saved = Number(PropertiesService.getUserProperties().getProperty(SUMMARY_THROUGH_KEY));
  const from = saved || to - DAY_MS;
  if (!Number.isFinite(from) || from > to) throw new Error('Invalid summary checkpoint.');
  const q = `in:anywhere -in:spam -in:sent -in:drafts after:${Math.floor(from / 1000) - 1} before:${Math.ceil(to / 1000) + 1} ${SUMMARY_SEARCH}`;
  const updates = [];
  const seen = new Set();
  let unreadable = 0;
  let pageToken;
  do {
    const page = gmailRequest_(5, () => Gmail.Users.Messages.list('me', {
      q, includeSpamTrash: true, maxResults: 100, ...(pageToken ? {pageToken} : {}),
    }));
    for (const {id} of page.messages || []) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (seen.size > MAX_SUMMARY_CANDIDATES || Date.now() - to > SUMMARY_SCAN_TIMEOUT_MS) {
        throw new Error('Summary scan limit reached. No summary was sent and its checkpoint was kept. Check Executions; reduce mailbox volume or process the backlog before retrying.');
      }
      const message = summaryMessage_(id);
      if (!message) continue;
      const received = Number(message.internalDate);
      if (!(received >= from && received < to)) continue;
      if ((message.labelIds || []).some(label => ['SENT', 'DRAFT', 'SPAM'].includes(label))) continue;
      const headers = message.payload?.headers || [];
      const subject = headerValue_(headers, 'subject');
      if (/^\[Job Mail (?:Summary|Reminder)\]/i.test(subject) || FORWARDED_SUBJECT.test(subject)) continue;
      const sender = headerValue_(headers, 'from');
      let alternatives;
      try {
        alternatives = messageText_(message.payload);
      } catch {
        unreadable++;
        continue;
      }
      const status = applicationUpdate_(subject, alternatives, sender);
      if (status) updates.push({id, received, subject, sender, ...status});
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  updates.sort((a, b) => b.received - a.received);
  return {from, to, updates, unreadable};
}

function summaryMessage_(id) {
  try {
    return gmailRequest_(60, () => Gmail.Users.Messages.get('me', id, {format: 'full'}));
  } catch (error) {
    if (/\b(?:404|requested entity was not found)\b/i.test(String(error))) return null;
    throw error;
  }
}

// These are email updates, not a count of unique applications or interview events.
function applicationUpdate_(subject, alternatives, sender) {
  const bodies = alternatives.map(currentBodyText_).filter(Boolean);
  if (!bodies.length) return null;
  const text = [normalizeText_(subject), ...bodies].join(' ');
  if (NON_JOB_APPLICATION.test(text)) return null;
  const domain = sender.trim().toLowerCase().match(/@([a-z0-9.-]+)>?$/)?.[1] || '';
  const explicitJobContext = /\b(?:thank you for applying|job (?:application|interview|offer)|recruit(?:er|ing|ment)|talent acquisition|hiring)\b/.test(text);
  if (!explicitJobContext && !(JOB_CONTEXT.test(text) && EMPLOYMENT_CONTEXT.test(text)) && !RECRUITING_PLATFORM.test(domain)) return null;

  const rejection = rejectionReason_(subject, alternatives, sender);
  if (rejection) return {category: 'rejection', status: rejection};
  // Test interview outcomes before invitations; rescheduling also mentions scheduling.
  const interviewRules = [
    ['Cancelled', /\b(?:interview (?:has been |was |is )?cancel(?:led|ed)|cancel(?:led|ed) (?:your |the |our )?interview)\b/],
    ['Reschedule requested', /\breschedul\w*\b.{0,80}\binterview\b|\binterview\b.{0,80}\breschedul\w*\b/],
    ['Completed / follow-up', /\bthank you for (?:your time (?:in|during) (?:the |your )?)?interviewing\b|\b(?:following|after) your (?:recent )?interview\b/],
    ['Scheduled / confirmed', /\b(?:your |the |our )?interview (?:is |has been )?(?:scheduled|confirmed)\b|\bconfirm(?:ing|ed)? your interview\b/],
    ['Invitation / scheduling needed', /\binterview invitation\b|\binvite you (?:to|for) (?:an? |the |your )?interview\b|\b(?:schedule|book|confirm) (?:your|an|the|a) interview\b/],
  ];
  for (const [status, pattern] of interviewRules) {
    if (pattern.test(text)) return {category: 'interview', status};
  }
  if (/\b(?:pleased|excited|happy) to offer you\b|\b(?:your|the|attached) offer letter\b/.test(text)) {
    return {category: 'progress', status: 'Offer received'};
  }
  if (/\b(?:complete|take|invited to) (?:the|this|your|an?) (?:online |technical )?assessment\b/.test(text)) {
    return {category: 'progress', status: 'Assessment requested'};
  }
  if (/\b(?:still )?(?:reviewing|considering) your application\b|\bapplication (?:is )?(?:under review|being reviewed)\b/.test(text)) {
    return {category: 'progress', status: 'Application under review'};
  }
  if (/\b(?:thank you for applying|(?:we(?: have|'ve)?|we've successfully) received your (?:job )?application|your (?:job )?application (?:has been|was) (?:received|submitted)|application (?:received|confirmation))\b/.test(text)) {
    return {category: 'application', status: 'Application received'};
  }
  if (ACTIVE_STEP.test(text)) return {category: 'progress', status: 'Next step — review email'};
  return {category: 'other', status: 'Other job update — review email'};
}

function summaryDate_(timestamp, format = 'MMM d, yyyy h:mm a') {
  return Utilities.formatDate(new Date(timestamp), CLEANUP_TIME_ZONE, format);
}

function summaryEmail_(report, period, recipient = '') {
  const groups = [
    ['application', 'Application confirmation emails'],
    ['rejection', 'Rejection emails'],
    ['interview', 'Interview updates'],
    ['progress', 'Other progress / next steps'],
    ['other', 'Other job updates'],
  ];
  const range = `${summaryDate_(report.from)} – ${summaryDate_(report.to)} (${CLEANUP_TIME_ZONE})`;
  const totals = groups.map(([category, label]) => `${label}: ${report.updates.filter(update => update.category === category).length}`);
  const details = report.updates.slice(0, MAX_SUMMARY_DETAILS).map(update => {
    const link = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(recipient)}#all/${encodeURIComponent(update.id)}`;
    return `${update.status}: ${update.subject}\nFrom: ${update.sender || 'Unknown sender'}\n${summaryDate_(update.received)}\n${link}`;
  });
  const notes = [
    'Counts are classified emails, not unique applications. Interview statuses reflect email wording, not a calendar or a verified current application status.',
    'Includes matching mail in Trash and starred mail. Permanently deleted mail is unavailable. Summaries do not move any messages.',
  ];
  if (report.unreadable) notes.push(`${report.unreadable} message(s) could not be decoded; counts may be incomplete.`);
  if (report.updates.length > MAX_SUMMARY_DETAILS) notes.push(`Showing the latest ${MAX_SUMMARY_DETAILS} updates; totals include all ${report.updates.length}.`);
  const subject = `${SUMMARY_SUBJECT_PREFIX} ${period} · ${summaryDate_(report.to, 'MMM d, yyyy')}`;
  const body = [`${period} application summary`, range, totals.join('\n'),
    details.length ? details.join('\n\n') : 'No classified job updates in this period.', notes.join('\n\n')].join('\n\n');
  const htmlBody = `<div style="font-family:Arial,sans-serif;max-width:720px;color:#172033"><h2>${escapeSummaryHtml_(period)} application summary</h2><p>${escapeSummaryHtml_(range)}</p><pre style="white-space:pre-wrap;font-family:inherit;line-height:1.6">${escapeSummaryHtml_(body)}</pre></div>`;
  return {subject, body, htmlBody};
}

function escapeSummaryHtml_(text) {
  return text.replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
}
