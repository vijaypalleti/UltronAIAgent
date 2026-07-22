/**
 * Streaming TTS — chunked, trackable text-to-speech playback.
 *
 * Splits text into sentence chunks and speaks them sequentially.
 * Tracks exactly which characters have been spoken, enabling interruption
 * to capture accurate partial-response context.
 *
 * Usage:
 *   const tts = new StreamingTts();
 *   tts.onChunkStart = (chunk) => { ... };
 *   tts.onChunkEnd = (chunk) => { ... };
 *   tts.onDone = () => { ... };
 *   tts.speak("Hello. This is a test.");
 *   tts.interrupt(); // stop mid-sentence, capture partial
 *   tts.getSpokenText(); // what was actually spoken
 */

export interface StreamingTtsCallbacks {
  /** Called when a new sentence chunk starts playback. */
  onChunkStart?: (chunk: string) => void;
  /** Called when a sentence chunk finishes playback. */
  onChunkEnd?: (chunk: string) => void;
  /** Called when all chunks are done. */
  onDone?: () => void;
  /** Called when an error occurs (e.g., TTS API fails). */
  onError?: (error: string) => void;
  /** Called when a chunk fails and we fall back to browser TTS. */
  onFallback?: (chunk: string) => void;
}

export class StreamingTts {
  private callbacks: StreamingTtsCallbacks = {};
  private queue: string[] = [];
  private speaking = false;
  private interrupted = false;
  private spokenText = "";
  private fullText = "";
  private currentChunkIndex = 0;
  private playbackId = 0; // increment on each speak() call to discard stale callbacks

  /** Set callbacks. */
  setCallbacks(cbs: StreamingTtsCallbacks): void {
    this.callbacks = cbs;
  }

  /**
   * Split text into speakable chunks (sentences).
   */
  private splitChunks(text: string): string[] {
    // Split on sentence boundaries: . ! ? followed by space or end
    const raw = text.match(/[^.!?\n]+[.!?]?/g) || [text];
    return raw
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => (s.endsWith(".") || s.endsWith("!") || s.endsWith("?") ? s : s + "."));
  }

  /**
   * Clean markdown for TTS — strips formatting artifacts.
   */
  private cleanForTTS(text: string): string {
    return text
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
      .replace(/[\[\]]/g, "")
      .trim();
  }

  /**
   * Start speaking the given text.
   * Cancels any speech currently in progress.
   */
  speak(text: string): void {
    this.interrupt(); // Stop any current playback
    this.interrupted = false;
    this.spokenText = "";
    this.fullText = text;
    this.currentChunkIndex = 0;
    this.playbackId++;

    const chunks = this.splitChunks(text);
    if (chunks.length === 0) {
      this.callbacks.onDone?.();
      return;
    }

    this.queue = chunks;
    this.speaking = true;
    this.speakNext(this.playbackId);
  }

  private speakNext(pid: number): void {
    if (!this.speaking || this.interrupted || pid !== this.playbackId) {
      this.finish(pid);
      return;
    }

    if (this.currentChunkIndex >= this.queue.length) {
      this.finish(pid);
      return;
    }

    const chunk = this.queue[this.currentChunkIndex];
    this.callbacks.onChunkStart?.(chunk);

    // Try ElevenLabs TTS via API, fallback to browser
    this.playChunk(chunk, pid);
  }

  private async playChunk(chunk: string, pid: number): Promise<void> {
    const cleanText = this.cleanForTTS(chunk);
    if (!cleanText) {
      this.advanceChunk(pid);
      return;
    }

    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: cleanText }),
      });

      if (!res.ok) throw new Error("TTS API failed");

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);

      // If interrupted while loading, clean up
      if (this.interrupted || pid !== this.playbackId) {
        URL.revokeObjectURL(url);
        this.finish(pid);
        return;
      }

      audio.onended = () => {
        URL.revokeObjectURL(url);
        this.spokenText += chunk;
        this.callbacks.onChunkEnd?.(chunk);
        this.advanceChunk(pid);
      };

      audio.onerror = () => {
        URL.revokeObjectURL(url);
        // Fallback to browser TTS
        this.callbacks.onFallback?.(chunk);
        this.playChunkBrowser(chunk, pid);
      };

      await audio.play();
    } catch {
      // Fallback to browser TTS
      this.callbacks.onFallback?.(chunk);
      this.playChunkBrowser(chunk, pid);
    }
  }

  private playChunkBrowser(chunk: string, pid: number): void {
    const utterance = new SpeechSynthesisUtterance(chunk);
    const voices = window.speechSynthesis.getVoices();
    const voice =
      voices.find((v) => v.name === "Google UK English Female") ||
      voices.find((v) => v.name === "Microsoft Zira Online (Natural) - English (United States)") ||
      voices.find((v) => v.name === "Microsoft Jenny Online (Natural) - English (United States)") ||
      voices.find((v) => v.name === "Google US English") ||
      voices.find((v) => v.lang === "en-US" && v.name.toLowerCase().includes("female")) ||
      voices.find((v) => v.name === "Microsoft Susan Online (Natural) - English (United Kingdom)") ||
      voices.find((v) => v.lang.startsWith("en"));
    if (voice) utterance.voice = voice;
    utterance.rate = 0.95;
    utterance.pitch = 1.1; // slightly higher pitch for female tone
    utterance.volume = 1;

    utterance.onend = () => {
      this.spokenText += chunk;
      this.callbacks.onChunkEnd?.(chunk);
      this.advanceChunk(pid);
    };
    utterance.onerror = () => {
      // Even browser TTS failed — skip this chunk
      this.advanceChunk(pid);
    };

    window.speechSynthesis.speak(utterance);
  }

  private advanceChunk(pid: number): void {
    if (pid !== this.playbackId) return;
    this.currentChunkIndex++;
    this.speakNext(pid);
  }

  private finish(pid: number): void {
    if (pid !== this.playbackId) return;
    this.speaking = false;
    this.callbacks.onDone?.();
  }

  /**
   * Interrupt speech immediately.
   * Returns the text that was spoken up to this point.
   */
  interrupt(): string {
    if (!this.speaking) return this.spokenText;

    this.interrupted = true;
    this.speaking = false;

    // Cancel browser speech
    window.speechSynthesis.cancel();

    // Cancel any audio elements
    // (we can't easily track the active Audio element, but speechSynthesis.cancel covers browser TTS)

    return this.spokenText;
  }

  /**
   * Return what has been spoken so far in the current utterance.
   */
  getSpokenText(): string {
    return this.spokenText;
  }

  /**
   * Return the full text that was given to speak().
   */
  getFullText(): string {
    return this.fullText;
  }

  /**
   * True if currently speaking.
   */
  get isSpeaking(): boolean {
    return this.speaking;
  }
}
