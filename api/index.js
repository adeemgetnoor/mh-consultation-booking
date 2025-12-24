// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { createMollieClient } = require('@mollie/api-client');
const simplyBookRouter = require('./simplybook-rpc.router');

const app = express();

/**
 * Env vars required:
 * SIMPLYBOOK_COMPANY_LOGIN
 * SIMPLYBOOK_API_KEY
 * (optional) SIMPLYBOOK_API_SECRET
 * (optional) MOLLIE_API_KEY
 * (optional) CACHE_ADMIN_SECRET
 */
const SIMPLYBOOK_CONFIG = {
  company: process.env.SIMPLYBOOK_COMPANY_LOGIN,
  apiKey: process.env.SIMPLYBOOK_API_KEY,
  apiUrl: 'https://user-api.simplybook.me' // base url used by login and admin endpoints
};

const SIMPLYBOOK_API_SECRET = process.env.SIMPLYBOOK_API_SECRET || '';

const mollieClient = createMollieClient({
  apiKey: process.env.MOLLIE_API_KEY || ''
});

if (!SIMPLYBOOK_CONFIG.company || !SIMPLYBOOK_CONFIG.apiKey) {
  console.warn('Warning: SimplyBook company or apiKey not set in env.');
}

// ---------------- Simple caches ----------------
let tokenCache = { token: null, fetchedAt: 0, ttlMs: 1000 * 60 * 50 };
let servicesCache = { data: null, fetchedAt: 0, ttlMs: 1000 * 60 * 5 };

// ---------------- Mollie in-memory state ----------------
// NOTE: in-memory only; use a DB for production so data survives restarts.
const pendingBookingsByPaymentId = new Map();
const processedPayments = new Set();

// ---------------- Normalizers ----------------
function normalizeServicesAdmin(items = []) {
  return items.map(s => {
    const id = s.id || s.service_id || null;
    const name = s.name || s.title || '';
    const price = (s.price || s.cost || '') + '';
    const duration = s.duration || s.length || '';
    const cat = (s.category && (s.category.name || s.category.title)) || s.category_name || s.group_name || 'General';
    let image_url = s.image || s.image_url || s.picture_url || null;
    if (image_url && typeof image_url === 'object') image_url = image_url.url || null;
    const status = typeof s.active === 'boolean' ? (s.active ? 'online' : 'offline') : (s.status || 'online');

    // Extract available time information
    const available_time = {
      start_time: s.start_time || s.available_from || s.time_from || null,
      end_time: s.end_time || s.available_to || s.time_to || null,
      timezone: s.timezone || s.time_zone || 'UTC',
      weekdays: s.weekdays || s.available_days || s.working_days || null,
      booking_window: s.booking_window || s.advance_booking || null
    };

    // Extract location information
    const location = {
      name: s.location_name || s.venue || s.location || null,
      address: s.address || s.location_address || s.full_address || null,
      city: s.city || s.location_city || null,
      country: s.country || s.location_country || null,
      postal_code: s.postal_code || s.zip || s.location_postal_code || null,
      coordinates: {
        latitude: s.latitude || s.lat || null,
        longitude: s.longitude || s.lng || s.lon || null
      },
      online: s.online || s.is_online || s.virtual || false,
      meeting_url: s.meeting_url || s.video_link || s.online_meeting_url || null
    };

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
      available_time,
      location,
      raw: s
    };
  });
}

