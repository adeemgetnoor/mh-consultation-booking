// simplybook-rpc.router.js
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { createMollieClient } = require('@mollie/api-client');

const router = express.Router();

// --- Configuration ---
const SIMPLYBOOK_URL = 'https://user-api.simplybook.me';
const COMPANY_LOGIN = process.env.SIMPLYBOOK_COMPANY_LOGIN;
const API_KEY = process.env.SIMPLYBOOK_API_KEY;
const SECRET_KEY = process.env.SIMPLYBOOK_API_SECRET; // Matches .env key name
const MOLLIE_API_KEY = process.env.MOLLIE_API_KEY;

// --- FIX: FORCE LIVE URL (Mollie rejects localhost) ---
const BASE_URL = 'https://mh-consultation-booking.vercel.app'; 

const mollieClient = createMollieClient({ apiKey: MOLLIE_API_KEY });

// --- Helper: SimplyBook JSON-RPC Client ---
async function callSimplyBook(method, params = []) {
    try {
        // 1. Get Token
        const loginResponse = await axios.post(`${SIMPLYBOOK_URL}/login`, {
            jsonrpc: '2.0',
            method: 'getToken',
            params: [COMPANY_LOGIN, API_KEY],
            id: 1
        });

        if (loginResponse.data.error) throw new Error(`Login Error: ${loginResponse.data.error.message}`);
        const token = loginResponse.data.result;

        // 2. Call API
        const response = await axios.post(SIMPLYBOOK_URL, {
            jsonrpc: '2.0',
            method: method,
            params: params,
            id: new Date().getTime()
        }, {
            headers: {
                'X-Company-Login': COMPANY_LOGIN,
                'X-Token': token
            }
        });

        if (response.data.error) throw new Error(`API Error [${method}]: ${response.data.error.message}`);
        return response.data.result;

    } catch (error) {
        console.error(`SimplyBook Call Failed: ${error.message}`);
        throw error;
    }
}

