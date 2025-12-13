// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createMollieClient } = require('@mollie/api-client');
const simplyBookRouter = require('./simplybook-rpc.router');

const app = express();

/**
 * Environment expectations:
 * - SIMPLYBOOK_COMPANY_LOGIN  (your company login)
 * - SIMPLYBOOK_API_KEY       (your API key shown in SimplyBook; used for getToken)
 * - MOLLIE_API_KEY           (optional, for payments)
 * - CACHE_ADMIN_SECRET       (optional, for forced refresh endpoint)
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

function normalizeServicesAdmin(items = []) {
  return items.map(s => {
    const id = s.id || s.service_id || null;
    const name = s.name || s.title || '';
    const price = (s.price || s.default_price || s.cost || '') + '';
    const duration = s.duration || s.length || '';
    const cat = (s.category && (s.category.name || s.category.title)) || s.category_name || s.group_name || 'General';
    let image_url = s.image || s.image_url || s.picture_url || null;
    if (image_url && typeof image_url === 'object') image_url = image_url.url || null;
    const status = (typeof s.active === 'boolean') ? (s.active ? 'online' : 'offline') : (s.status || 'online');
    return {
      id,
      name,
      description: s.description || '',
      price,
      duration,
      category_name: cat,
      category_id: s.category_id || (s.category && s.category.id) || null,
      image_url,
      status,
      raw: s
    };
  });
}

app.use(express.json());
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // allow server-side requests
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
    console.log('CORS: allowing unknown origin for now (relaxed):', origin);
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));
app.options('*', cors());
app.use('/api/sb', simplyBookRouter);

// Simple in-memory caches
let tokenCache = { token: null, fetchedAt: 0, ttlMs: 1000 * 60 * 50 };
let servicesCache = { data: null, fetchedAt: 0, ttlMs: 1000 * 60 * 5 };

/** getSimplyBookTokenCached
 * Uses JSON-RPC getToken on https://user-api.simplybook.me/login
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
    const resp = await axios.post(`${SIMPLYBOOK_CONFIG.apiUrl}/login`, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });
    if (!resp.data || !resp.data.result) throw new Error('No token in login response');
    tokenCache.token = resp.data.result;
    tokenCache.fetchedAt = Date.now();
    console.log('Obtained new SimplyBook token (cached).');
    return tokenCache.token;
  } catch (err) {
    console.error('getSimplyBookTokenCached error:', err.response?.data || err.message);
    throw new Error('Failed to obtain SimplyBook token');
  }
}

/**
 * Helper: callAdminRpc
 * Calls the admin RPC endpoint (POST to /admin) with X-Company-Login and X-Token
 */
async function callAdminRpc(token, method, params = [], timeout = 15000) {
  const payload = {
    jsonrpc: '2.0',
    method,
    params,
    id: 1
  };

  const resp = await axios.post(`${SIMPLYBOOK_CONFIG.apiUrl}/admin`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'X-Company-Login': SIMPLYBOOK_CONFIG.company,
      'X-Token': token
    },
    timeout
  });

  return resp.data;
}

/**
 * Helper: callPublicRpc
 * Calls the public RPC endpoint (POST to base apiUrl) — no headers required for public calls
 */
async function callPublicRpc(method, params = [], timeout = 15000) {
  const payload = { jsonrpc: '2.0', method, params, id: 1 };
  const headers = { 'Content-Type': 'application/json' };
  // Some public RPC methods require specifying company via header
  if (SIMPLYBOOK_CONFIG.company) headers['X-Company-Login'] = SIMPLYBOOK_CONFIG.company;
  const resp = await axios.post(`${SIMPLYBOOK_CONFIG.apiUrl}`, payload, {
    headers,
    timeout
  });
  return resp.data;
}

/**
 * fetchServicesCached
 * Primary strategy:
 *  1) Try admin RPC getEventList (requires token). If returns events, normalize & cache.
 *  2) If admin call fails with access denied OR returns no events:
 *     - try public getEventListPublic
 *     - if still nothing, try getServiceListPublic
 */