function normalizeEventsToServices(events = []) {
  return events.map(e => {
    const name = e.name || e.title || e.service_name || e.event_name || '';
    const id = e.id || e.event_id || e.service_id || null;
    const duration = e.duration || e.length || e.duration_minutes || e.event_duration || '';
    const price = (e.price || e.cost || (e.pricing && e.pricing.price) || '') + '';
    const cat = e.unit_group_name || e.category || e.category_name || e.group_name || (e.location || '') || 'General';

    let image_url = null;
    if (e.image) {
      image_url = typeof e.image === 'string' ? e.image : (e.image.url || null);
    }
    image_url = image_url || e.image_url || e.picture_url || null;

    const description = e.description || e.long_description || e.details || e.text || '';
    const status = e.status || (e.active ? 'online' : 'offline') || 'online';

    // Extract available time information
    const available_time = {
      start_time: e.start_time || e.available_from || e.time_from || null,
      end_time: e.end_time || e.available_to || e.time_to || null,
      timezone: e.timezone || e.time_zone || 'UTC',
      weekdays: e.weekdays || e.available_days || e.working_days || null,
      booking_window: e.booking_window || e.advance_booking || null
    };

    // Extract location information
    const location = {
      name: e.location_name || e.venue || e.location || null,
      address: e.address || e.location_address || e.full_address || null,
      city: e.city || e.location_city || null,
      country: e.country || e.location_country || null,
      postal_code: e.postal_code || e.zip || e.location_postal_code || null,
      coordinates: {
        latitude: e.latitude || e.lat || null,
        longitude: e.longitude || e.lng || e.lon || null
      },
      online: e.online || e.is_online || e.virtual || false,
      meeting_url: e.meeting_url || e.video_link || e.online_meeting_url || null
    };

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
      available_time,
      location,
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

    // Extract available time information
    const available_time = {
      start_time: s.start_time || s.available_from || s.time_from || null,
      end_time: s.end_time || s.available_to || s.time_to || null,
      timezone: s.timezone || s.time_zone || 'UTC',
      weekdays: s.weekdays || s.available_days || s.working_days || null,
      booking_window: s.booking_window || s.advance_booking || null
    };

    // Extract location information
    const location = {
      name: s.location_name || s.venue || s.location || null,
      address: s.address || s.location_address || s.full_address || null,
      city: s.city || s.location_city || null,
      country: s.country || s.location_country || null,
      postal_code: s.postal_code || s.zip || s.location_postal_code || null,
      coordinates: {
        latitude: s.latitude || s.lat || null,
        longitude: s.longitude || s.lng || s.lon || null
      },
      online: s.online || s.is_online || s.virtual || false,
      meeting_url: s.meeting_url || s.video_link || s.online_meeting_url || null
    };

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
      available_time,
      location,
      raw: s
    };
  });
}

// ---------------- Token + RPC helpers ----------------
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

    if (!resp.data || !resp.data.result) {
      throw new Error('No token in login response');
    }

    tokenCache.token = resp.data.result;
    tokenCache.fetchedAt = Date.now();
    console.log('Obtained new SimplyBook token (cached).');
    return tokenCache.token;
  } catch (err) {
    console.error('getSimplyBookTokenCached error:', err.response?.data || err.message);
    throw new Error('Failed to obtain SimplyBook token');
  }
}

