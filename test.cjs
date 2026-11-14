const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const code = fs.readFileSync(require('node:path').join(__dirname, 'Code.gs'), 'utf8');
const summaryCode = fs.readFileSync(require('node:path').join(__dirname, 'Summary.gs'), 'utf8');
const reminderCode = fs.readFileSync(require('node:path').join(__dirname, 'Reminders.gs'), 'utf8');
const hour = 3600000;

function fixture() {
  let now = 1800000000000;
  const messages = new Map();
  const trash = [];
  const props = new Map();
  const triggers = [];
  const log = [];
  const sleeps = [];
  const emails = [];
  const searches = [];
  const labels = new Map();
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    console: {log: (...args) => log.push(args)},
    LockService: {getUserLock: () => ({waitLock() {}, releaseLock() {}})},
    PropertiesService: {getUserProperties: () => ({
      getProperty: key => props.get(key),
      setProperty: (key, value) => props.set(key, value),
      deleteProperty: key => props.delete(key),
      setProperties: values => Object.entries(values).forEach(([key, value]) => props.set(key, value)),
    })},
    ScriptApp: {
      getProjectTriggers: () => [...triggers],
      deleteTrigger: trigger => triggers.splice(triggers.indexOf(trigger), 1),
      newTrigger: handler => {
        const settings = {};
        const builder = {
          timeBased() { return builder; },
          everyHours(hours) { settings.everyHours = hours; return builder; },
          atHour(hour) { settings.hour = hour; return builder; },
          nearMinute(minute) { settings.minute = minute; return builder; },
          everyDays(days) { settings.days = days; return builder; },
          inTimezone(timeZone) { settings.timeZone = timeZone; return builder; },
          create() { triggers.push({getHandlerFunction: () => handler, ...settings}); },
        };
        return builder;
      },
    },
    MailApp: {sendEmail: email => emails.push(email)},
    Utilities: {
      formatDate: (date, timeZone, format) => {
        if (format === 'H') {
          return new Intl.DateTimeFormat('en-US', {timeZone, hour: 'numeric', hourCycle: 'h23'}).format(date);
        }
        if (format === 'yyyy-MM-dd') {
          const parts = new Intl.DateTimeFormat('en-US', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(date);
          const value = type => parts.find(part => part.type === type).value;
          return `${value('year')}-${value('month')}-${value('day')}`;
        }
        return new Intl.DateTimeFormat('en-US', {timeZone, dateStyle: 'medium', timeStyle: 'short'}).format(date);
      },
      sleep: ms => sleeps.push(ms),
      base64DecodeWebSafe: data => {
        // Node's decoder is permissive; require normalized input in this mock.
        assert.match(data, /^[A-Za-z0-9_-]*={0,2}$/);
        assert.equal(data.length % 4, 0);
        return Buffer.from(data, 'base64url');
      },
      newBlob: bytes => ({getDataAsString: () => Buffer.from(bytes).toString('utf8')}),
    },
    Gmail: {Users: {getProfile: () => ({emailAddress: 'owner@example.com'}),
    Labels: {
      list: () => ({labels: [...labels].map(([name, id]) => ({name, id}))}),
      create: ({name}) => {
        const id = 'Label_' + (labels.size + 1);
        labels.set(name, id);
        return {name, id};
      },
    },
    Threads: {
      get: (_user, threadId) => ({id: threadId, messages: [...messages.values()].filter(message => message.threadId === threadId)}),
    },
    Messages: {
      list: (_user, options) => {
        searches.push(options);
        const {pageToken} = options;
        const ids = Array.from(messages.keys()).filter(id =>
          !options.labelIds || options.labelIds.every(label => messages.get(id).labelIds.includes(label)));
        const start = Number(pageToken || 0);
        const page = ids.slice(start, start + 2).map(id => ({id, threadId: messages.get(id).threadId}));
        return {messages: page, nextPageToken: start + 2 < ids.length ? String(start + 2) : undefined};
      },
      get: (_user, id) => messages.get(id),
      batchModify: ({ids, addLabelIds = [], removeLabelIds = []}) => {
        for (const id of ids) {
          const message = messages.get(id);
          message.labelIds = [...new Set([...message.labelIds, ...addLabelIds])].filter(label => !removeLabelIds.includes(label));
        }
      },
      trash: (_user, id) => {
        messages.get(id).labelIds.push('TRASH');
        trash.push(id);
      },
    }}},
  });
  vm.runInContext(code, context);
  vm.runInContext(summaryCode, context);
  vm.runInContext(reminderCode, context);

  return {
    context, messages, trash, log, props, triggers, sleeps, emails, searches, labels,
    advance: ms => { now += ms; },
    setTime: iso => { now = Date.parse(iso); },
    add(id, body, options = {}) {
      const {subject = 'Update on your job application', mimeType = 'text/plain', labels = [], age = 1000, threadId = 'shared-thread'} = options;
      messages.set(id, {
        id,
        threadId,
        internalDate: String(now - age),
        labelIds: labels,
        payload: {
          mimeType,
          headers: [{name: 'Subject', value: subject}],
          body: {data: Buffer.from(body).toString('base64url')},
        },
      });
    },
  };
}

