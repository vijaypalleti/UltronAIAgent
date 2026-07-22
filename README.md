# ULTRON AI Agent

An Iron Man–inspired holographic orb built with **Next.js**, **Three.js**, and **MediaPipe** hand tracking — now with an interruption-aware voice agent powered by LLM streaming and Gemini Live API native audio.

![ULTRON orb UI](docs/screenshot.png)

https://github.com/user-attachments/assets/91578a83-9a27-44e8-84b0-96defcfd7366

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Voice agent setup (Classic mode)

The voice agent uses STT → LLM → TTS. It requires a speech-to-text service (Groq Whisper or local whisper.cpp) and a TTS service (ElevenLabs or browser built-in).

1. **LLM backend** — one of:
   - **Groq** (online, fast): set `GROQ_API_KEY` in `.env.local`
   - **Local llama-server** (offline): run [llama.cpp](https://github.com/ggerganov/llama.cpp) server on port 8080

2. **TTS** — one of:
   - **ElevenLabs**: set `ELEVENLABS_API_KEY` in `.env.local` (female voice "Rachel" by default)
   - **Browser TTS**: automatic fallback, no setup needed

### Nova mode setup (Gemini Live API)

Nova uses Gemini's native audio-to-audio model — no separate STT/TTS needed. Requires Python 3.10+.

```bash
pip install -r requirements-gemini.txt
cp nova/.env.template nova/.env
# Edit nova/.env and set GEMINI_API_KEY
python nova/relay.py
```

Or let the UI auto-launch the relay when you click **VOICE OFF** (or press `V`).

## Controls

### Mouse / touch

| Input | Action |
| --- | --- |
| Drag | Spin the orb |
| Scroll / pinch | Zoom in & out |

### Hand gestures (webcam)

Click **GESTURES OFF** (or press `G`) and allow camera access, then:

| Gesture | Action |
| --- | --- |
| Pinch (thumb + index) one hand and move it | Spin the orb |
| Pinch with **both** hands, spread apart / bring together | Zoom in / out |

### Keyboard

| Key | Action |
| --- | --- |
| `G` | Toggle hand gestures |
| `R` | Reset the view |
| `+` / `−` | Zoom in / out |
| `V` | Toggle voice (Classic or Nova mode) |
| `N` | Switch between Classic ↔ Nova voice mode |
| `M` | Toggle mic mute during voice session |
| `S` | Toggle sound effects |

## Voice modes

### Classic mode (STT → LLM → TTS)

The default voice pipeline. Click **VOICE OFF** (or press `V`) to start.

1. **Listen** — browser captures mic audio, sends to Groq Whisper (or local whisper.cpp) for speech-to-text
2. **Think** — transcribed text is streamed to the LLM (Groq or local llama-server) via SSE; tokens appear as the orb "thinks"
3. **Speak** — LLM response is chunked into sentences and sent to ElevenLabs TTS (or browser fallback); audio plays through the speakers

**Interruption / barge-in**: If you speak while Nova is talking, the system:
- Aborts the current TTS playback immediately
- Sends accumulated context (what was already spoken + pending text) to the LLM for a follow-up
- Resumes listening for your next input

### Nova mode (Gemini Live API)

Click **VOICE OFF** (or press `V`), then press `N` to switch to Nova mode.

Nova bypasses the STT → LLM → TTS pipeline entirely. The Gemini Live API handles voice activity detection, speech recognition, reasoning, and speech synthesis in a single model call.

**Architecture**:
```
Browser (Web Audio API) ←→ WebSocket ←→ nova/relay.py ←→ Gemini Live API
```

- **Browser captures** 16kHz mono PCM from the mic, sends raw chunks over WebSocket
- **Python relay** forwards audio to Gemini Live API and streams responses back
- **Gemini responds** with 24kHz audio chunks and text transcripts
- **Browser plays** audio via Web Audio API with a 200ms buffer

**Session resilience**: The relay maintains a persistent browser WebSocket while creating fresh Gemini sessions per turn. When a Gemini session ends (after `turn_complete`), the relay automatically reconnects a new session — multi-turn conversations work seamlessly.

## Architecture

### Project structure

```
ultron-ai-agent/
├── app/                            Next.js App Router (pages + API routes)
│   ├── page.tsx                    Main page
│   ├── layout.tsx                  Root layout
│   ├── globals.css                 Global styles
│   └── api/
│       ├── chat/
│       │   ├── route.ts            Non-streaming LLM endpoint
│       │   └── stream/route.ts     SSE streaming LLM endpoint
│       ├── tts/route.ts            ElevenLabs TTS endpoint
│       └── nova/route.ts           Relay status + auto-launch endpoint
│
├── components/                     React components
│   └── JarvisOrb.tsx               Main HUD — orb, voice modes, transcript overlay
│
├── lib/                            Client-side libraries (grouped by concern)
│   ├── orb/                        Orb rendering
│   │   ├── orbScene.ts             Three.js scene — shells, scan rings, bloom
│   │   └── handTracker.ts          MediaPipe hand tracking — pinch-to-spin/zoom
│   ├── voice/                      Voice pipeline
│   │   ├── interruptionEngine.ts   Spoken/pending text tracking, interruption context
│   │   ├── streamingChat.ts        SSE client for streaming LLM tokens
│   │   ├── streamingTts.ts         Chunked TTS with sentence splitting
│   │   └── novaClient.ts           Browser ↔ relay WebSocket — audio capture, playback
│   └── core/                       Shared utilities
│       └── localLlmServer.ts       Local llama-server process manager
│
├── nova/                           Python relay (separate runtime)
│   ├── relay.py                    WebSocket relay — browser ↔ Gemini Live API
│   ├── .env                        API key config (git-ignored)
│   └── .env.template               Template for .env
│
├── requirements-gemini.txt         Python dependencies for nova relay
├── .env.local                      Next.js environment variables
└── package.json                    Node.js dependencies
```

### Key files

| Layer | File | Purpose |
| --- | --- | --- |
| **UI** | `components/JarvisOrb.tsx` | Main HUD — orb, voice modes, transcript overlay |
| **UI** | `lib/orb/orbScene.ts` | Three.js scene — wireframe shells, scan rings, bloom post-processing |
| **UI** | `lib/orb/handTracker.ts` | MediaPipe hand tracking — pinch-to-spin, pinch-to-zoom |
| **Voice** | `lib/voice/interruptionEngine.ts` | Tracks spoken/pending text, builds interruption context for LLM |
| **Voice** | `lib/voice/streamingChat.ts` | Client-side SSE handler for streaming LLM tokens |
| **Voice** | `lib/voice/streamingTts.ts` | Chunked TTS with sentence splitting, interruption support |
| **Voice** | `lib/voice/novaClient.ts` | Browser ↔ relay WebSocket — audio capture, playback, auto-reconnect |
| **API** | `app/api/chat/stream/route.ts` | SSE streaming LLM endpoint (Groq / local) |
| **API** | `app/api/tts/route.ts` | ElevenLabs TTS endpoint |
| **API** | `app/api/nova/route.ts` | Relay status check + auto-launch endpoint |
| **Backend** | `lib/core/localLlmServer.ts` | Local llama-server process management |
| **Backend** | `nova/relay.py` | Python WebSocket relay — bridges browser to Gemini Live API |

### Voice pipeline (Classic mode)

```
Mic → ScriptProcessorNode (16kHz PCM)
  → WebSocket → /api/chat/stream (SSE)
  → LLM tokens streamed back → HUD
  → Sentence chunks → /api/tts (ElevenLabs)
  → Audio chunks → AudioContext playback
```

### Nova pipeline

```
Mic → ScriptProcessorNode (16kHz PCM)
  → WebSocket → nova/relay.py → Gemini Live API
  ← 24kHz PCM audio + transcripts ← WebSocket
  ← AudioContext playback
```

### Interruption handling

The interruption engine (`lib/voice/interruptionEngine.ts`) maintains a log of what has been spoken and what's still pending. When the user interrupts:

1. TTS playback is aborted immediately
2. The spoken + pending text is packaged as context
3. A follow-up prompt is sent to the LLM: *"The user interrupted. Here's what was said and what was pending…"*
4. The LLM generates a contextual response

## Configuration

### Environment variables (`.env.local`)

| Variable | Required | Description |
| --- | --- | --- |
| `GROQ_API_KEY` | Classic mode | Groq API key for STT + LLM |
| `ELEVENLABS_API_KEY` | Classic mode (optional) | ElevenLabs TTS key; falls back to browser TTS |
| `GEMINI_API_KEY` | Nova mode | Google AI Studio key for Gemini Live API |

### Nova environment (`nova/.env`)

| Variable | Required | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | Yes | Google AI Studio key |
| `RELAY_HOST` | No | Relay host (default: `127.0.0.1`) |
| `RELAY_PORT` | No | Relay port (default: `8765`) |

## License

MIT
