require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { createMollieClient } = require('@mollie/api-client');

const app = express();

/* =======================
   CONFIG
======================= */
const SIMPLYBOOK = {
  company: process.env.SIMPLYBOOK_COMPANY_LOGIN,
  apiKey: process.env.SIMPLYBOOK_API_KEY,
  apiUrl: 'https://user-api.simplybook.me'
};

const SIMPLYBOOK_API_SECRET = process.env.SIMPLYBOOK_API_SECRET || '';

const mollie = createMollieClient({
  apiKey: process.env.MOLLIE_API_KEY || ''
});

/* =======================
   MIDDLEWARE
======================= */
app.use(express.json());
app.use(cors({
  origin: [
    'http://localhost:9292',
    'http://127.0.0.1:9292',
    'https://mh-consultation-booking.vercel.app'
  ],
  credentials: true
}));

/* =======================
   CACHES
======================= */
let tokenCache = { token: null, ts: 0, ttl: 1000 * 60 * 50 };
let servicesCache = { data: null, ts: 0, ttl: 1000 * 60 * 5 };

/* =======================
   HELPERS
======================= */
function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

async function getToken() {
  if (tokenCache.token && Date.now() - tokenCache.ts < tokenCache.ttl) {
    return tokenCache.token;
  }

  const resp = await axios.post(`${SIMPLYBOOK.apiUrl}/login`, {
    jsonrpc: '2.0',
    method: 'getToken',
    params: [SIMPLYBOOK.company, SIMPLYBOOK.apiKey],
    id: 1
  });

  tokenCache = { token: resp.data.result, ts: Date.now(), ttl: tokenCache.ttl };
  return tokenCache.token;
}

async function callAdmin(method, params = []) {
  const token = await getToken();
  const resp = await axios.post(`${SIMPLYBOOK.apiUrl}/admin`, {
    jsonrpc: '2.0',
    method,
    params,
    id: 1
  }, {
    headers: {
      'X-Company-Login': SIMPLYBOOK.company,
      'X-Token': token,
      'Content-Type': 'application/json'
    }
  });

  if (resp.data.error) throw new Error(resp.data.error.message);
  return resp.data.result;
}

async function callPublic(method, params = []) {
  const resp = await axios.post(SIMPLYBOOK.apiUrl, {
    jsonrpc: '2.0',
    method,
    params,
    id: 1
  }, {
    headers: {
      'X-Company-Login': SIMPLYBOOK.company,
      'Content-Type': 'application/json'
    }
  });

  if (resp.data.error) throw new Error(resp.data.error.message);
  return resp.data.result;
}

/* =======================
   NORMALIZER
======================= */
function normalizeService(s) {
  return {
    id: s.id,
    name: s.name || s.title,
    price: String(s.price || s.cost || ''),
    duration: s.duration || '',
    category: s.category_name || 'General'
  };
}

/* =======================
   ROUTES
======================= */

/* HEALTH */
app.get('/api/health', (_, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

/* =======================
   SERVICES (KEEP)
======================= */
app.get('/api/sb/services', async (_, res) => {
  try {
    if (servicesCache.data && Date.now() - servicesCache.ts < servicesCache.ttl) {
      return res.json({ success: true, data: servicesCache.data });
    }

    const services = await callAdmin('getEventList', []);
    const normalized = services.map(normalizeService);

    servicesCache = { data: normalized, ts: Date.now(), ttl: servicesCache.ttl };
    res.json({ success: true, count: normalized.length, data: normalized });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/sb/services-list', async (_, res) => {
  try {
    const services = await callPublic('getServiceListPublic', []);
    res.json({
      success: true,
      count: services.length,
      data: services.map(normalizeService)
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* =======================
   STEP 1: AVAILABLE DATES
======================= */
app.post('/api/work-calendar', async (req, res) => {
  try {
    const { year, month, performerId } = req.body;
    if (!year || !month) {
      return res.status(400).json({ success: false, error: 'year and month required' });
    }

    const calendar = await callAdmin('getWorkCalendar', [
      year,
      month,
      performerId ? parseInt(performerId) : null
    ]);

    const availableDates = Object.keys(calendar)
      .filter(d => calendar[d].is_day_off !== 1);

    res.json({
      success: true,
      available_dates: availableDates
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* =======================
   STEP 2: TIME SLOTS
======================= */
app.post('/api/get-slots', async (req, res) => {
  try {
    const { serviceId, date, performerId, count = 1 } = req.body;
    if (!serviceId || !date) {
      return res.status(400).json({ success: false, error: 'serviceId and date required' });
    }

    let times = [];

    /* Regular services */
    try {
      const matrix = await callAdmin('getStartTimeMatrix', [
        date,
        date,
        parseInt(serviceId),
        performerId ? parseInt(performerId) : null,
        parseInt(count)
      ]);

      times = matrix?.[date] || [];
    } catch (_) {}

    /* Event fallback */
    if (!times.length) {
      const events = await callPublic('getEventListPublic', [date, date]);
      events.forEach(e => {
        const id = e.id || e.service_id;
        if (parseInt(id) === parseInt(serviceId)) {
          const time = (e.start_time || '').substring(0, 5);
          if (time) times.push(time);
        }
      });
    }

    res.json({
      success: true,
      slots: times.map(t => ({
        time: t,
        datetime: `${date}T${t}:00`
      }))
    });

  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* =======================
   STEP 3: CREATE BOOKING
======================= */
app.post('/api/create-booking', async (req, res) => {
  try {
    const { serviceId, performerId, datetime, clientData } = req.body;
    if (!serviceId || !datetime || !clientData?.email || !clientData?.full_name) {
      return res.status(400).json({ success: false, error: 'Invalid booking data' });
    }

    const [date, time] = datetime.split('T');

    const result = await callAdmin('book', [
      parseInt(serviceId),
      performerId ? parseInt(performerId) : null,
      date,
      time.substring(0, 5),
      {
        name: clientData.full_name,
        email: clientData.email,
        phone: clientData.phone || ''
      },
      {},
      1
    ]);

    if (result.require_confirm && SIMPLYBOOK_API_SECRET) {
      for (const b of result.bookings || []) {
        const sign = md5(`${b.id}${b.hash}${SIMPLYBOOK_API_SECRET}`);
        await callAdmin('confirmBooking', [b.id, sign]);
      }
    }

    res.json({ success: true, booking: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* =======================
   PAYMENT (KEEP)
======================= */
app.post('/api/create-payment', async (req, res) => {
  try {
    const { amount, description, redirectUrl } = req.body;
    const payment = await mollie.payments.create({
      amount: { value: Number(amount).toFixed(2), currency: 'EUR' },
      description,
      redirectUrl
    });
    res.json({
      success: true,
      checkoutUrl: payment._links.checkout.href,
      paymentId: payment.id
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* =======================
   START
======================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
