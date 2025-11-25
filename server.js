require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS Configuration - Allow your Shopify store
app.use(cors({
  origin: [
    'https://maharishiayurveda.de',                      // Primary domain
    'https://www.maharishiayurveda.de',                  // www version
    'https://maharishi-ayurveda-de.myshopify.com',       // Shopify admin URL
    'http://localhost:9292' // for local testing
  ],
  credentials: true
}));

app.use(bodyParser.json());

// SimplyBook.me Configuration
const SIMPLYBOOK_CONFIG = {
  company: process.env.SIMPLYBOOK_COMPANY,
  apiKey: process.env.SIMPLYBOOK_API_KEY,
  apiUrl: 'https://user-api-v2.simplybook.me/'
};

// Utility: Get SimplyBook.me Authentication Token
async function getSimplebookToken() {
  try {
    const response = await axios.post(`${SIMPLYBOOK_CONFIG.apiUrl}/login`, {
      company: SIMPLYBOOK_CONFIG.company,
      login: SIMPLYBOOK_CONFIG.apiKey
    });
    return response.data.token;
  } catch (error) {
    throw new Error('Authentication failed');
  }
}

// ============================================
// ENDPOINT 1: Get Available Time Slots
// ============================================
app.post('/api/get-slots', async (req, res) => {
  try {
    const { serviceId, date } = req.body;
    

    if (!serviceId || !date) {
      return res.status(400).json({ 
        success: false, 
        error: 'Service ID and date are required' 
      });
    }

    const token = await getSimplebookToken();
    
    // Format date for SimplyBook API (YYYY-MM-DD)
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

    // Format slots for frontend
    const slots = response.data.map(slot => ({
      time: slot.time,
      available: slot.is_available !== false,
      id: slot.datetime || slot.time
    }));



    res.json({ success: true, slots });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.response?.data?.message || 'Failed to fetch time slots' 
    });
  }
});

// ============================================
// ENDPOINT 2: Create Booking
// ============================================
app.post('/api/create-booking', async (req, res) => {
  try {
    const { serviceId, datetime, clientData } = req.body;


    if (!serviceId || !datetime || !clientData) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required booking data' 
      });
    }

    const token = await getSimplebookToken();

    // Step 1: Create or find client
    let clientId;
    try {
      // Try to find existing client by email
      const existingClientResponse = await axios.get(
        `${SIMPLYBOOK_CONFIG.apiUrl}/admin/clients`,
        {
          headers: {
            'X-Company-Login': SIMPLYBOOK_CONFIG.company,
            'X-Token': token
          },
          params: {
            email: clientData.email
          }
        }
      );

      if (existingClientResponse.data && existingClientResponse.data.length > 0) {
        clientId = existingClientResponse.data[0].id;
      }
    } catch (e) {
    }

    // Create new client if not found
    if (!clientId) {
      const clientResponse = await axios.post(
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
      clientId = clientResponse.data.id;
    }

    // Step 2: Create booking
    const bookingResponse = await axios.post(
      `${SIMPLYBOOK_CONFIG.apiUrl}/admin/bookings`,
      {
        service_id: parseInt(serviceId),
        client_id: parseInt(clientId),
        datetime: datetime,
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

    res.json({ 
      success: true, 
      booking: bookingResponse.data,
      message: 'Booking created successfully'
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.response?.data?.message || 'Failed to create booking' 
    });
  }
});

// ============================================
// Health Check
// ============================================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Booking API is running',
    timestamp: new Date().toISOString()
  });
});

// ============================================
// Start Server
// ============================================
app.listen(PORT, () => {
});
