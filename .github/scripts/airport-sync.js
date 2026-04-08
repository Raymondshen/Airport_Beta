const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase Client using environment variables
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Airport Configuration
 * Add any new LocusLabs-supported airports to this array.
 */
const AIRPORTS = [
  { 
    code: 'DFW', 
    name: 'Dallas/Fort Worth International Airport', 
    venueId: 'dfw' 
  },
  { 
    code: 'MSP', 
    name: 'Minneapolis-St. Paul International Airport', 
    venueId: 'msp' 
  }
];

/**
 * Get current time in Central Time for database logging/debugging
 */
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

/**
 * Extract terminal identifiers based on LocusLabs floorId patterns.
 * Adapts logic based on the specific airport's naming convention.
 */
function extractTerminal(floorId, airportCode) {
  if (!floorId) return 'Main';
  
  if (airportCode === 'DFW') {
    // DFW pattern: "dfw-terminala-departures"
    const match = floorId.match(/terminal([a-e])/i);
    return match ? match[1].toUpperCase() : 'Unknown';
  }
  
  if (airportCode === 'MSP') {
    // MSP pattern: "msp-t1-level2"
    const match = floorId.match(/t(\d)/i);
    return match ? `T${match[1]}` : 'T1';
  }
  
  return 'Main';
}

/**
 * Generalize queue naming structure for cleaner UI.
 * Maps LocusLabs internal types to Q-ly's user-friendly names.
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
  console.log(`--- Starting Airport Sync: ${new Date().toISOString()} ---`);
  
  const now = new Date().toISOString();
  const localTimeCT = getLocalTimeCT();

  for (const airport of AIRPORTS) {
    console.log(`[${airport.code}] Fetching live data from LocusLabs...`);
    
    try {
      const url = `https://marketplace.locuslabs.com/venueId/${airport.venueId}/dynamic-poi`;
      const resp = await fetch(url);
      
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      
      const json = await resp.json();
      const data = json.data;

      // Filter for points of interest categorized as security checkpoints
      const checkpoints = Object.values(data).filter(poi => 
        poi.category === 'security.checkpoint' && 
        poi.dynamicData?.queue
      );

      console.log(`[${airport.code}] Found ${checkpoints.length} checkpoint records.`);

      let successCount = 0;

      for (const cp of checkpoints) {
        const queue = cp.dynamicData.queue;
        const terminal = extractTerminal(cp.position?.floorId, airport.code);
        const queueType = normalizeQueueType(cp.queue?.queueSubtype);
        
        // isVerified is TRUE if the airport is reporting a live sensor reading
        const isVerified = !queue.isQueueTimeDefault;
        const isClosed = cp.isClosed === true || cp.isTemporarilyClosed === true;
        
        // If closed, we store null for wait_minutes to handle UI state in FlutterFlow
        const waitMinutes = isClosed ? null : (queue.queueTime ?? null);

        // Call the Supabase RPC function
        const { error } = await supabase.rpc('upsert_wait_time', {
          p_airport_code: airport.code,
          p_airport_name: airport.name,
          p_terminal: terminal,
          p_queue_type: queueType,
          p_wait_minutes: waitMinutes,
          p_last_updated: cp.timestamp ? new Date(cp.timestamp).toISOString() : now,
          p_fetched_at: now,
          p_local_time_ct: localTimeCT,
          p_is_verified: isVerified
        });

        if (error) {
          console.error(`[${airport.code}] Update failed for ${terminal}/${queueType}:`, error.message);
        } else {
          successCount++;
        }
      }

      console.log(`[${airport.code}] Successfully synced ${successCount} records.`);

    } catch (err) {
      console.error(`[${airport.code}] Fatal error during sync:`, err.message);
    }
  }
  
  console.log(`--- Sync Cycle Complete ---`);
}

// Execute the sync process
runSync().catch(err => {
  console.error('Process failed unexpectedly:', err);
  process.exit(1);
});
