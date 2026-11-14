# Gmail Job Rejection Cleanup

A personal Google Apps Script that finds job application rejection emails and moves them to Gmail Trash. Preview older messages before removing them, or enable hourly cleanup for new mail.

Optional morning and evening emails summarize application confirmations, rejections, interview updates, and other job progress.

Optional hourly reminders collect job emails that may need a reply or action into one email, and repeat while those items remain outstanding.

The script runs on Google's servers, even when your computer is off. It checks message text for clear rejection wording and acts on individual messages within conversations.

## Features at a glance

| Feature | Schedule in Los Angeles time | Enable once | Stop |
| --- | --- | --- | --- |
| Rejection cleanup | Roughly hourly, 5 PM–before 6 AM | `enableHourlyCleanup` | `disableHourlyCleanup` |
| Application summaries | Around 7 AM and 5 PM | `enableApplicationSummaries` | `disableApplicationSummaries` |
| Reply/action reminders | Roughly hourly, day and night | `enableReplyReminders` | `disableReplyReminders` |

Each feature is independent. Summaries count emails within a reporting period, not all-time rejections or unique applications. They include matching emails in Trash. Reminders send only when outstanding items are detected.

## Requirements and files

You need a Gmail account and a Google Apps Script project authorized by that account. No local server, paid AI API, or npm installation is required. Node.js is only needed to run the local tests.

| File | Purpose | Dependencies in the same Apps Script project |
| --- | --- | --- |
| [Code.gs](Code.gs) | Cleanup, matching rules, and shared Gmail helpers | None |
| [Summary.gs](Summary.gs) | Summary reports and job-update classification | `Code.gs` |
| [Reminders.gs](Reminders.gs) | Outstanding-action detection and reminder reports | `Code.gs` and `Summary.gs` |
| [appsscript.json](appsscript.json) | Runtime, timezone, Gmail service, and permissions | Required project manifest |
| [test.cjs](test.cjs) | Local tests using simulated Google services | Node.js; do not paste into Apps Script |

Install all three `.gs` files for the full feature set. Keeping `Summary.gs` installed does not enable summary emails; its enable function controls those timers.

## Set up

