/**
 * Streaming Chat API Route (SSE) — returns LLM tokens progressively.
 *
 * Events:
 *   data: {"type":"token","content":"..."}
 *   data: {"type":"meta","payload":{...}}
 *   data: {"type":"error","content":"..."}
 *   data: [DONE]
 *
 * The final [DONE] marker signals end of stream.
 */

import { NextResponse } from "next/server";
import { ensureLocalLlmRunning } from "@/lib/core/localLlmServer";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || "http://localhost:8080";

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

const SYSTEM_PROMPT = `You are Ultron, a highly advanced, sophisticated, and articulate holographic AI system.
You speak in a commanding, slightly futuristic, yet helpful manner, similar to an intelligent movie AI.
Keep your vocal responses concise, direct, and conversational so they sound natural when spoken aloud.`;

const SYSTEM_PROMPT_WITH_SEARCH = `${SYSTEM_PROMPT}
If the user asks about real-time events, current news, weather, or anything requiring up-to-date knowledge, use the 'web_search' tool.
If search results are returned, synthesize them into a concise response.`;

const WEB_SEARCH_TOOL = [
  {
    type: "function" as const,
    function: {
      name: "web_search",
      description: "Search the web for real-time information, weather, news, or current events.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
        },
        required: ["query"],
      },
    },
  },
];

function trimHistory(messages: ChatMessage[], maxTurns = 4): ChatMessage[] {
  const userAssistant = messages.filter((m) => m.role === "user" || m.role === "assistant");
  return userAssistant.slice(-maxTurns * 2);
}

function needsWebSearch(query: string): boolean {
  const keywords = ["weather", "news", "today", "current", "latest", "price", "stock", "score", "who is", "what is", "when is", "search", "find", "look up", "headline"];
  return keywords.some((k) => query.toLowerCase().includes(k));
}

async function tavilySearch(query: string): Promise<any[] | null> {
  if (!TAVILY_API_KEY) return null;
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: TAVILY_API_KEY, query, search_depth: "basic", include_answer: false, include_images: false, max_results: 3 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return (await res.json()).results || [];
  } catch {
    return null;
  }
}

/**
 * Stream an SSE response, calling `write` for each event.
 */
function streamSSE(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  data: unknown,
): void {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  try {
    controller.enqueue(encoder.encode(payload));
  } catch {
    // Stream already closed
  }
}

function endStream(controller: ReadableStreamDefaultController, encoder: TextEncoder): void {
  try {
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    controller.close();
  } catch {
    // Already closed
  }
}

