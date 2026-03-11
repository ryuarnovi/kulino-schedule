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

    console.log('🚀 Tenggat Dynamic Scraper (History & Pagination) dimulai...');

    // 1. BACA DATA LAMA (HISTORY)
    let existingTasks = [];
    const dataFile = path.join(__dirname, '../public/deadlines.json');

    if (fs.existsSync(dataFile)) {
        try {
            const rawData = fs.readFileSync(dataFile, 'utf-8');
            existingTasks = JSON.parse(rawData);
            console.log(`📁 Menemukan ${existingTasks.length} tugas lama di database.`);
        } catch (err) {
            console.log('⚠️ Gagal membaca data.json lama, membuat ulang...');
        }
    }

    const taskHistoryMap = new Map();
    existingTasks.forEach((task) => {
        if (task.id) taskHistoryMap.set(task.id, task);
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

        console.log('📅 Pindah ke Kalender...');
        await page.waitForTimeout(2000);
        await page.goto('https://kulino.dinus.ac.id/calendar/view.php?view=month', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.calendartable', { timeout: 15000 });

        // --- 2. AMBIL LIST TUGAS DENGAN DYNAMIC PAGINATION ---
        let currentTasks = [];
        let monthsScraped = 0;
        const MIN_MONTHS = 2; // Minimal ambil 2 bulan
        const MAX_MONTHS = 5; // Maksimal ambil 5 bulan
        const TARGET_TASKS = 20; // Target standar jumlah tugas

        while (monthsScraped < MAX_MONTHS) {
            console.log(`\n🔍 Scraping Kalender Bulan ke-${monthsScraped + 1}...`);

            // 🛡️ TUNGGU OVERLAY LOADING MOODLE HILANG DULU SEBELUM MULAI
            await page.waitForSelector('.overlay-icon-container', { state: 'hidden', timeout: 10000 }).catch(() => {});

            // 🎯 PENGGUNAAN LOCATOR
            const eventsLocator = page.locator('a[data-action="view-event"]');
            const eventCount = await eventsLocator.count();

            for (let j = 0; j < eventCount; j++) {
                const ev = eventsLocator.nth(j);
                const eventId = await ev.getAttribute('data-event-id');
                if (!eventId) continue;

                // Bersihkan title
                const rawTitle = (await ev.getAttribute('title')) || '';
                const cleanTitle = rawTitle.replace(' is due', '').replace(' opens', '').trim();

                // Ambil timestamp dari parent td.day
                const timestampMs = await ev.evaluate((el) => {
                    const td = el.closest('td.day');
                    const ts = td ? td.getAttribute('data-day-timestamp') : null;
                    return ts ? parseInt(ts) * 1000 : null;
                });

                // 🖱️ BUKA MODAL
                await ev.click({ force: true });
                await page.waitForSelector('.modal-content', { state: 'visible', timeout: 5000 }).catch(() => {});

                // 🎯 AMBIL NAMA MATKUL DARI MODAL
                const modalData = await page.evaluate(() => {
                    const courseEl = document.querySelector('.modal-content a[href*="course/view.php?id="]');
                    let courseName = courseEl?.textContent?.trim() || '';
                    courseName = courseName.replace(/^\[\d+\]\s*/, ''); // Hapus angka kode matkul

                    const activityBtn = document.querySelector('.modal-content a.btn-primary');
                    const activityLink = activityBtn ? activityBtn.getAttribute('href') : null;

                    return { courseName, activityLink };
                });

                // ❌ TUTUP MODAL
                await page.keyboard.press('Escape');
                await page.waitForSelector('.modal-content', { state: 'hidden', timeout: 5000 }).catch(() => {});
                await page.waitForTimeout(300);

                // Masukkan ke array jika unik
                const isDuplicate = currentTasks.some((existing) => existing.id === eventId);
                if (!isDuplicate) {
                    currentTasks.push({
                        id: eventId,
                        title: cleanTitle,
                        course: modalData.courseName,
                        deadlineTimestamp: timestampMs,
                        url: modalData.activityLink || (await ev.getAttribute('href')),
                        scrapedAt: new Date().toISOString()
                    });
                }
            }

            monthsScraped++;
            console.log(`📊 Terkumpul sementara: ${currentTasks.length} tugas unik.`);

            // CEK KONDISI BERHENTI
            if (monthsScraped >= MIN_MONTHS && currentTasks.length >= TARGET_TASKS) {
                console.log(`✅ Sudah melewati ${MIN_MONTHS} bulan dan mencapai limit. Stop pindah bulan.`);
                break;
            }

            // PINDAH KE BULAN BERIKUTNYA
            if (monthsScraped < MAX_MONTHS) {
                const nextButton = page.locator('.arrow_link.next');
                if ((await nextButton.count()) > 0) {
                    await nextButton.click({ force: true });
                    console.log('⏳ Menunggu kalender bulan berikutnya dimuat...');
                    await page.waitForSelector('.overlay-icon-container', { state: 'visible', timeout: 5000 }).catch(() => {});
                    await page.waitForSelector('.overlay-icon-container', { state: 'hidden', timeout: 15000 }).catch(() => {});
                } else break;
            }
        }

        console.log(`\n✅ Total Kalender Selesai. Siap inspeksi detail ${currentTasks.length} tugas...`);

        // --- 3. DEEP SCRAPING DENGAN LOGIKA SKIP ---
        for (let i = 0; i < currentTasks.length; i++) {
            const task = currentTasks[i];
            if (!task || !task.id || !task.url) continue;

            const oldTask = taskHistoryMap.get(task.id);

            // HISTORY: Kalau sudah submit sebelumnya, skip
            if (oldTask && oldTask.isSubmitted) {
                console.log(`⏩ [${i + 1}/${currentTasks.length}] SKIP: ${task.title} (Sudah dikumpulkan)`);
                currentTasks[i] = oldTask;
                taskHistoryMap.delete(task.id);
                continue;
            }

            console.log(`➡️ [${i + 1}/${currentTasks.length}] SCRAPE: ${task.title}`);

            try {
                await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 15000 });

                const detail = await page.evaluate(() => {
                    let description = document.querySelector('#intro .no-overflow')?.textContent?.trim() || '';
                    let isSubmitted = false;
                    let deadline = '';

                    const dateDivs = document.querySelectorAll('[data-region="activity-dates"] > div');
                    dateDivs.forEach((div) => {
                        const text = div.textContent?.trim() || '';
                        if (text.includes('Opened:')) {}
                        else if (text.includes('Due:') || text.includes('Closes:')) deadline = text.replace(/Due:|Closes:/, '').trim();
                    });

                    const tableRows = document.querySelectorAll('.submissionstatustable tr');
                    tableRows.forEach((row) => {
                        const th = row.querySelector('th')?.textContent?.trim() || '';
                        const td = row.querySelector('td')?.textContent?.trim() || '';
                        if (th.includes('Submission status') || th.includes('Status pengajuan')) {
                            if (td.toLowerCase().includes('submitted') || td.toLowerCase().includes('dikumpulkan')) {
                                isSubmitted = true;
                            }
                        }
                    });

                    return { description, isSubmitted, deadline };
                });

                task.description = detail.description;
                task.isSubmitted = detail.isSubmitted;
                if (detail.deadline) {
                    task.deadline = detail.deadline;
                    const dt = new Date(detail.deadline);
                    if (!isNaN(dt.getTime())) task.deadlineTimestamp = dt.getTime();
                }

                taskHistoryMap.delete(task.id);
            } catch (err) {
                console.log(`⚠️ Gagal membaca detail untuk: ${task.title}`);
                if (oldTask) currentTasks[i] = oldTask;
            }
        }

        // --- 4. GABUNGKAN ---
        const finalTasks = [...currentTasks, ...Array.from(taskHistoryMap.values())];

        console.log('\n🎉 Proses Scraping Selesai!');
        fs.writeFileSync(dataFile, JSON.stringify(finalTasks, null, 2));
        console.log(`📁 Berhasil menyimpan total ${finalTasks.length} tugas ke deadlines.json`);
    } catch (error) {
        console.error('❌ Error Total:', error);
    } finally {
        await browser.close();
    }
}

scrapeDeep();