// --- Route: Initiate Booking & Payment ---
router.post('/book', async (req, res) => {
    try {
        console.log("!!! VERSION 7.0 (Title Fix) IS LIVE !!!");
        
        // 1. Extract data (Added serviceTitle)
        let { eventId, serviceTitle, unitId, date, time, clientData, additionalFields } = req.body;

        console.log("Raw Payload Received:", { eventId, serviceTitle, additionalFields });

        // --- PARSE STRINGIFIED FIELDS ---
        if (typeof additionalFields === 'string') {
            try {
                additionalFields = JSON.parse(additionalFields);
            } catch (e) {
                console.error("Failed to parse additionalFields:", e);
                additionalFields = {}; 
            }
        }
        
        // --- SAFETY LOCK ---
        if (!additionalFields) additionalFields = {};
        if (!additionalFields["76"] || additionalFields["76"] === "") {
            console.log("Auto-filling 'Others' to avoid haystack error.");
            additionalFields["76"] = "Others";
        }

        // 2. Call SimplyBook
        const bookingResult = await callSimplyBook('book', [
            eventId,
            unitId,
            date,
            time,
            clientData,
            additionalFields || {}, 
            1
        ]);
        
        // Log the result to see why code was undefined (for debugging)
        console.log("SimplyBook Booking Result:", JSON.stringify(bookingResult));

        // 3. Create Payment with BETTER DESCRIPTION
        const webhookUrl = `${BASE_URL}/api/webhook/mollie`;
        
        // Fallback title if frontend didn't send it
        const displayTitle = serviceTitle || "Consultation";
        
        // Use Booking ID if Code is missing
        const bookingRef = bookingResult.code || bookingResult.id || "Ref";

        const payment = await mollieClient.payments.create({
            amount: { value: '49.00', currency: 'EUR' }, 
            
            // FIX: Show Service Name + Client Name
            description: `${displayTitle} - ${clientData.name} (#${bookingRef})`,
            
            redirectUrl: `https://maharishi-ayurveda-de.myshopify.com/pages/booking-success`,
            webhookUrl: webhookUrl, // Must be HTTPS and Public
            metadata: {
                booking_id: bookingResult.id,
                booking_hash: bookingResult.hash,
                client_email: clientData.email
            }
        });

        res.json({ 
            success: true, 
            paymentUrl: payment.getCheckoutUrl() 
        });

    } catch (error) {
        console.error('Booking Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================================================================
// 1. GET SERVICES
// ==================================================================
router.get('/services', async (req, res) => {
    try {
        const services = await callSimplyBook('getEventList');
        res.json({ success: true, data: services });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================================================================
// 2. GET PERFORMERS
// ==================================================================
router.get('/performers', async (req, res) => {
    try {
        const { serviceId } = req.query;
        const allPerformers = await callSimplyBook('getUnitList');
        
        if (!serviceId) return res.json({ success: true, data: allPerformers });

        const allServices = await callSimplyBook('getEventList');
        const selectedService = allServices[serviceId];

        if (!selectedService) return res.status(404).json({ success: false, error: 'Service not found' });

        const unitMap = selectedService.unit_map;
        const filteredPerformers = {};
        
        if (unitMap && Object.keys(unitMap).length > 0) {
            Object.keys(allPerformers).forEach(unitId => {
                if (Object.prototype.hasOwnProperty.call(unitMap, unitId)) {
                    filteredPerformers[unitId] = allPerformers[unitId];
                }
            });
            res.json({ success: true, data: filteredPerformers });
        } else {
            res.json({ success: true, data: allPerformers });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================================================================
// 3. GET FIRST WORKING DAY
// ==================================================================
router.get('/first-working-day', async (req, res) => {
    try {
        const { unitId } = req.query;
        if (!unitId) return res.status(400).json({ error: 'Missing unitId' });

        const date = await callSimplyBook('getFirstWorkingDay', [unitId]);
        res.json({ success: true, date: date });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================================================================
// 4. GET CALENDAR
// ==================================================================
router.get('/calendar', async (req, res) => {
    try {
        const { year, month, unitId } = req.query;
        if (!year || !month || !unitId) return res.status(400).json({ error: 'Missing params' });

        const calendar = await callSimplyBook('getWorkCalendar', [year, month, unitId]);
        res.json({ success: true, data: calendar });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================================================================
// 5. GET AVAILABLE SLOTS
// ==================================================================
router.get('/slots', async (req, res) => {
    try {
        const { date, eventId, unitId, count } = req.query;
        if (!date || !eventId || !unitId) return res.status(400).json({ error: 'Missing params' });

        const matrix = await callSimplyBook('getStartTimeMatrix', [
            date, date, eventId, unitId, parseInt(count) || 1
        ]);
        
        res.json({ success: true, data: matrix });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================================================================
// 6. GET INTAKE FORMS
// ==================================================================
router.get('/intake-forms', async (req, res) => {
    try {
        const { serviceId } = req.query;
        if (!serviceId) {
            return res.status(400).json({ success: false, error: 'Missing serviceId' });
        }

        const fieldsRaw = await callSimplyBook('getAdditionalFields', [serviceId]);
        let fieldsArray = [];
        if (fieldsRaw) {
             if (Array.isArray(fieldsRaw)) {
                 fieldsArray = fieldsRaw;
             } else {
                 fieldsArray = Object.values(fieldsRaw);
             }
        }
        
        res.json({ success: true, data: fieldsArray });

    } catch (error) {
        console.error('Error fetching intake forms:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================================================================
// WEBHOOK
// ==================================================================

// Idempotency guard — track already-processed payment IDs in memory.
// (For multi-instance deployments, replace with a DB/Redis flag.)
const processedPayments = new Set();

router.post('/webhook/mollie', async (req, res) => {
    // Always respond 200 immediately so Mollie stops retrying on transient errors.
    // All logic runs after the response is acknowledged.
    res.send('OK');

    try {
        const paymentId = req.body.id;
        if (!paymentId) {
            console.warn('[Webhook] Received request with no paymentId — ignoring.');
            return;
        }

        // --- Idempotency check ---
        if (processedPayments.has(paymentId)) {
            console.log(`[Webhook] Payment ${paymentId} already processed — skipping duplicate.`);
            return;
        }

        console.log(`[Webhook] Processing payment: ${paymentId}`);
        const payment = await mollieClient.payments.get(paymentId);
        console.log(`[Webhook] Payment status: ${payment.status}`);

        if (payment.status === 'paid') {
            const { booking_id, booking_hash, client_email } = payment.metadata;
            console.log(`[Webhook] Payment paid. Confirming booking: ${booking_id} (client: ${client_email})`);

            // Build the MD5 signature expected by SimplyBook confirmBooking.
            // SECRET_KEY must equal process.env.SIMPLYBOOK_API_SECRET
            const sign = crypto.createHash('md5').update(booking_id + booking_hash + SECRET_KEY).digest('hex');
            console.log(`[Webhook] Computed sign for booking ${booking_id}: ${sign}`);

            await callSimplyBook('confirmBooking', [booking_id, sign]);

            // Mark as processed to prevent duplicate confirmations on retry
            processedPayments.add(paymentId);

            console.log(`[Webhook] ✅ Booking ${booking_id} confirmed. SimplyBook will send email to ${client_email}.`);
        } else {
            console.log(`[Webhook] Payment ${paymentId} is not paid (status: ${payment.status}). No action taken.`);
        }
    } catch (error) {
        // Log the error but do NOT change the HTTP response — 200 was already sent.
        // This prevents Mollie from retrying and causing duplicate bookings.
        console.error('[Webhook] ❌ Error processing Mollie webhook:', error.message);
    }
});

module.exports = router;