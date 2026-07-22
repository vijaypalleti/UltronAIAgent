"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createOrbScene, type OrbSceneApi } from "@/lib/orb/orbScene";
import { HandTracker, type TrackerStatus } from "@/lib/orb/handTracker";
import { InterruptionEngine } from "@/lib/voice/interruptionEngine";
import { StreamingChat, type ChatMessage } from "@/lib/voice/streamingChat";
import { StreamingTts } from "@/lib/voice/streamingTts";
import { NovaClient, type NovaState } from "@/lib/voice/novaClient";

type CameraState = "off" | "starting" | "on" | "error";
type VoiceState = "standby" | "listening" | "thinking" | "speaking" | "adjusting";
type VoiceMode = "classic" | "nova";

const MODE_LABEL: Record<TrackerStatus["mode"], string> = {
  idle: "STANDBY",
  spin: "SPIN",
  zoom: "ZOOM",
};

const SpeechRecognitionAPI =
  typeof window !== "undefined"
    ? ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)
    : null;

function playChime() {
  try {
    const AudioContextAPI = (window.AudioContext || (window as any).webkitAudioContext);
    if (!AudioContextAPI) return;
    const ctx = new AudioContextAPI();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = "sine";
    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.setValueAtTime(784, now + 0.1);

    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    osc.start(now);
    osc.stop(now + 0.35);
  } catch (err) {
    console.error("Audio chime failed:", err);
  }
}

