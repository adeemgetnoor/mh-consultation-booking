// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { createMollieClient } = require('@mollie/api-client');

// Import the specific RPC router we created
const simplyBookRouter = require('./simplybook-rpc.router');

const app = express();

// ---------------- CONFIGURATION ----------------
const SIMPLYBOOK_CONFIG = {
  company: process.env.SIMPLYBOOK_COMPANY_LOGIN,
  apiKey: process.env.SIMPLYBOOK_API_KEY,
  apiUrl: 'https://user-api.simplybook.me'
};

const SIMPLYBOOK_API_SECRET = process.env.SIMPLYBOOK_API_SECRET || '';

const mollieClient = createMollieClient({
  apiKey: process.env.MOLLIE_API_KEY || ''
});

if (!SIMPLYBOOK_CONFIG.company || !SIMPLYBOOK_CONFIG.apiKey) {
  console.warn('⚠️ Warning: SimplyBook company or apiKey not set in env.');
}

// ---------------- CACHE & STATE ----------------
// Token Cache: 15 min TTL to be safe (tokens last ~20m)
let tokenCache = { token: null, fetchedAt: 0, ttlMs: 1000 * 60 * 15 };
let servicesCache = { data: null, fetchedAt: 0, ttlMs: 1000 * 60 * 5 };

// Mollie State (In-Memory - Warning: Clears on restart)
const pendingBookingsByPaymentId = new Map();
const processedPayments = new Set();

// ---------------- HELPERS: RPC & TOKEN ----------------

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

async function callPublicRpc(method, params = [], timeout = 15000) {
  const payload = { jsonrpc: '2.0', method, params, id: 1 };
  const headers = { 'Content-Type': 'application/json' };
  if (SIMPLYBOOK_CONFIG.company) headers['X-Company-Login'] = SIMPLYBOOK_CONFIG.company;

  const resp = await axios.post(SIMPLYBOOK_CONFIG.apiUrl, payload, { headers, timeout });
  return resp.data;
}

// ---------------- HELPERS: DATA NORMALIZATION ----------------

async function fetchServicesCached(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && servicesCache.data && (now - servicesCache.fetchedAt) < servicesCache.ttlMs) {
    return servicesCache.data;
  }

  // Fallback Strategy: Admin RPC -> Public RPC
  try {
    const token = await getSimplyBookTokenCached();
    const adminResp = await callAdminRpc(token, 'getEventList', []);
    
    if (adminResp && adminResp.result) {
      const raw = Array.isArray(adminResp.result) ? adminResp.result : Object.values(adminResp.result);
      if (raw.length > 0) {
        const services = raw.map(s => ({
            id: s.id,
            name: s.name,
            description: s.description,
            price: s.price,
            duration: s.duration,
            image_url: s.picture_path ? `https://${SIMPLYBOOK_CONFIG.company}.simplybook.me${s.picture_path}` : null,
            // CRITICAL: Identify if it is an Event (Class) or Service
            type: (s.is_event || (s.classes_plugin_info && s.classes_plugin_info.unit_groups_binded_in_classes)) ? 'event' : 'service',
            unit_map: s.unit_map || {},
            raw: s
        }));
        servicesCache.data = services;
        servicesCache.fetchedAt = Date.now();
        return services;
      }
    }
  } catch (err) {
    console.warn('fetchServicesCached Admin failed, trying Public:', err.message);
  }

  // Public Fallback
  try {
     const publicResp = await callPublicRpc('getEventListPublic', []); 
     // Note: Logic for public list normalization would go here if admin fails
  } catch(e) { /* ignore */ }

  return servicesCache.data || [];
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
    slots = slots.filter(t => t && typeof t === 'string');

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

// ---------------- MIDDLEWARE ----------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin(origin, callback) {
    // Relaxed CORS for your development and production domains
    return callback(null, true);
  },
  credentials: true
}));

// MOUNT THE ROUTER for /api/sb path
// This handles: /api/sb/performers, /api/sb/time-slots, /api/sb/work-calendar
app.use('/api/sb', simplyBookRouter);


// ---------------- MAIN ROUTES ----------------

