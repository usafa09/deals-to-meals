import { Resend } from "resend";
import crypto from "crypto";
import { supabase } from "./utils.js";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "bill@dishcount.co";
const FROM_EMAIL  = process.env.EMAIL_FROM   || "notifications@dishcount.co";

const NEWSLETTER_FROM     = "Bill from Dishcount <bill.mccormick@dishcount.co>";
const TEST_RECIPIENT      = "bill.mccormick@dishcount.co";
const UNSUBSCRIBE_BASE    = "https://dishcount.co/api/unsubscribe";
const BATCH_CHUNK_SIZE    = 100;

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ── HMAC token helper ───────────────────────────────────────────────────────
// Exported so verification and tests can reproduce a token from a known id and
// secret. Verification of an incoming token lives in routes/newsletter.js where
// it is compared with crypto.timingSafeEqual.
export function unsubscribeToken(id, secret) {
  return crypto.createHmac("sha256", String(secret || "")).update(String(id || "")).digest("hex");
}

export function unsubscribeUrlFor(id, secret) {
  return `${UNSUBSCRIBE_BASE}?id=${encodeURIComponent(id)}&token=${unsubscribeToken(id, secret)}`;
}

// ── Template builders ───────────────────────────────────────────────────────
// Plain on purpose. Single column, inline CSS only, system fonts, no images.
// No em-dashes anywhere in literal copy.

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const FOOTER_ADDRESS_PLACEHOLDER =
  "Dishcount LLC, 6545 Market Ave N Ste 100, Canton, OH 44721";

export function buildNewsletterHtml(content, unsubscribeUrl) {
  const intro = escapeHtml(content.intro);
  const outro = content.outro ? escapeHtml(content.outro) : null;
  const itemsHtml = (content.items || [])
    .map(it => `      <li style="margin:0 0 18px;line-height:1.55;"><strong>${escapeHtml(it.deal)}</strong><br>${escapeHtml(it.idea)}</li>`)
    .join("\n");
  const unsubAttr = escapeHtml(unsubscribeUrl);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(content.subject)}</title>
</head>
<body style="margin:0;padding:24px 12px;background:#ffffff;color:#1a2e1f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;">
  <div style="max-width:600px;margin:0 auto;">
    <p style="margin:0 0 16px;">${intro}</p>
    <ol style="padding-left:24px;margin:0 0 20px;">
${itemsHtml}
    </ol>
${outro ? `    <p style="margin:0 0 16px;">${outro}</p>\n` : ""}    <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0 16px;">
    <p style="font-size:13px;color:#666;margin:0;">
      You're getting this because you signed up at dishcount.co.<br>
      Unsubscribe: <a href="${unsubAttr}" style="color:#2d6a4f;">${unsubAttr}</a><br>
      ${escapeHtml(FOOTER_ADDRESS_PLACEHOLDER)}
    </p>
  </div>
