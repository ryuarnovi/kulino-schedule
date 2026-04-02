const { chromium } = require('playwright-core');
const chromiumPack = require('@sparticuz/chromium');
const path = require('path');
const fs = require('fs');

module.exports = async function handler(req, res) {
    const isForce = req.query.force === 'true';
    const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    const dataPath = path.join(process.cwd(), 'public', 'deadlines.json');
    let existingData = [];
    try {
        if (fs.existsSync(dataPath)) {
            existingData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
            const latest = existingData.reduce((max, t) => Math.max(max, new Date(t.scrapedAt || 0).getTime()), 0);
            if (!isForce && (Date.now() - latest < TWELVE_HOURS_MS)) {
                return res.status(200).json({ status: "cached", data: existingData });
            }
        }
    } catch (e) {}

    const username = process.env.KULINO_USERNAME;
    const password = process.env.KULINO_PASSWORD;
    if (!username || !password) return res.status(401).json({ error: 'Missing Credentials' });

    let browser;
    try {
        browser = await chromium.launch({
            args: [...chromiumPack.args, '--no-sandbox'],
            executablePath: await chromiumPack.executablePath(),
            headless: true,
        });
        const context = await browser.newContext({ userAgent: 'Mozilla/5.0' });
        await context.route('**/*.{png,jpg,css,woff2}', route => route.abort());
        const page = await context.newPage();

        // 1. LOGIN
        console.log("🔑 Logging in...");
        await page.goto('https://kulino.dinus.ac.id/login/index.php', { waitUntil: 'domcontentloaded' });
        await page.fill('#username', username);
        await page.fill('#password', password);
        await page.click('#loginbtn');
        await page.waitForURL('**/my/**', { timeout: 15000 });

        // 2. GET COURSE LIST
        console.log("📚 Getting course list...");
        const courses = await page.evaluate(() => {
            const list = [];
            document.querySelectorAll('a[href*="course/view.php?id="]').forEach(a => {
                const url = a.href.split('&')[0];
                const name = a.innerText.trim();
                const isMBKM = name.toUpperCase().includes('MBKM');
                
                if (name && !list.some(c => c.url === url) && !name.includes('Summary') && !isMBKM) {
                    list.push({ name, url });
                }
            });
            return list.slice(0, 10);
        });

        const allTasksMap = new Map();

        // 3. DEEP CRAWL EACH COURSE
        const scrapeCourse = async (course) => {
            const cp = await context.newPage();
            try {
                await cp.goto(course.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
                const tasks = await cp.evaluate((courseInfo) => {
                    const found = [];
                    // Cari forum, assign, quiz
                    const selectors = '.activity.assign, .activity.quiz, .activity.forum, .activity.lti, .modtype_assign, .modtype_forum, .modtype_quiz';
                    document.querySelectorAll(selectors).forEach(el => {
                        const link = el.querySelector('a');
                        if (!link) return;
                        
                        const title = link.innerText.replace('Assignment', '').replace('Forum', '').trim();
                        const url = link.href;
                        
                        // Deteksi Centang Selesai (Moodle 4.x)
                        const isDone = !!el.querySelector('.badge-success, [data-region="completion-toggle"].btn-success, .completion-auto-pass, [aria-label*="Done"], [aria-label*="Selesai"]');
                        
                        found.push({
                            id: url.split('id=')[1],
                            title,
                            url,
                            course: courseInfo.name,
                            isSubmitted: isDone,
                            type: url.includes('forum') ? 'forum' : (url.includes('quiz') ? 'quiz' : 'assignment'),
                            scrapedAt: new Date().toISOString()
                        });
                    });
                    return found;
                }, course);
                tasks.forEach(t => allTasksMap.set(t.url, t));
            } catch (e) { console.error(`Error scraping ${course.name}:`, e.message); }
            finally { await cp.close(); }
        };

        // Run in chunks of 3 courses
        for (let i = 0; i < courses.length; i += 3) {
            await Promise.all(courses.slice(i, i + 3).map(c => scrapeCourse(c)));
        }

        await browser.close();
        const results = Array.from(allTasksMap.values());
        console.log(`✨ Deep Scrape Success: ${results.length} tasks found.`);
        return res.status(200).json(results);

    } catch (error) { if (browser) await browser.close(); return res.status(500).json({ error: error.message }); }
}
