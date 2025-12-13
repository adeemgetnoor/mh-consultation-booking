const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const router = express.Router();

const API_URL = 'https://user-api.simplybook.me';
const COMPANY = process.env.SIMPLYBOOK_COMPANY_LOGIN;
const API_KEY = process.env.SIMPLYBOOK_API_KEY;
const API_SECRET = process.env.SIMPLYBOOK_API_SECRET || '';

let tokenCache = { token: null, fetchedAt: 0, ttlMs: 1000 * 60 * 50 };

async function getTokenCached() {
  const now = Date.now();
  if (tokenCache.token && now - tokenCache.fetchedAt < tokenCache.ttlMs) return tokenCache.token;
  const payload = { jsonrpc: '2.0', method: 'getToken', params: [COMPANY, API_KEY], id: 1 };
  const resp = await axios.post(`${API_URL}/login`, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
  if (!resp.data || !resp.data.result) throw new Error('No token received from SimplyBook getToken');
  tokenCache = { token: resp.data.result, fetchedAt: Date.now(), ttlMs: tokenCache.ttlMs };
  return tokenCache.token;
}

async function rpcCall(method, params = [], timeout = 15000) {
  const token = await getTokenCached();
  const payload = { jsonrpc: '2.0', method, params, id: 1 };
  const resp = await axios.post(API_URL, payload, {
    headers: { 'Content-Type': 'application/json', 'X-Company-Login': COMPANY, 'X-Token': token },
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

router.get('/services', async (req, res) => {
  try {
    const result = await rpcCall('getEventList', []);
    return res.json({ ok: true, data: result || [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/services-list', async (req, res) => {
  try {
    const result = await rpcCall('getEventList', []);
    const items = Array.isArray(result) ? result : Object.values(result || {});
    let data = items.map(s => {
      const id = s.id != null ? parseInt(s.id, 10) : null;
      const name = s.name || '';
      const description = s.description || s.short_description || '';
      const duration = s.duration != null ? parseInt(s.duration, 10) : null;
      const price = s.price_with_tax != null ? Number(s.price_with_tax) : (s.price != null ? Number(s.price) : null);
      const currency = s.currency || null;
      const rawPath = s.picture_path || null;
      const image_url = rawPath ? (rawPath.startsWith('http') ? rawPath : `${API_URL}${rawPath}`) : null;
      const is_public = s.is_public === '1' || s.is_public === 1 || s.is_public === true;
      const is_active = s.is_active === '1' || s.is_active === 1 || s.is_active === true;
      const categories = Array.isArray(s.categories) ? s.categories : [];
      const providers = Array.isArray(s.providers) ? s.providers : [];
      return { id, name, description, duration, price, currency, image_url, is_public, is_active, categories, providers, raw: s };
    });
    const onlyActive = req.query.active === 'true';
    const onlyPublic = req.query.public === 'true';
    if (onlyActive || onlyPublic) {
      data = data.filter(d => (!onlyActive || d.is_active) && (!onlyPublic || d.is_public));
    }
    return res.json({ ok: true, count: data.length, data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/units', async (req, res) => {
  try {
    const result = await rpcCall('getUnitList', []);
    return res.json({ ok: true, data: result || [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/first-working-day', async (req, res) => {
  try {
    const performerId = req.query.performerId ? parseInt(req.query.performerId, 10) : null;
    const result = await rpcCall('getFirstWorkingDay', [performerId]);
    return res.json({ ok: true, data: result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/work-calendar', async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10);
    if (Number.isNaN(year) || Number.isNaN(month)) return res.status(400).json({ ok: false, error: 'year and month are required integers' });
    const performerId = req.query.performerId ? parseInt(req.query.performerId, 10) : null;
    const result = await rpcCall('getWorkCalendar', [year, month, performerId]);
    return res.json({ ok: true, data: result || {} });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/start-time-matrix', async (req, res) => {
  try {
    const { dateFrom, dateTo, eventId, performerId, count } = req.body || {};
    if (!dateFrom || !dateTo || !eventId) return res.status(400).json({ ok: false, error: 'dateFrom, dateTo, and eventId are required' });
    const eventIdInt = parseInt(eventId, 10);
    const performerIdInt = performerId != null ? parseInt(performerId, 10) : null;
    const qty = count != null ? parseInt(count, 10) : 1;
    const result = await rpcCall('getStartTimeMatrix', [dateFrom, dateTo, eventIdInt, performerIdInt, qty]);
    return res.json({ ok: true, data: result || {} });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/calculate-end-time', async (req, res) => {
  try {
    const { startDateTime, eventId, performerId } = req.body || {};
    if (!startDateTime || !eventId) return res.status(400).json({ ok: false, error: 'startDateTime and eventId are required' });
    const eventIdInt = parseInt(eventId, 10);
    const performerIdInt = performerId != null ? parseInt(performerId, 10) : null;
    const result = await rpcCall('calculateEndTime', [startDateTime, eventIdInt, performerIdInt]);
    return res.json({ ok: true, data: result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/additional-fields', async (req, res) => {
  try {
    const eventId = req.query.eventId ? parseInt(req.query.eventId, 10) : null;
    if (!eventId) return res.status(400).json({ ok: false, error: 'eventId is required' });
    const result = await rpcCall('getAdditionalFields', [eventId]);
    return res.json({ ok: true, data: result || [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/book', async (req, res) => {
  try {
    const { eventId, unitId, date, time, clientData, additional, count, batchId } = req.body || {};
    if (!eventId || !unitId || !date || !time || !clientData) return res.status(400).json({ ok: false, error: 'eventId, unitId, date, time, clientData are required' });
    const params = [
      parseInt(eventId, 10),
      parseInt(unitId, 10),
      date,
      time,
      clientData,
      additional || {},
      count != null ? parseInt(count, 10) : 1,
      batchId || null
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