const rejection = "Thank you for applying. We won't be moving forward with your application.";

test('overnight window follows Los Angeles time in winter and summer', () => {
  const f = fixture();
  for (const [iso, expected] of [
    ['2026-11-10T00:59:00Z', false], // 4:59 PM PST
    ['2026-11-10T01:00:00Z', true], // 5 PM PST
    ['2026-11-10T13:59:00Z', true], // 5:59 AM PST
    ['2026-11-10T14:00:00Z', false], // 6 AM PST
    ['2026-07-10T00:00:00Z', true], // 5 PM PDT
    ['2026-07-10T13:00:00Z', false], // 6 AM PDT
  ]) {
    f.setTime(iso);
    assert.equal(f.context.isCleanupWindow_(), expected, iso);
  }
});

test('daytime mail waits until evening without advancing the checkpoint', () => {
  const f = fixture();
  f.setTime('2026-11-10T14:00:00Z');
  f.context.enableHourlyCleanup();
  const checkpoint = f.props.get('cleanupThrough');
  f.advance(hour);
  f.add('daytime', rejection);
  f.context.hourlyCleanup();
  assert.deepEqual(f.sleeps, []);
  assert.equal(f.props.get('cleanupThrough'), checkpoint);
  f.setTime('2026-11-11T01:00:00Z');
  f.context.hourlyCleanup();
  assert.deepEqual(f.trash, ['daytime']);
});

test('stops trashing when the window ends during a message read', () => {
  const f = fixture();
  f.setTime('2026-11-10T13:00:00Z');
  f.context.enableHourlyCleanup();
  const checkpoint = f.props.get('cleanupThrough');
  f.advance(hour - 1000);
  f.add('boundary', rejection);
  const get = f.context.Gmail.Users.Messages.get;
  let reads = 0;
  f.context.Gmail.Users.Messages.get = (...args) => {
    if (++reads === 2) f.advance(2000);
    return get(...args);
  };
  f.context.hourlyCleanup();
  assert.deepEqual(f.trash, []);
  assert.equal(f.props.get('cleanupThrough'), checkpoint);
});

test('decodes signed and unsigned byte arrays from Advanced Gmail', () => {
  const f = fixture();
  const text = rejection + ' \u2014 Thank you.';
  const bytes = [...Buffer.from(text)];
  for (const data of [bytes, bytes.map(byte => byte > 127 ? byte - 256 : byte)]) {
    assert.equal(f.context.decodeTextPart_({body: {data}}), text);
  }
  f.add('bytes', rejection);
  f.messages.get('bytes').payload.body.data = [...Buffer.from(rejection)];
  f.context.previewRejections();
  assert.deepEqual(JSON.parse(f.props.get('reviewedRejections')).ids, ['bytes']);
  assert.throws(() => f.context.bodyBytes_({}), /Unsupported body data type/);
  assert.throws(() => f.context.bodyBytes_([256]), /Invalid body byte array/);
});

