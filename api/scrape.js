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

        // 2. SCRAPE CALENDAR (Enhanced: Scrape Both Views for Completeness)
        let resultsMap = new Map();

        // Function to merge results
        const mergeResults = (newItems) => {
            newItems.forEach(item => {
                if (item && item.url) {
                    // If already exists, keep the one with a deadline if available
                    if (resultsMap.has(item.url)) {
                        const existing = resultsMap.get(item.url);
                        if (!existing.deadlineTimestamp && item.deadlineTimestamp) {
                            resultsMap.set(item.url, { ...existing, ...item });
                        }
                    } else {
                        resultsMap.set(item.url, item);
                    }
                }
            });
        };

        // A. Upcoming View
        try {
            await page.goto('https://kulino.dinus.ac.id/calendar/view.php?view=upcoming', { waitUntil: 'domcontentloaded', timeout: 8000 });
            const upcoming = await page.evaluate(() => {
                const filter = ['tugas', 'praktikum', 'pratikum', 'assign', 'kuis', 'quiz', 'praktek', 'ujian', 'repositori', 'repository', 'proyek', 'project', 'forum', 'kegiatan', 'mahasiswa', 'student', 'activity', 'survey', 'kuesioner'];
                return Array.from(document.querySelectorAll('.eventlist .event')).map(ev => {
                    const titleLink = ev.querySelector('h3.name a') || ev.querySelector('a[href*="/mod/"]');
                    if (!titleLink) return null;
                    const title = titleLink.textContent.trim().replace(/\s+is\s+due$/i, '').replace(/\s+opens$/i, '').trim();
                    const url = titleLink.href;
                    if (!filter.some(f => title.toLowerCase().includes(f)) && !url.includes('assign') && !url.includes('quiz') && !url.includes('forum')) return null;
                    const courseLink = ev.querySelector('a[href*="course/view.php?id="]');
                    return {
                        id: ev.getAttribute('data-event-id') || url,
                        title, url,
                        course: courseLink ? courseLink.textContent.trim() : "",
                        type: url.includes('assign') ? 'assignment' : (url.includes('quiz') ? 'quiz' : 'activity'),
                        scrapedAt: new Date().toISOString()
                    };
                }).filter(i => i);
            });
            mergeResults(upcoming);
        } catch (e) {
            console.error('Upcoming scrape failed:', e.message);
        }

        // B. Month View (Usually more comprehensive)
        try {
            await page.goto('https://kulino.dinus.ac.id/calendar/view.php?view=month', { waitUntil: 'domcontentloaded', timeout: 8000 });
            const monthItems = await page.evaluate(() => {
                const filter = ['tugas', 'praktikum', 'pratikum', 'assign', 'kuis', 'quiz', 'praktek', 'ujian', 'repositori', 'repository', 'proyek', 'project', 'forum', 'kegiatan', 'mahasiswa', 'student', 'activity', 'survey', 'kuesioner'];
                const events = Array.from(document.querySelectorAll('a[data-action="view-event"]'));
                return events.map(ev => {
                    const rawTitle = ev.getAttribute('title') || '';
                    const url = ev.href;
                    const title = rawTitle.replace(' is due', '').replace(' opens', '').trim();
                    if (!filter.some(f => title.toLowerCase().includes(f)) && !url.includes('assign') && !url.includes('quiz') && !url.includes('forum')) return null;
                    const parentDay = ev.closest('td.day');
                    const timestamp = parentDay ? parseInt(parentDay.getAttribute('data-day-timestamp')) * 1000 : null;
                    let courseName = rawTitle.includes(':') ? rawTitle.split(':')[0].trim() : "";
                    return {
                        id: ev.getAttribute('data-event-id'),
                        title, url,
                        course: courseName,
                        deadlineTimestamp: timestamp,
                        type: url.includes('assign') ? 'assignment' : (url.includes('quiz') ? 'quiz' : 'activity'),
                        scrapedAt: new Date().toISOString()
                    };
                }).filter(i => i);
            });
            mergeResults(monthItems);
        } catch (e) {
            console.error('Month scrape failed:', e.message);
        }

        let results = Array.from(resultsMap.values());

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
