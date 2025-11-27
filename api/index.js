require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// SimplyBook config
const SIMPLYBOOK_CONFIG = {
  company: process.env.SIMPLYBOOK_COMPANY_LOGIN,
  apiKey: process.env.SIMPLYBOOK_API_KEY,
  apiUrl: 'https://user-api-v2.simplybook.me'
};

// Middleware
app.use(cors({
  origin: [
    'https://maharishiayurveda.de',
    'https://www.maharishiayurveda.de',
    'https://maharishi-ayurveda-de.myshopify.com',
    'http://localhost:9292'
  ],
  credentials: true
}));

app.use(express.json());

// Get SimplyBook token
async function getSimplyBookToken() {
  try {
    const response = await axios.post(`${SIMPLYBOOK_CONFIG.apiUrl}/login`, {
      company: SIMPLYBOOK_CONFIG.company,
      login: SIMPLYBOOK_CONFIG.apiKey
    });
    return response.data.token;
  } catch (error) {
    console.error('SimplyBook auth error:', error.response?.data || error.message);
    throw new Error('Authentication failed');
  }
}

// Get Available Time Slots
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
    const formattedDate = new Date(date).toISOString().split('T')[0];

    const response = await axios.get(
      `${SIMPLYBOOK_CONFIG.apiUrl}/admin/book/slots`,
      {
        headers: {
          'X-Company-Login': SIMPLYBOOK_CONFIG.company,
          'X-Token': token
        },
        params: {
          service_id: serviceId,
          date_from: formattedDate,
          date_to: formattedDate
        }
      }
    );

    const slots = (response.data || []).map(slot => ({
      time: slot.time,
      available: slot.is_available !== false,
      id: slot.datetime || slot.time
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

// Create Booking
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

    // Step 1: Find or create client
    let clientId;

    try {
      const existingClientResp = await axios.get(
        `${SIMPLYBOOK_CONFIG.apiUrl}/admin/clients`,
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

    // Create client if not found
    if (!clientId) {
      const clientResp = await axios.post(
        `${SIMPLYBOOK_CONFIG.apiUrl}/admin/clients`,
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
      `${SIMPLYBOOK_CONFIG.apiUrl}/admin/bookings`,
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

// Root route
app.get('/', (req, res) => {
  res.json({
    message: 'MH Consultation Booking API',
    status: 'running',
    endpoints: {
      health: '/api/health',
      getSlots: '/api/get-slots',
      createBooking: '/api/create-booking'
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

// Export for Vercel
module.exports = app;

// Local development only
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
  });
}
