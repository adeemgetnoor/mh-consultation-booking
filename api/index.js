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

    // Service type is now determined by API behavior, not assumed here.
    const serviceType = 'service'; // Default to 'service', will be verified by availability check.

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
      type: serviceType, // 'event' or 'service'
      available_time,
      location,
      raw: s
    };
  });
}


function normalizeEventsToServices(events = [], sourceMethod = 'getEventList') {
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
    
    // Detect service type (event vs service)
    // Service type is now determined by API behavior, not assumed here.
    const serviceType = sourceMethod === 'getEventListPublic' ? 'event' : 'service';

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
      type: serviceType, // 'event' or 'service'
      available_time,
      location,
      raw: e
    };
  });
}

function normalizeTimeMatrix(matrix = {}) {
  const availability = [];

  Object.entries(matrix).forEach(([date, times]) => {
    let slots = [];

    if (Array.isArray(times)) {
      slots = times;
    } else if (times && typeof times === 'object') {
      slots = Object.values(times).flat();
    }

    slots = slots
      .map(t => typeof t === 'string' ? t : (t?.time || t?.start_time))
      .filter(Boolean);

    if (slots.length > 0) {
      availability.push({
        date,
        times: slots.sort(),
        available_slots: slots.length
      });
    }
  });

  return availability;
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

    // Service type is now determined by API behavior, not assumed here.
    const serviceType = 'service'; // Default to 'service', will be verified by availability check.

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
      type: serviceType, // 'event' or 'service'
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

  // Prepare client data according to SimplyBook API format
  const clientDataForBooking = {
    name: clientData.full_name || clientData.name || '',
    email: clientData.email || '',
    phone: clientData.phone || clientData.phone_number || '',
    ...(clientData.client_id && { client_id: parseInt(clientData.client_id, 10) })
  };

  // Prepare additional fields (merge with provided additionalFields)
  const mergedAdditionalFields = {
    ...(additionalFields || {}),
    ...(clientData.city && { city: clientData.city }),
    ...(clientData.country && { country: clientData.country }),
    ...(clientData.wellness_priority && { wellness_priority: clientData.wellness_priority }),
    ...(clientData.consultation_type && { consultation_type: clientData.consultation_type }),
    ...(clientData.translator && { translator: clientData.translator }),
    ...(clientData.hear_about && { hear_about: clientData.hear_about }),
    ...(clientData.consultation_package && { consultation_package: clientData.consultation_package }),
    ...(clientData.location_name && { location_name: clientData.location_name }),
    ...(clientData.location_address && { location_address: clientData.location_address }),
    ...(clientData.online_meeting !== undefined && { online_meeting: clientData.online_meeting }),
    ...(clientData.meeting_url && { meeting_url: clientData.meeting_url }),
    ...(clientData.timezone && { booking_timezone: clientData.timezone })
  };

  // SimplyBook book method signature: book(eventId, unitId, date, time, clientData, additional, count)
  const eventId = parseInt(serviceId, 10);
  const unitId = Number.isFinite(resolvedPerformerId) ? resolvedPerformerId : null;
  const count = 1;

  let bookingResp;
  try {
    // Primary booking method using official SimplyBook API
    bookingResp = await callAdminRpc(token, 'book', [
      eventId,              // service/event ID
      unitId,               // performer/unit ID (can be null for any performer)
      startDate,            // date in YYYY-MM-DD format
      startTime,            // time in HH:MM format
      clientDataForBooking, // client data object
      mergedAdditionalFields, // additional fields object
      count                 // number of bookings
    ]);

    // Validate response
    if (bookingResp?.error) {
      throw new Error(bookingResp.error.message || 'Booking failed');
    }
  } catch (e1) {
    console.error('Primary book method failed, trying fallback:', e1.message);
    // Fallback: try using bookSession if available (some SimplyBook setups may use this)
    try {
      const endDateTimeObj = new Date(`${startDate}T${startTime}:00`);
      // Estimate end time based on service duration (default 60 minutes if not known)
      const durationMinutes = 60; // Could fetch from service details if needed
      endDateTimeObj.setMinutes(endDateTimeObj.getMinutes() + durationMinutes);
      const endDateTime = endDateTimeObj.toISOString().replace('T', ' ').substring(0, 16);

      bookingResp = await callAdminRpc(token, 'bookSession', [{
        service_id: eventId,
        client_id: clientId ? parseInt(clientId, 10) : null,
        start_datetime: `${startDate} ${startTime}:00`,
        end_datetime: endDateTime,
        additional_fields: mergedAdditionalFields
      }]);
    } catch (e2) {
      // If both methods fail, throw the original error with context
      const errorMsg = e1.response?.data?.error?.message || e1.message || 'Booking creation failed';
      throw new Error(`Failed to create booking: ${errorMsg}. Fallback also failed: ${e2.message}`);
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

// ---------------- Availability helpers ----------------
// Get slots using getStartTimeMatrix (for regular services)
async function getSlotsFromTimeMatrix(token, serviceId, date, performerId, count = 1) {
  const serviceIdInt = parseInt(serviceId, 10);
  const performerIdInt = performerId ? parseInt(performerId, 10) : null;
  const countInt = parseInt(count, 10) || 1;
  
  const response = await callAdminRpc(token, 'getStartTimeMatrix', [
    date,
    date,
    serviceIdInt,
    performerIdInt,
    countInt
  ]);

  const matrix = response.result || {};
  const times = matrix[date] || [];
  
  let availableTimes = [];
  if (Array.isArray(times)) {
    availableTimes = times;
  } else if (typeof times === 'object' && times !== null) {
    availableTimes = Object.values(times).flat();
  }

  return availableTimes
    .map(t => typeof t === 'string' ? t : (t.time || t.start_time || ''))
    .filter(t => t && t.trim());
}

// Get slots using getEventListPublic (for events/courses)
async function getSlotsFromEvents(token, serviceId, dateFrom, dateTo) {
  const serviceIdInt = parseInt(serviceId, 10);
  const eventListResp = await callPublicRpc('getEventListPublic', [dateFrom, dateTo]);
  
  if (!eventListResp || !eventListResp.result || !Array.isArray(eventListResp.result)) {
    return new Map();
  }

  // Filter events matching service ID and date range
  const matchingEvents = eventListResp.result.filter(event => {
    const eventId = event.id || event.event_id || event.service_id;
    if (parseInt(eventId, 10) !== serviceIdInt) return false;
    
    let eventDate = event.date || event.start_date || event.occurrence_date;
    if (!eventDate && (event.start_datetime || event.datetime)) {
      const dtStr = event.start_datetime || event.datetime;
      eventDate = typeof dtStr === 'string' ? dtStr.split('T')[0] : new Date(dtStr).toISOString().split('T')[0];
    }
    
    if (eventDate) {
      const eventDateStr = typeof eventDate === 'string' ? eventDate.split('T')[0] : new Date(eventDate).toISOString().split('T')[0];
      return eventDateStr >= dateFrom && eventDateStr <= dateTo;
    }
    return false;
  });

  // Extract times from matching events
  const timesMap = new Map(); // date -> [times]
  
  matchingEvents.forEach(event => {
    let eventDate = event.date || event.start_date || event.occurrence_date;
    let eventTime = event.start_time || event.time;
    
    if (!eventDate && (event.start_datetime || event.datetime)) {
      const dtStr = event.start_datetime || event.datetime;
      eventDate = typeof dtStr === 'string' ? dtStr.split('T')[0] : new Date(dtStr).toISOString().split('T')[0];
    }
    
    if (!eventTime && (event.start_datetime || event.datetime)) {
      const dtStr = event.start_datetime || event.datetime;
      if (typeof dtStr === 'string') {
        const timeMatch = dtStr.match(/(\d{2}:\d{2})/);
        eventTime = timeMatch ? timeMatch[1] : null;
      }
    }

    if (eventDate && eventTime) {
      const dateStr = typeof eventDate === 'string' ? eventDate.split('T')[0] : new Date(eventDate).toISOString().split('T')[0];
      const timeStr = typeof eventTime === 'string' ? eventTime.substring(0, 5) : String(eventTime).substring(0, 5);
      
      if (!timesMap.has(dateStr)) {
        timesMap.set(dateStr, []);
      }
      if (!timesMap.get(dateStr).includes(timeStr)) {
        timesMap.get(dateStr).push(timeStr);
      }
    }
  });

  return timesMap; // Returns Map<date, [times]>
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
        const services = normalizeEventsToServices(raw, 'getEventList');
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
      const services = normalizeEventsToServices(publicResp.result, 'getEventListPublic');
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
      sb_services_list: '/api/sb/services-list',
      // Availability endpoints
      service_availability: 'POST /api/service-availability - Get available dates with time slots for a service',
      category_availability: 'POST /api/category-availability - Get available dates and slots for a whole category',
      work_calendar: 'POST /api/work-calendar - Get the monthly work calendar for UI hints',
      // Booking endpoints
      create_booking: 'POST /api/create-booking - Create a booking in SimplyBook',
      // Other endpoints
      performers: 'GET /api/performers - Get list of performers/units'
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


// Get available dates for a specific service (checks which dates have available time slots)

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



// Get available dates with time slots for a service (combined endpoint for convenience)
app.post('/api/service-availability', async (req, res) => {
  try {
    const { serviceId, startDate, endDate, performerId, count } = req.body || {};
    if (!serviceId) return res.status(400).json({ success: false, error: 'Service ID is required' });

    const token = await getSimplyBookTokenCached();
    
    // Set default date range (next 30 days)
    let dateFrom = startDate;
    let dateTo = endDate;
    if (!dateFrom) {
      const today = new Date();
      dateFrom = today.toISOString().split('T')[0];
    }
    if (!dateTo) {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 30);
      dateTo = futureDate.toISOString().split('T')[0];
    }

    // Validate dates
    const fromDate = new Date(dateFrom);
    const toDate = new Date(dateTo);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid date format. Use YYYY-MM-DD' });
    }
    if (fromDate > toDate) {
      return res.status(400).json({ success: false, error: 'Start date must be before end date' });
    }

    // ✅ ALWAYS try getStartTimeMatrix first
    let availability = [];

    try {
      const matrixResp = await callAdminRpc(token, 'getStartTimeMatrix', [
        dateFrom,
        dateTo,
        parseInt(serviceId, 10),
        performerId ? parseInt(performerId, 10) : null,
        count ? parseInt(count, 10) : 1
      ]);

      availability = normalizeTimeMatrix(matrixResp.result);
    } catch (_) {}

    // 🔁 Event fallback (ONLY if empty)
    if (availability.length === 0) {
      const timesMap = await getSlotsFromEvents(token, serviceId, dateFrom, dateTo);

      timesMap.forEach((times, date) => {
        availability.push({
          date,
          times: times.sort(),
          available_slots: times.length
        });
      });
    }

    // Sort dates chronologically
    availability.sort((a, b) => a.date.localeCompare(b.date));

    return res.json({
      success: true,
      service_id: serviceId,
      performer_id: performerId || null,
      date_range: { from: dateFrom, to: dateTo },
      availability,
      available_dates: availability.map(a => a.date),
      total_dates: availability.length,
      total_slots: availability.reduce((s, d) => s + d.available_slots, 0)
    });
  } catch (error) {
    console.error('service-availability error:', error.response?.data || error.message);
    const errorMsg = error.response?.data?.error?.message || error.response?.data?.message || error.message || 'Failed to fetch service availability';
    return res.status(500).json({ success: false, error: errorMsg });
  }
});

app.post('/api/category-availability', async (req, res) => {
  try {
    const { categoryId, startDate, endDate, performerId, count } = req.body || {};
    if (!categoryId) return res.status(400).json({ success: false, error: 'Category ID is required' });

    const token = await getSimplyBookTokenCached();
    const allServices = await fetchServicesCached(false);
    const categoryServices = allServices.filter(s => String(s.category_id) === String(categoryId));

    if (categoryServices.length === 0) {
      return res.json({ success: true, availability: [], message: 'No services found for this category' });
    }

    let dateFrom = startDate;
    let dateTo = endDate;
    if (!dateFrom) {
      dateFrom = new Date().toISOString().split('T')[0];
    }
    if (!dateTo) {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 30);
      dateTo = futureDate.toISOString().split('T')[0];
    }

    const aggregatedAvailability = new Map();

    for (const service of categoryServices) {
      let serviceAvailability = [];
      try {
        const matrixResp = await callAdminRpc(token, 'getStartTimeMatrix', [
          dateFrom,
          dateTo,
          parseInt(service.id, 10),
          performerId ? parseInt(performerId, 10) : null,
          count ? parseInt(count, 10) : 1
        ]);
        serviceAvailability = normalizeTimeMatrix(matrixResp.result);
      } catch (_) {}

      if (serviceAvailability.length === 0) {
        const timesMap = await getSlotsFromEvents(token, service.id, dateFrom, dateTo);
        timesMap.forEach((times, date) => {
          serviceAvailability.push({ date, times: times.sort(), available_slots: times.length });
        });
      }

      serviceAvailability.forEach(day => {
        if (aggregatedAvailability.has(day.date)) {
          const existingDay = aggregatedAvailability.get(day.date);
          const newTimes = day.times.filter(t => !existingDay.times.includes(t));
          existingDay.times.push(...newTimes);
          existingDay.times.sort();
          existingDay.available_slots = existingDay.times.length;
        } else {
          aggregatedAvailability.set(day.date, { ...day });
        }
      });
    }

    const availability = Array.from(aggregatedAvailability.values()).sort((a, b) => a.date.localeCompare(b.date));

    return res.json({
      success: true,
      category_id: categoryId,
      date_range: { from: dateFrom, to: dateTo },
      availability,
      available_dates: availability.map(a => a.date),
      total_dates: availability.length,
      total_slots: availability.reduce((s, d) => s + d.available_slots, 0)
    });

  } catch (error) {
    console.error('category-availability error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch category availability' });
  }
});

