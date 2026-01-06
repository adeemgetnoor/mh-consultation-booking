// index.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const simplyBookRouter = require('./simplybook-rpc.router');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CRITICAL CORS FIX ---
// This allows your Shopify store (and localhost) to talk to the backend
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'OPTIONS'], 
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    credentials: true
}));

// Handle preflight requests explicitly
app.options('*', cors());

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use('/api', simplyBookRouter);

app.get('/', (req, res) => {
    res.send('SimplyBook API Service Running');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});