import { spawn, type ChildProcess } from "child_process";

/**
 * Manages the local llama-server process lifecycle.
 * - Checks if the server is already running
 * - Starts it on demand if not
 * - Waits until it's ready before returning
 */

const LLAMA_SERVER_DIR =
  process.env.LLAMA_SERVER_DIR || "C:\\llama-b8838-bin-win-cpu-x64";
const LLAMA_SERVER_BIN =
  process.env.LLAMA_SERVER_BIN || `${LLAMA_SERVER_DIR}\\llama-server.exe`;
const LLAMA_MODEL =
  process.env.LLAMA_MODEL || "LFM2.5-1.2B-Instruct-Q8_0.gguf";
const LOCAL_LLM_HOST = process.env.LOCAL_LLM_HOST || "127.0.0.1";
const LOCAL_LLM_PORT = parseInt(process.env.LOCAL_LLM_PORT || "8080", 10);

let serverProcess: ChildProcess | null = null;
let startingPromise: Promise<void> | null = null;

/** Check if the local LLM server is already responding. */
async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://${LOCAL_LLM_HOST}:${LOCAL_LLM_PORT}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      // llama-server returns { status: "ok" } when ready
      return body?.status === "ok";
    }
    return false;
  } catch {
    return false;
  }
}

/** Poll the health endpoint until the server is ready or timeout. */
async function waitForReady(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://${LOCAL_LLM_HOST}:${LOCAL_LLM_PORT}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.status === "ok") return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Local LLM server did not become ready within ${timeoutMs}ms`);
}

/**
 * Ensure the local llama-server is running.
 * If already running, returns immediately.
 * If not, starts the process and waits for it to be ready.
 */
export async function ensureLocalLlmRunning(): Promise<void> {
  // Already running?
  if (await isServerRunning()) return;

  // Another call is already starting it — wait on that
  if (startingPromise) return startingPromise;

  startingPromise = (async () => {
    console.log("[ULTRON] Starting local llama-server...");

    const modelPath = `${LLAMA_SERVER_DIR}\\${LLAMA_MODEL}`;

    serverProcess = spawn(
      LLAMA_SERVER_BIN,
      [
        "-m", modelPath,
        "--host", LOCAL_LLM_HOST,
        "--port", String(LOCAL_LLM_PORT),
      ],
      {
        cwd: LLAMA_SERVER_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: false,
      },
    );

    serverProcess.stdout?.on("data", (data: Buffer) => {
      console.log(`[llama-server] ${data.toString().trim()}`);
    });
    serverProcess.stderr?.on("data", (data: Buffer) => {
      console.error(`[llama-server] ${data.toString().trim()}`);
    });
    serverProcess.on("error", (err) => {
      console.error("[ULTRON] Failed to start llama-server:", err.message);
      serverProcess = null;
    });
    serverProcess.on("exit", (code) => {
      console.log(`[ULTRON] llama-server exited with code ${code}`);
      serverProcess = null;
    });

    try {
      await waitForReady(90_000); // 90s to load model (can be slow on first run)
      console.log("[ULTRON] Local llama-server is ready.");
    } catch (err) {
      console.error("[ULTRON] llama-server failed to start:", err);
      throw err;
    }
  })();

  try {
    await startingPromise;
  } finally {
    startingPromise = null;
  }
}

/** Gracefully stop the local server (called on process exit). */
export function stopLocalLlm(): void {
  if (serverProcess) {
    console.log("[ULTRON] Stopping local llama-server...");
    serverProcess.kill();
    serverProcess = null;
  }
}

// Clean up on process exit
process.on("SIGINT", () => { stopLocalLlm(); process.exit(0); });
process.on("SIGTERM", () => { stopLocalLlm(); process.exit(0); });
process.on("exit", () => { stopLocalLlm(); });
