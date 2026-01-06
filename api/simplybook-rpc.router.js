// simplybook-rpc.router.js
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { createMollieClient } = require('@mollie/api-client');

const router = express.Router();

// --- Configuration ---
// Load these from your .env file
const SIMPLYBOOK_URL = 'https://user-api.simplybook.me';
const COMPANY_LOGIN = process.env.SIMPLYBOOK_COMPANY_LOGIN;
const API_KEY = process.env.SIMPLYBOOK_API_KEY;       // Public API Key
const SECRET_KEY = process.env.SIMPLYBOOK_SECRET_KEY; // Secret Key (for signing payment confirmations)
const MOLLIE_API_KEY = process.env.MOLLIE_API_KEY;    // Mollie API Key
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'; // Your public server URL (for webhooks)

// Initialize Mollie
const mollieClient = createMollieClient({ apiKey: MOLLIE_API_KEY });

// --- Helper: SimplyBook JSON-RPC Client ---
async function callSimplyBook(method, params = []) {
    try {
        // 1. Authenticate to get a Token
        // NOTE: In production, cache this token and reuse it until it expires to speed up requests.
        const loginResponse = await axios.post(`${SIMPLYBOOK_URL}/login`, {
            jsonrpc: '2.0',
            method: 'getToken',
            params: [COMPANY_LOGIN, API_KEY],
            id: 1
        });

        if (loginResponse.data.error) throw new Error(`Login Error: ${loginResponse.data.error.message}`);
        const token = loginResponse.data.result;

        // 2. Execute the requested method
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

// --- API Endpoints ---

/**
 * GET /api/services
 * Fetches the list of available services from SimplyBook.
 */
router.get('/services', async (req, res) => {
    try {
        const services = await callSimplyBook('getEventList');
        res.json({ success: true, data: services });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/performers
 * Fetches the list of service providers (employees/units).
 */
router.get('/performers', async (req, res) => {
    try {
        const performers = await callSimplyBook('getUnitList');
        res.json({ success: true, data: performers });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/slots
 * Fetches available time slots.
 * Query Params: date (YYYY-MM-DD), eventId, unitId, count
 */
router.get('/slots', async (req, res) => {
    try {
        const { date, eventId, unitId, count } = req.query;
        if (!date || !eventId || !unitId) return res.status(400).json({ error: 'Missing required params' });

        // getStartTimeMatrix(dateFrom, dateTo, eventId, unitId, count)
        const matrix = await callSimplyBook('getStartTimeMatrix', [
            date, 
            date, 
            eventId, 
            unitId, 
            parseInt(count) || 1
        ]);
        
        res.json({ success: true, data: matrix });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/book
 * 1. Creates a booking in SimplyBook
 * 2. Creates a payment in Mollie
 * 3. Returns the payment URL to the frontend
 */
router.post('/book', async (req, res) => {
    try {
        const { eventId, unitId, date, time, clientData } = req.body;
        // clientData format: { name: "John", email: "john@doe.com", phone: "+123456" }

        // Step 1: Create Booking in SimplyBook
        // book(eventId, unitId, date, time, clientData, additionalFields, count)
        const booking = await callSimplyBook('book', [
            eventId,
            unitId,
            date,
            time,
            clientData,
            [], // additional fields
            1   // count
        ]);

        // SimplyBook returns: { id, code, hash, require_confirm }
        const bookingId = booking.id;
        const bookingHash = booking.hash; // Vital for confirming payment later

        console.log(`Booking created: ID ${bookingId}, Code ${booking.code}`);

        // Step 2: Create Payment in Mollie
        // NOTE: In a real app, calculate 'value' dynamically based on the service price from getEventList
        const payment = await mollieClient.payments.create({
            amount: { value: '10.00', currency: 'EUR' }, 
            description: `Booking #${booking.code}`,
            redirectUrl: `${BASE_URL}/booking-complete?booking_id=${bookingId}`, // Frontend success page
            webhookUrl: `${BASE_URL}/api/webhook/mollie`, // Backend webhook handler (defined below)
            metadata: {
                booking_id: bookingId,
                booking_hash: bookingHash
            }
        });

        // Step 3: Return Payment URL to frontend
        res.json({
            success: true,
            bookingId: bookingId,
            paymentUrl: payment.getCheckoutUrl()
        });

    } catch (error) {
        console.error('Booking Flow Failed:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/webhook/mollie
 * Handles payment updates from Mollie.
 * If paid, confirms the booking in SimplyBook using the Secret Key.
 */
router.post('/webhook/mollie', async (req, res) => {
    try {
        const paymentId = req.body.id;
        if (!paymentId) return res.status(400).send('Missing payment ID');

        const payment = await mollieClient.payments.get(paymentId);

        if (payment.isPaid()) {
            const { booking_id, booking_hash } = payment.metadata;

            console.log(`Payment ${paymentId} CONFIRMED for Booking ${booking_id}`);

            // Step 4: Confirm Booking in SimplyBook
            // Calculate Signature: md5(bookingId + bookingHash + secretKey)
            const signatureString = booking_id + booking_hash + SECRET_KEY;
            const sign = crypto.createHash('md5').update(signatureString).digest('hex');

            const confirmResult = await callSimplyBook('confirmBooking', [
                booking_id,
                sign
            ]);

            console.log('SimplyBook Confirmation:', confirmResult);
        } else {
            console.log(`Payment status: ${payment.status}`);
            // Logic for 'failed', 'canceled', or 'expired' can go here (e.g., cancel booking)
        }

        // Always return 200 OK to Mollie to acknowledge receipt
        res.status(200).send('OK');

    } catch (error) {
        console.error('Webhook Error:', error);
        res.status(500).send('Server Error');
    }
});

/**
 * GET /api/first-working-day
 * Finds the first available date for a specific performer.
 * Query Param: unitId
 */
router.get('/first-working-day', async (req, res) => {
    try {
        const { unitId } = req.query;
        if (!unitId) return res.status(400).json({ error: 'Missing unitId' });

        // SimplyBook API: getFirstWorkingDay(unitId)
        const date = await callSimplyBook('getFirstWorkingDay', [unitId]);
        
        res.json({ success: true, date: date });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;