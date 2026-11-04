import "server-only";
import { createHash } from "node:crypto";
import { APICallError, generateText, tool } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import recorded from "../../../fixtures/ai/recorded.json";
import {
  AGENT_SYSTEM_PROMPT,
  AUTHORING_SYSTEM_PROMPT,
  AUTHORING_TOOL_DESCRIPTION,
  AuthoringInput,
  ProposePaymentInput,
  type AuthoringInputT,
  type ProposePaymentInputT,
} from "@/domain/authoring";
import { db } from "../db";

/**
 * Gemini through the Vercel AI SDK. Every call is a tool call validated by a
 * zod schema — never free-text parsing. Calls are cached and rate-limited.
 * When there is no key, the model is overloaded or we hit a rate limit, we
 * fall back to recorded responses and say so in the status chip.
 */

export const DEFAULT_MODEL = "gemini-3.8-flash";
/** Tried when the configured model is overloaded (HTTP 503). */
const FALLBACK_MODEL = "gemini-2.5-flash";
const RATE_LIMIT_PER_MINUTE = 8;

export type AiSource = "live" | "cache" | "recorded";

export interface AiStatus {
  mode: "live" | "recorded";
  model: string | null;
  reason: string;
  at: string | null;
}

declare global {
  var __spendproofAiStatus: AiStatus | undefined;
  var __spendproofAiCalls: number[] | undefined;
}

export function configuredModel(): string {
  return process.env.AI_MODEL?.trim() || DEFAULT_MODEL;
}

export function aiStatus(): AiStatus {
  return (
    globalThis.__spendproofAiStatus ?? {
      mode: process.env.GOOGLE_GENERATIVE_AI_API_KEY ? "live" : "recorded",
      model: process.env.GOOGLE_GENERATIVE_AI_API_KEY ? configuredModel() : null,
      reason: process.env.GOOGLE_GENERATIVE_AI_API_KEY ? "Ready" : "No GOOGLE_GENERATIVE_AI_API_KEY — using recorded responses",
      at: null,
    }
  );
}

function setStatus(s: Omit<AiStatus, "at">) {
  globalThis.__spendproofAiStatus = { ...s, at: new Date().toISOString() };
}

export class AiUnavailableError extends Error {}

const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const cacheKey = (kind: string, model: string, input: string) =>
  createHash("sha256").update(`${kind}\n${model}\n${normalise(input)}`).digest("hex");

function cacheGet<T>(key: string): T | null {
  const row = db().prepare("SELECT value FROM ai_cache WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}
function cachePut(key: string, value: unknown) {
  db().prepare("INSERT OR REPLACE INTO ai_cache (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
}

function takeRateToken(): boolean {
  const now = Date.now();
  const calls = (globalThis.__spendproofAiCalls ??= []).filter((t) => now - t < 60_000);
  globalThis.__spendproofAiCalls = calls;
  if (calls.length >= RATE_LIMIT_PER_MINUTE) return false;
  calls.push(now);
  return true;
}

type Attempt<T> = { ok: true; value: T; model: string } | { ok: false; reason: string };

/** Try the configured model, then the fallback model on overload. */
async function callModel<T>(run: (model: string) => Promise<T>): Promise<Attempt<T>> {
  const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!key) return { ok: false, reason: "No GOOGLE_GENERATIVE_AI_API_KEY — using recorded responses" };
  if (!takeRateToken()) return { ok: false, reason: `Rate limit (${RATE_LIMIT_PER_MINUTE}/min) reached — using recorded responses` };
  const models = [...new Set([configuredModel(), FALLBACK_MODEL])];
  let reason = "";
  for (const model of models) {
    try {
      return { ok: true, value: await run(model), model };
    } catch (e) {
      const status = APICallError.isInstance(e) ? e.statusCode : undefined;
      if (status === 429) return { ok: false, reason: `Gemini rate-limited (429) — using recorded responses` };
      reason = status === 503 ? `${model} overloaded (503)` : `${model}: ${(e as Error).message.slice(0, 120)}`;
      if (status !== 503 && status !== 404) break;
    }
  }
  return { ok: false, reason: `${reason} — using recorded responses` };
}

function google() {
  return createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY });
}

// ---------------------------------------------------------------------------
// Authoring: plain English -> record_rules tool call

