let context: AudioContext | null = null;

export function playChime(): void {
  try {
    context ??= new AudioContext();
    const ctx = context;
    if (ctx.state === "suspended") void ctx.resume();
    const start = ctx.currentTime + 0.02;
    [880, 1320].forEach((frequency, index) => {
      const at = start + index * 0.18;
      const tone = ctx.createOscillator();
      const gain = ctx.createGain();
      tone.type = "sine";
      tone.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
      tone.connect(gain).connect(ctx.destination);
      tone.start(at);
      tone.stop(at + 0.5);
    });
  } catch {
    return;
  }
}
