// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createMollieClient } = require('@mollie/api-client');

const app = express();

/**
 * Config / env
 * - SIMPLYBOOK_COMPANY_LOGIN
 * - SIMPLYBOOK_API_KEY
 * - MOLLIE_API_KEY
 * - CACHE_ADMIN_SECRET (optional; used to purge caches)
 */
const SIMPLYBOOK_CONFIG = {
  company: process.env.SIMPLYBOOK_COMPANY_LOGIN,
  apiKey: process.env.SIMPLYBOOK_API_KEY,
  apiUrl: 'https://user-api.simplybook.me' // base url used by login and (admin) endpoints
};

const mollieClient = createMollieClient({
  apiKey: process.env.MOLLIE_API_KEY || ''
});

if (!SIMPLYBOOK_CONFIG.company || !SIMPLYBOOK_CONFIG.apiKey) {
  console.warn('Warning: SimplyBook company or apiKey not set in env.');
}

app.use(express.json());

/**
 * CORS - adjust allowedOrigins as needed
 */
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const allowedOrigins = [
      'https://maharishiayurveda.de',
      'https://www.maharishiayurveda.de',
      'https://maharishi-ayurveda-de.myshopify.com',
      'https://mh-consultation-booking.vercel.app',
      'http://localhost:9292',
      'http://127.0.0.1:9292'
    ];
    if (allowedOrigins.indexOf(origin) !== -1 || origin.includes('.myshopify.com')) {
      return callback(null, true);
    }
    console.log('Blocked by CORS (origin not explicitly allowed):', origin);
    // Relaxed for testing — change to callback(new Error('Not allowed by CORS')) to enforce.
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));
app.options('*', cors());

// -------------------------
// In-memory caches & helpers
// -------------------------
let tokenCache = {
  token: null,
  fetchedAt: 0,
  ttlMs: 1000 * 60 * 50 // 50 minutes default TTL
};

let servicesCache = {
  data: null,
  fetchedAt: 0,
  ttlMs: 1000 * 60 * 5 // 5 minutes
};

// -------------------------
// Helpers
// -------------------------

/**
 * Obtain and cache SimplyBook token (getToken RPC)
 */
async function getSimplyBookTokenCached() {
  const now = Date.now();
  if (tokenCache.token && (now - tokenCache.fetchedAt) < tokenCache.ttlMs) {
    return tokenCache.token;
  }

  const payload = {
    jsonrpc: '2.0',
    method: 'getToken',
    params: [SIMPLYBOOK_CONFIG.company, SIMPLYBOOK_CONFIG.apiKey],
    id: 1
  };

  try {
    const response = await axios.post(
      `${SIMPLYBOOK_CONFIG.apiUrl}/login`,
      payload,
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    if (!response.data || !response.data.result) {
      throw new Error('No token in SimplyBook response');
    }

    tokenCache.token = response.data.result;
    tokenCache.fetchedAt = Date.now();
    return tokenCache.token;
  } catch (err) {
    console.error('SimplyBook auth error:', err.response?.data || err.message);
    throw new Error('Failed to obtain SimplyBook token');
  }
}

/**
 * Call admin JSON-RPC method on /admin endpoint using X-Token header
 * returns response.data (raw)
 */
async function callAdminRpc(method, params = []) {
  const token = await getSimplyBookTokenCached();
  const payload = {
    jsonrpc: '2.0',
    method,
    params,
    id: 1
  };

  const url = `${SIMPLYBOOK_CONFIG.apiUrl}/admin`;

  const resp = await axios.post(url, payload, {
    headers: {
      'Content-Type': 'application/json',
      'X-Company-Login': SIMPLYBOOK_CONFIG.company,
      'X-Token': token
    },
    timeout: 20000
  });

  return resp.data;
}

/**
 * Call public JSON-RPC method on base user-api endpoint (no X-Token)
 * (fallback for accounts where public methods are available)
 */
async function callPublicRpc(method, params = []) {
  const payload = {
    jsonrpc: '2.0',
    method,
    params,
    id: 1
  };

  const url = `${SIMPLYBOOK_CONFIG.apiUrl}`;

  const resp = await axios.post(url, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 20000
  });

  return resp.data;
}

/**
 * Normalize an event/service item from SimplyBook event list into our "service" shape
 */
function normalizeEventToService(e) {
  // defensive access — SimplyBook event structure varies by account
  const id = e.id || e.event_id || e.eventId || e.id_event || (e.raw && e.raw.id) || null;
  const name = e.name || e.title || e.event_name || (e.raw && (e.raw.name || e.raw.title)) || '';
  const description = e.description || e.long_description || e.info || '';
  // duration may be present as minutes or string
  const duration = e.duration || e.length || e.length_in_minutes || (e.raw && e.raw.length) || '';
  // price may be nested
  let price = '';
  if (e.price) price = String(e.price);
  else if (e.cost) price = String(e.cost);
  else if (e.default_price) price = String(e.default_price);
  else if (e.raw && (e.raw.price || e.raw.cost)) price = String(e.raw.price || e.raw.cost || '');

  const category_name = e.category_name || (e.category && e.category.name) || e.group_name || e.unit_group_name || 'General';

  const image_url = e.image || e.image_url || e.picture_url || (e.raw && (e.raw.picture_url || e.raw.image_url)) || null;
  const status = (e.status || (e.active ? 'online' : 'offline') || 'online').toString();

  return {
    id,
    name,
    description,
    price,
    duration,
    category_name,
    image_url,
    status,
    raw: e
  };
}

