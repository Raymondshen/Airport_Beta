const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const AIRPORTS = [
  { code: 'DFW', name: 'Dallas/Fort Worth International', venueId: 'dfw' },
  { code: 'MSP', name: 'Minneapolis-St. Paul International', venueId: 'msp' },
  { code: 'MCO', name: 'Orlando International', venueId: 'mco' },
  { code: 'DEN', name: 'Denver International', venueId: 'den' },
  { code: 'PHX', name: 'Phoenix Sky Harbor International', venueId: 'phx' },
  { code: 'SEA', name: 'Seattle-Tacoma International', venueId: 'sea' }
];

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: 'numeric', minute: '2-digit', hour12: true
});

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
  if (airportCode === 'SEA') return fid.includes('main') ? 'Main' : 'Satellite';
  if (airportCode === 'DEN') return 'Main Terminal';
  return 'Main';
}

function normalizeQueueType(queueSubtype) {
  const s = (queueSubtype || '').toLowerCase();
  if (s.includes('pre')) return 'precheck';
  if (s.includes('priority')) return 'priority';
  return 'standard';
}

async function runSync() {
  const nowRaw = new Date();
  const nowISO = nowRaw.toISOString();

  for (const airport of AIRPORTS) {
    try {
      const resp = await fetch(`https://marketplace.locuslabs.com/venueId/${airport.venueId}/dynamic-poi`);
      const json = await resp.json();
      const data = json.data;

      const checkpoints = Object.values(data).filter(poi => {
        const category = (poi.category || '').toLowerCase();
        const name = (poi.name || '').toLowerCase();
        return (category.includes('security') || name.includes('checkpoint')) && poi.dynamicData?.queue;
      });

      console.log(`[${airport.code}] Syncing ${checkpoints.length} checkpoints...`);

      for (const cp of checkpoints) {
        const queue = cp.dynamicData.queue;
        const terminal = extractTerminal(cp.position?.floorId, airport.code);
        const queueType = normalizeQueueType(cp.queue?.queueSubtype || queue.queueSubtype);
        const checkpointName = cp.name || 'Main Checkpoint';
        
        const isVerified = !queue.isQueueTimeDefault;
        const isClosed = cp.isClosed === true || cp.isTemporarilyClosed === true;
        const waitMinutes = isClosed ? null : (queue.queueTime ?? null);
        const prettyTime = timeFormatter.format(cp.timestamp ? new Date(cp.timestamp) : nowRaw);

        // RPC CALL: Stripped of local_time_ct and type
        await supabase.rpc('upsert_wait_time', {
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
      }
    } catch (err) {
      console.error(`[${airport.code}] Error:`, err.message);
    }
  }
  console.log('Sync complete.');
}

runSync();
