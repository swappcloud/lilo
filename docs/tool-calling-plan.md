# LILO tool calling protocol — implementation plan

Status: proposed. This document plans future work; it does not establish provider support or implement the protocol.

## Goal

Allow the active voice model to select and call tools from installed LILO plugins when a user asks a natural question or requests an action. LILO executes the selected tool, returns the relevant result to the same model, and lets that model continue speaking. The user should not have to memorize command phrases.

The architecture must work with arbitrary compatible plugins. Language study is an acceptance example, alongside notes, weather, media, and a previously unknown plugin installed after the host was built.

Plugin data stays local until a relevant tool is called. The initial model briefing contains tool discovery information and protocol instructions, rather than every plugin's memory. Tools may read data or update it according to host permissions and confirmation policy.

## Product constraints

- Use the user's existing provider web account and existing voice service. Provider availability, subscriptions, and quotas continue to apply.
- No API keys, paid API dependencies, local LLMs, or local speech synthesis.
- Windows, macOS, and Linux are equally supported desktop targets. Headless Linux shares the execution contract; standalone daemon voice remains limited to its implemented adapters, currently ChatGPT.
- Keep plugin ownership, storage, permissions, and business logic in the plugin system. The protocol must contain no study-specific or provider-specific routing rules.
- Keep shared Rust logic in `lilo-core`, without a Tauri dependency. Desktop and daemon bridges translate host events into the same execution contract.

## Current implementation and gaps

The repository already has several building blocks:

- `crates/lilo-core/src/plugins/provider.rs` and `registry.rs`: tool descriptors, plugin ownership, discovery, and invocation.
- `crates/lilo-core/src/commands/`: user-caption matching, command policies, confirmation, and host effects.
- `app/src/providers/contract.ts` and `types.ts`: provider capabilities and the common voice interface.
- `crates/lilo-core/src/plugins/voice.rs` and `app/src/providers/plugins/transport.ts`: the external provider contract, including a capability-gated `tool_call` / `toolResult` path.
- Desktop command execution and result events in `src-tauri/src/lib.rs`; command feedback in `app/src/store/sessionStore.ts`.

The real ChatGPT, Claude, Grok, and Qwen adapters currently declare `nativeToolCalls: false`. The mock provider supports native calls for local testing. These declarations describe the current adapters, not every interface their vendors may offer.

The existing phrase matcher does not perform semantic tool selection. Adding more templates cannot provide the requested model-driven behavior. The current `followUp` handling and hidden command notes also lack a complete, correlated model tool-call lifecycle.

Claude currently declares no live outbound text channel. A provider's ability to accept an opening prompt or deliver assistant captions does not establish that it can participate in a live tool-result loop.

`docs/command-protocol.md` currently prohibits executable text markers in spoken output. Any proposed compatibility transport must address that decision explicitly before it is enabled; this plan does not silently replace it.

## Intended user experience

For a request such as “I want to continue with my English study planning”:

1. The model uses the plugin capability catalog to find the appropriate study tool and its input schema.
2. It requests the owned tool for resuming the existing English course, using the language as a structured argument.
3. LILO validates the call, applies the existing permissions and confirmation policy, and invokes the plugin.
4. The plugin returns the current plan, relevant progress, and the next activity from its own storage.
5. LILO delivers that selected result to the same active model and resumes its response.
6. The model explains the next step by voice using the returned facts.
7. Later changes are saved through explicit tool calls when supported by the plugin. LILO acknowledges a successful save only after execution succeeds.

A request to inspect a plan must remain distinct from a request to start or resume an activity. Missing memory, an ambiguous language, or an unavailable plugin must lead to a truthful answer or a clarification question.

The same sequence applies to reading a note, changing a saved routine, checking weather, or invoking another installed plugin. No host change should be necessary to recognize a new plugin's business domain.

## Feasibility gate: obtaining model decisions

A LILO-owned protocol standardizes requests and results inside the app. It cannot force an upstream voice service to expose a reliable control channel or guarantee that every model follows a prompt convention.

Evaluate two adapter modes:

