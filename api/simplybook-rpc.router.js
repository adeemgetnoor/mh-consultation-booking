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
const SECRET_KEY = process.env.SIMPLYBOOK_SECRET_KEY;
const MOLLIE_API_KEY = process.env.MOLLIE_API_KEY;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

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
        // 1. Extract data
        let { eventId, unitId, date, time, clientData, additionalFields } = req.body;

        console.log("Raw Payload Received:", { eventId, additionalFields });

        // --- THE FIX: Parse additionalFields if it came as a string ---
        if (typeof additionalFields === 'string') {
            console.log(" additionalFields is a string. Parsing it to object...");
            try {
                additionalFields = JSON.parse(additionalFields);
            } catch (e) {
                console.error(" Failed to parse additionalFields:", e);
                additionalFields = {}; // Fallback to empty if parsing fails
            }
        }
        // -------------------------------------------------------------

        console.log("Sending to SimplyBook:", additionalFields);

        // --- SAFETY LOCK: Ensure country field is never empty ---
        // Field ID "76" appears to be the country/region field
        if (!additionalFields["76"] || additionalFields["76"] === "") {
            console.log(" Country field (76) is empty. Setting to 'Others' as safety lock...");
            additionalFields["76"] = "Others";
        }
        // ---------------------------------------------------------

        // 2. Call SimplyBook
        const bookingResult = await callSimplyBook('book', [
            eventId,
            unitId,
            date,
            time,
            clientData,
            additionalFields || {}, // Now this is guaranteed to be an Object
            1
        ]);

        // 3. Create Payment
        const payment = await mollieClient.payments.create({
            amount: { value: '49.00', currency: 'EUR' }, 
            description: `Booking #${bookingResult.code} - ${clientData.name}`,
            redirectUrl: `https://maharishi-ayurveda-de.myshopify.com/pages/booking-success`,
            webhookUrl: `${process.env.BASE_URL}/api/webhook/mollie`,
            metadata: {
                booking_id: bookingResult.id,
                booking_hash: bookingResult.hash
            }
        });

        res.json({ 
            success: true, 
            paymentUrl: payment.getCheckoutUrl() 
        });

    } catch (error) {
        console.error('Booking Error:', error.message);
        // Send exact error to frontend
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
// 2. GET PERFORMERS (With Filtering Logic)
// ==================================================================
// Usage: /api/performers?serviceId=8
router.get('/performers', async (req, res) => {
    try {
        const { serviceId } = req.query;

        // Fetch all performers
        const allPerformers = await callSimplyBook('getUnitList');
        
        // If no serviceId is provided, return everyone
        if (!serviceId) {
            return res.json({ success: true, data: allPerformers });
        }

        // --- FILTERING LOGIC ---
        // We need to fetch service list to see 'unit_map' for the selected service
        const allServices = await callSimplyBook('getEventList');
        const selectedService = allServices[serviceId];

        if (!selectedService) {
            return res.status(404).json({ success: false, error: 'Service not found' });
        }

        const unitMap = selectedService.unit_map; // e.g. { "1": null, "2": null }
        
        // If unit_map is empty or undefined, ALL performers are allowed (usually)
        // Otherwise, filter performers list
        const filteredPerformers = {};
        
        if (unitMap && Object.keys(unitMap).length > 0) {
            Object.keys(allPerformers).forEach(unitId => {
                // Check if this unitId exists in the service's unit_map
                if (Object.prototype.hasOwnProperty.call(unitMap, unitId)) {
                    filteredPerformers[unitId] = allPerformers[unitId];
                }
            });
            res.json({ success: true, data: filteredPerformers });
        } else {
            // No specific map, return all
            res.json({ success: true, data: allPerformers });
        }

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================================================================
// 3. GET FIRST WORKING DAY
// ==================================================================
// Usage: /api/first-working-day?unitId=1
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
// 4. GET CALENDAR (Monthly Schedule)
// ==================================================================
// Usage: /api/calendar?year=2026&month=01&unitId=1
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
// 5. GET AVAILABLE SLOTS (Time Matrix)
// ==================================================================
// Usage: /api/slots?date=2026-01-06&eventId=1&unitId=1&count=1
router.get('/slots', async (req, res) => {
    try {
        const { date, eventId, unitId, count } = req.query;
        if (!date || !eventId || !unitId) return res.status(400).json({ error: 'Missing params' });

        const matrix = await callSimplyBook('getStartTimeMatrix', [
            date, // from
            date, // to (same day for single day view)
            eventId,
            unitId,
            parseInt(count) || 1
        ]);
        
        res.json({ success: true, data: matrix });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/webhook/mollie', async (req, res) => {
    try {
        const paymentId = req.body.id;
        const payment = await mollieClient.payments.get(paymentId);

        if (payment.isPaid()) {
            const { booking_id, booking_hash } = payment.metadata;
            const sign = crypto.createHash('md5').update(booking_id + booking_hash + SECRET_KEY).digest('hex');
            await callSimplyBook('confirmBooking', [booking_id, sign]);
        }
        res.send('OK');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error');
    }
});

module.exports = router;