async function callAdminRpc(token, method, params = [], timeout = 15000) {
  const payload = { jsonrpc: '2.0', method, params, id: 1 };

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

function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

async function confirmSimplyBookBookingIfRequired(token, bookingResp) {
  const result = bookingResp?.result;
  if (!result?.require_confirm || !SIMPLYBOOK_API_SECRET) return [];

  const bookings = Array.isArray(result.bookings) ? result.bookings : [];
  const confirmations = [];
  for (const b of bookings) {
    if (!b?.id || !b?.hash) continue;
    const sign = md5(`${b.id}${b.hash}${SIMPLYBOOK_API_SECRET}`);
    const confirmResp = await callAdminRpc(token, 'confirmBooking', [b.id, sign]);
    confirmations.push({ bookingId: b.id, confirmResp });
  }
  return confirmations;
}

async function createSimplyBookBooking({ serviceId, performerId, datetime, clientData, additionalFields }) {
  if (!serviceId || !datetime || !clientData) {
    throw new Error('Missing required booking data');
  }

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
    // Client lookup failed, will create new
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

  // Derive start_date/start_time in a timezone-safe way.
  // If datetime is provided as an ISO-like string (YYYY-MM-DDTHH:MM...), prefer slicing
  // instead of Date() conversions (which can shift the day/time due to timezone).
  let startDate;
  let startTime;
  if (typeof datetime === 'string') {
    const m = datetime.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})/);
    if (m) {
      startDate = m[1];
      startTime = m[2];
    }
  }
  if (!startDate || !startTime) {
    const datetimeObj = new Date(datetime);
    if (Number.isNaN(datetimeObj.getTime())) {
      throw new Error('Invalid datetime provided');
    }
    const iso = datetimeObj.toISOString();
    startDate = iso.split('T')[0];
    startTime = iso.split('T')[1].substring(0, 5);
  }

  const startDateTime = `${startDate} ${startTime}:00`;

  let resolvedPerformerId = performerId ? parseInt(performerId, 10) : null;
  if (!resolvedPerformerId) {
    try {
      const availableUnitsResp = await callAdminRpc(token, 'getAvailableUnits', [parseInt(serviceId, 10), startDateTime, 1]);
      const unitsRaw = availableUnitsResp?.result;
      const units = Array.isArray(unitsRaw) ? unitsRaw : Object.values(unitsRaw || {});
      if (units.length > 0) {
        const first = units[0];
        resolvedPerformerId = parseInt(first?.id || first?.unit_id || first, 10);
      }
    } catch (e) {
      // ignore and proceed with null performer id
    }
  }

  const bookingPayload = {
    service_id: parseInt(serviceId, 10),
    unit_id: Number.isFinite(resolvedPerformerId) ? resolvedPerformerId : null,
    start_date: startDate,
    start_time: startTime,
    client_data: {
      name: clientData.full_name,
      email: clientData.email,
      phone: clientData.phone
    },
    additional_fields: additionalFields || {
      city: clientData.city || '',
      country: clientData.country || '',
      wellness_priority: clientData.wellness_priority || '',
      consultation_type: clientData.consultation_type || 'in-person',
      translator: clientData.translator || 'no',
      hear_about: clientData.hear_about || '',
      consultation_package: clientData.consultation_package || '',
      location_name: clientData.location_name || '',
      location_address: clientData.location_address || '',
      online_meeting: clientData.online_meeting || false,
      meeting_url: clientData.meeting_url || '',
      preferred_time_slot: startTime,
      booking_timezone: clientData.timezone || 'UTC'
    },
    count: 1
  };

  let bookingResp;
  try {
    bookingResp = await callAdminRpc(token, 'book', [
      bookingPayload.service_id,
      bookingPayload.unit_id,
      bookingPayload.start_date,
      bookingPayload.start_time,
      bookingPayload.client_data,
      bookingPayload.additional_fields,
      bookingPayload.count
    ]);
  } catch (e1) {
    try {
      const fallbackPayload = {
        service_id: bookingPayload.service_id,
        client_id: parseInt(clientId, 10),
        start_datetime: datetime,
        end_datetime: new Date(new Date(datetime).getTime() + 60 * 60 * 1000).toISOString(),
        additional_fields: bookingPayload.additional_fields
      };
      bookingResp = await callAdminRpc(token, 'bookSession', [fallbackPayload]);
    } catch (e2) {
      throw e2;
    }
  }

  const confirmations = await confirmSimplyBookBookingIfRequired(token, bookingResp);
  return {
    bookingResp,
    confirmations,
    booking_details: {
      service_id: serviceId,
      performer_id: Number.isFinite(resolvedPerformerId) ? resolvedPerformerId : performerId,
      start_date: startDate,
      start_time: startTime,
      client_info: {
        name: clientData.full_name,
        email: clientData.email
      }
    }
  };
}

async function callPublicRpc(method, params = [], timeout = 15000) {
  const payload = { jsonrpc: '2.0', method, params, id: 1 };
  const headers = { 'Content-Type': 'application/json' };
  if (SIMPLYBOOK_CONFIG.company) headers['X-Company-Login'] = SIMPLYBOOK_CONFIG.company;

  const resp = await axios.post(SIMPLYBOOK_CONFIG.apiUrl, payload, {
    headers,
    timeout
  });

  return resp.data;
}

