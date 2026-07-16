# Newsletter Send Runbook

Weekly send process for the Dishcount newsletter. Proven on issue #1 (2026-07-15, 59 recipients, 0 failures).
Internal doc. Not user-facing.

## Overview

- Sends go out **Wednesday**. The weekly deal cron (`weekly-deals.yml`) runs Wed 14:00 UTC (~10:00 AM Eastern, often +60-90 min GitHub drift). Draft AFTER fresh deals land.
- The send pipeline is `POST /api/cron/send-newsletter` on production, authenticated with the `x-cron-secret` header. `CRON_SECRET` is in local `.env` and Render env.
- **Test vs live is decided by the SERVER env var `NEWSLETTER_LIVE` on Render, not by the request.**
  - Unset (default): sends ONE `[TEST]` email to bill.mccormick@dishcount.co. No DB writes.
  - Set to `true`: sends to the entire active subscriber list and logs to `sent_emails`.
- Idempotency: each send is keyed by `template_id`. A live re-POST of the same `template_id` skips anyone already in `sent_emails` for it. Safe against double-sends; still only POST once unless recovering from a partial failure.

## Content format

The send body is a JSON object (not markdown):

```
{
  "template_id": "weekly-YYYY-MM-DD",       // unique per issue
  "subject": "...",                          // ~55 chars max; brand or hook up front (mobile truncates ~40-50)
  "intro": "...",                            // \n\n for paragraph breaks
  "items": [ { "deal": "...", "idea": "..." } x5 ],
  "recipe": { "title", "meta", "ingredients": [], "steps": [] },   // ONE recipe card only
  "outro": "..."
}
```

Editorial rules (user-facing copy):
- Founder "I" voice. No em-dashes. No banned words (robust, seamless, comprehensive, innovative, leverage, passionate about, we believe).
- Real prices from this week's ads only. Quote prices ONLY from Kroger API, Walmart API, or ALDI scraper sources. Never quote OCR-sourced prices without manually checking the actual ad. If a reg-vs-sale spread looks too good (>50% off fresh meat), suspect per-lb/per-tray misclassification and drop the savings claim or the item.
- One "Full recipe below" pointer, on the pick that matches the recipe card.
- Bill does a ~20 minute editorial pass on every issue. AI draft is never final.

## Weekly sequence

1. **Wed morning:** confirm the deal cron succeeded (GitHub Actions) and SSR pages show current "Week of" date with real deal counts: /deals/kroger, /deals/aldi, /deals/walmart.
2. **Draft** newsletter-content.json from live deal data. Pull candidate recipes from the SSR pages' JSON-LD (pre-generated pipeline recipes) rather than inventing new ones.
3. **Content gate** (run before every send, test or live):
   ```
   node -e "const c=require('./newsletter-content.json'); console.log('subject:', c.subject); console.log('recipe:', c.recipe.title); console.log('items:', c.items.length, '| steps:', c.recipe.steps.length)"
   ```
   Compare against the intended issue. Any mismatch = stale file. Fix the file, never fudge the gate.
4. **Test send** (NEWSLETTER_LIVE must NOT be set on Render. Verify in dashboard, don't assume):
   ```powershell
   $secret = (Get-Content .env | Where-Object { $_ -match '^CRON_SECRET=' }) -replace '^CRON_SECRET=', ''
   $body = Get-Content .\newsletter-content.json -Raw
   Invoke-RestMethod -Method Post -Uri "https://dishcount.co/api/cron/send-newsletter" -Headers @{ "x-cron-secret" = "$secret" } -ContentType "application/json" -Body $body
   ```
   Expect `{"recipients":1,"sent":1,"skipped":0,"failed":0}`.
5. **Inbox check** on the [TEST]: logo renders in header, phone layout, copy reads right, unsubscribe link works. If you complete the unsubscribe while testing, RESET YOUR ROW in email_subscribers before the live send.
6. **Pre-live checks:** RLS enabled on `email_subscribers`; own subscriber row active.
7. **Go live:** Render → service → Environment → add `NEWSLETTER_LIVE` = `true` (lowercase) → Save. Wait for restart to fully complete (~100s).
8. **POST once** (same command). Expect `recipients` = active subscriber count, `failed` = 0.
9. **Immediately unset:** delete `NEWSLETTER_LIVE` from Render env, save, let it restart. The safety goes back on before anything else.
10. **Verify:** `sent_emails` rows = recipients count for this `template_id`; Resend dashboard for bounces/complaints over the next hour. Retire hard-bounce subscriber rows before next issue.

## Failure handling

- 401: secret mismatch. 5xx or connection error: check Render isn't mid-restart.
- `failed` > 0: do NOT blind-retry. Inspect `sent_emails` and the verbatim response first. The template_id guard makes a targeted re-POST safe for anyone not already marked sent.
- Never edit lib/email.js or routes/newsletter.js on send day.

## Claude Code guardrails (paste into any send task)

- Never print, echo, or log CRON_SECRET.
- Never set, unset, or read NEWSLETTER_LIVE. That is Bill's manual Render step.
- Live sends require Bill's explicit go in chat. An automated event completing is not a go.
- Content gate must pass exactly before any POST. Never edit the JSON to make a gate pass.
- Exactly one POST per instruction. No code changes, no commits, unless the task says otherwise.
