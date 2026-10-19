# Daily vocabulary review

A real voice-only learning routine: save a word with your own cue, review due
words, report whether you recalled them, and continue the next day. This plugin
is one JavaScript file and a manifest on Windows, macOS and Linux/headless.
It needs no network, account, API key, local model or custom host UI.

## Try it in LILO

For local development, rebuild with `node scripts/build-marketplace.mjs` and set
the marketplace URL to your checkout's `examples/plugins` directory. Packaged
installations use the default marketplace.

1. Open Settings → Plugins and refresh the default marketplace.
2. Install **Daily vocabulary review**.
3. Say “Remember the word hello with cue a greeting.”
4. Say “Review my vocabulary.” The panel also lists due words and cues.
5. Say “I recalled the word hello” or “Review the word hello again.”
6. Say “Review my vocabulary daily at 18:00.” For a quick check, choose the
   next local minute, keep LILO running and check for the notification.
7. Restart LILO before the chosen time. The saved vocabulary and job should
   remain. Inspect the routine in the plugin's opening context.
8. Say “Stop my vocabulary reminders.” Vocabulary remains available offline.
9. Say “Forget my vocabulary word hello” and confirm. Both current memory and
   its recovery snapshot exclude the forgotten word.

Portuguese and Italian equivalents are declared in the JavaScript command
templates. A beginner can speak their own language; this guide uses English examples.
The saved cues can concern any language; explanations use the conversation's
language. Time currently requires an HH:MM transcript; interpreting spoken
time expressions is a separate workflow.

## How it works

`lilo.memory` stores up to 50 words, cues, recall-report counts and next due
timestamps with schema version 1 and revision guards. A successful recall
report increases the interval, capped at 30 days; retry schedules tomorrow.
These are self-reports, not assessed mastery, pronunciation or a CEFR level.
Read the due list before viewing cues if you want to attempt recall first.

`lilo.schedule` stores a one-shot job. Its callback first schedules the next
local calendar occurrence using JavaScript `Date`, then publishes `notify`.
No language or calendar rule exists in Rust. The scheduler persists a claim
before invocation and never replays an uncertain claim after a crash. A missed
job runs once when the plugin resumes, rather than replaying every missed day.
The next time is recalculated with the device's current time zone; a time zone
change does not automatically move an already queued occurrence.

LILO and this plugin must be running for delivery. Notifications do not open a
voice call. Spoken delivery depends on an active compatible voice session.
A crash between claiming and delivery can lose that reminder; vocabulary still
remains due and the next manual review can continue. The routine can be enabled
again after an interrupted callback. This is not an OS background alarm.

The UI uses existing declarative status/actions/list blocks. Unknown schemas
and invalid data fail explicitly without resetting memory. Failed writes do
not report successful saves. Removing the plugin deletes its private data;
turning it off postpones jobs until it is enabled again.

Automated tests cover persistence, cancellation, bounds, explicit recall,
failed writes, native permission enforcement and restart delivery. The steps
above are the manual voice check; desktop Windows/Linux execution still needs
those native targets.
