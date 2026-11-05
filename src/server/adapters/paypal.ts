import "server-only";
import {
  ApiError,
  CheckoutPaymentIntent,
  Client,
  Environment,
  OAuthAuthorizationController,
  OrdersController,
} from "@paypal/paypal-server-sdk";
import createFixture from "../../../fixtures/paypal/payouts-create-201.json";
import getFixture from "../../../fixtures/paypal/payouts-get-200.json";
import insufficientFixture from "../../../fixtures/paypal/payouts-error-422-insufficient-funds.json";
import orderCreateFixture from "../../../fixtures/paypal/orders-create-201.json";
import orderCaptureFixture from "../../../fixtures/paypal/orders-capture-201.json";
import { fromDecimalString, toDecimalString, type Cents } from "@/lib/money";

/**
 * PayPal behind one adapter with two implementations:
 *  - live: PayPal sandbox. Orders through @paypal/paypal-server-sdk; Payouts
 *    (which the server SDK does not cover) through the documented REST
 *    endpoints with an OAuth token obtained via the SDK.
 *  - mock: the same calls answered from fixture JSON shaped exactly like the
 *    documented responses, with statuses that advance as you poll.
 * Live is used when the keys are present and the sandbox answers.
 */

const SANDBOX = "https://api-m.sandbox.paypal.com";

export interface PayoutItemInput {
  senderItemId: string;
  receiver: string;
  amountCents: Cents;
  note: string;
}

export interface CreateBatchInput {
  senderBatchId: string;
  emailSubject: string;
  emailMessage: string;
  items: PayoutItemInput[];
  /** PayPal sandbox negative testing: ask PayPal to answer INSUFFICIENT_FUNDS. */
  simulateFailure?: boolean;
}

export type CreateBatchResponse = typeof createFixture;
export type GetBatchResponse = typeof getFixture;
export type PayPalErrorBody = { name: string; message: string; debug_id?: string; information_link?: string; details?: unknown };

export type CreateBatchResult =
  | { ok: true; status: number; body: CreateBatchResponse }
  | { ok: false; status: number; body: PayPalErrorBody };

export interface CapturedOrder {
  id: string;
  status: string;
  amountCents: Cents;
  payer: string | null;
  raw: unknown;
}

export interface PayPalAdapter {
  mode: "live" | "mock";
  reason: string;
  createBatch(input: CreateBatchInput): Promise<CreateBatchResult>;
  getBatch(payoutBatchId: string): Promise<GetBatchResponse>;
  createOrder(amountCents: Cents, description: string): Promise<{ id: string; status: string }>;
  captureOrder(orderId: string): Promise<CapturedOrder>;
}

// ---------------------------------------------------------------------------
// Live sandbox

/** The server SDK throws ApiError with an empty message; surface PayPal's own reason. */
function paypalError(e: unknown): Error {
  if (!(e instanceof ApiError)) return e as Error;
  let reason = "";
  try {
    const body = JSON.parse(String(e.body)) as { name?: string; message?: string; details?: { issue?: string; description?: string }[] };
    const d = body.details?.[0];
    reason = d?.issue ? `${d.issue}: ${d.description ?? ""}` : `${body.name ?? ""} ${body.message ?? ""}`;
  } catch {
    reason = String(e.body ?? "").slice(0, 200);
  }
  return new Error(`PayPal ${e.statusCode} ${reason}`.trim());
}

class LivePayPal implements PayPalAdapter {
  mode = "live" as const;
  reason = "PayPal sandbox";
  private token: { value: string; expires: number } | null = null;
  private client: Client;

  constructor(private id: string, private secret: string) {
    this.client = new Client({
      clientCredentialsAuthCredentials: { oAuthClientId: id, oAuthClientSecret: secret },
      environment: Environment.Sandbox,
      timeout: 20_000,
    });
  }

