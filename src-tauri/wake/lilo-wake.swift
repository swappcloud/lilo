// LILO wake-word listener (macOS).
//
// A tiny helper app spawned by the Tauri backend. It listens continuously on
// the microphone using the on-device Speech framework and reports events.
//
// It is launched through LaunchServices (`open -n LiloWake.app`) rather than
// a direct `posix_spawn`: TCC attributes a direct child's permission request
// to the *responsible* process (the terminal/IDE that launched the dev app),
// whose Info.plist has no usage strings, so macOS aborts us. When launched via
// LaunchServices the helper is its own responsible process and its own
// Info.plist (`NSSpeechRecognitionUsageDescription`) applies.
//
// Because `open` detaches stdio, events travel over a Unix domain socket the
// backend passes as an argument. stdout is still used when no socket is given
// (handy for manual runs).
//
// Usage: lilo-wake "<phrase>" [socket-path] [parent-pid]
//
// Lines:
//   READY          listening started
//   WAKE           wake phrase detected
//   HEARD <text>   final transcription (debug)
//   NOREC          speech recognition unavailable
//   ERR <message>  fatal error
//   BLOCKED <reason>: <detail>   recognition cannot work until the user acts
//   UNBLOCKED      recognition recovered
//   DBG <message>  diagnostics (audio restarts, auth steps)

import AVFoundation
import Darwin
import Foundation
import Speech

// --- arguments -------------------------------------------------------------
let args = CommandLine.arguments
let rawPhrase = args.count > 1 ? args[1] : "lilo"
let socketPath = args.count > 2 ? args[2] : ""
let parentPid: Int32 = args.count > 3 ? (Int32(args[3]) ?? 0) : 0

func normalize(_ value: String) -> String {
    let allowed = CharacterSet.alphanumerics.union(.whitespaces)
    let filtered = value.unicodeScalars.filter { allowed.contains($0) }
    return String(String.UnicodeScalarView(filtered))
        .lowercased()
        .split(separator: " ")
        .joined(separator: " ")
}

let phrase: String = {
    let trimmed = normalize(rawPhrase)
    return trimmed.isEmpty ? "lilo" : trimmed
}()

// Speech recognition mangles uncommon names ("lilo" -> "zully"/"zooli"/
// "jolly"), so compare word windows by edit distance instead of exact match.
func levenshtein(_ a: [Character], _ b: [Character]) -> Int {
    var prev = Array(0...b.count)
    var cur = prev
    for i in 1...max(a.count, 1) {
        if i > a.count { break }
        cur[0] = i
        for j in 1...max(b.count, 1) {
            if j > b.count { break }
            let cost = a[i - 1] == b[j - 1] ? 0 : 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        }
        prev = cur
    }
    return prev[b.count]
}

let phraseWords = phrase.split(separator: " ").map(String.init)
let allowedDistance = phrase.count <= 7 ? 1 : 2

/// The phrase's coined word, when it has one worth matching on its own.
///
/// The recognizer needs a moment to lock on after silence, so the greeting in
/// front ("hello") is routinely lost and only "lilo …" comes back. The coined
/// word alone is distinctive enough to wake on, but only spelled exactly: its
/// near neighbours ("kilo", "silo", "milo") are ordinary words. A one-word
/// phrase is that word.
let distinctiveWord: String? = {
    guard let last = phraseWords.last, last.count >= 4 else {
        return nil
    }
    return last
}()

func matchesPhrase(_ text: String) -> Bool {
    let words = normalize(text).split(separator: " ").map(String.init)
    guard !words.isEmpty else { return false }
    if let distinctiveWord, words.contains(distinctiveWord) { return true }
    if phraseWords.count == 1 {
        // One word is too short for edit distance to be safe; accept it only
        // exact, or split in two by the recognizer ("li lo").
        return zip(words, words.dropFirst()).contains { $0 + $1 == phrase }
    }
    let target = Array(phrase)
    for len in [phraseWords.count, phraseWords.count + 1] where len >= 1 && words.count >= len {
        for start in 0...(words.count - len) {
            let window = Array(words[start..<(start + len)].joined(separator: " "))
            if window.count > target.count + 2 { continue }
            if levenshtein(window, target) <= allowedDistance { return true }
        }
    }
    return false
}

