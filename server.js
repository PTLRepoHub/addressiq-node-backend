require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── Local mock upstream (MOCK_UPSTREAM=1) ──
// Serves the `/api/v1/*` paths the IQCollect web widget calls directly, so the
// full flow (session → list addresses → start-verification → collect) runs with
// zero dependency on api.addressiqpro.com. Toggle the address-book branches via
// `hasSavedAddresses` in mock-fixtures.json.
const MOCK_UPSTREAM = process.env.MOCK_UPSTREAM === '1';
const FIXTURES_PATH = path.join(__dirname, 'mock-fixtures.json');

function loadFixtures() {
  try {
    return JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));
  } catch (err) {
    console.warn(`[Mock] Could not read fixtures (${err.message}); using empty defaults.`);
    return { hasSavedAddresses: false, savedAddresses: [], business: {} };
  }
}

function mockId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

if (MOCK_UPSTREAM) {
  // Session create — mirrors POST /api/v1/widget/sessions/create.
  app.post('/api/v1/widget/sessions/create', (req, res) => {
    const { phone, email } = req.body || {};
    console.log(`[Mock] Session create for ${phone || email || 'anon'}`);
    res.json({ sessionId: mockId('sess'), sessionToken: mockId('tok') });
  });

  // Business branding for the tenant behind the API key (NEW — the widget reads
  // its business identity here rather than the integrator hardcoding it).
  app.get('/api/v1/widget/config', (req, res) => {
    const fx = loadFixtures();
    console.log(`[Mock] Widget config → business "${(fx.business || {}).displayName || '(unset)'}"`);
    res.json({ business: fx.business || {}, googleMapsApiKey: GOOGLE_MAPS_API_KEY || undefined });
  });

  // List a user's saved addresses across businesses (NEW — address book source).
  app.get('/api/v1/locations', (req, res) => {
    const fx = loadFixtures();
    const addresses = fx.hasSavedAddresses ? (fx.savedAddresses || []) : [];
    console.log(`[Mock] List addresses for ${req.query.appUserId || 'anon'} → ${addresses.length}`);
    res.json({ addresses, business: fx.business || {} });
  });

  // Start verification for an EXISTING address (NEW — address-book "Verify").
  app.post('/api/v1/verifications/start', (req, res) => {
    const { locationCode, appUserId } = req.body || {};
    if (!locationCode) return res.status(400).json({ code: 'MISSING_LOCATION_CODE', message: 'locationCode is required' });
    const verificationId = mockId('ver');
    console.log(`[Mock] Start verification ${verificationId} for ${locationCode} (${appUserId || 'anon'})`);
    console.log(`[Mock] would-send-email → verification "${verificationId}" started for ${locationCode}`);
    res.json({ verificationId, locationCode, status: 'PENDING' });
  });

  // Collect a NEW address, then implicitly start its verification.
  app.post('/api/v1/locations/collect', (req, res) => {
    const locationCode = mockId('LOC');
    const verificationId = mockId('ver');
    console.log(`[Mock] Collect new address → ${locationCode}`);
    console.log(`[Mock] would-send-email → verification "${verificationId}" started for ${locationCode}`);
    res.json({ locationCode, verificationId, status: 'PENDING' });
  });

  console.log('[Mock] MOCK_UPSTREAM=1 — serving canned /api/v1/* responses from mock-fixtures.json');
}

// Environment-based URL configuration
const ENVIRONMENT_URLS = {
  production: {
    apiUrl: 'https://api.addressiqpro.com',
    ingestUrl: 'https://ingest-api.addressiqpro.com',
  },
  staging: {
    apiUrl: 'https://api-staging.addressiqpro.com',
    ingestUrl: 'https://ingest-api-staging.addressiqpro.com',
  },
  local: {
    apiUrl: 'http://localhost:4000',
    ingestUrl: 'http://localhost:4001',
  },
};

const ENV = process.env.ENVIRONMENT || 'staging';
const envUrls = ENVIRONMENT_URLS[ENV] || ENVIRONMENT_URLS.staging;
const API_URL = process.env.ADDRESSIQ_API_URL || envUrls.apiUrl;
const INGEST_URL = process.env.ADDRESSIQ_INGEST_URL || envUrls.ingestUrl;
const API_KEY = process.env.ADDRESSIQ_API_KEY || 'fsp_test_hE2DIQASZmuWS7cU9l1MyhZcmmXG1Rfw';
// Client-side Google Maps key for the demo widget's address map. Read from
// .env (gitignored) so it isn't committed. Empty → the map degrades to manual
// address entry.
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '66850035a4e0866156e4bd95e7468c4a455afdfe183f17d4fb53a50d21a0980d';
const PORT = process.env.PORT || 3333;

// In-memory stores
const webhookEvents = [];
let currentSession = null;

// ── Helpers ──

async function addressiqFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      ...options.headers,
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

// ── Live widget proxy (when MOCK_UPSTREAM is off) ──
// Forwards the IQCollect widget's `/api/v1/*` calls to the configured upstream
// (ENVIRONMENT=local → localhost:4000, staging, or production) using the
// server-side API key. This is the "connect to the real API" path: run the
// backend WITHOUT MOCK_UPSTREAM and point the widget's apiUrl at this server.
if (!MOCK_UPSTREAM) {
  app.all('/api/v1/*', async (req, res) => {
    const target = `${API_URL}${req.originalUrl}`;
    try {
      const init = { method: req.method, headers: { 'x-api-key': API_KEY } };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(req.body || {});
      }
      const upstream = await fetch(target, init);
      const body = await upstream.text();
      const ct = upstream.headers.get('content-type');
      if (ct) res.set('content-type', ct);
      console.log(`[Proxy] ${req.method} ${req.originalUrl} → ${API_URL} (${upstream.status})`);
      res.status(upstream.status).send(body);
    } catch (err) {
      console.error(`[Proxy] ${req.method} ${req.originalUrl} → ${API_URL} failed:`, err.message);
      res.status(502).json({ code: 'UPSTREAM_UNREACHABLE', message: err.message });
    }
  });
  console.log(`[Proxy] Live mode — forwarding /api/v1/* → ${API_URL} with server API key`);
}

