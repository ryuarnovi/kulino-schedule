const { chromium } = require('playwright-core');
const chromiumPack = require('@sparticuz/chromium');

module.exports = async function handler(req, res) {
    const startTime = Date.now();
    const TIMEOUT_BUDGET = 9000; // 9 seconds max total

    const username = process.env.KULINO_USERNAME;
    const password = process.env.KULINO_PASSWORD;

    if (!username || !password) {
        return res.status(401).json({ error: 'Missing Credentials' });
    }

    let browser;
    try {
        browser = await chromium.launch({
            args: [...chromiumPack.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            executablePath: await chromiumPack.executablePath(),
            headless: chromiumPack.headless,
        });

        
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
        });
        
        // Block images and CSS to speed up
        await context.route('**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2}', route => route.abort());
        
        const page = await context.newPage();

        // 1. LOGIN (Hyper fast)
        await page.goto('https://kulino.dinus.ac.id/login/index.php', { 
            waitUntil: 'domcontentloaded', 
            timeout: 5000 
        });
        
        await page.fill('#username', username);
        await page.fill('#password', password);
        
        await Promise.all([
            page.waitForNavigation({ timeout: 5000, waitUntil: 'domcontentloaded' }).catch(() => null),
            page.click('#loginbtn'),
        ]);

        // 2. SCRAPE DASHBOARD (The only thing we can afford in 10s)
        if (Date.now() - startTime > 7500) throw new Error('Timeout nearing');

        await page.goto('https://kulino.dinus.ac.id/my/', { waitUntil: 'domcontentloaded', timeout: 3000 }).catch(() => null);

        const courses = await page.evaluate(() => {
            const results = [];
            const seen = new Set();
            document.querySelectorAll('a[href*="course/view.php?id="]').forEach(el => {
                const title = el.textContent.trim();
                const url = el.href;
                if (title && url && !seen.has(url) && title.length > 3) {
                    seen.add(url);
                    results.push({ course: title, title: 'Matakuliah ditemukan', url: url, type: 'course' });
                }
            });
            return results;
        });

        await browser.close();
        return res.status(200).json(courses);
    } catch (error) {
        if (browser) await browser.close();
        return res.status(500).json({ error: 'Scrape Failed', details: error.message });
    }
}

