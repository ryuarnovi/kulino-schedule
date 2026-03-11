const { chromium } = require('playwright-core');
const chromiumPack = require('@sparticuz/chromium');

module.exports = async function handler(req, res) {
    const startTime = Date.now();
    const TIMEOUT_LIMIT = 9000; // 9s for Vercel

    const username = process.env.KULINO_USERNAME;
    const password = process.env.KULINO_PASSWORD;

    if (!username || !password) return res.status(401).json({ error: 'Missing Credentials' });

    let browser;
    try {
        browser = await chromium.launch({
            args: [...chromiumPack.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            executablePath: await chromiumPack.executablePath(),
            headless: chromiumPack.headless,
        });
        
        const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36' });
        await context.route('**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2}', route => route.abort());
        const page = await context.newPage();

        // 1. LOGIN
        await page.goto('https://kulino.dinus.ac.id/login/index.php', { waitUntil: 'domcontentloaded', timeout: 6000 });
        await page.fill('#username', username);
        await page.fill('#password', password);
        await Promise.all([
            page.waitForURL('**/my/**', { timeout: 8000, waitUntil: 'domcontentloaded' }).catch(() => null),
            page.click('#loginbtn'),
        ]);

        // 2. SCRAPE CALENDAR (Much more efficient for deadlines)
        console.log('📅 Transitioning to Kalender...');
        await page.goto('https://kulino.dinus.ac.id/calendar/view.php?view=upcoming', { waitUntil: 'domcontentloaded', timeout: 5000 });

        const calendarTasks = await page.evaluate(() => {
            const events = Array.from(document.querySelectorAll('.eventlist .event'));
            return events.map(ev => {
                const titleEl = ev.querySelector('h3.name a');
                const courseEl = ev.querySelector('.course a');
                const dateEl = ev.querySelector('.description'); 
                
                if (!titleEl) return null;

                const title = titleEl.textContent.trim();
                const url = titleEl.href;
                const course = courseEl ? courseEl.textContent.trim() : 'General';
                const deadline = dateEl ? dateEl.textContent.split(',')[1]?.trim() + ' ' + dateEl.textContent.split(',')[2]?.trim() : null;

                // Determine type
                let type = 'activity';
                if (title.toLowerCase().includes('tugas') || title.toLowerCase().includes('praktikum') || url.includes('assign')) type = 'assignment';
                if (title.toLowerCase().includes('kuis') || url.includes('quiz')) type = 'quiz';

                return { course, title, url, deadline, type, source: 'calendar' };
            }).filter(i => i);
        });

        // 3. OPTIONAL: Materials (Only if we have time left)
        let finalData = [...calendarTasks];
        if (Date.now() - startTime < 6000) {
             // We could potentially add dashboard course names here for context
        }

        await browser.close();
        return res.status(200).json(finalData);

    } catch (error) {
        if (browser) await browser.close();
        return res.status(500).json({ error: 'Scrape Failed', details: error.message });
    }
}



