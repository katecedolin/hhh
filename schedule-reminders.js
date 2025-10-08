
/**
 * Netlify Function: schedule-reminders
 * Debug-friendly version:
 *  - Twilio client is created AFTER env var checks (prevents cold-start crashes -> 502)
 *  - Returns more descriptive errors
 *  - Adds CORS headers for local testing
 */
const { DateTime } = require('luxon');
const fetch = require('node-fetch');
const { parse } = require('csv-parse/sync');
const twilio = require('twilio');

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
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  const justDigits = digits.replace(/\D/g, '');
  if (justDigits.length === 10) return '+1' + justDigits;
  if (justDigits.length === 11 && justDigits.startsWith('1')) return '+' + justDigits;
  return null;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

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

    const {
      TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN,
      TWILIO_MESSAGING_SERVICE_SID
    } = process.env;

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_MESSAGING_SERVICE_SID) {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Twilio environment variables are not configured' }) };
    }

    // Create Twilio client only after confirming env vars
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    const csvUrl = toCsvUrl(sheetUrl);
    const resp = await fetch(csvUrl);
    if (!resp.ok) {
      const txt = await resp.text().catch(()=>'');
      console.error('CSV fetch failed', resp.status, txt);
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: `Unable to fetch the CSV (${resp.status})`, details: txt.slice(0, 200) }) };
    }
    const csvText = await resp.text();
    const rows = parse(csvText, { columns: true, skip_empty_lines: true });

    const normalizeKey = s => (s || '').toLowerCase().replace(/\s+/g, '');

    const recipients = [];
    for (const row of rows) {
      const keyed = {};
      for (const [k, v] of Object.entries(row)) {
        keyed[normalizeKey(k)] = v;
      }
      const name = keyed['name'] || keyed['fullname'] || keyed['volunteername'];
      const phone = normalizePhone(keyed['phone'] || keyed['phonenumber'] || keyed['cell'] || keyed['mobile']);
      if (!name || !phone) continue;
      recipients.push({ name, phone });
    }

    const wlSet = new Set((Array.isArray(waitlistNames) ? waitlistNames : []).map(n => (n || '').trim().toLowerCase()));
    const filtered = recipients.filter(r => !wlSet.has((r.name || '').trim().toLowerCase()));

    const eventDateTime = DateTime.fromISO(`${date}T${time}`, { zone: 'America/Los_Angeles' });
    if (!eventDateTime.isValid) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid date/time' }) };
    }
    const dayOf9am = eventDateTime.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    const threeDaysPrior9am = dayOf9am.minus({ days: 3 });

    const sends = [];
    for (const rec of filtered) {
      const bodyText = `Hi ${rec.name}, this is a reminder that you signed up for the ${organization} volunteer opportunity on ${eventDateTime.toFormat('MMMM d, yyyy')} at ${eventDateTime.toFormat('h:mm a')}. See you then!`;
      for (const when of [threeDaysPrior9am, dayOf9am]) {
        const sendAtUtc = when.setZone('UTC').toISO({ suppressMilliseconds: true });
        const params = {
          to: rec.phone,
          messagingServiceSid: TWILIO_MESSAGING_SERVICE_SID,
          body: bodyText,
          scheduleType: 'fixed',
          sendAt: sendAtUtc
        };
        sends.push(
          client.messages.create(params).then(
            msg => ({ ok: true, sid: msg.sid, to: rec.phone, when: sendAtUtc }),
            err => {
              console.error('Twilio create error', err.message, { to: rec.phone, when: sendAtUtc });
              return { ok: false, error: err.message, to: rec.phone, when: sendAtUtc };
            }
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
        failures: failed.slice(0, 5)
      })
    };
  } catch (err) {
    console.error('Handler fatal error', err);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message || 'Unknown error' }) };
  }
};
