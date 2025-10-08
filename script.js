// Carpool Automator (client-side for Netlify)
// - Fetches Google Sheet as CSV (public link), parses with PapaParse
// - Recognizes exactly three transportation choices:
//   "I can provide transportation for others" -> driver (2)
//   "I have transportation for myself"       -> self-driver (1)
//   "I need transportation provided"         -> rider (3)

const qs = (s) => document.querySelector(s);

// UI elements
const sheetUrlInput = qs('#sheetUrl');
const eventCapInput = qs('#eventCap');
const gidInput = qs('#gid');
const runBtn = qs('#runBtn');
const statusEl = qs('#status');
const results = qs('#results');

runBtn.addEventListener('click', async () => {
  try {
    clearResults();
    setStatus('Fetching sheet…');
    const link = sheetUrlInput.value.trim();
    const capStr = eventCapInput.value.trim();
    const cap = parseInt(capStr, 10);
    const gidManual = gidInput.value.trim();

    if (!link) return alert('Please paste the Google Sheet link.');
    if (!Number.isFinite(cap) || cap <= 0) return alert('Please enter a valid positive event capacity.');

    const csvUrl = toCsvExportUrl(link, gidManual);
    const csvText = await fetchCsv(csvUrl);

    setStatus('Parsing CSV…');
    const rows = parseCsv(csvText);

    if (!rows || rows.length === 0) {
      setStatus('No data.');
      return;
    }

    const header = rows[0];
    const headerMap = headerIndex(header);

    const nameCol = findCol(headerMap, "Name");
    const transCol = findCol(headerMap, "Transportation?");
    const capCol   = findCol(headerMap, "If you can provide transportation for others");

    if (nameCol < 0 || transCol < 0 || capCol < 0) {
      throw new Error("Missing one or more required columns: 'Name', 'Transportation?', 'If you can provide transportation for others'");
    }

    const hasTransport = [];
    const drivers = [];
    const needRides = [];

    // Build queues
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      const name = safe(row, nameCol).trim();
      if (!name) continue;

      const tVal = safe(row, transCol);
      const tCode = toTransportationCode(tVal);
      let carCap = -1;

      if (tCode === 2) {
        carCap = parsePositiveIntOrMinusOne(safe(row, capCol));
        if (carCap === 0) {
          console.warn(`Driver "${name}" reported car capacity 0. Skipping.`);
          continue;
        }
        if (carCap < 0) {
          console.warn(`Driver "${name}" missing/invalid car capacity. Skipping.`);
          continue;
        }
      }

      const person = { name, transportation: tCode, carCap };
      if (tCode === 1) hasTransport.push(person);
      else if (tCode === 2) drivers.push(person);
      else if (tCode === 3) needRides.push(person);
    }

    // Assign
    let numPeople = hasTransport.length;
    const carpools = [];
    if (hasTransport.length) {
      carpools.push([...hasTransport]); // self-drivers bucket
    }

    while (drivers.length && numPeople < cap) {
      const driver = drivers.shift();
      const car = [driver];
      numPeople++;
      const seats = Math.max(0, driver.carCap);
      for (let i = 0; i < seats && needRides.length && numPeople < cap; i++) {
        car.push(needRides.shift());
        numPeople++;
      }
      carpools.push(car);
    }

    renderSummary(carpools, needRides);
    setStatus('Done.');
  } catch (err) {
    console.error(err);
    setStatus('Error.');
    alert(err.message || 'Something went wrong.');
  }
});

function setStatus(msg) {
  statusEl.textContent = msg || '';
}

function clearResults() {
  results.innerHTML = '';
  setStatus('');
}

// --- Parsing helpers ---