// ── Routes ──

// Demo-only config the local.html harness reads at startup (e.g. the Google
// Maps key). Keeps keys out of the committed example HTML.
app.get('/api/demo/config', (_req, res) => {
  res.json({ googleMapsApiKey: GOOGLE_MAPS_API_KEY });
});

// 1. Create a widget session (server-to-server)
app.post('/api/session', async (req, res) => {
  try {
    const { phone, firstName, lastName, email } = req.body;

    console.log(`[Session] Creating for ${phone}...`);

    const data = await addressiqFetch(`${API_URL}/api/v1/widget/sessions/create`, {
      method: 'POST',
      body: JSON.stringify({ phone, firstName, lastName, email }),
    });

    currentSession = { ...data, phone };
    console.log(`[Session] Created: ${data.sessionId}`);

    res.json(data);
  } catch (err) {
    console.error('[Session] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 2. Submit address (proxy with session token)
app.post('/api/submit-address', async (req, res) => {
  try {
    if (!currentSession?.sessionToken) {
      return res.status(400).json({ error: 'No active session. Create one first.' });
    }

    const { lat, lon, propertyNumber, streetName, buildingColor, propertyName, directions, plusCode } = req.body;

    console.log(`[Address] Submitting at ${lat}, ${lon}...`);

    const submitRes = await fetch(`${API_URL}/api/v1/widget/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentSession.sessionToken}`,
      },
      body: JSON.stringify({
        lat, lon,
        placeId: 'demo_place_id',
        propertyNumber: propertyNumber || '12',
        streetName: streetName || 'Broad Street',
        buildingColor: buildingColor || 'White',
        propertyName, directions, plusCode,
      }),
    });

    const data = await submitRes.json();
    if (!submitRes.ok) throw new Error(data.message || `HTTP ${submitRes.status}`);

    console.log(`[Address] Verification started: ${data.verificationCode}`);
    res.json(data);
  } catch (err) {
    console.error('[Address] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 3. Get verification status (proxy)
app.get('/api/status/:verificationId', async (req, res) => {
  try {
    const data = await addressiqFetch(
      `${API_URL}/api/v1/verifications/${req.params.verificationId}`,
    );
    res.json(data);
  } catch (err) {
    console.error('[Status] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 4. Send location pings (proxy to ingest)
app.post('/api/send-pings', async (req, res) => {
  try {
    const { events } = req.body;

    const ingestRes = await fetch(`${INGEST_URL}/v1/transit-events/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      },
      body: JSON.stringify({ events }),
    });

    const data = await ingestRes.json();
    if (!ingestRes.ok) throw new Error(data.message || `HTTP ${ingestRes.status}`);

    console.log(`[Pings] Sent ${events.length} events`);
    res.json(data);
  } catch (err) {
    console.error('[Pings] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 5. Webhook receiver
app.post('/api/webhook', (req, res) => {
  const signature = req.headers['x-addressiq-signature'] || '';
  const deliveryId = req.headers['x-delivery-id'] || '';
  const attempt = req.headers['x-attempt'] || '1';

  // Verify HMAC signature (optional — skip if no secret configured)
  let signatureValid = !WEBHOOK_SECRET; // true if no secret = accept all
  if (WEBHOOK_SECRET && signature) {
    const expected = 'sha256=' + crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(JSON.stringify(req.body))
      .digest('hex');
    signatureValid = signature === expected;
  }

  const event = {
    id: deliveryId,
    attempt: Number(attempt),
    receivedAt: new Date().toISOString(),
    signatureValid,
    payload: req.body,
  };

  webhookEvents.unshift(event);
  // Keep last 50
  if (webhookEvents.length > 50) webhookEvents.length = 50;

  console.log(`[Webhook] Received: ${req.body?.event || 'unknown'} | Signature: ${signatureValid ? 'VALID' : 'INVALID'}`);

  res.status(200).json({ received: true });
});

// 6. Get webhook events (for the app to display)
app.get('/api/webhook/events', (_req, res) => {
  res.json(webhookEvents);
});

// 7. Trigger simulation (dev shortcut)
app.post('/api/simulate/:verificationId', async (req, res) => {
  try {
    const { targetStatus } = req.body;
    const data = await addressiqFetch(`${API_URL}/api/v1/verifications/simulate`, {
      method: 'POST',
      body: JSON.stringify({
        verificationId: req.params.verificationId,
        targetStatus: targetStatus || 'VERIFIED',
      }),
    });
    console.log(`[Simulate] ${req.params.verificationId} → ${data.status}`);
    res.json(data);
  } catch (err) {
    console.error('[Simulate] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──

app.listen(PORT, () => {
  console.log(`\n  AddressIQ Demo Backend`);
  console.log(`  ─────────────────────────`);
  console.log(`  Env:       ${ENV}${MOCK_UPSTREAM ? ' (MOCK_UPSTREAM)' : ''}`);
  console.log(`  Server:    http://localhost:${PORT}`);
  console.log(`  API:       ${API_URL}`);
  console.log(`  Ingest:    ${INGEST_URL}`);
  console.log(`  Webhook:   http://localhost:${PORT}/api/webhook`);
  console.log(`  API Key:   ${API_KEY ? API_KEY.slice(0, 12) + '...' : '(not set)'}`);
  console.log('');
});
