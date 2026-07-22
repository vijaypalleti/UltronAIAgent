/**
 * Interruption Engine — tracks conversation context across interruptions.
 *
 * Key concepts:
 * - PartialResponse: the text the assistant was mid-way through saying when interrupted
 * - InterruptionRecord: { partialResponse, interruptionQuery, timestamp }
 * - The engine builds a compact "interruption preamble" every new turn so the LLM can
 *   respond coherently after being interrupted.
 */

export interface InterruptionRecord {
  /** The assistant text that was *already spoken* before the interruption. */
  spokenText: string;
  /** Any text that was enqueued for TTS but not yet spoken. */
  pendingText: string;
  /** The user's interruption utterance (after the wake word). */
  interruptionQuery: string;
  /** When it happened. */
  timestamp: number;
}

export interface InterruptionContext {
  /** Full interruption history for the current conversation. */
  history: InterruptionRecord[];
  /** The text the assistant is currently accumulating (streaming). */
  currentAccumulated: string;
  /** How much of currentAccumulated has been spoken so far (character offset). */
  spokenOffset: number;
}

function createInitialContext(): InterruptionContext {
  return {
    history: [],
    currentAccumulated: "",
    spokenOffset: 0,
  };
}

/**
 * Produce a natural-language preamble that tells the LLM about the interruption
 * so it can respond coherently.
 *
 * Example output:
 *   "[Context: You were previously responding to the user. You had said:
 *    \"The weather today in San Francisco is...\"
 *    The user interrupted you with a new question: \"What about the wind speed?\"
 *    Acknowledge the interruption and answer the new query, referencing what you
 *    were just saying if relevant.]"
 */
function buildInterruptionPreamble(record: InterruptionRecord): string {
  return `[INTERRUPTION CONTEXT — continue naturally]
You were in the middle of answering when the user interrupted.
You had already said: "${record.spokenText.slice(0, 300)}"
You still had more to say: "${record.pendingText.slice(0, 200)}..."
The user then interrupted with: "${record.interruptionQuery}"

Acknowledge the interruption briefly, then answer the user's new query naturally.`;
}

export class InterruptionEngine {
  private ctx: InterruptionContext;

  constructor() {
    this.ctx = createInitialContext();
  }

  /** Reset engine for a fresh conversation. */
  reset(): void {
    this.ctx = createInitialContext();
  }

  /**
   * Call this as tokens stream in from the LLM.
   * @param chunk — the latest text token.
   */
  accumulate(chunk: string): void {
    this.ctx.currentAccumulated += chunk;
  }

  /**
   * Call this to mark that `chars` characters have been spoken via TTS.
   */
  markSpoken(chars: number): void {
    this.ctx.spokenOffset = Math.min(
      this.ctx.spokenOffset + chars,
      this.ctx.currentAccumulated.length,
    );
  }

  /**
   * What text has been accumulated but not yet spoken.
   */
  getPendingText(): string {
    return this.ctx.currentAccumulated.slice(this.ctx.spokenOffset);
  }

  /**
   * What text has been spoken so far.
   */
  getSpokenText(): string {
    return this.ctx.currentAccumulated.slice(0, this.ctx.spokenOffset);
  }

  /**
   * The full accumulated response so far.
   */
  getFullAccumulated(): string {
    return this.ctx.currentAccumulated;
  }

  /**
   * Called when an interruption occurs.
   * Records the interruption and returns a system preamble to inject into
   * the next LLM request so the model is aware of the interruption.
   */
  recordInterruption(interruptionQuery: string): string {
    const record: InterruptionRecord = {
      spokenText: this.getSpokenText(),
      pendingText: this.getPendingText(),
      interruptionQuery,
      timestamp: Date.now(),
    };
    this.ctx.history.push(record);

    // Build the preamble for the LLM
    const preamble = buildInterruptionPreamble(record);

    // Reset accumulation for the new response
    this.ctx.currentAccumulated = "";
    this.ctx.spokenOffset = 0;

    return preamble;
  }

  /**
   * Build a full system prompt with conversation context for a new query,
   * including any interruption history.
   */
  buildContextualSystemPrompt(baseSystemPrompt: string, userQuery: string): string {
    if (this.ctx.history.length === 0) {
      return baseSystemPrompt;
    }

    // Build a compact summary of interruptions for this turn
    const contextBlocks = this.ctx.history.map((r) => {
      return `- You had said: "${r.spokenText.slice(0, 200)}..." → User interrupted: "${r.interruptionQuery}"`;
    });

    return `${baseSystemPrompt}

${contextBlocks.join("\n")}

The user has just said: "${userQuery}"
Be aware of the interruption context above and respond coherently, naturally acknowledging the flow.`;
  }

  /**
   * Return the number of interruptions so far.
   */
  get interruptionCount(): number {
    return this.ctx.history.length;
  }

  getContext(): InterruptionContext {
    return this.ctx;
  }
}
