const { chromium } = require('playwright-core');
const chromiumPack = require('@sparticuz/chromium');

module.exports = async function handler(req, res) {
    const startTime = Date.now();
    const TIMEOUT_LIMIT = 9000; 

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
        // Block images/CSS to save time
        await context.route('**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2}', route => route.abort());
        const page = await context.newPage();

        // 1. LOGIN
        console.log('Logging in...');
        await page.goto('https://kulino.dinus.ac.id/login/index.php', { waitUntil: 'domcontentloaded', timeout: 7000 });
        await page.fill('#username', username);
        await page.fill('#password', password);
        await Promise.all([
            page.waitForNavigation({ timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => null),
            page.click('#loginbtn'),
        ]);

        // Verifikasi Login (Check if logged in)
        const isLoggedIn = await page.evaluate(() => {
            const text = document.body.innerText.toLowerCase();
            return text.includes('logout') || text.includes('keluar') || !!document.querySelector('.userbutton') || !!document.querySelector('.usermenu');
        });
        
        if (!isLoggedIn) {
             throw new Error('Login Gagal. Mohon cek KULINO_USERNAME dan KULINO_PASSWORD Anda.');
        }

        // 2. SCRAPE CALENDAR
        let results = [];
        try {
            console.log('Navigating to Calendar...');
            // Direct to upcoming view as it's the most reliable list for tasks
            await page.goto('https://kulino.dinus.ac.id/calendar/view.php?view=upcoming', { waitUntil: 'domcontentloaded', timeout: 5000 });
            
            results = await page.evaluate(() => {
                // Selector for Moodle Calendar events
                const events = Array.from(document.querySelectorAll('.eventlist .event, .calendar_event'));
                return events.map(ev => {
                    const titleEl = ev.querySelector('h3.name a') || ev.querySelector('.name a');
                    const courseEl = ev.querySelector('.course a') || ev.querySelector('.course');
                    const dateEl = ev.querySelector('.description') || ev.querySelector('.date'); 
                    
                    if (!titleEl) return null;
                    
                    const title = titleEl.textContent.trim();
                    const url = titleEl.href;
                    const course = courseEl ? courseEl.textContent.trim() : 'Umum';
                    const deadline = dateEl ? dateEl.textContent.trim().replace(/\n/g, ' ') : '';
                    
                    // Kita hanya ingin Tugas, Praktikum, atau Kuis
                    const t = title.toLowerCase();
                    const filter = ['tugas', 'praktikum', 'pratikum', 'assign', 'kuis', 'quiz'];
                    const isTask = filter.some(f => t.includes(f));
                    
                    if (!isTask) return null;

                    return {
                        course,
                        title,
                        url,
                        deadline,
                        type: url.includes('assign') ? 'assignment' : (url.includes('quiz') ? 'quiz' : 'activity')
                    };
                }).filter(i => i);
            });
        } catch (e) {
            console.error('Scrape Calendar Error:', e.message);
        }

        // 3. FALLBACK DASHBOARD (If empty & time exists)
        if (results.length === 0 && (Date.now() - startTime < 7500)) {
            console.log('Calendar empty, fallback to Dashboard...');
            await page.goto('https://kulino.dinus.ac.id/my/', { waitUntil: 'domcontentloaded', timeout: 4000 }).catch(() => null);
            const courses = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('.coursename, .course-name')).map(el => {
                    const link = el.tagName === 'A' ? el : el.querySelector('a');
                    if (link) return { course: el.textContent.trim(), title: 'Matakuliah ditemukan', url: link.href, type: 'course' };
                    return null;
                }).filter(i => i);
            });
            results = [...courses];
        }

        await browser.close();
        return res.status(200).json(results);

    } catch (error) {
        if (browser) await browser.close();
        return res.status(500).json({ error: error.message });
    }
}
