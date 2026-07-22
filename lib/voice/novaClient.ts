/**
 * Nova Client — connects the browser to the Gemini Live API via the Python relay.
 *
 * Architecture:
 *   Browser (Web Audio API) ←→ WebSocket ←→ nova/relay.py ←→ Gemini Live API
 *
 * No wake word needed. Just start/stop the session. The Gemini Live API handles:
 *   - Voice Activity Detection (sends audio to model when user speaks)
 *   - Barge-in / interruption (if user speaks while model responds)
 *   - Natural turn-taking
 *
 * Usage:
 *   const nova = new NovaClient();
 *   nova.onStateChange = (state) => { ... };
 *   nova.onTranscript = (text) => { ... };
 *   nova.onError = (msg) => { ... };
 *   await nova.start();
 *   // ...
 *   nova.stop();
 */

export type NovaState = "connecting" | "listening" | "speaking" | "thinking" | "disconnected";

export interface NovaCallbacks {
  onStateChange?: (state: NovaState) => void;
  onInputTranscript?: (text: string) => void;   // what the user said
  onOutputTranscript?: (text: string) => void;  // what Nova said
  onError?: (error: string) => void;
}

export interface RelayStatus {
  running: boolean;
  host: string;
  port: number;
  hasDotEnv: boolean;
  hasPython: boolean;
  hasDeps: boolean;
  canAutoStart: boolean;
  error?: string;
}

const SEND_SAMPLE_RATE = 16000;
const RECV_SAMPLE_RATE = 24000;
const CHUNK_SIZE = 2048;

export class NovaClient {
  private wsUrl: string;
  private ws: WebSocket | null = null;
  private callbacks: NovaCallbacks = {};

  // Audio capture
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;

  // Audio playback
  private playbackContext: AudioContext | null = null;
  private audioQueue: AudioBuffer[] = [];
  private isPlaying = false;

  private _state: NovaState = "disconnected";
  private running = false;

  constructor(wsUrl = "ws://127.0.0.1:8765") {
    this.wsUrl = wsUrl;
  }

  setCallbacks(cbs: NovaCallbacks): void {
    this.callbacks = cbs;
  }

  get state(): NovaState {
    return this._state;
  }

  private setState(s: NovaState): void {
    if (this._state !== s) {
      this._state = s;
      this.callbacks.onStateChange?.(s);
    }
  }

  // ──────────────────────────────────────────────
  // Pre-flight check — ping the relay manager API
  // ──────────────────────────────────────────────

  /**
   * Check if the relay is running via the Next.js API.
   * Returns the status object, or null if the API can't be reached.
   */
  async checkRelayStatus(): Promise<RelayStatus | null> {
    try {
      const res = await fetch("/api/nova");
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  /**
   * Try to auto-launch the relay via the Next.js API.
   */
  async launchRelay(): Promise<{ success: boolean; message: string }> {
    try {
      const res = await fetch("/api/nova", { method: "POST" });
      const data = await res.json();
      return data;
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  // ──────────────────────────────────────────────
  // Start / Stop
  // ──────────────────────────────────────────────

  async start(modelId = "gemini-2.5-flash-native-audio-preview-12-2025"): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.setState("connecting");

    // 0. Pre-flight: check if relay is running; if not, try to launch it
    const status = await this.checkRelayStatus();
    if (status && !status.running) {
      if (status.canAutoStart) {
        this.callbacks.onError?.("Launching Nova relay...");
        const launchResult = await this.launchRelay();
        if (!launchResult.success) {
          this.callbacks.onError?.(`${launchResult.message}`);
          this.running = false;
          this.setState("disconnected");
          return;
        }
      } else {
        // Relay not running and can't auto-start — give clear instructions
        let msg = "Nova relay is not running. ";
        if (!status.hasDotEnv) {
          msg += "Missing nova/.env file. ";
        }
        if (!status.hasPython) {
          msg += "Python is not installed or not in PATH. ";
        }
        if (status.hasPython && !status.hasDeps) {
          msg += "Python dependencies not installed. Run: pip install -r requirements-gemini.txt";
        }
        if (!status.hasPython && !status.hasDotEnv) {
          msg += "\n\nSetup:\n" +
            "  1. pip install -r requirements-gemini.txt\n" +
            "  2. cp nova/.env.template nova/.env\n" +
            "  3. Edit nova/.env with your GEMINI_API_KEY\n" +
            "  4. python nova/relay.py";
        }
        this.callbacks.onError?.(msg);
        this.running = false;
        this.setState("disconnected");
        return;
      }
    }

    // 1. Get mic permission
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: { ideal: SEND_SAMPLE_RATE },
        },
      });
    } catch (err) {
      this.callbacks.onError?.("Microphone access denied. Check browser permissions.");
      this.running = false;
      this.setState("disconnected");
      return;
    }

    // 2. Open WebSocket to relay
    try {
      this.ws = await this.connectWebSocket();
    } catch (err) {
      this.callbacks.onError?.(
        `Cannot reach Nova relay at ${this.wsUrl}.\n` +
        `Make sure relay.py is running: python nova/relay.py`
      );
      this.cleanupAudio();
      this.running = false;
      this.setState("disconnected");
      return;
    }

    // 3. Send start command
    this.ws.send(JSON.stringify({ type: "start", model: modelId }));

    // 4. Set up audio capture
    this.setupCapture();

    // 5. Set up audio playback
    this.setupPlayback();

    // 6. Set up WebSocket receive handler
    this.setupReceiver();