test('paces Gmail requests and surfaces rate limits without saving a preview', () => {
  const f = fixture();
  f.add('rejection', rejection);
  f.context.previewRejections();
  assert.deepEqual(f.sleeps, [65, 780]);
  f.context.Gmail.Users.Messages.get = () => {
    throw new Error("Quota exceeded for quota metric 'Total Query Cost'");
  };
  assert.throws(() => f.context.previewRejections(), /Wait at least one minute/);
  assert.equal(f.props.has('reviewedRejections'), false);
  assert.deepEqual(f.trash, []);
  // A failed scheduled read must leave its checkpoint available for a later retry.
  f.context.enableHourlyCleanup();
  const checkpoint = f.props.get('cleanupThrough');
  f.advance(hour);
  assert.throws(() => f.context.hourlyCleanup(), /Wait at least one minute/);
  assert.equal(f.props.get('cleanupThrough'), checkpoint);
});

test('decodes padded and unpadded bodies with either base64 alphabet', () => {
  const {context} = fixture();
  for (const text of ['a', 'ab', 'abc', rejection, 'Unicode: \u{1ffff}']) {
    for (const encoding of ['base64', 'base64url']) {
      const data = Buffer.from(text).toString(encoding);
      for (const value of [data, data.replace(/=+$/, ''), `\n${data}\r\n`]) {
        assert.equal(context.decodeTextPart_({body: {data: value}}), text);
      }
    }
  }
});

test('preserves messages with an unreadable alternative and continues the preview', () => {
  const f = fixture();
  for (const data of ['invalid!', 'a']) {
    f.add(data, rejection);
    const payload = f.messages.get(data).payload;
    payload.parts = [{mimeType: 'text/html', body: {data}}];
  }
  f.add('valid', rejection);
  f.context.previewRejections();
  assert.deepEqual(JSON.parse(f.props.get('reviewedRejections')).ids, ['valid']);
  // Even a previously reviewed message is preserved if a body becomes unreadable.
  f.messages.get('valid').payload.body.data = 'invalid!';
  f.context.trashReviewedRejections();
  assert.deepEqual(f.trash, []);
  assert.ok(f.log.some(args => String(args[0]).includes('Skipped message')));
});

test('recognizes common explicit rejections', () => {
  const {context} = fixture();
  for (const body of [
    rejection,
    'Thank you for applying. We have decided to move forward with other candidates.',
    'Your application was unsuccessful.',
    'You were not selected for this role.',
    'Thank you for applying. The position has been filled.',
    'After your recent interview, we are unable to offer you this role.',
    'We have decided not to invite you for an interview for this position.',
  ]) {
    assert.ok(context.rejectionReason_('Job application update', [body]), body);
  }
});

test('recognizes a named position at a company without a recruiting-platform sender', () => {
  const {context} = fixture();
  const subject = 'Your application to Full Stack Engineer at Mastech';
  const body = 'Thank you for your interest in the Full Stack Engineer position at Mastech in Durham, North Carolina, United States. Unfortunately, we will not be moving forward with your application, but we appreciate your time and interest in Mastech.\n\nRegards,\nMastech';
  assert.equal(context.rejectionReason_(subject, [body], 'Hiring <jobs@example.com>'), 'Not moving forward');
  assert.equal(context.rejectionReason_(subject, [body + ' Please confirm your availability.']), null);
  assert.equal(context.rejectionReason_('Rental application', [body + ' Your rental application was declined.']), null);
});

test('skips active, quoted, ambiguous, and unrelated messages', () => {
  const {context} = fixture();
  for (const body of [
    'Thank you for applying. We are still reviewing your application.',
    'Please confirm your availability for the next round.',
    rejection + " We'd like to discuss a different role.",
    rejection + ' Please complete the export compliance paperwork.',
    "We won't move forward with your application until you upload a resume.",
    'This position has been filled.',
    'Your refund request was declined.',
    'Your application was declined.',
    'Your rental application was declined. Your application was unsuccessful.',
    'Your application was declined by the admissions committee after your interview.',
    'Thanks for getting back to me.\n\nOn Tue, recruiter@example.com wrote:\n' + rejection,
    'Thanks for getting back to me.\n> ' + rejection,
  ]) {
    assert.equal(context.rejectionReason_('Update', [body]), null, body);
  }
});

test('recognizes a generic subject and body from a recruiting platform', () => {
  const {context} = fixture();
  assert.ok(context.rejectionReason_('Application update', [rejection], 'Talent <notify@mail.lever.co>'));
  assert.equal(context.rejectionReason_('Application update', [rejection], 'lever.co <notices@example.org>'), null);
});

