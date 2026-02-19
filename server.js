// ============================================================
// FindMyDog — Server-side dog simulation
// Runs forever on Railway. Clients are pure read-only observers.
// ============================================================

process.env.TZ = 'America/New_York';

// Global error handlers — first so nothing crashes silently
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack);
  // Do NOT exit — keep HTTP server alive
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  // Do NOT exit — keep HTTP server alive
});

const admin = require('firebase-admin');
const http  = require('http');

// ============================================================
// HTTP server — bound immediately so Railway keeps the container alive
// ============================================================
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  const status = {
    status:      'ok',
    activeHours: isActiveHours(),
    dog:         dog ? `${dog.dogName} (${dog.dateKey})` : 'none',
    position:    dog ? { lat: dog.lat.toFixed(6), lng: dog.lng.toFixed(6) } : null,
    uptime:      Math.round(process.uptime()) + 's',
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(status));
}).listen(PORT, () => {
  console.log(`[SERVER] HTTP server listening on port ${PORT}`);
});

// ============================================================
// Firebase init
// ============================================================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
console.log('[SERVER] Firebase Admin initialized');

// ============================================================
// CONFIG
// ============================================================
const DOGS = [
  { id: 'dog1', name: 'Claver', image: 'dogs/claver.png' },
  { id: 'dog2', name: 'Cashew', image: 'dogs/cashew.png' },
  { id: 'dog3', name: 'Java',   image: 'dogs/java.png'   },
  { id: 'dog4', name: 'Angel',  image: 'dogs/angel.png'  },
  { id: 'dog5', name: 'Kesha',  image: 'dogs/kesha.png'  },
  { id: 'dog6', name: 'Buddy',  image: 'dogs/buddy.png'  },
  { id: 'dog7', name: 'Max',    image: 'dogs/max.png'    },
];

const BC_BOUNDARY = [
  [42.33224350973427, -71.17622608785834],
  [42.33294418013368, -71.17670186131114],
  [42.334696698297854,-71.17617488356345],
  [42.334723208937135,-71.17355845252719],
  [42.33364940855117, -71.1726398624431 ],
  [42.33452480446149, -71.17177160723693],
  [42.3371744184889,  -71.17224573285121],
  [42.339004671862,   -71.16981411429009],
  [42.33983359003376, -71.16677242009746],
  [42.34003246804304, -71.16471273471637],
  [42.33847109761738, -71.16474563289441],
  [42.33693062395219, -71.16402897148993],
  [42.33606965117531, -71.16563611774984],
  [42.33515614285314, -71.16397622579184],
  [42.33384055554289, -71.16419197870498],
  [42.33285235206975, -71.17273406243879],
  [42.33251237623095, -71.1753307857849 ],
];

const DOG_TICK_MS        = 1000; // tick every 1s
const FIRESTORE_WRITE_MS = 3000; // write to Firestore every 3s

// ============================================================
// Active hours: 10am–2am Eastern
// 10am to 1:59am = 16 hours = 19,200 writes/day at 3s cadence
// ============================================================
function isActiveHours() {
  const hour = new Date().getHours();
  return hour >= 10 || hour < 2; // 10:00am–1:59am
}

// ============================================================
// Spawn date key — the date the CURRENT dog was spawned (10am basis).
// Between midnight and 2am, the active dog belongs to YESTERDAY
// because it spawned at yesterday's 10am.
// Between 2am and 10am, there is no active dog (returns null).
// At 10am+, the active dog belongs to TODAY.
// ============================================================
function spawnDateKey() {
  const now  = new Date();
  const hour = now.getHours();

  if (hour >= 10) {
    // Today's dog
    return formatDate(now);
  } else if (hour < 2) {
    // Yesterday's dog (still running until 2am)
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return formatDate(yesterday);
  } else {
    // 2am–10am: no active dog
    return null;
  }
}

