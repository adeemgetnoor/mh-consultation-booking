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
      { headers: { 'Content-Type': 'application/json' } }
    );

    if (!response.data || !response.data.result) {
      throw new Error('No token in SimplyBook response');
    }

    tokenCache.token = response.data.result;
    tokenCache.fetchedAt = Date.now();

    // Optionally set TTL based on response if available. Keep default otherwise.
    // e.g. if response.data.expires_in then tokenCache.ttlMs = (response.data.expires_in - 60) * 1000

    return tokenCache.token;
  } catch (err) {
    console.error('SimplyBook auth error:', err.response?.data || err.message);
    throw new Error('Failed to obtain SimplyBook token');
  }
}

/**
 * Helper: fetch services from SimplyBook admin and normalize
 * - caches for servicesCache.ttlMs
 */
async function fetchServicesCached(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && servicesCache.data && (now - servicesCache.fetchedAt) < servicesCache.ttlMs) {
    return servicesCache.data;
  }

  const token = await getSimplyBookTokenCached();
  const adminBase = `${SIMPLYBOOK_CONFIG.apiUrl}/admin`;

  try {
    const resp = await axios.get(`${adminBase}/services`, {
      headers: {
        'X-Company-Login': SIMPLYBOOK_CONFIG.company,
        'X-Token': token,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    // Normalize: the exact structure might vary; support multiple shapes
    const raw = Array.isArray(resp.data) ? resp.data : (resp.data.result || resp.data.services || []);
    const services = (raw || []).map(s => {
      // attempt to read nested category info
      const catName = (s.category && s.category.name) ? s.category.name
        : (s.category_name || s.service_category || s.group_name || 'General');

      // attempt to get image URL - different accounts return different keys
      let imageUrl = null;
      if (s.image) {
        if (typeof s.image === 'string') imageUrl = s.image;
        else if (s.image.url) imageUrl = s.image.url;
      }
      imageUrl = imageUrl || s.picture_url || s.image_url || s.photo_url || null;

      // price may be nested or in price object
      let priceVal = '';
      if (s.price) priceVal = String(s.price);
      else if (s.default_price) priceVal = String(s.default_price);
      else if (s.cost) priceVal = String(s.cost || '');
      else if (s.pricing && s.pricing.price) priceVal = String(s.pricing.price);

      return {
        id: s.id || s.service_id || s.id_service || null,
        name: s.name || s.title || s.service_name || '',
        description: s.description || s.long_description || s.details || '',
        price: priceVal || '',
        duration: s.duration || s.length || s.length_in_minutes || s.duration_minutes || '',
        category_name: catName,
        category_id: (s.category && s.category.id) ? s.category.id : (s.category_id || null),
        image_url: imageUrl,
        status: s.status || (s.active ? 'online' : 'offline') || 'online',
        raw: s
      };
    });

    // sort for stable display
    services.sort((a, b) => {
      const ca = (a.category_name || '').toString();
      const cb = (b.category_name || '').toString();
      const na = (a.name || '').toString();
      const nb = (b.name || '').toString();
      return ca.localeCompare(cb) || na.localeCompare(nb);
    });

    servicesCache.data = services;
    servicesCache.fetchedAt = Date.now();
    return services;
  } catch (err) {
    console.error('fetchServicesCached error:', err.response?.data || err.message);
    throw new Error('Failed to fetch services from SimplyBook');
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

// Get Available Time Slots using getStartTimeMatrix
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

// Create Booking (SimplyBook admin API)
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

      // response shape may be an array or wrapped
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

      // client response may be direct object or wrapped
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

// Create Mollie payment (TEST or LIVE key depending on env)
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
