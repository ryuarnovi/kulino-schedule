const { chromium } = require('playwright-core');
const chromiumPack = require('@sparticuz/chromium');
const path = require('path');
const fs = require('fs');

// Suppress DEP0169: url.parse() deprecation warning from dependencies in Vercel logs
process.off('warning', process.listeners('warning')[0]); // Optional: clear existing if needed
process.on('warning', (warning) => {
    if (warning.name === 'DeprecationWarning' && warning.code === 'DEP0169') return;
    console.warn(warning);
});

module.exports = async function handler(req, res) {
    const isForce = req.query.force === 'true';
    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    const dataPath = path.join(process.cwd(), 'public', 'deadlines.json');
    let existingData = [];
    try {
        if (fs.existsSync(dataPath)) {
            existingData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
            const latest = existingData.reduce((max, t) => Math.max(max, new Date(t.scrapedAt || 0).getTime()), 0);
            if (!isForce && (Date.now() - latest < FOUR_HOURS_MS)) {
                return res.status(200).json({ status: "cached", data: existingData });
            }
        }
    } catch (e) {}

    // 1. Verifikasi PIN Dashboard (Hanya lewat ENV untuk Keamanan)
    const pin = req.body?.pin || req.query.pin;
    const correctPin = process.env.DASHBOARD_PIN;

    if (!pin || pin !== correctPin) {
        return res.status(401).json({ error: 'INVALID_DASHBOARD_PIN' });
    }

    // 2. Gunakan Kredensial Kulino dari ENV (Otomatis)
    const username = process.env.KULINO_USERNAME;
    const password = process.env.KULINO_PASSWORD;

    if (!username || !password) {
        return res.status(500).json({ error: 'SYSTEM_CONFIG_ERROR: KULINO_CREDENTIALS_MISSING' });
    }

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

        await page.goto('https://kulino.dinus.ac.id/login/index.php', { waitUntil: 'domcontentloaded' });
        await page.fill('#username', username);
        await page.fill('#password', password);
        await page.click('#loginbtn');
        await page.waitForURL('**/my/**', { timeout: 15000 });

        const courses = await page.evaluate(() => {
            const list = [];
            document.querySelectorAll('a[href*="course/view.php?id="]').forEach(a => {
                const url = a.href.split('&')[0];
                const name = a.innerText.trim();
                const isMBKM = name.toUpperCase().includes('MBKM');
                if (name && !list.some(c => c.url === url) && !name.includes('Summary') && !isMBKM && name.length > 5) {
                    list.push({ name, url });
                }
            });
            return list.slice(0, 15); // Ambil 15 matkul teratas
        });

        const allTasks = [];

        const scrapeCourse = async (course) => {
            const cp = await context.newPage();
            try {
                await cp.goto(course.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
                const tasks = await cp.evaluate((courseInfo) => {
                    const found = [];
                    const selectors = '.activity.assign, .activity.quiz, .activity.forum, .activity.lti, .modtype_assign, .modtype_forum, .modtype_quiz';
                    const elements = document.querySelectorAll(selectors);
                    
                    if (elements.length === 0) {
                        // Jika kosong, masukkan placeholder agar kode matkul tetap muncul
                        found.push({
                            id: 'empty-' + courseInfo.url.split('id=')[1],
                            title: 'NO_ACTIVE_TASKS_FOUND',
                            url: courseInfo.url,
                            course: courseInfo.name,
                            isSubmitted: true,
                            type: 'placeholder',
                            scrapedAt: new Date().toISOString()
                        });
                    } else {
                        elements.forEach(el => {
                            const link = el.querySelector('a');
                            if (!link) return;
                            const title = link.innerText.replace('Assignment', '').replace('Forum', '').trim();
                            const url = link.href;
                            const isDone = !!el.querySelector('.badge-success, [data-region="completion-toggle"].btn-success, .completion-auto-pass, [aria-label*="Done"], [aria-label*="Selesai"], .completionbutton.btn-success');
                            const isManualCheck = !!el.querySelector('img[src*="i/completion-manual-y"], img[src*="i/completion-auto-y"]');

                            found.push({
                                id: url.split('id=')[1],
                                title, url,
                                course: courseInfo.name,
                                isSubmitted: isDone || isManualCheck,
                                type: url.includes('forum') ? 'forum' : (url.includes('quiz') ? 'quiz' : 'assignment'),
                                scrapedAt: new Date().toISOString()
                            });
                        });
                    }
                    return found;
                }, course);
                allTasks.push(...tasks);
            } catch (e) { 
                // Tetap masukkan kursus meskipun gagal dibuka (error handling)
                allTasks.push({ id: 'err-' + course.url.split('id=')[1], title: 'ACCESS_ERROR', course: course.name, isSubmitted: true, type: 'placeholder', url: course.url });
            }
            finally { await cp.close(); }
        };

        for (let i = 0; i < courses.length; i += 3) {
            await Promise.all(courses.slice(i, i + 3).map(c => scrapeCourse(c)));
        }

        await browser.close();
        return res.status(200).json(allTasks);

    } catch (error) { if (browser) await browser.close(); return res.status(500).json({ error: error.message }); }
}
