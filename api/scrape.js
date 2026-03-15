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

        // 1. LOGIN
        await page.goto('https://kulino.dinus.ac.id/login/index.php', { waitUntil: 'commit', timeout: 6000 }).catch(() => null);
        await page.fill('#username', username);
        await page.fill('#password', password);
        await Promise.all([
            page.waitForURL('**/my/**', { timeout: 6000, waitUntil: 'commit' }).catch(() => null),
            page.click('#loginbtn'),
        ]);

        let resultsMap = new Map();

        // 2. URL normalization helper
        const normalizeUrl = (u) => {
            if (!u) return "";
            try {
                const urlObj = new URL(u);
                const id = urlObj.searchParams.get('id');
                return urlObj.origin + urlObj.pathname + (id ? `?id=${id}` : "");
            } catch (e) { return u.split('?')[0]; }
        };

        const mergeResults = (newItems) => {
            newItems.forEach(item => {
                if (!item || !item.url) return;
                const normUrl = normalizeUrl(item.url);
                item.url = normUrl;
                const existing = resultsMap.get(normUrl);
                if (existing) {
                    const merged = { ...existing, ...item };
                    if (!item.course && existing.course) merged.course = existing.course;
                    merged.isSubmitted = existing.isSubmitted || item.isSubmitted;
                    resultsMap.set(normUrl, merged);
                } else {
                    resultsMap.set(normUrl, item);
                }
            });
        };

        // 3. Get Course ID Map (Gathers names for data-courseid matches)
        let courseIdMap = {};
        const collectCourses = async () => {
            const found = await page.evaluate(() => {
                const map = {};
                document.querySelectorAll('a[href*="course/view.php?id="]').forEach(a => {
                    const id = new URL(a.href).searchParams.get('id');
                    let name = a.innerText.trim();
                    if (id && name && name.length > 5 && name !== 'Course') {
                        // Clean up name and prioritize [CODE] SUBJECT
                        if (!map[id] || name.includes('[')) {
                            map[id] = name.split('\n')[0].replace(/^Course:\s+/i, '').trim();
                        }
                    }
                });
                return map;
            });
            Object.assign(courseIdMap, found);
        };

        try {
            await page.goto('https://kulino.dinus.ac.id/my/', { waitUntil: 'domcontentloaded', timeout: 10000 });
            await collectCourses();
            await page.goto('https://kulino.dinus.ac.id/my/courses.php', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
            await collectCourses();
        } catch(e) {}

        // 4. Scraper Function for Month View
        const scrapeMonth = async (targetUrl) => {
            try {
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
                let items = await page.evaluate((cidMap) => {
                    const filter = ['tugas', 'praktikum', 'pratikum', 'assign', 'kuis', 'quiz', 'praktek', 'ujian', 'repositori', 'repository', 'proyek', 'project', 'forum', 'kegiatan', 'mahasiswa', 'student', 'activity', 'survey', 'kuesioner', 'materi', 'kuliah'];
                    const events = Array.from(document.querySelectorAll('a[data-action="view-event"]'));
                    
                    return events.map(ev => {
                        const rawTitle = ev.getAttribute('title') || '';
                        const url = ev.href;
                        const title = rawTitle.replace(/\s+is\s+due$/i, '').replace(/\s+opens$/i, '').trim();
                        if (!filter.some(f => title.toLowerCase().includes(f)) && !url.includes('assign') && !url.includes('quiz')) return null;

                        const dayCell = ev.closest('td.day');
                        const container = ev.closest('.calendar-event, .event') || ev.parentElement;
                        const indicatesDone = container.innerHTML.toLowerCase().includes('btn-success') || 
                                             container.innerHTML.toLowerCase().includes('badge-success') || 
                                             container.innerText.toLowerCase().includes('done') ||
                                             window.getComputedStyle(ev).opacity < 0.8;

                        let courseName = "";
                        const cid = ev.closest('[data-courseid]')?.getAttribute('data-courseid') || ev.closest('.event')?.getAttribute('data-course-id');
                        if (cid && cidMap[cid]) courseName = cidMap[cid];
                        
                        if (!courseName && rawTitle.includes(':')) {
                            const p = rawTitle.split(':');
                            if (p[0].includes('[') || p[0].includes('A11')) courseName = p[0].trim();
                        }
                        
                        if (!courseName && rawTitle.includes(' - ')) {
                            const p = rawTitle.split(' - ');
                            courseName = p[0].toLowerCase().includes(title.toLowerCase()) ? p[1].trim() : p[0].trim();
                        }

                        return {
                            id: ev.getAttribute('data-event-id'),
                            title, url, course: courseName,
                            deadlineTimestamp: dayCell ? parseInt(dayCell.getAttribute('data-day-timestamp')) * 1000 : null,
                            isSubmitted: indicatesDone,
                            type: url.includes('assign') ? 'assignment' : (url.includes('quiz') ? 'quiz' : 'activity'),
                            scrapedAt: new Date().toISOString()
                        };
                    }).filter(i => i);
                }, courseIdMap);

                // Deep Search Fallback
                for (const item of items) {
                    if (!item.course || item.course === "") {
                        try {
                            await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 5000 });
                            item.course = await page.evaluate(() => {
                                const b = document.querySelector('.breadcrumb-item:nth-last-child(3) a') || 
                                          document.querySelector('.breadcrumb-item:nth-child(3) a') ||
                                          document.querySelector('a[href*="course/view.php?id="]');
                                return b ? b.innerText.trim() : "";
                            });
                        } catch(e) {}
                    }
                }
                return items;
            } catch (e) { return []; }
        };

        // A. Upcoming View
        try {
            await page.goto('https://kulino.dinus.ac.id/calendar/view.php?view=upcoming', { waitUntil: 'domcontentloaded', timeout: 8000 });
            const upcoming = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('.eventlist .event')).map(ev => {
                    const titleLink = ev.querySelector('h3.name a') || ev.querySelector('a[href*="/mod/"]');
                    if (!titleLink) return null;
                    const title = titleLink.textContent.trim().replace(/\s+is\s+due$/i, '').replace(/\s+opens$/i, '').trim();
                    const url = titleLink.href;
                    const courseLink = ev.querySelector('a[href*="course/view.php?id="]');
                    const text = ev.innerText.toLowerCase();
                    const isDone = ev.innerHTML.toLowerCase().includes('btn-success') || 
                                  ev.innerHTML.toLowerCase().includes('badge-success') || 
                                  ((text.includes('submitted') || text.includes('done')) && !text.includes('mark as done'));

                    return {
                        id: ev.getAttribute('data-event-id') || url,
                        title, url,
                        course: courseLink ? courseLink.textContent.trim() : "",
                        isSubmitted: isDone,
                        type: url.includes('assign') ? 'assignment' : (url.includes('quiz') ? 'quiz' : 'activity'),
                        scrapedAt: new Date().toISOString()
                    };
                }).filter(i => i);
            });
            mergeResults(upcoming);
        } catch (e) {}

        // B. Month Views
        const currentMonthUrl = `https://kulino.dinus.ac.id/calendar/view.php?view=month`;
        mergeResults(await scrapeMonth(currentMonthUrl));

        try {
            const prevBtn = await page.$('a[data-action="change-month"][title*="previous"]'); 
            if (prevBtn) {
                const prevUrl = await prevBtn.evaluate(el => el.href);
                mergeResults(await scrapeMonth(prevUrl));
            }
        } catch (e) {}

        try {
            await page.goto(currentMonthUrl);
            const nextBtn = await page.$('a[data-action="change-month"][title*="next"]');
            if (nextBtn) {
                const nextUrl = await nextBtn.evaluate(el => el.href);
                mergeResults(await scrapeMonth(nextUrl));
            }
        } catch (e) {}

        // Final Sync and Persistence
        let finalResults = Array.from(resultsMap.values());
        try {
            const dataPath = path.join(process.cwd(), 'public', 'deadlines.json');
            if (fs.existsSync(dataPath)) {
                const history = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
                history.forEach(oldItem => {
                    const normUrl = normalizeUrl(oldItem.url);
                    const existing = resultsMap.get(normUrl);
                    if (!existing) {
                        oldItem.url = normUrl;
                        finalResults.push(oldItem);
                    } else {
                        if (oldItem.isSubmitted) existing.isSubmitted = true;
                        if (!existing.course && oldItem.course) existing.course = oldItem.course;
                    }
                });
            }
        } catch (e) {}

        if (!process.env.VERCEL) {
            try {
                const dataPath = path.join(process.cwd(), 'public', 'deadlines.json');
                fs.writeFileSync(dataPath, JSON.stringify(finalResults, null, 2));
            } catch (e) {}
        }

        await browser.close();
        return res.status(200).json(finalResults);

    } catch (error) {
        if (browser) await browser.close();
        return res.status(500).json({ error: error.message });
    }
}