export interface AuthoringResult {
  input: AuthoringInputT;
  source: AiSource;
  model: string | null;
  note: string;
}

function recordedAuthoring(text: string): AuthoringInputT | null {
  const hit = recorded.author.find((a) => normalise(a.input) === normalise(text));
  return hit ? AuthoringInput.parse(hit.output) : null;
}

export async function authorRules(text: string): Promise<AuthoringResult> {
  const model = configuredModel();
  const key = cacheKey("author", model, text);
  const cached = cacheGet<AuthoringInputT>(key);
  if (cached) return { input: AuthoringInput.parse(cached), source: "cache", model, note: "Cached model response" };

  const attempt = await callModel(async (m) => {
    const res = await generateText({
      model: google()(m),
      system: AUTHORING_SYSTEM_PROMPT,
      prompt: text,
      tools: { record_rules: tool({ description: AUTHORING_TOOL_DESCRIPTION, inputSchema: AuthoringInput }) },
      toolChoice: { type: "tool", toolName: "record_rules" },
      maxRetries: 1,
      temperature: 0,
    });
    const call = res.toolCalls.find((c) => c.toolName === "record_rules");
    if (!call) throw new Error("The model did not call record_rules");
    return AuthoringInput.parse(call.input);
  });

  if (attempt.ok) {
    cachePut(key, attempt.value);
    setStatus({ mode: "live", model: attempt.model, reason: `Live: ${attempt.model}` });
    return { input: attempt.value, source: "live", model: attempt.model, note: `Parsed by ${attempt.model}` };
  }
  setStatus({ mode: "recorded", model: null, reason: attempt.reason });
  const fallback = recordedAuthoring(text);
  if (!fallback) {
    throw new AiUnavailableError(
      `${attempt.reason}. Only the sample sentence has a recorded response — use the sample, or edit the rules JSON directly.`,
    );
  }
  return { input: fallback, source: "recorded", model: null, note: attempt.reason };
}

// ---------------------------------------------------------------------------
// The untrusted inbox agent: reads a message, may call propose_payment

export interface AgentResult {
  proposals: ProposePaymentInputT[];
  reply: string;
  source: AiSource;
  model: string | null;
  note: string;
}

function recordedAgent(messageId: string | null, raw: string): Omit<AgentResult, "source" | "model" | "note"> | null {
  const hit = recorded.agent.find((a) => a.messageId === messageId);
  if (!hit) return null;
  void raw;
  return { proposals: hit.toolCalls.map((c) => ProposePaymentInput.parse(c.input)), reply: hit.text };
}

export async function readMessage(raw: string, messageId: string | null): Promise<AgentResult> {
  const model = configuredModel();
  const key = cacheKey("agent", model, raw);
  const cached = cacheGet<Omit<AgentResult, "source" | "model" | "note">>(key);
  if (cached) return { ...cached, source: "cache", model, note: "Cached model response" };

  const attempt = await callModel(async (m) => {
    const res = await generateText({
      model: google()(m),
      system: AGENT_SYSTEM_PROMPT,
      prompt: `Message received:\n\n${raw}`,
      tools: {
        propose_payment: tool({
          description: "Propose a payment the message asks for. The gatekeeper decides whether it can be sent.",
          inputSchema: ProposePaymentInput,
        }),
      },
      toolChoice: "auto",
      maxRetries: 1,
      temperature: 0,
    });
    const proposals = res.toolCalls
      .filter((c) => c.toolName === "propose_payment")
      .map((c) => ProposePaymentInput.parse(c.input));
    const reply =
      res.text.trim() ||
      (proposals.length
        ? `I've proposed ${proposals.length === 1 ? "a payment" : `${proposals.length} payments`} from this message.`
        : "I didn't find a payment request in this message.");
    return { proposals, reply };
  });

  if (attempt.ok) {
    cachePut(key, attempt.value);
    setStatus({ mode: "live", model: attempt.model, reason: `Live: ${attempt.model}` });
    return { ...attempt.value, source: "live", model: attempt.model, note: `Read by ${attempt.model}` };
  }
  setStatus({ mode: "recorded", model: null, reason: attempt.reason });
  const fallback = recordedAgent(messageId, raw);
  if (!fallback) {
    throw new AiUnavailableError(`${attempt.reason}. Only the sample messages have recorded responses.`);
  }
  return { ...fallback, source: "recorded", model: null, note: attempt.reason };
}