// --- output channel (socket, else stdout) ----------------------------------
func connectUnixSocket(_ path: String) -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    if fd < 0 { return -1 }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let cap = MemoryLayout.size(ofValue: addr.sun_path)
    let bytes = Array(path.utf8)
    if bytes.count >= cap { close(fd); return -1 }
    withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
        ptr.withMemoryRebound(to: CChar.self, capacity: cap) { cptr in
            for (i, b) in bytes.enumerated() { cptr[i] = CChar(bitPattern: b) }
            cptr[bytes.count] = 0
        }
    }
    let len = socklen_t(MemoryLayout<sockaddr_un>.size)
    let res = withUnsafePointer(to: &addr) { ptr in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, len)
        }
    }
    if res < 0 { close(fd); return -1 }
    return fd
}

let outFd: Int32 = socketPath.isEmpty ? -1 : connectUnixSocket(socketPath)
let writeQueue = DispatchQueue(label: "com.lilo.app.wake.emit")

func writeLine(_ line: String) {
    let data = (line + "\n").data(using: .utf8)!
    writeQueue.sync {
        if outFd >= 0 {
            data.withUnsafeBytes { buf in
                var offset = 0
                while offset < buf.count {
                    let n = Darwin.write(outFd, buf.baseAddress! + offset, buf.count - offset)
                    if n <= 0 { break }
                    offset += n
                }
            }
        } else {
            FileHandle.standardOutput.write(data)
        }
    }
}

func emit(_ line: String) { writeLine(line) }
func logErr(_ line: String) { FileHandle.standardError.write((line + "\n").data(using: .utf8)!) }

// If the backend never connects, there is nobody to talk to — bail so we do
// not strand a mic-holding process.
if !socketPath.isEmpty && outFd < 0 {
    logErr("could not connect to wake socket: \(socketPath)")
    exit(7)
}
// A write to a peer that closed its end must not kill us (default SIGPIPE
// action is silent termination). Turn it into an EPIPE the write loop ignores.
signal(SIGPIPE, SIG_IGN)
// Report fatal crashes over the socket so the backend log shows the cause.
for sig in [SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGFPE] {
    signal(sig) { s in
        let msg = "SIG \(s)\n"
        _ = msg.withCString { Darwin.write(outFd, $0, strlen($0)) }
        _exit(128 + s)
    }
}

// --- listen for STOP / EOF from the backend --------------------------------
if outFd >= 0 {
    DispatchQueue(label: "com.lilo.app.wake.control").async {
        var buf = [UInt8](repeating: 0, count: 256)
        while true {
            let n = read(outFd, &buf, buf.count)
            if n <= 0 {
                emit("BYE")
                exit(0)
            }
            let text = String(bytes: buf[0..<n], encoding: .utf8) ?? ""
            if text.contains("STOP") {
                emit("BYE")
                exit(0)
            }
        }
    }
}

// Self-reap if the app that owns us is gone: this helper is reparented to
// launchd when launched via `open`, so getppid() is useless. We watch the pid
// the backend handed us so a crashed app never leaves the orange mic dot on.
func parentAlive() -> Bool {
    guard parentPid > 0 else { return true }
    return kill(parentPid, 0) == 0 || errno == EPERM
}

Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
    if !parentAlive() { exit(0) }
}

// --- permissions -----------------------------------------------------------
var speechAuthorized = false
let authSem = DispatchSemaphore(value: 0)
SFSpeechRecognizer.requestAuthorization { status in
    speechAuthorized = status == .authorized
    authSem.signal()
}
authSem.wait()
guard speechAuthorized else {
    emit("NOREC")
    logErr("speech recognition not authorized")
    exit(3)
}

