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

// Keep only last N user/assistant turns to avoid TPM limits
function trimHistory(messages: ChatMessage[], maxTurns = 4): ChatMessage[] {
  const userAssistant = messages.filter((m) => m.role === "user" || m.role === "assistant");
  return userAssistant.slice(-maxTurns * 2);
}

async function callLocalLLM(messages: ChatMessage[]): Promise<string> {
  const res = await fetch(`${LOCAL_LLM_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "local", messages, temperature: 0.7, max_tokens: 512 }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Local LLM error: ${await res.text()}`);
  return (await res.json()).choices[0].message.content;
}

async function callGroq(messages: ChatMessage[], tools?: any[]): Promise<any> {
  const body: any = {
    model: "llama-3.1-8b-instant", // smaller model = lower TPM usage, faster
    messages,
    temperature: 0.7,
    max_tokens: 512,
  };
  if (tools) { body.tools = tools; body.tool_choice = "auto"; }

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Groq API error: ${await res.text()}`);
  return (await res.json()).choices[0].message;
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

function needsWebSearch(query: string): boolean {
  const keywords = ["weather", "news", "today", "current", "latest", "price", "stock", "score", "who is", "what is", "when is", "search", "find", "look up", "headline"];
  return keywords.some((k) => query.toLowerCase().includes(k));
}

export async function POST(request: Request) {
  try {
    const { messages, mode } = (await request.json()) as { messages: ChatMessage[]; mode: "online" | "offline" };
    const trimmed = trimHistory(messages);
    const lastUserQuery = trimmed.filter((m) => m.role === "user").at(-1)?.content || "";

    // ——— LOCAL mode: local LLM + optional Tavily ———
    if (mode === "offline") {
      // Auto-start the local llama-server if it's not already running
      try {
        await ensureLocalLlmRunning();
      } catch (err: any) {
        return NextResponse.json(
          { error: `Failed to start local LLM server: ${err.message}` },
          { status: 503 },
        );
      }

      const systemMessage: ChatMessage = { role: "system", content: SYSTEM_PROMPT };
      const fullMessages = [systemMessage, ...trimmed];

      if (needsWebSearch(lastUserQuery)) {
        const searchResults = await tavilySearch(lastUserQuery);
        if (searchResults?.length) {
          fullMessages.push({
            role: "system",
            content: `Web search results:\n${searchResults.map((r, i) => `[${i + 1}] ${r.title}: ${r.content}`).join("\n")}`,
          });
          const response = await callLocalLLM(fullMessages);
          return NextResponse.json({ response, searchResults, searchUsed: true, searchQuery: lastUserQuery, mode: "offline" });
        }
      }

      const response = await callLocalLLM(fullMessages);
      return NextResponse.json({ response, searchResults: null, searchUsed: false, mode: "offline" });
    }

    // ——— ONLINE mode: Groq + Tavily ———
    if (!GROQ_API_KEY) {
      return NextResponse.json({ error: "GROQ_API_KEY is not configured." }, { status: 500 });
    }

    const systemMessage: ChatMessage = { role: "system", content: SYSTEM_PROMPT_WITH_SEARCH };
    const fullMessages = [systemMessage, ...trimmed];

    let assistantMessage: any;
    try {
      assistantMessage = await callGroq(fullMessages, WEB_SEARCH_TOOL);
    } catch (err: any) {
      const errMsg: string = err.message || "";

      // tool_use_failed: retry without tools
      if (errMsg.includes("tool_use_failed")) {
        console.warn("Tool use failed, retrying without tools...");
        try {
          assistantMessage = await callGroq([{ role: "system", content: SYSTEM_PROMPT }, ...trimmed]);
          return NextResponse.json({ response: assistantMessage.content, searchResults: null, searchUsed: false, mode: "online" });
        } catch {
          // fall through to local fallback
        }
      }

      // Any other Groq failure: fallback to local
      console.warn("Groq failed, falling back to local LLM:", errMsg);
      try {
        // Auto-start local server before fallback
        await ensureLocalLlmRunning();

        const searchResults = needsWebSearch(lastUserQuery) ? await tavilySearch(lastUserQuery) : null;
        const localMessages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...trimmed];
        if (searchResults?.length) {
          localMessages.push({ role: "system", content: `Web search results:\n${searchResults.map((r, i) => `[${i + 1}] ${r.title}: ${r.content}`).join("\n")}` });
        }
        const response = await callLocalLLM(localMessages);
        return NextResponse.json({ response, searchResults: searchResults || null, searchUsed: !!searchResults?.length, mode: "offline-fallback" });
      } catch (localErr: any) {
        return NextResponse.json({ error: `All backends failed. Local LLM: ${localErr.message}` }, { status: 500 });
      }
    }

    // Groq wants to call web_search
    if (assistantMessage.tool_calls?.length > 0) {
      const toolCall = assistantMessage.tool_calls[0];
      if (toolCall.function.name === "web_search") {
        const { query } = JSON.parse(toolCall.function.arguments);
        const searchResults = await tavilySearch(query);
        if (!searchResults) {
          // No internet — answer without search
          const fallback = await callGroq([{ role: "system", content: SYSTEM_PROMPT }, ...trimmed]);
          return NextResponse.json({ response: fallback.content, searchResults: null, searchUsed: false, mode: "online" });
        }
        fullMessages.push(assistantMessage);
        fullMessages.push({ role: "tool", tool_call_id: toolCall.id, name: "web_search", content: JSON.stringify(searchResults) });
        const finalMessage = await callGroq(fullMessages);
        return NextResponse.json({ response: finalMessage.content, searchResults, searchUsed: true, searchQuery: query, mode: "online" });
      }
    }

    return NextResponse.json({ response: assistantMessage.content, searchResults: null, searchUsed: false, mode: "online" });

  } catch (error: any) {
    console.error("API error:", error);
    return NextResponse.json({ error: error?.message || "Internal server error" }, { status: 500 });
  }
}