// ---------------- Fetch services only from SimplyBook ----------------
async function fetchServicesCached(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && servicesCache.data && (now - servicesCache.fetchedAt) < servicesCache.ttlMs) {
    return servicesCache.data;
  }

  // 1) Admin getEventList
  try {
    const token = await getSimplyBookTokenCached();
    const adminResp = await callAdminRpc(token, 'getEventList', []);

    if (adminResp && adminResp.result) {
      const raw = Array.isArray(adminResp.result)
        ? adminResp.result
        : Object.values(adminResp.result);
      if (raw.length > 0) {
        console.log('admin getEventList returned', raw.length, 'items');
        const services = normalizeEventsToServices(raw);
        servicesCache.data = services;
        servicesCache.fetchedAt = Date.now();
        return services;
      }
    }

    if (adminResp && adminResp.error) {
      console.warn('admin getEventList error:', adminResp.error);
    }
  } catch (err) {
    console.warn('admin getEventList failed:', err.message || err);
  }

  // 2) Public getEventListPublic
  try {
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
  } catch (err) {
    console.warn('getEventListPublic failed:', err.response?.data || err.message);
  }

  // 3) Public getServiceListPublic
  try {
    const svcResp = await callPublicRpc('getServiceListPublic', []);
    if (svcResp && svcResp.result && Array.isArray(svcResp.result) && svcResp.result.length > 0) {
      console.log('getServiceListPublic returned', svcResp.result.length, 'items');
      const services = normalizeServicesListPublic(svcResp.result);
      servicesCache.data = services;
      servicesCache.fetchedAt = Date.now();
      return services;
    }
  } catch (err) {
    console.warn('getServiceListPublic failed:', err.response?.data || err.message);
  }

  // 4) Admin REST /admin/services
  try {
    const token = await getSimplyBookTokenCached();
    const adminBase = `${SIMPLYBOOK_CONFIG.apiUrl}/admin`;
    const resp = await axios.get(`${adminBase}/services`, {
      headers: {
        'X-Company-Login': SIMPLYBOOK_CONFIG.company,
        'X-Token': token
      },
      timeout: 15000
    });

    const itemsRaw = Array.isArray(resp.data)
      ? resp.data
      : (resp.data.result || resp.data.services || []);

    if (Array.isArray(itemsRaw) && itemsRaw.length > 0) {
      console.log('/admin/services returned', itemsRaw.length, 'items');
      const services = normalizeServicesAdmin(itemsRaw);
      servicesCache.data = services;
      servicesCache.fetchedAt = Date.now();
      return services;
    }
  } catch (err) {
    console.warn('/admin/services failed:', err.response?.data || err.message);
  }

  throw new Error('Failed to fetch services from SimplyBook (no methods returned data).');
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin(origin, callback) {
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
    console.log('CORS relaxed for origin:', origin);
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));
app.options('*', cors());
app.use('/api/sb', simplyBookRouter);

// Simple in-memory caches

// -------------------------
// Routes
// -------------------------
app.get('/', (req, res) => {
  res.json({
    message: 'MH Consultation Booking API',
    status: 'running',
    endpoints: {
      health: '/api/health',
      services: '/api/services',
      sb_services: '/api/sb/services',
      sb_services_list: '/api/sb/services-list'
    }
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Booking API running', timestamp: new Date().toISOString() });
});

// Main endpoint the frontend will call: returns normalized services from SimplyBook
app.get('/api/services', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const services = await fetchServicesCached(force);
    return res.json({
      ok: true,
      fetched_at: new Date().toISOString(),
      count: services.length,
      data: services
    });
  } catch (err) {
    console.error('/api/services error:', err.message || err);
    return res.status(500).json({
      ok: false,
      error: err.message || 'Failed to fetch services from SimplyBook'
    });
  }
});

app.post('/api/available-units', async (req, res) => {
  try {
    const { serviceId, startDateTime, datetime, count } = req.body || {};
    if (!serviceId) return res.status(400).json({ success: false, error: 'serviceId is required' });

    let start = startDateTime;
    if (!start && typeof datetime === 'string') {
      const m = datetime.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})/);
      if (m) start = `${m[1]} ${m[2]}:00`;
    }
    if (!start) return res.status(400).json({ success: false, error: 'startDateTime or datetime is required' });

    const token = await getSimplyBookTokenCached();
    const qty = Number.isFinite(Number(count)) ? parseInt(count, 10) : 1;
    const response = await callAdminRpc(token, 'getAvailableUnits', [parseInt(serviceId, 10), start, qty]);
    const unitsRaw = response?.result;
    const units = Array.isArray(unitsRaw) ? unitsRaw : Object.values(unitsRaw || {});

    return res.json({ success: true, count: units.length, units });
  } catch (error) {
    console.error('available-units error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch available units' });
  }
});

app.post('/api/calculate-end-time', async (req, res) => {
  try {
    const { startDateTime, datetime, serviceId, performerId } = req.body || {};
    if (!serviceId) return res.status(400).json({ success: false, error: 'serviceId is required' });

    let start = startDateTime;
    if (!start && typeof datetime === 'string') {
      const m = datetime.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})/);
      if (m) start = `${m[1]} ${m[2]}:00`;
    }
    if (!start) return res.status(400).json({ success: false, error: 'startDateTime or datetime is required' });

    const token = await getSimplyBookTokenCached();
    const response = await callAdminRpc(token, 'calculateEndTime', [start, parseInt(serviceId, 10), performerId ? parseInt(performerId, 10) : null]);
    return res.json({ success: true, endDateTime: response?.result, raw: response });
  } catch (error) {
    console.error('calculate-end-time error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: 'Failed to calculate end time' });
  }
});

