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
  apiUrl: 'https://user-api.simplybook.me' // base url used by login and admin endpoints
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

// Services cache
let servicesCache = {
  data: null,
  fetchedAt: 0,
  ttlMs: 1000 * 60 * 5 // 5 minutes
};

/**
 * Helper: getCachedSimplyBookToken
 * - caches token for tokenCache.ttlMs
 */
async function getSimplyBookTokenCached() {
  const now = Date.now();
  if (tokenCache.token && (now - tokenCache.fetchedAt) < tokenCache.ttlMs) {
    return tokenCache.token;
  }

  // fetch new token
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
 * Try multiple ways to fetch "services/events" from SimplyBook:
 * 1) JSON-RPC getEventList (may be denied for some accounts)
 * 2) Admin REST GET /admin/services (requires token + company header)
 * 3) Public REST v2 GET /services on user-api-v2 (best-effort)
 *
 * Returns normalized array of service objects or throws with detailed info.
 */
async function fetchServicesCached(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && servicesCache.data && (now - servicesCache.fetchedAt) < servicesCache.ttlMs) {
    return servicesCache.data;
  }

  // collect failures for debugging
  const failures = [];

  // First: get token
  let token;
  try {
    token = await getSimplyBookTokenCached();
  } catch (err) {
    // token fetch failed, can't proceed
    throw new Error(`Failed to fetch SimplyBook token: ${err.message}`);
  }

  // Helper to normalize list shapes to our standard
  function normalizeList(rawList) {
    if (!Array.isArray(rawList)) return [];
    return rawList.map(s => {
      const catName = (s.category && s.category.name) ? s.category.name
        : (s.category_name || s.service_category || s.group_name || s.category || 'General');

      let imageUrl = null;
      if (s.image) {
        if (typeof s.image === 'string') imageUrl = s.image;
        else if (s.image.url) imageUrl = s.image.url;
      }
      imageUrl = imageUrl || s.picture_url || s.image_url || s.photo_url || null;

      let priceVal = '';
      if (s.price) priceVal = String(s.price);
      else if (s.default_price) priceVal = String(s.default_price);
      else if (s.cost) priceVal = String(s.cost || '');
      else if (s.pricing && s.pricing.price) priceVal = String(s.pricing.price);

      return {
        id: s.id || s.service_id || s.event_id || s.id_service || null,
        name: s.name || s.title || s.service_name || s.event_name || '',
        description: s.description || s.long_description || s.details || s.info || '',
        price: priceVal || '',
        duration: s.duration || s.length || s.length_in_minutes || s.duration_minutes || '',
        category_name: catName,
        category_id: (s.category && s.category.id) ? s.category.id : (s.category_id || null),
        image_url: imageUrl,
        status: s.status || (s.active ? 'online' : 'offline') || 'online',
        raw: s
      };
    });
  }

  // ---------- Attempt 1: JSON-RPC getEventList ----------
  try {
    const rpcPayload = {
      jsonrpc: '2.0',
      method: 'getEventList',
      params: [], // no filters - account may accept else adjust
      id: 1
    };
    const rpcResp = await axios.post(SIMPLYBOOK_CONFIG.apiUrl, rpcPayload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Company-Login': SIMPLYBOOK_CONFIG.company,
        'X-Token': token
      },
      timeout: 15000
    });

    if (rpcResp.data && rpcResp.data.result) {
      const raw = Array.isArray(rpcResp.data.result) ? rpcResp.data.result : (rpcResp.data.result.events || rpcResp.data.result || []);
      const normalized = normalizeList(raw);
      servicesCache.data = normalized;
      servicesCache.fetchedAt = Date.now();
      console.info('fetchServicesCached: fetched via getEventList (RPC)');
      return normalized;
    }

    // If error returned by RPC, capture and move to fallback
    if (rpcResp.data && rpcResp.data.error) {
      failures.push({ method: 'getEventList', payload: rpcResp.data.error });
      console.warn('getEventList returned error:', rpcResp.data.error);
    } else {
      failures.push({ method: 'getEventList', payload: rpcResp.data });
      console.warn('getEventList unexpected response:', rpcResp.data);
    }
  } catch (err) {
    failures.push({ method: 'getEventList', payload: err.response?.data || err.message || String(err) });
    console.warn('getEventList attempt failed:', err.response?.data || err.message);
  }

  // ---------- Attempt 2: Admin GET /admin/services ----------
  try {
    const adminBase = `${SIMPLYBOOK_CONFIG.apiUrl}/admin`;
    const resp = await axios.get(`${adminBase}/services`, {
      headers: {
        'Content-Type': 'application/json',
        'X-Company-Login': SIMPLYBOOK_CONFIG.company,
        'X-Token': token
      },
      timeout: 15000
    });

    const raw = Array.isArray(resp.data) ? resp.data : (resp.data.result || resp.data.services || resp.data);
    if (raw && Array.isArray(raw)) {
      const normalized = normalizeList(raw);
      servicesCache.data = normalized;
      servicesCache.fetchedAt = Date.now();
      console.info('fetchServicesCached: fetched via admin /services');
      return normalized;
    } else {
      // not array: fallback
      failures.push({ method: 'admin/services', payload: resp.data });
      console.warn('admin/services returned unexpected shape:', resp.data);
    }
  } catch (err) {
    failures.push({ method: 'admin/services', payload: err.response?.data || err.message || String(err) });
    console.warn('admin/services attempt failed:', err.response?.data || err.message);
  }

  // ---------- Attempt 3: Public REST (user-api-v2) ----------
  try {
    // Public v2 endpoint (best-effort). Some accounts expose /services publicly.
    const v2Url = 'https://user-api-v2.simplybook.me/services';
    // query by company login (some v2 endpoints use company_login param)
    const resp = await axios.get(v2Url, {
      params: { company_login: SIMPLYBOOK_CONFIG.company },
      timeout: 15000
    });

    const raw = Array.isArray(resp.data) ? resp.data : (resp.data.services || resp.data.result || resp.data);
    if (raw && Array.isArray(raw)) {
      const normalized = normalizeList(raw);
      servicesCache.data = normalized;
      servicesCache.fetchedAt = Date.now();
      console.info('fetchServicesCached: fetched via user-api-v2 /services');
      return normalized;
    } else {
      failures.push({ method: 'user-api-v2/services', payload: resp.data });
      console.warn('user-api-v2/services unexpected shape:', resp.data);
    }
  } catch (err) {
    failures.push({ method: 'user-api-v2/services', payload: err.response?.data || err.message || String(err) });
    console.warn('user-api-v2/services attempt failed:', err.response?.data || err.message);
  }

  // All attempts failed — throw with collected failure info
  const err = new Error('All attempts to fetch services from SimplyBook failed. See details in "failures" property.');
  err.failures = failures;
  console.error('fetchServicesCached failures:', JSON.stringify(failures, null, 2));
  throw err;
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
 * Returns normalized list of services from SimplyBook (cached)
 * Query params:
 *   force=true -> force refresh (requires valid admin secret header or allow during dev)
 */