async function fetchServicesCached(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && servicesCache.data && (now - servicesCache.fetchedAt) < servicesCache.ttlMs) {
    return servicesCache.data;
  }

  // Try admin getEventList first
  try {
    const token = await getSimplyBookTokenCached();
    // request for a reasonable date window (today -> +1 year)
    const from = new Date().toISOString().split('T')[0];
    const to = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().split('T')[0];

    console.log('Attempting admin getEventList', { from, to });
    const adminResp = await callAdminRpc(token, 'getEventList', [from, to]);
    if (adminResp && adminResp.result && Array.isArray(adminResp.result) && adminResp.result.length > 0) {
      console.log('admin getEventList returned', adminResp.result.length, 'events');
      const services = normalizeEventsToServices(adminResp.result);
      servicesCache.data = services;
      servicesCache.fetchedAt = Date.now();
      return services;
    }

    // If adminResp has error (access denied), throw to fall back
    if (adminResp && adminResp.error) {
      const code = adminResp.error.code;
      console.warn('admin getEventList returned error', adminResp.error);
      if (code === -32600 || String(adminResp.error.message).toLowerCase().includes('access')) {
        throw new Error('admin_access_denied');
      }
    }

    console.log('admin getEventList returned no events -> will try public methods');
  } catch (err) {
    console.warn('admin getEventList failed:', err.message || err);
    // continue to public fallbacks
  }

  // Fallback: getEventListPublic (public RPC)
  try {
    console.log('Trying public getEventListPublic');
    // Provide a date window like the admin call (today -> +1 year)
    const from = new Date().toISOString().split('T')[0];
    const to = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().split('T')[0];
    const publicResp = await callPublicRpc('getEventListPublic', [from, to]);
    if (publicResp && publicResp.result && Array.isArray(publicResp.result) && publicResp.result.length > 0) {
      console.log('getEventListPublic returned', publicResp.result.length, 'events');
      const services = normalizeEventsToServices(publicResp.result);
      servicesCache.data = services;
      servicesCache.fetchedAt = Date.now();
      return services;
    }
    console.log('getEventListPublic returned no events or empty array');
  } catch (err) {
    console.warn('getEventListPublic failed:', err.response?.data || err.message);
  }

  // Last fallback: getServiceListPublic (some accounts expose services via this)
  try {
    console.log('Trying public getServiceListPublic');
    const svcResp = await callPublicRpc('getServiceListPublic', []);
    if (svcResp && svcResp.result && Array.isArray(svcResp.result) && svcResp.result.length > 0) {
      console.log('getServiceListPublic returned', svcResp.result.length, 'items');
      const services = normalizeServicesListPublic(svcResp.result);
      servicesCache.data = services;
      servicesCache.fetchedAt = Date.now();
      return services;
    }
    console.log('getServiceListPublic returned no items');
  } catch (err) {
    console.warn('getServiceListPublic failed:', err.response?.data || err.message);
  }

  // Additional fallback: Admin REST /admin/services (requires token)
  try {
    console.log('Trying admin REST /admin/services');
    const token = await getSimplyBookTokenCached();
    const adminBase = `${SIMPLYBOOK_CONFIG.apiUrl}/admin`;
    const resp = await axios.get(`${adminBase}/services`, {
      headers: {
        'X-Company-Login': SIMPLYBOOK_CONFIG.company,
        'X-Token': token
      },
      timeout: 15000
    });
    const itemsRaw = Array.isArray(resp.data) ? resp.data : (resp.data.result || resp.data.services || []);
    if (Array.isArray(itemsRaw) && itemsRaw.length > 0) {
      console.log('/admin/services returned', itemsRaw.length, 'items');
      const services = normalizeServicesAdmin(itemsRaw);
      servicesCache.data = services;
      servicesCache.fetchedAt = Date.now();
      return services;
    }
    console.log('/admin/services returned no items');
  } catch (err) {
    console.warn('Admin REST /admin/services failed:', err.response?.data || err.message);
  }

  // Nothing found
  throw new Error('Failed to fetch services from SimplyBook (no events returned by getEventList/getEventListPublic/getServiceListPublic).');
}

/**
 * Normalizers
 * convert different RPC shapes into a uniform service object:
 * { id, name, description, price, duration, category_name, image_url, status, raw }
 */
function normalizeEventsToServices(events = []) {
  return events.map(e => {
    // event shape varies across accounts; pick best-guess fields
    const name = e.name || e.title || e.service_name || e.event_name || '';
    const id = e.id || e.event_id || e.service_id || null;
    const duration = e.duration || e.length || e.duration_minutes || e.event_duration || '';
    const price = (e.price || e.cost || (e.pricing && e.pricing.price) || '') + '';
    const cat = e.unit_group_name || e.category || e.category_name || e.group_name || (e.location || '') || 'General';
    let image_url = null;
    if (e.image) image_url = (typeof e.image === 'string') ? e.image : (e.image.url || null);
    image_url = image_url || e.image_url || e.picture_url || null;

    const description = e.description || e.long_description || e.details || e.text || '';
    const status = e.status || (e.active ? 'online' : 'offline') || 'online';

    return {
      id,
      name,
      description,
      price,
      duration,
      category_name: cat,
      category_id: e.category_id || e.unit_group_id || null,
      image_url,
      status,
      raw: e
    };
  });
}

