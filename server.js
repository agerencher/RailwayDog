// ============================================================
// FindMyDog — Server-side dog simulation
// Runs forever on Railway. Clients are pure read-only observers.
// ============================================================

process.env.TZ = 'America/New_York';
const admin = require('firebase-admin');

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('[SERVER] FATAL: FIREBASE_SERVICE_ACCOUNT environment variable is not set');
  process.exit(1);
}

// ------------------------------------
// Firebase init (uses env var on Railway)
// ------------------------------------
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
console.log('[SERVER] Firebase Admin initialized');

// ============================================================
// CONFIG — must match your client exactly
// ============================================================
const DOGS = [
  { id: 'dog1', name: 'Claver',  image: 'dogs/claver.png'  },
  { id: 'dog2', name: 'Cashew',  image: 'dogs/cashew.png'  },
  { id: 'dog3', name: 'Java',    image: 'dogs/java.png'    },
  { id: 'dog4', name: 'Angel',   image: 'dogs/angel.png'   },
  { id: 'dog5', name: 'Kesha',   image: 'dogs/kesha.png'   },
  { id: 'dog6', name: 'Buddy',   image: 'dogs/buddy.png'   },
  { id: 'dog7', name: 'Max',     image: 'dogs/max.png'     },
];

const BC_BOUNDARY = [
  [42.33224350973427,-71.17622608785834],
  [42.33294418013368,-71.17670186131114],
  [42.334696698297854,-71.17617488356345],
  [42.334723208937135,-71.17355845252719],
  [42.33364940855117,-71.1726398624431],
  [42.33452480446149,-71.17177160723693],
  [42.3371744184889,-71.17224573285121],
  [42.339004671862,-71.16981411429009],
  [42.33983359003376,-71.16677242009746],
  [42.34003246804304,-71.16471273471637],
  [42.33847109761738,-71.16474563289441],
  [42.33693062395219,-71.16402897148993],
  [42.33606965117531,-71.16563611774984],
  [42.33515614285314,-71.16397622579184],
  [42.33384055554289,-71.16419197870498],
  [42.33285235206975,-71.17273406243879],
  [42.33251237623095,-71.1753307857849],
];

const DOG_TICK_MS       = 1000;  // advance simulation every 1s
const FIRESTORE_WRITE_MS = 3000; // write to Firestore every 3s (saves quota)
const HEADING_CHANGE_MS  = 5000; // pick a new direction every ~5s (jittered)

// ============================================================
// Math helpers (mirrors client)
// ============================================================
function metersToLat(m)       { return m / 111320; }
function metersToLng(m, lat)  { return m / (111320 * Math.cos(lat * Math.PI / 180)); }

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
  return { lat: 42.3355, lng: -71.1685 }; // fallback: BC center
}

// ============================================================
// Date helpers (mirrors client)
// ============================================================
function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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

