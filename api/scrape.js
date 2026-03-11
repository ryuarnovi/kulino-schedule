const { chromium } = require('playwright-core');
const chromiumPack = require('@sparticuz/chromium');

module.exports = async function handler(req, res) {
    const startTime = Date.now();
    
    // Vercel Hobby Limit is 10s. We should stop and return what we have at 9s.
    const VERCEL_TIMEOUT = 9500; 

    const username = process.env.KULINO_USERNAME;
    const password = process.env.KULINO_PASSWORD;

    if (!username || !password) {
        return res.status(401).json({ error: 'Kredensial tidak ditemukan di Environment Variables Vercel.' });
    }

    let browser;
    try {
        console.log('--- Start Scrape ---');
        
        // Launch Configuration for Serverless
        browser = await chromium.launch({
            args: [...chromiumPack.args, '--no-sandbox', '--disable-setuid-sandbox'],
            executablePath: await chromiumPack.executablePath(),
            headless: chromiumPack.headless,
        });
        
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();

        // 1. FAST LOGIN
        console.log('Logging in...');
        await page.goto('https://kulino.dinus.ac.id/login/index.php', { 
            waitUntil: 'domcontentloaded', 
            timeout: 8000 
        });
        
        await page.fill('#username', username);
        await page.fill('#password', password);
        
        // Click and wait for the dashboard to start loading, not necessarily finish
        await Promise.all([
            page.waitForURL('**/my/**', { timeout: 8000, waitUntil: 'domcontentloaded' }),
            page.click('#loginbtn'),
        ]);

        console.log('Dashboard loaded.');

        // 2. SCRAPE DASHBOARD (Dinamis)
        // Check time remaining
        if (Date.now() - startTime > VERCEL_TIMEOUT) throw new Error('Timeout after login');

        const courses = await page.evaluate(() => {
            const selectors = ['.coursename', '.course-name', '.multiline', '.card-title'];
            const results = [];
            const seenUrls = new Set();
            selectors.forEach(selector => {
                document.querySelectorAll(selector).forEach(el => {
                    const link = el.tagName === 'A' ? el : el.querySelector('a');
                    if (link && link.href && !seenUrls.has(link.href)) {
                        seenUrls.add(link.href);
                        results.push({ title: el.textContent.trim(), url: link.href });
                    }
                });
            });
            return results;
        });

        console.log(`Found ${courses.length} courses.`);

        const allItems = [];
        // Only attempt to scrape the FIRST course to stay within 10s
        // If we have more than 7s already, we just return the courses list
        if (Date.now() - startTime < 7000 && courses.length > 0) {
            const course = courses[0];
            try {
                console.log(`Scraping course: ${course.title}`);
                await page.goto(course.url, { waitUntil: 'domcontentloaded', timeout: 5000 });
                const items = await page.evaluate((cTitle) => {
                    return Array.from(document.querySelectorAll('.activityinstance')).map(mod => {
                        const link = mod.querySelector('a');
                        const img = mod.querySelector('img');
                        return link ? {
                            course: cTitle,
                            title: link.textContent.trim(),
                            url: link.href,
                            type: img ? img.alt : 'activity',
                            scrapedAt: new Date().toISOString()
                        } : null;
                    }).filter(i => i);
                }, course.title);
                allItems.push(...items);
            } catch (err) {
                console.warn('Course scrape partial failure:', err.message);
            }
        }

        await browser.close();
        
        // Return whatever we managed to get
        return res.status(200).json(allItems.length > 0 ? allItems : courses.map(c => ({ course: c.title, title: 'Matakuliah ditemukan', url: c.url, type: 'course' })));

    } catch (error) {
        console.error('Final Scrape Error:', error);
        if (browser) await browser.close();
        return res.status(500).json({ 
            error: 'Gagal melakukan scraping', 
            details: error.message,
            timeElapsed: `${Date.now() - startTime}ms`
        });
    }
}