function playInterruptionChime() {
  try {
    const AudioContextAPI = (window.AudioContext || (window as any).webkitAudioContext);
    if (!AudioContextAPI) return;
    const ctx = new AudioContextAPI();

    // Quick descending tone — indicates interruption accepted
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = "sine";
    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(660, now);
    osc.frequency.exponentialRampToValueAtTime(330, now + 0.2);

    gain.gain.setValueAtTime(0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

    osc.start(now);
    osc.stop(now + 0.25);
  } catch (err) {
    console.error("Interruption chime failed:", err);
  }
}

export default function JarvisOrb() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OrbSceneApi | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);

  const [camera, setCamera] = useState<CameraState>("off");
  const [status, setStatus] = useState<TrackerStatus>({ hands: 0, mode: "idle" });
  const [error, setError] = useState<string | null>(null);

  // ——— VOICE ASSISTANT STATES ———
  const [voiceState, setVoiceState] = useState<VoiceState>("standby");
  const [voiceAssistantActive, setVoiceAssistantActive] = useState(true);
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);
  const [activeQuery, setActiveQuery] = useState<string | null>(null);
  const [activeResponse, setActiveResponse] = useState<string | null>(null);
  const [streamingResponse, setStreamingResponse] = useState<string>("");
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [showConsole, setShowConsole] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [llmMode, setLlmMode] = useState<"online" | "offline">("online");
  const [interruptionCount, setInterruptionCount] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);

  // ——— NOVA (Gemini Live) states ———
  const [voiceMode, setVoiceMode] = useState<VoiceMode>("classic");
  const [novaConversation, setNovaConversation] = useState<{role: "user"|"nova"; text: string}[]>([]);
  const [novaLiveInput, setNovaLiveInput] = useState<string>("");    // live: what user is saying right now
  const [novaLiveOutput, setNovaLiveOutput] = useState<string>("");  // live: what Nova is saying right now
  const novaClientRef = useRef<NovaClient | null>(null);

  // Refs for engines / recognition
  const recognitionRef = useRef<any>(null);
  const isSpeakingRef = useRef(false);
  const isAwaitingQueryRef = useRef(false);
  const interruptionInProgressRef = useRef(false); // guard against double-trigger
  const [liveTranscript, setLiveTranscript] = useState<string | null>(null);

  // Refs for interruption-aware engines (stable across renders)
  const engineRef = useRef<InterruptionEngine | null>(null);
  const chatRef = useRef<StreamingChat | null>(null);
  const ttsRef = useRef<StreamingTts | null>(null);

  // A ref to hold the latest voiceState value for use in closures
  const voiceStateRef = useRef<VoiceState>("standby");
  voiceStateRef.current = voiceState;

  // A ref to hold the latest active assistant state
  const voiceAssistantActiveRef = useRef(true);
  voiceAssistantActiveRef.current = voiceAssistantActive;

  // Logging helper
  const log = useCallback((msg: string) => {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    console.log(`[ULTRON ${time}] ${msg}`);
    setTerminalLogs((prev) => [...prev.slice(-30), `[${time}] ${msg}`]);
  }, []);

  // Sync state transitions to the 3D Orb Scene
  useEffect(() => {
    if (sceneRef.current) {
      sceneRef.current.setOrbMode(voiceState);
    }
  }, [voiceState]);

  // Initial Scene setup
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scene = createOrbScene(container);
    sceneRef.current = scene;

    log("ULTRON COGNITIVE CORE ONLINE.");
    log("AWAITING VOCAL PROTOCOLS...");

    // Initialize interruption-aware engines
    engineRef.current = new InterruptionEngine();
    chatRef.current = new StreamingChat();
    ttsRef.current = new StreamingTts();

    return () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
      chatRef.current?.abort();
      scene.dispose();
      sceneRef.current = null;
      engineRef.current = null;
      chatRef.current = null;
      ttsRef.current = null;
    };
  }, [log]);

  // Start continuous listening loop
  const startListening = useCallback(() => {
    if (!recognitionRef.current || isSpeakingRef.current || !voiceAssistantActiveRef.current) return;
    try {
      recognitionRef.current.start();
    } catch (e) {
      // Already running
    }
  }, []);

  // Set up TTS callbacks
  useEffect(() => {
    const tts = ttsRef.current;
    if (!tts) return;
    tts.setCallbacks({
      onDone: () => {
        isSpeakingRef.current = false;
        setVoiceState("standby");
        if (voiceAssistantActiveRef.current) startListening();
      },
      onChunkStart: (chunk) => {
        log(`VOCALIZING: "${chunk.slice(0, 60)}..."`);
      },
      onFallback: (chunk) => {
        log(`TTS API UNAVAILABLE — USING LOCAL VOCAL SYNTHESIS.`);
      },
    });
  }, [log, startListening]);

  // ——— NOVA (Gemini Live) lifecycle ———
  const novaLiveInputRef = useRef("");
  const novaLiveOutputRef = useRef("");
  const novaPrevStateRef = useRef<string>("");

  useEffect(() => {
    novaLiveInputRef.current = "";
    novaLiveOutputRef.current = "";
    novaPrevStateRef.current = "";

    if (voiceMode === "classic") {
      // Stop Nova if it was running
      novaClientRef.current?.stop();
      novaClientRef.current = null;
      // Restore classic voice assistant
      setVoiceAssistantActive(true);
      return;
    }

    // Stop classic voice assistant before starting Nova
    setVoiceAssistantActive(false);

    // Start Nova
    const nova = new NovaClient();
    novaClientRef.current = nova;

    nova.setCallbacks({
      onStateChange: (novaState) => {
        const prevState = novaPrevStateRef.current;
        novaPrevStateRef.current = novaState;

        // Map Nova states → orb voice states
        switch (novaState) {
          case "listening":
            setVoiceState("listening");
            // If we were speaking (Nova was responding), commit the output to conversation
            if (prevState === "speaking" && novaLiveOutputRef.current.trim()) {
              const text = novaLiveOutputRef.current.trim();
              setNovaConversation((prev) => [...prev.slice(-20), { role: "nova", text }]);
              novaLiveOutputRef.current = "";
              setNovaLiveOutput("");
            }
            break;
          case "speaking":
            setVoiceState("speaking");
            // If we were listening (user was speaking), commit the input to conversation
            if (novaLiveInputRef.current.trim()) {
              const text = novaLiveInputRef.current.trim();
              setNovaConversation((prev) => [...prev.slice(-20), { role: "user", text }]);
              novaLiveInputRef.current = "";
              setNovaLiveInput("");
            }
            break;
          case "thinking":
            setVoiceState("thinking");
            break;
          case "connecting":
            setVoiceState("thinking");
            break;
          case "disconnected":
            setVoiceState("standby");
            break;
        }
      },
      onInputTranscript: (text) => {
        // Live update — replace, don't append
        novaLiveInputRef.current = text;
        setNovaLiveInput(text);
      },
      onOutputTranscript: (text) => {
        // Live update — replace, don't append
        novaLiveOutputRef.current = text;
        setNovaLiveOutput(text);
      },
      onError: (error) => {
        log(`NOVA ERROR: ${error}`);
        setVoiceMode("classic");
      },
    });

    nova.start().catch((err) => {
      log(`NOVA LAUNCH FAILED: ${err}`);
      setVoiceMode("classic");
    });

    return () => {
      nova.stop();
      novaClientRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceMode]);

  /**
   * it's automatically injected as a system prompt override.
   */
  const submitStreamingQuery = useCallback(async (query: string) => {
    if (!query.trim()) return;
    const chat = chatRef.current;
    if (!chat) return;

    setVoiceState("thinking");
    setActiveQuery(query);
    setActiveResponse(null);
    setStreamingResponse("");
    setSearchResults(null);
    setShowConsole(true);

    const engine = engineRef.current;
    const isInterrupted = engine ? engine.interruptionCount > 0 : false;

    log(isInterrupted
      ? `INTERRUPTION PROCESSED — NEW DIRECTIVE: "${query}"`
      : `SUBMITTING DIRECTIVE: "${query}"`);

    const updatedMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: query },
    ];
    setMessages(updatedMessages);

    let fullResponse = "";
    setIsStreaming(true);

    // Build system override with interruption context if applicable
    const BASE_PROMPT = "You are Ultron, a highly advanced, sophisticated, and articulate holographic AI system. You speak in a commanding, slightly futuristic, yet helpful manner, similar to an intelligent movie AI. Keep your vocal responses extremely concise — at most 2-3 sentences, direct answers, no fluff. Never begin with a preamble like 'Ah' or 'Of course'. Just answer directly and briefly so the response sounds natural when spoken aloud.";

    let systemOverride: string | undefined;
    if (isInterrupted && engine) {
      systemOverride = engine.buildContextualSystemPrompt(BASE_PROMPT, query);
    }

    chat.setCallbacks({
      onToken: (token: string) => {
        fullResponse += token;
        setStreamingResponse(fullResponse);

        // Track accumulation in the interruption engine
        engineRef.current?.accumulate(token);
      },
      onDone: (text, meta) => {
        setIsStreaming(false);
        setActiveResponse(text);
        setStreamingResponse("");

        if (meta.searchResults) {
          setSearchResults(meta.searchResults);
        }

        setMessages((prev) => [...prev, { role: "assistant", content: text }]);
        log(`RESPONSE READY (${text.length} chars). INITIALIZING VOCAL OUTPUT...`);

        // Speak the full response
        const tts = ttsRef.current;
        if (tts) {
          isSpeakingRef.current = true;
          setVoiceState("speaking");
          tts.speak(text);
        } else {
          isSpeakingRef.current = false;
          setVoiceState("standby");
        }
      },
      onError: (errorMsg) => {
        setIsStreaming(false);
        log(`GRID ERROR: ${errorMsg}`);
        setVoiceState("standby");
        const tts = ttsRef.current;
        if (tts) {
          isSpeakingRef.current = true;
          setVoiceState("speaking");
          tts.speak("System error. Connection to the network was interrupted.");
        }
      },
    });

    try {
      await chat.streamQuery(updatedMessages, llmMode, systemOverride);
    } catch (err) {
      setIsStreaming(false);
      log(`GRID FAIL: ${err}`);
      setVoiceState("standby");
    }
  }, [messages, log, llmMode]);

  // Speech Recognition results processor — now interruption-aware
  const handleSpeechResult = useCallback((event: any) => {
    if (isSpeakingRef.current) {
      // Even while speaking, process results — this is the key to interruption!
    }

    let finalTranscript = "";
    let interimTranscript = "";

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += transcript;
      } else {
        interimTranscript += transcript;
      }
    }

    const currentTranscript = (finalTranscript || interimTranscript).toLowerCase().trim();
    if (!currentTranscript) return;

    const wakeWord = "ultron";
    if (currentTranscript.includes(wakeWord)) {
      // ——— INTERRUPTION DETECTED (if currently speaking) ———
      if (isSpeakingRef.current && !interruptionInProgressRef.current) {
        // Set guard immediately to prevent re-entry from interim results
        interruptionInProgressRef.current = true;

        const tts = ttsRef.current;
        const engine = engineRef.current;

        // 1. Capture what was already spoken
        const spokenText = tts?.interrupt() || "";
        const pendingText = tts?.getFullText().slice(spokenText.length) || "";
        const fullAccumulated = engine?.getFullAccumulated() || "";

        // 2. Stop all audio
        window.speechSynthesis.cancel();

        log(`⛔ INTERRUPTION DETECTED. Spoken: "${spokenText.slice(-80)}..."`);

        // 3. Play interruption chime
        playInterruptionChime();

        // 4. Extract the interruption query (text after wake word)
        const idx = currentTranscript.indexOf(wakeWord);
        const afterWake = currentTranscript.slice(idx + wakeWord.length).trim().replace(/^[,\s\.\?!]+/, '');

        // Accept interruption on ANY final result, or on interim if > 3 chars
        const interruptionQuery = afterWake.length > 2 ? afterWake : "";

        if (interruptionQuery && (finalTranscript || interimTranscript.length > 3)) {
          // 5. Record the interruption in the engine (this stores what was said,
          //    what was pending, and the interruption query for LLM context)
          if (engine) {
            engine.recordInterruption(interruptionQuery);
          }

          setInterruptionCount((prev) => prev + 1);
          log(`INTERRUPTION QUERY: "${interruptionQuery}" (interruption #${interruptionCount + 1})`);

          // 6. Update state
          isSpeakingRef.current = false;
          setVoiceState("adjusting");

          // 7. Submit new query — the engine's interruption context is automatically
          //    injected as a system prompt override inside submitStreamingQuery
          setTimeout(() => {
            interruptionInProgressRef.current = false;
            submitStreamingQuery(interruptionQuery);
          }, 400);
        } else if (finalTranscript) {
          // Just "ultron" — switch to listening mode
          interruptionInProgressRef.current = false;
          isSpeakingRef.current = false;
          setVoiceState("listening");
          isAwaitingQueryRef.current = true;
          playChime();
          log("WAKE WORD CONFIRMED. AWAITING VOCAL INPUT...");
          setShowConsole(true);
        }
        return;
      }

      // ——— NOT SPEAKING — normal wake word handling ———
      if (isSpeakingRef.current) return;

      const idx = currentTranscript.indexOf(wakeWord);
      const afterWake = currentTranscript.slice(idx + wakeWord.length).trim().replace(/^[,\s\.\?!]+/, '');
      setLiveTranscript(afterWake || null);
      console.log(`[ULTRON] 🟢 Wake word detected! afterWake="${afterWake}" isFinal=${!!finalTranscript}`);

      if (afterWake.length > 2 && finalTranscript) {
        setLiveTranscript(null);
        log(`WAKE PATTERN CONFIRMED: "${afterWake}"`);
        submitStreamingQuery(afterWake);
      } else if (afterWake.length <= 2 && finalTranscript) {
        playChime();
        log("WAKE WORD CONFIRMED. AWAITING VOCAL INPUT...");
        setVoiceState("listening");
        isAwaitingQueryRef.current = true;
        setShowConsole(true);
      }
    } else if (isAwaitingQueryRef.current) {
      setLiveTranscript(currentTranscript);
      if (finalTranscript) {
        const queryText = finalTranscript.trim();
        if (queryText.length > 1) {
          isAwaitingQueryRef.current = false;
          setLiveTranscript(null);
          log(`INSTRUCTION CAPTURED: "${queryText}"`);
          submitStreamingQuery(queryText);
        }
      }
    } else {
      console.log(`[ULTRON] 💤 No wake word — transcript: "${currentTranscript}"`);
    }
  }, [submitStreamingQuery, log, interruptionCount]);

  // Speech Recognition hook with watchdog to keep mic alive during TTS playback
  useEffect(() => {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.getVoices();
    }

    if (!SpeechRecognitionAPI) {
      log("VOCAL DECODER OFFLINE. USE TERMINAL FORM.");
      return;
    }

    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    let watchdogTimer: ReturnType<typeof setInterval> | null = null;

    recognition.onstart = () => {
      log("VOCAL SENSOR ENGAGED.");
    };

    recognition.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const transcript = event.results[i][0].transcript;
        const confidence = (event.results[i][0].confidence * 100).toFixed(1);
        const type = event.results[i].isFinal ? "FINAL" : "interim";
        console.log(`[ULTRON] 🗣️ [${type}] "${transcript}" (confidence: ${confidence}%)`);
      }
      handleSpeechResult(event);
    };

    recognition.onerror = (event: any) => {
      if (event.error === "not-allowed") {
        log("VOCAL SENSOR BLOCKED: MIC PERMISSION DENIED.");
        setVoiceAssistantActive(false);
      } else if (event.error === "aborted") {
        // Expected during normal stop/restart cycles — ignore
      } else if (event.error !== "no-speech") {
        console.error("[ULTRON] ❌ Speech error:", event.error);
        log(`CORE WARNING: Speech decode error [${event.error}]`);
      }
    };

    recognition.onend = () => {
      // Always restart — we need to hear interruptions even during speech
      if (voiceAssistantActiveRef.current) {
        try { recognition.start(); } catch (e) { }
      }
    };

    recognitionRef.current = recognition;

    if (voiceAssistantActive) {
      try { recognition.start(); } catch (e) { }
    }

    // Watchdog: every 5 seconds, try starting recognition.
    // If it's already running, start() throws — caught silently.
    // If it died (e.g. from audio focus loss during TTS), this revives it.
    watchdogTimer = setInterval(() => {
      if (!voiceAssistantActiveRef.current) return;
      try {
        recognition.start();
      } catch (e) {
        // Already running — good, no action needed
      }
    }, 5000);

    return () => {
      if (watchdogTimer) clearInterval(watchdogTimer);
      recognition.onresult = null;
      recognition.onend = null;
      recognition.onerror = null;
      try { recognition.stop(); } catch (e) { }
    };
  }, [voiceAssistantActive, handleSpeechResult, log]);

  // Hand gesture camera trigger
  const stopGestures = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    setCamera("off");
    setStatus({ hands: 0, mode: "idle" });
  }, []);

  const startGestures = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || trackerRef.current) return;

    setCamera("starting");
    setError(null);

    const tracker = new HandTracker(video, overlay, {
      onRotate: (dt, dp) => sceneRef.current?.rotateBy(dt, dp),
      onZoom: (factor) => sceneRef.current?.zoomBy(factor),
      onStatus: setStatus,
    });
    trackerRef.current = tracker;

    try {
      await tracker.start();
      setCamera("on");
    } catch (err) {
      trackerRef.current = null;
      tracker.stop();
      setCamera("error");
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "CAMERA ACCESS DENIED"
          : "TRACKING INIT FAILED",
      );
    }
  }, []);

  const toggleGestures = useCallback(() => {
    if (trackerRef.current) stopGestures();
    else void startGestures();
  }, [startGestures, stopGestures]);

  // Keyboard shortcut listener
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      switch (e.key) {
        case "+":
        case "=":
          sceneRef.current?.zoomIn();
          break;
        case "-":
        case "_":
          sceneRef.current?.zoomOut();
          break;
        case "r":
        case "R":
          sceneRef.current?.resetView();
          break;
        case "g":
        case "G":
          toggleGestures();
          break;
        case "v":
        case "V":
          setVoiceAssistantActive((prev) => !prev);
          break;
        case "c":
        case "C":
          setShowConsole((prev) => !prev);
          break;
        case "n":
        case "N":
          setVoiceMode((prev) => (prev === "classic" ? "nova" : "classic"));
          log(`VOICE MODE: ${voiceMode === "classic" ? "NOVA (Gemini Live)" : "CLASSIC"}`);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleGestures]);

  const cameraOn = camera === "on";

  // Interruption count label for display
  const interruptionLabel = interruptionCount > 0
    ? `INTERRUPTIONS: ${interruptionCount}`
    : null;

  return (
    <>
      <div ref={containerRef} className="orb-root" />

      <div className="overlay-vignette" />
      <div className="overlay-grain" />
      <div className="overlay-scanlines" />

      {/* Holographic Header */}
      <div className="hud hud-title">U.L.T.R.O.N.</div>

      {/* AI Voice State HUD */}
      <div className="hud-voice-indicator">
        <span className={`voice-glow-dot ${voiceState}`} />
        <span className="voice-state-text">
          {voiceMode === "nova" ? "NOVA" : "CORE"}: {voiceState.toUpperCase()}
          {voiceMode === "nova" && <span className="mode-badge-nova"> · LIVE</span>}
          {interruptionLabel && voiceMode === "classic" && (
            <span className="interruption-badge"> · {interruptionLabel}</span>
          )}
        </span>
      </div>

      {/* Nova live transcript — always visible when Nova is active */}
      {voiceMode === "nova" && (
        <div className="hud-nova-transcript">
          {/* Always-visible status indicator */}
          {!novaLiveInput && !novaLiveOutput && novaConversation.length === 0 && (
            <div className="hud-nova-line hud-nova-status">
              <span className="hud-nova-live-dot" />
              <span className="hud-nova-role">NOVA</span>
              Listening... just speak
            </div>
          )}

          {/* History — last few completed turns */}
          {novaConversation.slice(-3).map((entry, i) => (
            <div key={i} className={`hud-nova-line hud-nova-history hud-nova-${entry.role}`}>
              <span className="hud-nova-role">{entry.role === "user" ? "YOU" : "NOVA"}</span>
              {entry.text}
            </div>
          ))}

          {/* Live input — what user is saying right now */}
          {novaLiveInput && (
            <div className="hud-nova-line hud-nova-live-input">
              <span className="hud-nova-live-dot" />
              <span className="hud-nova-role">YOU</span>
              {novaLiveInput}
            </div>
          )}

          {/* Live output — what Nova is saying right now */}
          {novaLiveOutput && (
            <div className="hud-nova-line hud-nova-live-output">
              <span className="hud-nova-live-dot" />
              <span className="hud-nova-role">NOVA</span>
              {novaLiveOutput}
              <span className="hud-nova-cursor" />
            </div>
          )}
        </div>
      )}

      {/* Futuristic Console Popup */}
      {showConsole && (
        <div className="hud-console">
          <div className="console-header">
            <span className="console-title">SYS INTERACTION MATRIX</span>
            <button
              type="button"
              className="console-close"
              onClick={() => setShowConsole(false)}
            >
              [X]
            </button>
          </div>

          <div className="console-logs-container">
            {terminalLogs.slice(-5).map((l, i) => (
              <div key={i} className="console-log-row">{l}</div>
            ))}
          </div>

          <div className="console-display">
            {activeQuery && (
              <div className="display-query-section">
                <span className="matrix-prefix">SYS_DIR:</span> {activeQuery}
              </div>
            )}

            {voiceState === "thinking" && isStreaming && (
              <div className="display-thinking-section">
                <span className="matrix-spinner" />
                RETRIEVING RESPONSES FROM THE GRID...
              </div>
            )}

            {voiceState === "adjusting" && (
              <div className="display-adjusting-section">
                <span className="adjusting-spinner" />
                RE-ROUTING THROUGH INTERRUPTION MATRIX...
              </div>
            )}

            {/* Streaming response (progressive tokens) */}
            {isStreaming && streamingResponse && (
              <div className="display-streaming-section">
                <span className="matrix-prefix">ULTRON (live):</span>
                <span className="streaming-text">{streamingResponse}</span>
                <span className="streaming-cursor" />
              </div>
            )}

            {activeResponse && !isStreaming && (
              <div className="display-response-section">
                <span className="matrix-prefix">ULTRON:</span> {activeResponse}
              </div>
            )}

            {/* Nova live transcript */}
            {voiceMode === "nova" && novaConversation.length > 0 && (
              <div className="display-nova-section">
                <div className="nova-header-line">NOVA LIVE TRANSCRIPT:</div>
                {novaConversation.slice(-5).map((entry, i) => (
                  <div key={i} className={`nova-transcript-row nova-transcript-${entry.role}`}>
                    <span className="nova-prefix">{entry.role === "user" ? "▸" : "◂"}</span>
                    <span className="nova-role-tag">{entry.role === "user" ? "YOU:" : "NOVA:"}</span> {entry.text}
                  </div>
                ))}
              </div>
            )}

            {searchResults && searchResults.length > 0 && (
              <div className="display-search-section">
                <div className="search-header-line">SEARCH GRAPH ENTRIES CONNECTED:</div>
                <div className="search-results-list">
                  {searchResults.map((res, i) => (
                    <div key={i} className="search-result-node">
                      <div className="node-top-bar">
                        <span className="node-title">{res.title}</span>
                        <span className="node-domain">{new URL(res.url).hostname}</span>
                      </div>
                      <p className="node-snippet">{res.content}</p>
                      <a
                        href={res.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="node-link"
                      >
                        [OPEN MEMORY LINK]
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              const inputEl = e.currentTarget.elements.namedItem("cmdInput") as HTMLInputElement;
              if (inputEl.value.trim()) {
                submitStreamingQuery(inputEl.value.trim());
                inputEl.value = "";
              }
            }}
            className="console-cmd-form"
          >
            <span className="form-prompt">&gt;</span>
            <input
              name="cmdInput"
              type="text"
              placeholder="ENTER SYSTEM DIRECTIVE..."
              className="console-cmd-input"
              autoComplete="off"
            />
            <button type="submit" className="console-cmd-btn">EXECUTE</button>
          </form>
        </div>
      )}

      {/* Classic live mic transcript — shown when NOT in Nova mode */}
      {voiceMode === "classic" && voiceAssistantActive && liveTranscript && (
        <div className="hud-live-transcript">
          <span className="live-mic-dot" />
          {`"${liveTranscript}"`}
        </div>
      )}

      {/* HUD Keyboard/Control Hints */}
      <div className="hud hud-hint">
        <div>
          <span className="key">DRAG</span> spin&nbsp;&nbsp;
          <span className="key">SCROLL</span> zoom
        </div>
        <div>
          <span className="key">G</span> camera gestures&nbsp;&nbsp;
          <span className="key">V</span> mic toggle&nbsp;&nbsp;
          <span className="key">C</span> console panel&nbsp;&nbsp;
          <span className="key">N</span> Nova mode
        </div>
        {voiceMode === "nova" ? (
          <div className="mic-listening-msg" style={{color: "#44ff88"}}>
            NOVA LIVE — just speak, no wake word needed
          </div>
        ) : voiceAssistantActive ? (
          <div className="mic-listening-msg">
            VOCAL TRIGGER WORD: <span className="highlight">"ULTRON"</span>
            {interruptionCount > 0 && (
              <span className="interruption-hint">
                &nbsp;· {interruptionCount} interruption{interruptionCount > 1 ? 's' : ''} handled
              </span>
            )}
          </div>
        ) : (
          <div className="mic-disabled-msg">VOCAL TRANSCEIVER OFFLINE</div>
        )}
      </div>

      {/* Control Buttons Grid */}
      <div className="hud hud-controls">
        <div className={`camera-panel${cameraOn ? " visible" : ""}`}>
          <video ref={videoRef} muted playsInline className="camera-video" />
          <canvas ref={overlayRef} width={208} height={156} className="camera-overlay" />
          <div className="camera-status">
            {status.hands > 0
              ? `${status.hands} HAND${status.hands > 1 ? "S" : ""} · ${MODE_LABEL[status.mode]}`
              : "SHOW HANDS"}
          </div>
        </div>

        {error && <div className="hud-error">{error}</div>}

        <div className="hud-row">
          <button
            type="button"
            className="hud-btn"
            onClick={() => {
              const next = voiceMode === "classic" ? "nova" : "classic";
              setVoiceMode(next);
              log(`VOICE MODE: ${next === "nova" ? "NOVA (Gemini Live)" : "CLASSIC"}`);
            }}
            aria-pressed={voiceMode === "nova"}
          >
            {voiceMode === "nova" ? "NOVA" : "CLASSIC"}
          </button>

          <button
            type="button"
            className="hud-btn"
            aria-pressed={llmMode === "offline"}
            onClick={() => {
              const next = llmMode === "online" ? "offline" : "online";
              setLlmMode(next);
              log(`LLM MODE: ${next.toUpperCase()}`);
            }}
            disabled={voiceMode === "nova"}
          >
            {llmMode === "online" ? "ONLINE" : "LOCAL"}
          </button>
        </div>

        <div className="hud-row">
          <button
            type="button"
            className="hud-btn"
            aria-pressed={voiceAssistantActive}
            disabled={voiceMode === "nova"}
            onClick={() => {
              setVoiceAssistantActive((prev) => !prev);
              log(`VOCAL INTERCEPTOR: ${!voiceAssistantActive ? "ONLINE" : "STANDBY"}`);
            }}
          >
            {voiceAssistantActive ? "VOICE ON" : "VOICE OFF"}
          </button>

          <button
            type="button"
            className="hud-btn"
            aria-pressed={showConsole}
            onClick={() => setShowConsole((prev) => !prev)}
          >
            CONSOLE
          </button>
        </div>

        <div className="hud-row">
          <button
            type="button"
            className="hud-btn"
            aria-pressed={cameraOn}
            onClick={toggleGestures}
            disabled={camera === "starting"}
          >
            {camera === "starting" ? "INITIALIZING…" : cameraOn ? "GESTURES ON" : "GESTURES OFF"}
          </button>
        </div>

        <div className="hud-row">
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomIn()} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomOut()} aria-label="Zoom out">
            −
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.resetView()}>
            RESET
          </button>
        </div>
      </div>
    </>
  );
}
