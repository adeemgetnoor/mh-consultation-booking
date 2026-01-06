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
        console.log("!!! VERSION 5.0 (With Intake Forms) IS LIVE !!!");
        
        // 1. Extract data
        let { eventId, unitId, date, time, clientData, additionalFields } = req.body;

        console.log("Raw Payload Received:", { eventId, additionalFields });

        // --- THE FIX: Parse additionalFields if it came as a string ---
        if (typeof additionalFields === 'string') {
            try {
                additionalFields = JSON.parse(additionalFields);
            } catch (e) {
                console.error(" Failed to parse additionalFields:", e);
                additionalFields = {}; 
            }
        }
        
        // --- SAFETY LOCK: Ensure country field is never empty ---
        // Keeps your booking working while you implement the dynamic forms
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
// 6. GET INTAKE FORMS (Fixed for Data Structure)
// ==================================================================
router.get('/intake-forms', async (req, res) => {
    try {
        const { serviceId } = req.query;
        if (!serviceId) {
            return res.status(400).json({ success: false, error: 'Missing serviceId' });
        }

        const fieldsRaw = await callSimplyBook('getAdditionalFields', [serviceId]);
        
        // FIX: Convert Object/Map to Array so frontend can loop through it
        // and ensure we grab the data values, not just the keys.
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