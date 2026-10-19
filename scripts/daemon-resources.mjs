#!/usr/bin/env node
/** Read-only Docker measurements for the optional local daemon test runtime. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const containers = ["lilo-daemon-phone", "lilo-browser-host"];
const samples = Number(process.argv[2] ?? 5);
if (!Number.isInteger(samples) || samples < 1 || samples > 30) {
  console.error("Usage: node scripts/daemon-resources.mjs [samples: 1..30]");
  process.exitCode = 1;
} else {
  try {
    const measurements = [];
    for (let sample = 0; sample < samples; sample++) {
      const { stdout } = await execute("docker", ["stats", "--no-stream", "--format", "{{json .}}", ...containers], { timeout: 15000, maxBuffer: 65536, windowsHide: true });
      for (const line of stdout.trim().split("\n")) {
        if (!line) continue;
        const value = JSON.parse(line);
        if (!containers.includes(value.Name)) throw new Error("Unexpected container.");
        measurements.push({ sample: sample + 1, container: value.Name, cpu: value.CPUPerc, memory: value.MemUsage, pids: value.PIDs });
      }
      if (sample + 1 < samples) await delay(1000);
    }
    console.log(JSON.stringify({ measuredAt: new Date().toISOString(), scope: "Local Linux Docker containers; Docker working-set accounting, not process RSS or physical-board sizing. Session state is not inferred.", measurements }, null, 2));
  } catch {
    console.error("Measurement failed. Start the local daemon runtime and ensure Docker is available to your regular user.");
    process.exitCode = 1;
  }
}
