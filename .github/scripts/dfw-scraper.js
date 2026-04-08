const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Airport Configuration
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
 * Get current time in Central Time for database logging
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
 * Extract terminal identifiers based on LocusLabs floorId patterns
 */
function extractTerminal(floorId, airportCode) {
  if (!floorId) return 'Main';
  
  if (airportCode === 'DFW') {
    const match = floorId.match(/terminal([a-e])/i);
    return match ? match[1].toUpperCase() : 'Unknown';
  }
  
  if (airportCode === 'MSP') {
    const match = floorId.match(/t(\d)/i);
    return match ? `T${match[1]}` : 'T1';
  }
  
  return 'Main';
}

/**
 * Generalize queue naming structure for cleaner UI
 * LocusLabs: 'general' | 'tsapre' | 'priority'
 * Q-ly: 'standard' | 'precheck' | 'priority'
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
      
      if (!resp.ok) throw new Error(`HTTP ${resp.status
