# Language study

## Learning journey and daily progress

The plugin page shows next-level task coverage, six skill bars, a 28-day
practice chart, an evidence trend, words taking root and pronunciation wins.
The same information is available by voice: **“show my language progress”**
and **“what should I practice today”**. Calculations and memory run locally
in QuickJS on Windows, macOS and headless Linux. Study context is shared
with the selected voice provider as described below.

The oral-task curriculum is LILO's adaptation of the
[CEFR Companion Volume](https://rm.coe.int/cefr-companion-volume-with-new-descriptors-2020/16809ea0d4),
with two tasks per skill per level, A1 through C2. It covers listening,
natural conversation, fluency, vocabulary, grammar and pronunciation. It is
a small practice curriculum, not an official CEFR test or a calibrated
proficiency estimator. Reading and writing are outside this oral profile.
Pronunciation focuses on intelligibility, articulation, stress and rhythm,
following the Council of Europe's
[phonological competence guidance](https://www.coe.int/en/web/common-european-framework-reference-languages/phonological-competence),
rather than eliminating the learner's accent.

A chosen starting point is **self-reported**. For example, A2 sets the
practice target to B1. A provisional demonstrated level requires both tasks
in all six skills completed independently on two separate local calendar
days within the last 45 days. Scores: 0 not yet, 1 with help, 2 independently,
3 independently with flexibility. One independent day contributes half of
a task's evidence; two contribute the full task. The latest two daily
observations determine coverage; a failed retest lowers it. The percentage
averages all twelve target tasks equally. Unknown skills remain visibly
unassessed; missing evidence contributes nothing to overall **task coverage**.

Thus **“A2 → B1: 30%”** means roughly 30% of this curriculum's required
evidence has been collected, not scientifically 30% of the distance between
official CEFR levels. Coverage can fall when evidence becomes stale or a
retest reveals a gap. Completing a level advances the target, starting its
next-level chart afresh. C2 is the final curriculum level and continues
receiving retention checks.

## Tutor checkpoints and measurement limits

Web voice providers do not expose reliable structured tool calls. The tracker
captures explicitly formatted tutor observations from assistant captions in
opted-in study, linked to a recent learner turn. Study guidance supplies the
task catalogue, rubric and these formats:

```text
Study checkpoint: conversation B1 1 2; evidence: handled a ticket change independently; audio: none.
Study word: biglietto; meaning: ticket; recall: 4; pronunciation: 2; audio: heard.
```

The task numbers identify skill level, task and score. Word recall uses 0–5;
word pronunciation uses 0–3 or `unknown`. Listening, fluency and pronunciation
require the tutor's explicit `audio: heard` claim. LILO receives captions,
not an independent acoustic assessment, so it cannot verify that claim or
establish teaching accuracy. These results are provisional observations.
Providers that alter or omit the format leave the tracker unassessed.
Conversation length, transcription accuracy and attendance never create a
proficiency score. Caption revisions replace or retract their observations;
user-spoken and forged plugin markers are ignored.

Checkpoint sentences are a transport workaround and may sound technical.
Real provider compliance and pronunciation accuracy still require in-app
evaluation. The tracker cannot promise reliable automatic grading when a
provider cannot deliver these observations.

## Words, retention and small daily wins

Words are tracked after a reported retrieval attempt. The list shows meaning,
review days, next due date and audio-based pronunciation changes. A word is
labelled as recalled across days after three consecutive successful daily
checks: retention evidence, not permanent mastery. Pronunciation improvement
requires a later-day heard-audio score above the first recorded score. Newly
encountered words stay separate from repeated successful recall. Expressions
can be forgotten with confirmation, including observations and recovery copies.

Reviews use a bounded adaptation of
[SuperMemo SM-2](https://www.super-memory.com/english/ol/sm2.htm): successful
reviews start at one and six days, then scale by item ease; failed recall
resets the interval to one day. Ease stays at least 1.3; intervals are capped
at 365 days. Only the latest observation per local day counts. This applies
[retrieval practice](https://www.learningscientists.org/retrieval-practice)
and spacing: recall before receiving a hint, then use the word in a fresh
context. It is not FSRS or a trained forgetting-probability model.

At study resumption the tutor receives up to three due words and three older
demonstrated tasks needing a retention check after fourteen days. Guidance
asks for short checks every few minutes, specific praise and a session recap.
Reminders take place inside explicitly started study, with no background
notifications or unsolicited recording. The chart counts recorded learner
turns and checkpoints, not speaking minutes. Daily totals survive transcript
compaction and revisions. The streak covers the last 28 days and allows the
learner to continue today's practice before the day ends.

Each language retains at most 480 task observations and 600 word attempts;
older evidence can leave the retention window. The shared memory budget may also compact optional tracker history across languages before those per-language caps are reached. Existing notes, goals, sessions
and learner-reported schedules are preserved; those self-reports stay separate
from progress observations. Delete the language memory to remove the profile.
No paid service or new model is required.

## Course ownership and changing voice providers

The course belongs to the local user and the study plugin, not to a voice
provider, account or vendor conversation. Storage is scoped to the plugin;
profiles are scoped by target language. Goals, routine, plan, expressions,
review dates and continuation checkpoints are reused when changing providers.
Do not create a new course or copy memory into a provider-specific directory.

Before every connection, LILO reads the plugin's fresh `contextTool` result
and supplies the same bounded learning context to the selected adapter. A live
text adapter receives hidden opening context after connection; an adapter
without live text receives it upfront if it declares prompt support. Vendor
conversation ids remain vendor-specific; they are not course identifiers.

Voice/transcription/delivery capabilities can differ. A missing live text
channel changes when updates reach the tutor, not which memory is authoritative.
A provider with no suitable context channel cannot be promised automatic
continuation; its limitations must be explicit, while the local course stays
available for the next compatible provider. Tutor observations remain sourced
evidence and suggestions, not verified proficiency facts.

Regression tests cover one native-memory course resumed through different
session identities/capabilities, with goals, routine, review dates and last
checkpoint preserved. Prompt tests check both live-text and upfront-context
delivery paths and require fresh memory on the next connection.

Language study is an optional QuickJS plugin, `com.lilo.study`. Install it in
Settings → Plugins; it contributes its own grouped settings page and voice
commands on Windows, macOS, Linux and headless hosts. No API key, local LLM,
local TTS or additional service is required.

## Start through conversation

Say **“Lilo, let's study Italian”** or **“I want to improve my English”**
to start or resume the selected language's study. Existing goals and evidence are preserved. The tutor discovers the real-life objective,
starting abilities, interests, available time and correction preference one
question at a time. No form is required. A bare language answer such as
“italiano” can complete an initially unnamed profile.

The tutor's instructions ask for a goal over months, a weekly focus and today's
next step. The learner and tutor agree on this through ordinary conversation;
the initial dialogue and subsequent sessions are recorded as evidence, rather
than automatically converted into certified levels or verified facts.

The next day, say **“let’s study”** or **“resume my study”**. The provider
receives the selected language's saved evidence when the voice connection
starts. A backend with a live text channel also receives fresh memory when a
study command runs mid-call. The tutor asks how much time is available and
uses the prior practice and spoken recap to choose a continuation.

For a learning or improvement request, the language of the request becomes the
support language for explanations. The target language is used for practice.
A beginner asking in Portuguese to learn English therefore receives Portuguese
scaffolding; an existing speaker asking to improve English receives exercises
that expose their current gaps. The learner can choose another support language.

The tutor is instructed to discover goals and time naturally, then adapt a short
diagnostic using comprehension, an introduction and a relevant role-play. It
proposes a provisional level, a goal spanning months, a weekly focus and a next
session. It should resume saved work rather than repeat onboarding daily.
The diagnosis is conversational evidence, not a certified language test.

## Memory and learner control

The plugin records user and assistant captions only after study was explicitly
started. Ending a call or saying **“pausa meu estudo”** stops recording. Normal
conversation before study, system messages and injected context are excluded.
Captions without a final flag are supported; revisions replace their original
turn. Speech is checkpointed every ten seconds; explicit edits, pause, call
end and plugin shutdown flush immediately. An interrupted app retains evidence
already written to disk, with a previous valid snapshot for incomplete-write
recovery. Recovery is reported when study resumes.

Each language has its own initial conversation, learner notes, expression
reviews and recent sessions. User speech is self-reported evidence. Assistant
speech is a tutor suggestion. Neither captions nor repetition counts establish
pronunciation quality, mastery or a CEFR level.

Examples of voice controls:

| Purpose | English example |
| --- | --- |
| Pin a goal or routine | “remember for my study I have ten minutes a day” |
| Update current goal | “my study goal is work conversations” |
| Update current plan | “my study plan is work scenarios this week” |
| Update routine | “my study routine is ten minutes a day” |
| Update correction preference | “my study correction preference is after the exercise” |
| Read the memory | “what do you remember about my study” |
| Save an expression | “save study expression vorrei un biglietto” |
| Report recall | “I remembered my study expression vorrei un biglietto” |
| Request earlier review | “I need to review my study expression vorrei un biglietto” |
| Forget an expression | “forget study expression vorrei un biglietto” |
| Forget a pinned note | “forget my study note I have ten minutes a day” |
| Delete selected language | “delete my study memory” |

Deleting a language requires the existing voice-command confirmation flow.
The page also shows pinned notes, scheduled expressions, the initial dialogue
and recent sessions. It lets the learner forget a note or switch to another
language. No screen is needed for the voice controls.

Expressions become due immediately when added. Reports of recall schedule
them after 1, 3, 7, 14 and then 30 days. A request for another review resets
the interval to one day. This is a simple transparent scheduling rule, not an
assessment. At most five due expressions enter the opening context, so an
absence does not require clearing an unlimited backlog.

## Storage and context budget

On current hosts, `lilo.memory` stores the learning record as versioned UTF-8
JSON under `data/.lilo-state/memory/`, with a bounded recovery snapshot and
revision guards. Existing `learning.json` and `learning.backup.json` are
validated, imported after a native commit, then sanitized. Older hosts keep
the previous raw-file path; downgrading after migration does not expose the
new native record through that path.
Updates preserve it; deactivation preserves it; uninstall removes it.
Up to eight language profiles, fifty pinned notes and fifty expressions per
language are supported. Notes and expressions are never silently evicted;
when full, the learner must forget an entry first.

The journal keeps at most ninety sessions per language and twenty-four turns
per session, with at most 1,200 characters per turn. Initial evidence keeps
twenty-four turns. Long turns preserve their beginning and end so a final
continuation is not lost. Each serialized snapshot is bounded to 800,000 characters:
older sessions are compacted to their final two short turns, then removed if
necessary. Durable notes and initial evidence take priority. This is a bounded
learning memory, not an unlimited transcript archive.

Explicit goal, plan, routine and correction updates replace their previous
current value. They take priority in opening context, alongside the first
three and up to thirteen latest general notes,
initial evidence, due expressions and up to three recent sessions, within
10,000 characters. A long history therefore does not grow the provider prompt
without limit. Memory remains local, but the selected context is sent to the
user's current web voice provider to conduct the lesson, as conversation is.

Forgetting removes matching evidence from the study plugin, including spoken
checkpoints and the recovery copy. Existing app
conversation history and provider conversation history are separate stores.
Malformed or unsupported memory fails plugin loading instead of silently
overwriting the learner's history.

## Host contract

`contextTool` declares an owned read-only tool returning `{context: string}`.
The host calls it before connection, quotes its data and keeps it separate from
the plugin's static capability description. Context is bounded and failures
do not block a voice connection. A tool result may carry the same `context`
field for live follow-up; only a short `summary` enters command UI and logs.

`conversation:read` is required to receive host `conversation.turn` and
`conversation.ended` events. Wildcard subscriptions without that capability
cannot receive them. These events are not retained or mirrored to UI windows;
plugins cannot forge them. Delivery has a 500 ms budget per subscriber, with
subscribers running concurrently. The desktop coalesces revisions, drains outstanding
events before disconnect and awaits plugin delivery before completing the
publication. The daemon emits finished captions from its standalone ChatGPT
voice session through the same contract. It does not add local wake-word or
speech-recognition models, and this does not imply support for other standalone
providers. Desktop-backed satellite sessions use the desktop voice path.

Web voice providers do not provide a reliable structured tool-call channel.
Consequently, the tutor cannot silently write verified structured assessments.
Spoken planning recaps are captured automatically as evidence. At call end,
the latest learner and tutor turns are saved as a continuation checkpoint,
alongside the bounded session journal. No special command is required for this
continuity. Explicit voice commands remain available to pin or replace a
specific goal, plan, routine or correction preference and to report review recall.
On a provider without live text
feedback, memory edits reach the tutor on the next connection; the tutor must
not claim it verified a mid-call edit.

## App verification

Use `npm run dev` and test in the app:

1. For this checkout, set Settings → Plugins → Marketplace URL to the absolute
   `<checkout>/examples/plugins` folder, refresh and install Language study.
   This uses the local catalog before the change is published remotely.
2. Say “Lilo, let's study Italian” and answer the tutor's questions.
3. Pin a goal and save an expression by voice; inspect the plugin page.
4. End the call and restart the app. Say “let's study” and check continuity.
5. Give a different time budget, pause study and have an unrelated conversation.
6. Verify the unrelated conversation is absent from study memory.
7. Switch language, return, forget a note and confirm deletion of that language.
8. Check a provider without live text feedback separately: it restores memory
   at connection and does not claim to verify later commands.

Automated tests cover persistence, caption revisions, context bounds, scoped
event access, cross-language isolation, review scheduling and headless routing.
They do not establish the upstream model's teaching quality or voice accuracy.

## Saved notes and tutor answers

Say **“remember for my study I have ten minutes a day”** to save a note.
After an explanation, say **“save this answer in my study”** and LILO
keeps the exact latest tutor turn captured in the active study session. The
plugin never invents or paraphrases the answer. Tutor answers over 600
characters require an explicit shorter excerpt to fit one saved item.

The Language study plugin page shows saved notes and tutor answers with the
learning-memory list. Each item can be copied, edited and deleted; deletion
asks for confirmation. Portuguese, English and Italian interface labels are
provided. Items remain available after restart and switching providers because
they are stored with the course, not with a voice conversation. The automated
regression test exercises saving an answer, reopening the plugin, editing, and
deleting it. In-app clipboard behavior should also be checked on desktop and
headless users can still request saved items by voice.

The daily-budget interview is part of `com.lilo.study`: say “planeja meu
tempo diário de estudo de línguas” (or the English/Italian equivalent). LILO
asks in the support language, repeats the number for a separate confirmation,
and only then writes the routine into the selected language profile. Changing
the selected language while the question is pending does not move that answer
to another course. Without a supported live-text provider, LILO reports that
the interview is unavailable and keeps existing memory unchanged.


## Study session boundary

Study has two runtime phases: inactive and active. Installing the plugin,
opening its settings, loading a saved plan, checking progress or reconnecting
does not start a lesson. An explicit study request or Start action activates it.
Ending or pausing study returns an authoritative inactive context immediately;
previous lesson history cannot override that phase. Automatic provider context
omits lesson memory and review prompts while inactive. The explicit memory tool
can still read saved material without activating a session.

The host's existing End interaction inactivity setting owns the deadline. When
it ends the voice interaction, `conversation.ended` ends study as well, including
sessions with no captured turns. There is no separate study timer. Starting a
later interaction remains inactive until another explicit study request.
