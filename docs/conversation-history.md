# Conversation history and continuation

LILO owns a local conversation containing spoken user/assistant turns, titles,
provider-specific chat links and voice-session ids. Stopping a call, waking LILO
again, or changing provider keeps that local conversation selected. The New
conversation action explicitly starts fresh and clears every provider link and
inherited context, including a greeting-only conversation.

## Provider threads

A voice call and a durable chat are separate concepts. ChatGPT reports its chat
id through startup/conversation events; Claude and Grok return their conversation
id when starting their transport. The local record keeps these links under the
provider that issued them. A ChatGPT id is never passed to Claude or Grok.

Reconnecting ChatGPT first attempts to refresh the selected remote branch.
Messages written through the website are merged by message id and timestamp,
while local turns from other providers remain. The snapshot follows only the
ancestors of the remote current node, with at most 200 spoken messages, 16,000
characters per message, 96,000 characters of text and a 128,000-character JSON
payload. Earlier locally saved turns remain. Attachments and audio bytes are
not imported. The user account stays inside the signed-in ChatGPT host; tokens
are never returned to the main window or written into source/build assets.

This refresh concerns a linked chat, not the entire ChatGPT account's chat list.
Local rename/delete operations remain local. Website deletions and branching
are not destructive operations against locally saved conversations. The Claude
and Grok adapters resume their native chat but do not yet import website edits.
Legacy records containing only a ChatGPT voice-call id acquire a durable chat
link from the next successful session; old website chats are not guessed or
merged automatically. The private web protocol still requires live validation.

## Switching provider

Switching provider stops the old transport and selects the most recent local
conversation owned by the selected provider, or creates a clean conversation.
A call reconnects there unless a newer user action cancels the switch. Returning
to a provider preserves its own chat links and history. No transcript from
another provider is sent as context. Legacy histories containing links to
multiple providers remain readable, but are not reused for new sessions.

A resumed session receives only that provider's quoted spoken history after
its last acknowledged turn. System lines and injected application prompts are
excluded. The prompt explicitly treats earlier requests as already handled;
only new live requests can trigger commands. Context is bounded to about
32,000 characters, with a disclosed omission if needed. The full local
transcript remains independent of that prompt budget.

## A full conversation

Only explicit ChatGPT `context_length_exceeded` or
`conversation_limit_exceeded` events request an automatic remote continuation.
Quota, rate limits, authentication and network failures do not split history.
The local transcript also opens a successor at its 2,000-turn capacity, instead
of silently dropping earlier turns at the former 300-turn limit. The previous
conversation remains in history; the successor records `continuationOf` and
bounded inherited context, clears provider links and reconnects if the call
was live. A concurrent user selection or provider change cancels the rollover.
If a successor is rejected before any new user speech, LILO stops and shows
an error instead of repeatedly creating empty remote chats. The existing
persisted-history limit remains 40 conversations.

The Conversations panel shows the provider names whose chats are linked.
Automatic capacity handling on other providers depends on their adapters
reporting the generic capacity callback; unknown error messages are not guessed
from prose.

## Validation

Tests cover authoritative ChatGPT thread events, explicit limit classification,
request payload ids, bounded history parsing, merging remote updates without
losing another provider's messages, cross-provider isolation, provider ownership
and automatic continuation. In the app, verify a stop/wake cycle against the
ChatGPT website, write a message on the website then reconnect, switch provider
and back, and explicitly start a fresh conversation. These live-account checks
cannot be replaced by mocked protocol tests.
