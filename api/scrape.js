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
                    // PRESERVE Real Course Name: Only overwrite if item.course is non-empty AND not General
                    const isNewCourseValid = item.course && item.course !== "" && item.course !== "GENERAL_ARCHIVE";
                    const isExistingCourseValid = existing.course && existing.course !== "" && existing.course !== "GENERAL_ARCHIVE";
                    
                    if (!isNewCourseValid && isExistingCourseValid) {
                        merged.course = existing.course;
                    }
                    
                    merged.isSubmitted = existing.isSubmitted || item.isSubmitted;
                    resultsMap.set(normUrl, merged);
                } else {
                    resultsMap.set(normUrl, item);
                }
            });
        };

        // 3. Get Course ID Map (Aggressive Search across multiple entry points)
        let courseIdMap = {};
        const collectCourses = async () => {
            const found = await page.evaluate(() => {
                const map = {};
                // Scan all links that point to a course
                document.querySelectorAll('a[href*="course/view.php?id="]').forEach(a => {
                    const id = new URL(a.href).searchParams.get('id');
                    let name = a.innerText.trim();
                    if (id && name && name.length > 3 && name.toLowerCase() !== 'course') {
                        // Clean name: remove "Course", "Mata Kuliah", and extra whitespace/newlines
                        name = name.split('\n')[0].replace(/^(Course|Mata Kuliah|Matkul):\s+/i, '').trim();
                        // Priority to names with brackets [202xx]
                        if (!map[id] || (name.includes('[') && !map[id].includes('['))) {
                            map[id] = name;
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
            // Try Grades page which is a list of ALL enrolled courses
            await page.goto('https://kulino.dinus.ac.id/grade/report/overview/index.php', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
            await collectCourses();
            // Try the 'all' view
            await page.goto('https://kulino.dinus.ac.id/my/courses.php?display=all', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
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
                        // Try data-courseid from calendar
                        const cid = ev.closest('[data-courseid]')?.getAttribute('data-courseid') || ev.closest('.event')?.getAttribute('data-course-id');
                        if (cid && cidMap[cid]) courseName = cidMap[cid];
                        
                        // Try title parsing "[COURSE] Task" or "Course: Task"
                        if (!courseName && rawTitle.includes(':')) {
                            const p = rawTitle.split(':');
                            if (p[0].includes('[') || p[0].includes('A11')) courseName = p[0].trim();
                        }
                        
                        return {
                            id: ev.getAttribute('data-event-id'),
                            title, url, course: courseName, cid,
                            deadlineTimestamp: dayCell ? parseInt(dayCell.getAttribute('data-day-timestamp')) * 1000 : null,
                            isSubmitted: indicatesDone,
                            type: url.includes('assign') ? 'assignment' : (url.includes('quiz') ? 'quiz' : 'activity'),
                            scrapedAt: new Date().toISOString()
                        };
                    }).filter(i => i);
                }, courseIdMap);

                // DEEP SEARCH: If still missing course, visit the activity page to find its course
                // We focus on items with MISSING course names
                const missing = items.filter(i => !i.course || i.course === "" || i.course === "GENERAL_ARCHIVE");
                for (const item of missing) {
                    try {
                        // Go to activity detail page
                        await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 5000 });
                        
                        const detailInfo = await page.evaluate(() => {
                            // 1. Breadcrumb (Home > Course Name > ...)
                            const bread = document.querySelectorAll('.breadcrumb-item a');
                            if (bread.length >= 3) return bread[2].innerText.trim();
                            
                            // 2. Specific Course Link in page (often in sidebars)
                            const cLink = document.querySelector('a[href*="course/view.php?id="]');
                            if (cLink && cLink.innerText.length > 5) return cLink.innerText.trim();
                            
                            // 3. Page Title (often contains Course Name)
                            const h1 = document.querySelector('h1');
                            if (h1 && h1.innerText.includes('[')) return h1.innerText.trim();
                            
                            return "";
                        });
                        
                        if (detailInfo && detailInfo.length > 3) {
                            item.course = detailInfo.split('\n')[0].replace(/^(Course|Mata Kuliah):\s+/i, '').trim();
                        }
                    } catch(e) {}
                }
                return items;
            } catch (e) { return []; }
        };

        // A. Upcoming View
        try {
            await page.goto('https://kulino.dinus.ac.id/calendar/view.php?view=upcoming', { waitUntil: 'domcontentloaded', timeout: 8000 });
            const upcomingRaw = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('.eventlist .event')).map(ev => {
                    const titleLink = ev.querySelector('h3.name a') || ev.querySelector('a[href*="/mod/"]');
                    if (!titleLink) return null;
                    const url = titleLink.href;
                    const courseLink = ev.querySelector('a[href*="course/view.php?id="]');
                    const cid = courseLink ? new URL(courseLink.href).searchParams.get('id') : null;
                    const text = ev.innerText.toLowerCase();
                    const isDone = ev.innerHTML.toLowerCase().includes('btn-success') || 
                                  ev.innerHTML.toLowerCase().includes('badge-success') || 
                                  ((text.includes('submitted') || text.includes('done')) && !text.includes('mark as done'));

                    return {
                        id: ev.getAttribute('data-event-id') || url,
                        title: titleLink.textContent.trim().replace(/\s+is\s+due$/i, '').trim(),
                        url, cid,
                        isSubmitted: isDone,
                        type: url.includes('assign') ? 'assignment' : (url.includes('quiz') ? 'quiz' : 'activity'),
                        scrapedAt: new Date().toISOString()
                    };
                }).filter(i => i);
            });
            
            // Map cid to names using our courseIdMap
            const upcoming = upcomingRaw.map(item => {
                let name = "";
                if (item.cid && courseIdMap[item.cid]) name = courseIdMap[item.cid];
                return { ...item, course: name };
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
        
        // Final Fixer: For any item still in General Archive, try to find its course from history or deep scan
        finalResults.forEach(item => {
            if (!item.course || item.course === "" || item.course === "GENERAL_ARCHIVE") {
                // Check if we can find it in courseIdMap (if we have its CID)
                if (item.cid && courseIdMap[item.cid]) {
                    item.course = courseIdMap[item.cid];
                }
            }
        });

        try {
            const dataPath = path.join(process.cwd(), 'public', 'deadlines.json');
            if (fs.existsSync(dataPath)) {
                const history = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
                history.forEach(oldItem => {
                    const normUrl = normalizeUrl(oldItem.url);
                    const existingFound = finalResults.find(f => f.url === normUrl);
                    
                    if (!existingFound) {
                        oldItem.url = normUrl;
                        finalResults.push(oldItem);
                    } else {
                        // Priority: DONE stays DONE
                        if (oldItem.isSubmitted) existingFound.isSubmitted = true;
                        // Priority: Real course name stays, don't overwrite with General
                        if ((!existingFound.course || existingFound.course === "GENERAL_ARCHIVE") && (oldItem.course && oldItem.course !== "GENERAL_ARCHIVE")) {
                            existingFound.course = oldItem.course;
                        }
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
