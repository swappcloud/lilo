# Travel phrasebook

Real scenario: a Portuguese-speaking beginner is travelling in Italy and needs
three useful Italian phrases, with explanations in Portuguese. This offline
JavaScript example reads `lilo.session()` and subscribes to `session.changed`.
It branches on declared capabilities, never provider ids. It includes a
declarative list and action; no host component or native feature code is needed.

## Try it in LILO

For local development, rebuild with `node scripts/build-marketplace.mjs` and set
the marketplace URL to your checkout's `examples/plugins` directory. Packaged
installations use the default marketplace.

1. Open Settings → Plugins and refresh the default marketplace.
2. Install **Travel phrasebook**.
3. Select English as the support language and say “read my travel phrases”.
4. Change the language to Portuguese or Italian; refresh the phrasebook list.
   Both the opening context and results should use the new explanation language.
5. Compare a provider with and without live outbound text. The result's context
   reports the declared channel; absence means the panel and next opening
   briefing remain usable, without promising mid-call delivery.

The support-language preference is an explanation default, not a detected CEFR
level or a claim about which language the user currently speaks. Other support
languages fall back to English for this small curated example. A full language
pack can translate the panel separately.

`session:read` is required. The snapshot contains no account details, vendor
conversation ids, credentials or provider options. It is read-only and returns
a fresh object. With no live voice session, the provider may be null and the
state idle. During standalone daemon ChatGPT voice, the snapshot reports that
session's declared capabilities. OS platform is supplied by the core.

Run the manual checks above in the app, not a browser. Automated tests cover
explanation-language changes, capability adaptation and event source checks;
native tests cover permission denial, snapshot validation and late subscribers.
