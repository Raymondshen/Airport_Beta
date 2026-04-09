const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase Client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Targeted Airports for Q-ly v1
const AIRPORTS = [
  { code: 'DFW', name: 'Dallas/Fort Worth International', venueId: 'dfw' },
  { code: 'MSP', name: 'Minneapolis-St. Paul International', venueId: 'msp' },
  { code: 'MCO', name: 'Orlando International', venueId: 'mco' },
  { code: 'DEN', name: 'Denver International', venueId: 'den' },
  { code: 'PHX', name: 'Phoenix Sky Harbor International', venueId: 'phx' },
  { code: 'SEA', name: 'Seattle-Tacoma International', venueId: 'sea' }
];

// Formatter for MM/DD/YYYY, 0:00 PM (Central Time)
const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true
});

/**
 * Normalizes terminal names based on airport-specific floor IDs.
 */
function extractTerminal(floorId, airportCode) {
  if (!floorId) return 'Main';
  const fid = floorId.toLowerCase();
  
  if (airportCode === 'DFW') {
    const match = fid.match(/terminal([a-e])/);
    return match ? match[1].toUpperCase() : 'Main';
  }
  
  if (['MSP', 'PHX', 'MCO'].includes(airportCode)) {
    const match = fid.match(/terminal(\d)/);
    return match ? `T${match[1]}` : 'Main';
  }

  if (airportCode === 'SEA') {
    return fid.includes('main') ? 'Main' : 'Satellite';
  }

  if (airportCode === 'DEN') {
    return 'Main Terminal';
  }
  
  return 'Main';
}

/**
 * Standardizes queue subtypes to our database schema.
 */
function normalizeQueueType(queueSubtype) {
  const map = { 
    'general': 'standard', 
    'tsapre': 'precheck', 
    'priority': 'priority' 
  };
  return map[queueSubtype] || 'standard';
}

async function runSync() {
  const nowRaw = new Date();
  const nowISO = nowRaw.toISOString();

  console.log(`--- Starting Q-ly Sync at ${nowISO} ---`);

  for (const airport of AIRPORTS) {
    try {
      const resp = await fetch(`https://marketplace.locuslabs.com/venueId/${airport.venueId}/dynamic-poi`);
      const json = await resp.json();
      const data = json.data;

      // Filter: Catches multiple category naming styles used across different airports
      const checkpoints = Object.values(data).filter(poi => {
        const category = (poi.category || '').toLowerCase();
        const name = (poi.name || '').toLowerCase();
        
        const isSecurity = category.includes('security') || name.includes('checkpoint');
        const hasQueue = poi.dynamicData?.queue;
        
        return isSecurity && hasQueue;
      });

      console.log(`[${airport.code}] Found ${checkpoints.length} checkpoints.`);

      for (const cp of checkpoints) {
        const queue = cp.dynamicData.queue;
        const terminal = extractTerminal(cp.position?.floorId, airport.code);
        const queueType = normalizeQueueType(cp.queue?.queueSubtype);
        const checkpointName = cp.name || 'Main Checkpoint';
        
        const isVerified = !queue.isQueueTimeDefault;
        const isClosed = cp.isClosed === true || cp.isTemporarilyClosed === true;
        const waitMinutes = isClosed ? null : (queue.queueTime ?? null);

        // Format the sensor timestamp or current time into our simplified format
        const prettyTime = timeFormatter.format(cp.timestamp ? new Date(cp.timestamp) : nowRaw);

        // RPC call to Supabase
        const { error } = await supabase.rpc('upsert_wait_time', {
          p_airport_code: airport.code,
          p_airport_name: airport.name,
          p_terminal: terminal,
          p_checkpoint_name: checkpointName,
          p_queue_type: queueType,
          p_wait_minutes: waitMinutes,
          p_last_updated: prettyTime,
          p_fetched_at: nowISO,
          p_is_verified: isVerified
        });

        if (error) {
          console.error(`[${airport.code}] DB Error for ${checkpointName}:`, error.message);
        }
      }
      console.log(`[${airport.code}] Sync finished.`);
    } catch (err) {
      console.error(`[${airport.code}] Critical Fetch Error:`, err.message);
    }
  }
  console.log('--- All Sync Tasks Complete ---');
}

runSync();
