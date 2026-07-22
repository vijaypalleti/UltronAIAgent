#!/usr/bin/env python3
"""
Nova — Gemini Live API WebSocket relay.

Run:
  1. Copy .env.template → .env  and fill in your GEMINI_API_KEY
  2. pip install -r ../requirements-gemini.txt
  3. python relay.py

The relay speaks this protocol over WebSocket:

  Browser → Relay (text, JSON):
    {"type":"start","model":"gemini-2.5-flash-native-audio-preview-12-2025"}
    {"type":"interrupt"}                                   # force-interrupt
    {"type":"stop"}                                        # end session

  Browser → Relay (binary):
    [PCM S16LE 16000 Hz mono audio chunks]                 # mic audio (raw bytes)

  Relay → Browser (text, JSON):
    {"type":"state","state":"listening"|"speaking"|"thinking"}
    {"type":"input_transcript","text":"..."}               # what the user said
    {"type":"output_transcript","text":"..."}              # what Nova said
    {"type":"error","message":"..."}

  Relay → Browser (binary):
    [PCM S16LE 24000 Hz mono audio chunks]                 # model's voice (raw bytes)

Architecture:
  The browser WebSocket lives for the entire session.
  Gemini sessions are ephemeral — each turn creates a new one.
  When a Gemini session ends (turn_complete), we auto-reconnect
  a fresh session so the next turn works seamlessly.
"""

import asyncio
import base64
import json
import os
import signal
import sys
from pathlib import Path

import websockets
from websockets.asyncio.server import ServerConnection

from google import genai
from google.genai import types

# ---------------------------------------------------------------------------
# Config  (reads from .env next to this file)
# ---------------------------------------------------------------------------
ENV_PATH = Path(__file__).resolve().parent / ".env"


def _load_env():
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())


_load_env()

API_KEY = os.environ.get("GEMINI_API_KEY", "")
HOST = os.environ.get("RELAY_HOST", "127.0.0.1")
PORT = int(os.environ.get("RELAY_PORT", "8765"))

if not API_KEY:
    print("\n  WARNING: GEMINI_API_KEY not set!")
    print(f"     Create {ENV_PATH} with:\n")
    print(f"     GEMINI_API_KEY=your_key_here\n")
    print(f"     Get a key at: https://aistudio.google.com/apikey\n")
    sys.exit(1)

key_preview = API_KEY[:4] + "…" + API_KEY[-4:] if len(API_KEY) > 8 else "(too short)"
print(f"     API key: {key_preview}")

DEFAULT_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"

SYSTEM_PROMPT = (
    "Your name is Nova. You are a good AI model that helps humans in your own way — "
    "direct, warm, genuinely useful, and honest even when the honest answer isn't the "
    "easiest one. Keep replies conversational and reasonably brief, since this is a "
    "live spoken conversation, not a written one."
)

SEND_SAMPLE_RATE = 16000   # mic → Gemini
RECV_SAMPLE_RATE = 24000   # Gemini → browser
RECONNECT_DELAY = 0.5      # seconds between Gemini session reconnects