test('previews without writes and trashes only reviewed, unstarred messages', () => {
  const f = fixture();
  f.add('plain', rejection);
  f.add('offer', 'We are pleased to offer you this position.');
  f.add('html', '<p>Thank you for applying.</p><p>We won&rsquo;t be moving forward with your application.</p>', {mimeType: 'text/html'});
  f.add('quote', '<p>Thanks for the note.</p><div class="gmail_quote">' + rejection + '</div>', {mimeType: 'text/html'});
  f.add('forward', rejection, {subject: 'Fwd: Update'});
  f.add('old', rejection, {age: 100 * 24 * hour});
  f.add('starred', rejection, {labels: ['STARRED']});

  f.context.previewRejections();
  assert.deepEqual(f.trash, []);
  assert.deepEqual(JSON.parse(f.props.get('reviewedRejections')).ids, ['plain', 'html']);
  f.messages.get('plain').labelIds.push('STARRED');
  f.add('arrived-later', rejection);
  f.context.trashReviewedRejections();
  assert.deepEqual(f.trash, ['html']);
  assert.throws(() => f.context.trashReviewedRejections(), /Run previewRejections first/);
});

test('enables one trigger, handles new mail only, and disables the job', () => {
  const f = fixture();
  f.add('historical', rejection);
  f.context.enableHourlyCleanup();
  f.context.enableHourlyCleanup();
  assert.equal(f.triggers.length, 1);
  assert.equal(f.triggers[0].everyHours, 1);
  f.advance(hour);
  f.add('fresh', rejection);
  f.context.hourlyCleanup();
  f.context.hourlyCleanup();
  assert.deepEqual(f.trash, ['fresh']);
  f.context.disableHourlyCleanup();
  assert.equal(f.triggers.length, 0);
  f.advance(hour);
  f.add('after-disable', rejection);
  f.context.hourlyCleanup();
  assert.deepEqual(f.trash, ['fresh']);
});

test('creates two daily summaries without duplicating or deleting the cleanup trigger', () => {
  const f = fixture();
  f.context.enableHourlyCleanup();
  f.context.enableApplicationSummaries();
  f.context.enableApplicationSummaries();
  const daily = f.triggers.filter(trigger => trigger.days);
  assert.deepEqual(daily.map(trigger => trigger.hour), [7, 17]);
  assert.ok(daily.every(trigger => trigger.minute === 0 && trigger.days === 1 && trigger.timeZone === 'America/Los_Angeles'));
  assert.deepEqual(f.emails, []);
  f.context.disableApplicationSummaries();
  assert.equal(f.triggers.length, 1);
  assert.equal(f.triggers[0].getHandlerFunction(), 'hourlyCleanup');
  f.context.morningApplicationSummary();
  assert.deepEqual(f.emails, []);
});

test('classifies application and interview updates without changing rejection cleanup rules', () => {
  const f = fixture();
  for (const [body, category, status] of [
    ['We received your application for this position.', 'application', 'Application received'],
    [rejection, 'rejection', 'Not moving forward'],
    ['We would like to invite you to an interview for this role.', 'interview', 'Invitation / scheduling needed'],
    ['Your interview is confirmed for this position.', 'interview', 'Scheduled / confirmed'],
    ['Please reschedule your interview for this role.', 'interview', 'Reschedule requested'],
    ['Your interview has been cancelled for this position.', 'interview', 'Cancelled'],
    ['Thank you for interviewing for this position.', 'interview', 'Completed / follow-up'],
    ['We are pleased to offer you this position.', 'progress', 'Offer received'],
    ['Please complete your technical assessment for this role.', 'progress', 'Assessment requested'],
    ['We are still reviewing your application for this position.', 'progress', 'Application under review'],
  ]) {
    const result = f.context.applicationUpdate_('Job application update', [body], 'recruiter@example.com');
    assert.equal(result?.category, category, body);
    assert.equal(result?.status, status, body);
  }
  assert.equal(f.context.applicationUpdate_('Rental application', ['Your rental application was received.'], ''), null);
  assert.equal(f.context.applicationUpdate_('Sale', ['Book an interview with our celebrity guest.'], ''), null);
  assert.equal(f.context.applicationUpdate_('Thank you for applying', ['We received your application.'], 'careers@example.com').category, 'application');
});