  async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const oauth = new OAuthAuthorizationController(this.client);
    const basic = Buffer.from(`${this.id}:${this.secret}`).toString("base64");
    const res = await oauth.requestToken({ authorization: `Basic ${basic}` });
    const ttl = Number(res.result.expiresIn ?? 3000n);
    this.token = { value: res.result.accessToken, expires: Date.now() + ttl * 1000 };
    return this.token.value;
  }

  private async rest(path: string, init: RequestInit & { mock?: string } = {}) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "Content-Type": "application/json",
    };
    if (init.mock) headers["PayPal-Mock-Response"] = init.mock;
    const res = await fetch(`${SANDBOX}${path}`, { ...init, headers, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  }

  async createBatch(input: CreateBatchInput): Promise<CreateBatchResult> {
    const { status, body } = await this.rest("/v1/payments/payouts", {
      method: "POST",
      mock: input.simulateFailure ? JSON.stringify({ mock_application_codes: "INSUFFICIENT_FUNDS" }) : undefined,
      body: JSON.stringify({
        sender_batch_header: {
          sender_batch_id: input.senderBatchId,
          email_subject: input.emailSubject,
          email_message: input.emailMessage,
        },
        items: input.items.map((i) => ({
          recipient_type: "EMAIL",
          amount: { value: toDecimalString(i.amountCents), currency: "USD" },
          receiver: i.receiver,
          note: i.note,
          sender_item_id: i.senderItemId,
        })),
      }),
    });
    return status >= 200 && status < 300 ? { ok: true, status, body } : { ok: false, status, body };
  }

  async getBatch(payoutBatchId: string): Promise<GetBatchResponse> {
    const { status, body } = await this.rest(`/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`);
    if (status !== 200) throw new Error(`PayPal GET payout batch ${payoutBatchId} returned ${status}: ${JSON.stringify(body)}`);
    return body;
  }

  async createOrder(amountCents: Cents, description: string) {
    const orders = new OrdersController(this.client);
    const res = await orders.createOrder({
      body: {
        intent: CheckoutPaymentIntent.Capture,
        purchaseUnits: [{ amount: { currencyCode: "USD", value: toDecimalString(amountCents) }, description }],
      },
      prefer: "return=minimal",
    }).catch((e) => {
      throw paypalError(e);
    });
    return { id: res.result.id as string, status: String(res.result.status) };
  }

  async captureOrder(orderId: string): Promise<CapturedOrder> {
    const orders = new OrdersController(this.client);
    const res = await orders.captureOrder({ id: orderId, prefer: "return=representation" }).catch((e) => {
      throw paypalError(e);
    });
    const capture = res.result.purchaseUnits?.[0]?.payments?.captures?.[0];
    return {
      id: res.result.id as string,
      status: String(res.result.status),
      amountCents: capture?.amount?.value ? fromDecimalString(capture.amount.value) : 0,
      payer: res.result.payer?.emailAddress ?? res.result.paymentSource?.paypal?.emailAddress ?? null,
      raw: res.result,
    };
  }
}

// ---------------------------------------------------------------------------
// Mock, backed by fixtures

interface MockBatch {
  input: CreateBatchInput;
  id: string;
  created: string;
  polls: number;
}

declare global {
  var __spendproofMockBatches: Map<string, MockBatch> | undefined;
  var __spendproofMockOrders: Map<string, Cents> | undefined;
}