export async function POST(request: Request) {
  try {
    const { messages, mode, systemOverride } = (await request.json()) as {
      messages: ChatMessage[];
      mode: "online" | "offline";
      systemOverride?: string;
    };

    const trimmed = trimHistory(messages);
    const lastUserQuery = trimmed.filter((m) => m.role === "user").at(-1)?.content || "";

    // Determine which system prompt to use
    const effectiveSystem = systemOverride || (mode === "online" ? SYSTEM_PROMPT_WITH_SEARCH : SYSTEM_PROMPT);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // ——— OFFLINE / LOCAL ———
          if (mode === "offline") {
            try {
              await ensureLocalLlmRunning();
            } catch (err: any) {
              streamSSE(controller, encoder, { type: "error", content: `Local LLM startup failed: ${err.message}` });
              endStream(controller, encoder);
              return;
            }

            const fullMessages: ChatMessage[] = [{ role: "system", content: effectiveSystem }, ...trimmed];

            // Web search for local mode
            if (needsWebSearch(lastUserQuery)) {
              const searchResults = await tavilySearch(lastUserQuery);
              if (searchResults?.length) {
                streamSSE(controller, encoder, { type: "meta", payload: { searchResults, searchUsed: true, searchQuery: lastUserQuery, mode: "offline" } });
                fullMessages.push({
                  role: "system",
                  content: `Web search results:\n${searchResults.map((r, i) => `[${i + 1}] ${r.title}: ${r.content}`).join("\n")}`,
                });
              }
            }

            // Local LLM streaming
            const res = await fetch(`${LOCAL_LLM_URL}/v1/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "local",
                messages: fullMessages,
                temperature: 0.7,
                max_tokens: 512,
                stream: true,
              }),
              signal: AbortSignal.timeout(30000),
            });

            if (!res.ok) {
              streamSSE(controller, encoder, { type: "error", content: `Local LLM error: ${await res.text()}` });
              endStream(controller, encoder);
              return;
            }

            const reader = res.body?.getReader();
            if (!reader) {
              streamSSE(controller, encoder, { type: "error", content: "Local LLM returned no body" });
              endStream(controller, encoder);
              return;
            }

            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const dataStr = line.slice(6).trim();
                if (dataStr === "[DONE]") continue;

                try {
                  const parsed = JSON.parse(dataStr);
                  const content = parsed.choices?.[0]?.delta?.content || "";
                  if (content) {
                    streamSSE(controller, encoder, { type: "token", content });
                  }
                } catch {
                  // Ignore malformed lines
                }
              }
            }

            streamSSE(controller, encoder, { type: "meta", payload: { mode: "offline" } });
            endStream(controller, encoder);
            return;
          }

          // ——— ONLINE (Groq) ———
          if (!GROQ_API_KEY) {
            streamSSE(controller, encoder, { type: "error", content: "GROQ_API_KEY is not configured." });
            endStream(controller, encoder);
            return;
          }

          const fullMessages: ChatMessage[] = [{ role: "system", content: effectiveSystem }, ...trimmed];

          // Try Groq streaming first
          try {
            const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
              body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                messages: fullMessages,
                temperature: 0.7,
                max_tokens: 512,
                stream: true,
                tools: WEB_SEARCH_TOOL,
                tool_choice: "auto",
              }),
              signal: AbortSignal.timeout(15000),
            });

            if (!groqRes.ok) {
              const errText = await groqRes.text();
              throw new Error(`Groq API error: ${errText}`);
            }

            const reader = groqRes.body?.getReader();
            if (!reader) throw new Error("Groq returned no body");

            const decoder = new TextDecoder();
            let buffer = "";
            let toolCallAccum: any = null;
            let contentAccum = "";

            const streamDone = async () => {
              // Send any accumulated meta
              streamSSE(controller, encoder, { type: "meta", payload: { mode: "online" } });
              endStream(controller, encoder);
            };

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const dataStr = line.slice(6).trim();
                if (dataStr === "[DONE]") continue;

                try {
                  const parsed = JSON.parse(dataStr);
                  const delta = parsed.choices?.[0]?.delta;

                  if (delta?.content) {
                    contentAccum += delta.content;
                    streamSSE(controller, encoder, { type: "token", content: delta.content });
                  }

                  if (delta?.tool_calls) {
                    toolCallAccum = toolCallAccum || { name: "", arguments: "", id: "" };
                    for (const tc of delta.tool_calls) {
                      if (tc.id) toolCallAccum.id = tc.id;
                      if (tc.function?.name) toolCallAccum.name += tc.function.name;
                      if (tc.function?.arguments) toolCallAccum.arguments += tc.function.arguments;
                    }
                  }

                  // Finish reason
                  const finishReason = parsed.choices?.[0]?.finish_reason;
                  if (finishReason === "tool_calls" && toolCallAccum) {
                    // Execute tool call
                    if (toolCallAccum.name === "web_search") {
                      const { query } = JSON.parse(toolCallAccum.arguments);
                      const searchResults = await tavilySearch(query);
                      if (searchResults?.length) {
                        streamSSE(controller, encoder, { type: "meta", payload: { searchResults, searchUsed: true, searchQuery: query, mode: "online" } });

                        // Make a second request with search context
                        const toolMessages: ChatMessage[] = [
                          ...fullMessages,
                          { role: "assistant", content: contentAccum || null, tool_calls: [{ id: toolCallAccum.id, type: "function", function: { name: toolCallAccum.name, arguments: toolCallAccum.arguments } }] } as any,
                          { role: "tool", tool_call_id: toolCallAccum.id, name: "web_search", content: JSON.stringify(searchResults) },
                        ];

                        const res2 = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                          method: "POST",
                          headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
                          body: JSON.stringify({
                            model: "llama-3.1-8b-instant",
                            messages: toolMessages,
                            temperature: 0.7,
                            max_tokens: 512,
                            stream: true,
                          }),
                          signal: AbortSignal.timeout(15000),
                        });

                        if (res2.ok) {
                          const reader2 = res2.body?.getReader();
                          if (reader2) {
                            let buf2 = "";
                            while (true) {
                              const r = await reader2.read();
                              if (r.done) break;
                              buf2 += decoder.decode(r.value, { stream: true });
                              const lines2 = buf2.split("\n");
                              buf2 = lines2.pop() || "";
                              for (const l of lines2) {
                                if (!l.startsWith("data: ") || l.includes("[DONE]")) continue;
                                try {
                                  const p = JSON.parse(l.slice(6));
                                  const c = p.choices?.[0]?.delta?.content || "";
                                  if (c) streamSSE(controller, encoder, { type: "token", content: c });
                                } catch {}
                              }
                            }
                          }
                        }
                      } else {
                        // No search results — answer without
                        const res2 = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                          method: "POST",
                          headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
                          body: JSON.stringify({
                            model: "llama-3.1-8b-instant",
                            messages: [{ role: "system", content: SYSTEM_PROMPT }, ...trimmed],
                            temperature: 0.7,
                            max_tokens: 512,
                            stream: true,
                          }),
                          signal: AbortSignal.timeout(15000),
                        });

                        if (res2.ok) {
                          const reader2 = res2.body?.getReader();
                          if (reader2) {
                            let buf2 = "";
                            while (true) {
                              const r = await reader2.read();
                              if (r.done) break;
                              buf2 += decoder.decode(r.value, { stream: true });
                              const lines2 = buf2.split("\n");
                              buf2 = lines2.pop() || "";
                              for (const l of lines2) {
                                if (!l.startsWith("data: ") || l.includes("[DONE]")) continue;
                                try {
                                  const p = JSON.parse(l.slice(6));
                                  const c = p.choices?.[0]?.delta?.content || "";
                                  if (c) streamSSE(controller, encoder, { type: "token", content: c });
                                } catch {}
                              }
                            }
                          }
                        }
                      }
                    }
                    break;
                  }
                } catch {
                  // Ignore parse errors on partial lines
                }
              }
            }

            await streamDone();
          } catch (groqErr: any) {
            // Groq failed — fallback to local LLM
            streamSSE(controller, encoder, { type: "meta", payload: { mode: "offline-fallback" } });

            try {
              await ensureLocalLlmRunning();
            } catch (localErr: any) {
              streamSSE(controller, encoder, { type: "error", content: `All backends failed: ${localErr.message}` });
              endStream(controller, encoder);
              return;
            }

            // Web search for local fallback
            if (needsWebSearch(lastUserQuery)) {
              const searchResults = await tavilySearch(lastUserQuery);
              if (searchResults?.length) {
                streamSSE(controller, encoder, { type: "meta", payload: { searchResults, searchUsed: true, searchQuery: lastUserQuery } });
                fullMessages.push({
                  role: "system",
                  content: `Web search results:\n${searchResults.map((r, i) => `[${i + 1}] ${r.title}: ${r.content}`).join("\n")}`,
                });
              }
            }

            const localRes = await fetch(`${LOCAL_LLM_URL}/v1/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "local",
                messages: fullMessages,
                temperature: 0.7,
                max_tokens: 512,
                stream: true,
              }),
              signal: AbortSignal.timeout(30000),
            });

            if (localRes.ok) {
              const reader = localRes.body?.getReader();
              if (reader) {
                const decoder = new TextDecoder();
                let buf = "";
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  buf += decoder.decode(value, { stream: true });
                  const lines = buf.split("\n");
                  buf = lines.pop() || "";
                  for (const line of lines) {
                    if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
                    try {
                      const p = JSON.parse(line.slice(6));
                      const c = p.choices?.[0]?.delta?.content || "";
                      if (c) streamSSE(controller, encoder, { type: "token", content: c });
                    } catch {}
                  }
                }
              }
            } else {
              streamSSE(controller, encoder, { type: "error", content: `Fallback local LLM failed: ${await localRes.text()}` });
            }

            endStream(controller, encoder);
          }
        } catch (err: any) {
          streamSSE(controller, encoder, { type: "error", content: err?.message || "Server error" });
          endStream(controller, encoder);
        }
      },
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Internal server error" }, { status: 500 });
  }
}