function normalizeServicesListPublic(items = []) {
  return items.map(s => {
    const id = s.id || s.service_id || null;
    const name = s.name || s.title || '';
    const price = (s.price || s.cost || '') + '';
    const duration = s.duration || s.length || '';
    const cat = s.category_name || s.group_name || 'General';
    let image_url = s.image || s.image_url || s.picture_url || null;
    if (image_url && typeof image_url === 'object') image_url = image_url.url || null;
    return {
      id,
      name,
      description: s.description || '',
      price,
      duration,
      category_name: cat,
      category_id: s.category_id || null,
      image_url,
      status: s.status || 'online',
      raw: s
    };
  });
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
  res.json({ status: 'ok', message: 'Booking API running', timestamp: new Date().toISOString() });
});

/**
 * GET /api/services
 * Query: ?force=true to bypass cache (protected in prod by x-cache-admin-secret)
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
    return res.status(500).json({ ok: false, error: err.message || 'Failed to fetch services from SimplyBook' });
  }
});

/**
 * POST /api/get-slots, /api/create-booking, /api/create-payment
 * Keep your existing (unchanged) implementations — simplified for brevity here
 */

// Get Available Time Slots (same logic as earlier - uses getStartTimeMatrix RPC on admin)
app.post('/api/get-slots', async (req, res) => {
  try {
    const { serviceId, date } = req.body;
    if (!serviceId || !date) return res.status(400).json({ success: false, error: 'Service ID and date are required' });

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

    const response = await axios.post(SIMPLYBOOK_CONFIG.apiUrl, rpcPayload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Company-Login': SIMPLYBOOK_CONFIG.company,
        'X-Token': token
      },
      timeout: 15000
    });

    const matrix = response.data?.result || {};
    const times = matrix[formattedDate] || [];
    const slots = times.map(t => ({ time: t, available: true, id: `${formattedDate} ${t}` }));
    return res.json({ success: true, slots });
  } catch (error) {
    console.error('get-slots error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: error.response?.data?.message || 'Failed to fetch time slots' });
  }
});

// Create Booking (admin bookings)
app.post('/api/create-booking', async (req, res) => {
  try {
    const { serviceId, datetime, clientData } = req.body;
    if (!serviceId || !datetime || !clientData) return res.status(400).json({ success: false, error: 'Missing required booking data' });

    const token = await getSimplyBookTokenCached();
    const adminBase = `${SIMPLYBOOK_CONFIG.apiUrl}/admin`;

    // try to find existing client
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
        name: clientData.full_name,
        email: clientData.email,
        phone: clientData.phone
      }, {
        headers: { 'X-Company-Login': SIMPLYBOOK_CONFIG.company, 'X-Token': token, 'Content-Type': 'application/json' },
        timeout: 15000
      });
      const clientDataResp = clientResp.data && clientResp.data.id ? clientResp.data : (clientResp.data.result || clientResp.data.client || clientResp.data);
      clientId = clientDataResp.id;
    }

    // create booking
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

// Mollie payment (unchanged)
app.post('/api/create-payment', async (req, res) => {
  try {
    const { amount, description, redirectUrl, metadata } = req.body;
    if (!amount || !description || !redirectUrl) return res.status(400).json({ success: false, error: 'amount, description and redirectUrl are required' });
    if (!process.env.MOLLIE_API_KEY) return res.status(500).json({ success: false, error: 'Mollie API key not configured' });

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

// Admin-only: purge caches
app.post('/api/purge-cache', (req, res) => {
  const secret = req.headers['x-cache-admin-secret'] || req.body?.admin_secret;
  if (!process.env.CACHE_ADMIN_SECRET || secret !== process.env.CACHE_ADMIN_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  tokenCache = { token: null, fetchedAt: 0, ttlMs: tokenCache.ttlMs };
  servicesCache = { data: null, fetchedAt: 0, ttlMs: servicesCache.ttlMs };
  return res.json({ ok: true, message: 'Caches purged' });
});

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
}
