// index.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors'); // Make sure to install: npm install cors
const simplyBookRouter = require('./simplybook-rpc.router');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
// --- FIX CORS HERE ---
// Allow all origins (*) for testing, or specify your Shopify domain
app.use(cors({
    origin: '*', // Allow all domains (easiest for development)
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Mount the SimplyBook + Payment API Router
// Endpoints will be accessible via http://localhost:3000/api/...
app.use('/api', simplyBookRouter);

// Health Check
app.get('/', (req, res) => {
    res.send('SimplyBook.me + Mollie Integration API is running');
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});