app.get('/', (req, res) => {
  res.json({ status: 'running', message: 'MH Consultation Booking API' });
});

// 1. Get Services (Smart Cached)
app.get('/api/services', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const services = await fetchServicesCached(force);
    res.json({ ok: true, count: services.length, data: services });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 2. Get Performers (With Fallback)
app.get('/api/performers', async (req, res) => {
  try {
    // Try Public first (matches widget behavior)
    let response = await callPublicRpc('getUnitList', []);
    
    // Fallback to Admin
    if (!response || !response.result) {
        const token = await getSimplyBookTokenCached();
        response = await callAdminRpc(token, 'getUnitList', []);
    }

    const raw = response.result || {};
    const performers = Object.values(raw).map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      email: p.email,
      image_url: p.picture_path ? `https://${SIMPLYBOOK_CONFIG.company}.simplybook.me${p.picture_path}` : null,
      services: p.services || []
    }));

    res.json({ success: true, count: performers.length, data: performers });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Smart Service Availability (The Fix for Classes vs Services)
app.post('/api/service-availability', async (req, res) => {
  try {
    const { serviceId, startDate, endDate, performerId, count } = req.body || {};
    if (!serviceId) return res.status(400).json({ success: false, error: 'Service ID is required' });

    // FIX: Default to 14 days to prevent timeouts on the SimplyBook side
    let dateFrom = startDate || new Date().toISOString().split('T')[0];
    let dateTo = endDate;
    if (!dateTo) {
      const d = new Date(dateFrom);
      d.setDate(d.getDate() + 14); 
      dateTo = d.toISOString().split('T')[0];
    }

    const availability = [];
    const allServices = await fetchServicesCached();
    const serviceInfo = allServices.find(s => String(s.id) === String(serviceId));
    const isEvent = serviceInfo?.type === 'event' || serviceInfo?.raw?.is_event;

    // PATH A: It's a Class/Event (Fixed Time) -> Use getEventListPublic
    if (isEvent) {
       console.log(`Service ${serviceId} is Event. Using Public Event List.`);
       const publicResp = await callPublicRpc('getEventListPublic', [dateFrom, dateTo]);
       if (publicResp.result && Array.isArray(publicResp.result)) {
           // Group events by date
           const map = new Map();
           publicResp.result.forEach(e => {
               // Strict match on ID
               if (String(e.service_id || e.category_id || e.unit_group_id) !== String(serviceId)) return;
               
               const [dt, tm] = (e.start_datetime || '').split(' ');
               if (dt && tm) {
                   if (!map.has(dt)) map.set(dt, []);
                   // Push time (HH:MM)
                   if(!map.get(dt).includes(tm.substring(0,5))) map.get(dt).push(tm.substring(0,5));
               }
           });
           
           map.forEach((times, date) => {
               availability.push({ date, times: times.sort(), available_slots: times.length });
           });
       }
    } 
    // PATH B: It's a Regular Service (Flexible) -> Use getStartTimeMatrix
    else {
      // Try Public Matrix
      try {
        const publicResp = await callPublicRpc('getStartTimeMatrix', [
          dateFrom,
          dateTo,
          parseInt(serviceId, 10),
          performerId ? parseInt(performerId, 10) : null,
          count ? parseInt(count, 10) : 1
        ]);
        if (publicResp && publicResp.result) {
            availability.push(...normalizeTimeMatrix(publicResp.result));
        }
      } catch (e) {
        console.warn("Public Matrix failed, trying Admin...", e.message);
        // Retry with Admin
        try {
            const token = await getSimplyBookTokenCached();
            const adminResp = await callAdminRpc(token, 'getStartTimeMatrix', [
                dateFrom, dateTo, parseInt(serviceId), performerId ? parseInt(performerId) : null, count || 1
            ]);
            if (adminResp && adminResp.result) {
                availability.push(...normalizeTimeMatrix(adminResp.result));
            }
        } catch (_) {}
      }
    }

    // Sort results
    availability.sort((a, b) => a.date.localeCompare(b.date));

    return res.json({
      success: true,
      service_id: serviceId,
      is_event: !!isEvent,
      date_range: { from: dateFrom, to: dateTo },
      availability,
      total_slots: availability.reduce((s, d) => s + d.available_slots, 0)
    });

  } catch (error) {
    console.error('service-availability error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Create Booking (Handles Payment & Free)
app.post('/api/create-booking', async (req, res) => {
  try {
    const { serviceId, performerId, datetime, clientData, payment, additionalFields } = req.body;

    if (!serviceId || !datetime || !clientData) {
        return res.status(400).json({ success: false, error: 'Missing serviceId, datetime, or clientData' });
    }

    // A. Payment Required? -> Init Mollie
    if (payment && payment.amount) {
        if (!process.env.MOLLIE_API_KEY) throw new Error("Mollie API Key missing");
        
        // Store request logic for after payment
        const bookingRequest = { serviceId, performerId, datetime, clientData, additionalFields };
        
        const molliePayment = await mollieClient.payments.create({
            amount: { value: Number(payment.amount).toFixed(2), currency: 'EUR' },
            description: payment.description || `Booking Service ${serviceId}`,
            redirectUrl: payment.redirectUrl,
            webhookUrl: payment.webhookUrl || process.env.MOLLIE_WEBHOOK_URL,
            metadata: { purpose: 'simplybook_booking', serviceId, email: clientData.email }
        });
        
        // SAVE TO MEMORY (Use DB in production!)
        pendingBookingsByPaymentId.set(molliePayment.id, bookingRequest);
        
        return res.json({ 
            success: true, 
            payment_required: true, 
            checkoutUrl: molliePayment.getCheckoutUrl(),
            paymentId: molliePayment.id
        });
    }

    // B. No Payment -> Book Directly via SimplyBook
    const token = await getSimplyBookTokenCached();
    
    // Ensure Client Exists (Simplified logic)
    // In prod, search for client by email first, then create if not exists
    const clientPayload = {
        name: clientData.full_name,
        email: clientData.email,
        phone: clientData.phone
    };

    // Format Date/Time
    const [date, timePart] = datetime.includes('T') ? datetime.split('T') : datetime.split(' ');
    const time = timePart.substring(0, 5);

    const bookParams = [
        parseInt(serviceId),
        performerId ? parseInt(performerId) : null,
        date,
        time,
        clientPayload, 
        additionalFields || {}, 
        1 // count
    ];
    
    const bookingResp = await callAdminRpc(token, 'book', bookParams);
    
    if (bookingResp.error) throw new Error(bookingResp.error.message);

    return res.json({ 
        success: true, 
        payment_required: false, 
        booking: bookingResp.result 
    });

  } catch (error) {
    console.error('create-booking error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Mollie Webhook (Completes the Payment Booking)
app.post('/api/mollie-webhook', async (req, res) => {
  try {
    const paymentId = req.body?.id;
    if (!paymentId) return res.status(400).send('Missing ID');
    if (processedPayments.has(paymentId)) return res.status(200).send('Already Processed');

    const payment = await mollieClient.payments.get(paymentId);
    if (payment.status === 'paid') {
        const request = pendingBookingsByPaymentId.get(paymentId);
        if (request) {
            // Re-trigger the booking logic
            // Note: In real app, refactor the 'book' logic into a shared function to call here
            console.log(`Payment ${paymentId} paid. Creating booking for ${request.clientData.email}`);
            
            const token = await getSimplyBookTokenCached();
            const [date, timePart] = request.datetime.includes('T') ? request.datetime.split('T') : request.datetime.split(' ');
            
            await callAdminRpc(token, 'book', [
                parseInt(request.serviceId),
                request.performerId ? parseInt(request.performerId) : null,
                date,
                timePart.substring(0,5),
                request.clientData,
                request.additionalFields || {},
                1
            ]);
            
            processedPayments.add(paymentId);
            pendingBookingsByPaymentId.delete(paymentId); // Cleanup
        }
    }
    res.status(200).send('OK');
  } catch (e) {
    console.error('Webhook Error', e);
    res.status(500).send('Error');
  }
});

// ---------------- SERVER START ----------------
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
}

module.exports = app;