app.get('/api/services', async (req, res) => {
  try {
    const force = req.query.force === 'true';

    // Allow forced refresh only if admin secret matches (or if in dev)
    if (force && process.env.NODE_ENV === 'production') {
      const secret = req.headers['x-cache-admin-secret'] || req.query.admin_secret;
      if (!process.env.CACHE_ADMIN_SECRET || secret !== process.env.CACHE_ADMIN_SECRET) {
        return res.status(401).json({ ok: false, error: 'Unauthorized to force refresh cache' });
      }
    }

    const services = await fetchServicesCached(force);
    return res.json({ ok: true, fetched_at: new Date().toISOString(), count: services.length, data: services });
  } catch (err) {
    console.error('/api/services error (detailed):', err.message || err);
    // if we captured failure details, include them (safe for debugging)
    const details = err.failures || err.message || err.toString();
    return res.status(500).json({ ok: false, error: 'Failed to fetch services from SimplyBook', details });
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
      return res.status(400).json({
        success: false,
        error: 'Service ID and date are required'
      });
    }

    const token = await getSimplyBookTokenCached();

    const dateObj = new Date(date);
    if (isNaN(dateObj)) {
      return res.status(400).json({ success: false, error: 'Invalid date' });
    }
    const formattedDate = dateObj.toISOString().split('T')[0]; // YYYY-MM-DD

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

    const slots = times.map(t => ({
      time: t,
      available: true,
      id: `${formattedDate} ${t}`
    }));

    return res.json({ success: true, slots });
  } catch (error) {
    console.error('get-slots error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error.response?.data?.message || 'Failed to fetch time slots'
    });
  }
});

// Create Booking (SimplyBook admin API) - unchanged
app.post('/api/create-booking', async (req, res) => {
  try {
    const { serviceId, datetime, clientData } = req.body;

    if (!serviceId || !datetime || !clientData) {
      return res.status(400).json({
        success: false,
        error: 'Missing required booking data'
      });
    }

    const token = await getSimplyBookTokenCached();
    const adminBase = `${SIMPLYBOOK_CONFIG.apiUrl}/admin`;

    // Step 1: Find or create client
    let clientId;

    try {
      const existingClientResp = await axios.get(
        `${adminBase}/clients`,
        {
          headers: {
            'X-Company-Login': SIMPLYBOOK_CONFIG.company,
            'X-Token': token
          },
          params: { email: clientData.email },
          timeout: 15000
        }
      );

      const clientsRaw = Array.isArray(existingClientResp.data) ? existingClientResp.data : (existingClientResp.data.result || existingClientResp.data.clients || []);
      if (Array.isArray(clientsRaw) && clientsRaw.length > 0) {
        clientId = clientsRaw[0].id;
      }
    } catch (e) {
      console.warn('Client lookup failed, will create new:', e.response?.data || e.message);
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
          headers: {
            'X-Company-Login': SIMPLYBOOK_CONFIG.company,
            'X-Token': token,
            'Content-Type': 'application/json'
          },
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
        headers: {
          'X-Company-Login': SIMPLYBOOK_CONFIG.company,
          'X-Token': token,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    return res.json({
      success: true,
      booking: bookingResp.data,
      message: 'Booking created successfully'
    });
  } catch (error) {
    console.error('create-booking error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error.response?.data?.message || 'Failed to create booking'
    });
  }
});

// Create Mollie payment (TEST or LIVE key depending on env) - unchanged
app.post('/api/create-payment', async (req, res) => {
  try {
    const { amount, description, redirectUrl, metadata } = req.body;

    if (!amount || !description || !redirectUrl) {
      return res.status(400).json({
        success: false,
        error: 'amount, description and redirectUrl are required'
      });
    }

    if (!process.env.MOLLIE_API_KEY) {
      return res.status(500).json({ success: false, error: 'Mollie API key not configured' });
    }

    const payment = await mollieClient.payments.create({
      amount: {
        value: Number(amount).toFixed(2),
        currency: 'EUR'
      },
      description,
      redirectUrl,
      metadata: metadata || {}
    });

    return res.json({
      success: true,
      checkoutUrl: payment._links.checkout.href,
      paymentId: payment.id
    });
  } catch (err) {
    console.error('Mollie create-payment error:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to create Mollie payment'
    });
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
