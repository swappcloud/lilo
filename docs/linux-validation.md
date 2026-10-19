# Linux runtime validation evidence

This engineering record describes the environments behind the published measurements. Product installation instructions are in [Headless Linux](headless-linux.md).

## Resource and login boundaries

A sample from an active voice session used approximately
4.4 MiB for the Rust daemon and 281 MiB for the browser host including Chromium.
These are one observed active-session sample, not peak
budgets or hardware benchmarks. The browser starts only for sign-in or an active
voice session and closes when that operation ends. Pinned yt-dlp and Deno are
provisioned on the first media request where platform artifacts exist. Linux
mpv must be available as a system package or configured path; the player starts
on demand.
Detailed transport counters are off by default; enable `LILO_VOICE_DIAGNOSTICS=1`
on the optional broker only while diagnosing a session.

Phone login uses the same form driver as desktop Connect with phone, in Linux
Chromium. The phone presents LILO's own email, password, phone and code
fields. Email and codes remain visible; passwords are masked. Normal provider
pages are not mirrored. A submitted answer remains in Working until the provider
reports its next question or an error; stalled submissions report a retry.
Explicit interactive provider verification is the only case that supplies a
challenge image. Generic remote typing and full-page mirror controls are absent.
Xvfb supplies an isolated rendering display; no window appears
on the desktop. The browser and display start only during login or voice, then
stop when the operation ends or fails. The private broker remains
available for subsequent login requests and audio checks.

The default Chromium/Xvfb/CDP host handles both login and voice with the same
engine implementation. `LILO_BROWSER_ENGINE=webkitgtk` selects an optional
legacy login fallback; that fallback does not provide voice. Windows desktop
uses WebView2 and macOS uses native WebKit, so success there does not establish
provider acceptance on Linux. The user confirmed ChatGPT sign-in, microphone
capture and audio playback using the Linux container runtime with a WSLg
PulseAudio endpoint; this is not a
physical Linux board run. Provider verification can still require an interactive
challenge, and the result does not establish acceptance for another account or
device.

The `check` command reports runtime health, not a resource benchmark. Small-board
support requires measurements on the actual board. Account registration, voice
sessions and explicit device audio checks are separate actions.

## Reproducible local resource measurements

With the optional Docker runtime started, run:

```sh
node scripts/daemon-resources.mjs 5
```

The read-only script samples only the two LILO containers and emits CPU, memory working-set and task counts. It does not inspect accounts, conversations, process arguments or credentials. Run it separately at rest, during an explicit voice session, and after stopping voice. Docker memory accounting is not summed process RSS; shared memory and cache make those figures different. Container limits are ceilings, not requirements.

## Recorded container memory

MiB means mebibytes (approximately megabytes), not gigabytes. For example,
6.2 MiB is about 6.5 MB. Each row measures the named container, not the whole
computer. Docker working-set accounting differs from process RSS and excludes
the host OS and other services.

| Observation | Rust daemon | Browser-host container | Scope |
| --- | --- | --- | --- |
| Initial idle | About 6.2 MiB | About 17–19 MiB | Chromium not started; about 23–25 MiB combined |
| Earlier idle implementation | About 6.2 MiB | About 88 MiB | Chromium not started; automation module already loaded |
| One active voice sample | About 4.4 MiB | About 281 MiB | Browser host includes active Chromium; about 285 MiB combined |

Five samples support each idle observation. Loading the automation module only
when the browser starts reduced initial idle memory. The module remains cached
after its first use, so the initial figure is not a measurement of idle memory
after a voice session. The active row is one sample, not a peak measurement.

These samples predate local wake integration and do not measure
current idle memory with the wake listener enabled.

These measurements do not establish minimum device RAM. Measure the host OS,
installation, sign-in, simultaneous voice/media and idle after voice separately
on representative x86-64 and ARM64 hardware. Physical-board audio and Wi-Fi
validation remain outstanding.

## Updated WSL2 runtime samples

The local debug runtime exposed the panel over HTTP by WSL IPv4 address.
It used the distribution wake model, WSLg PulseAudio capture and the optional
ChatGPT browser host. Docker reported these individual working-set samples:

| State | Daemon container | Browser container | Combined containers |
| --- | ---: | ---: | ---: |
| Wake listening, voice idle | 10.18 MiB | 18.22 MiB | 28.40 MiB |
| Connected voice, sample A | 8.08 MiB | 892.70 MiB | 900.78 MiB |
| Connected voice, sample B | 11.50 MiB | 278.90 MiB | 290.40 MiB |

These are snapshots, not measured peaks or RAM requirements. They exclude
Windows, WSL, Docker and audio-service memory. The idle sample includes the
daemon's capture child; active voice releases that child. Browser memory
changes substantially while it starts and connects.

HTTP checks confirmed authenticated management and AES-GCM browser exchange,
rejected unpaired and foreign-origin requests, and exercised wake off/on.
The recognizer reached `listening` with a live capture stream. Recognition of
the owner's spoken `lilo` phrase remains a device acceptance step.

## Local wake acceptance on WSL2

A native x86-64 test used the distribution PocketSphinx model and the
[upstream recorded PCM fixture](https://github.com/cmusphinx/pocketsphinx/blob/v5.0.4/test/data/goforward.raw).
It detected `go forward` once, rejected the same recording with `lilo`
configured, and rejected silence. One run decoded the 2.79-second recording
in about 0.088 seconds. The test process reported about 17.4 MiB RSS, including
the Rust test harness and native recognizer. This excludes daemon, browser and
OS memory; it establishes neither a hardware minimum nor a voice-session peak.

Spoken LILO activation, microphone permissions, music/noise rejection and
provider microphone handover remain device acceptance checks.
