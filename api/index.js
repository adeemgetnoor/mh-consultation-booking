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
 * - SIMPLYBOOK_API_KEY (plugin/public API key is fine for getEventList + login)
 * - MOLLIE_API_KEY
 * - CACHE_ADMIN_SECRET (optional; used to purge caches)
 */
const SIMPLYBOOK_CONFIG = {
  company: process.env.SIMPLYBOOK_COMPANY_LOGIN,
  apiKey: process.env.SIMPLYBOOK_API_KEY,
  apiUrl: 'https://user-api.simplybook.me' // public JSON-RPC endpoint (no /admin for getEventList/login)
};

const mollieClient = createMollieClient({
  apiKey: process.env.MOLLIE_API_KEY || ''
});

if (!SIMPLYBOOK_CONFIG.company || !SIMPLYBOOK_CONFIG.apiKey) {
  console.warn('Warning: SimplyBook company or apiKey not set in env.');
}

app.use(express.json());

// CORS - adjust allowedOrigins as needed
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
    if (allowedOrigins.indexOf(origin) !== -1 || (origin && origin.includes('.myshopify.com'))) {
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
      throw new Error('No token in SimplyBook login response');
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
 * fetchServicesCached using public JSON-RPC getEventList
 * Normalizes output into: { id, name, description, price, duration, category_name, image_url, raw }
 */
async function fetchServicesCached(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && servicesCache.data && (now - servicesCache.fetchedAt) < servicesCache.ttlMs) {
    return servicesCache.data;
  }

  const token = await getSimplyBookTokenCached();

  const payload = {
    jsonrpc: '2.0',
    method: 'getEventList',
    params: [], // optionally you can pass filters here if needed
    id: 1
  };

  try {
    const resp = await axios.post(
      SIMPLYBOOK_CONFIG.apiUrl,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Company-Login': SIMPLYBOOK_CONFIG.company,
          'X-Token': token
        },
        timeout: 15000
      }
    );

    // Response shapes vary: look for resp.data.result, resp.data.events or resp.data
    const rawResult = resp.data?.result ?? resp.data?.events ?? resp.data;
    const rawArray = Array.isArray(rawResult) ? rawResult : (rawResult?.events ?? rawResult?.items ?? []);

    if (!Array.isArray(rawArray)) {
      console.warn('getEventList returned non-array shape, returning empty array. Raw:', rawResult);
    }

    const items = Array.isArray(rawArray) ? rawArray : [];

    const services = items.map(item => {
      const id = item.id ?? item.event_id ?? item.service_id ?? item.eventId ?? null;
      const name = item.name ?? item.title ?? item.event_name ?? item.service_name ?? '';
      const description = item.description ?? item.long_description ?? item.details ?? item.info ?? '';
      let price = '';
      if (item.price) price = String(item.price);
      else if (item.cost) price = String(item.cost);
      else if (item.default_price) price = String(item.default_price);
      else if (item.price_value) price = String(item.price_value);
      const duration = item.duration ?? item.length ?? item.length_min ?? item.duration_minutes ?? item.duration_min ?? '';
      const category_name = (item.category && item.category.name) ? item.category.name
        : item.category_name ?? item.group_name ?? item.unit_group_name ?? item.service_category ?? 'General';

      let image_url = null;
      if (item.image) {
        if (typeof item.image === 'string') image_url = item.image;
        else if (item.image.url) image_url = item.image.url;
      }
      image_url = image_url || item.picture_url || item.image_url || item.photo_url || item.thumbnail || null;

      return {
        id,
        name,
        description,
        price,
        duration,
        category_name,
        image_url,
        raw: item
      };
    });

    // stable sort by category + name
    services.sort((a, b) => {
      const ca = String(a.category_name || '');
      const cb = String(b.category_name || '');
      const na = String(a.name || '');
      const nb = String(b.name || '');
      return ca.localeCompare(cb) || na.localeCompare(nb);
    });

    servicesCache.data = services;
    servicesCache.fetchedAt = Date.now();
    return services;
  } catch (err) {
    console.error('fetchServicesCached (getEventList) error:', err.response?.data || err.message);
    throw new Error('Failed to fetch services from SimplyBook (getEventList).');
  }
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
 * Query params:
 *   force=true -> force cache refresh (protected in production)
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
    console.error('/api/services error:', err.message);
    return res.status(500).json({ ok: false, error: err.message || 'Failed to fetch services' });
  }
});

/**
 * Admin-only: purge caches (token + services)
 * POST /api/purge-cache with header x-cache-admin-secret
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
    if (isNaN(dateObj)) {
      return res.status(400).json({ success: false, error: 'Invalid date' });
    }
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

// Create Booking (SimplyBook admin API) - may require admin privileges; will attempt admin endpoints
app.post('/api/create-booking', async (req, res) => {
  try {
    const { serviceId, datetime, clientData } = req.body;

    if (!serviceId || !datetime || !clientData) {
      return res.status(400).json({ success: false, error: 'Missing required booking data' });
    }

    const token = await getSimplyBookTokenCached();
    const adminBase = `${SIMPLYBOOK_CONFIG.apiUrl}/admin`;

    // Step 1: Find or create client
    let clientId;
    try {
      const existingClientResp = await axios.get(
        `${adminBase}/clients`,
        {
          headers: { 'X-Company-Login': SIMPLYBOOK_CONFIG.company, 'X-Token': token },
          params: { email: clientData.email },
          timeout: 15000
        }
      );

      const clientsRaw = Array.isArray(existingClientResp.data) ? existingClientResp.data : (existingClientResp.data.result || existingClientResp.data.clients || []);
      if (Array.isArray(clientsRaw) && clientsRaw.length > 0) {
        clientId = clientsRaw[0].id;
      }
    } catch (e) {
      console.warn('Client lookup failed (may be due to missing admin rights):', e.response?.data || e.message);
    }

    if (!clientId) {
      const clientResp = await axios.post(
        `${adminBase}/clients`,
        {
          name: clientData.full_name,
          email: clientData.email,
          phone: clientData.phone
        },
        {
          headers: { 'X-Company-Login': SIMPLYBOOK_CONFIG.company, 'X-Token': token, 'Content-Type': 'application/json' },
          timeout: 15000
        }
      );

      const clientDataResp = clientResp.data && clientResp.data.id ? clientResp.data : (clientResp.data.result || clientResp.data.client || clientResp.data);
      clientId = clientDataResp.id;
    }

    // Step 2: Create booking
    const bookingResp = await axios.post(
      `${adminBase}/bookings`,
      {
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
      },
      {
        headers: { 'X-Company-Login': SIMPLYBOOK_CONFIG.company, 'X-Token': token, 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );

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

    if (!amount || !description || !redirectUrl) {
      return res.status(400).json({ success: false, error: 'amount, description and redirectUrl are required' });
    }

    if (!process.env.MOLLIE_API_KEY) {
      return res.status(500).json({ success: false, error: 'Mollie API key not configured' });
    }

    const payment = await mollieClient.payments.create({
      amount: { value: Number(amount).toFixed(2), currency: 'EUR' },
      description,
      redirectUrl,
      metadata: metadata || {}
    });

    return res.json({ success: true, checkoutUrl: payment._links.checkout.href, paymentId: payment.id });
  } catch (err) {
    console.error('Mollie create-payment error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create Mollie payment' });
  }
});

// Export for Vercel / serverless and local dev
module.exports = app;

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
  });
}
