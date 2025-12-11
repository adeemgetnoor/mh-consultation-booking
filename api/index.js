// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createMollieClient } = require('@mollie/api-client');

const app = express();

/**
 * Env:
 * SIMPLYBOOK_COMPANY_LOGIN
 * SIMPLYBOOK_API_KEY
 * SIMPLYBOOK_API_SECRET (optional - try if access denied with regular key)
 * MOLLIE_API_KEY
 * CACHE_ADMIN_SECRET (optional)
 */
const SIMPLYBOOK_CONFIG = {
  company: process.env.SIMPLYBOOK_COMPANY_LOGIN,
  apiKey: process.env.SIMPLYBOOK_API_KEY,
  apiSecret: process.env.SIMPLYBOOK_API_SECRET || null,
  apiUrl: 'https://user-api.simplybook.me'
};

const mollieClient = createMollieClient({
  apiKey: process.env.MOLLIE_API_KEY || ''
});

if (!SIMPLYBOOK_CONFIG.company) console.warn('SIMPLYBOOK_COMPANY_LOGIN not set');
if (!SIMPLYBOOK_CONFIG.apiKey) console.warn('SIMPLYBOOK_API_KEY not set');

app.use(express.json());

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
    return callback(null, true); // relaxed for dev; change to callback(new Error(...)) to enforce
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Company-Login', 'X-Token']
}));
app.options('*', cors());

// simple in-memory caches
let tokenCache = {
  token: null,
  fetchedAt: 0,
  ttlMs: 1000 * 60 * 50
};

let servicesCache = {
  data: null,
  fetchedAt: 0,
  ttlMs: 1000 * 60 * 5
};

// small helper to call the JSON-RPC endpoints (admin or public)
async function callRpc(url, payload, headers = {}) {
  try {
    const resp = await axios.post(url, payload, {
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      timeout: 15000
    });
    return resp.data;
  } catch (err) {
    // wrap error with response body if present
    const info = err.response?.data || err.message;
    throw new Error(typeof info === 'string' ? info : JSON.stringify(info));
  }
}

// getToken using a provided apiKey (normal or secret)
async function getTokenForKey(apiKey) {
  const payload = {
    jsonrpc: '2.0',
    method: 'getToken',
    params: [SIMPLYBOOK_CONFIG.company, apiKey],
    id: 1
  };

  const resp = await callRpc(`${SIMPLYBOOK_CONFIG.apiUrl}/login`, payload);
  // resp expected { result: 'TOKEN', id: '1', jsonrpc: '2.0' } on success
  if (!resp || !resp.result) {
    throw new Error('No token in getToken response: ' + JSON.stringify(resp));
  }
  return resp.result;
}

// cached token getter - tries normal key then secret if provided & forced
async function getSimplyBookTokenCached({ useSecret = false } = {}) {
  const now = Date.now();
  if (tokenCache.token && (now - tokenCache.fetchedAt) < tokenCache.ttlMs && !useSecret) {
    return tokenCache.token;
  }

  // try main key first or explicitly secret
  const keyToUse = useSecret && SIMPLYBOOK_CONFIG.apiSecret ? SIMPLYBOOK_CONFIG.apiSecret : SIMPLYBOOK_CONFIG.apiKey;
  if (!keyToUse) throw new Error('No API key available for getToken');

  try {
    const token = await getTokenForKey(keyToUse);
    tokenCache.token = token;
    tokenCache.fetchedAt = Date.now();
    return token;
  } catch (err) {
    throw new Error('getToken failed: ' + err.message);
  }
}

// Normalize an event (SimplyBook shape) -> service object used by frontend
function normalizeEventToService(e) {
  const startDate = e.start_date || e.start || e.date || null;
  const price = e.price || e.cost || (e.prices && e.prices[0] && e.prices[0].value) || '';
  const category = e.group_name || e.category_name || (e.category && e.category.name) || 'General';

  return {
    id: e.id || e.event_id || e.id_event || null,
    name: e.name || e.title || e.service_name || e.summary || '',
    description: e.description || e.long_description || e.details || '',
    price: price ? String(price) : '',
    duration: e.duration || e.length || e.duration_minutes || '',
    category_name: category,
    category_id: (e.category && e.category.id) ? e.category.id : (e.category_id || null),
    image_url: e.image_url || e.picture_url || e.photo_url || null,
    status: e.status || (e.active ? 'online' : 'offline') || 'online',
    raw: e
  };
}

// Try admin getEventList (with wide date range) -> returns array of events or throws
async function adminGetEventList(token, startDate, endDate) {
  const payload = {
    jsonrpc: '2.0',
    method: 'getEventList',
    params: [startDate, endDate],
    id: 1
  };

  const headers = {
    'X-Company-Login': SIMPLYBOOK_CONFIG.company,
    'X-Token': token
  };

  const resp = await callRpc(`${SIMPLYBOOK_CONFIG.apiUrl}/admin`, payload, headers);
  return resp;
}

// Try public getEventListPublic or public getEventList
async function publicGetEventList() {
  // first try public getEventListPublic
  try {
    const payloadPublic = {
      jsonrpc: '2.0',
      method: 'getEventListPublic',
      params: [],
      id: 1
    };
    const resp = await callRpc(`${SIMPLYBOOK_CONFIG.apiUrl}`, payloadPublic);
    return resp;
  } catch (err) {
    // fallback to public getEventList
    const payload = {
      jsonrpc: '2.0',
      method: 'getEventList',
      params: [],
      id: 1
    };
    const resp2 = await callRpc(`${SIMPLYBOOK_CONFIG.apiUrl}`, payload);
    return resp2;
  }
}

