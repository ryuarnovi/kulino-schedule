const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

chromium.use(StealthPlugin());

async function scrapeDeep() {
    const username = process.env.KULINO_USERNAME;
    const password = process.env.KULINO_PASSWORD;

    if (!username || !password) {
        console.error('❌ Kredensial tidak ditemukan di .env');
        process.exit(1);
    }

    console.log('🚀 Memulai Optimized JS Scraper (with Forum Detection)...');

    const dataFile = path.join(__dirname, '../public/deadlines.json');
    let existingTasks = [];
    if (fs.existsSync(dataFile)) {
        try {
            existingTasks = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
            console.log(`📁 Menemukan ${existingTasks.length} entri lama.`);
        } catch (err) { console.log('⚠️ Gagal membaca deadlines.json lama.'); }
    }

    const taskHistoryMap = new Map();
    existingTasks.forEach((task) => {
        if (task.id || task.url) taskHistoryMap.set(task.id || task.url, task);
    });

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 }
    });
    const page = await context.newPage();

    try {
        console.log('🌐 Login ke Kulino...');
        await page.goto('https://kulino.dinus.ac.id/login/index.php', { waitUntil: 'networkidle' });
        await page.fill('#username', username);
        await page.fill('#password', password);
        await Promise.all([
            page.waitForURL('**/my/**', { timeout: 30000 }),
            page.click('#loginbtn')
        ]);

        const userDisplayName = await page.evaluate(() => {
            return document.querySelector('.userbutton .usertext')?.textContent?.trim() || '';
        });
        console.log(`👤 Login berhasil sebagai: ${userDisplayName}`);

        console.log('📅 Mengambil daftar semua tugas dari kalender...');
        let currentTasks = [];
        const MAX_MONTHS = 5;

        for (let m = 0; m < MAX_MONTHS; m++) {
            console.log(`🔍 Scraping Bulan ke-${m + 1}...`);
            await page.goto(`https://kulino.dinus.ac.id/calendar/view.php?view=month`, { waitUntil: 'domcontentloaded' });
            
            if (m > 0) {
                for (let i = 0; i < m; i++) {
                    const nextBtn = page.locator('.arrow_link.next');
                    if (await nextBtn.count() > 0) {
                        await nextBtn.click({ force: true });
                        await page.waitForSelector('.overlay-icon-container', { state: 'hidden' });
                    }
                }
            }

            const events = await page.evaluate(() => {
                const results = [];
                const eventLinks = document.querySelectorAll('a[data-action="view-event"]');
                const filters = ['tugas', 'praktikum', 'pratikum', 'assign', 'kuis', 'quiz', 'praktek', 'ujian', 'repositori', 'repository', 'proyek', 'project', 'forum', 'kegiatan', 'mahasiswa', 'student', 'activity', 'survey', 'kuesioner', 'meeting'];
                
                eventLinks.forEach(ev => {
                    const rawTitle = ev.getAttribute('title') || '';
                    const url = ev.href;
                    const cleanTitle = rawTitle.replace(' is due', '').replace(' opens', '').trim();
                    const t = cleanTitle.toLowerCase();
                    const isValid = filters.some(f => t.includes(f)) || url.includes('assign') || url.includes('quiz') || url.includes('forum');
                    
                    if (isValid) {
                        const td = ev.closest('td.day');
                        results.push({
                            id: ev.getAttribute('data-event-id'),
                            title: cleanTitle,
                            url: url,
                            deadlineTimestamp: td ? parseInt(td.getAttribute('data-day-timestamp')) * 1000 : null
                        });
                    }
                });
                return results;
            });

            events.forEach(ev => {
                if (!currentTasks.some(t => t.id === ev.id)) currentTasks.push(ev);
            });
        }

        console.log(`\n✅ Ditemukan ${currentTasks.length} tugas unik.`);
        
        const CONCURRENCY_LIMIT = 5;
        const finalResults = [];
        const tasksToScrape = [];
        currentTasks.forEach(task => {
            const old = taskHistoryMap.get(task.id || task.url);
            if (old && old.isSubmitted) finalResults.push(old);
            else tasksToScrape.push(task);
        });

        const scrapeTaskWorker = async (task) => {
            const taskPage = await context.newPage();
            try {
                await taskPage.route('**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2,ico}', route => route.abort());
                await taskPage.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
                const activityLink = await taskPage.locator('a.btn-primary[href*="mod/"]').getAttribute('href').catch(() => null);
                if (activityLink) await taskPage.goto(activityLink, { waitUntil: 'domcontentloaded', timeout: 10000 });

                const detail = await taskPage.evaluate((userName) => {
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
                    
                    if (!isSubmitted) {
                        const completionBtn = document.querySelector('[data-region="completion-toggle"], .completion-dialog-button, .btn-outline-success, .btn-success');
                        if (completionBtn && (completionBtn.innerText.toLowerCase().includes('done') || completionBtn.innerText.toLowerCase().includes('selesai'))) isSubmitted = true;
                    }

                    if (!isSubmitted && userName && location.href.includes('mod/forum')) {
                        const authors = Array.from(document.querySelectorAll('.author, .post-author, .user-name'));
                        if (authors.some(a => a.textContent.includes(userName))) isSubmitted = true;
                        if (document.body.innerText.includes('Your post has been added')) isSubmitted = true;
                    }

                    return { description, isSubmitted, deadline, courseName };
                }, userDisplayName);

                const updatedTask = {
                    ...task,
                    course: detail.courseName,
                    description: detail.description,
                    isSubmitted: detail.isSubmitted,
                    deadline: detail.deadline,
                    type: task.url.includes('forum') ? 'forum' : (task.url.includes('assign') ? 'assignment' : (task.url.includes('quiz') ? 'quiz' : 'activity')),
                    scrapedAt: new Date().toISOString()
                };

                if (detail.deadline) {
                    const dt = new Date(detail.deadline);
                    if (!isNaN(dt.getTime())) updatedTask.deadlineTimestamp = dt.getTime();
                }
                return updatedTask;
            } catch (err) { return task; }
            finally { await taskPage.close(); }
        };

        for (let i = 0; i < tasksToScrape.length; i += CONCURRENCY_LIMIT) {
            const chunk = tasksToScrape.slice(i, i + CONCURRENCY_LIMIT);
            const chunkResults = await Promise.all(chunk.map(task => scrapeTaskWorker(task)));
            finalResults.push(...chunkResults);
        }

        fs.writeFileSync(dataFile, JSON.stringify(finalResults, null, 2));
        console.log(`\n✨ Selesai! ${finalResults.length} tugas disimpan.`);

    } catch (error) { console.error('❌ Fatal Error:', error); } finally { await browser.close(); }
}

scrapeDeep();