| Mode | Required evidence | Release condition |
|---|---|---|
| Native | The adapter can publish tool schemas, receive structured model calls, return correlated results, and resume speech. | Enable only after the complete loop works through the user's existing web account. |
| Compatibility | The model can produce a bounded structured decision in an explicitly requested control turn, and the adapter can isolate that output from audible speech, inject a result, and resume the response. | Experimental until adherence, audio suppression, cancellation, and result delivery are validated. |
| Unavailable | One or more required operations cannot be implemented or validated. | Keep existing explicit user commands available and declare model-driven tool calling unavailable for this adapter. |

For compatibility mode, prefer a dedicated text/control response when the provider exposes one. If only a combined text/audio response exists, prove that the adapter can hold or suppress its audio before any control content is played. Track the latency and resource cost of doing so. Immediate playback followed by detecting a command in late captions is insufficient.

Assistant speech, ordinary captions, recalled conversation text, and plugin results must never become executable commands merely because they contain JSON or a marker. Compatibility parsing is allowed only for an active host-requested control turn with a known response boundary. A correlation token identifies that turn; it is not execution authorization.

If an adapter cannot provide this isolation, the experiment stops for that adapter. Do not promise universal model-driven calling or introduce an additional paid model to bypass the limitation.

## Proposed architecture

### Shared protocol and coordinator

Add a small `tool_calling` module in `lilo-core`, with separate files for protocol types, policy, and the call coordinator as the implementation grows. It owns:

- Protocol versioning and validation.
- Registry-backed tool discovery and stable tool handles.
- Call authorization, argument validation, and confirmation policy.
- Session/request correlation, deduplication, cancellation, timeouts, and result limits.
- A bounded loop of model decisions, tool results, and final response completion.

Keep vendor parsing and media behavior in provider adapters. Put desktop and daemon integration beside their current command bridges. `sessionStore.ts` should delegate lifecycle work to a focused module rather than becoming the tool coordinator.

### Tool catalog and discovery

Build the catalog exclusively from enabled, compatible, registered plugin tools. Include public tool names or host handles, plugin identity, descriptions, input schemas, and execution policy. Never include saved data, credentials, private file paths, or vendor account identifiers.

Use a bounded two-stage catalog:

1. A compact index describes installed plugin abilities and tool purposes.
2. A host-owned discovery operation returns detailed schemas for selected tools. The model then calls the chosen tool with structured arguments.

For a small catalog, the full schema set may fit the same budget. The implementation must define deterministic size limits and avoid silently hiding tools when the catalog grows. Tool lookup is for schema discovery; it must not query plugin memory.

A new plugin contributes descriptions and schemas through the existing registry. Natural-language selection belongs to the active model. Phrase templates remain useful for explicit commands, but they do not determine which tools the model is allowed to call.

### Request and result contract

Define a versioned envelope independent of vendor event names. An illustrative normalized request is:

```json
{
  "version": 1,
  "type": "tool_call",
  "requestId": "request-1",
  "callId": "call-1",
  "tool": "study_start",
  "arguments": { "language": "English" }
}
```

The host binds that envelope to the active session generation, provider instance, model response, registry revision, and resolved plugin owner. A model cannot select another session or assign its own authorization scope.

A normalized result is:

```json
{
  "version": 1,
  "type": "tool_result",
  "requestId": "request-1",
  "callId": "call-1",
  "status": "ok",
  "output": {
    "summary": "Existing course resumed.",
    "data": {
      "targetLanguage": "English",
      "nextActivity": "Practice changing a train reservation."
    }
  }
}
```

Define `ok`, `error`, `requires_confirmation`, and `cancelled` outcomes, plus typed errors for unsupported transport, unknown tool, invalid arguments, unavailable plugin, timeout, and uncertain execution. Transport acceptance, tool completion, response generation, and audible completion are distinct events.

Protocol control types should also cover cancellation and turn completion. Exact wire framing for compatibility mode is a Phase 0 deliverable; the JSON examples above describe the internal contract, not a verified vendor transport.

### Plugin result handling

Return only the selected tool's useful output, with its source and freshness when available. Support structured results even when the plugin does not return a `context` string. Normalize legacy `summary` / `context` results through one bounded adapter.

Separate model-readable data from host lifecycle fields such as media playback, screenshot delivery, interaction creation, or session termination. Reuse their existing host handlers rather than serializing private assets into model text or executing effects twice.