test('summary previews count trashed and starred mail, omit own summaries, and make no writes', () => {
  const f = fixture();
  f.add('application', 'We received your application for this position.');
  f.add('rejection', rejection, {labels: ['TRASH']});
  f.add('interview', 'Your interview is confirmed for this position.', {labels: ['STARRED']});
  f.add('old', rejection, {age: 25 * hour});
  f.add('sent', rejection, {labels: ['SENT']});
  f.add('spam', rejection, {labels: ['SPAM']});
  f.add('own-summary', rejection, {subject: '[Job Mail Summary] Morning'});
  f.add('forward', rejection, {subject: 'Fwd: job application'});
  f.add('unreadable', rejection);
  f.messages.get('unreadable').payload.body.data = {};
  f.context.previewApplicationSummary();
  const body = f.log[0][0];
  assert.match(body, /Application confirmation emails: 1/);
  assert.match(body, /Rejection emails: 1/);
  assert.match(body, /Interview updates: 1/);
  assert.match(body, /1 message\(s\) could not be decoded/);
  assert.ok(f.searches.every(search => search.includeSpamTrash && search.q.includes('in:anywhere')));
  assert.equal(f.props.size, 0);
  assert.deepEqual(f.emails, []);
  assert.deepEqual(f.trash, []);
});

test('summaries send to the account owner and cover consecutive periods without recounting mail', () => {
  const f = fixture();
  f.context.enableApplicationSummaries();
  f.add('first', rejection);
  f.context.morningApplicationSummary();
  assert.equal(f.emails.length, 1);
  assert.equal(f.emails[0].to, 'owner@example.com');
  assert.match(f.emails[0].body, /Rejection emails: 1/);
  const firstThrough = f.props.get('applicationSummaryThrough');
  f.context.morningApplicationSummary();
  assert.equal(f.emails.length, 1);
  f.advance(10 * hour);
  f.add('second', 'Your interview is confirmed for this position.');
  f.context.eveningApplicationSummary();
  assert.equal(f.emails.length, 2);
  assert.match(f.emails[1].body, /Rejection emails: 0/);
  assert.match(f.emails[1].body, /Interview updates: 1/);
  assert.notEqual(f.props.get('applicationSummaryThrough'), firstThrough);
  assert.deepEqual(f.trash, []);
});

test('send and Gmail failures keep the summary checkpoint and slot available for retry', () => {
  const f = fixture();
  f.context.enableApplicationSummaries();
  f.add('first', rejection);
  f.props.set('applicationSummaryThrough', String(1800000000000 - hour));
  const through = f.props.get('applicationSummaryThrough');
  const send = f.context.MailApp.sendEmail;
  f.context.MailApp.sendEmail = () => { throw new Error('Email quota exceeded'); };
  assert.throws(() => f.context.morningApplicationSummary(), /Email quota/);
  assert.equal(f.props.get('applicationSummaryThrough'), through);
  assert.equal(f.props.has('applicationSummarySlot'), false);
  f.context.MailApp.sendEmail = send;
  f.context.morningApplicationSummary();
  assert.equal(f.emails.length, 1);
  f.advance(hour);
  const sentThrough = f.props.get('applicationSummaryThrough');
  f.context.Gmail.Users.Messages.get = () => { throw new Error('Quota exceeded'); };
  assert.throws(() => f.context.eveningApplicationSummary(), /Gmail rate limit/);
  assert.equal(f.props.get('applicationSummaryThrough'), sentThrough);
  assert.equal(f.emails.length, 1);
});

