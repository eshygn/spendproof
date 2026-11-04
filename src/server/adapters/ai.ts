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
  type Contact,
  type ProposePaymentInputT,
} from "@/domain/authoring";
import { withContactEmails } from "@/domain/demo";
import { formatMoney } from "@/lib/money";
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
  if (globalThis.__spendproofAiStatus) return globalThis.__spendproofAiStatus;
  const forced = process.env.SPENDPROOF_FORCE_MOCK === "1";
  const live = !!process.env.GOOGLE_GENERATIVE_AI_API_KEY && !forced;
  return {
    mode: live ? "live" : "recorded",
    model: live ? configuredModel() : null,
    reason: live
      ? "Ready"
      : forced
        ? "Mock mode forced by SPENDPROOF_FORCE_MOCK — using recorded responses"
        : "No GOOGLE_GENERATIVE_AI_API_KEY — using recorded responses",
    at: null,
  };
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
  if (process.env.SPENDPROOF_FORCE_MOCK === "1") return { ok: false, reason: "Mock mode forced by SPENDPROOF_FORCE_MOCK — using recorded responses" };
  if (!key) return { ok: false, reason: "No GOOGLE_GENERATIVE_AI_API_KEY — using recorded responses" };
  if (!takeRateToken()) return { ok: false, reason: `Rate limit (${RATE_LIMIT_PER_MINUTE}/min) reached — using recorded responses` };
  const models = [...new Set([configuredModel(), FALLBACK_MODEL])];
  let reason = "";
  for (const model of models) {
    try {
      return { ok: true, value: await run(model), model };
    } catch (e) {
      const status = APICallError.isInstance(e) ? e.statusCode : undefined;
      reason =
        status === 429
          ? "Gemini rate-limited (429)"
          : status === 503
            ? `${model} overloaded (503)`
            : `${model}: ${(e as Error).message.slice(0, 120)}`;
      // Quotas and capacity are per model: try the fallback model before giving up.
      if (status === undefined || ![400, 404, 429, 500, 503].includes(status)) break;
    }
  }
  return { ok: false, reason: `${reason} — using recorded responses` };
}

function google() {
  return createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY });
}

/** Tool-filling needs little reasoning: keep latency low on thinking models. */
function thinking(model: string) {
  return {
    google: /gemini-2\./.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : { thinkingConfig: { thinkingLevel: "low" as const } },
  };
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
  const cached = cacheGet<{ input: AuthoringInputT; model: string }>(key);
  if (cached?.input) {
    setStatus({ mode: "live", model: cached.model, reason: `Cached response from ${cached.model}` });
    return { input: AuthoringInput.parse(cached.input), source: "cache", model: cached.model, note: `Cached response from ${cached.model}` };
  }

  const attempt = await callModel(async (m) => {
    const res = await generateText({
      model: google()(m),
      system: AUTHORING_SYSTEM_PROMPT,
      prompt: text,
      tools: { record_rules: tool({ description: AUTHORING_TOOL_DESCRIPTION, inputSchema: AuthoringInput }) },
      toolChoice: { type: "tool", toolName: "record_rules" },
      providerOptions: thinking(m),
      maxRetries: 0,
      timeout: 25_000,
      temperature: 0,
    });
    const call = res.toolCalls.find((c) => c.toolName === "record_rules");
    if (!call) throw new Error("The model did not call record_rules");
    return AuthoringInput.parse(call.input);
  });

  if (attempt.ok) {
    cachePut(key, { input: attempt.value, model: attempt.model });
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

function recordedAgent(messageId: string | null): Omit<AgentResult, "source" | "model" | "note"> | null {
  const hit = recorded.agent.find((a) => a.messageId === messageId);
  if (!hit) return null;
  // Recorded against the default demo addresses; follow any sandbox overrides.
  const contacts = db().prepare("SELECT id, name, email, role FROM contacts").all() as Contact[];
  return {
    proposals: hit.toolCalls.map((c) =>
      ProposePaymentInput.parse({ ...c.input, payeePaypalEmail: withContactEmails(c.input.payeePaypalEmail, contacts) }),
    ),
    reply: hit.text,
  };
}

export async function readMessage(raw: string, messageId: string | null): Promise<AgentResult> {
  const key = cacheKey("agent", configuredModel(), raw);
  const cached = cacheGet<Omit<AgentResult, "source" | "note">>(key);
  if (cached?.proposals) setStatus({ mode: "live", model: cached.model, reason: `Cached response from ${cached.model}` });
  if (cached?.proposals) return { ...cached, source: "cache", note: `Cached response from ${cached.model}` };

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
      providerOptions: thinking(m),
      maxRetries: 0,
      timeout: 25_000,
      temperature: 0,
    });
    const proposals = res.toolCalls
      .filter((c) => c.toolName === "propose_payment")
      .map((c) => ProposePaymentInput.parse(c.input));
    const reply =
      res.text.trim() ||
      (proposals.length
        ? proposals.map((p) => `I've proposed paying ${p.payeeName} ${formatMoney(p.amountCents)}: ${p.reason}`).join(" ")
        : "I didn't find a payment request in this message.");
    return { proposals, reply };
  });

  if (attempt.ok) {
    cachePut(key, { ...attempt.value, model: attempt.model });
    setStatus({ mode: "live", model: attempt.model, reason: `Live: ${attempt.model}` });
    return { ...attempt.value, source: "live", model: attempt.model, note: `Read by ${attempt.model}` };
  }
  setStatus({ mode: "recorded", model: null, reason: attempt.reason });
  const fallback = recordedAgent(messageId);
  if (!fallback) {
    throw new AiUnavailableError(`${attempt.reason}. Only the sample messages have recorded responses.`);
  }
  return { ...fallback, source: "recorded", model: null, note: attempt.reason };
}