let micSem = DispatchSemaphore(value: 0)
var micGranted = false
AVCaptureDevice.requestAccess(for: .audio) { granted in
    micGranted = granted
    micSem.signal()
}
micSem.wait()
let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
guard micGranted else {
    emit("ERR no-mic-permission")
    logErr("microphone access denied (status=\(micStatus.rawValue))")
    exit(8)
}

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
      recognizer.isAvailable else {
    emit("NOREC")
    logErr("speech recognizer unavailable")
    exit(4)
}

// --- recognition loop ------------------------------------------------------
let engine = AVAudioEngine()

/// When the last audio buffer arrived. The tap fires continuously while the
/// device is alive — silence still produces buffers — so a gap means the input
/// device went away, not that the room is quiet.
var lastBufferAt = Date()
/// When audio last carried *anything*. A device another process reconfigured
/// keeps delivering buffers that are digitally silent: the recognizer then
/// answers "no speech" forever, which looks exactly like a broken wake word.
/// A quiet room still has a noise floor, so true zero is the signal.
var lastSoundAt = Date()
/// When audio last carried something loud enough to be someone talking.
/// A noise floor clears `SILENCE_RMS` at all times, so it cannot tell "nobody
/// said anything" from "the recognizer stopped understanding speech"; this can.
var lastLoudAt = Date.distantPast
/// Consecutive rebuilds that did not bring the sound back.
var silentRestarts = 0
/// Digital silence: below this the buffer carries no signal at all.
let SILENCE_RMS: Float = 1e-5
/// Speech level: above this someone is talking near the microphone.
let SPEECH_RMS: Float = 5e-3
/// How long silent-but-flowing audio is tolerated before rebuilding.
let SILENT_AFTER: TimeInterval = 12

var request: SFSpeechAudioBufferRecognitionRequest?
var task: SFSpeechRecognitionTask?
var lastWake = Date.distantPast
var lastPartial = ""
/// Last time the recognizer reacted at all: a partial, a final, or a "no
/// speech detected" error. Silence is normal; *no reaction whatsoever* while
/// buffers keep arriving is a wedged recognizer, and it looks exactly like a
/// deaf microphone from the outside.
var lastRecognizerAt = Date()
/// Last time the recognizer produced an actual transcription. "No speech
/// detected" keeps `lastRecognizerAt` fresh, so on its own that clock cannot
/// see a recognizer that is fed speech and understands none of it.
var lastResultAt = Date()
/// A DEAF report goes to the host once per silence episode.
var deafReported = false
/// Silence needed before the host is told the recognizer is wedged.
let DEAF_AFTER: TimeInterval = 180
/// How long speech may go untranscribed before the recognizer is declared deaf.
/// This is the only clock that sees the failure that follows a device change,
/// so it has to be short enough that a person retrying the wake phrase gets a
/// working listener back rather than giving up on it.
let UNHEARD_AFTER: TimeInterval = 45
var restarting = false
/// Set when recognition cannot work at all until the user changes something.
/// Retrying three times a second against a disabled service floods the log and
/// hides everything else, so a blocked recognizer backs off instead.
var blockedReason = ""

@Sendable func stopTask() {
    request?.endAudio()
    task?.cancel()
    task = nil
    request = nil
}

