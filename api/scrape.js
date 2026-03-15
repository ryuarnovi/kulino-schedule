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
                const existing = resultsMap.get(item.url);
                if (existing) {
                    // Update existing with new data, but keep isSubmitted if already true
                    resultsMap.set(item.url, { 
                        ...existing, 
                        ...item, 
                        isSubmitted: existing.isSubmitted || item.isSubmitted 
                    });
                } else {
                    resultsMap.set(item.url, item);
                }
            });
        };

        // Utility to scrape a month view
        const scrapeMonth = async (targetUrl) => {
            try {
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
                return await page.evaluate(() => {
                    const filter = ['tugas', 'praktikum', 'pratikum', 'assign', 'kuis', 'quiz', 'praktek', 'ujian', 'repositori', 'repository', 'proyek', 'project', 'forum', 'kegiatan', 'mahasiswa', 'student', 'activity', 'survey', 'kuesioner', 'materi', 'kuliah'];
                    const events = Array.from(document.querySelectorAll('a[data-action="view-event"]'));
                    return events.map(ev => {
                        const rawTitle = ev.getAttribute('title') || '';
                        const url = ev.href;
                        const title = rawTitle.replace(' is due', '').replace(' opens', '').trim();
                        
                        // Clean URL for unique key
                        let cleanUrl = url.split('?')[0];
                        if (url.includes('id=')) {
                            const idMatch = url.match(/id=(\d+)/);
                            if (idMatch) cleanUrl += '?id=' + idMatch[1];
                        }

                        const isTask = filter.some(f => title.toLowerCase().includes(f)) || url.includes('assign') || url.includes('quiz') || url.includes('forum');
                        if (!isTask) return null;

                        const parentDay = ev.closest('td.day');
                        const timestamp = parentDay ? parseInt(parentDay.getAttribute('data-day-timestamp')) * 1000 : null;
                        
                        // MOODLE 4+ COMPLETION DETECTION (Deep Scan in Container)
                        const container = ev.closest('.calendar-event, .event') || ev.parentElement;
                        const hasGreenIndicator = !!container.querySelector('.btn-success, .badge-success, .btn-outline-success.active, .completionicon[title*="Done"], .icon[title*="Done"]');
                        const isDimmed = window.getComputedStyle(ev).opacity < 0.8;
                        const isSubmitted = hasGreenIndicator || isDimmed || container.innerText.toLowerCase().includes('done') || container.innerText.toLowerCase().includes('selesai');

                        let courseName = "";
                        if (rawTitle.includes(':')) {
                            courseName = rawTitle.split(':')[0].trim();
                        } else if (rawTitle.includes(' - ')) {
                            courseName = rawTitle.split(' - ')[0].trim();
                        }

                        return {
                            id: ev.getAttribute('data-event-id'),
                            title, 
                            url: cleanUrl,
                            course: courseName,
                            deadlineTimestamp: timestamp,
                            isSubmitted: isSubmitted,
                            type: url.includes('assign') ? 'assignment' : (url.includes('quiz') ? 'quiz' : (url.includes('forum') ? 'forum' : 'activity')),
                            scrapedAt: new Date().toISOString()
                        };
                    }).filter(i => i);
                });
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
                    const rawContent = ev.innerText.toLowerCase();
                    const rawHtml = ev.innerHTML.toLowerCase();
                    
                    // Comprehensive Check for Moodle 4 "Done" status
                    const isSubmitted = rawContent.includes('submitted') || 
                                      rawContent.includes('terselesaikan') || 
                                      rawContent.includes('sudah dikumpulkan') ||
                                      rawContent.includes('done') ||
                                      rawContent.includes('complete') ||
                                      rawContent.includes('mark as done') ||
                                      rawHtml.includes('btn-success') ||
                                      rawHtml.includes('badge-success') ||
                                      rawHtml.includes('btn-outline-success active') ||
                                      !!ev.querySelector('.btn-success, .badge-success, .icon[title*="Done"]');

                    return {
                        id: ev.getAttribute('data-event-id') || url,
                        title, url,
                        course: courseLink ? courseLink.textContent.trim() : "",
                        isSubmitted: isSubmitted,
                        type: url.includes('assign') ? 'assignment' : (url.includes('quiz') ? 'quiz' : 'activity'),
                        scrapedAt: new Date().toISOString()
                    };
                }).filter(i => i);
            });
            mergeResults(upcoming);
        } catch (e) {}

        // B. Get Current, Previous and Next Month for comprehensive history/future
        const now = new Date();
        const currentMonthUrl = `https://kulino.dinus.ac.id/calendar/view.php?view=month&course=1`;
        
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
                    const existing = resultsMap.get(oldItem.url);
                    if (!existing) {
                        finalResults.push(oldItem);
                    } else {
                        // Priority: If either history or current scrape says it's done, it's DONE
                        if (oldItem.isSubmitted) {
                            existing.isSubmitted = true;
                        }
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