# ---------------------------------------------------------------------------
# Gemini session wrapper with auto-reconnect
# ---------------------------------------------------------------------------
class GeminiRelay:
    """Bridges a persistent browser WebSocket to ephemeral Gemini Live sessions.

    The browser WS lives for the entire conversation.
    Gemini sessions are created per-turn — when one ends (turn_complete),
    a fresh session is opened for the next turn.
    """

    def __init__(self, ws: ServerConnection, model_id: str):
        self.ws = ws
        self.model_id = model_id or DEFAULT_MODEL
        self.client = genai.Client(api_key=API_KEY)
        self.session = None          # current Gemini live session (swapped on reconnect)
        self._running = False
        self._send_error_count = 0   # track consecutive send errors

    # ── main entry point ───────────────────────────────────────────
    async def run(self):
        self._running = True

        # Send loop runs for the lifetime of the browser WebSocket
        send_task = asyncio.create_task(self._send_loop(), name="send")

        # Gemini session loop — reconnects after each turn
        try:
            await self._gemini_session_loop()
        except Exception as e:
            print(f"[nova] session loop error: {e}")
            import traceback
            traceback.print_exc()
        finally:
            self._running = False
            send_task.cancel()
            try:
                await send_task
            except asyncio.CancelledError:
                pass

    # ── Gemini session loop (auto-reconnect) ───────────────────────
    async def _gemini_session_loop(self):
        """Keep creating Gemini sessions as long as the browser is connected."""
        while self._running:
            try:
                await self._connect_and_receive()
            except Exception as e:
                print(f"[nova] Gemini session error: {e}")

            if self._running:
                print(f"[nova] Reconnecting in {RECONNECT_DELAY}s…")
                await asyncio.sleep(RECONNECT_DELAY)

    async def _connect_and_receive(self):
        """Open one Gemini session, run recv until it ends, then return."""
        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            system_instruction=SYSTEM_PROMPT,
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name="Aoede",
                    )
                )
            ),
        )

        print(f"[nova] Connecting to {self.model_id} …")
        async with self.client.aio.live.connect(
            model=self.model_id, config=config
        ) as session:
            self.session = session
            self._send_error_count = 0
            print(f"[nova] Connected. Relaying audio …")
            await self._send_state("listening")

            # Run receive loop — blocks until the Gemini session ends
            await self._recv_loop()

            print("[nova] Gemini session ended (turn complete)")

    # ── send loop (browser mic → Gemini) ───────────────────────────
    async def _send_loop(self):
        """Read audio from browser WebSocket and forward to current Gemini session."""
        chunk_count = 0
        try:
            async for msg in self.ws:
                if isinstance(msg, bytes):
                    chunk_count += 1
                    if chunk_count == 1 or chunk_count % 50 == 0:
                        print(f"[nova] mic chunks sent: {chunk_count} ({len(msg)} bytes)")

                    # Wait for a live Gemini session
                    while self._running and self.session is None:
                        await asyncio.sleep(0.05)

                    if not self._running or self.session is None:
                        break

                    audio_b64 = base64.b64encode(msg).decode("ascii")
                    try:
                        await self.session.send_realtime_input(
                            audio=types.Blob(
                                data=audio_b64,
                                mime_type="audio/pcm;rate=16000",
                            )
                        )
                        self._send_error_count = 0
                    except Exception as e:
                        self._send_error_count += 1
                        # Only log every 20th error to avoid spam
                        if self._send_error_count == 1 or self._send_error_count % 20 == 0:
                            print(f"[nova] send error (#{self._send_error_count}): {e}")

                elif isinstance(msg, str):
                    try:
                        cmd = json.loads(msg)
                    except json.JSONDecodeError:
                        continue

                    if cmd.get("type") == "stop":
                        break
                    elif cmd.get("type") == "interrupt":
                        print("[nova] Interrupt requested")
                        if self.session:
                            try:
                                await self.session.send_client_content(
                                    turns=None, turn_complete=True
                                )
                            except Exception as e:
                                print(f"[nova] interrupt error: {e}")
        except websockets.exceptions.ConnectionClosed:
            pass
        print("[nova] Browser disconnected")

    # ── receive loop (Gemini → browser) ────────────────────────────
    async def _recv_loop(self):
        """Read Gemini responses and forward audio/text to the browser."""
        msg_count = 0
        try:
            async for msg in self.session.receive():
                msg_count += 1
                try:
                    await self._process_message(msg)
                except Exception as e:
                    print(f"[nova] error processing msg #{msg_count}: {e}")
                    import traceback
                    traceback.print_exc()
                    continue
        except websockets.exceptions.ConnectionClosed:
            pass
        except Exception as e:
            # The receive iterator ending normally is expected (turn complete).
            # Only log unexpected errors.
            err_str = str(e)
            if "receive" not in err_str.lower():
                print(f"[nova] recv error: {e}")

    async def _process_message(self, msg):
        """Process a single Gemini response message."""
        if not msg.server_content:
            return

        sc = msg.server_content

        # User's input speech transcription
        if sc.input_transcription and sc.input_transcription.text:
            await self.ws.send(json.dumps({
                "type": "input_transcript",
                "text": sc.input_transcription.text,
            }))

        # Nova's output (audio + text)
        if sc.model_turn:
            part_summary = []
            for part in sc.model_turn.parts:
                if part.inline_data:
                    part_summary.append(f"audio({part.inline_data.mime_type})")
                    raw = part.inline_data.data
                    audio = base64.b64decode(raw) if isinstance(raw, str) else raw
                    await self._send_state("speaking")
                    await self.ws.send(audio)
                elif part.text:
                    is_thought = getattr(part, "thought", False)
                    if is_thought:
                        part_summary.append(f"thought({len(part.text)}ch)")
                    else:
                        part_summary.append(f"speech({len(part.text)}ch)")
                        await self.ws.send(
                            json.dumps({"type": "output_transcript", "text": part.text})
                        )
                else:
                    part_summary.append("other")
            if part_summary:
                print(f"[nova] parts: {', '.join(part_summary)}")

        if sc.interrupted:
            print("[nova] Gemini interrupted (barge-in)")
            await self._send_state("listening")

        if sc.turn_complete:
            print("[nova] turn complete")
            await self._send_state("listening")

    # ── helpers ────────────────────────────────────────────────────
    async def _send_state(self, state: str):
        try:
            await self.ws.send(json.dumps({"type": "state", "state": state}))
        except websockets.exceptions.ConnectionClosed:
            pass

    async def close(self):
        self._running = False
        if self.session:
            await self.session.close()


# ---------------------------------------------------------------------------
# WebSocket server
# ---------------------------------------------------------------------------
async def handler(ws: ServerConnection):
    """Handle one browser WebSocket connection."""
    model_id = DEFAULT_MODEL

    try:
        msg = await asyncio.wait_for(ws.recv(), timeout=30)
    except asyncio.TimeoutError:
        await ws.send(json.dumps({"type": "error", "message": "Timeout waiting for start command"}))
        return

    if isinstance(msg, str):
        try:
            cmd = json.loads(msg)
            if cmd.get("type") == "start":
                model_id = cmd.get("model", DEFAULT_MODEL)
        except json.JSONDecodeError:
            pass

    relay = GeminiRelay(ws, model_id)
    try:
        await relay.run()
    except Exception as exc:
        print(f"[nova] Relay error: {exc}")
        try:
            await ws.send(json.dumps({"type": "error", "message": str(exc)}))
        except websockets.exceptions.ConnectionClosed:
            pass
    finally:
        await relay.close()


async def main():
    stop = asyncio.Future()

    def _signal():
        if not stop.done():
            stop.set_result(True)

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _signal)
        except NotImplementedError:
            pass

    async with websockets.serve(
        handler, HOST, PORT,
        ping_interval=None,
    ):
        print(f"\n  +-----------------------------------------------+")
        print(f"  |     Nova Gemini Live Relay                    |")
        print(f"  |     ws://{HOST}:{PORT}                           |")
        print(f"  |     Config: {ENV_PATH.name}                      |")
        print(f"  |     Ctrl+C to stop                             |")
        print(f"  +-----------------------------------------------+\n")
        await stop


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[nova] Shutting down.")
        sys.exit(0)
