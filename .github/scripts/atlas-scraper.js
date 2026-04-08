// atlas-scraper.js
// Authenticates with Atlas via Supabase, calls /api/flight for 12 airports,
// parses terminal/queue/wait time data, upserts into airport_wait_times via RPC.

const { createClient } = require('@supabase/supabase-js');

// ── Config ────────────────────────────────────────────────────────────────────
const ATLAS_EMAIL    = process.env.ATLAS_EMAIL;
const ATLAS_PASSWORD = process.env.ATLAS_PASSWORD;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Atlas's own Supabase project — used only for auth (getting the Bearer token)
const ATLAS_SUPABASE_URL = 'https://qkfbntsrlkplvrmhjgqw.supabase.co';
const ATLAS_PUBLISHABLE_KEY = 'sb_publishable_B_4AnUr2CAi9y-IZ6QtxUg_WUobZBSV';

const ATLAS_API_BASE = 'https://atlas-navigation.com';

// All 12 target airports — BUR is not in Atlas's system, logged and skipped
const AIRPORTS = ['ATL', 'DFW', 'DEN', 'ORD', 'LAX', 'CLT', 'MCO', 'LAS', 'PHX', 'SEA', 'MSP', 'BUR'];

// Atlas checkpoint IDs extracted from bundle 773f52769d21364c.js
const CHECKPOINT_IDS = {
  ATL: { security: 269, customs: 295 },
  DFW: { security: 267, customs: null },
  DEN: { security: 291, customs: null },
  ORD: { security: 293, customs: 298 },
  LAX: { security: 10,  customs: 299 },
  CLT: { security: 259, customs: null },
  MCO: { security: 258, customs: null },
  LAS: { security: 13,  customs: null },
  PHX: { security: 257, customs: null },
  SEA: { security: 280, customs: null },
  MSP: { security: 261, customs: null },
  // BUR not in Atlas system
};

