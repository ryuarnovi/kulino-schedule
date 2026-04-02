const { chromium } = require('playwright-core');
const chromiumPack = require('@sparticuz/chromium');
const path = require('path');
const fs = require('fs');

module.exports = async function handler(req, res) {
    const startTime = Date.now();
    const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
    const isForce = req.query.force === 'true';

    console.log("🚀 Serverless function started...");
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

    // 1. Cek Caching 12 Jam
    const dataPath = path.join(process.cwd(), 'public', 'deadlines.json');
    let existingData = [];
    let lastScrapeTime = 0;

    try {
        if (fs.existsSync(dataPath)) {
            existingData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
            // Cari timestamp scrape terakhir dari data yang ada
            if (existingData.length > 0) {
                const latestScrape = existingData.reduce((max, task) => {
                    const time = task.scrapedAt ? new Date(task.scrapedAt).getTime() : 0;
                    return time > max ? time : max;
                }, 0);
                lastScrapeTime = latestScrape;
            }
        }
    } catch (e) {
        console.warn("⚠️ Gagal membaca cache:", e.message);
    }

    // Jika belum 12 jam dan tidak dipaksa force, kembalikan data lama
    if (!isForce && (Date.now() - lastScrapeTime < TWELVE_HOURS_MS)) {
        console.log(`♻️ Menggunakan cache (Terakhir scrape: ${new Date(lastScrapeTime).toLocaleString()})`);
        return res.status(200).json({
            status: "cached",
            lastScrape: new Date(lastScrapeTime).toISOString(),
            data: existingData
        });
    }

    // 2. Jalankan Scraper (Hanya jika cache kadaluarsa)
    const username = process.env.KULINO_USERNAME;
    const password = process.env.KULINO_PASSWORD;

    if (!username || !password) return res.status(401).json({ error: 'Missing Credentials' });

    let browser;
    try {
        console.log("🔑 Cache kadaluarsa atau Force, memulai login...");
        browser = await chromium.launch({
            args: [...chromiumPack.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--block-new-web-contents'],
            executablePath: await chromiumPack.executablePath(),
            headless: true,
        });
        
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 }
        });
        
        await context.route('**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2,ico}', route => route.abort());
        const page = await context.newPage();

        await page.goto('https://kulino.dinus.ac.id/login/index.php', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.fill('#username', username);
        await page.fill('#password', password);
        await Promise.all([
            page.waitForURL('**/my/**', { timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => null),
            page.click('#loginbtn'),
        ]);

        // ... (Logika scraping tetap sama dengan versi paralel yang sudah dioptimasi) ...
        const currentMonthUrl = `https://kulino.dinus.ac.id/calendar/view.php?view=month`;
        await page.goto(currentMonthUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        
        const tasksToScrape = await page.evaluate(() => {
            const results = [];
            const filter = ['tugas', 'praktikum', 'pratikum', 'assign', 'kuis', 'quiz', 'praktek', 'ujian', 'repositori', 'repository', 'proyek', 'project', 'forum', 'kegiatan', 'mahasiswa', 'student', 'activity', 'survey', 'kuesioner'];
            const events = Array.from(document.querySelectorAll('a[data-action="view-event"]'));
            events.forEach(ev => {
                const rawTitle = ev.getAttribute('title') || '';
                const url = ev.href;
                const title = rawTitle.replace(/\s+is\s+due$/i, '').replace(/\s+opens$/i, '').trim();
                if (filter.some(f => title.toLowerCase().includes(f)) || url.includes('assign') || url.includes('quiz')) {
                    const dayCell = ev.closest('td.day');
                    results.push({
                        id: ev.getAttribute('data-event-id'),
                        title, url,
                        deadlineTimestamp: dayCell ? parseInt(dayCell.getAttribute('data-day-timestamp')) * 1000 : null
                    });
                }
            });
            return results;
        });

        const CONCURRENCY_LIMIT = 3; 
        const results = [];

        const scrapeTask = async (task) => {
            const taskPage = await context.newPage();
            try {
                await taskPage.route('**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2,ico}', route => route.abort());
                await taskPage.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 10000 });
                const btn = await taskPage.$('a.btn-primary[href*="mod/"]');
                if (btn) {
                    const activityLink = await btn.getAttribute('href');
                    await taskPage.goto(activityLink, { waitUntil: 'domcontentloaded', timeout: 8000 });
                }

                const detail = await taskPage.evaluate(() => {
                    let deadline = '', isSubmitted = false, courseName = '', description = document.querySelector('#intro .no-overflow')?.textContent?.trim() || '';
                    const bread = document.querySelectorAll('.breadcrumb-item a');
                    if (bread.length >= 3) courseName = bread[2].innerText.trim();
                    const dateDivs = document.querySelectorAll('[data-region="activity-dates"] > div');
                    dateDivs.forEach(div => {
                        const txt = div.textContent.trim();
                        if (txt.includes('Due:') || txt.includes('Closes:')) deadline = txt.replace(/Due:|Closes:/, '').trim();
                    });
                    const rows = document.querySelectorAll('.submissionstatustable tr');
                    rows.forEach(row => {
                        const th = row.querySelector('th')?.innerText.toLowerCase() || '', td = row.querySelector('td')?.innerText.toLowerCase() || '';
                        if (th.includes('status') && (td.includes('submitted') || td.includes('dikumpulkan'))) isSubmitted = true;
                    });

                    // --- DETEKSI: Mark as Done / Completion Status ---
                    if (!isSubmitted) {
                        const completionBtn = document.querySelector('[data-region="completion-toggle"], .completion-dialog-button, .btn-outline-success, .btn-success');
                        if (completionBtn && (completionBtn.innerText.toLowerCase().includes('done') || completionBtn.innerText.toLowerCase().includes('selesai'))) {
                            isSubmitted = true;
                        }
                        const doneLabel = document.querySelector('.completioninfo .badge-success, .automatic-completion-conditions [aria-label*="Done"], .badge-success');
                        if (doneLabel && (doneLabel.innerText.toLowerCase().includes('done') || doneLabel.innerText.toLowerCase().includes('selesai'))) {
                            isSubmitted = true;
                        }
                        if (document.querySelector('img[src*="i/completion-manual-y"], img[src*="i/completion-auto-y"]')) isSubmitted = true;
                    }

                    return { description, isSubmitted, deadline, courseName };
                });

                return {
                    ...task,
                    course: detail.courseName,
                    description: detail.description,
                    isSubmitted: detail.isSubmitted,
                    deadline: detail.deadline,
                    type: task.url.includes('assign') ? 'assignment' : (task.url.includes('quiz') ? 'quiz' : 'activity'),
                    scrapedAt: new Date().toISOString()
                };
            } catch (e) { return task; }
            finally { await taskPage.close(); }
        };

        for (let i = 0; i < tasksToScrape.length; i += CONCURRENCY_LIMIT) {
            const chunk = tasksToScrape.slice(i, i + CONCURRENCY_LIMIT);
            const chunkResults = await Promise.all(chunk.map(t => scrapeTask(t)));
            results.push(...chunkResults);
        }

        await browser.close();
        console.log(`✨ Scrape selesai dalam ${(Date.now() - startTime)/1000}s.`);
        return res.status(200).json(results);

    } catch (error) {
        if (browser) await browser.close();
        return res.status(500).json({ error: error.message });
    }
}