    this.setState("listening");
  }

  stop(): void {
    this.running = false;

    // Send stop command
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "stop" }));
    }

    // Close WebSocket
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }

    this.cleanupAudio();
    this.setState("disconnected");
  }

  // ──────────────────────────────────────────────
  // WebSocket connection
  // ──────────────────────────────────────────────

  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private reconnectDelayMs = 2000;

  private connectWebSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      // Critical: browsers default binaryType to "blob", which makes
      // event.data a Blob instead of ArrayBuffer. Our receiver checks
      // instanceof ArrayBuffer, so binary audio would be silently dropped.
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        this.reconnectAttempts = 0; // reset on successful connect
        resolve(ws);
      };
      ws.onerror = () => {
        reject(new Error("WebSocket connection failed"));
      };
      ws.onclose = () => {
        if (this.running && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          this.callbacks.onError?.(`Connection lost — reconnecting (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
          // Attempt reconnect after delay
          setTimeout(() => {
            if (!this.running) return;
            this.connectWebSocket()
              .then((newWs) => {
                this.ws = newWs;
                // Re-send start command
                newWs.send(JSON.stringify({ type: "start", model: "gemini-2.5-flash-native-audio-preview-12-2025" }));
                this.setupReceiver();
                this.setState("listening");
              })
              .catch(() => {
                this.callbacks.onError?.("Reconnect failed — Nova session ended");
                this.running = false;
                this.setState("disconnected");
              });
          }, this.reconnectDelayMs);
        } else if (this.running) {
          this.callbacks.onError?.("Connection to Nova relay lost");
          this.running = false;
          this.setState("disconnected");
        }
      };

      // Timeout after 5 seconds
      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new Error("WebSocket connection timeout"));
        }
      }, 5000);
    });
  }

  // ──────────────────────────────────────────────
  // Audio capture — mic → WebSocket
  // ──────────────────────────────────────────────

  private setupCapture(): void {
    if (!this.mediaStream) return;

    this.audioContext = new AudioContext({ sampleRate: SEND_SAMPLE_RATE });
    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

    this.scriptProcessor = this.audioContext.createScriptProcessor(CHUNK_SIZE, 1, 1);

    this.scriptProcessor.onaudioprocess = (e) => {
      if (!this.running || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      const input = e.inputBuffer.getChannelData(0);

      // Convert Float32 → Int16 PCM
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      this.ws.send(pcm.buffer);
    };

    this.sourceNode.connect(this.scriptProcessor);
    this.scriptProcessor.connect(this.audioContext.destination);
  }

  // ──────────────────────────────────────────────
  // Audio playback — WebSocket → speakers
  // ──────────────────────────────────────────────

  private setupPlayback(): void {
    this.playbackContext = new AudioContext({ sampleRate: RECV_SAMPLE_RATE });
    this.audioQueue = [];
    this.isPlaying = false;
  }

  private setupReceiver(): void {
    if (!this.ws) return;

    let pcmBuffer = new Uint8Array(0);

    this.ws.onmessage = (event) => {
      if (!this.running) return;

      if (event.data instanceof ArrayBuffer) {
        const newData = new Uint8Array(event.data);
        const combined = new Uint8Array(pcmBuffer.length + newData.length);
        combined.set(pcmBuffer);
        combined.set(newData, pcmBuffer.length);
        pcmBuffer = combined;

        // Buffer 200ms of audio before playing (vs 1s before).
        // Gemini streams audio in small chunks — waiting too long
        // means the first chunk of a short greeting never plays.
        const frameBytes = RECV_SAMPLE_RATE * 2 * 0.2; // 200ms at 24kHz 16-bit
        while (pcmBuffer.length >= frameBytes) {
          const chunk = pcmBuffer.slice(0, frameBytes);
          pcmBuffer = pcmBuffer.slice(frameBytes);
          this.enqueueAudio(chunk);
        }

        this.setState("speaking");
      } else if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === "state") {
            this.setState(msg.state as NovaState);
          } else if (msg.type === "input_transcript") {
            this.callbacks.onInputTranscript?.(msg.text);
          } else if (msg.type === "output_transcript") {
            this.callbacks.onOutputTranscript?.(msg.text);
          } else if (msg.type === "text") {
            // Legacy fallback — treat as output
            this.callbacks.onOutputTranscript?.(msg.text);
          } else if (msg.type === "error") {
            this.callbacks.onError?.(msg.message);
          }
        } catch {
          // Ignore malformed JSON
        }
      }
    };
  }

  private enqueueAudio(pcmData: Uint8Array): void {
    if (!this.playbackContext) return;

    const sampleCount = pcmData.byteLength / 2;
    const buffer = this.playbackContext.createBuffer(1, sampleCount, RECV_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);

    const view = new DataView(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);
    for (let i = 0; i < sampleCount; i++) {
      channel[i] = view.getInt16(i * 2, true) / 32768;
    }

    this.audioQueue.push(buffer);
    this.schedulePlayback();
  }

  private schedulePlayback(): void {
    if (this.isPlaying || this.audioQueue.length === 0) return;
    this.isPlaying = true;
    this.playNext();
  }

  private playNext(): void {
    if (!this.playbackContext || this.audioQueue.length === 0) {
      this.isPlaying = false;
      if (this._state === "speaking") {
        this.setState("listening");
      }
      return;
    }

    const buffer = this.audioQueue.shift()!;
    const source = this.playbackContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.playbackContext.destination);
    source.onended = () => {
      this.playNext();
    };
    source.start();
  }

  // ──────────────────────────────────────────────
  // Cleanup
  // ──────────────────────────────────────────────

  private cleanupAudio(): void {
    if (this.scriptProcessor) {
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }

    if (this.playbackContext) {
      this.playbackContext.close();
      this.playbackContext = null;
    }
    this.audioQueue = [];
    this.isPlaying = false;
  }
}