function formatDate(d) {
  const y   = d.getFullYear();
  const m   = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// todayKey is only used to name a new dog when it spawns at 10am
function todayKey() {
  return formatDate(new Date());
}

// ============================================================
// Math helpers
// ============================================================
function metersToLat(m)      { return m / 111320; }
function metersToLng(m, lat) { return m / (111320 * Math.cos(lat * Math.PI / 180)); }

function polygonBbox(poly) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [lat, lng] of poly) {
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

function pointInPolygon(lat, lng, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    const hit = (yi > lat) !== (yj > lat) &&
                lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function randomPointInPolygon(poly, tries = 800) {
  const b = polygonBbox(poly);
  for (let k = 0; k < tries; k++) {
    const lat = b.minLat + Math.random() * (b.maxLat - b.minLat);
    const lng = b.minLng + Math.random() * (b.maxLng - b.minLng);
    if (pointInPolygon(lat, lng, poly)) return { lat, lng };
  }
  return { lat: 42.3355, lng: -71.1685 };
}

// ============================================================
// Week / schedule helpers
// ============================================================
function getWeekKey(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const dayNum = d.getDay() || 7;
  d.setDate(d.getDate() + 4 - dayNum);
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function getDayOfWeek(date = new Date()) {
  const day = date.getDay();
  return day === 0 ? 6 : day - 1;
}

async function getOrCreateWeeklySchedule(weekKey) {
  const ref = db.collection('weeklySchedules').doc(weekKey);
  const doc = await ref.get();
  if (doc.exists) return doc.data().schedule;

  const shuffled = [...DOGS].sort(() => Math.random() - 0.5).map(d => d.id);
  await ref.set({ weekKey, schedule: shuffled, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  console.log('[SCHEDULE] Created schedule for', weekKey, ':', shuffled);
  return shuffled;
}

async function getDogForDate(dateKey) {
  // Parse as local midnight — new Date('2026-02-19') parses as UTC midnight
  // which is 7pm ET the day before, giving the wrong day index.
  const date      = new Date(dateKey + 'T00:00:00');
  const weekKey   = getWeekKey(date);
  const dayOfWeek = getDayOfWeek(date);
  const schedule  = await getOrCreateWeeklySchedule(weekKey);
  const dogId     = schedule[dayOfWeek];
  return DOGS.find(d => d.id === dogId) || DOGS[0];
}

// ============================================================
// Dog state (in-memory)
// ============================================================
let dog   = null;
let dirty = false;

// ============================================================
// Publish current state to meta/currentDog so clients know
// what to load (or that there's no active dog right now)
// ============================================================
async function publishMeta(dateKey) {
  try {
    await db.collection('meta').doc('currentDog').set({
      dateKey: dateKey || null,
      active:  !!dateKey,
    });
    console.log('[SERVER] Published meta — active:', !!dateKey, 'dateKey:', dateKey);
  } catch (err) {
    console.warn('[SERVER] Could not publish meta (non-fatal):', err.message);
  }
}

// ============================================================
// Load or create dog for a given dateKey
// ============================================================
async function loadOrCreateDog(dateKey) {
  const dogInfo = await getDogForDate(dateKey);
  const ref     = db.collection('dogs').doc(dateKey);

  let doc;
  try {
    doc = await ref.get();
  } catch (err) {
    console.warn('[SERVER] Could not read Firestore, using in-memory fallback:', err.message);
    const p = randomPointInPolygon(BC_BOUNDARY);
    dog = {
      dateKey, dogId: dogInfo.id, dogName: dogInfo.name, dogImage: dogInfo.image,
      lat: p.lat, lng: p.lng,
      speedMps: (1.75 + Math.random() * 0.5) * 0.44704,
      headingRad: Math.random() * Math.PI * 2,
      lastUpdateMs: Date.now(),
    };
    return;
  }

  if (doc.exists) {
    const d = doc.data();
    console.log(`[DOG] Loaded ${d.dogName} (${dateKey}) @ ${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`);
    dog = {
      dateKey,
      dogId:        d.dogId    || dogInfo.id,
      dogName:      d.dogName  || dogInfo.name,
      dogImage:     d.dogImage || dogInfo.image,
      lat:          d.lat,
      lng:          d.lng,
      speedMps:     d.speedMps,
      headingRad:   d.headingRad,
      lastUpdateMs: d.lastUpdateMs || Date.now(),
    };
  } else {
    console.log(`[DOG] Creating new dog for ${dateKey}: ${dogInfo.name}`);
    const p        = randomPointInPolygon(BC_BOUNDARY);
    const speedMps = (1.75 + Math.random() * 0.5) * 0.44704; // 1.75–2.25 mph

    dog = {
      dateKey, dogId: dogInfo.id, dogName: dogInfo.name, dogImage: dogInfo.image,
      lat: p.lat, lng: p.lng, speedMps,
      headingRad:   Math.random() * Math.PI * 2,
      lastUpdateMs: Date.now(),
    };

    try {
      await ref.set({
        ...dog,
        createdBy:        'server',
        createdAt:        admin.firestore.FieldValue.serverTimestamp(),
        serverControlled: true,
      });
    } catch (err) {
      console.warn('[SERVER] Could not save new dog (will retry on flush):', err.message);
      dirty = true;
    }
  }
}

// ============================================================
// Tick
// ============================================================
function tickDog(dtSeconds) {
  if (!dog || !isActiveHours()) return;

  const stepM = dog.speedMps * dtSeconds;
  const dLat  = metersToLat(stepM * Math.cos(dog.headingRad));
  const dLng  = metersToLng(stepM * Math.sin(dog.headingRad), dog.lat);
  const nextLat = dog.lat + dLat;
  const nextLng = dog.lng + dLng;

  if (pointInPolygon(nextLat, nextLng, BC_BOUNDARY)) {
    dog.lat = nextLat;
    dog.lng = nextLng;
  } else {
    dog.headingRad = (dog.headingRad + Math.PI + (Math.random() - 0.5) * 0.6) % (Math.PI * 2);
  }

  dog.lastUpdateMs = Date.now();
  dirty = true;
}

// ============================================================
// Flush to Firestore
// ============================================================
async function flushToFirestore() {
  if (!dog || !dirty || !isActiveHours()) return;
  dirty = false;

  try {
    await db.collection('dogs').doc(dog.dateKey).update({
      lat: dog.lat, lng: dog.lng,
      headingRad:      dog.headingRad,
      speedMps:        dog.speedMps,
      lastUpdateMs:    dog.lastUpdateMs,
      serverHeartbeat: Date.now(),
    });
  } catch (err) {
    console.error('[FIRESTORE] Write error:', err.message);
    dirty = true;
  }
}

// ============================================================
// Main loop
// ============================================================
let tickTimer  = null;
let writeTimer = null;

function scheduleHeadingChange() {
  setTimeout(() => {
    if (dog && isActiveHours()) {
      const turn = (Math.random() - 0.5) * (Math.PI / 2);
      dog.headingRad = (dog.headingRad + turn + Math.PI * 2) % (Math.PI * 2);
      dirty = true;
    }
    scheduleHeadingChange();
  }, 3000 + Math.random() * 4000);
}

function stopLoop() {
  if (tickTimer)  { clearInterval(tickTimer);  tickTimer  = null; }
  if (writeTimer) { clearInterval(writeTimer); writeTimer = null; }
}

async function startLoop() {
  stopLoop();

  const dateKey = spawnDateKey();

  if (!dateKey) {
    // 2am–10am: no active dog
    console.log('[SERVER] Inactive hours (2am–10am) — no dog running');
    dog = null;
    await publishMeta(null);
    return;
  }

  await loadOrCreateDog(dateKey);
  await publishMeta(dateKey);

  scheduleHeadingChange();
  tickTimer  = setInterval(() => tickDog(DOG_TICK_MS / 1000), DOG_TICK_MS);
  writeTimer = setInterval(flushToFirestore, FIRESTORE_WRITE_MS);

  console.log(`[SERVER] Simulation running for ${dog.dogName} on ${dog.dateKey}`);
}

// ============================================================
// Watcher — checks every 30s for state transitions
//
// Transitions we care about:
//   active → inactive  (2am):  stop loop, clear dog
//   inactive → active  (10am): start loop with today's dog
//
// Midnight is intentionally ignored — the dog from yesterday's
// 10am keeps running until 2am regardless of calendar date.
// ============================================================
let wasActive = isActiveHours();

setInterval(async () => {
  const nowActive = isActiveHours();

  if (wasActive && !nowActive) {
    // Transition: active → inactive (just hit 2am)
    console.log('[SERVER] 2am — dog going to sleep, stopping simulation');
    stopLoop();
    dog = null;
    await publishMeta(null);
  } else if (!wasActive && nowActive) {
    // Transition: inactive → active (just hit 10am)
    console.log('[SERVER] 10am — spawning new dog for', todayKey());
    await startLoop();
  }

  wasActive = nowActive;
}, 30_000);

// ============================================================
// Boot — retry on failure
// ============================================================
async function boot() {
  let attempts = 0;
  while (true) {
    try {
      await startLoop();
      console.log('[SERVER] Boot successful');
      return;
    } catch (err) {
      attempts++;
      const wait = Math.min(attempts * 5000, 30000);
      console.error(`[SERVER] Boot attempt ${attempts} failed: ${err.message}. Retrying in ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

boot();

process.on('SIGTERM', () => {
  console.log('[SERVER] Shutting down gracefully');
  stopLoop();
  process.exit(0);
});