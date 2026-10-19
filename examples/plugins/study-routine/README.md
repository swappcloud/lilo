# Study routine interview

Real scenario: a learner asks LILO to plan a daily study budget. This JavaScript
plugin asks for a number, repeats it in a confirmation question, and saves only
a confirmed answer. The routine belongs to the learner/plugin and survives a
provider change; a pending interview belongs to one local voice call and ends
when that call ends. There is no provider-specific course or Rust workflow.

## Try it in LILO

1. Install **Study routine interview** from Settings → Plugins. For local
   development, rebuild with `node scripts/build-marketplace.mjs` and use the
   checkout's `examples/plugins` directory as the marketplace URL.
2. Start a voice call on a provider declaring inbound user text and outbound
   live text, then say “Plan my daily study time.”
3. Answer “15 minutes”. No routine should be saved yet.
4. Answer “yes” to the separate confirmation. Read the saved routine.
5. Restart LILO or switch providers; “Read my study routine” should still show
   the same budget. A different vendor conversation id must not create a new
   routine.
6. Start another interview. Try unrelated speech, a rejected answer, “cancel”,
   ending the call, and waiting for the deadline. None may overwrite the routine.
7. Check a provider without the required channels: the interview reports
   unsupported, while the previous routine stays readable.

Localized commands and answers are declared in the plugin's English, Portuguese
and Italian templates. This guide uses English examples. The plugin accepts numeric
transcripts, not arbitrary spelled-out numbers or a full semantic interview.
The generic choice/text answer contracts can provide other authored workflows.

The host emits correlated delivery-attempt ids. `submitted` only means the
adapter accepted the local call to submit text; it does not prove spoken
delivery. Final fresh user captions are required; assistant/system/injected
captions and old revisions cannot provide confirmation. A timeout retries once,
then stops. Only one question can be pending across plugins at a time.

The example uses `lilo.interaction`, `lilo.session`, atomic memory, owned tools,
voice commands, a context tool and declarative actions. Its UI never embeds
HTML/React. The daemon supports standalone ChatGPT voice and delivers plugin-owned
interaction questions through the active session. Run voice checks in the app; tests
cover native correlation/privacy, permission checks, deadlines and save behavior.
