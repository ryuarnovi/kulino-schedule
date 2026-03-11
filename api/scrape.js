const { chromium } = require('playwright-core');
const chromiumPack = require('@sparticuz/chromium');

module.exports = async function handler(req, res) {
    // Increase timeout for the response if possible (Vercel might still cap it)
    // but we can try to be as fast as possible.
    
    const username = process.env.KULINO_USERNAME;
    const password = process.env.KULINO_PASSWORD;

    if (!username || !password) {
        return res.status(401).json({ error: 'Kredensial tidak ditemukan di Environment Variables Vercel.' });
    }

    let browser;
    try {
        console.log('Launching browser...');
        browser = await chromium.launch({
            args: chromiumPack.args,
            executablePath: await chromiumPack.executablePath(),
            headless: chromiumPack.headless,
        });
        
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();

        // 1. Login
        console.log('Logging in...');
        await page.goto('https://kulino.dinus.ac.id/login/index.php', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.fill('#username', username);
        await page.fill('#password', password);
        
        // Use Promise.all for navigation after click to avoid race conditions
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }),
            page.click('#loginbtn'),
        ]);

        // 2. Navigasi & Scrape
        console.log('Navigating to dashboard...');
        await page.goto('https://kulino.dinus.ac.id/my/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        // Wait for courses to be visible
        await page.waitForSelector('.coursename, .course-name, .card-title', { timeout: 10000 }).catch(() => console.log('Timeout waiting for course selectors'));

        // Ambil matakuliah secara dinamis
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

        console.log(`Found ${courses.length} courses. Scraping first 3 to stay within timeout.`);

        const allItems = [];
        // Limit to 3 to avoid Vercel 10s/60s timeout
        for (const course of courses.slice(0, 3)) {
            try {
                await page.goto(course.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
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
            } catch (courseErr) {
                console.error(`Error scraping course ${course.title}:`, courseErr.message);
            }
        }

        await browser.close();
        return res.status(200).json(allItems);

    } catch (error) {
        console.error('Scrape error:', error);
        if (browser) await browser.close();
        return res.status(500).json({ 
            error: 'Gagal melakukan scraping', 
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined 
        });
    }
}