// Create Booking (with payment integration)
app.post('/api/create-booking', async (req, res) => {
  try {
    const {
      serviceId,
      performerId,
      datetime,
      date,
      time,
      clientData,
      additionalFields,
      payment
    } = req.body;

    // Validate required fields
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }

    let bookingDateTime = datetime;
    if (!bookingDateTime && date && time) {
      bookingDateTime = `${date}T${time}`;
    }
    if (!bookingDateTime) {
      return res.status(400).json({ success: false, error: 'datetime (or date+time) is required' });
    }

    if (!clientData || !clientData.email || !clientData.full_name) {
      return res.status(400).json({ 
        success: false, 
        error: 'clientData with email and full_name is required' 
      });
    }

    // If payment details are provided, initiate payment flow
    if (payment && payment.amount && payment.redirectUrl) {
      if (!process.env.MOLLIE_API_KEY) {
        return res.status(500).json({ success: false, error: 'Mollie API key not configured' });
      }

      const bookingRequest = { serviceId, performerId, datetime: bookingDateTime, clientData, additionalFields };

      const molliePayment = await mollieClient.payments.create({
        amount: { value: Number(payment.amount).toFixed(2), currency: 'EUR' },
        description: payment.description || `Booking for service ${serviceId}`,
        redirectUrl: payment.redirectUrl,
        webhookUrl: payment.webhookUrl || process.env.MOLLIE_WEBHOOK_URL || undefined,
        metadata: {
          purpose: 'simplybook_booking',
          serviceId,
          clientEmail: clientData.email,
          ...payment.metadata
        }
      });

      pendingBookingsByPaymentId.set(molliePayment.id, bookingRequest);

      return res.json({ 
        success: true, 
        payment_required: true,
        checkoutUrl: molliePayment.getCheckoutUrl(), 
        paymentId: molliePayment.id 
      });
    }

    // If no payment details, create booking directly (for free services or other scenarios)
    const result = await createSimplyBookBooking({ serviceId, performerId, datetime: bookingDateTime, clientData, additionalFields });

    if (result.bookingResp?.error) {
      throw new Error(result.bookingResp.error.message || 'Booking failed');
    }

    const bookingResult = result.bookingResp?.result || result.bookingResp;
    const bookings = bookingResult?.bookings || [];
    const bookingId = bookings.length > 0 ? bookings[0].id : bookingResult?.id || null;

    return res.json({
      success: true,
      payment_required: false,
      booking_id: bookingId,
      booking: bookingResult,
      message: 'Booking created successfully'
    });

  } catch (error) {
    console.error('create-booking error:', error.response?.data || error.message);
    const errorMsg = error.response?.data?.error?.message || error.message || 'Failed to create booking';
    return res.status(500).json({ success: false, error: errorMsg });
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
