# Tanta Pulse

Fresh local leads, ranked and delivered weekly.

## Live stack
- **Hosting:** Vercel
- **Domain:** tantapulse.com
- **Capture:** `/api/sample-request`
- **Processor:** `/api/lead-feed/process`
- **Follow-up sender:** `/api/lead-feed/send`
- **Data sink:** Supabase `lead_feed_runs`, `lead_feed_raw_items`, `lead_feed_leads`, `newsletter_subscribers`, `email_sequence`
- **Email:** Resend using the shared THOS secrets mirrored into the Vercel project

## CTA
Use **Request a sample** only.

## Deploy notes
The Vercel project is linked to this repo and the apex domain is attached.
