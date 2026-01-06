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