// A cloudflared quick tunnel, so AgentPhone can reach this machine without hosting anything.
import { spawn } from "node:child_process";

/** Start a cloudflared quick tunnel to `port` and resolve with its public URL. */
export function openTunnel(port: number, isStopping: () => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => reject(new Error("cloudflared didn't report a tunnel URL within 30s")), 30_000);
    const onData = (chunk: Buffer) => {
      const match = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => {
      if (!isStopping()) {
        console.error(`cloudflared exited (${code})`);
        process.exit(1);
      }
    });
    process.on("exit", () => proc.kill());
  });
}

/** Best-effort: this Mac may cache a failed DNS lookup for the new hostname even when the tunnel works. */
export async function waitUntilReachable(url: string) {
  for (let i = 0; i < 45; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(3000) })).ok) return;
    } catch {
      /* DNS for a new quick tunnel takes a few seconds */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.warn(`warning: couldn't reach ${url} from this machine; continuing (AgentPhone may still reach it)`);
}
