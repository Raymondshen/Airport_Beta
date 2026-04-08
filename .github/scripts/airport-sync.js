const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const AIRPORTS = [
  { code: 'DFW', name: 'Dallas/Fort Worth International Airport', venueId: 'dfw' },
  { code: 'MSP', name: 'Minneapolis-St. Paul International Airport', venueId: 'msp' }
];

function getLocalTimeCT() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function extractTerminal(floorId, airportCode) {
  if (!floorId) return 'Main';
  const fid = floorId.toLowerCase();
  
  if (airportCode === 'DFW') {
    const match = fid.match(/terminal([a-e])/);
    return match ? match[1].toUpperCase() : 'Unknown';
  }
  
  if (airportCode === 'MSP') {
    // Matches "terminal1" or "terminal2" in the floorId string
    const match = fid.match(/terminal(\d)/);
    return match ? `T${match[1]}` : 'T1';
  }
  return 'Main';
}

function normalizeQueueType(queueSubtype) {
  const map = { 'general': 'standard', 'tsapre': 'precheck', 'priority': 'priority' };
  return map[queueSubtype] || 'standard';
}

async function runSync() {
  const now = new Date().toISOString();
  const localTimeCT = getLocalTimeCT();

  for (const airport of AIRPORTS) {
    try {
      const resp = await fetch(`https://marketplace.locuslabs.com/venueId/${airport.venueId}/dynamic-poi`);
      const json = await resp.json();
      const data = json.data;

      // UPDATED FILTER: Catch both 'security.checkpoint' AND 'security'
      const checkpoints = Object.values(data).filter(poi => 
        (poi.category === 'security.checkpoint' || poi.category === 'security') && 
        poi.dynamicData?.queue
      );

      console.log(`[${airport.code}] Processing ${checkpoints.length} checkpoints...`);

      for (const cp of checkpoints) {
        const queue = cp.dynamicData.queue;
        const terminal = extractTerminal(cp.position?.floorId, airport.code);
        
        // Use the POI name if checkpoint_name is needed, or just terminal/type
        const queueType = normalizeQueueType(cp.queue?.queueSubtype);
        const isVerified = !queue.isQueueTimeDefault;
        const isClosed = cp.isClosed === true || cp.isTemporarilyClosed === true;
        const waitMinutes = isClosed ? null : (queue.queueTime ?? null);

        await supabase.rpc('upsert_wait_time', {
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
      }
      console.log(`[${airport.code}] Sync complete.`);
    } catch (err) {
      console.error(`[${airport.code}] Error:`, err.message);
    }
  }
}

runSync();
