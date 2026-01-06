// index.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const simplyBookRouter = require('./simplybook-rpc.router');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors()); // Allow requests from your frontend
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Mount the SimplyBook + Payment API Router
// Endpoints will be accessible via http://localhost:3000/api/...
app.use('/api', simplyBookRouter);

// Health Check
app.get('/', (req, res) => {
    res.send('SimplyBook.me + Mollie API Service is Running');
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});