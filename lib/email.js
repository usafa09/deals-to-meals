import { Resend } from "resend";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "bill@dishcount.co";
const FROM_EMAIL  = process.env.EMAIL_FROM   || "notifications@dishcount.co";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

function supabaseTableLink(table, rowId) {
  // Derive the project ref from SUPABASE_URL (e.g. https://abc123.supabase.co → abc123)
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
