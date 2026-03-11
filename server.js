require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, './'))); 

// --- API ROUTES ---

// Local fallback for /api/scrape using the logic from api/scrape.js
app.get('/api/scrape', async (req, res) => {
    try {
        const scraper = require('./api/scrape.js');
        // Mocking Vercel's req/res for local execution
        const mockRes = {
            setHeader: () => {},
            status: (code) => ({
                json: (data) => res.status(code).json(data)
            })
        };
        await scraper(req, mockRes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Task Only Server running on http://localhost:${PORT}`);
    console.log(`📂 Serving dashboard from: ${path.join(__dirname, 'public/index.html')}`);
});
