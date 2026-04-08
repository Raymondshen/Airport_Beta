// DFW Security Wait Times Scraper - LocusLabs API
// Source: https://marketplace.locuslabs.com/venueId/dfw/dynamic-poi
// No auth required. Returns all DFW POIs including live security checkpoint wait times.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LOCUSLABS_URL = 'https://marketplace.locuslabs.com/venueId/dfw/dynamic-poi';

// DFW is in CDT (UTC-5) / CST (UTC-6)
// We store local_time_ct as a convenience field
function getLocalTimeCT() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

// Extract terminal letter from LocusLabs floorId
// e.g. "dfw-terminala-departures" -> "A"
//      "dfw-terminalb-departures" -> "B"
function extractTerminal(floorId) {
  if (!floorId) return 'Unknown';
  const match = floorId.match(/terminal([a-e])/i);
  if (match) return match[1].toUpperCase();
  return 'Unknown';
}

// Normalize queue subtype to our schema's queue_type values
// LocusLabs: "general" | "tsapre" | "priority"
// Our schema: "standard" | "tsa_precheck" | "priority"
function normalizeQueueType(queueSubtype) {
  switch (queueSubtype) {
    case 'general':  return 'standard';
    case 'tsapre':   return 'tsa_precheck';
    case 'priority': return 'priority';
    default:         return queueSubtype || 'standard';
  }
}

async function scrape() {
  console.log(`[DFW] Starting scrape at ${new Date().toISOString()}`);

  // --- Fetch from LocusLabs ---
  let data;
  try {
    const resp = await fetch(LOCUSLABS_URL);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    const json = await resp.json();
    data = json.data;
  } catch (err) {
    console.error('[DFW] Failed to fetch LocusLabs API:', err.message);
    process.exit(1);
  }

  const now = new Date().toISOString();
  const localTimeCT = getLocalTimeCT();

  // --- Filter to security checkpoints only ---
  const checkpoints = Object.values(data).filter(poi =>
    poi.category === 'security.checkpoint' &&
    poi.dynamicData?.queue &&
    poi.queue?.queueSubtype
  );

  console.log(`[DFW] Found ${checkpoints.length} security checkpoint entries`);

  // --- Build upsert records ---
  const records = [];

  for (const cp of checkpoints) {
    const queue = cp.dynamicData.queue;
    const terminal = extractTerminal(cp.position?.floorId);
    const queueType = normalizeQueueType(cp.queue.queueSubtype);

    // Skip if temporarily closed or hard closed
    // (store with null wait_minutes so FlutterFlow can show "Closed")
    const isClosed = cp.isClosed === true || cp.isTemporarilyClosed === true;

    // isQueueTimeDefault: true means LocusLabs is showing a fallback estimate,
    // not a live reading. We store it but flag it.
    const isDefaultTime = queue.isQueueTimeDefault === true;
    const waitMinutes = isClosed ? null : (queue.queueTime ?? null);

    records.push({
      airport_code: 'DFW',
      terminal: terminal,
      queue_type: queueType,
      wait_minutes: waitMinutes,
      // last_updated: timestamp from LocusLabs (epoch ms -> ISO string)
      last_updated: cp.timestamp
        ? new Date(cp.timestamp).toISOString()
        : now,
      fetched_at: now,
      local_time_ct: localTimeCT,
      // Optional metadata fields — only store if your schema has them
      // checkpoint_name: cp.name,
      // is_default_time: isDefaultTime,
      // is_closed: isClosed,
    });
  }

  console.log(`[DFW] Built ${records.length} records to upsert`);
  if (records.length === 0) {
    console.log('[DFW] No records — exiting.');
    return;
  }

  // --- Upsert via Supabase RPC ---
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let successCount = 0;
  let errorCount = 0;

  for (const record of records) {
    const { error } = await supabase.rpc('upsert_wait_time', {
      p_airport_code: record.airport_code,
      p_terminal:     record.terminal,
      p_queue_type:   record.queue_type,
      p_wait_minutes: record.wait_minutes,
      p_last_updated: record.last_updated,
      p_fetched_at:   record.fetched_at,
      p_local_time_ct: record.local_time_ct,
    });

    if (error) {
      console.error(`[DFW] Upsert error for ${record.terminal}/${record.queue_type}:`, error.message);
      errorCount++;
    } else {
      successCount++;
    }
  }

  console.log(`[DFW] Done. ${successCount} upserted, ${errorCount} errors.`);

  // --- Summary log ---
  const byTerminal = {};
  for (const r of records) {
    const key = `Terminal ${r.terminal}`;
    if (!byTerminal[key]) byTerminal[key] = [];
    byTerminal[key].push(`${r.queue_type}: ${r.wait_minutes ?? 'CLOSED'} min`);
  }
  for (const [term, lanes] of Object.entries(byTerminal).sort()) {
    console.log(`  ${term}: ${lanes.join(' | ')}`);
  }
}

scrape().catch(err => {
  console.error('[DFW] Fatal error:', err);
  process.exit(1);
});
