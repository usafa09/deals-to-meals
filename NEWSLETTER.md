# Newsletter Send Runbook

Weekly send process for the Dishcount newsletter. Proven on issue #1 (2026-07-15, 59 recipients, 0 failures)
and issue #3 (2026-09-04, 73 recipients, 0 failures).
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
  "items": [ { "deal": "...", "idea": "..." } ],             // 1 to 10. Renders under "This week's picks"
  "recipes": [                                               // 1 to 3 cards, rendered in order
    { "label": "The splurge", "title": "...", "meta": "...", "ingredients": [], "steps": [] },
    { "label": "The budget cookout", "title": "...", "meta": "...", "ingredients": [] }
  ],
  "extras": {                                                // optional second list, same row shape
    "heading": "Worth stocking up on",
    "items": [ { "deal": "...", "idea": "..." } ]            // 1 to 10
  },
  "outro": "..."
}
```

Field notes:
- `recipes` (array) is the current shape. `recipe` (a single object) still validates and renders, so the
  issue #1 and #2 payloads replay unchanged. If both keys are present, `recipes` wins and `recipe` is ignored.
- `label` is optional per card, defaulting to "Make this one". With more than one card, label them, or every
  card carries the same heading.
- `steps` is optional per card. A card without steps renders its ingredients and no Steps heading. That is the
  point of a budget or assembly card.
- `extras` is optional. It renders after the "See deals near you" button and before the outro.
- Limits enforced by `validateContent` in lib/email.js: `items` 1 to 10, `extras.items` 1 to 10, `recipes` 1 to 3.
  A bad payload throws with the exact field path, e.g. `content.recipes[1].title: non-empty string required`.
- Header logo is `public/email-logo-96.png`, the dark full-bleed mark drawn for the dark header. NOT
  apple-touch-icon.png (the old light mark) and NOT /icons/icon-*.png (blank green squares, no logo drawn).
- Known wrinkle: in the HTML the extras block sits above the follow-along footer, in the plain-text part it sits
  below the "Follow along:" line. Cosmetic, and only visible in text-only clients.

Editorial rules (user-facing copy):
- Founder "I" voice. No em-dashes. No banned words (robust, seamless, comprehensive, innovative, leverage, passionate about, we believe).
- Real prices from this week's ads only. Quote prices ONLY from Kroger API, Walmart API, or ALDI scraper sources. Never quote OCR-sourced prices without manually checking the actual ad. If a reg-vs-sale spread looks too good (>50% off fresh meat), suspect per-lb/per-tray misclassification and drop the savings claim or the item.
- One "Full recipe below" pointer, on the pick that matches a recipe card. With two cards, point at the splurge.
- Do not repeat the extras entries in the outro. They used to be outro prose; they are their own block now.
- Bill does a ~20 minute editorial pass on every issue. AI draft is never final.

## Weekly sequence

1. **Wed morning:** confirm the deal cron succeeded (GitHub Actions) and SSR pages show current "Week of" date with real deal counts: /deals/kroger, /deals/aldi, /deals/walmart.
2. **Draft** newsletter-content.json from live deal data. Pull candidate recipes from the SSR pages' JSON-LD (pre-generated pipeline recipes) rather than inventing new ones.
3. **Content gate** (run before every send, test or live):
   ```
   node -e "const c=require('./newsletter-content.json'); console.log('template_id:', c.template_id); console.log('subject:', c.subject); console.log('cards:', c.recipes.map(r=>r.label+' / '+r.title).join(' | ')); console.log('items:', c.items.length, '| steps:', c.recipes[0].steps.length); console.log('extras:', c.extras.heading, '|', c.extras.items.length); console.log('outro starts:', c.outro.slice(0,19))"
   ```
   Compare against the intended issue. Any mismatch = stale file. Fix the file, never fudge the gate.
   Keep the `outro starts:` line. A title-only gate passes happily after copy has been moved between blocks,
   which is exactly the edit most likely to happen during the editorial pass. Drop the `cards`/`extras` lines
   for an issue that does not use those fields, and say so in the task rather than letting the gate error.
4. **List hygiene** (read-only, before every live send). Query `email_subscribers` where `unsubscribed_at IS NULL`.
   Report the active count, and flag any address containing example.com, example.org, test.com, mailinator or
   localhost, or with no `@`, more than one `@`, embedded whitespace, or a trailing dot. On 2026-08-19 a single
   example.com row made Resend reject the entire batch, and batch pre-filtering was never shipped, so this query
   is the guard. The active count is also what `recipients` must equal in step 9.
5. **Test send** (NEWSLETTER_LIVE must NOT be set on Render. Verify in dashboard, don't assume):
   ```powershell
   $secret = (Get-Content .env | Where-Object { $_ -match '^CRON_SECRET=' }) -replace '^CRON_SECRET=', ''
   $body = Get-Content .\newsletter-content.json -Raw
   Invoke-RestMethod -Method Post -Uri "https://dishcount.co/api/cron/send-newsletter" -Headers @{ "x-cron-secret" = "$secret" } -ContentType "application/json" -Body $body
   ```
   Expect `{"recipients":1,"sent":1,"skipped":0,"failed":0}`.
   If the template changed since the last deploy, wait for Render to finish first. A 200 on an asset that already
   existed proves the site is up, not that the newest commit is live, and there is no version endpoint to check.
   The [TEST] email itself is the only real proof: a payload field the deployed code does not know about is
   ignored in silence, not rejected.
6. **Inbox check** on the [TEST]: header logo renders, phone layout, copy reads right, unsubscribe link works.
   Every recipe card present and carrying the right label; a card with no `steps` shows no Steps heading; the
   extras block sits between the CTA button and the outro, and its entries are not also repeated in the outro.
   If you complete the unsubscribe while testing, RESET YOUR ROW in email_subscribers before the live send.
7. **Pre-live checks:** RLS enabled on `email_subscribers`; own subscriber row active.
8. **Go live:** Render → service → Environment → add `NEWSLETTER_LIVE` = `true` (lowercase) → Save. Wait for restart to fully complete (~100s).
9. **POST once** (same command). Expect `recipients` = the active count from step 4, `failed` = 0. `skipped` is 0
   for a first live POST: test sends do not write `sent_emails`, so no one is marked sent by them.
10. **Immediately unset:** delete `NEWSLETTER_LIVE` from Render env, save, let it restart. The safety goes back on before anything else.
11. **Verify:** `sent_emails` rows = recipients count for this `template_id`; Resend dashboard for bounces/complaints over the next hour. Retire hard-bounce subscriber rows before next issue.

Issue #3 (2026-09-04, 73 recipients, 0 failures) required three same-day edits to lib/email.js. The rule stands.
If a send-day template change is unavoidable, it goes on a branch, gets verified independently from the pushed
SHA, and gets a fresh test send after the fast-forward, before the live flag goes on.

## Failure handling

- 401: secret mismatch. 5xx or connection error: check Render isn't mid-restart.
- `failed` > 0: do NOT blind-retry. Inspect `sent_emails` and the verbatim response first. The template_id guard makes a targeted re-POST safe for anyone not already marked sent.
- Never edit lib/email.js or routes/newsletter.js on send day.
- NEWSLETTER_LIVE was found still set to true before issue #3 (Sep 4, 2026). Any POST to the endpoint during that
  window would have gone to the full list. Deleting the variable after a send is the step that fails. Verify it is
  absent in the Render dashboard before every test send, never assume.

## Claude Code guardrails (paste into any send task)

- Never print, echo, or log CRON_SECRET.
- Never set, unset, or read NEWSLETTER_LIVE. That is Bill's manual Render step.
- Live sends require Bill's explicit go in chat. An automated event completing is not a go.
- Content gate must pass exactly before any POST. Never edit the JSON to make a gate pass.
- Exactly one POST per instruction. No code changes, no commits, unless the task says otherwise.
