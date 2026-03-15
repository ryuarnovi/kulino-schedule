const { chromium } = require('playwright-core');
const chromiumPack = require('@sparticuz/chromium');
const path = require('path');
const fs = require('fs');

module.exports = async function handler(req, res) {
    const startTime = Date.now();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    
    const username = process.env.KULINO_USERNAME;
    const password = process.env.KULINO_PASSWORD;

    // Load existing data for status sync
    let historyMap = new Map();
    try {
        const dataPath = path.join(process.cwd(), 'public', 'deadlines.json');
        if (fs.existsSync(dataPath)) {
            const history = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
            history.forEach(t => {
                if (t.isSubmitted) historyMap.set(t.url, true);
            });
        }
    } catch (e) {}

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

        // 2. SCRAPE CALENDAR (Try Upcoming first for Course Names, then Month)
        let results = [];
        const h3 = 3 * 24 * 60 * 60 * 1000;
        const now = Date.now();

        // Upcoming View (Faster for Course Names)
        try {
            await page.goto('https://kulino.dinus.ac.id/calendar/view.php?view=upcoming', { waitUntil: 'domcontentloaded', timeout: 5000 });
            await page.waitForSelector('.eventlist .event', { timeout: 3000 }).catch(() => {});
            
            results = await page.evaluate(() => {
                const filter = ['tugas', 'praktikum', 'pratikum', 'assign', 'kuis', 'quiz', 'praktek', 'ujian', 'repositori', 'repository', 'proyek', 'project', 'forum', 'kegiatan', 'mahasiswa', 'student', 'activity', 'survey', 'kuesioner'];
                return Array.from(document.querySelectorAll('.eventlist .event')).map(ev => {
                    const titleLink = ev.querySelector('h3.name a') || ev.querySelector('a[href*="/mod/"]');
                    if (!titleLink) return null;
                    
                    const title = titleLink.textContent.trim().replace(/\s+is\s+due$/i, '').replace(/\s+opens$/i, '').trim();
                    const url = titleLink.href;
                    
                    const t = title.toLowerCase();
                    const isTask = filter.some(f => t.includes(f)) || url.includes('assign') || url.includes('quiz') || url.includes('forum') || url.includes('choice') || url.includes('feedback') || url.includes('survey') || url.includes('workshop') || url.includes('lti') || url.includes('resource') || url.includes('url');
                    if (!isTask) return null;

                    // Upcoming view has course link near the bottom
                    const courseLink = ev.querySelector('a[href*="course/view.php?id="]');
                    let courseName = courseLink ? courseLink.textContent.trim() : "";

                    return {
                        id: ev.getAttribute('data-event-id') || url,
                        title, url,
                        course: courseName,
                        type: url.includes('assign') ? 'assignment' : (url.includes('quiz') ? 'quiz' : (url.includes('forum') ? 'forum' : (url.includes('choice') || url.includes('feedback') || url.includes('survey') || url.includes('workshop') || url.includes('lti') || url.includes('resource') || url.includes('url') || t.includes('kegiatan') || t.includes('activity') ? 'student_activity' : 'activity'))),
                        scrapedAt: new Date().toISOString()
                    };
                }).filter(i => i);
            });
        } catch (e) {}

        // Fallback to Month View if Upcoming is empty
        if (results.length === 0 && (Date.now() - startTime < 8000)) {
            try {
                await page.goto('https://kulino.dinus.ac.id/calendar/view.php?view=month', { waitUntil: 'domcontentloaded', timeout: 4000 });
                await page.waitForSelector('.calendartable', { timeout: 2000 }).catch(() => {});
                
                const monthResults = await page.evaluate(() => {
                    const filter = ['tugas', 'praktikum', 'pratikum', 'assign', 'kuis', 'quiz', 'praktek', 'ujian', 'repositori', 'repository', 'proyek', 'project', 'forum', 'kegiatan', 'mahasiswa', 'student', 'activity', 'survey', 'kuesioner'];
                    const events = Array.from(document.querySelectorAll('a[data-action="view-event"]'));
                    return events.map(ev => {
                        const rawTitle = ev.getAttribute('title') || '';
                        const url = ev.href;
                        let title = rawTitle.replace(' is due', '').replace(' opens', '').trim();
                        
                        const t = title.toLowerCase();
                        const isTask = filter.some(f => t.includes(f)) || url.includes('assign') || url.includes('quiz') || url.includes('forum') || url.includes('choice') || url.includes('feedback') || url.includes('survey') || url.includes('workshop') || url.includes('lti') || url.includes('resource') || url.includes('url');
                        if (!isTask) return null;

                        const parentDay = ev.closest('td.day');
                        const timestamp = parentDay ? parseInt(parentDay.getAttribute('data-day-timestamp')) * 1000 : null;

                        // Try to parse course name from title attribute if possible
                        // Format: "Course Name: Event Name is due"
                        let courseName = "";
                        if (rawTitle.includes(':')) {
                            courseName = rawTitle.split(':')[0].trim();
                        }

                        return {
                            id: ev.getAttribute('data-event-id'),
                            title, url,
                            course: courseName,
                            deadlineTimestamp: timestamp,
                        type: url.includes('assign') ? 'assignment' : (url.includes('quiz') ? 'quiz' : (url.includes('forum') ? 'forum' : (url.includes('choice') || url.includes('feedback') || url.includes('survey') || url.includes('workshop') || url.includes('lti') || url.includes('resource') || url.includes('url') || t.includes('kegiatan') || t.includes('activity') ? 'student_activity' : 'activity'))),
                        scrapedAt: new Date().toISOString()
                    };
                    }).filter(i => i);
                });
                results = [...results, ...monthResults];
            } catch (e) {}
        }


        // Final Sync with History
        results = results.map(r => ({
            ...r,
            isSubmitted: historyMap.has(r.url) || false
        }));

        // PERSISTENCE: Save to deadlines.json for real-time local sync (Skip on Vercel/Read-only)
        if (!process.env.VERCEL) {
            try {
                const dataPath = path.join(process.cwd(), 'public', 'deadlines.json');
                fs.writeFileSync(dataPath, JSON.stringify(results, null, 2));
            } catch (e) {
                console.error('Failed to save persistence file:', e.message);
            }
        }

        await browser.close();
        return res.status(200).json(results);

    } catch (error) {
        if (browser) await browser.close();
        return res.status(500).json({ error: error.message });
    }
}
