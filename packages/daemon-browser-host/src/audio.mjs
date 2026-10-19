import { spawn } from "node:child_process";

/** Linux audio adapter. The service must be given a real PulseAudio endpoint. */
function command(binary, args, { input, captureMs, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const chunks = [];
    let length = 0;
    const timer = setTimeout(() => child.kill("SIGTERM"), captureMs ?? timeout);
    const deadline = setTimeout(() => child.kill("SIGKILL"), timeout + 1000);
    child.stdout.on("data", chunk => {
      length += chunk.length;
      if (length > 128000) child.kill("SIGTERM");
      else chunks.push(chunk);
    });
    child.on("error", () => { clearTimeout(timer); clearTimeout(deadline); reject(new Error("Audio command is unavailable.")); });
    child.on("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(deadline);
      if (code === 0 || (captureMs && signal === "SIGTERM" && length > 0)) resolve(Buffer.concat(chunks));
      else reject(new Error("Audio device is unavailable."));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export class PulseAudio {
  async status() {
    if (process.platform !== "linux" || !process.env.PULSE_SERVER) return { available: false, inputAvailable: false, outputAvailable: false, backend: "unavailable" };
    try {
      const sources = JSON.parse((await command("pactl", ["--format=json", "list", "sources"])).toString("utf8"));
      const sinks = JSON.parse((await command("pactl", ["--format=json", "list", "sinks"])).toString("utf8"));
      return { available: true, inputAvailable: sources.some(source => !source.name?.endsWith(".monitor")), outputAvailable: sinks.length > 0, backend: "pulseaudio" };
    } catch { return { available: false, inputAvailable: false, outputAvailable: false, backend: "pulseaudio" }; }
  }
  async testSpeaker() {
    const status = await this.status();
    if (!status.outputAvailable) throw new Error("Output is unavailable.");
    const samples = Buffer.alloc(16000);
    for (let i = 0; i < 8000; i++) samples.writeInt16LE(Math.round(2500 * Math.sin(2 * Math.PI * 440 * i / 16000) * Math.sin(Math.PI * i / 8000)), i * 2);
    await command("paplay", ["--raw", "--format=s16le", "--rate=16000", "--channels=1"], { input: samples });
    return { ...status, speakerTest: "played" };
  }
  async testMicrophone() {
    const status = await this.status();
    if (!status.inputAvailable) throw new Error("Input is unavailable.");
    const pcm = await command("parec", ["--raw", "--format=s16le", "--rate=16000", "--channels=1"], { captureMs: 2000 });
    let peak = 0;
    for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    return { ...status, microphoneTest: "captured", microphonePeak: peak / 32768 };
  }
}