// Create Mollie payment and attach a pending SimplyBook booking request.
// Frontend should call this instead of calling create-payment + create-booking separately.
app.post('/api/initiate-booking-payment', async (req, res) => {
  try {
    const { amount, description, redirectUrl, webhookUrl, bookingRequest } = req.body || {};
    if (!amount || !description || !redirectUrl) {
      return res.status(400).json({ success: false, error: 'amount, description and redirectUrl are required' });
    }
    if (!bookingRequest) {
      return res.status(400).json({ success: false, error: 'bookingRequest is required' });
    }
    if (!process.env.MOLLIE_API_KEY) return res.status(500).json({ success: false, error: 'Mollie API key not configured' });

    const payment = await mollieClient.payments.create({
      amount: { value: Number(amount).toFixed(2), currency: 'EUR' },
      description,
      redirectUrl,
      webhookUrl: webhookUrl || process.env.MOLLIE_WEBHOOK_URL || undefined,
      metadata: {
        purpose: 'simplybook_booking',
        createdAt: new Date().toISOString()
      }
    });

    pendingBookingsByPaymentId.set(payment.id, bookingRequest);
    return res.json({ success: true, checkoutUrl: payment._links.checkout.href, paymentId: payment.id });
  } catch (err) {
    console.error('initiate-booking-payment error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create Mollie payment' });
  }
});

// Mollie webhook: Mollie will POST { id: "tr_..." }
app.post('/api/mollie-webhook', async (req, res) => {
  try {
    const paymentId = req.body?.id;
    if (!paymentId) return res.status(400).send('Missing payment id');
    if (processedPayments.has(paymentId)) return res.status(200).send('Already processed');

    const payment = await mollieClient.payments.get(paymentId);
    if (!payment) return res.status(404).send('Payment not found');

    if (payment.status !== 'paid') {
      return res.status(200).send(`Ignored status ${payment.status}`);
    }

    const bookingRequest = pendingBookingsByPaymentId.get(paymentId);
    if (!bookingRequest) {
      return res.status(200).send('No pending booking attached');
    }

    await createSimplyBookBooking(bookingRequest);
    processedPayments.add(paymentId);

    return res.status(200).send('OK');
  } catch (err) {
    console.error('mollie-webhook error:', err);
    return res.status(500).send('Webhook error');
  }
});

// Frontend can call this after redirect to ensure booking is created.
app.post('/api/finalize-booking-after-payment', async (req, res) => {
  try {
    const { paymentId } = req.body || {};
    if (!paymentId) return res.status(400).json({ success: false, error: 'paymentId is required' });
    if (processedPayments.has(paymentId)) {
      return res.json({ success: true, already_processed: true });
    }

    const payment = await mollieClient.payments.get(paymentId);
    if (!payment) return res.status(404).json({ success: false, error: 'Payment not found' });
    if (payment.status !== 'paid') {
      return res.status(400).json({ success: false, error: `Payment not paid (status=${payment.status})` });
    }

    const bookingRequest = pendingBookingsByPaymentId.get(paymentId);
    if (!bookingRequest) {
      return res.status(400).json({ success: false, error: 'No pending booking attached to paymentId' });
    }

    const bookingResult = await createSimplyBookBooking(bookingRequest);
    processedPayments.add(paymentId);

    return res.json({
      success: true,
      payment_status: payment.status,
      booking: bookingResult.bookingResp,
      confirmations: bookingResult.confirmations,
      booking_details: bookingResult.booking_details
    });
  } catch (err) {
    console.error('finalize-booking-after-payment error:', err);
    return res.status(500).json({ success: false, error: 'Failed to finalize booking' });
  }
});