const mockId = (prefix = "") =>
  prefix +
  Array.from({ length: 13 - prefix.length }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");

export class MockPayPal implements PayPalAdapter {
  mode = "mock" as const;
  constructor(public reason: string) {}
  private get batches(): Map<string, MockBatch> {
    return (globalThis.__spendproofMockBatches ??= new Map<string, MockBatch>());
  }
  private get orders(): Map<string, Cents> {
    return (globalThis.__spendproofMockOrders ??= new Map<string, Cents>());
  }

  async createBatch(input: CreateBatchInput): Promise<CreateBatchResult> {
    if (input.simulateFailure) return { ok: false, status: 422, body: { ...insufficientFixture, debug_id: mockId().toLowerCase() } };
    const id = mockId("M");
    this.batches.set(id, { input, id, created: new Date().toISOString(), polls: 0 });
    const body: CreateBatchResponse = structuredClone(createFixture);
    body.batch_header.payout_batch_id = id;
    body.batch_header.sender_batch_header = {
      sender_batch_id: input.senderBatchId,
      email_subject: input.emailSubject,
      email_message: input.emailMessage,
    };
    body.links[0].href = `${SANDBOX}/v1/payments/payouts/${id}`;
    return { ok: true, status: 201, body };
  }

  async getBatch(payoutBatchId: string): Promise<GetBatchResponse> {
    const b = this.batches.get(payoutBatchId);
    const body: GetBatchResponse = structuredClone(getFixture);
    body.batch_header.payout_batch_id = payoutBatchId;
    if (!b) {
      // Process restarted: the mock has no memory of this batch; report it settled.
      body.items = [];
      return body;
    }
    b.polls++;
    const done = b.polls >= 2;
    const total = b.input.items.reduce((s, i) => s + i.amountCents, 0);
    body.batch_header.batch_status = done ? "SUCCESS" : "PROCESSING";
    body.batch_header.time_created = b.created;
    body.batch_header.sender_batch_header = {
      sender_batch_id: b.input.senderBatchId,
      email_subject: b.input.emailSubject,
      email_message: b.input.emailMessage,
    };
    body.batch_header.amount = { currency: "USD", value: toDecimalString(total) };
    body.batch_header.fees = { currency: "USD", value: toDecimalString(Math.min(25 * b.input.items.length, total)) };
    const template = getFixture.items[0];
    body.items = b.input.items.map((i) => {
      const item = structuredClone(template);
      const itemId = mockId("I");
      item.payout_item_id = itemId;
      item.transaction_id = done ? mockId("T") : "";
      item.transaction_status = done ? "SUCCESS" : "PENDING";
      item.payout_batch_id = payoutBatchId;
      item.payout_item = { ...item.payout_item, amount: { currency: "USD", value: toDecimalString(i.amountCents) }, note: i.note, receiver: i.receiver, sender_item_id: i.senderItemId };
      item.links[0].href = `${SANDBOX}/v1/payments/payouts-item/${itemId}`;
      return item;
    });
    return body;
  }

  async createOrder(amountCents: Cents) {
    const id = mockId("O");
    this.orders.set(id, amountCents);
    return { id, status: orderCreateFixture.status };
  }

  async captureOrder(orderId: string): Promise<CapturedOrder> {
    const amountCents = this.orders.get(orderId) ?? 0;
    const raw = structuredClone(orderCaptureFixture);
    raw.id = orderId;
    raw.purchase_units[0].payments.captures[0].amount.value = toDecimalString(amountCents);
    return { id: orderId, status: raw.status, amountCents, payer: raw.payer.email_address, raw };
  }
}

// ---------------------------------------------------------------------------
// Selection

declare global {
  var __spendproofPayPal: Promise<PayPalAdapter> | undefined;
}

async function select(): Promise<PayPalAdapter> {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (process.env.SPENDPROOF_FORCE_MOCK === "1") return new MockPayPal("Mock mode forced by SPENDPROOF_FORCE_MOCK");
  if (!id || !secret) return new MockPayPal("No PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET");
  const live = new LivePayPal(id, secret);
  try {
    await live.accessToken();
    return live;
  } catch (e) {
    return new MockPayPal(`PayPal sandbox unreachable (${(e as Error).message.slice(0, 80)})`);
  }
}

export function paypal(): Promise<PayPalAdapter> {
  globalThis.__spendproofPayPal ??= select();
  return globalThis.__spendproofPayPal;
}

/** Client id for the PayPal JS SDK buttons (public by design), or null in mock mode. */
export async function paypalClientId(): Promise<string | null> {
  const adapter = await paypal();
  return adapter.mode === "live" ? (process.env.PAYPAL_CLIENT_ID ?? null) : null;
}
