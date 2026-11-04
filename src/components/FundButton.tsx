"use client";

import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { act } from "@/lib/client";

/**
 * PayPal JS SDK buttons — the one place a person pays: topping up the balance
 * the agent pays out from. Browser-only, so it is loaded with dynamic import
 * and ssr: false. In mock mode a look-alike button runs the same server flow.
 */
export default function FundButton({
  clientId, amountCents, onDone, onError,
}: {
  clientId: string | null;
  amountCents: number;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  if (!clientId) {
    return (
      <button
        type="button"
        className="btn lg"
        style={{ background: "#ffc439", borderColor: "#ffc439", color: "#111", width: "100%" }}
        onClick={async () => {
          try {
            const order = await act<{ id: string }>({ type: "fundCreate", amountCents });
            await act({ type: "fundCapture", orderId: order.id });
            onDone();
          } catch (e) {
            onError((e as Error).message);
          }
        }}
      >
        <b style={{ fontStyle: "italic", color: "#003087" }}>Pay</b>
        <b style={{ fontStyle: "italic", color: "#009cde", marginLeft: -6 }}>Pal</b>
        <span className="small">(mock checkout)</span>
      </button>
    );
  }
  return (
    <PayPalScriptProvider options={{ clientId, currency: "USD", intent: "capture", disableFunding: "paylater,card" }}>
      <PayPalButtons
        style={{ layout: "horizontal", height: 40, tagline: false, label: "pay" }}
        forceReRender={[amountCents]}
        createOrder={async () => {
          const order = await act<{ id: string }>({ type: "fundCreate", amountCents });
          return order.id;
        }}
        onApprove={async (data) => {
          await act({ type: "fundCapture", orderId: data.orderID });
          onDone();
        }}
        onError={(err) => onError(String((err as { message?: string })?.message ?? err))}
      />
    </PayPalScriptProvider>
  );
}
