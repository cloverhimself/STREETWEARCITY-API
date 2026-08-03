import { SendByte } from "@sendbyte/node";
import { env } from "./env";
import { logger } from "./logger";

const FROM = env.SENDBYTE_FROM_EMAIL || "no-reply@streetwearcity.com";

const client = env.SENDBYTE_API_KEY ? new SendByte(env.SENDBYTE_API_KEY) : null;

// Email delivery is best-effort: a SendByte outage should never fail the
// register/reset-password request that triggered it, so failures are logged,
// not thrown.
async function send(to: string, subject: string, html: string) {
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

export function sendVerificationEmail(to: string, token: string) {
  const link = `${env.CLIENT_ORIGIN}/verify-email?token=${token}`;
  return send(
    to,
    "Verify your email",
    `<p>Welcome to Streetwear City. Confirm your email to activate your account:</p><p><a href="${link}">${link}</a></p><p>This link expires in 24 hours.</p>`
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
