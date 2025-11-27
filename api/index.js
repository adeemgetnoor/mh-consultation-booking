require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createMollieClient } = require('@mollie/api-client');

const app = express();

// SimplyBook config (use public API base URL)
const SIMPLYBOOK_CONFIG = {
  company: process.env.SIMPLYBOOK_COMPANY_LOGIN,
  apiKey: process.env.SIMPLYBOOK_API_KEY,
  apiUrl: 'https://user-api.simplybook.me' // no -v2, no /admin
};

// Mollie client (TEST or LIVE key from env)
const mollieClient = createMollieClient({
  apiKey: process.env.MOLLIE_API_KEY // e.g. test_xxx while developing
});

// CORS
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const allowedOrigins = [
      'https://maharishiayurveda.de',
      'https://www.maharishiayurveda.de',
      'https://maharishi-ayurveda-de.myshopify.com',
      'http://localhost:9292',
      'http://127.0.0.1:9292'
    ];
    if (allowedOrigins.indexOf(origin) !== -1 || origin.includes('.myshopify.com')) {
      callback(null, true);
    } else {
      console.log('Blocked by CORS:', origin);
      callback(null, true); // relax during testing
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

app.options('*', cors());
app.use(express.json());

// Get SimplyBook token via JSON‑RPC
async function getSimplyBookToken() {
  try {
    const payload = {
      jsonrpc: '2.0',
      method: 'getToken',
      params: [SIMPLYBOOK_CONFIG.company, SIMPLYBOOK_CONFIG.apiKey],
      id: 1
    };

    const response = await axios.post(
      `${SIMPLYBOOK_CONFIG.apiUrl}/login`,
      payload,
      { headers: { 'Content-Type': 'application/json' } }
    );

    if (!response.data || !response.data.result) {
      throw new Error('No token in response');
    }

    return response.data.result;
  } catch (error) {
    console.error('SimplyBook auth error:', error.response?.data || error.message);
    throw new Error('Authentication failed');
  }
}

// Root route
app.get('/', (req, res) => {
  res.json({
    message: 'MH Consultation Booking API',
    status: 'running',
    endpoints: {
      health: '/api/health',
      getSlots: '/api/get-slots',
      createBooking: '/api/create-booking',
      createPayment: '/api/create-payment'
    }
  });
});

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Booking API is running',
    timestamp: new Date().toISOString()
  });
});

// Get Available Time Slots using getStartTimeMatrix
app.post('/api/get-slots', async (req, res) => {
  try {
    const { serviceId, date } = req.body;

    if (!serviceId || !date) {
      return res.status(400).json({
        success: false,
        error: 'Service ID and date are required'
      });
    }

    const token = await getSimplyBookToken();

    const dateObj = new Date(date);
    const formattedDate = dateObj.toISOString().split('T')[0]; // YYYY-MM-DD

    const rpcPayload = {
      jsonrpc: '2.0',
      method: 'getStartTimeMatrix',
      params: [formattedDate, formattedDate, parseInt(serviceId, 10), null, 1],
      id: 1
    };

    const response = await axios.post(
      SIMPLYBOOK_CONFIG.apiUrl,
      rpcPayload,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Company-Login': SIMPLYBOOK_CONFIG.company,
          'X-Token': token
        }
      }
    );

    const matrix = response.data?.result || {};
    const times = matrix[formattedDate] || [];

    const slots = times.map(t => ({
      time: t,
      available: true,
      id: `${formattedDate} ${t}`
    }));

    return res.json({ success: true, slots });
  } catch (error) {
    console.error('get-slots error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error.response?.data?.message || 'Failed to fetch time slots'
    });
  }
});

// Create Booking (SimplyBook admin API)
app.post('/api/create-booking', async (req, res) => {
  try {
    const { serviceId, datetime, clientData } = req.body;

    if (!serviceId || !datetime || !clientData) {
      return res.status(400).json({
        success: false,
        error: 'Missing required booking data'
      });
    }

    const token = await getSimplyBookToken();
    const adminBase = `${SIMPLYBOOK_CONFIG.apiUrl}/admin`;

    // Step 1: Find or create client
    let clientId;

    try {
      const existingClientResp = await axios.get(
        `${adminBase}/clients`,
        {
          headers: {
            'X-Company-Login': SIMPLYBOOK_CONFIG.company,
            'X-Token': token
          },
          params: { email: clientData.email }
        }
      );

      if (Array.isArray(existingClientResp.data) && existingClientResp.data.length > 0) {
        clientId = existingClientResp.data[0].id;
      }
    } catch (e) {
      console.warn('Client lookup failed, will create new:', e.response?.data || e.message);
    }

    if (!clientId) {
      const clientResp = await axios.post(
        `${adminBase}/clients`,
        {
          name: clientData.full_name,
          email: clientData.email,
          phone: clientData.phone
        },
        {
          headers: {
            'X-Company-Login': SIMPLYBOOK_CONFIG.company,
            'X-Token': token,
            'Content-Type': 'application/json'
          }
        }
      );
      clientId = clientResp.data.id;
    }

    // Step 2: Create booking
    const bookingResp = await axios.post(
      `${adminBase}/bookings`,
      {
        service_id: parseInt(serviceId, 10),
        client_id: parseInt(clientId, 10),
        datetime,
        additional_fields: {
          city: clientData.city || '',
          country: clientData.country || '',
          wellness_priority: clientData.wellness_priority || '',
          consultation_type: clientData.consultation_type || 'in-person',
          translator: clientData.translator || 'no',
          hear_about: clientData.hear_about || '',
          consultation_package: clientData.consultation_package || ''
        }
      },
      {
        headers: {
          'X-Company-Login': SIMPLYBOOK_CONFIG.company,
          'X-Token': token,
          'Content-Type': 'application/json'
        }
      }
    );

    return res.json({
      success: true,
      booking: bookingResp.data,
      message: 'Booking created successfully'
    });
  } catch (error) {
    console.error('create-booking error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error.response?.data?.message || 'Failed to create booking'
    });
  }
});

// NEW: Create Mollie payment (TEST key)
app.post('/api/create-payment', async (req, res) => {
  try {
    const { amount, description, redirectUrl, metadata } = req.body;

    if (!amount || !description || !redirectUrl) {
      return res.status(400).json({
        success: false,
        error: 'amount, description and redirectUrl are required'
      });
    }

    const payment = await mollieClient.payments.create({
      amount: {
        value: Number(amount).toFixed(2), // "50.00"
        currency: 'EUR'
      },
      description,
      redirectUrl,
      // Optional: webhookUrl: 'https://your-domain.com/api/mollie-webhook',
      metadata: metadata || {}
    });

    return res.json({
      success: true,
      checkoutUrl: payment._links.checkout.href,
      paymentId: payment.id
    });
  } catch (err) {
    console.error('Mollie create-payment error:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to create Mollie payment'
    });
  }
});

// Export for Vercel
module.exports = app;

// Local dev
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
  });
}
