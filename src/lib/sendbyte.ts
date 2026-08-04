import { SendByte } from "@sendbyte/node";
import { env } from "./env";
import { logger } from "./logger";

const FROM = env.SENDBYTE_FROM_EMAIL || "no-reply@streetwearcity.com";

const client = env.SENDBYTE_API_KEY ? new SendByte(env.SENDBYTE_API_KEY) : null;
const testOutbox: Array<{ to: string; subject: string; html: string }> = [];

export function drainTestEmailOutbox() {
  if (env.NODE_ENV !== "test") throw new Error("The test email outbox is only available in test mode");
  return testOutbox.splice(0);
}

// Email delivery is best-effort: a SendByte outage should never fail the
// register/reset-password request that triggered it, so failures are logged,
// not thrown.
async function send(to: string, subject: string, html: string) {
  if (env.NODE_ENV === "test") {
    testOutbox.push({ to, subject, html });
    return;
  }
  if (!client) {
    logger.warn({ to, subject }, "SENDBYTE_API_KEY not set — skipping email send");
    return;
  }
  try {
    await client.emails.send({ from: `Streetwear City <${FROM}>`, to, subject, html });
  } catch (err) {
    logger.error({ err, to, subject }, "SendByte email send failed");
  }
}

export function sendVerificationEmail(to: string, code: string) {
  return send(
    to,
    "Verify your email",
    `<p>Welcome to Streetwear City. Enter this verification code to activate your account:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>This code expires in 15 minutes.</p>`
  );
}

export function sendPasswordResetEmail(to: string, token: string) {
  const link = `${env.CLIENT_ORIGIN}/reset-password?token=${token}`;
  return send(
    to,
    "Reset your password",
    `<p>Use the link below to reset your Streetwear City password:</p><p><a href="${link}">${link}</a></p><p>This link expires in 30 minutes. If you didn't request this, ignore this email.</p>`
  );
}

export function sendOrderStatusEmail(to: string, input: { orderNumber: string; status: "CONFIRMED" | "SHIPPED" | "DELIVERED" }) {
  const copy = {
    CONFIRMED: { subject: `Order ${input.orderNumber} confirmed`, heading: "Payment confirmed", body: "Your payment was confirmed and your order is now being prepared." },
    SHIPPED: { subject: `Order ${input.orderNumber} shipped`, heading: "Your order is on the way", body: "Your Streetwear City order has shipped." },
    DELIVERED: { subject: `Order ${input.orderNumber} delivered`, heading: "Order delivered", body: "Your Streetwear City order has been marked as delivered. We hope you love it." },
  }[input.status];
  return send(to, copy.subject, `<h2>${copy.heading}</h2><p>${copy.body}</p><p>Order: <strong>${input.orderNumber}</strong></p>`);
}
