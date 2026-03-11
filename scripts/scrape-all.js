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

    console.log('🚀 Memulai Deep Scraper (Inspirasi: Tengga Engine)...');
    
    // 1. Load existing data to sync / skip
    const dataPath = path.join(__dirname, '../public/deadlines.json');
    let existingData = [];
    if (fs.existsSync(dataPath)) {
        try {
            existingData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
            console.log(`📁 Database lama ditemukan: ${existingData.length} entri.`);
        } catch (e) {
            console.warn('⚠️ Gagal baca database lama.');
        }
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    try {
        // 1. Login
        console.log('🔑 Logging in...');
        await page.goto('https://kulino.dinus.ac.id/login/index.php', { waitUntil: 'domcontentloaded' });
        await page.fill('#username', username);
        await page.fill('#password', password);
        await Promise.all([
            page.waitForURL('**/my/**', { timeout: 30000, waitUntil: 'domcontentloaded' }),
            page.click('#loginbtn'),
        ]);

        // 2. Calendar Month View
        console.log('📅 Navigasi ke Kalender (Month View)...');
        await page.goto('https://kulino.dinus.ac.id/calendar/view.php?view=month', { waitUntil: 'domcontentloaded' });
        
        let allTasks = [];
        let monthCount = 0;
        const MAX_MONTHS = 4;

        while (monthCount < MAX_MONTHS) {
            console.log(`🔍 Scraping Bulan ke-${monthCount + 1}...`);
            await page.waitForSelector('.calendartable', { timeout: 10000 });
            
            const eventLinks = await page.locator('a[data-action="view-event"]');
            const count = await eventLinks.count();

            for (let i = 0; i < count; i++) {
                const ev = eventLinks.nth(i);
                const eventId = await ev.getAttribute('data-event-id');
                const rawTitle = await ev.getAttribute('title');
                const cleanTitle = (rawTitle || '').replace(' is due', '').replace(' opens', '').trim();
                
                // Open Modal to get Course Name & Real Link
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

                // Close Modal
                await page.keyboard.press('Escape');
                await page.waitForSelector('.modal-content', { state: 'hidden', timeout: 5000 }).catch(() => {});

                if (modalData.activityLink) {
                    allTasks.push({
                        id: eventId,
                        title: cleanTitle,
                        course: modalData.courseName,
                        url: modalData.activityLink,
                        scrapedAt: new Date().toISOString()
                    });
                }
            }

            // Next Month
            monthCount++;
            if (monthCount < MAX_MONTHS) {
                const nextBtn = page.locator('.arrow_link.next');
                if (await nextBtn.count() > 0) {
                    await nextBtn.click({ force: true });
                    // Wait for Moodle loading overlay
                    await page.waitForSelector('.overlay-icon-container', { state: 'visible', timeout: 3000 }).catch(() => {});
                    await page.waitForSelector('.overlay-icon-container', { state: 'hidden', timeout: 10000 }).catch(() => {});
                } else break;
            }
        }

        console.log(`✅ Kalender selesai. Ditemukan ${allTasks.length} tugas. Memulai inspeksi detail...`);

        // 3. Deep Detail Scraping
        for (let i = 0; i < allTasks.length; i++) {
            const task = allTasks[i];
            
            // Cek history
            const history = existingData.find(h => h.url === task.url || h.id === task.id);
            if (history && history.isSubmitted) {
                console.log(`⏩ [${i+1}/${allTasks.length}] Skip (Sudah dikerjakan): ${task.title}`);
                allTasks[i] = history;
                continue;
            }

            console.log(`➡️ [${i+1}/${allTasks.length}] Inspeksi: ${task.title}`);
            try {
                await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
                
                const details = await page.evaluate(() => {
                    let deadline = '';
                    let isSubmitted = false;
                    let description = document.querySelector('#intro .no-overflow')?.textContent?.trim() || '';

                    // Get Dates
                    const dateElements = document.querySelectorAll('[data-region="activity-dates"] > div');
                    dateElements.forEach(div => {
                        const txt = div.textContent.trim();
                        if (txt.includes('Due:') || txt.includes('Closes:')) deadline = txt.replace(/Due:|Closes:/, '').trim();
                    });

                    // Get Status
                    const rows = document.querySelectorAll('.submissionstatustable tr');
                    rows.forEach(row => {
                        const th = row.querySelector('th')?.textContent?.toLowerCase() || '';
                        const td = row.querySelector('td')?.textContent?.toLowerCase() || '';
                        if (th.includes('status') && (td.includes('submitted') || td.includes('dikumpulkan'))) isSubmitted = true;
                    });

                    return { deadline, isSubmitted, description };
                });

                task.deadline = details.deadline;
                task.isSubmitted = details.isSubmitted;
                task.description = details.description;
                if (task.deadline) {
                    const dt = new Date(task.deadline);
                    if (!isNaN(dt.getTime())) task.deadlineTimestamp = dt.getTime();
                }
            } catch (err) {
                console.warn(`⚠️ Gagal deteksi detail ${task.title}`);
            }
        }

        // 4. Final Save
        fs.writeFileSync(dataPath, JSON.stringify(allTasks, null, 2));
        console.log(`✨ Scraping Berhasil! ${allTasks.length} entri disimpan ke public/deadlines.json`);

    } catch (e) {
        console.error('❌ Fatal Error during scrape:', e);
    } finally {
        await browser.close();
    }
}

scrapeDeep();
