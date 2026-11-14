const REMINDERS_ENABLED_KEY = 'replyRemindersEnabled';
const REMINDERS_THROUGH_KEY = 'replyRemindersThrough';
const REMINDERS_SENT_KEY = 'replyReminderSent';
const REMINDER_PENDING_LABEL = 'Job Mail - Needs Reply';
const REMINDER_HANDLED_LABEL = 'Job Mail - Handled';
const REMINDER_SUBJECT_PREFIX = '[Job Mail Reminder]';
const REMINDER_INITIAL_DAYS = 7;
const MAX_REMINDER_CANDIDATES = 200;
const MAX_REMINDER_THREADS = 60;
const REMINDER_TIMEOUT_MS = 4 * 60 * 1000;
const REMINDER_MIN_INTERVAL_MS = 55 * 60 * 1000;

function enableReplyReminders() {
  withLock_(() => {
    reminderLabels_(true);
    if (!ScriptApp.getProjectTriggers().some(isReminderTrigger_)) {
      ScriptApp.newTrigger('hourlyReplyReminders').timeBased().everyHours(1).create();
    }
    PropertiesService.getUserProperties().setProperty(REMINDERS_ENABLED_KEY, 'true');
    console.log('Hourly reply reminders enabled, day and night. Apply "%s" in Gmail to stop reminders for a message.', REMINDER_HANDLED_LABEL);
  });
}

function disableReplyReminders() {
  withLock_(() => {
    PropertiesService.getUserProperties().deleteProperty(REMINDERS_ENABLED_KEY);
    for (const trigger of ScriptApp.getProjectTriggers().filter(isReminderTrigger_)) {
      ScriptApp.deleteTrigger(trigger);
    }
    console.log('Reply reminders disabled. Cleanup and summaries remain active.');
  });
}

function isReminderTrigger_(trigger) {
  return trigger.getHandlerFunction() === 'hourlyReplyReminders';
}

function previewReplyReminders() {
  withLock_(() => {
    const report = replyReminderReport_(reminderLabels_(false));
    console.log(replyReminderEmail_(report).body);
  });
}

function hourlyReplyReminders() {
  withLock_(() => {
    const props = PropertiesService.getUserProperties();
    if (props.getProperty(REMINDERS_ENABLED_KEY) !== 'true') return;
    const lastSent = Number(props.getProperty(REMINDERS_SENT_KEY));
    if (lastSent && Date.now() - lastSent < REMINDER_MIN_INTERVAL_MS) return;

    const labels = reminderLabels_(true);
    const report = replyReminderReport_(labels);
    // Labels retain outstanding items even after they leave the discovery window.
    if (report.add.length) {
      gmailRequest_(50, () => Gmail.Users.Messages.batchModify({ids: report.add, addLabelIds: [labels.pending]}, 'me'));
    }
    if (report.remove.length) {
      gmailRequest_(50, () => Gmail.Users.Messages.batchModify({ids: report.remove, removeLabelIds: [labels.pending]}, 'me'));
    }
    props.setProperty(REMINDERS_THROUGH_KEY, String(report.to));
    if (!report.items.length) {
      console.log('No job emails currently need a reply or action. %s thread(s) unreadable.', report.unreadable);
      return;
    }
    const recipient = gmailRequest_(1, () => Gmail.Users.getProfile('me')).emailAddress;
    if (!recipient) throw new Error('Gmail did not return a reminder recipient.');
    MailApp.sendEmail({to: recipient, ...replyReminderEmail_(report, recipient), name: 'Job Mail Reminders'});
    props.setProperty(REMINDERS_SENT_KEY, String(Date.now()));
    console.log('Sent one reminder email covering %s outstanding thread(s).', report.items.length);
  });
}

function reminderLabels_(create) {
  const labels = gmailRequest_(1, () => Gmail.Users.Labels.list('me')).labels || [];
  const result = {};
  for (const [key, name] of [['pending', REMINDER_PENDING_LABEL], ['handled', REMINDER_HANDLED_LABEL]]) {
    const existing = labels.find(label => label.name === name);
    if (existing) result[key] = existing.id;
    else if (create) {
      result[key] = gmailRequest_(5, () => Gmail.Users.Labels.create({
        name, labelListVisibility: 'labelShow', messageListVisibility: 'show',
      }, 'me')).id;
    }
  }
  return result;
}