func startTask() {
    stopTask()
    restarting = false

    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    if recognizer.supportsOnDeviceRecognition {
        req.requiresOnDeviceRecognition = true
    }
    // Bias the recognizer toward our coined word: without this "lilo" comes
    // back as "julie"/"zooli"/"sully" and the wake never fires.
    let distinctive = phraseWords.last ?? phrase
    req.contextualStrings = [phrase, distinctive, "hey \(distinctive)"]
    request = req

    task = recognizer.recognitionTask(with: req) { result, error in
        if let result {
            lastRecognizerAt = Date()
            lastResultAt = Date()
            deafReported = false
            let text = normalize(result.bestTranscription.formattedString)
            if !text.isEmpty && text != lastPartial {
                lastPartial = text
                emit("PART " + text)
            }
            if result.isFinal {
                emit("HEARD " + text)
            }
            if matchesPhrase(text) {
                let now = Date()
                if now.timeIntervalSince(lastWake) > 3 {
                    lastWake = now
                    emit("WAKE")
                }
                DispatchQueue.main.async { startTask() }
                return
            }
        }
        var retryAfter = 0.3
        if let error {
            // Without this a recognizer that fails on every task simply looks
            // like the wake word not working: audio flows, nothing is heard.
            let code = (error as NSError).code
            switch code {
            case 301, 216:
                break // we cancelled it ourselves
            case 203, 1110:
                // "No speech detected" — this is what silence looks like, and it
                // fires constantly. Routine, never a reason to alarm anyone, but
                // it *is* the recognizer reacting: the deafness watch stays quiet.
                lastRecognizerAt = Date()
                break
            case 201:
                // The one that actually blocks: the Speech framework refuses to
                // work while Dictation is off, and says so only here.
                if blockedReason != "dictation-disabled" {
                    blockedReason = "dictation-disabled"
                    emit("BLOCKED dictation-disabled: \(error.localizedDescription)")
                }
                retryAfter = 15
            default:
                emit("DBG rec error \(code): \(error.localizedDescription)")
                retryAfter = 1
            }
        } else if result != nil && !blockedReason.isEmpty {
            // It started working again — say so, so the UI can clear the notice.
            blockedReason = ""
            emit("UNBLOCKED")
        }
        if error != nil || (result?.isFinal ?? false) {
            if restarting { return }
            restarting = true
            DispatchQueue.main.asyncAfter(deadline: .now() + retryAfter) { startTask() }
        }
    }
}

/// Level of a tap buffer, sampled cheaply (every 8th frame of the first channel
/// is plenty to tell silence from a noise floor from speech).
func bufferLevel(_ buffer: AVAudioPCMBuffer) -> Float {
    guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else {
        return 0
    }
    var sum: Float = 0
    var counted = 0
    var i = 0
    while i < Int(buffer.frameLength) {
        let sample = channel[i]
        sum += sample * sample
        counted += 1
        i += 8
    }
    guard counted > 0 else { return 0 }
    return (sum / Float(counted)).squareRoot()
}

/// Turns a multichannel input into mono for the recognizer; `nil` when the
/// input already is mono.
///
/// After a voice call, WebKit leaves the built-in microphone in its
/// voice-processing layout (3 channels). The recognizer accepts multichannel
/// buffers without an error and never recognizes a word from them.
var downmix: (converter: AVAudioConverter, format: AVAudioFormat)?

/// Install the tap and start the engine, reading the input format *now*.
///
/// The format must be re-read on every start: after the default input device
/// changes, the previous one describes hardware that no longer exists.
@Sendable func startAudio() -> Bool {
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
        logErr("no usable microphone format (sr=\(format.sampleRate) ch=\(format.channelCount))")
        return false
    }
    downmix = nil
    if format.channelCount > 1,
       let mono = AVAudioFormat(
           commonFormat: .pcmFormatFloat32,
           sampleRate: format.sampleRate,
           channels: 1,
           interleaved: false
       ),
       let converter = AVAudioConverter(from: format, to: mono) {
        // Channel 0 is the microphone; the others are voice-processing
        // references, and mixing them in would feed playback to the recognizer.
        converter.channelMap = [0]
        downmix = (converter, mono)
        emit("DBG audio downmix ch=\(format.channelCount) -> 1")
    }
    let conversion = downmix
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        lastBufferAt = Date()
        let level = bufferLevel(buffer)
        if level > SILENCE_RMS {
            lastSoundAt = Date()
            silentRestarts = 0
        }
        if level > SPEECH_RMS {
            lastLoudAt = Date()
        }
        guard let (converter, mono) = conversion else {
            request?.append(buffer)
            return
        }
        guard let out = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength) else {
            return
        }
        do {
            try converter.convert(to: out, from: buffer)
            request?.append(out)
        } catch {
            // One bad buffer is not worth a restart; the next one tries again.
        }
    }
    engine.prepare()
    do {
        try engine.start()
    } catch {
        logErr("audio engine failed: \(error)")
        return false
    }
    lastBufferAt = Date()
    emit("DBG audio started sr=\(Int(format.sampleRate)) ch=\(format.channelCount)")
    return true
}