1. Sign into the Gmail account you want to clean up and open [Google Apps Script](https://script.google.com/home). Click **New project** and name it **Job Rejection Cleanup**.
2. Replace the contents of the default **Code.gs** editor tab with [Code.gs](Code.gs).
3. Open **Project Settings** and turn on **Show "appsscript.json" manifest file in editor**. Return to the editor, replace the manifest with [appsscript.json](appsscript.json), and save.
4. Select `previewRejections` in the function dropdown, click **Run**, and authorize the script with the correct Gmail account.
5. Review the dates, subjects, and match reasons in the **Execution log**. The preview saves matched message IDs in your script's user properties and makes no Gmail changes.

The manifest enables the advanced Gmail service. If you linked a standard Google Cloud project, [enable the Gmail API in that project](https://developers.google.com/apps-script/guides/services/advanced) as well.

## Run the cleanup

| Function | What it does |
| --- | --- |
| `previewRejections` | Previews matches from the past 7 days by default. Each preview replaces the previous one. |
| `trashReviewedRejections` | Moves reviewed matches to Trash. Run within 24 hours of the preview; protected messages and messages that no longer match are skipped. |
| `enableHourlyCleanup` | Enables cleanup roughly once an hour for mail received after activation. Run once. |
| `disableHourlyCleanup` | Stops scheduled cleanup. |

Historical cleanup and hourly cleanup are independent. Enabling hourly cleanup does not remove older mail.

Scheduled cleanup runs roughly hourly and only moves mail from **5 PM to before 6 AM in America/Los_Angeles**, including daylight saving changes. Daytime runs leave the checkpoint unchanged, so mail received during the day waits for an overnight run. If the window ends during cleanup, remaining messages wait for the next window. The trigger does not guarantee a run exactly at 5 PM. Manual previews and `trashReviewedRejections` remain available at any time.

Keep the code in the Apps Script project, but you can close the editor and turn off your computer. The function selected in the Run dropdown does not affect scheduled execution. Open **Triggers** to verify that `hourlyCleanup` exists.

## Morning and evening summaries

To add summaries to an existing Apps Script project:

1. Keep the current `Code.gs` and hourly cleanup trigger.
2. Click **+** next to Files, choose **Script**, name it **Summary**, and replace its contents with [Summary.gs](Summary.gs). Both script files must be in the same project.
3. Replace the manifest with the updated [appsscript.json](appsscript.json). It adds `script.send_mail` for sending summary emails.
4. Save and run `previewApplicationSummary`. Approve the updated permissions when prompted, then check the report in the execution log. This sends no email and moves no mail.
5. Run `sendApplicationSummaryNow` to send the first report to the Gmail account running the script. Check its inbox for a message starting with **[Job Mail Summary]**.
6. Run `enableApplicationSummaries` once. The Triggers page should show `morningApplicationSummary` and `eveningApplicationSummary` alongside the existing `hourlyCleanup` trigger.

The summary timers target **7 AM and 5 PM in America/Los_Angeles**, with daylight saving handled by Google's timezone support. Apps Script's `nearMinute(0)` scheduling is approximate, typically within 15 minutes before or after the requested time. Mailbox scanning adds delivery time. See [Google's timer documentation](https://developers.google.com/apps-script/reference/script/clock-trigger-builder).

Each report covers mail received since the previous successfully sent report. The first covers the previous 24 hours. A manual send also advances that checkpoint; previews do not. Morning and evening summaries therefore show separate periods rather than recounting the same emails. Zero-update periods still produce a summary. Re-enabling after a pause resumes from the last successful report.

Counts refer to **emails**, not unique applications: multiple updates about one role can be counted separately. Interview updates distinguish invitations, confirmations, rescheduling, cancellation, and follow-up wording. Other progress includes offers, assessments, and applications under review. Unknown job updates are listed for review. These rules infer status from English email text; they do not track calendar attendance or verify a company's current decision.

Summaries include starred mail and messages in Trash, so overnight cleanup does not hide rejection emails from the morning report. They exclude sent mail, drafts, spam, forwarded subjects, and the script's own summaries. Permanently deleted mail cannot be counted. Counts include every classified message in the reporting period, with details for the latest 30 and links to Gmail. Unreadable messages are disclosed as a count; classifications can miss unusual wording.

Run `disableApplicationSummaries` to stop the two summary timers while keeping cleanup active. Conversely, disabling cleanup leaves summaries active. Summary scans stop without sending or advancing the checkpoint if they exceed 200 candidates, take too long, or hit an API failure. Email-send failures also retain the checkpoint for retry. Check **Executions** for errors. If Google accepts an email but the run stops before saving its checkpoint, a retry may repeat the report.

## Hourly reminders for emails needing attention

Reply reminders are a separate hourly timer that operates **all day and night**. Each run sends at most one email containing all detected outstanding conversations. No email is sent when there are no outstanding items. The timer is approximate; scans and quotas can delay delivery.

To install:

1. Update `Code.gs` and `Summary.gs` in your existing Apps Script project. Both are required; summary email timers do not have to be enabled.
2. Add a new Script file named **Reminders** and paste in [Reminders.gs](Reminders.gs).
3. Use the current `appsscript.json`, which already includes `script.send_mail` from the summary feature. Save and approve updated permissions if prompted when running a function.
4. Run `previewReplyReminders` to inspect detected items in the execution log. It sends no email, creates no labels, and changes no mail.
5. Run `enableReplyReminders` once. This creates an `hourlyReplyReminders` timer and two visible Gmail labels: **Job Mail - Needs Reply** and **Job Mail - Handled**.
6. To check a real email immediately, run `hourlyReplyReminders` after enabling. It sends to the Gmail account running the script if outstanding items are detected. Repeated manual runs are suppressed for 55 minutes after a successful send.

Reminders detect interview invitations, rescheduling requests, availability requests, assessments, offers, and explicit requests to reply or confirm in job-related mail. Confirmations without a request, acknowledgments, recognized rejections, quoted requests, and this script's own reports do not trigger reminders. Detection uses English wording and can miss requests or produce false matches.

The first discovery scan looks back seven days (`REMINDER_INITIAL_DAYS`). Later scans cover mail since the last scan with a one-hour overlap. The **Needs Reply** label preserves pending items beyond that initial range. A conversation contributes one item, based on its latest incoming email. A later incoming update replaces an earlier request; a later rejection in Trash also resolves it.

To stop reminders for an item, reply in the **original Gmail conversation**, or apply **Job Mail - Handled** to the original email in Gmail. A later message with the `SENT` label in that conversation counts as a reply. A draft or a sent application from before the request does not. Reading or archiving an email alone does not resolve it. Replying in a different conversation, completing an assessment on another website, or scheduling externally cannot be detected; apply **Handled** yourself in those cases. A later incoming request can reopen reminders. Moving the latest incoming email to Trash also dismisses it.

Run `disableReplyReminders` to stop the reminder timer. Cleanup and morning/evening summaries continue independently. Existing Gmail labels remain for your reference.

Each scan allows at most 200 candidates and 60 conversations, with a runtime guard. A scan failure sends no partial report and keeps its discovery checkpoint. An email-send failure retains pending labels so the next run can retry. If Google accepts an email but saving the sent timestamp fails, a retry may duplicate that reminder. The script checks reply state during each scan; a reply sent after that check can result in one final reminder. Unreadable threads keep their existing pending label and are reported as unreadable in logs or reminders. Check **Executions** for limits or failures.

## Control the cleanup

- **Change the review range.** Edit `REVIEW_NEWER_THAN_DAYS` and `REVIEW_OLDER_THAN_DAYS` at the top of `Code.gs`. For mail received between 90 and 120 days ago, set them to `90` and `120`, respectively.
- **Keep a message.** Star it in Gmail. The script rechecks stars before moving each message. It also skips sent mail, drafts, spam, and messages already in Trash.
- **Restore a message.** Move it out of Trash and star it before resuming cleanup. Gmail normally keeps messages in Trash for up to 30 days.
- **Check activity.** Open **Executions** to see scheduled runs, counts, and errors. Scheduled scans keep a checkpoint and retry the same period after a failure. Use a historical preview to review mail received while cleanup was disabled.
- **Handle scan limits.** A scan stops before moving mail if it exceeds 350 Gmail search candidates. A historical preview also stops if it finds more than 100 matches. Narrow the review range and preview again. If a scheduled scan repeatedly hits the candidate limit, disable cleanup, review the affected period in smaller batches, then enable it again.

## Matching and access

The rules recognize common English rejection wording and skip apparent next steps such as interview scheduling, offers, and export-compliance requests. They can miss unusual wording, other languages, attachments, and image-only messages, or misread context. Use the preview to check matches against your mail.

Body decoding accepts both decoded byte arrays from the advanced Gmail service and base64 strings. If any body alternative cannot be decoded, the entire message is kept and its ID is logged as skipped; the scan continues with other messages.

Gmail requests are paced according to their quota cost, so larger scans can take several minutes. If a per-minute rate limit is reached, wait at least one minute before retrying and narrow the preview range. Other activity using the same quota can still cause limits. A failed preview is not saved; a failed scheduled scan keeps its checkpoint for retry. If a run times out, review a smaller date range.

The script uses the Gmail modify scope, so Google's authorization screen may describe additional actions. Cleanup reads messages and moves matches to Trash. Reply reminders also create tracking labels and update those labels on messages. The optional summaries and reminders use `MailApp` and the `script.send_mail` scope to send reports only to the running account's Gmail address. No mail is sent merely by enabling the timers or previewing a report. The project uses no external classifier and has no permanent-delete call. Preview logs include subjects; scheduled logs record counts.

| Manifest permission | Used for |
| --- | --- |
| `gmail.modify` | Read messages, move matched messages to Trash, and manage reminder labels |
| `script.scriptapp` | Create, inspect, and remove this project's scheduled triggers |
| `script.send_mail` | Send summaries and reminders to the running Gmail account |

Runtime state is stored in the executing user's Apps Script user properties: reviewed message IDs, activation and scan checkpoints, feature flags, and send timestamps. Reminder state also uses Gmail labels. These values are not stored in this repository. Each person installing a copy authorizes their own account and creates their own triggers.

## Troubleshooting and verification

### Cleanup says `Moved 0 message(s) to Trash`

This is a count of messages moved during that run, not a count of every rejection in the inbox. A successful execution with zero moves does not prove that no rejection emails exist.

1. Run `previewRejections` and inspect the subjects and reasons. The default range is the past seven days; increase `REVIEW_OLDER_THAN_DAYS` for older mail.
2. If the preview lists the intended messages, run `trashReviewedRejections` within 24 hours. The preview alone changes no mail.
3. Check the moved count in the execution log, then find the subjects in Gmail Trash. A Gmail search such as `in:trash newer_than:7d` helps find recent mail, but does not identify who moved it or when it was moved.
4. If the preview misses a message, check whether it is starred, forwarded, unreadable, or contains an apparent next step. Matching requires explicit rejection wording and job context in the current message; a subject alone is insufficient.

Automatic cleanup only covers messages received after activation. It also keeps a scan checkpoint, so changing wording rules does not automatically rescan all previously processed dates. Use a manual preview for emails missed before a rule update.

A regression test covers a named role such as "the Full Stack Engineer position at Example Company" followed by "we will not be moving forward with your application." Named roles must count as employment context as well as generic phrases such as "the position."

### `ReferenceError: REMINDER_PENDING_LABEL is not defined`

Check the copy of `Reminders.gs` inside **Google Apps Script**, not only your local editor. Its top-level constants must include:

```js
const REMINDER_PENDING_LABEL = 'Job Mail - Needs Reply';
const REMINDER_HANDLED_LABEL = 'Job Mail - Handled';
```

Replace the entire Apps Script file with the repository version, save, and rerun `enableReplyReminders`. Do not append a second copy: duplicate declarations can cause errors. If the error persists, confirm that you saved and ran the intended Apps Script project.

### No summary or reminder email arrives

- Preview first: `previewApplicationSummary` or `previewReplyReminders`. These write reports to the execution log without sending email.
- Test a summary with `sendApplicationSummaryNow`; it sends and advances the reporting checkpoint.
- Test reminders with `hourlyReplyReminders` after enabling them. No outstanding items means no email. A successful reminder send suppresses another send for 55 minutes.
- Check **Triggers** for `morningApplicationSummary`, `eveningApplicationSummary`, and `hourlyReplyReminders`, according to the features you enabled. Then check **Executions** for failures or quota errors.
- Ensure `Code.gs`, `Summary.gs`, and `Reminders.gs` are installed together and the current manifest is saved. Resolve any authorization prompt by running the relevant public function manually.

Summary rejection totals describe classified messages, not confirmed cleanup actions. Use cleanup execution logs and Gmail Trash to verify moves.

## Updating an installation

Local files and Google Apps Script are separate copies. A Git commit or GitHub push does not deploy this project.

1. Copy each changed `.gs` file into the matching file in your existing Apps Script project, replacing the full contents. Keep any personal configuration changes deliberately.
2. If the manifest changed, update `appsscript.json` too. Save and approve any newly required permissions by running a public function.
3. Run the relevant preview and inspect its output before moving mail or sending reports.
4. Check existing triggers. Updating code in the same project normally does not require enabling timers again. A new Apps Script project needs its own authorization and enable calls.

Do not delete shared helper functions or files that another installed feature depends on. To stop automation, use the corresponding disable function.

## Sharing the repository

Share the source files, manifest, tests, and documentation. Other users should follow setup in their own Apps Script project; they do not need access to your Gmail account or your running project.

Before publishing, review the actual files being committed. Exclude real email bodies, execution logs, account details, credentials, OAuth tokens, and screenshots containing mailbox information. The included `.gitignore` excludes local credentials and desktop screenshot filenames, but it cannot detect sensitive content or remove files already tracked by Git.

No license file is currently included. Choose and add a license before presenting the repository as open source so others know the terms for reuse. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report matching issues and validate changes.

## Maintain the code

`Code.gs` contains configuration and matching patterns, public cleanup functions, scanning and trash helpers, MIME parsing, and rejection classification. `Summary.gs` adds summary classification, report formatting, and the two daily timers using the shared helpers from `Code.gs`. `Reminders.gs` uses both files for hourly action detection and tracks outstanding conversations with Gmail labels. Helper function names end in `_`; use the public functions listed above to operate the project.

Keep wording rules in the classification patterns near the top of the file. When changing them, update the examples in `test.cjs` to cover both intended matches and similar messages that should be kept.

Run the local checks with Node.js:

```sh
node --test test.cjs
```

The tests simulate Apps Script services and check matching, previews, protected messages, scheduled cleanup, summary timing, reporting periods, decoding, and failure handling without accessing Gmail or sending actual mail.

[Google Apps Script trigger documentation](https://developers.google.com/apps-script/guides/triggers/installable) · [Gmail Trash and recovery](https://support.google.com/mail/answer/7401)