function replyReminderReport_(labels) {
  const to = Date.now();
  const checkpoint = Number(PropertiesService.getUserProperties().getProperty(REMINDERS_THROUGH_KEY));
  // An overlap allows recently indexed incoming mail another chance to be discovered.
  const from = checkpoint ? checkpoint - 60 * 60 * 1000 : to - REMINDER_INITIAL_DAYS * DAY_MS;
  const q = `after:${Math.floor(from / 1000) - 1} before:${Math.ceil(to / 1000) + 1} -in:sent -in:drafts -in:spam -in:trash ${SUMMARY_SEARCH}`;
  const queries = [{q}];
  if (labels.pending) queries.push({labelIds: [labels.pending]});
  const seen = new Set();
  const threads = new Set();
  for (const query of queries) {
    let pageToken;
    do {
      const page = gmailRequest_(5, () => Gmail.Users.Messages.list('me', {
        ...query, maxResults: 100, ...(pageToken ? {pageToken} : {}),
      }));
      for (const candidate of page.messages || []) {
        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        if (seen.size > MAX_REMINDER_CANDIDATES) throw reminderScanLimit_();
        // Gmail's list response normally includes threadId; retain a fallback.
        const threadId = candidate.threadId || summaryMessage_(candidate.id)?.threadId;
        if (threadId) threads.add(threadId);
        if (threads.size > MAX_REMINDER_THREADS || Date.now() - to > REMINDER_TIMEOUT_MS) throw reminderScanLimit_();
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  const items = [];
  const add = [];
  const remove = [];
  let unreadable = 0;
  for (const threadId of threads) {
    if (Date.now() - to > REMINDER_TIMEOUT_MS) throw reminderScanLimit_();
    let thread;
    try {
      thread = gmailRequest_(160, () => Gmail.Users.Threads.get('me', threadId, {format: 'full'}));
    } catch (error) {
      if (/\b(?:404|requested entity was not found)\b/i.test(String(error))) continue;
      throw error;
    }
    const messages = thread.messages || [];
    // Inspect only the latest incoming update in a conversation. A later reply resolves it.
    const incoming = messages.filter(message => !(message.labelIds || []).some(label =>
      ['SENT', 'DRAFT', 'SPAM'].includes(label)))
      .sort((a, b) => Number(b.internalDate) - Number(a.internalDate))[0];
    let item = null;
    if (incoming && !(incoming.labelIds || []).some(label => label === labels.handled || label === 'TRASH')) {
      const replied = messages.some(message => (message.labelIds || []).includes('SENT') &&
        Number(message.internalDate) > Number(incoming.internalDate));
      if (!replied) {
        try {
          item = attentionItem_(incoming);
        } catch {
          // Preserve existing tracking rather than clearing an unreadable conversation.
          unreadable++;
          continue;
        }
      }
    }
    if (item) {
      items.push(item);
      if (!(incoming.labelIds || []).includes(labels.pending)) add.push(incoming.id);
    }
    for (const message of messages) {
      if ((message.labelIds || []).includes(labels.pending) && message.id !== item?.id) remove.push(message.id);
    }
  }
  items.sort((a, b) => a.received - b.received);
  return {to, items, add, remove, unreadable};
}

function reminderScanLimit_() {
  return new Error('Reply-reminder scan limit reached; no reminder was sent and the discovery checkpoint was kept. Reduce REMINDER_INITIAL_DAYS for the first scan or review the pending-mail backlog.');
}

function attentionItem_(message) {
  const headers = message.payload?.headers || [];
  const subject = headerValue_(headers, 'subject');
  if (/^\[Job Mail (?:Summary|Reminder)\]/i.test(subject) || FORWARDED_SUBJECT.test(subject)) return null;
  const sender = headerValue_(headers, 'from');
  const alternatives = messageText_(message.payload);
  const update = applicationUpdate_(subject, alternatives, sender);
  if (!update || update.category === 'rejection' || ['Cancelled', 'Completed / follow-up'].includes(update.status)) return null;
  const text = alternatives.map(currentBodyText_).join(' ');
  const request = /\b(?:please|kindly) (?:reply|respond|confirm|share|provide|send|let us know)|\b(?:reply to this (?:email|message)|confirm your availability|share your availability|provide your availability)\b/;
  const actionable = ['Invitation / scheduling needed', 'Reschedule requested', 'Assessment requested', 'Offer received'].includes(update.status);
  if (!actionable && !request.test(text)) return null;
  return {id: message.id, received: Number(message.internalDate), subject, sender, status: update.status};
}

function replyReminderEmail_(report, recipient = '') {
  const details = report.items.map(item => {
    const link = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(recipient)}#all/${encodeURIComponent(item.id)}`;
    return `${item.subject}\n${item.status}\nFrom: ${item.sender || 'Unknown sender'}\nReceived: ${summaryDate_(item.received)}\n${link}`;
  });
  const body = [
    `${report.items.length} job conversation(s) may need your reply or action.`,
    details.length ? details.join('\n\n') : 'No outstanding items detected.',
    `Reply in the original Gmail conversation to stop reminders. If you handled it elsewhere, no reply is needed, or this is a false match, apply the Gmail label "${REMINDER_HANDLED_LABEL}" to the original email. Reading it alone does not stop reminders.`,
    'This reminder repeats roughly hourly while items remain outstanding, including during the day. Never reply to this reminder itself. Requests and statuses are inferred from email wording; external scheduling or assessment completion cannot be detected.',
    report.unreadable ? `${report.unreadable} thread(s) could not be decoded; this list may be incomplete.` : '',
  ].filter(Boolean).join('\n\n');
  return {
    subject: `${REMINDER_SUBJECT_PREFIX} ${report.items.length} conversation(s) need attention`,
    body,
    htmlBody: `<div style="font-family:Arial,sans-serif;max-width:720px"><h2>Job emails needing attention</h2><pre style="white-space:pre-wrap;font-family:inherit;line-height:1.6">${escapeSummaryHtml_(body)}</pre></div>`,
  };
}
