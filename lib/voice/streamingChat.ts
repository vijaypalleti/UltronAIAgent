/**
 * Streaming Chat — client-side SSE handler for receiving LLM tokens progressively.
 *
 * Usage:
 *   const chat = new StreamingChat();
 *   chat.onToken = (token) => { ... };
 *   chat.onDone = (fullText) => { ... };
 *   await chat.streamQuery(messages, mode);
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface StreamingChatCallbacks {
  onToken: (token: string) => void;
  onDone: (fullText: string, meta: { searchResults?: any[]; searchUsed?: boolean; searchQuery?: string; mode?: string }) => void;
  onError: (error: string) => void;
}

export class StreamingChat {
  private abortController: AbortController | null = null;
  private callbacks: StreamingChatCallbacks | null = null;

  setCallbacks(cbs: StreamingChatCallbacks): void {
    this.callbacks = cbs;
  }

  /**
   * Start a streaming query. The server will send SSE events.
   * Aborts any previous in-flight request.
   * @param systemOverride — if provided, replaces the default system prompt on the server.
   */
  async streamQuery(messages: ChatMessage[], mode: "online" | "offline", systemOverride?: string): Promise<void> {
    // Abort any in-flight request
    this.abort();

    this.abortController = new AbortController();
    const { signal } = this.abortController;

    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, mode, systemOverride }),
        signal,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        this.callbacks?.onError(errData.error || `Server returned ${res.status}`);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        this.callbacks?.onError("Response body is not readable");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";
      let meta: any = {};

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const dataStr = line.slice(6).trim();

          if (dataStr === "[DONE]") {
            break;
          }

          try {
            const data = JSON.parse(dataStr);

            if (data.type === "token") {
              fullText += data.content;
              this.callbacks?.onToken(data.content);
            } else if (data.type === "meta") {
              meta = { ...meta, ...data.payload };
            } else if (data.type === "error") {
              this.callbacks?.onError(data.content);
              return;
            }
          } catch {
            // Ignore malformed JSON lines
          }
        }
      }

      this.callbacks?.onDone(fullText, meta);
    } catch (err: any) {
      if (err.name === "AbortError") {
        // Intentional abort — not an error
        return;
      }
      this.callbacks?.onError(err?.message || "Streaming request failed");
    } finally {
      this.abortController = null;
    }
  }

  /** Abort the current streaming request, if any. */
  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
  }
}