/// Hand the listener back to the host as a fresh process.
///
/// Rebuilding this engine in place does not survive the microphone being
/// reconfigured under us: the tap keeps delivering buffers, so every watchdog
/// here stays happy, but the recognizer is handed audio it transcribes into
/// nothing and answers "no speech" forever. A new process always comes back
/// listening, and the host respawns us as long as it still wants a listener.
func respawn(_ reason: String) -> Never {
    emit("DBG respawn (\(reason))")
    exit(0)
}

/// Rebuild the audio path after the microphone changed underneath us.
///
/// AVAudioEngine does **not** follow the default input device on macOS: plug in
/// a headset and the tap goes silent with no error and no microphone indicator,
/// which looks exactly like the wake word being broken.
func restartAudio(_ reason: String) {
    emit("DBG audio restart (\(reason))")
    stopTask()
    engine.stop()
    engine.reset()
    // A rebuild is a fresh chance for sound; the watchdog judges the result.
    lastSoundAt = Date()
    if startAudio() {
        startTask()
    } else {
        emit("ERR engine-restart")
        // Try again shortly: the device may still be settling.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { restartAudio("retry") }
    }
}

guard startAudio() else {
    emit("ERR no-mic")
    exit(6)
}

emit("DBG recognizer onDevice=\(recognizer.supportsOnDeviceRecognition) available=\(recognizer.isAvailable)")
emit("READY")
startTask()

NotificationCenter.default.addObserver(
    forName: .AVAudioEngineConfigurationChange,
    object: engine,
    queue: .main
) { _ in
    // Rebuilding in place after a device change leaves a recognizer that is fed
    // audio and transcribes none of it; only a fresh process comes back
    // listening, and the host brings one up within a couple of seconds.
    respawn("configuration change")
}

// The recognizer caps a single request; recycle it periodically.
Timer.scheduledTimer(withTimeInterval: 45, repeats: true) { _ in startTask() }

// A recognizer that is fed audio and gives nothing back is wedged: recycling
// the task does not bring it back, a fresh process does.
Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { _ in
    let fed = Date().timeIntervalSince(lastBufferAt) < 10
    guard fed, !deafReported else { return }
    let wedged = Date().timeIntervalSince(lastRecognizerAt) > DEAF_AFTER
    // Speech going in and nothing coming out. Answering "no speech detected"
    // to someone talking into the microphone is the quietest way this breaks:
    // every other clock here is satisfied, because audio really is flowing.
    let unheard = Date().timeIntervalSince(lastLoudAt) < UNHEARD_AFTER
        && Date().timeIntervalSince(lastResultAt) > UNHEARD_AFTER
    guard wedged || unheard else { return }
    deafReported = true
    emit("DEAF")
    respawn(unheard ? "speech heard, nothing recognized" : "recognizer silent")
}

// The configuration-change notification is not always delivered when a device
// disappears, so watch the audio itself. No buffers for this long means deaf.
Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
    if Date().timeIntervalSince(lastBufferAt) > 10 {
        restartAudio("no audio for 10s")
        return
    }
    // Buffers arriving with nothing in them: the device was reconfigured under
    // us (a voice call, another app taking the microphone). Rebuild, and if
    // that does not bring the signal back, hand the problem to the host.
    guard Date().timeIntervalSince(lastSoundAt) > SILENT_AFTER else { return }
    silentRestarts += 1
    if silentRestarts > 2 {
        silentRestarts = 0
        emit("DEAF")
    }
    restartAudio("silent input")
}

// Periodic proof of life: distinguishes "deaf" from "hearing but recognizing
// nothing", which look identical from the outside.
Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in
    let age = Date().timeIntervalSince(lastBufferAt)
    let quiet = Date().timeIntervalSince(lastSoundAt)
    emit(String(
        format: "DBG heartbeat lastBuffer=%.1fs silence=%.1fs task=%@",
        age,
        quiet,
        task == nil ? "none" : "live"
    ))
}

RunLoop.main.run()