/**
 * fetchServicesCached:
 * - attempts admin getEventList with token (today -> +365)
 * - if Access denied, optionally tries secret key, then falls back to public RPCs
 * - normalizes events into services array
 */
async function fetchServicesCached(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && servicesCache.data && (now - servicesCache.fetchedAt) < servicesCache.ttlMs) {
    return servicesCache.data;
  }

  // date range: today -> +365 days
  const today = new Date();
  const start = today.toISOString().split('T')[0];
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + 365);
  const end = endDate.toISOString().split('T')[0];

  // attempt admin with main key token
  try {
    const token = await getSimplyBookTokenCached({ useSecret: false });
    console.log('Trying admin getEventList with token (main key). Range:', start, end);
    const adminResp = await adminGetEventList(token, start, end);
    console.log('admin getEventList raw (main):', typeof adminResp === 'object' ? JSON.stringify(adminResp).slice(0, 3000) : String(adminResp));

    // check for error
    if (adminResp && adminResp.error) {
      const errMsg = adminResp.error.message || JSON.stringify(adminResp.error);
      // if "Access denied", we'll attempt secret key (if available) then public fallback
      if (errMsg.toLowerCase().includes('access denied') || errMsg.toLowerCase().includes('access')) {
        console.warn('admin getEventList returned error (main key):', errMsg);
        // try secret (if provided)
        if (SIMPLYBOOK_CONFIG.apiSecret) {
          try {
            const secretToken = await getSimplyBookTokenCached({ useSecret: true });
            console.log('Trying admin getEventList with secret API key token. Range:', start, end);
            const adminResp2 = await adminGetEventList(secretToken, start, end);
            console.log('admin getEventList raw (secret):', typeof adminResp2 === 'object' ? JSON.stringify(adminResp2).slice(0, 3000) : String(adminResp2));
            if (adminResp2 && adminResp2.result && Array.isArray(adminResp2.result) && adminResp2.result.length > 0) {
              const services = adminResp2.result.map(normalizeEventToService);
              servicesCache.data = services;
              servicesCache.fetchedAt = Date.now();
              return services;
            } else {
              console.warn('admin getEventList with secret returned no events or empty result.');
            }
          } catch (err) {
            console.warn('admin getEventList with secret failed:', err.message || err);
          }
        }

        // fallback to public RPCs below
      } else {
        // other error - propagate as fallback to public
        console.warn('admin getEventList returned non-access error (main):', errMsg);
      }
    } else {
      // success path: adminResp.result may contain events array
      const events = Array.isArray(adminResp) ? adminResp : (adminResp.result || adminResp.events || []);
      if (Array.isArray(events) && events.length > 0) {
        const services = events.map(normalizeEventToService);
        services.sort((a, b) => (a.category_name || '').localeCompare(b.category_name || '') || (a.name || '').localeCompare(b.name || ''));
        servicesCache.data = services;
        servicesCache.fetchedAt = Date.now();
        return services;
      } else {
        console.warn('admin getEventList returned zero events (main key) — trying other fallbacks.');
      }
    }
  } catch (err) {
    console.warn('admin getEventList attempt failed (main):', err.message || err);
    // continue to try secret/public below
  }

  // If we reach here, try public endpoints
  try {
    console.log('Attempting public getEventListPublic / public getEventList fallback...');
    const publicResp = await publicGetEventList();
    console.log('public getEventList raw:', typeof publicResp === 'object' ? JSON.stringify(publicResp).slice(0, 3000) : String(publicResp));

    const events = Array.isArray(publicResp) ? publicResp : (publicResp.result || publicResp.events || []);
    if (Array.isArray(events) && events.length > 0) {
      const services = events.map(normalizeEventToService);
      services.sort((a, b) => (a.category_name || '').localeCompare(b.category_name || '') || (a.name || '').localeCompare(b.name || ''));
      servicesCache.data = services;
      servicesCache.fetchedAt = Date.now();
      return services;
    } else {
      throw new Error('no events returned by getEventList/getEventListPublic');
    }
  } catch (err) {
    console.error('fetchServicesCached error:', err.message || err);
    throw new Error('Failed to fetch services from SimplyBook (no events returned by getEventList/getEventListPublic).');
  }
}

// small helper wrappers for routes below
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

// Purge cache
app.post('/api/purge-cache', (req, res) => {
  const secret = req.headers['x-cache-admin-secret'] || req.body?.admin_secret;
  if (!process.env.CACHE_ADMIN_SECRET || secret !== process.env.CACHE_ADMIN_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  tokenCache = { token: null, fetchedAt: 0, ttlMs: tokenCache.ttlMs };
  servicesCache = { data: null, fetchedAt: 0, ttlMs: servicesCache.ttlMs };
  return res.json({ ok: true, message: 'Caches purged' });
});

// get start time matrix (unchanged)
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

// create booking (unchanged)
app.post('/api/create-booking', async (req, res) => {
  try {
    const { serviceId, datetime, clientData } = req.body;
    if (!serviceId || !datetime || !clientData) {
      return res.status(400).json({ success: false, error: 'Missing required booking data' });
    }
    const token = await getSimplyBookTokenCached();
    const adminBase = `${SIMPLYBOOK_CONFIG.apiUrl}/admin`;

    // find/create client
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

// create mollie payment (unchanged)
app.post('/api/create-payment', async (req, res) => {
  try {
    const { amount, description, redirectUrl, metadata } = req.body;
    if (!amount || !description || !redirectUrl) {
      return res.status(400).json({ success: false, error: 'amount, description and redirectUrl are required' });
    }
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

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
}
