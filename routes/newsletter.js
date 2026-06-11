import { Router } from "express";
import crypto from "crypto";
import { supabase } from "../lib/utils.js";
import { sendNewsletter, unsubscribeToken } from "../lib/email.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE  = /^[0-9a-f]+$/i;

// ── Cron-secret check ──────────────────────────────────────────────────────
// Length-check first because crypto.timingSafeEqual throws on unequal-length
// inputs. Equal-length comparison is constant-time so an attacker cannot
// distinguish "wrong header" from "missing env" via timing.
function cronSecretMatches(provided) {
  const expected = process.env.CRON_SECRET;
  if (!expected || typeof provided !== "string") return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Unsubscribe token verification ─────────────────────────────────────────
function unsubscribeTokenValid(id, providedHex) {
  if (typeof id !== "string" || !UUID_RE.test(id)) return false;
  if (typeof providedHex !== "string" || !HEX_RE.test(providedHex)) return false;
  const secret = process.env.UNSUBSCRIBE_SECRET;
  if (!secret) return false;
  const expectedHex = unsubscribeToken(id, secret);
  const a = Buffer.from(providedHex, "hex");
  const b = Buffer.from(expectedHex, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── POST /api/cron/send-newsletter ─────────────────────────────────────────
router.post("/api/cron/send-newsletter", async (req, res) => {
  if (!cronSecretMatches(req.header("x-cron-secret"))) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const result = await sendNewsletter(req.body || {});
    res.json(result);
  } catch (err) {
    const msg = err?.message || String(err);
    if (msg.startsWith("content")) {
      return res.status(400).json({ error: msg });
    }
    console.error("[newsletter] send error:", msg);
    res.status(500).json({ error: "send failed" });
  }
});

// ── Unsubscribe page response ──────────────────────────────────────────────
const UNSUB_SUCCESS_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unsubscribed</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 80px auto; padding: 0 24px; color: #1a2e1f; line-height: 1.55; }
p { font-size: 17px; }
a { color: #2d6a4f; }
</style>
</head>
<body>
<p>You're unsubscribed. No more emails from me. If this was a mistake, you can sign up again anytime at <a href="https://dishcount.co">dishcount.co</a>.</p>
</body>
</html>`;

const UNSUB_INVALID_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invalid link</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 80px auto; padding: 0 24px; color: #1a2e1f; line-height: 1.55; }
p { font-size: 17px; }
</style>
</head>
<body>
<p>This link is not valid.</p>
</body>
</html>`;

async function applyUnsubscribe(id) {
  try {
    await supabase
      .from("email_subscribers")
      .update({ unsubscribed_at: new Date().toISOString() })
      .eq("id", id)
      .is("unsubscribed_at", null);
  } catch { /* idempotent endpoint, swallow */ }
}

// ── GET /api/unsubscribe ───────────────────────────────────────────────────
router.get("/api/unsubscribe", async (req, res) => {
  const id    = String(req.query?.id    || "");
  const token = String(req.query?.token || "");
  if (!unsubscribeTokenValid(id, token)) {
    return res.status(403).type("html").send(UNSUB_INVALID_PAGE);
  }
  await applyUnsubscribe(id);
  res.status(200).type("html").send(UNSUB_SUCCESS_PAGE);
});

// ── POST /api/unsubscribe (Gmail one-click, RFC 8058) ──────────────────────
router.post("/api/unsubscribe", async (req, res) => {
  const id    = String(req.query?.id    || "");
  const token = String(req.query?.token || "");
  if (!unsubscribeTokenValid(id, token)) {
    return res.status(403).end();
  }
  await applyUnsubscribe(id);
  res.status(200).end();
});

export default router;
