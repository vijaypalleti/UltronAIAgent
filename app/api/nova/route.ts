/**
 * Nova Relay Manager API
 *
 * GET  /api/nova/status  — checks whether the relay WebSocket port is open
 * POST /api/nova/launch  — attempts to auto-launch relay.py and returns port info
 *
 * The relay runs separately from the Next.js server. If the user has Python
 * and the dependencies installed, this endpoint can spawn it automatically.
 */

import { NextResponse } from "next/server";
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import net from "net";

const RELAY_HOST = process.env.RELAY_HOST || "127.0.0.1";
const RELAY_PORT = parseInt(process.env.RELAY_PORT || "8765", 10);
const RELAY_SCRIPT = path.join(process.cwd(), "nova", "relay.py");
const ENV_FILE = path.join(process.cwd(), "nova", ".env");

interface RelayStatus {
  running: boolean;
  host: string;
  port: number;
  pid?: number;
  error?: string;
  hasDotEnv: boolean;
  hasPython: boolean;
  hasDeps: boolean;
  canAutoStart: boolean;
}

let relayProcess: ChildProcess | null = null;

/**
 * Check if a TCP port is accepting connections.
 */
function checkPort(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

/**
 * Check if Python is available.
 */
async function checkPython(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("python", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3000,
    });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Check if the google-genai package is installed.
 */
async function checkDeps(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("python", ["-c", "import google.genai; import websockets"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3000,
    });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

export async function GET() {
  const running = await checkPort(RELAY_HOST, RELAY_PORT);
  const hasDotEnv = fs.existsSync(ENV_FILE);

  const status: RelayStatus = {
    running,
    host: RELAY_HOST,
    port: RELAY_PORT,
    hasDotEnv,
    hasPython: false,
    hasDeps: false,
    canAutoStart: false,
  };

  if (!running) {
    status.hasPython = await checkPython();
    if (status.hasPython) {
      status.hasDeps = await checkDeps();
    }
    status.canAutoStart = status.hasDotEnv && status.hasPython && status.hasDeps;
  }

  // If relay process was spawned by us, include PID
  if (relayProcess && relayProcess.pid) {
    status.pid = relayProcess.pid;
  }

  return NextResponse.json(status);
}

export async function POST() {
  // Check if already running
  const running = await checkPort(RELAY_HOST, RELAY_PORT);
  if (running) {
    return NextResponse.json({
      success: true,
      message: "Relay is already running",
      host: RELAY_HOST,
      port: RELAY_PORT,
    });
  }

  // Check prerequisites
  const hasDotEnv = fs.existsSync(ENV_FILE);
  if (!hasDotEnv) {
    return NextResponse.json({
      success: false,
      message: `No .env file found at nova/.env. Create it with your GEMINI_API_KEY:\ncp nova/.env.template nova/.env\nThen edit nova/.env and paste your key.`,
    }, { status: 400 });
  }

  if (!fs.existsSync(RELAY_SCRIPT)) {
    return NextResponse.json({
      success: false,
      message: `Relay script not found at ${RELAY_SCRIPT}`,
    }, { status: 500 });
  }

  // Spawn the relay
  try {
    relayProcess = spawn("python", [RELAY_SCRIPT], {
      cwd: path.join(process.cwd(), "nova"),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: false,
    });

    relayProcess.stdout?.on("data", (data: Buffer) => {
      console.log(`[nova-relay] ${data.toString().trim()}`);
    });
    relayProcess.stderr?.on("data", (data: Buffer) => {
      console.error(`[nova-relay] ${data.toString().trim()}`);
    });
    relayProcess.on("error", (err) => {
      console.error("[nova-relay] Failed to start:", err.message);
      relayProcess = null;
    });
    relayProcess.on("exit", (code) => {
      console.log(`[nova-relay] Exited with code ${code}`);
      relayProcess = null;
    });

    // Wait up to 8s for it to be ready
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await checkPort(RELAY_HOST, RELAY_PORT)) {
        return NextResponse.json({
          success: true,
          message: "Relay started successfully",
          host: RELAY_HOST,
          port: RELAY_PORT,
          pid: relayProcess.pid,
        });
      }
    }

    // Timed out
    return NextResponse.json({
      success: false,
      message: "Relay process started but didn't become ready within 8s. Check the terminal for errors.",
    }, { status: 500 });

  } catch (err: any) {
    return NextResponse.json({
      success: false,
      message: `Failed to start relay: ${err.message}`,
    }, { status: 500 });
  }
}