test('scan caps stop delivery, HTML escapes email text, and details do not truncate totals', () => {
  const f = fixture();
  for (let index = 0; index < 201; index++) f.add(String(index), rejection);
  assert.throws(() => f.context.sendApplicationSummaryNow(), /Summary scan limit/);
  assert.deepEqual(f.emails, []);
  assert.equal(f.props.has('applicationSummaryThrough'), false);
  const updates = Array.from({length: 31}, (_, index) => ({
    id: String(index), received: 1800000000000, subject: '<img src=x onerror=bad()>',
    sender: '"Recruiter" <recruiter@example.com>', category: 'interview', status: 'Scheduled',
  }));
  const email = f.context.summaryEmail_({from: 1799999999000, to: 1800000000000, updates, unreadable: 0}, 'Morning');
  assert.match(email.body, /Interview updates: 31/);
  assert.match(email.body, /Showing the latest 30/);
  assert.ok(!email.htmlBody.includes('<img'));
  assert.match(email.htmlBody, /&lt;img/);
});

const invitation = 'We would like to invite you to an interview for this position. Please share your availability.';

test('hourly reminder setup is idempotent and independent of other timers', () => {
  const f = fixture();
  f.context.enableHourlyCleanup();
  f.context.enableApplicationSummaries();
  f.context.enableReplyReminders();
  f.context.enableReplyReminders();
  assert.equal(f.triggers.length, 4);
  assert.equal(f.triggers.find(trigger => trigger.getHandlerFunction() === 'hourlyReplyReminders').everyHours, 1);
  assert.ok(f.labels.has('Job Mail - Needs Reply'));
  assert.ok(f.labels.has('Job Mail - Handled'));
  assert.deepEqual(f.emails, []);
  f.context.disableReplyReminders();
  assert.equal(f.triggers.length, 3);
  f.context.hourlyReplyReminders();
  assert.deepEqual(f.emails, []);
});

test('attention detection excludes rejections, confirmations without action, and quoted requests', () => {
  const f = fixture();
  for (const [id, body, expected] of [
    ['invite', invitation, true],
    ['availability', 'For this position, please provide your availability for a call.', true],
    ['assessment', 'Please complete your technical assessment for this role.', true],
    ['confirm', 'Your interview is confirmed for this position. Please reply to confirm.', true],
    ['rejected', rejection, false],
    ['ack', 'We received your application for this position.', false],
    ['confirmed', 'Your interview is confirmed for this position.', false],
    ['cancelled', 'Your interview has been cancelled for this position.', false],
    ['quote', 'Thanks.\nOn Tue recruiter@example.com wrote:\n' + invitation, false],
  ]) {
    f.add(id, body);
    assert.equal(Boolean(f.context.attentionItem_(f.messages.get(id))), expected, id);
  }
});

test('one reminder covers multiple conversations, repeats hourly in daytime, and stops after replies', () => {
  const f = fixture();
  f.setTime('2026-11-10T20:00:00Z'); // Noon PST, outside overnight cleanup.
  f.add('invite', invitation, {threadId: 'interview'});
  f.add('assessment', 'Please complete your technical assessment for this role.', {threadId: 'assessment'});
  f.context.enableReplyReminders();
  f.context.hourlyReplyReminders();
  assert.equal(f.emails.length, 1);
  assert.match(f.emails[0].body, /2 job conversation/);
  assert.equal(f.emails[0].to, 'owner@example.com');
  const pending = f.labels.get('Job Mail - Needs Reply');
  assert.ok(f.messages.get('invite').labelIds.includes(pending));
  f.context.hourlyReplyReminders();
  assert.equal(f.emails.length, 1);
  f.advance(hour);
  f.context.hourlyReplyReminders();
  assert.equal(f.emails.length, 2);
  f.advance(hour);
  f.add('reply', 'Tuesday works for me.', {threadId: 'interview', labels: ['SENT']});
  f.messages.get('assessment').labelIds.push(f.labels.get('Job Mail - Handled'));
  f.context.hourlyReplyReminders();
  assert.equal(f.emails.length, 2);
  assert.ok(!f.messages.get('invite').labelIds.includes(pending));
  assert.ok(!f.messages.get('assessment').labelIds.includes(pending));
  assert.deepEqual(f.trash, []);
});

