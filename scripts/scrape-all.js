const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function scrapeDeep() {
    const username = process.env.KULINO_USERNAME;
    const password = process.env.KULINO_PASSWORD;

    if (!username || !password) {
        console.error('❌ Kredensial tidak ditemukan.');
        process.exit(1);
    }

    console.log('🚀 Tenggat Task Only Scraper dimulai...');

    // 1. Load existing data to sync
    const dataFile = path.join(__dirname, '../public/deadlines.json');
    let existingTasks = [];
    if (fs.existsSync(dataFile)) {
        try {
            const rawData = fs.readFileSync(dataFile, 'utf-8');
            existingTasks = JSON.parse(rawData);
            console.log(`📁 Menemukan ${existingTasks.length} entri lama di database.`);
        } catch (err) {
            console.log('⚠️ Gagal membaca deadlines.json lama.');
        }
    }

    const taskHistoryMap = new Map();
    existingTasks.forEach((task) => {
        if (task.id || task.url) taskHistoryMap.set(task.id || task.url, task);
    });

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    try {
        console.log('🌐 Membuka halaman login...');
        await page.goto('https://kulino.dinus.ac.id/login/index.php');
        await page.fill('#username', username);
        await page.fill('#password', password);
        await page.click('#loginbtn');
        await page.waitForURL('**/my/**', { timeout: 30000 });

        console.log('📅 Pindah ke Kalender (Month View)...');
        await page.waitForTimeout(2000);
        await page.goto('https://kulino.dinus.ac.id/calendar/view.php?view=month', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.calendartable', { timeout: 15000 });

        // --- 2. AMBIL LIST TUGAS DENGAN PAGINATION ---
        let currentTasks = [];
        let monthsScraped = 0;
        const MAX_MONTHS = 5; 

        while (monthsScraped < MAX_MONTHS) {
            console.log(`🔍 Scraping Bulan ke-${monthsScraped + 1}...`);
            await page.waitForSelector('.overlay-icon-container', { state: 'hidden', timeout: 10000 }).catch(() => {});

            const eventsLocator = page.locator('a[data-action="view-event"]');
            const eventCount = await eventsLocator.count();

            for (let j = 0; j < eventCount; j++) {
                const ev = eventsLocator.nth(j);
                const eventId = await ev.getAttribute('data-event-id');
                const rawTitle = (await ev.getAttribute('title')) || '';
                const cleanTitle = rawTitle.replace(' is due', '').replace(' opens', '').trim();
                const url = await ev.getAttribute('href');

                // Keywords check
                const t = cleanTitle.toLowerCase();
                const filter = ['tugas', 'praktikum', 'pratikum', 'assign', 'kuis', 'quiz', 'praktek', 'ujian'];
                if (!filter.some(f => t.includes(f)) && !url.includes('assign') && !url.includes('quiz')) continue;

                const timestampMs = await ev.evaluate((el) => {
                    const td = el.closest('td.day');
                    const ts = td ? td.getAttribute('data-day-timestamp') : null;
                    return ts ? parseInt(ts) * 1000 : null;
                });

                // BUKA MODAL untuk Nama Matkul
                await ev.click({ force: true });
                await page.waitForSelector('.modal-content', { state: 'visible', timeout: 5000 }).catch(() => {});

                const modalData = await page.evaluate(() => {
                    const courseEl = document.querySelector('.modal-content a[href*="course/view.php?id="]');
                    let courseName = courseEl?.textContent?.trim() || 'Umum';
                    courseName = courseName.replace(/^\[\d+\]\s*/, '');
                    const activityBtn = document.querySelector('.modal-content a.btn-primary');
                    const activityLink = activityBtn ? activityBtn.getAttribute('href') : null;
                    return { courseName, activityLink };
                });

                await page.keyboard.press('Escape');
                await page.waitForSelector('.modal-content', { state: 'hidden', timeout: 5000 }).catch(() => {});

                const activeUrl = modalData.activityLink || url;
                const isDuplicate = currentTasks.some((existing) => (existing.id === eventId || existing.url === activeUrl));
                
                if (!isDuplicate) {
                    currentTasks.push({
                        id: eventId,
                        title: cleanTitle,
                        course: modalData.courseName,
                        deadlineTimestamp: timestampMs,
                        url: activeUrl,
                        scrapedAt: new Date().toISOString()
                    });
                }
            }

            monthsScraped++;
            if (monthsScraped < MAX_MONTHS) {
                const nextBtn = page.locator('.arrow_link.next');
                if ((await nextBtn.count()) > 0) {
                    await nextBtn.click({ force: true });
                    await page.waitForSelector('.overlay-icon-container', { state: 'visible', timeout: 5000 }).catch(() => {});
                    await page.waitForSelector('.overlay-icon-container', { state: 'hidden', timeout: 15000 }).catch(() => {});
                } else break;
            }
        }

        console.log(`\n✅ Ditemukan ${currentTasks.length} tugas unik. Memulai inspeksi rincian...`);

        // --- 3. DETAIL INSPECTION (Skip if submitted) ---
        for (let i = 0; i < currentTasks.length; i++) {
            const task = currentTasks[i];
            const oldTask = taskHistoryMap.get(task.id || task.url);

            if (oldTask && oldTask.isSubmitted) {
                console.log(`⏩ [${i + 1}/${currentTasks.length}] Skip: ${task.title} (Selesai)`);
                currentTasks[i] = oldTask;
                taskHistoryMap.delete(task.id || task.url);
                continue;
            }

            console.log(`➡️ [${i + 1}/${currentTasks.length}] Inspeksi Detail: ${task.title}`);
            try {
                await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
                const detail = await page.evaluate(() => {
                    let deadline = '';
                    let isSubmitted = false;
                    let description = document.querySelector('#intro .no-overflow')?.textContent?.trim() || '';

                    const dateDivs = document.querySelectorAll('[data-region="activity-dates"] > div');
                    dateDivs.forEach(div => {
                        const txt = div.textContent.trim();
                        if (txt.includes('Due:') || txt.includes('Closes:')) deadline = txt.replace(/Due:|Closes:/, '').trim();
                    });

                    const rows = document.querySelectorAll('.submissionstatustable tr');
                    rows.forEach(row => {
                        const th = row.querySelector('th')?.textContent?.trim().toLowerCase() || '';
                        const td = row.querySelector('td')?.textContent?.trim().toLowerCase() || '';
                        if (th.includes('status') && (td.includes('submitted') || td.includes('dikumpulkan'))) isSubmitted = true;
                    });
                    
                    if (!isSubmitted) {
                        const quizBtn = document.querySelector('form[action*="startattempt.php"] button');
                        if (!quizBtn && document.body.innerText.toLowerCase().includes('quiz has been submitted')) isSubmitted = true;
                    }

                    return { description, isSubmitted, deadline };
                });

                task.description = detail.description;
                task.isSubmitted = detail.isSubmitted;
                if (detail.deadline) {
                    task.deadline = detail.deadline;
                    const dt = new Date(detail.deadline);
                    if (!isNaN(dt.getTime())) task.deadlineTimestamp = dt.getTime();
                }
                taskHistoryMap.delete(task.id || task.url);
            } catch (err) {
                console.warn(`⚠️ Gagal rincian ${task.title}`);
                if (oldTask) currentTasks[i] = oldTask;
            }
        }

        const finalTasks = [...currentTasks, ...Array.from(taskHistoryMap.values())];
        fs.writeFileSync(dataFile, JSON.stringify(finalTasks, null, 2));
        console.log(`✨ Selesai! ${finalTasks.length} tugas disimpan.`);

    } catch (error) {
        console.error('❌ Fatal Error:', error);
    } finally {
        await browser.close();
    }
}

scrapeDeep();
