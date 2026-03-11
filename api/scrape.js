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
            viewport: { width: 1280, height: 800 }
        });
        
        await context.route('**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2,ico}', route => route.abort());
        const page = await context.newPage();

        // 1. LOGIN (Super Fast)
        await page.goto('https://kulino.dinus.ac.id/login/index.php', { waitUntil: 'commit', timeout: 6000 }).catch(() => null);
        await page.fill('#username', username);
        await page.fill('#password', password);
        await Promise.all([
            page.waitForURL('**/my/**', { timeout: 6000, waitUntil: 'commit' }).catch(() => null),
            page.click('#loginbtn'),
        ]);

        // 2. SCRAPE CALENDAR (Try Month first, then Upcoming)
        let results = [];
        
        // Month View (Tengga Logic)
        try {
            await page.goto('https://kulino.dinus.ac.id/calendar/view.php?view=month', { waitUntil: 'domcontentloaded', timeout: 5000 });
            await page.waitForSelector('.calendartable', { timeout: 3000 }).catch(() => {});
            
            results = await page.evaluate(() => {
                const events = Array.from(document.querySelectorAll('a[data-action="view-event"]'));
                return events.map(ev => {
                    const rawTitle = ev.getAttribute('title') || '';
                    const url = ev.href;
                    let title = rawTitle.replace(' is due', '').replace(' opens', '').trim();
                    const parentDay = ev.closest('td.day');
                    const timestamp = parentDay ? parseInt(parentDay.getAttribute('data-day-timestamp')) * 1000 : null;
                    
                    const t = title.toLowerCase();
                    const filter = ['tugas', 'praktikum', 'pratikum', 'assign', 'kuis', 'quiz'];
                    if (!filter.some(f => t.includes(f)) && !url.includes('assign') && !url.includes('quiz')) return null;

                    return {
                        id: ev.getAttribute('data-event-id'),
                        title, url,
                        course: 'Umum (Kalender)',
                        deadlineTimestamp: timestamp,
                        type: url.includes('assign') ? 'assignment' : (url.includes('quiz') ? 'quiz' : 'activity'),
                        scrapedAt: new Date().toISOString()
                    };
                }).filter(i => i);
            });
        } catch (e) {}

        // Fallback to Upcoming View if Month is empty or failed
        if (results.length === 0 && (Date.now() - startTime < 8000)) {
            try {
                await page.goto('https://kulino.dinus.ac.id/calendar/view.php?view=upcoming', { waitUntil: 'domcontentloaded', timeout: 4000 });
                await page.waitForSelector('.eventlist .event', { timeout: 2000 }).catch(() => {});
                
                const upcomingResults = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('.eventlist .event')).map(ev => {
                        const titleLink = ev.querySelector('h3.name a') || ev.querySelector('a[href*="/mod/"]');
                        if (!titleLink) return null;
                        
                        const courseLink = ev.querySelector('a[href*="course/view.php?id="]');
                        let title = titleLink.textContent.trim().replace(/\s+is\s+due$/i, '').replace(/\s+opens$/i, '').trim();
                        let course = courseLink ? courseLink.textContent.trim() : 'Umum';
                        
                        const t = title.toLowerCase();
                        const filter = ['tugas', 'praktikum', 'pratikum', 'assign', 'kuis', 'quiz'];
                        if (!filter.some(f => t.includes(f)) && !titleLink.href.includes('assign') && !titleLink.href.includes('quiz')) return null;

                        return {
                            title, url: titleLink.href,
                            course: course.replace(/^\[\d+\]\s*/, ''),
                            type: titleLink.href.includes('assign') ? 'assignment' : (titleLink.href.includes('quiz') ? 'quiz' : 'activity'),
                            scrapedAt: new Date().toISOString()
                        };
                    }).filter(i => i);
                });
                results = [...results, ...upcomingResults];
            } catch (e) {}
        }

        await browser.close();
        return res.status(200).json(results);

    } catch (error) {
        if (browser) await browser.close();
        return res.status(500).json({ error: error.message });
    }
}




