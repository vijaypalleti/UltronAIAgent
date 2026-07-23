# ULTRON AI Agent

An Iron Man–inspired holographic orb AI assistant built with **Next.js**, **Three.js**, and **MediaPipe** hand tracking — featuring two voice modes: a Classic STT → LLM → TTS pipeline powered by **Groq** + **ElevenLabs**, and a native audio-to-audio **Nova mode** powered by the **Gemini Live API**.

![ULTRON orb UI](docs/screenshot.png)

---

## Features

- Holographic 3D orb with layered wireframe shells, scan rings, orbiting debris, dust particles, and bloom post-processing
- Two voice modes: Classic (Groq + ElevenLabs) and Nova (Gemini Live API)
- Real-time web search via **Tavily** — automatically triggered for news, weather, and current events
- Interruption / barge-in support — speak while the orb is talking to redirect it mid-sentence
- Hand gesture control via webcam using **MediaPipe** HandLandmarker
- Local LLM fallback via **llama.cpp** server (offline mode)
- Orb color and animation speed shift dynamically based on voice state (standby, listening, thinking, speaking, adjusting)

---

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Voice Modes

### Classic Mode (STT → LLM → TTS)

The default pipeline. Uses Groq for speech-to-text and LLM inference, and ElevenLabs for text-to-speech.

**Pipeline:**
```
Mic → Browser SpeechRecognition
  → Wake word "ULTRON" detected
  → Groq LLM (llama-3.1-8b-instant) via SSE streaming
  → Tokens streamed to HUD in real time
  → Sentence chunks → ElevenLabs TTS (or browser fallback)
  → Audio playback via AudioContext
```

**Web search:** If your query contains keywords like "weather", "news", "today", "latest", "price", etc., Tavily is called automatically and results are injected into the LLM context before responding.

**Interruption / barge-in:** Say "Ultron" while the orb is speaking to interrupt it mid-sentence. The system:
1. Stops TTS playback immediately and plays a descending chime
2. Captures what was already spoken and what was still pending
3. Records the interruption context via `InterruptionEngine`
4. Submits your new query with full context so the LLM responds coherently

**Offline fallback:** If Groq is unavailable, the system automatically falls back to a local llama.cpp server.

---

### Nova Mode (Gemini Live API)

Nova bypasses the STT → LLM → TTS pipeline entirely. The Gemini Live API handles voice activity detection, speech recognition, reasoning, and speech synthesis in a single native audio model call.

**Pipeline:**
```
Browser (Web Audio API) ←→ WebSocket ←→ nova/relay.py ←→ Gemini Live API
```

- Browser captures 16kHz mono PCM from the mic and sends raw chunks over WebSocket
- Python relay (`nova/relay.py`) forwards audio to Gemini Live API and streams responses back
- Gemini responds with 24kHz audio chunks and text transcripts
- Browser plays audio via Web Audio API with a 200ms buffer

**Key capabilities:**
- No wake word needed — Gemini handles voice activity detection natively
- Native barge-in — speak while Nova is responding and Gemini interrupts itself automatically
- Input and output transcripts are sent back to the HUD in real time
- Session resilience — relay maintains a persistent browser WebSocket while creating fresh Gemini sessions per turn; multi-turn conversations work seamlessly
- Auto-reconnect — up to 3 WebSocket reconnect attempts if the connection drops
- Auto-launch — the UI can spawn `relay.py` automatically if Python and dependencies are installed

**Model:** `gemini-2.5-flash-native-audio-preview-12-2025`  
**Voice:** Aoede (built-in Gemini voice)

---

## Setup

### 1. Install Node dependencies

```bash
npm install
```

### 2. Classic mode setup

Create `.env.local` in the project root:

```env
GROQ_API_KEY=your_groq_api_key
ELEVENLABS_API_KEY=your_elevenlabs_api_key   # optional — falls back to browser TTS
TAVILY_API_KEY=your_tavily_api_key           # optional — enables real-time web search
```

