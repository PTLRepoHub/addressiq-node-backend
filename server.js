require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

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

// ── Routes ──

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

    console.log(`[Address] Verification started: ${data.verificationId}`);
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
  console.log(`  Env:       ${ENV}`);
  console.log(`  Server:    http://localhost:${PORT}`);
  console.log(`  API:       ${API_URL}`);
  console.log(`  Ingest:    ${INGEST_URL}`);
  console.log(`  Webhook:   http://localhost:${PORT}/api/webhook`);
  console.log(`  API Key:   ${API_KEY ? API_KEY.slice(0, 12) + '...' : '(not set)'}`);
  console.log('');
});
