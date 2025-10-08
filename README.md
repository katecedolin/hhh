# Carpool Automator (Netlify-ready)

A static, client‑side web app that builds carpool groups from a Google Sheets responses tab.

## How to deploy on Netlify
1. Download the ZIP from ChatGPT.
2. Drag‑and‑drop it into Netlify (or push these files to a repo and connect it).
3. That’s it — no build step required.

## Usage
- Paste the Google Sheets link (must be readable by **Anyone with the link**).
- Enter the total event capacity (includes drivers, self‑drivers, and riders).
- Click **Build Carpool**.

### Expected Columns
- `Name`
- `Transportation?`
- `If you can provide transportation for others` (integer seat count for drivers)

### Transportation options recognized
- **I can provide transportation for others** → driver (we expect a positive seat count)
- **I have transportation for myself** → self driver
- **I need transportation provided** → rider

All parsing happens in the browser. No server, no keys, no data leaves the client.

---

## ✉️ Volunteer SMS Reminders Add‑On

This adds a **one‑button** volunteer SMS reminder scheduler that works on Netlify using **Netlify Functions** and **Twilio’s scheduled messaging**.

### How it works
- Frontend form (at the bottom of `index.html`) collects **Organization**, **Event Date**, **Event Time**, and **Google Sheet Link**.
- The **Netlify Function** `/.netlify/functions/schedule-reminders`:
  1. Converts the Google Sheet URL to a CSV export URL.
  2. Reads and parses the CSV.
  3. Filters out anyone on the waitlist (looks for a `Waitlist`/`Status` column containing “wait”).
  4. Schedules **two** SMS per volunteer via Twilio (using your Messaging Service):
     - **3 days before** the event at **9:00am America/Los_Angeles**
     - **9:00am America/Los_Angeles** on the **event day**
- Messages sent use exactly this template:
  `Hi [Name], this is a reminder that you signed up for the [Organization] volunteer opportunity on [Date] at [Time]. See you then!`

### Expected columns in your sheet
- `Name`
- `Phone`
- `Waitlist` or `Status` (any value containing “wait” is treated as waitlisted)

### Environment variables (set these in Netlify → Site settings → Environment variables)
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_MESSAGING_SERVICE_SID`

> **Never commit secrets.** Use Netlify environment variables in production.

### Install & run locally (optional)
```bash
npm i
npx netlify dev
```
This spins up the static site and the function locally at `/.netlify/functions/schedule-reminders`.

### Deployment
1. Zip this folder and drag‑drop into Netlify **OR** connect a repo.
2. In **Site settings → Environment variables**, add your Twilio creds (see above).
3. Publish. The new **Volunteer SMS Reminders** section will appear beneath your existing app.

### Notes
- This implementation uses **Twilio’s native message scheduling** (`scheduleType=fixed`, `sendAt=<UTC ISO>`), which works reliably on serverless platforms (no long‑running scheduler required).
- If you **must** use APScheduler / node‑cron on a persistent server, deploy the backend separately (e.g., Render/Heroku) and point the form to that endpoint. Otherwise, this Netlify‑only setup is recommended.


**Waitlist source change:** The reminders feature now ignores any waitlist in the spreadsheet and **uses the waitlist from your carpool UI** instead. Provide it via one of:
- `window.carpoolWaitlist` or `window.CARPOOL_WAITLIST` (array of names)
- `<input id="carpool-waitlist-json" value='["Name 1","Name 2"]' hidden>`
- `<script type="application/json" data-carpool-waitlist>[...]</script>`
- An element with `[data-carpool-waitlist-list]` containing `<li>` items or children with `data-name`