- **Groq API key:** [console.groq.com](https://console.groq.com)
- **ElevenLabs API key:** [elevenlabs.io](https://elevenlabs.io) — if omitted, browser SpeechSynthesis is used
- **Tavily API key:** [tavily.com](https://tavily.com) — if omitted, web search is disabled

### 3. Nova mode setup

Requires Python 3.10+.

```bash
pip install -r requirements-gemini.txt
cp nova/.env.template nova/.env
# Edit nova/.env and set your GEMINI_API_KEY
python nova/relay.py
```

Or let the UI auto-launch the relay when you switch to Nova mode (press `N`).

Get a Gemini API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

### 4. Local LLM setup (optional, offline fallback)

Install [llama.cpp](https://github.com/ggerganov/llama.cpp) and configure in `.env.local`:

```env
LLAMA_SERVER_DIR=C:\llama-b8838-bin-win-cpu-x64
LLAMA_SERVER_BIN=C:\llama-b8838-bin-win-cpu-x64\llama-server.exe
LLAMA_MODEL=LFM2.5-1.2B-Instruct-Q8_0.gguf
LOCAL_LLM_HOST=127.0.0.1
LOCAL_LLM_PORT=8080
```

The server is auto-started on demand when Classic mode falls back to offline.

---

## Controls

### Mouse / Touch

| Input | Action |
| --- | --- |
| Drag | Spin the orb |
| Scroll / pinch | Zoom in & out |

### Hand Gestures (webcam)

Click **GESTURES OFF** (or press `G`) and allow camera access, then:

| Gesture | Action |
| --- | --- |
| Pinch (thumb + index) one hand and move | Spin the orb |
| Pinch with **both** hands, spread apart / bring together | Zoom in / out |

### Keyboard

| Key | Action |
| --- | --- |
| `V` | Toggle voice on / off |
| `N` | Switch between Classic ↔ Nova mode |
| `G` | Toggle hand gestures |
| `R` | Reset the view |
| `+` / `−` | Zoom in / out |
| `C` | Toggle console panel |

### Voice (Classic mode)

Say **"Ultron"** followed by your query:

| Example | Result |
| --- | --- |
| `"Ultron, what's the weather in New York?"` | Triggers web search + response |
| `"Ultron, explain quantum computing"` | Direct LLM response |
| Say `"Ultron"` alone | Switches to listening mode, waits for next utterance |
| Say `"Ultron"` while it's speaking | Interrupts mid-sentence, processes new query |

---

## Orb Visual States

The orb color palette and animation speed change dynamically based on the current voice state:

| State | Color | Description |
| --- | --- | --- |
| `standby` | Amber / orange | Idle, waiting for wake word |
| `listening` | Cyan / blue | Actively listening for input |
| `thinking` | Purple / violet | LLM is generating a response |
| `speaking` | Red / orange-red | TTS is playing audio |
| `adjusting` | Green | Processing an interruption |

---

## Project Structure

```
ultron-ai-agent/
├── app/                            Next.js App Router
│   ├── page.tsx                    Main page (renders JarvisOrb)
│   ├── layout.tsx                  Root layout + metadata
│   ├── globals.css                 Global styles + HUD CSS
│   └── api/
│       ├── chat/
│       │   ├── route.ts            Non-streaming LLM endpoint (Groq + Tavily + local fallback)
│       │   └── stream/route.ts     SSE streaming LLM endpoint
│       ├── tts/route.ts            ElevenLabs TTS endpoint
│       └── nova/route.ts           Relay status check + auto-launch endpoint
│
├── components/
│   └── JarvisOrb.tsx               Main HUD — orb, voice modes, transcript overlay, console
│
├── lib/
│   ├── orb/
│   │   ├── orbScene.ts             Three.js scene — shells, scan rings, debris, bloom
│   │   └── handTracker.ts          MediaPipe HandLandmarker — pinch-to-spin/zoom
│   ├── voice/
│   │   ├── interruptionEngine.ts   Spoken/pending text tracking, interruption context builder
│   │   ├── streamingChat.ts        SSE client for streaming LLM tokens
│   │   ├── streamingTts.ts         Chunked TTS with sentence splitting + interruption support
│   │   └── novaClient.ts           Browser ↔ relay WebSocket — audio capture, playback, reconnect
│   └── core/
│       └── localLlmServer.ts       Local llama-server process manager (auto-start/stop)
│
├── nova/
│   ├── relay.py                    Python WebSocket relay — browser ↔ Gemini Live API
│   ├── .env                        API key config (git-ignored)
│   └── .env.template               Template for .env
│
├── requirements-gemini.txt         Python dependencies for Nova relay
├── .env.local                      Next.js environment variables (git-ignored)
└── package.json
```

---

## Key Files

| Layer | File | Purpose |
| --- | --- | --- |
| UI | `components/JarvisOrb.tsx` | Main HUD — orb, voice modes, transcript overlay, console panel |
| UI | `lib/orb/orbScene.ts` | Three.js scene — wireframe shells, scan rings, bloom post-processing, color palettes per state |
| UI | `lib/orb/handTracker.ts` | MediaPipe HandLandmarker — pinch detection with hysteresis, spin + zoom gestures |
| Voice | `lib/voice/interruptionEngine.ts` | Tracks spoken/pending text, builds interruption preamble for LLM |
| Voice | `lib/voice/streamingChat.ts` | Client-side SSE handler for streaming LLM tokens with abort support |
| Voice | `lib/voice/streamingTts.ts` | Chunked TTS with sentence splitting, ElevenLabs + browser fallback |
| Voice | `lib/voice/novaClient.ts` | Browser ↔ relay WebSocket — 16kHz PCM capture, 24kHz playback, auto-reconnect |
| API | `app/api/chat/route.ts` | Non-streaming LLM endpoint — Groq + Tavily tool use + local fallback |
| API | `app/api/chat/stream/route.ts` | SSE streaming LLM endpoint — Groq streaming + Tavily + local fallback |
| API | `app/api/tts/route.ts` | ElevenLabs TTS proxy (Adam voice, eleven_turbo_v2_5 model) |
| API | `app/api/nova/route.ts` | Relay status check (TCP port probe) + auto-launch via `child_process.spawn` |
| Backend | `lib/core/localLlmServer.ts` | Spawns and manages local llama-server process, polls health endpoint |
| Backend | `nova/relay.py` | Python WebSocket relay — bridges browser PCM audio to Gemini Live API, auto-reconnects sessions |

---

## Environment Variables

### `.env.local` (Next.js)

| Variable | Required | Description |
| --- | --- | --- |
| `GROQ_API_KEY` | Classic mode | Groq API key for LLM inference |
| `ELEVENLABS_API_KEY` | Optional | ElevenLabs TTS key; falls back to browser TTS if omitted |
| `ELEVENLABS_VOICE_ID` | Optional | ElevenLabs voice ID (default: `pNInz6obpgDQGcFmaJgB` — Adam) |
| `TAVILY_API_KEY` | Optional | Tavily web search key; disables search if omitted |
| `LOCAL_LLM_URL` | Optional | Local LLM base URL (default: `http://localhost:8080`) |
| `LLAMA_SERVER_DIR` | Optional | Path to llama.cpp binary directory |
| `LLAMA_SERVER_BIN` | Optional | Path to `llama-server.exe` |
| `LLAMA_MODEL` | Optional | Model filename (`.gguf`) |
| `LOCAL_LLM_HOST` | Optional | Local LLM host (default: `127.0.0.1`) |
| `LOCAL_LLM_PORT` | Optional | Local LLM port (default: `8080`) |
| `RELAY_HOST` | Optional | Nova relay host (default: `127.0.0.1`) |
| `RELAY_PORT` | Optional | Nova relay port (default: `8765`) |

### `nova/.env` (Python relay)

| Variable | Required | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | Yes | Google AI Studio key for Gemini Live API |
| `RELAY_HOST` | No | Relay bind host (default: `127.0.0.1`) |
| `RELAY_PORT` | No | Relay bind port (default: `8765`) |

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Framework | Next.js 16 (App Router) |
| 3D Rendering | Three.js 0.185 + OrbitControls + UnrealBloomPass + ShaderPass |
| Hand Tracking | MediaPipe Tasks Vision 0.10.35 |
| LLM | Groq (llama-3.1-8b-instant) / local llama.cpp |
| Web Search | Tavily Search API |
| TTS | ElevenLabs (eleven_turbo_v2_5) / browser SpeechSynthesis |
| Native Audio AI | Gemini Live API (gemini-2.5-flash-native-audio-preview) |
| Nova Relay | Python 3.10+ / websockets / google-genai |
| Language | TypeScript (frontend + API routes) / Python (relay) |

---

## Author

**Vijay Palleti**  
Email: [palletivijay333@gmail.com](mailto:palletivijay333@gmail.com)

