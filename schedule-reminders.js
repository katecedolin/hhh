/**
 * schedule-reminders (Netlify Function)
 * - Uses waitlist from frontend (carpool UI)
 * - Validates Twilio scheduling rules:
 *      - sendAt must be RFC3339 UTC (…Z)
 *      - 15 minutes ≤ sendAt - now ≤ 7 days
 *      - If <15 min or past: send immediately (no scheduleType/sendAt)
 */
const { DateTime } = require('luxon');
const fetch = require('node-fetch');
const { parse } = require('csv-parse/sync');
const twilio = require('twilio');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function toCsvUrl(sheetUrl) {
  try {
    const m = sheetUrl.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!m) return sheetUrl;
    const id = m[1];
    let gid = '0';
    const gidMatch = sheetUrl.match(/gid=([0-9]+)/);
    if (gidMatch) gid = gidMatch[1];
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  } catch {
    return sheetUrl;
  }
}

function normalizePhone(phone) {
  if (!phone) return null;
  const only = String(phone).replace(/[^\d+]/g, '');
  if (only.startsWith('+')) return only;
  const d = only.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;          // US default
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return null;
}

// Twilio env check (names only)
function missingEnv() {
  const required = ['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_MESSAGING_SERVICE_SID'];
  return required.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
}

function classifySendTiming(utcIso) {
  const now = Date.now();
  const when = Date.parse(utcIso);
  if (Number.isNaN(when)) return { mode: 'error', reason: 'Invalid timestamp' };
  const delta = when - now;
  const minAhead = 15 * 60 * 1000;         // 15 min
  const maxAhead = 7 * 24 * 60 * 60 * 1000; // 7 days
  if (delta < minAhead) return { mode: 'immediate' };   // send now
  if (delta > maxAhead) return { mode: 'tooFar' };      // cannot schedule yet
  return { mode: 'scheduled' };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { sheetUrl, organization, date, time, waitlistNames = [] } = body;

    if (!sheetUrl || !organization || !date || !time) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing sheetUrl, organization, date, or time' }) };
    }

    const missing = missingEnv();
    if (missing.length) {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Twilio environment variables are not configured', missing }) };
    }

    // Create Twilio client *after* env check
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    // Fetch CSV
    const csvUrl = toCsvUrl(sheetUrl);
    const resp = await fetch(csvUrl);
    if (!resp.ok) {
      const txt = await resp.text().catch(()=> '');
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: `Unable to fetch the CSV (${resp.status})`, details: txt.slice(0, 200) }) };
    }
    const csvText = await resp.text();
    const rows = parse(csvText, { columns: true, skip_empty_lines: true });

    // Build recipients (Name/Phone only)
    const normKey = s => (s || '').toLowerCase().replace(/\s+/g, '');
    const recipients = [];
    for (const row of rows) {
      const keyed = {};
      for (const [k, v] of Object.entries(row)) keyed[normKey(k)] = v;
      const name = keyed['name'] || keyed['fullname'] || keyed['volunteername'];
      const phone = normalizePhone(keyed['phone'] || keyed['phonenumber'] || keyed['cell'] || keyed['mobile']);
      if (!name || !phone) continue;
      // basic E.164 sanity
      if (!/^\+[1-9]\d{1,14}$/.test(phone)) continue;
      recipients.push({ name, phone });
    }

    // Exclude carpool waitlist (from UI)
    const wlSet = new Set((Array.isArray(waitlistNames) ? waitlistNames : []).map(n => (n || '').trim().toLowerCase()));
    const filtered = recipients.filter(r => !wlSet.has((r.name || '').trim().toLowerCase()));

    // Build event times in PT -> to UTC RFC-3339 (no ms)
    const eventPT = DateTime.fromISO(`${date}T${time}`, { zone: 'America/Los_Angeles' });
    if (!eventPT.isValid) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid date/time' }) };
    }
    const dayOf9amPT = eventPT.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    const threeDaysPrior9amPT = dayOf9amPT.minus({ days: 3 });

    // Helper to make RFC-3339 UTC without ms
    const toUtcIso = (dt) => dt.setZone('UTC').toFormat("yyyy-LL-dd'T'HH:mm:ss'Z'");

    const sends = [];
    for (const rec of filtered) {
      const msgBody = `Hi ${rec.name}, this is a reminder that you signed up for the ${organization} volunteer opportunity on ${eventPT.toFormat('MMMM d, yyyy')} at ${eventPT.toFormat('h:mm a')}. See you then!`;

      for (const whenPT of [threeDaysPrior9amPT, dayOf9amPT]) {
        const sendAtUtc = toUtcIso(whenPT);
        const timing = classifySendTiming(sendAtUtc);

        const base = {
          to: rec.phone,
          messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
          body: msgBody
        };

        // <15min => immediate send (no schedule params)
        // >7d    => do not schedule, return a clear error
        let params = base;
        if (timing.mode === 'scheduled') {
          params = { ...base, scheduleType: 'fixed', sendAt: sendAtUtc };
        } else if (timing.mode === 'tooFar') {
          sends.push(Promise.resolve({ ok:false, error:`Cannot schedule more than 7 days ahead: ${sendAtUtc}`, to: rec.phone, when: sendAtUtc }));
          continue;
        }

        sends.push(
          client.messages.create(params).then(
            msg => ({ ok:true, sid: msg.sid, to: rec.phone, when: sendAtUtc, scheduled: timing.mode === 'scheduled' }),
            err => ({ ok:false, error: err.message, to: rec.phone, when: sendAtUtc })
          )
        );
      }
    }

    const results = await Promise.all(sends);
    const failed = results.filter(r => !r.ok);
    const ok = results.filter(r => r.ok);

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        recipients: filtered.length,
        scheduledCount: ok.length,
        failed: failed.length,
        failures: failed.slice(0, 10),
        hint: "Twilio only allows scheduled messages 15 minutes to 7 days in the future. Immediate send is used if <15 minutes."
      })
    };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message || 'Unknown error' }) };
  }
};