// Service details (incl. duration)
app.get('/api/services/:serviceId', async (req, res) => {
  try {
    const serviceId = req.params.serviceId;
    if (!serviceId) return res.status(400).json({ ok: false, error: 'serviceId is required' });
    const services = await fetchServicesCached(false);
    const svc = services.find(s => String(s.id) === String(serviceId));
    if (!svc) return res.status(404).json({ ok: false, error: 'Service not found' });
    return res.json({ ok: true, data: svc });
  } catch (err) {
    console.error('/api/services/:serviceId error:', err.message || err);
    return res.status(500).json({ ok: false, error: 'Failed to fetch service' });
  }
});

// Available dates for a month (uses SimplyBook getWorkCalendar)
app.post('/api/available-dates', async (req, res) => {
  try {
    const { year, month, performerId } = req.body || {};
    if (!year || !month) return res.status(400).json({ success: false, error: 'Year and month are required' });

    const token = await getSimplyBookTokenCached();
    const response = await callAdminRpc(token, 'getWorkCalendar', [year, month, performerId || null]);
    const calendar = response.result || {};
    const available_dates = Object.keys(calendar).filter(date => calendar[date]?.is_day_off !== 1);

    return res.json({
      success: true,
      year,
      month,
      performer_id: performerId || null,
      available_dates
    });
  } catch (error) {
    console.error('available-dates error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch available dates' });
  }
});

// Get performers/units list (using official getUnitList method)
app.get('/api/performers', async (req, res) => {
  try {
    const token = await getSimplyBookTokenCached();
    const response = await callAdminRpc(token, 'getUnitList', []);

    const performers = Array.isArray(response.result) ? response.result : Object.values(response.result || {});
    const normalizedPerformers = performers.map(p => ({
      id: p.id || p.unit_id,
      name: p.name || p.unit_name || p.title,
      description: p.description || '',
      email: p.email || '',
      phone: p.phone || '',
      location: p.location || p.address || '',
      specialties: p.specialties || p.services || [],
      available: p.active !== false,
      image_url: p.picture || p.image || null,
      timezone: p.timezone || 'UTC',
      working_hours: p.working_hours || {},
      raw: p
    }));

    return res.json({
      success: true,
      count: normalizedPerformers.length,
      data: normalizedPerformers
    });
  } catch (error) {
    console.error('get-performers error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch performers' });
  }
});

// Get work calendar for availability checking (using official getWorkCalendar method)
app.post('/api/work-calendar', async (req, res) => {
  try {
    const { year, month, performerId } = req.body;
    if (!year || !month) return res.status(400).json({ success: false, error: 'Year and month are required' });

    const token = await getSimplyBookTokenCached();
    const response = await callAdminRpc(token, 'getWorkCalendar', [year, month, performerId || null]);

    const calendar = response.result || {};

    return res.json({
      success: true,
      year,
      month,
      performer_id: performerId,
      calendar: calendar,
      working_days: Object.keys(calendar).filter(date => calendar[date].is_day_off !== 1),
      total_days: Object.keys(calendar).length
    });
  } catch (error) {
    console.error('work-calendar error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch work calendar' });
  }
});

// Get first available working day (using official getFirstWorkingDay method)
app.post('/api/first-working-day', async (req, res) => {
  try {
    const { performerId } = req.body;

    const token = await getSimplyBookTokenCached();
    const response = await callAdminRpc(token, 'getFirstWorkingDay', [performerId || null]);

    const firstWorkingDay = response.result;

    return res.json({
      success: true,
      performer_id: performerId,
      first_working_day: firstWorkingDay,
      date_info: firstWorkingDay ? {
        date: firstWorkingDay,
        day_name: new Date(firstWorkingDay + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' }),
        formatted: new Date(firstWorkingDay + 'T00:00:00').toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        })
      } : null
    });
  } catch (error) {
    console.error('first-working-day error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: 'Failed to get first working day' });
  }
});

