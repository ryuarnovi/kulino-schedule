const { chromium } = require('playwright-core');
const chromiumPack = require('@sparticuz/chromium');

module.exports = async function handler(req, res) {
    const startTime = Date.now();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    
    const username = process.env.KULINO_USERNAME;
    const password = process.env.KULINO_PASSWORD;

    if (!username || !password) return res.status(401).json({ error: 'Missing Credentials' });

    let browser;
    try {
        browser = await chromium.launch({
            args: [...chromiumPack.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--block-new-web-contents'],
            executablePath: await chromiumPack.executablePath(),
            headless: true,
        });
        
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
            viewport: { width: 800, height: 600 }
        });
        
        // Fast intercept: Kill anything heavy
        await context.route('**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2,ico}', route => route.abort());
        const page = await context.newPage();

        // 1. FAST LOGIN
        await page.goto('https://kulino.dinus.ac.id/login/index.php', { waitUntil: 'commit', timeout: 5000 });
        await page.fill('#username', username);
        await page.fill('#password', password);
        
        // Parallel click and wait with low timeout
        await Promise.all([
            page.waitForURL('**/my/**', { timeout: 6000, waitUntil: 'commit' }).catch(() => null),
            page.click('#loginbtn'),
        ]);

        // If we are still at 8s, we are in trouble. Return whatever we find.
        if (Date.now() - startTime > 8500) throw new Error('Timeout at Login Stage');

        // 2. SCRAPE CALENDAR (Quick list)
        // Preferring the upcoming events view which is a flat list
        await page.goto('https://kulino.dinus.ac.id/calendar/view.php?view=upcoming', { waitUntil: 'commit', timeout: 4000 }).catch(() => null);

        const results = await page.evaluate(() => {
            // Find all event containers
            const events = Array.from(document.querySelectorAll('.eventlist .event, .calendar_event, .event'));
            return events.map(ev => {
                const titleLink = ev.querySelector('h3.name a') || ev.querySelector('.name a') || ev.querySelector('a[href*="/mod/"]');
                const courseLink = ev.querySelector('.course a') || ev.querySelector('.description a[href*="course/view.php"]');
                const dateInfo = ev.querySelector('.description') || ev.querySelector('.date');
                
                if (!titleLink || !titleLink.href.includes('/mod/')) return null;

                const title = titleLink.textContent.trim();
                const url = titleLink.href;
                const course = courseLink ? courseLink.textContent.trim() : 'Umum';
                const dateText = dateInfo ? dateInfo.textContent.trim().replace(/\n/g, ' ') : '';

                // Keywords filtering
                const t = title.toLowerCase();
                const filter = ['tugas', 'praktikum', 'pratikum', 'assign', 'kuis', 'quiz'];
                if (!filter.some(f => t.includes(f))) return null;

                return {
                    course,
                    title,
                    url,
                    deadline: dateText,
                    type: url.includes('assign') ? 'assignment' : (url.includes('quiz') ? 'quiz' : 'activity')
                };
            }).filter(i => i);
        });

        await browser.close();
        return res.status(200).json(results);

    } catch (error) {
        if (browser) await browser.close();
        return res.status(500).json({ error: 'Scrape Failed', details: error.message });
    }
}

