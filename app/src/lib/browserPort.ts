/** Optional host-owned browser interaction. No native IPC or provider code. */
export interface BrowserFrame {
  phase: "login" | "connected" | "closed" | "error" | "audio";
  origin?: string;
  image?: string;
  width?: number;
  height?: number;
  error?: string;
  message?: string;
  audio?: { available: boolean; inputAvailable: boolean; outputAvailable: boolean; microphonePeak?: number; speakerTest?: string; microphoneTest?: string };
  step?: "working" | "ask" | "challenge" | "error";
  ask?: "email" | "password" | "code" | "phone";
}
export type BrowserAction =
  | { action: "start"; provider: string }
  | { action: "frame" | "visual" | "cancel" | "audioStatus" | "audioEnable" | "audioTestSpeaker" | "audioTestMicrophone" }
  | { action: "answer"; field: "email" | "password" | "code" | "phone"; value: string }
  | { action: "click"; x: number; y: number }
  | { action: "text"; text: string }
  | { action: "key"; key: "Enter" | "Tab" | "Backspace" | "Escape" }
  | { action: "scroll"; dy: number };
export interface BrowserPort {
  supports(provider: string): boolean;
  exchange(action: BrowserAction): Promise<BrowserFrame>;
}