Treat returned data as untrusted facts. Instructions embedded in notes or remote content must not authorize additional tool use. An oversized result should produce a bounded summary, pagination, or a typed limit error; never truncate JSON into an invalid payload.

### Execution and confirmation policy

Resolve tool ownership from the live registry on every invocation. Validate arguments against the supported schema subset before calling a plugin, and reject unsupported schemas explicitly.

Add tool-level policy metadata where it is missing: read-only, mutating, external effects, and confirmation requirements. Existing `requiresConfirm` command policies must not be bypassed by calling the same tool through the new model path. Tools with incomplete policy metadata receive a conservative default until reviewed.

Reuse current confirmation behavior, including a usable voice-only flow. The model cannot approve its own request. Cancellation, refusal, or expiry must prevent execution of a waiting action.

Deduplicate on host session, request, and call identity. Repeated delivery of an identical call returns the cached outcome; reuse of an identity with different arguments is rejected. If a write may have executed before a timeout or restart, report an uncertain outcome and avoid automatic retries. This is not a promise of exactly-once execution across process failure.

### Provider adapter contract

Define operations for publishing the catalog, receiving a normalized model decision, delivering a correlated result, resuming the response, and cancelling the current tool turn. Specify which acknowledgments each adapter can actually observe.

Expose capability data for native, experimental compatibility, or unavailable mode, including control-output isolation, live result delivery, and speech resumption. Core and UI branch on these capabilities, never on provider IDs.

Extend the external provider plugin contract with the same operations, events, version negotiation, and bounds. Provider plugins must not gain broader tool execution privileges than built-in adapters. Keep the existing native `tool_call` / `toolResult` integration as a migration input rather than creating a competing invocation path.

### Turn lifecycle and audio

Use an explicit lifecycle:

```text
listening -> model_deciding -> validating -> awaiting_confirmation?
          -> executing -> returning_result -> model_deciding | speaking
          -> completed | cancelled | failed
```

Start with sequential tool calls and a small configurable maximum number of calls per user request. Do not run a batch of model-selected writes concurrently. Tools can request subsequent reads when the model needs more information, within the same bounds.

Cancel or detach pending work when the user interrupts, the call ends, the provider changes, or the plugin is disabled. Recheck correlation after every asynchronous boundary so a late result cannot reach another provider. A write that has already started may complete; cancellation must not imply that its side effect was rolled back.

Suppress control output from audio, captions, transcript history, conversation recaps, titles, and learning-evidence events. Ordinary answers should still play promptly. Measure any added audio holding time and memory use before choosing defaults.

## Implementation phases

| Phase | Work and deliverable | Completion gate |
|---|---|---|
| 0. Transport feasibility | Inspect current adapter contracts; run a controlled experiment in the desktop app for model selection, isolated control output, result injection, and resumed speech. Record an evidence matrix for every provider. | At least one real adapter completes the loop without speaking protocol content. Mark each remaining adapter as proven, blocked, or untested. |
| 1. Core protocol | Add versioned envelopes, the catalog, schema validation, policy metadata, correlation, deduplication, limits, and the coordinator in `lilo-core`. | Deterministic tests cover valid reads/writes, invalid calls, confirmation, retries, cancellation, and bounded execution. |
| 2. Vertical slice | Integrate one feasible adapter through the common provider contract. Exercise both study and an unrelated plugin. | A natural request causes model selection, plugin execution, result delivery, and a grounded spoken answer. No domain-specific host routing is added. |
| 3. Provider extensions | Implement remaining proven adapter transports and the external provider plugin contract. Include Qwen as the provider-plugin acceptance case. | Enable capabilities separately for each validated adapter; unavailable transports remain explicitly unavailable. |
| 4. Lifecycle integration | Coordinate model calls with explicit commands, plugin interactions, media effects, provider switching, and existing storage flows. Integrate the shared contract with the daemon's supported voice path. | No duplicate execution, stale delivery, accidental lesson activation, or fabricated save acknowledgment. |
| 5. Validation and rollout | Complete automated checks, real in-app validation on all three desktop platforms, resource measurements, documentation, and migration. | Release only the adapter/platform combinations supported by recorded evidence. |

## Acceptance criteria