test('an earlier sent application does not count as a reply, but a later incoming request reopens attention', () => {
  const f = fixture();
  f.add('sent-application', 'My application.', {labels: ['SENT'], age: hour});
  f.add('invite', invitation);
  f.context.enableReplyReminders();
  f.context.hourlyReplyReminders();
  assert.equal(f.emails.length, 1);
  f.advance(hour);
  f.add('reply', 'Monday works.', {labels: ['SENT']});
  f.context.hourlyReplyReminders();
  assert.equal(f.emails.length, 1);
  f.advance(hour);
  f.add('followup', 'Please reschedule your interview for this role.');
  f.context.hourlyReplyReminders();
  assert.equal(f.emails.length, 2);
  assert.match(f.emails[1].body, /Reschedule requested/);
  assert.ok(f.messages.get('followup').labelIds.includes(f.labels.get('Job Mail - Needs Reply')));
});

test('previews do not create labels, timers, messages, or checkpoints', () => {
  const f = fixture();
  f.add('invite', invitation);
  f.context.previewReplyReminders();
  assert.match(f.log[0][0], /1 job conversation/);
  assert.equal(f.labels.size, 0);
  assert.equal(f.props.size, 0);
  assert.equal(f.triggers.length, 0);
  assert.deepEqual(f.emails, []);
});

test('older pending messages remain tracked and unreadable threads do not lose their pending label', () => {
  const f = fixture();
  f.context.enableReplyReminders();
  const pending = f.labels.get('Job Mail - Needs Reply');
  f.add('old', invitation, {age: 30 * 24 * hour, labels: [pending]});
  // Only the pending-label query returns this old item, as Gmail would.
  const list = f.context.Gmail.Users.Messages.list;
  f.context.Gmail.Users.Messages.list = (user, options) => options.labelIds ? list(user, options) : {messages: []};
  f.context.hourlyReplyReminders();
  assert.equal(f.emails.length, 1);
  f.advance(hour);
  f.messages.get('old').payload.body.data = {};
  f.context.hourlyReplyReminders();
  assert.equal(f.emails.length, 1);
  assert.ok(f.messages.get('old').labelIds.includes(pending));
});

test('mail send failures preserve pending tracking and allow retry without an hourly suppression', () => {
  const f = fixture();
  f.add('invite', invitation);
  f.context.enableReplyReminders();
  const send = f.context.MailApp.sendEmail;
  f.context.MailApp.sendEmail = () => { throw new Error('Email quota exceeded'); };
  assert.throws(() => f.context.hourlyReplyReminders(), /Email quota/);
  assert.equal(f.props.has('replyReminderSent'), false);
  assert.ok(f.messages.get('invite').labelIds.includes(f.labels.get('Job Mail - Needs Reply')));
  f.context.MailApp.sendEmail = send;
  f.context.hourlyReplyReminders();
  assert.equal(f.emails.length, 1);
});

test('reminder scan failures keep discovery checkpoints and avoid misleading partial emails', () => {
  const f = fixture();
  for (let index = 0; index < 61; index++) f.add(String(index), invitation, {threadId: String(index)});
  f.context.enableReplyReminders();
  assert.throws(() => f.context.hourlyReplyReminders(), /Reply-reminder scan limit/);
  assert.equal(f.props.has('replyRemindersThrough'), false);
  assert.deepEqual(f.emails, []);
  assert.ok([...f.messages.values()].every(message => !message.labelIds.includes(f.labels.get('Job Mail - Needs Reply'))));
});

test('generated reports are never cleanup candidates or job updates to count', () => {
  const f = fixture();
  for (const prefix of ['[Job Mail Reminder]', '[Job Mail Summary]']) {
    f.add(prefix, rejection, {subject: prefix + ' Job application update'});
    assert.equal(f.context.readMatch_(prefix), null);
    assert.equal(f.context.attentionItem_(f.messages.get(prefix)), null);
  }
  f.context.previewApplicationSummary();
  assert.match(f.log.at(-1)[0], /Rejection emails: 0/);
});

test('a later rejection in Trash resolves an earlier pending interview invitation', () => {
  const f = fixture();
  f.add('invite', invitation);
  f.context.enableReplyReminders();
  f.context.hourlyReplyReminders();
  assert.equal(f.emails.length, 1);
  f.advance(hour);
  f.add('rejection', rejection, {labels: ['TRASH']});
  f.context.hourlyReplyReminders();
  assert.equal(f.emails.length, 1);
  assert.ok(!f.messages.get('invite').labelIds.includes(f.labels.get('Job Mail - Needs Reply')));
});