// Check if additional fields plugin is activated (using official isPluginActivated method)
app.get('/api/plugin-status/:pluginName', async (req, res) => {
  try {
    const { pluginName } = req.params;
    if (!pluginName) return res.status(400).json({ success: false, error: 'Plugin name is required' });

    const token = await getSimplyBookTokenCached();
    const response = await callAdminRpc(token, 'isPluginActivated', [pluginName]);

    return res.json({
      success: true,
      plugin_name: pluginName,
      is_activated: response.result || false,
      message: response.result ? 'Plugin is activated' : 'Plugin is not activated'
    });
  } catch (error) {
    console.error('plugin-status error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: 'Failed to check plugin status' });
  }
});

// Get additional fields for services (using official getEventFields method)
app.get('/api/additional-fields/:serviceId', async (req, res) => {
  try {
    const { serviceId } = req.params;
    if (!serviceId) return res.status(400).json({ success: false, error: 'Service ID is required' });

    const token = await getSimplyBookTokenCached();

    // First check if additional fields plugin is activated
    const pluginStatus = await callAdminRpc(token, 'isPluginActivated', ['event_field']);

    if (!pluginStatus.result) {
      return res.json({
        success: true,
        service_id: serviceId,
        plugin_activated: false,
        fields: []
      });
    }

    // Get additional fields for the service
    const response = await callAdminRpc(token, 'getEventFields', [parseInt(serviceId, 10)]);

    const fields = Array.isArray(response.result) ? response.result : [];
    const normalizedFields = fields.map(field => ({
      id: field.id,
      name: field.name || field.field_name,
      label: field.label || field.title,
      type: field.type || 'text',
      required: field.required || false,
      options: field.options || [],
      default_value: field.default_value || '',
      description: field.description || '',
      order: field.order || 0,
      raw: field
    }));

    return res.json({
      success: true,
      service_id: serviceId,
      plugin_activated: true,
      count: normalizedFields.length,
      fields: normalizedFields
    });
  } catch (error) {
    console.error('additional-fields error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch additional fields' });
  }
});

// Get Available Time Slots (using official getStartTimeMatrix method)
app.post('/api/get-slots', async (req, res) => {
  try {
    const { serviceId, date, performerId, timezone } = req.body;
    if (!serviceId || !date) return res.status(400).json({ success: false, error: 'Service ID and date are required' });

    const token = await getSimplyBookTokenCached();
    const dateObj = new Date(date);
    if (isNaN(dateObj)) return res.status(400).json({ success: false, error: 'Invalid date' });
    const formattedDate = dateObj.toISOString().split('T')[0];

    // Use official getStartTimeMatrix method with performer support
    const rpcPayload = {
      jsonrpc: '2.0',
      method: 'getStartTimeMatrix',
      params: [formattedDate, formattedDate, parseInt(serviceId, 10), performerId || null, 1],
      id: 1
    };

    const response = await callAdminRpc(token, 'getStartTimeMatrix', [formattedDate, formattedDate, parseInt(serviceId, 10), performerId || null, 1]);

    const matrix = response.result || {};
    const times = matrix[formattedDate] || [];
    const weekday = dateObj.toLocaleDateString('en-US', { weekday: 'long' });

    // Enhanced slot information with timezone support
    const slots = times.map(t => ({
      time: t,
      available: true,
      id: `${formattedDate} ${t}`,
      timezone: timezone || 'UTC',
      weekday: weekday,
      date: formattedDate,
      formatted_time: `${t} ${timezone || 'UTC'}`
    }));

    return res.json({
      success: true,
      slots,
      metadata: {
        date: formattedDate,
        timezone: timezone || 'UTC',
        service_id: serviceId,
        performer_id: performerId,
        total_slots: slots.length
      }
    });
  } catch (error) {
    console.error('get-slots error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: error.response?.data?.message || 'Failed to fetch time slots' });
  }
});

// Create Booking (using official book method)
app.post('/api/create-booking', async (req, res) => {
  try {
    const result = await createSimplyBookBooking(req.body);
    return res.json({
      success: true,
      booking: result.bookingResp,
      confirmations: result.confirmations,
      message: 'Booking created successfully',
      booking_details: result.booking_details
    });
  } catch (error) {
    console.error('create-booking error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: error.response?.data?.message || 'Failed to create booking' });
  }
});

// Mollie payment (unchanged)
app.post('/api/create-payment', async (req, res) => {
  try {
    const { amount, description, redirectUrl, metadata, webhookUrl } = req.body;
    if (!amount || !description || !redirectUrl) return res.status(400).json({ success: false, error: 'amount, description and redirectUrl are required' });
    if (!process.env.MOLLIE_API_KEY) return res.status(500).json({ success: false, error: 'Mollie API key not configured' });

    const payment = await mollieClient.payments.create({
      amount: { value: Number(amount).toFixed(2), currency: 'EUR' },
      description,
      redirectUrl,
      webhookUrl: webhookUrl || process.env.MOLLIE_WEBHOOK_URL || undefined,
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
