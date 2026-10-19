# English vocabulary notebook

Real scenario: a learner hears an unfamiliar English word, asks LILO what it
means, then explicitly saves it to review later. Definitions come from
[Free Dictionary API](https://dictionaryapi.dev/), without an account or API
key. The notebook works offline after saving.

This package is JavaScript plus its manifest. It uses only public HTTP,
discovery, local storage, context, voice commands and declarative UI APIs.
There is no dictionary-specific Rust, Tauri command or React component.

## Try it in LILO

For local development, rebuild with `node scripts/build-marketplace.mjs` and set
the marketplace URL to your checkout's `examples/plugins` directory. Packaged
installations use the default marketplace.

1. Open Settings → Plugins and refresh the default marketplace.
2. Install **English vocabulary notebook**.
3. Say “What does the English word resilient mean?” A lookup alone saves nothing.
4. Say “Save the English word resilient.” Check the plugin's saved-word list.
5. End the conversation, restart LILO and disconnect the network. Say “Read my
   vocabulary notebook.” Saved definitions should remain available.
6. Say “Forget the English word resilient” and confirm. It should disappear
   from the notebook and opening context.

The plugin also declares Portuguese and Italian command templates. These
localized utterances live in the plugin; documentation examples use English.

Only individual English words are accepted. The service supplies English
definitions; LILO can explain them in the conversation's language. This does
not assess pronunciation or proficiency. Source/license metadata is kept and
displayed; definitions remain third-party data.

The notebook holds at most 50 words and 100,000 serialized characters. Invalid
existing data fails loading instead of being silently reset. Read operations
work on an older host; online lookup reports that a host exposing plugin HTTP
is needed. Failed HTTP responses and failed writes do not report a successful
save. New hosts use atomic memory with revision guards. Existing vocabulary.json is
validated and imported once, then its obsolete copy is sanitized. Forgetting
sanitizes the recovery snapshot too. Older hosts retain raw-file storage;
downgrading after migration does not expose the native record through it.
Persistent daily review is demonstrated separately by vocabulary-review.
