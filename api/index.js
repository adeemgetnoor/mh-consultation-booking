// index.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors'); // Make sure to install: npm install cors
const simplyBookRouter = require('./simplybook-rpc.router');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CRITICAL CORS FIX ---
app.use(cors({
    origin: '*', // Allow all origins (Shopify, Localhost, etc.)
    methods: ['GET', 'POST', 'OPTIONS'], // Explicitly allow OPTIONS for preflight
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    credentials: true
}));

// Handle preflight requests specifically
app.options('*', cors());

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Mount the SimplyBook + Payment API Router
// Endpoints will be accessible via http://localhost:3000/api/...
app.use('/api', simplyBookRouter);

// Health Check
app.get('/', (req, res) => {
    res.send('SimplyBook API Service Running');
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});