- Natural questions and requests work without requiring a fixed voice-command template when model-driven calling is enabled.
- The model can discover and use an unrelated newly installed plugin without host code changes.
- The initial briefing contains capability metadata, while private plugin memory is fetched only through relevant calls.
- Results are delivered to the same active request and provider before it resumes the answer.
- Reads do not activate an activity or modify memory. Explicit updates use the correct plugin, preserve existing data, and respect confirmation policy.
- Control frames are never audible and do not enter user history, captions, recaps, or plugin learning evidence.
- Native and compatibility transports share execution policy and result semantics.
- Malformed output, unknown tools, missing memory, plugin removal, provider switching, and timeouts produce bounded, truthful outcomes.
- Existing explicit commands and tools continue to work when model-driven calling is unavailable.
- No new paid dependency, API key requirement, local LLM, or local TTS is introduced.

## Verification plan

Use deterministic tests for protocol framing across streamed chunks, malformed or quoted control text, schema limits, ownership, confirmation, duplicate events, uncertain writes, loops, and cancellation. Include adversarial plugin results that contain instruction-like text.

Add adapter fixtures for control-output isolation, result-before-resume ordering, late captions/audio, generation changes, and interrupted responses. Validate a read and an update across two unrelated plugins; test the core independently from Tauri and from a specific provider.

Run the repository checks during implementation: `npm run typecheck`, `npm test`, `npm run build`, and `cargo test --workspace`. Rebuild the marketplace after plugin changes using `scripts/build-marketplace.sh`, or `node scripts/build-marketplace.mjs` on Windows. Record dependency or environment blockers rather than counting blocked checks as passes.

Perform live checks in the desktop app via `npm run dev`, never through a browser test harness. Cover Windows/WebView2, macOS/WKWebView, and Linux/WebKitGTK for each enabled desktop adapter. Validate the supported headless ChatGPT path separately. Real sessions must verify audible suppression, resumed speech, interruption, mute, session changes, language variation, quota exhaustion, and plugin disable/removal.

Diagnostic events should contain call IDs, resolved tool identity, status, timings, and byte counts. Do not record user speech, plugin memory, raw arguments/results, credentials, or personal account fields in new protocol diagnostics.

## Migration and documentation

- Inventory the existing `followUp` flag, hidden command notes, automatic context reads, and native plugin tool events before replacing their overlapping behavior.
- Keep explicit user-command execution and model-selected calls on one authorization and tool-effect path, with deduplication between the two.
- Avoid synthetic internal instructions being recorded as new user utterances. Result delivery and response resumption need dedicated adapter operations.
- Preserve plugin storage and account identities. Model/provider changes must not create copies of plugin memory.
- Update `docs/command-protocol.md`, `docs/plugins.md`, `docs/plugin-authoring.md`, and `docs/provider-plugins.md` when the contract is implemented. Record any change to the current executable-marker decision with its evidence and scope.
- Align language-study documentation with lazy reads and preserve explicit study activation boundaries.
- Update `docs/atlas.md` as implementation modules are added, moved, or split.

## Effort and difficulty

The registry and plugin execution work are already present, so the protocol types and dispatch path are moderate work. Reliable model adherence, isolated audio output, and returning results through undocumented provider web voice transports are the highest-risk work.

Allow roughly 1–2 engineering days for the initial feasibility experiment. After a compatible transport is demonstrated, a limited single-adapter MVP is approximately 3–5 additional engineering days. Broader integration and hardening may take 1–3 additional weeks, with Windows, macOS, Linux, and live-account validation affecting elapsed time.

These are planning ranges, not a commitment that every current provider can support the feature. Re-estimate after Phase 0 using the recorded transport evidence. A provider that cannot isolate model decisions or accept live results may require separate adapter research or remain unavailable.

## Decisions required before implementation

1. Which transport can produce the first verified control turn, and how is its audio kept silent?
2. What exact framing and acknowledgment rules does compatibility mode use?
3. Which schema subset, catalog budgets, call limits, deadlines, and result sizes fit desktop and headless resource budgets?
4. How are tool-level read/write and confirmation policies migrated from current command declarations?
5. How are late results, started writes, and competition between explicit commands and model-selected calls represented?
6. Which adapter/platform combinations have enough evidence to enable the capability?

Resolve these through the feasibility work and shared contract design before presenting the feature as reliable across providers.