/**
 * Fetch services cached but using getEventList RPC (admin) and fallback to public RPCs.
 * This is the main change: we attempt admin getEventList first (requires token header),
 * then try public getEventListPublic, then other fallbacks.
 */
async function fetchServicesCached(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && servicesCache.data && (now - servicesCache.fetchedAt) < servicesCache.ttlMs) {
    return servicesCache.data;
  }

  // We'll try multiple strategies, collecting results if any
  let events = [];

  // 1) Try admin RPC getEventList (recommended)
  try {
    const adminResp = await callAdminRpc('getEventList', []);
    // adminResp may be { result: [...] } or an array directly
    events = Array.isArray(adminResp) ? adminResp : (adminResp.result || adminResp.events || []);
    if (Array.isArray(events) && events.length > 0) {
      // normalize and cache
      const services = events.map(normalizeEventToService);
      // sort stable
      services.sort((a, b) => (a.category_name || '').localeCompare(b.category_name || '') || (a.name || '').localeCompare(b.name || ''));
      servicesCache.data = services;
      servicesCache.fetchedAt = Date.now();
      return services;
    }
    // if adminResp succeeded but returned empty array, fall through to public fallback
    console.warn('getEventList (admin) returned 0 items; falling back to public RPCs.');
  } catch (err) {
    // log and continue to fallback
    console.warn('getEventList (admin) failed:', err.response?.data || err.message);
  }

  // 2) Try public RPC getEventListPublic on base endpoint
  try {
    const publicResp = await callPublicRpc('getEventListPublic', []);
    events = Array.isArray(publicResp) ? publicResp : (publicResp.result || publicResp.events || []);
    if (Array.isArray(events) && events.length > 0) {
      const services = events.map(normalizeEventToService);
      services.sort((a, b) => (a.category_name || '').localeCompare(b.category_name || '') || (a.name || '').localeCompare(b.name || ''));
      servicesCache.data = services;
      servicesCache.fetchedAt = Date.now();
      return services;
    }
    console.warn('getEventListPublic returned 0 items.');
  } catch (err) {
    console.warn('getEventListPublic failed:', err.response?.data || err.message);
  }

  // 3) Try another commonly available public method: getEventList (without admin URL)
  try {
    const publicResp2 = await callPublicRpc('getEventList', []);
    events = Array.isArray(publicResp2) ? publicResp2 : (publicResp2.result || publicResp2.events || []);
    if (Array.isArray(events) && events.length > 0) {
      const services = events.map(normalizeEventToService);
      services.sort((a, b) => (a.category_name || '').localeCompare(b.category_name || '') || (a.name || '').localeCompare(b.name || ''));
      servicesCache.data = services;
      servicesCache.fetchedAt = Date.now();
      return services;
    }
    console.warn('public getEventList returned 0 items.');
  } catch (err) {
    console.warn('public getEventList failed:', err.response?.data || err.message);
  }

  // If we've reached here, no data was found
  const errMsg = 'Failed to fetch services from SimplyBook (no events returned by getEventList/getEventListPublic).';
  console.error('fetchServicesCached error:', errMsg);
  throw new Error(errMsg);
}