function toCsvExportUrl(sheetLink, gidManual) {
  // Standard link: https://docs.google.com/spreadsheets/d/<ID>/edit#gid=<GID>
  // Export link:   https://docs.google.com/spreadsheets/d/<ID>/export?format=csv&gid=<GID>
  let id = null;
  let gid = '0';

  try {
    const dIdx = sheetLink.indexOf('/d/');
    if (dIdx >= 0) {
      const start = dIdx + 3;
      let end = sheetLink.indexOf('/', start);
      if (end < 0) end = sheetLink.length;
      id = sheetLink.substring(start, end);
    }
    const gidIdx = sheetLink.indexOf('gid=');
    if (gidIdx >= 0) {
      const start = gidIdx + 4;
      let end = sheetLink.indexOf('&', start);
      if (end < 0) end = sheetLink.length;
      gid = sheetLink.substring(start, end);
    }
  } catch {}

  if (gidManual) gid = gidManual;
  if (!id) throw new Error('Could not parse spreadsheet ID from the link.');

  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

async function fetchCsv(url) {
  const res = await fetch(url, { headers: { 'Accept': 'text/csv' } });
  if (!res.ok) {
    throw new Error(`Failed to fetch CSV (${res.status}) – is the sheet public to "Anyone with the link"?`);
  }
  return await res.text();
}

function parseCsv(text) {
  // Return as array-of-arrays
  const parsed = Papa.parse(text, { dynamicTyping: false });
  return parsed?.data || [];
}

function headerIndex(headerRow) {
  const map = new Map();
  for (let i = 0; i < headerRow.length; i++) {
    const h = (headerRow[i] ?? '').toString().trim();
    if (h) map.set(h, i);
  }
  return map;
}

function findCol(map, wantedPrefix) {
  const w = wantedPrefix.toLowerCase();
  for (const [key, idx] of map.entries()) {
    const k = key.toLowerCase();
    if (k === w || k.startsWith(w)) return idx;
  }
  return -1;
}

function safe(row, idx) {
  if (idx < 0 || idx >= row.length) return '';
  const v = row[idx];
  return (v == null) ? '' : String(v);
}

function toTransportationCode(val) {
  const n = (val ?? '').trim().toLowerCase();
  if (n === 'i can provide transportation for others') return 2;
  if (n === 'i have transportation for myself') return 1;
  if (n === 'i need transportation provided') return 3;
  return -1;
}

function parsePositiveIntOrMinusOne(s) {
  if (!s || !s.trim()) return -1;
  const digits = s.replace(/[^0-9-]/g, '');
  if (!digits) return -1;
  const n = parseInt(digits, 10);
  if (!Number.isFinite(n) || n < 0) return -1;
  return n;
}

// --- Rendering ---

function renderSummary(carpools, waitlist) {
  const container = document.createElement('div');
  container.className = 'space-y-6';

  // Self-drivers group (first bucket) if present
  if (carpools.length && carpools[0].every(p => p.transportation === 1)) {
    const group = carpools[0];
    const card = document.createElement('div');
    card.className = 'card rounded-2xl bg-white p-6';
    card.innerHTML = `
      <h3 class="text-lg font-semibold mb-2">Self-drivers</h3>
      ${group.length ? `<ul class="list-disc pl-6 space-y-1">${group.map(p => `<li>${escapeHtml(p.name)}</li>`).join('')}</ul>` : '<p class="text-sm text-slate-500">None</p>'}
    `;
    container.appendChild(card);
  }

  // Cars (drivers + passengers)
  let carIndex = 1;
  for (const group of carpools) {
    if (group.length && group.every(p => p.transportation === 1)) continue; // skip self-driver bucket already shown
    if (!group.length) continue;

    const driver = group[0];
    const passengers = group.slice(1);
    const seats = Math.max(0, driver.carCap);

    const card = document.createElement('div');
    card.className = 'card rounded-2xl bg-white p-6';
    card.innerHTML = `
      <div class="flex items-start justify-between gap-4">
        <div>
          <h3 class="text-lg font-semibold">Car #${carIndex++}</h3>
          <p class="text-sm text-slate-600 mt-1"><span class="font-medium text-indigo-700">Driver:</span> ${escapeHtml(driver.name)} <span class="text-slate-500">[seats: ${seats}]</span></p>
        </div>
      </div>
      ${passengers.length ? `
        <div class="mt-3">
          <h4 class="text-sm font-medium text-slate-700 mb-1">Passengers</h4>
          <ul class="list-disc pl-6 space-y-1">
            ${passengers.map(p => `<li>${escapeHtml(p.name)}</li>`).join('')}
          </ul>
        </div>` : `
        <p class="text-sm text-slate-500 mt-3">(no passengers assigned)</p>`}
    `;
    container.appendChild(card);
  }

  if (waitlist && waitlist.length) {
    const card = document.createElement('div');
    card.className = 'card rounded-2xl bg-white p-6';
    card.innerHTML = `
      <h3 class="text-lg font-semibold">Waitlist</h3>
      <ol class="list-decimal pl-6 space-y-1 mt-2">
        ${waitlist.map((p, i) => `<li>${escapeHtml(p.name)}</li>`).join('')}
      </ol>
    `;
    container.appendChild(card);
  }

  results.appendChild(container);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[ch]));
}
