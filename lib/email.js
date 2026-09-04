import { Resend } from "resend";
import crypto from "crypto";
import { supabase, diagnoseStoreRequest } from "./utils.js";

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
  const intro = escapeHtml(content.intro).replace(/\n/g, "<br>");
  const outro = content.outro ? escapeHtml(content.outro).replace(/\n/g, "<br>") : null;
  const unsubAttr = escapeHtml(unsubscribeUrl);

  // Shared by the picks list and the optional extras block so both render as the
  // same bold-deal-plus-idea row.
  const renderItems = (items) => (items || [])
    .map(it => `
      <tr>
        <td style="padding:0 0 18px;">
          <div style="font-weight:700;color:#1a2e1f;line-height:1.45;">${escapeHtml(it.deal)}</div>
          <div style="color:#4a463d;line-height:1.55;margin-top:3px;">${escapeHtml(it.idea)}</div>
        </td>
      </tr>`)
    .join("");

  const itemsHtml = renderItems(content.items);

  // content.recipes (array) is the current shape. content.recipe (single) stays
  // supported so earlier issue payloads still render. Steps are optional: a
  // budget card can be an assembly list with nothing to cook.
  const recipes = Array.isArray(content.recipes) ? content.recipes : (content.recipe ? [content.recipe] : []);
  const recipeHtml = recipes.map(r => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF6EE;border:1px solid #EDE6D4;border-radius:12px;margin:8px 0 24px;">
      <tr><td style="padding:20px 22px;">
        <div style="font-size:11px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;color:#d97706;">${escapeHtml(r.label || "Make this one")}</div>
        <div style="font-size:20px;font-weight:800;color:#2d6a4f;line-height:1.25;margin:4px 0 2px;">${escapeHtml(r.title)}</div>
        ${r.meta ? `<div style="font-size:13px;color:#6b6b6b;margin-bottom:14px;">${escapeHtml(r.meta)}</div>` : ""}
        <div style="font-size:12px;letter-spacing:0.6px;text-transform:uppercase;font-weight:700;color:#6b6b6b;margin:12px 0 6px;">Ingredients</div>
        <ul style="margin:0 0 14px;padding-left:20px;color:#1a2e1f;line-height:1.6;">
          ${r.ingredients.map(x => `<li>${escapeHtml(x)}</li>`).join("")}
        </ul>
        ${Array.isArray(r.steps) && r.steps.length ? `<div style="font-size:12px;letter-spacing:0.6px;text-transform:uppercase;font-weight:700;color:#6b6b6b;margin:0 0 6px;">Steps</div>
        <ol style="margin:0;padding-left:20px;color:#1a2e1f;line-height:1.6;">
          ${r.steps.map(x => `<li style="margin-bottom:6px;">${escapeHtml(x)}</li>`).join("")}
        </ol>` : ""}
      </td></tr>
    </table>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(content.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#F4F1E8;color:#1a2e1f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F1E8;">
    <tr><td align="center" style="padding:20px 12px;">

      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;">

        <!-- Header. The wordmark is TEXT, not an image, so it survives image blocking.
             The icon is a hosted PNG because email clients strip inline SVG. -->
        <tr>
          <td style="background:#1a2e1f;padding:20px 24px;" align="center">
            <!-- email-logo-96.png is the dark full-bleed mark, drawn for the dark header:
                 the D-plate sits on its own dark ground so it reads against #1a2e1f.
                 NOT /icons/icon-*.png. Every file in /icons/ is a BLANK flat green
                 square with no logo drawn on it (1 distinct color). -->
            <img src="https://dishcount.co/email-logo-96.png" width="40" height="40" alt="Dishcount" style="display:inline-block;vertical-align:middle;border:0;border-radius:8px;">
            <span style="display:inline-block;vertical-align:middle;margin-left:10px;font-size:24px;font-weight:800;letter-spacing:-0.3px;">
              <span style="color:#e8f0ea;">Dish</span><span style="color:#d97706;">count</span>
            </span>
            <div style="color:#8fb89a;font-size:11px;letter-spacing:1.4px;text-transform:uppercase;margin-top:4px;">Meals from Deals</div>
          </td>
        </tr>

        <tr><td style="padding:26px 24px 0;">
          <p style="margin:0 0 20px;">${intro}</p>

          <div style="font-size:12px;letter-spacing:0.6px;text-transform:uppercase;font-weight:700;color:#6b6b6b;margin:0 0 12px;">This week's picks</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${itemsHtml}
          </table>
${recipeHtml}
          <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:4px auto 24px;">
            <tr><td style="background:#d97706;border-radius:999px;">
              <a href="https://dishcount.co" style="display:inline-block;padding:13px 28px;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;">See deals near you &rarr;</a>
            </td></tr>
          </table>

${content.extras ? `<div style="font-size:12px;letter-spacing:0.6px;text-transform:uppercase;font-weight:700;color:#6b6b6b;margin:0 0 12px;">${escapeHtml(content.extras.heading)}</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${renderItems(content.extras.items)}</table>` : ""}
${outro ? `          <p style="margin:0 0 20px;">${outro}</p>\n` : ""}        </td></tr>

        <tr><td style="padding:0 24px 24px;">
          <hr style="border:none;border-top:1px solid #EDE6D4;margin:0 0 14px;">
          <p style="font-size:13px;color:#4a463d;margin:0 0 12px;line-height:1.6;">
            Follow along &nbsp;&middot;&nbsp; <a href="https://www.facebook.com/dishcountapp/" style="color:#2d6a4f;font-weight:600;text-decoration:none;">Facebook</a> &nbsp;&middot;&nbsp; <a href="https://www.pinterest.com/dishcountapp/" style="color:#2d6a4f;font-weight:600;text-decoration:none;">Pinterest</a>
          </p>
          <p style="font-size:12px;color:#8a8a8a;margin:0;line-height:1.6;">
            You're getting this because you signed up at dishcount.co.<br>
            <a href="${unsubAttr}" style="color:#2d6a4f;">Unsubscribe</a><br>
            ${escapeHtml(FOOTER_ADDRESS_PLACEHOLDER)}
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
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
  const recipes = Array.isArray(content.recipes) ? content.recipes : (content.recipe ? [content.recipe] : []);
  recipes.forEach(r => {
    lines.push(String(r.label || "Make this one").toUpperCase());
    lines.push(r.title);
    if (r.meta) lines.push(r.meta);
    lines.push("");
    lines.push("Ingredients:");
    r.ingredients.forEach(x => lines.push(`  - ${x}`));
    lines.push("");
    if (Array.isArray(r.steps) && r.steps.length) {
      lines.push("Steps:");
      r.steps.forEach((x, i) => lines.push(`  ${i + 1}. ${x}`));
      lines.push("");
    }
  });

  lines.push("See deals near you: https://dishcount.co");
  lines.push("Follow along: Facebook facebook.com/dishcountapp | Pinterest pinterest.com/dishcountapp");
  lines.push("");

  if (content.extras) {
    lines.push(String(content.extras.heading).toUpperCase());
    (content.extras.items || []).forEach((it, i) => { lines.push(`${i + 1}. ${it.deal}`); lines.push(`   ${it.idea}`); lines.push(""); });
  }

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

  // Shared by content.items and the optional content.extras.items list.
  const validateItems = (arr, path) => {
    if (!Array.isArray(arr)) throw new Error(`${path}: array required`);
    if (arr.length < 1 || arr.length > 10) {
      throw new Error(`${path}: must contain between 1 and 10 entries`);
    }
    arr.forEach((it, i) => {
      if (!it || typeof it !== "object") throw new Error(`${path}[${i}]: object required`);
      if (typeof it.deal !== "string" || it.deal.trim() === "") throw new Error(`${path}[${i}].deal: non-empty string required`);
      if (typeof it.idea !== "string" || it.idea.trim() === "") throw new Error(`${path}[${i}].idea: non-empty string required`);
    });
  };

  validateItems(content.items, "content.items");

  if (content.outro !== undefined && content.outro !== null && typeof content.outro !== "string") {
    throw new Error("content.outro: string when present");
  }

  // Optional closing list block, same row shape as the picks list.
  if (content.extras !== undefined && content.extras !== null) {
    const e = content.extras;
    if (typeof e !== "object" || e === null) throw new Error("content.extras: object when present");
    if (typeof e.heading !== "string" || e.heading.trim() === "") throw new Error("content.extras.heading: non-empty string required");
    validateItems(e.items, "content.extras.items");
  }

  // Optional recipe block. The newsletter promises meal ideas, so it should be
  // able to carry one full recipe the reader can cook without clicking anything.
  // content.recipes carries 1 to 3 cards. content.recipe (single) stays valid so
  // earlier issue payloads still pass. Steps are optional per card: a budget card
  // is an assembly list with nothing to cook.
  const validateRecipe = (r, path) => {
    if (typeof r !== "object" || r === null) throw new Error(`${path}: object when present`);
    if (typeof r.title !== "string" || r.title.trim() === "") throw new Error(`${path}.title: non-empty string required`);
    if (!Array.isArray(r.ingredients) || r.ingredients.length < 1) throw new Error(`${path}.ingredients: non-empty array required`);
    r.ingredients.forEach((x, i) => { if (typeof x !== "string" || !x.trim()) throw new Error(`${path}.ingredients[${i}]: non-empty string required`); });
    if (r.steps !== undefined && r.steps !== null) {
      if (!Array.isArray(r.steps) || r.steps.length < 1) throw new Error(`${path}.steps: non-empty array when present`);
      r.steps.forEach((x, i) => { if (typeof x !== "string" || !x.trim()) throw new Error(`${path}.steps[${i}]: non-empty string required`); });
    }
    if (r.meta !== undefined && r.meta !== null && typeof r.meta !== "string") throw new Error(`${path}.meta: string when present`);
    if (r.label !== undefined && r.label !== null && typeof r.label !== "string") throw new Error(`${path}.label: string when present`);
  };

  if (content.recipes !== undefined && content.recipes !== null) {
    if (!Array.isArray(content.recipes) || content.recipes.length < 1 || content.recipes.length > 3) throw new Error("content.recipes: array of 1 to 3 entries when present");
    content.recipes.forEach((r, i) => validateRecipe(r, `content.recipes[${i}]`));
  } else if (content.recipe !== undefined && content.recipe !== null) {
    validateRecipe(content.recipe, "content.recipe");
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

// ── notifyTermsDrift ────────────────────────────────────────────────────────
// The terms of a source we depend on changed. This reports the fact and
// nothing else: no attempt to read the diff, no judgment about whether the new
// terms still permit the use, and no effect on extraction. A human decides.
export async function notifyTermsDrift(changes) {
  if (!changes?.length) return;
  if (!resend) {
    console.warn(`[${new Date().toISOString()}] RESEND_API_KEY not set — skipping terms-drift email for ${changes.map(c => c.id).join(", ")}`);
    return;
  }
  const subject = `Terms changed: ${changes.map(c => c.id).join(", ")}`;
  const body = [
    "The terms page of a source Dishcount depends on has changed since the last check.",
    "",
    "This is a notification, not a verdict. Nothing has been blocked and extraction",
    "is unaffected. Read the page and decide whether the source can still be used.",
    "",
    ...changes.flatMap(c => [
      `Source:   ${c.id}`,
      `URL:      ${c.url}`,
      `Baseline: ${c.expected}  (captured ${c.capturedAt})`,
      `Now:      ${c.actual}`,
      "",
    ]),
    "If the change is acceptable, update the baseline hash in lib/utils.js",
    "(SOURCE_TERMS) and note the date it was re-captured.",
  ].join("\n");
  try {
    await resend.emails.send({ from: FROM_EMAIL, to: ADMIN_EMAIL, subject, text: body });
    console.log(`[${new Date().toISOString()}] terms-drift email sent for ${changes.map(c => c.id).join(", ")}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Failed to send terms-drift email:`, err?.message || err);
  }
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

// Subject-line verdicts, so a request triages from the inbox unopened.
const REQUEST_VERDICT_LABEL = {
  ONE_ROW_AWAY: "ONE ROW AWAY",
  STALE_CACHE: "stale cache",
  ALREADY_SERVING: "already serving",
  NO_SOURCE: "no source",
};

function requestVerdictLines(d) {
  if (!d) return ["Diagnosis: unavailable. The check failed; the request itself is unaffected."];
  if (d.verdict === "ONE_ROW_AWAY") return [
    "Diagnosis: ONE ROW AWAY.",
    `A weeklyad source exists (${d.subdomain}.weeklyad.us.com) but no ad_regions banner covers this`,
    "zip3, so the region filter discards every row it would produce.",
    "",
    "To fix, insert one ad_regions row:",
    `  zip3  ${d.zip3}`,
    `  store ${d.slug}`,
  ];
  if (d.verdict === "STALE_CACHE") return [
    "Diagnosis: stale cache.",
    "The region covers this chain and a source exists, but the cached rows are expired or absent",
    `(adValidTo ${d.adValidTo || "none"}, cache age ${d.cacheAgeHours == null ? "no row" : d.cacheAgeHours + "h"}).`,
    `To fix, re-extract ${d.slug}.`,
  ];
  if (d.verdict === "ALREADY_SERVING") return [
    "Diagnosis: already serving.",
    `${d.slug} already returns ${d.dealCount} deals for this zip, so this is a UI problem, not a data one.`,
  ];
  return [
    "Diagnosis: no source.",
    `${d.slug} is not in the source map and has no weeklyad subdomain. Log the demand, nothing to extract.`,
  ];
}

export async function notifyStoreRequest({ id, store_name, zip, created_at }) {
  if (!resend) {
    console.warn(`[${new Date().toISOString()}] RESEND_API_KEY not set — skipping store-request email for "${store_name}" (${zip})`);
    return;
  }
  // The diagnosis is an enrichment, never a precondition. If it throws, the
  // email sends exactly as it sent before it existed.
  let diagnosis = null;
  try {
    diagnosis = await diagnoseStoreRequest(store_name, zip);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] diagnoseStoreRequest failed for "${store_name}" (${zip}):`, err?.message || err);
  }
  const label = diagnosis ? REQUEST_VERDICT_LABEL[diagnosis.verdict] : null;
  const subject = label
    ? `Store request: ${store_name} (${zip}) - ${label}`
    : `New store request: ${store_name} (${zip})`;
  const link = supabaseTableLink("store_requests", id);
  const body = [
    "A new store request was submitted on Dishcount.",
    "",
    `Store: ${store_name}`,
    `Zip: ${zip}`,
    `Submitted: ${fmtEastern(created_at || new Date())}`,
    `Request ID: ${id ?? "(unknown)"}`,
    "",
    ...requestVerdictLines(diagnosis),
    "",
    `View in Supabase: ${link || "(SUPABASE_URL not set — cannot build dashboard link)"}`,
  ].join("\n");

  try {
    await resend.emails.send({ from: FROM_EMAIL, to: ADMIN_EMAIL, subject, text: body });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Failed to send store-request email for "${store_name}" (${zip}):`, err?.message || err);
  }
}