// Timezone map for local_time_ct equivalent per airport
const AIRPORT_TZ = {
  ATL: 'America/New_York',
  DFW: 'America/Chicago',
  DEN: 'America/Denver',
  ORD: 'America/Chicago',
  LAX: 'America/Los_Angeles',
  CLT: 'America/New_York',
  MCO: 'America/New_York',
  LAS: 'America/Los_Angeles',
  PHX: 'America/Phoenix',
  SEA: 'America/Los_Angeles',
  MSP: 'America/Chicago',
  BUR: 'America/Los_Angeles',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getLocalTime(ianaTimezone) {
  return new Date().toLocaleString('en-US', {
    timeZone: ianaTimezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

// ── Step 1: Authenticate with Atlas via their Supabase project ────────────────
async function getAtlasToken() {
  console.log('[AUTH] Signing in to Atlas...');

  const atlasClient = createClient(ATLAS_SUPABASE_URL, ATLAS_PUBLISHABLE_KEY);
  const { data, error } = await atlasClient.auth.signInWithPassword({
    email: ATLAS_EMAIL,
    password: ATLAS_PASSWORD,
  });

  if (error) throw new Error(`Atlas auth failed: ${error.message}`);
  if (!data?.session?.access_token) throw new Error('Atlas auth succeeded but no access_token returned');

  console.log('[AUTH] ✅ Authenticated successfully');
  return data.session.access_token;
}

// ── Step 2: Call /api/flight for one airport ──────────────────────────────────
async function fetchAirportData(airportCode, token) {
  const url = `${ATLAS_API_BASE}/api/flight`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ airportCode }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`/api/flight ${airportCode} → HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  return resp.json();
}

// ── Step 3: Parse response into rows for airport_wait_times ──────────────────
// Expected response shape from recon:
// {
//   airport: "ATL",
//   terminalData: [
//     { terminal: "...", queue: "STANDARD"|"PRECHECK"|"CLEAR", minWaitTime: 5, maxWaitTime: 12, historicalDataUsed: false }
//   ],
//   historicalOnly: false
// }
function parseRows(data, airportCode) {
  const rows = [];
  const now = new Date();
  const localTime = getLocalTime(AIRPORT_TZ[airportCode] || 'America/Chicago');

  if (!data?.terminalData || !Array.isArray(data.terminalData)) {
    console.warn(`  [${airportCode}] Unexpected response shape:`, JSON.stringify(data).slice(0, 300));
    return rows;
  }

  for (const entry of data.terminalData) {
    const terminal  = entry.terminal  || 'Main';
    const queueType = entry.queue     || 'STANDARD';
    const minWait   = entry.minWaitTime ?? null;
    const maxWait   = entry.maxWaitTime ?? null;

    // Use midpoint of min/max as wait_minutes; fall back to whichever is present
    let waitMinutes = null;
    if (minWait !== null && maxWait !== null) {
      waitMinutes = Math.round((minWait + maxWait) / 2);
    } else if (minWait !== null) {
      waitMinutes = minWait;
    } else if (maxWait !== null) {
      waitMinutes = maxWait;
    }

    rows.push({
      airport_code:  airportCode,
      terminal:      terminal,
      queue_type:    queueType,
      wait_minutes:  waitMinutes,
      last_updated:  now.toISOString(),
      fetched_at:    now.toISOString(),
      local_time_ct: localTime,
    });
  }

  return rows;
}

// ── Step 4: Upsert rows into Supabase via existing RPC ────────────────────────
async function upsertRows(supabase, rows) {
  let successCount = 0;
  let errorCount = 0;

  for (const row of rows) {
    const { error } = await supabase.rpc('upsert_wait_time', {
      p_airport_code:  row.airport_code,
      p_terminal:      row.terminal,
      p_queue_type:    row.queue_type,
      p_wait_minutes:  row.wait_minutes,
      p_last_updated:  row.last_updated,
      p_fetched_at:    row.fetched_at,
      p_local_time_ct: row.local_time_ct,
    });

    if (error) {
      console.error(`  ❌ Upsert failed [${row.airport_code}/${row.terminal}/${row.queue_type}]:`, error.message);
      errorCount++;
    } else {
      successCount++;
    }
  }

  return { successCount, errorCount };
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Atlas Scraper — ${new Date().toISOString()}`);
  console.log(`Airports: ${AIRPORTS.join(', ')}`);
  console.log('='.repeat(60));

  // Validate env
  for (const [k, v] of Object.entries({ ATLAS_EMAIL, ATLAS_PASSWORD, SUPABASE_URL, SUPABASE_KEY })) {
    if (!v) throw new Error(`Missing required env var: ${k}`);
  }

  // Init Q-ly Supabase client
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Get Atlas Bearer token
  const token = await getAtlasToken();

  const summary = { success: [], skipped: [], failed: [] };
  let totalRows = 0;

  for (const airportCode of AIRPORTS) {
    console.log(`\n[${airportCode}] Fetching...`);

    // Skip airports not in Atlas system
    if (!CHECKPOINT_IDS[airportCode]) {
      console.log(`  ⚠️  ${airportCode} not in Atlas system — skipping`);
      summary.skipped.push(airportCode);
      continue;
    }

    try {
      const data = await fetchAirportData(airportCode, token);
      const rows = parseRows(data, airportCode);

      if (rows.length === 0) {
        console.log(`  ⚠️  No rows parsed from response`);
        summary.skipped.push(airportCode);
        continue;
      }

      console.log(`  Parsed ${rows.length} rows:`);
      rows.forEach(r => console.log(`    ${r.terminal} / ${r.queue_type} → ${r.wait_minutes ?? 'N/A'} min`));

      const { successCount, errorCount } = await upsertRows(supabase, rows);
      totalRows += successCount;

      if (errorCount > 0) {
        console.log(`  ⚠️  ${successCount} upserted, ${errorCount} failed`);
        summary.failed.push(airportCode);
      } else {
        console.log(`  ✅ ${successCount} rows upserted`);
        summary.success.push(airportCode);
      }

    } catch (err) {
      console.error(`  ❌ Error for ${airportCode}:`, err.message);
      summary.failed.push(airportCode);
    }

    // Polite delay between airports — avoid rate limiting
    await sleep(1200);
  }

  // Final summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('SCRAPE COMPLETE');
  console.log(`  ✅ Success:  ${summary.success.join(', ') || 'none'}`);
  console.log(`  ⚠️  Skipped:  ${summary.skipped.join(', ') || 'none'}`);
  console.log(`  ❌ Failed:   ${summary.failed.join(', ') || 'none'}`);
  console.log(`  Total rows upserted: ${totalRows}`);
  console.log('='.repeat(60));

  if (summary.failed.length > 0) {
    process.exit(1);
  }
})();