</body>
</html>`;
}

export function buildNewsletterText(content, unsubscribeUrl) {
  const lines = [];
  lines.push(String(content.intro || "").trim());
  lines.push("");
  (content.items || []).forEach((it, i) => {
    lines.push(`${i + 1}. ${it.deal}`);
    lines.push(`   ${it.idea}`);
    lines.push("");
  });
  if (content.outro) {
    lines.push(String(content.outro).trim());
    lines.push("");
  }
  lines.push("---");
  lines.push("You're getting this because you signed up at dishcount.co.");
  lines.push(`Unsubscribe: ${unsubscribeUrl}`);
  lines.push(FOOTER_ADDRESS_PLACEHOLDER);
  return lines.join("\n");
}

// ── Validation ──────────────────────────────────────────────────────────────

function validateContent(content) {
  if (!content || typeof content !== "object") throw new Error("content: object required");
  const requireString = (field) => {
    const v = content[field];
    if (typeof v !== "string" || v.trim() === "") throw new Error(`content.${field}: non-empty string required`);
  };
  requireString("template_id");
  requireString("subject");
  requireString("intro");

  if (!Array.isArray(content.items)) throw new Error("content.items: array required");
  if (content.items.length < 1 || content.items.length > 10) {
    throw new Error("content.items: must contain between 1 and 10 entries");
  }
  content.items.forEach((it, i) => {
    if (!it || typeof it !== "object") throw new Error(`content.items[${i}]: object required`);
    if (typeof it.deal !== "string" || it.deal.trim() === "") throw new Error(`content.items[${i}].deal: non-empty string required`);
    if (typeof it.idea !== "string" || it.idea.trim() === "") throw new Error(`content.items[${i}].idea: non-empty string required`);
  });

  if (content.outro !== undefined && content.outro !== null && typeof content.outro !== "string") {
    throw new Error("content.outro: string when present");
  }
}

// ── sendNewsletter ──────────────────────────────────────────────────────────
// Test mode (default): sends one [TEST] copy to Bill, no DB writes.
// Live mode: NEWSLETTER_LIVE === "true". Excludes already-sent subscriber_ids
// for this template_id, batch-sends the rest, and logs every attempt to
// sent_emails. Returns { recipients, sent, skipped, failed }.

export async function sendNewsletter(content) {
  validateContent(content);
  if (!resend) throw new Error("RESEND_API_KEY not set");
  if (!supabase) throw new Error("Supabase client unavailable (SUPABASE_URL not set)");

  const secret = process.env.UNSUBSCRIBE_SECRET;
  if (!secret) throw new Error("UNSUBSCRIBE_SECRET not set");

  const live = process.env.NEWSLETTER_LIVE === "true";

  // Live-mode guard: refuse to send while the postal-address placeholder is
  // still present in the rendered footer. Renders against a stub URL so the
  // check covers both the literal placeholder and any future template change
  // that fails to substitute it.
  if (live) {
    const sampleUrl = `${UNSUBSCRIBE_BASE}?id=00000000-0000-0000-0000-000000000000&token=preflight`;
    if (buildNewsletterHtml(content, sampleUrl).includes("[POSTAL ADDRESS")) {
      throw new Error("Refusing live send: postal address placeholder still in footer.");
    }
  }

  // 1. Build the recipient list
  let recipientPool;
  let skipped = 0;

  if (!live) {
    // Test mode: single recipient is Bill. Try to use his real subscriber row
    // so the unsubscribe token round-trips against a real id, but fall back to
    // a synthetic UUID if his email is not on the list yet.
    const { data: row } = await supabase
      .from("email_subscribers")
      .select("id")
      .eq("email", TEST_RECIPIENT)
      .maybeSingle();
    const id = row?.id || crypto.randomUUID();
    recipientPool = [{ id, email: TEST_RECIPIENT }];
  } else {
    const { data: active, error: subsErr } = await supabase
      .from("email_subscribers")
      .select("id, email")
      .is("unsubscribed_at", null);
    if (subsErr) throw new Error(`subscriber fetch failed: ${subsErr.message}`);

    const total = active?.length || 0;

    // Idempotency: skip subscriber_ids already logged for this template_id.
    const { data: prior, error: priorErr } = await supabase
      .from("sent_emails")
      .select("subscriber_id")
      .eq("template_id", content.template_id)
      .eq("status", "sent");
    if (priorErr) throw new Error(`sent_emails lookup failed: ${priorErr.message}`);
    const sentIds = new Set((prior || []).map(r => r.subscriber_id));

    recipientPool = (active || []).filter(s => !sentIds.has(s.id));
    skipped = total - recipientPool.length;
  }

  const recipients = recipientPool.length + skipped;
  if (recipientPool.length === 0) {
    return { recipients, sent: 0, skipped, failed: 0 };
  }

  // 2. Build payloads, send in chunks of BATCH_CHUNK_SIZE
  const subject = live ? content.subject : `[TEST] ${content.subject}`;
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < recipientPool.length; i += BATCH_CHUNK_SIZE) {
    const chunk = recipientPool.slice(i, i + BATCH_CHUNK_SIZE);
    const payloads = chunk.map(sub => {
      const url = unsubscribeUrlFor(sub.id, secret);
      return {
        from: NEWSLETTER_FROM,
        to: sub.email,
        subject,
        html: buildNewsletterHtml(content, url),
        text: buildNewsletterText(content, url),
        headers: {
          "List-Unsubscribe": `<${url}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      };
    });

    let batchResp = null;
    let batchErr = null;
    try {
      batchResp = await resend.batch.send(payloads);
      if (batchResp?.error) batchErr = batchResp.error;
    } catch (err) {
      batchErr = err;
    }

    const idArray = Array.isArray(batchResp?.data?.data) ? batchResp.data.data : [];
    const chunkSucceeded = !batchErr;

    if (chunkSucceeded) sent += chunk.length;
    else failed += chunk.length;

    // Live mode only: write one sent_emails row per recipient in the chunk.
    if (live) {
      const errMsg = batchErr ? String(batchErr?.message || batchErr).slice(0, 1000) : null;
      const auditRows = chunk.map((sub, idx) => ({
        subscriber_id: sub.id,
        template_id: content.template_id,
        resend_message_id: chunkSucceeded ? (idArray[idx]?.id || null) : null,
        status: chunkSucceeded ? "sent" : "failed",
        error_message: errMsg,
      }));
      const { error: insertErr } = await supabase.from("sent_emails").insert(auditRows);
      if (insertErr) {
        console.error(`[newsletter] sent_emails insert failed for chunk ${Math.floor(i / BATCH_CHUNK_SIZE) + 1} (${chunk.length} rows): ${insertErr.message}`);
      }
    }
  }

  return { recipients, sent, skipped, failed };
}

// ── notifyStoreRequest (untouched from main) ────────────────────────────────

function supabaseTableLink(table, rowId) {
  const ref = (process.env.SUPABASE_URL || "").match(/^https:\/\/([^.]+)\.supabase\.co/)?.[1];
  if (!ref) return null;
  const base = `https://supabase.com/dashboard/project/${ref}/editor`;
  return rowId ? `${base}?table=${table}&filter=id%3Aeq%3A${rowId}` : `${base}?table=${table}`;
}

function fmtEastern(d) {
  return new Date(d).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short", year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
  });
}

export async function notifyStoreRequest({ id, store_name, zip, created_at }) {
  if (!resend) {
    console.warn(`[${new Date().toISOString()}] RESEND_API_KEY not set — skipping store-request email for "${store_name}" (${zip})`);
    return;
  }
  const subject = `New store request: ${store_name} (${zip})`;
  const link = supabaseTableLink("store_requests", id);
  const body = [
    "A new store request was submitted on Dishcount.",
    "",
    `Store: ${store_name}`,
    `Zip: ${zip}`,
    `Submitted: ${fmtEastern(created_at || new Date())}`,
    `Request ID: ${id ?? "(unknown)"}`,
    "",
    `View in Supabase: ${link || "(SUPABASE_URL not set — cannot build dashboard link)"}`,
  ].join("\n");

  try {
    await resend.emails.send({ from: FROM_EMAIL, to: ADMIN_EMAIL, subject, text: body });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Failed to send store-request email for "${store_name}" (${zip}):`, err?.message || err);
  }
}
