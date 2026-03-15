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

        // 2. SCRAPE CALENDAR (Ultra Comprehensive: Previous, Current, Next Month + Upcoming)
        let resultsMap = new Map();
        
        // Populate resultsMap with existing history first to preserve old data
        historyMap.forEach((isDone, url) => {
            // We don't have the full object here, so we will update it if found during scrape
            // For now, we'll keep it as a placeholder or wait for merge
        });

        const mergeResults = (newItems) => {
            newItems.forEach(item => {
                if (!item || !item.url) return;
                const normUrl = normalizeUrl(item.url);
                item.url = normUrl;
                const existing = resultsMap.get(normUrl);
                if (existing) {
                    resultsMap.set(normUrl, { 
                        ...existing, 
                        ...item, 
                        isSubmitted: existing.isSubmitted || item.isSubmitted 
                    });
                } else {
                    resultsMap.set(normUrl, item);
                }
            });
        };

        // URL normalization helper
        const normalizeUrl = (u) => {
            if (!u) return "";
            try {
                const urlObj = new URL(u);
                const id = urlObj.searchParams.get('id');
                return urlObj.origin + urlObj.pathname + (id ? `?id=${id}` : "");
            } catch (e) { return u.split('?')[0]; }
        };

        // 1. Get Course ID Map from Dashboard (Higher reliability)
        let courseIdMap = {};
        try {
            await page.goto('https://kulino.dinus.ac.id/my/', { waitUntil: 'domcontentloaded', timeout: 10000 });
            courseIdMap = await page.evaluate(() => {
                const map = {};
                // Look for course cards or sidebar links
                const selectors = ['a[href*="course/view.php?id="]', '.course-listitem a', '.course-card a'];
                selectors.forEach(s => {
                    document.querySelectorAll(s).forEach(a => {
                        const url = a.href;
                        const id = new URL(url).searchParams.get('id');
                        let name = a.innerText.trim();
                        // Clean up name (remove 'Course' prefix or similar)
                        name = name.split('\n')[0].replace(/^Course:\s+/i, '').trim();
                        if (id && name && name.length > 5) map[id] = name;
                    });
                });
                return map;
            });
        } catch(e) {}

        // Utility to scrape a month view
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
                        
                        const isTask = filter.some(f => title.toLowerCase().includes(f)) || url.includes('assign') || url.includes('quiz') || url.includes('forum');
                        if (!isTask) return null;

                        const dayCell = ev.closest('td.day');
                        const container = ev.closest('.calendar-event') || ev.closest('.event') || ev.parentElement;
                        const containerHtml = container.innerHTML.toLowerCase();
                        const containerText = container.innerText.toLowerCase();
                        
                        const indicatesDone = containerHtml.includes('btn-success') || 
                                             containerHtml.includes('badge-success') || 
                                             containerHtml.includes('completionicon') ||
                                             containerHtml.includes('fa-check') ||
                                             (containerText.includes('done') && !containerText.includes('mark as done')) ||
                                             containerText.includes('selesai') ||
                                             window.getComputedStyle(ev).opacity < 0.8;

                        // ROBUST COURSE NAME EXTRACTION
                        let courseName = "";
                        const cid = ev.closest('[data-courseid]')?.getAttribute('data-courseid');
                        if (cid && cidMap[cid]) courseName = cidMap[cid];
                        
                        // Fallback to title parsing
                        if (!courseName && rawTitle.includes(':')) {
                            const p = rawTitle.split(':');
                            courseName = p[0].trim();
                            if (courseName.toLowerCase() === title.toLowerCase()) courseName = "";
                        }
                        
                        if (!courseName && rawTitle.includes(' - ')) {
                            courseName = rawTitle.split(' - ')[0].trim();
                        }

                        return {
                            id: ev.getAttribute('data-event-id'),
                            title, url,
                            course: courseName,
                            deadlineTimestamp: dayCell ? parseInt(dayCell.getAttribute('data-day-timestamp')) * 1000 : null,
                            isSubmitted: indicatesDone,
                            type: url.includes('assign') ? 'assignment' : (url.includes('quiz') ? 'quiz' : (url.includes('forum') ? 'forum' : 'activity')),
                            scrapedAt: new Date().toISOString()
                        };
                    }).filter(i => i);
                }, courseIdMap);

                // Deep Scan Fallback for items with missing course names (Limit to 5 to avoid timeout)
                const missing = items.filter(i => !i.course).slice(0, 5);
                for (const item of missing) {
                    try {
                        await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 5000 });
                        const breadcrumb = await page.evaluate(() => {
                            const b = document.querySelector('.breadcrumb-item:nth-last-child(3) a') || 
                                      document.querySelector('.breadcrumb-item:nth-child(3) a') ||
                                      document.querySelector('a[href*="course/view.php?id="]');
                            return b ? b.innerText.trim() : "";
                        });
                        if (breadcrumb && breadcrumb.length > 5) item.course = breadcrumb;
                    } catch(e) {}
                }

                return items;
            } catch (e) { return []; }
        };

        // A. Upcoming View (Check for explicit Moodle 4 status indicators)
        try {
            await page.goto('https://kulino.dinus.ac.id/calendar/view.php?view=upcoming', { waitUntil: 'domcontentloaded', timeout: 8000 });
            const upcoming = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('.eventlist .event')).map(ev => {
                    const titleLink = ev.querySelector('h3.name a') || ev.querySelector('a[href*="/mod/"]');
                    if (!titleLink) return null;
                    const title = titleLink.textContent.trim().replace(/\s+is\s+due$/i, '').replace(/\s+opens$/i, '').trim();
                    const url = titleLink.href;
                    
                    const courseLink = ev.querySelector('a[href*="course/view.php?id="]');
                    const html = ev.innerHTML.toLowerCase();
                    const text = ev.innerText.toLowerCase();
                    
                    const isDone = html.includes('btn-success') || 
                                  html.includes('badge-success') || 
                                  html.includes('btn-outline-success active') ||
                                  ((text.includes('submitted') || text.includes('terselesaikan') || text.includes('done') || text.includes('complete')) && !text.includes('mark as done'));

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
            
            // Normalize URLs for consistent mapping
            upcoming.forEach(item => item.url = normalizeUrl(item.url));
            mergeResults(upcoming);
        } catch (e) {}

        // B. Get Current, Previous and Next Month for comprehensive history/future
        const now = new Date();
        const currentMonthUrl = `https://kulino.dinus.ac.id/calendar/view.php?view=month`;
        
        // Scrape Current Month
        const currentItems = await scrapeMonth(currentMonthUrl);
        mergeResults(currentItems);

        // Try Previous Month
        try {
            const prevBtn = await page.$('a[data-action="change-month"][title*="previous"], a[href*="time="]'); 
            if (prevBtn) {
                const prevUrl = await prevBtn.evaluate(el => el.href);
                const prevItems = await scrapeMonth(prevUrl);
                mergeResults(prevItems);
            }
        } catch (e) {}

        // Try Next Month
        try {
            await page.goto(currentMonthUrl); // Go back to current
            const nextBtn = await page.$('a[data-action="change-month"][title*="next"]');
            if (nextBtn) {
                const nextUrl = await nextBtn.evaluate(el => el.href);
                const nextItems = await scrapeMonth(nextUrl);
                mergeResults(nextItems);
            }
        } catch (e) {}

        // Final Sync with History (Preserve items that weren't found in current scrape but exist in history)
        let finalResults = Array.from(resultsMap.values());
        
        try {
            const dataPath = path.join(process.cwd(), 'public', 'deadlines.json');
            if (fs.existsSync(dataPath)) {
                const history = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
                history.forEach(oldItem => {
                    const normUrl = normalizeUrl(oldItem.url);
                    const existing = resultsMap.get(normUrl);
                    if (!existing) {
                        oldItem.url = normUrl; // Ensure normalized
                        finalResults.push(oldItem);
                    } else {
                        // Priority: If either history or current scrape says it's done, it's DONE
                        if (oldItem.isSubmitted) existing.isSubmitted = true;
                        // Preserve course name if current scrape missed it
                        if (!existing.course && oldItem.course) existing.course = oldItem.course;
                    }
                });
            }
        } catch (e) {}

        // PERSISTENCE: Save to deadlines.json for real-time local sync (Skip on Vercel/Read-only)
        if (!process.env.VERCEL) {
            try {
                const dataPath = path.join(process.cwd(), 'public', 'deadlines.json');
                fs.writeFileSync(dataPath, JSON.stringify(finalResults, null, 2));
            } catch (e) {
                console.error('Failed to save persistence file:', e.message);
            }
        }

        await browser.close();
        return res.status(200).json(finalResults);

    } catch (error) {
        if (browser) await browser.close();
        return res.status(500).json({ error: error.message });
    }
}
