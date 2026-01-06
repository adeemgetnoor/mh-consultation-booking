// simplybook-rpc.router.js
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const router = express.Router();

const API_URL = 'https://user-api.simplybook.me';
const COMPANY = process.env.SIMPLYBOOK_COMPANY_LOGIN;
const API_KEY = process.env.SIMPLYBOOK_API_KEY;
const API_SECRET = process.env.SIMPLYBOOK_API_SECRET || '';

let tokenCache = { token: null, fetchedAt: 0, ttlMs: 1000 * 60 * 15 }; // 15 min TTL

async function getTokenCached() {
  const now = Date.now();
  if (tokenCache.token && now - tokenCache.fetchedAt < tokenCache.ttlMs) {
    return tokenCache.token;
  }

  const payload = {
    jsonrpc: '2.0',
    method: 'getToken',
    params: [COMPANY, API_KEY],
    id: 1
  };

  const resp = await axios.post(`${API_URL}/login`, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000
  });

  if (!resp.data || !resp.data.result) {
    throw new Error('No token received from SimplyBook getToken');
  }

  tokenCache = {
    token: resp.data.result,
    fetchedAt: Date.now(),
    ttlMs: tokenCache.ttlMs
  };

  return tokenCache.token;
}

async function rpcCall(method, params = [], timeout = 15000) {
  const token = await getTokenCached();
  const payload = { jsonrpc: '2.0', method, params, id: Math.ceil(Math.random() * 1000) };

  // Use the admin endpoint for standard data retrieval
  const resp = await axios.post(`${API_URL}/admin`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'X-Company-Login': COMPANY,
      'X-Token': token
    },
    timeout
  });

  if (resp.data && resp.data.error) {
    const err = resp.data.error;
    throw new Error(`${method} error ${err.code || ''}: ${err.message || JSON.stringify(err)}`);
  }

  return resp.data?.result;
}

function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

// ==================================================================
// STEP 2: Get Services (Helper)
// ==================================================================
router.get('/services', async (req, res) => {
  try {
    const result = await rpcCall('getEventList', []);
    return res.json({ ok: true, data: result || [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================================================================
// STEP 3: Get Performer List (Normalized)
// Matches Guide: client.getUnitList()
// ==================================================================
router.get('/performers', async (req, res) => {
  try {
    const result = await rpcCall('getUnitList', []);
    
    // Normalize object { "1": {...}, "2": {...} } to array
    const performers = Object.values(result || {}).map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      email: p.email,
      image: p.picture_path ? `https://${COMPANY}.simplybook.me${p.picture_path}` : null,
      services: p.services || [] // Array of service IDs this unit can perform
    }));

    res.json({ success: true, count: performers.length, data: performers });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==================================================================
// STEP 5: Get First Working Day
// Matches Guide: client.getFirstWorkingDay(performerId)
// ==================================================================
router.get('/first-working-day/:performerId', async (req, res) => {
  try {
    const { performerId } = req.params;
    // RPC expects param as array: ["1"]
    const result = await rpcCall('getFirstWorkingDay', [performerId]);
    // Result is usually a string "YYYY-MM-DD"
    res.json({ success: true, date: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==================================================================
// STEP 6: Get Work Calendar (Month View)
// Matches Guide: client.getWorkCalendar(year, month, performerId)
// ==================================================================
router.post('/work-calendar', async (req, res) => {
  try {
    const { year, month, performerId } = req.body;
    if (!year || !month) return res.status(400).json({ success: false, error: 'Year and Month required' });

    // RPC Params: [year, month, performerId]
    const result = await rpcCall('getWorkCalendar', [year, month, performerId || null]);
    
    res.json({ success: true, calendar: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==================================================================
// STEP 7: Get Time Slots (Single Day Matrix)
// Matches Guide: client.getStartTimeMatrix(date, date, ...)
// ==================================================================
router.post('/time-slots', async (req, res) => {
  try {
    const { date, serviceId, performerId, count } = req.body;
    
    if (!date || !serviceId) {
      return res.status(400).json({ success: false, error: 'Date and ServiceID required' });
    }

    const qty = count || 1;
    const pid = performerId ? parseInt(performerId) : null;
    const sid = parseInt(serviceId);

    // RPC Params: [dateFrom, dateTo, serviceId, performerId, count]
    // We request start=date and end=date to get just that day's slots
    const result = await rpcCall('getStartTimeMatrix', [date, date, sid, pid, qty]);

    // Result format: { "2026-01-06": ["18:30:00", "19:30:00"] }
    const slots = result[date] || [];

    res.json({ 
      success: true, 
      date: date,
      slots: slots,
      count: slots.length
    });

  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==================================================================
// Book & Confirm (Admin)
// ==================================================================
router.post('/book', async (req, res) => {
  try {
    const { eventId, unitId, date, time, clientData, additional, count } = req.body || {};
    if (!eventId || !date || !time || !clientData) {
      return res.status(400).json({ ok: false, error: 'eventId, date, time, clientData are required' });
    }

    const params = [
      parseInt(eventId, 10),
      unitId ? parseInt(unitId, 10) : null,
      date,
      time,
      clientData,
      additional || {},
      count != null ? parseInt(count, 10) : 1
    ];

    const bookingInfo = await rpcCall('book', params);

    let confirmations = [];
    if (bookingInfo?.require_confirm && API_SECRET) {
      for (const b of (bookingInfo.bookings || [])) {
        const sign = md5(`${b.id}${b.hash}${API_SECRET}`);
        const confirmRes = await rpcCall('confirmBooking', [b.id, sign]);
        confirmations.push({ bookingId: b.id, result: confirmRes });
      }
    }

    return res.json({ ok: true, booking: bookingInfo, confirmations });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;