// -------------------------
// Routes
// -------------------------
app.get('/', (req, res) => {
  res.json({
    message: 'MH Consultation Booking API',
    status: 'running',
    endpoints: {
      health: '/api/health',
      getSlots: '/api/get-slots',
      createBooking: '/api/create-booking',
      createPayment: '/api/create-payment',
      services: '/api/services'
    }
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Booking API is running',
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /api/services
 */
app.get('/api/services', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    if (force && process.env.NODE_ENV === 'production') {
      const secret = req.headers['x-cache-admin-secret'] || req.query.admin_secret;
      if (!process.env.CACHE_ADMIN_SECRET || secret !== process.env.CACHE_ADMIN_SECRET) {
        return res.status(401).json({ ok: false, error: 'Unauthorized to force refresh cache' });
      }
    }

    const services = await fetchServicesCached(force);
    return res.json({ ok: true, fetched_at: new Date().toISOString(), count: services.length, data: services });
  } catch (err) {
    console.error('/api/services error:', err.message || err);
    // return the low-level RPC error if available for debugging
    return res.status(500).json({ ok: false, error: err.message || 'Failed to fetch services' });
  }
});

/**
 * POST /api/purge-cache
 */
app.post('/api/purge-cache', (req, res) => {
  const secret = req.headers['x-cache-admin-secret'] || req.body?.admin_secret;
  if (!process.env.CACHE_ADMIN_SECRET || secret !== process.env.CACHE_ADMIN_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  tokenCache = { token: null, fetchedAt: 0, ttlMs: tokenCache.ttlMs };
  servicesCache = { data: null, fetchedAt: 0, ttlMs: servicesCache.ttlMs };

  return res.json({ ok: true, message: 'Caches purged' });
});

// Get Available Time Slots using getStartTimeMatrix (unchanged)
app.post('/api/get-slots', async (req, res) => {
  try {
    const { serviceId, date } = req.body;
    if (!serviceId || !date) {
      return res.status(400).json({ success: false, error: 'Service ID and date are required' });
    }

    const token = await getSimplyBookTokenCached();
    const dateObj = new Date(date);
    if (isNaN(dateObj)) return res.status(400).json({ success: false, error: 'Invalid date' });
    const formattedDate = dateObj.toISOString().split('T')[0];

    const rpcPayload = {
      jsonrpc: '2.0',
      method: 'getStartTimeMatrix',
      params: [formattedDate, formattedDate, parseInt(serviceId, 10), null, 1],
      id: 1
    };

    const response = await axios.post(
      SIMPLYBOOK_CONFIG.apiUrl,
      rpcPayload,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Company-Login': SIMPLYBOOK_CONFIG.company,
          'X-Token': token
        },
        timeout: 15000
      }
    );

    const matrix = response.data?.result || {};
    const times = matrix[formattedDate] || [];

    const slots = times.map(t => ({ time: t, available: true, id: `${formattedDate} ${t}` }));
    return res.json({ success: true, slots });
  } catch (error) {
    console.error('get-slots error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: error.response?.data?.message || 'Failed to fetch time slots' });
  }
});

// Create Booking (unchanged)
app.post('/api/create-booking', async (req, res) => {
  try {
    const { serviceId, datetime, clientData } = req.body;
    if (!serviceId || !datetime || !clientData) {
      return res.status(400).json({ success: false, error: 'Missing required booking data' });
    }

    const token = await getSimplyBookTokenCached();
    const adminBase = `${SIMPLYBOOK_CONFIG.apiUrl}/admin`;

    let clientId;
    try {
      const existingClientResp = await axios.get(`${adminBase}/clients`, {
        headers: { 'X-Company-Login': SIMPLYBOOK_CONFIG.company, 'X-Token': token },
        params: { email: clientData.email },
        timeout: 15000
      });
      const clientsRaw = Array.isArray(existingClientResp.data) ? existingClientResp.data : (existingClientResp.data.result || existingClientResp.data.clients || []);
      if (Array.isArray(clientsRaw) && clientsRaw.length > 0) clientId = clientsRaw[0].id;
    } catch (e) {
      console.warn('Client lookup failed, will create new:', e.response?.data || e.message);
    }

    if (!clientId) {
      const clientResp = await axios.post(`${adminBase}/clients`, {
        name: clientData.full_name, email: clientData.email, phone: clientData.phone
      }, {
        headers: { 'X-Company-Login': SIMPLYBOOK_CONFIG.company, 'X-Token': token, 'Content-Type': 'application/json' },
        timeout: 15000
      });
      const clientDataResp = clientResp.data && clientResp.data.id ? clientResp.data : (clientResp.data.result || clientResp.data.client || clientResp.data);
      clientId = clientDataResp.id;
    }

    const bookingResp = await axios.post(`${adminBase}/bookings`, {
      service_id: parseInt(serviceId, 10),
      client_id: parseInt(clientId, 10),
      datetime,
      additional_fields: {
        city: clientData.city || '',
        country: clientData.country || '',
        wellness_priority: clientData.wellness_priority || '',
        consultation_type: clientData.consultation_type || 'in-person',
        translator: clientData.translator || 'no',
        hear_about: clientData.hear_about || '',
        consultation_package: clientData.consultation_package || ''
      }
    }, {
      headers: { 'X-Company-Login': SIMPLYBOOK_CONFIG.company, 'X-Token': token, 'Content-Type': 'application/json' },
      timeout: 15000
    });

    return res.json({ success: true, booking: bookingResp.data, message: 'Booking created successfully' });
  } catch (error) {
    console.error('create-booking error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: error.response?.data?.message || 'Failed to create booking' });
  }
});

// Create Mollie payment (unchanged)
app.post('/api/create-payment', async (req, res) => {
  try {
    const { amount, description, redirectUrl, metadata } = req.body;
    if (!amount || !description || !redirectUrl) return res.status(400).json({ success: false, error: 'amount, description and redirectUrl are required' });
    if (!process.env.MOLLIE_API_KEY) return res.status(500).json({ success: false, error: 'Mollie API key not configured' });

    const payment = await mollieClient.payments.create({
      amount: { value: Number(amount).toFixed(2), currency: 'EUR' },
      description, redirectUrl, metadata: metadata || {}
    });

    return res.json({ success: true, checkoutUrl: payment._links.checkout.href, paymentId: payment.id });
  } catch (err) {
    console.error('Mollie create-payment error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create Mollie payment' });
  }
});

// -------------------------
// Export for serverless (Vercel) and local run
// -------------------------
module.exports = app;

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
  });
}