// ============================================================
// Weekly schedule (mirrors client)
// ============================================================
async function getOrCreateWeeklySchedule(weekKey) {
  const ref = db.collection('weeklySchedules').doc(weekKey);
  const doc = await ref.get();
  if (doc.exists) return doc.data().schedule;

  const shuffled = [...DOGS].sort(() => Math.random() - 0.5).map(d => d.id);
  await ref.set({ weekKey, schedule: shuffled, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  console.log('[SCHEDULE] Created new schedule for', weekKey, ':', shuffled);
  return shuffled;
}

async function getDogForDate(dateKey) {
  const date   = new Date(dateKey);
  const weekKey = getWeekKey(date);
  const dayOfWeek = getDayOfWeek(date);
  const schedule  = await getOrCreateWeeklySchedule(weekKey);
  const dogId  = schedule[dayOfWeek];
  return DOGS.find(d => d.id === dogId) || DOGS[0];
}

// ============================================================
// Dog state (in-memory)
// ============================================================
let dog = null;         // { dateKey, dogId, dogName, dogImage, lat, lng, speedMps, headingRad, lastUpdateMs }
let dirty = false;      // true when in-memory state differs from Firestore

// ============================================================
// Load or create today's dog from Firestore
// ============================================================
async function loadOrCreateDog() {
  const dateKey = todayKey();
  const dogInfo = await getDogForDate(dateKey);
  const ref = db.collection('dogs').doc(dateKey);

  // Publish active dateKey — non-fatal if it fails (quota, network, etc.)
  try {
    await db.collection('meta').doc('currentDog').set({ dateKey });
    console.log('[SERVER] Published active dateKey:', dateKey);
  } catch (err) {
    console.warn('[SERVER] Could not publish dateKey (non-fatal):', err.message);
  }

  let doc;
  try {
    doc = await ref.get();
  } catch (err) {
    console.warn('[SERVER] Could not read dog from Firestore, using in-memory fallback:', err.message);
    // Build an in-memory dog so the server keeps running even if Firestore is down
    if (!dog) {
      const p = randomPointInPolygon(BC_BOUNDARY);
      dog = {
        dateKey,
        dogId:        dogInfo.id,
        dogName:      dogInfo.name,
        dogImage:     dogInfo.image,
        lat:          p.lat,
        lng:          p.lng,
        speedMps:     (1.75 + Math.random() * 0.5) * 0.44704,
        headingRad:   Math.random() * Math.PI * 2,
        lastUpdateMs: Date.now(),
      };
    }
    return;
  }

  if (doc.exists) {
    const d = doc.data();
    console.log(`[DOG] Loaded existing dog for ${dateKey}: ${d.dogName} @ ${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`);
    dog = {
      dateKey:      d.dateKey,
      dogId:        d.dogId    || dogInfo.id,
      dogName:      d.dogName  || dogInfo.name,
      dogImage:     d.dogImage || dogInfo.image,
      lat:          d.lat,
      lng:          d.lng,
      speedMps:     d.speedMps,
      headingRad:   d.headingRad,
      lastUpdateMs: d.lastUpdateMs || Date.now(),
    };

    // Patch old docs missing dog info (non-fatal)
    if (!d.dogId) {
      try {
        await ref.update({ dogId: dogInfo.id, dogName: dogInfo.name, dogImage: dogInfo.image });
      } catch (err) {
        console.warn('[SERVER] Could not patch dog info:', err.message);
      }
    }
  } else {
    console.log(`[DOG] Creating new dog for ${dateKey}: ${dogInfo.name}`);
    const p = randomPointInPolygon(BC_BOUNDARY);
    const speedMps = (1.75 + Math.random() * 0.5) * 0.44704;

    dog = {
      dateKey,
      dogId:        dogInfo.id,
      dogName:      dogInfo.name,
      dogImage:     dogInfo.image,
      lat:          p.lat,
      lng:          p.lng,
      speedMps,
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
      console.warn('[SERVER] Could not save new dog to Firestore (will retry on next flush):', err.message);
      dirty = true; // mark dirty so flushToFirestore retries when quota resets
    }
  }
}

// ============================================================
// Tick — advance dog position by dtSeconds
// ============================================================
function tickDog(dtSeconds) {
  if (!dog) return;

  const stepM = dog.speedMps * dtSeconds;
  const dLat  = metersToLat(stepM * Math.cos(dog.headingRad));
  const dLng  = metersToLng(stepM * Math.sin(dog.headingRad), dog.lat);

  const nextLat = dog.lat + dLat;
  const nextLng = dog.lng + dLng;

  if (pointInPolygon(nextLat, nextLng, BC_BOUNDARY)) {
    dog.lat = nextLat;
    dog.lng = nextLng;
  } else {
    // Bounce: reverse heading + small random wiggle
    dog.headingRad = (dog.headingRad + Math.PI + (Math.random() - 0.5) * 0.6) % (Math.PI * 2);
  }

  dog.lastUpdateMs = Date.now();
  dirty = true;
}

// ============================================================
// Flush in-memory state to Firestore (called on a slower cadence)
// ============================================================
async function flushToFirestore() {
  if (!dog || !dirty) return;
  dirty = false;

  try {
    await db.collection('dogs').doc(dog.dateKey).update({
      lat:          dog.lat,
      lng:          dog.lng,
      headingRad:   dog.headingRad,
      speedMps:     dog.speedMps,
      lastUpdateMs: dog.lastUpdateMs,
      serverHeartbeat: Date.now(), // lets clients know the server is alive
    });
  } catch (err) {
    console.error('[FIRESTORE] Write error:', err.message);
    dirty = true; // retry next cycle
  }
}

// ============================================================
// Main loop
// ============================================================
let tickTimer     = null;
let writeTimer    = null;
let headingTimer  = null;

function scheduleHeadingChange() {
  const delay = 3000 + Math.random() * 4000; // 3–7 s
  setTimeout(() => {
    if (dog) {
      const turn = (Math.random() - 0.5) * (Math.PI / 2); // ±90°
      dog.headingRad = (dog.headingRad + turn + Math.PI * 2) % (Math.PI * 2);
      dirty = true;
    }
    scheduleHeadingChange();
  }, delay);
}

function stopLoop() {
  if (tickTimer)  { clearInterval(tickTimer);  tickTimer  = null; }
  if (writeTimer) { clearInterval(writeTimer); writeTimer = null; }
}

async function startLoop() {
  stopLoop();
  await loadOrCreateDog();

  scheduleHeadingChange();

  tickTimer = setInterval(() => {
    tickDog(DOG_TICK_MS / 1000);
  }, DOG_TICK_MS);

  writeTimer = setInterval(flushToFirestore, FIRESTORE_WRITE_MS);

  console.log(`[SERVER] Simulation running for ${dog.dogName} on ${dog.dateKey}`);
}

// ============================================================
// Day-change watcher — restarts loop at midnight
// ============================================================
let currentDateKey = todayKey();

setInterval(async () => {
  const newKey = todayKey();
  if (newKey !== currentDateKey) {
    console.log(`[SERVER] New day detected: ${currentDateKey} → ${newKey}`);
    currentDateKey = newKey;
    dog = null;
    await startLoop();
  }
}, 30_000); // check every 30s

// ============================================================
// Boot — retry on failure instead of crashing
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
      const wait = Math.min(attempts * 5000, 30000); // back off up to 30s
      console.error(`[SERVER] Boot attempt ${attempts} failed: ${err.message}. Retrying in ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

boot();

// Keep Railway happy — it expects a long-running process
process.on('SIGTERM', () => {
  console.log('[SERVER] Shutting down gracefully');
  stopLoop();
  process.exit(0);
}); 