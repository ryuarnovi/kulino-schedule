const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Tambahkan plugin stealth agar tidak terdeteksi sebagai bot
chromium.use(StealthPlugin());

async function scrapeDeep() {
    const username = process.env.KULINO_USERNAME;
    const password = process.env.KULINO_PASSWORD;

    if (!username || !password) {
        console.error('❌ Kredensial tidak ditemukan di .env');
        process.exit(1);
    }

    console.log('🚀 Memulai Optimized JS Scraper (with Stealth & Parallelism)...');

    // 1. Load data lama untuk sinkronisasi
    const dataFile = path.join(__dirname, '../public/deadlines.json');
    let existingTasks = [];
    if (fs.existsSync(dataFile)) {
        try {
            existingTasks = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
            console.log(`📁 Menemukan ${existingTasks.length} entri lama.`);
        } catch (err) {
            console.log('⚠️ Gagal membaca deadlines.json lama.');
        }
    }

    const taskHistoryMap = new Map();
    existingTasks.forEach((task) => {
        if (task.id || task.url) taskHistoryMap.set(task.id || task.url, task);
    });

    const browser = await chromium.launch({ headless: true });
    // User agent yang lebih modern
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 }
    });
    const page = await context.newPage();

    try {
        // --- PROSES LOGIN (STEALTH) ---
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

        // --- AMBIL LIST TUGAS DARI KALENDER ---
        console.log('📅 Mengambil daftar semua tugas dari kalender...');
        let currentTasks = [];
        const MAX_MONTHS = 5;

        for (let m = 0; m < MAX_MONTHS; m++) {
            console.log(`🔍 Scraping Bulan ke-${m + 1}...`);
            await page.goto(`https://kulino.dinus.ac.id/calendar/view.php?view=month`, { waitUntil: 'domcontentloaded' });
            
            // Jika bukan bulan pertama, kita perlu navigasi (atau langsung inject URL param jika tahu)
            // Tapi untuk amannya kita ikuti navigasi tombol Next
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
                const filters = ['tugas', 'praktikum', 'pratikum', 'assign', 'kuis', 'quiz', 'praktek', 'ujian', 'repositori', 'repository', 'proyek', 'project', 'forum', 'kegiatan', 'mahasiswa', 'student', 'activity', 'survey', 'kuesioner'];
                
                eventLinks.forEach(ev => {
                    const rawTitle = ev.getAttribute('title') || '';
                    const url = ev.href;
                    const cleanTitle = rawTitle.replace(' is due', '').replace(' opens', '').trim();
                    const t = cleanTitle.toLowerCase();
                    
                    const isValid = filters.some(f => t.includes(f)) || 
                                  ['assign', 'quiz', 'forum', 'choice', 'feedback', 'survey', 'workshop'].some(x => url.includes(x));
                    
                    if (isValid) {
                        const td = ev.closest('td.day');
                        const timestamp = td ? parseInt(td.getAttribute('data-day-timestamp')) * 1000 : null;
                        results.push({
                            id: ev.getAttribute('data-event-id'),
                            title: cleanTitle,
                            url: url,
                            deadlineTimestamp: timestamp
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
        
        // --- INSPEKSI DETAIL (PARALEL) ---
        console.log('🚀 Memulai inspeksi detail secara PARALEL...');
        const CONCURRENCY_LIMIT = 5; // Buka 5 tab sekaligus
        const finalResults = [];
        
        // Pisahkan tugas yang butuh di-scrape vs yang sudah ada di history (Selesai)
        const tasksToScrape = [];
        currentTasks.forEach(task => {
            const old = taskHistoryMap.get(task.id || task.url);
            if (old && old.isSubmitted) {
                finalResults.push(old);
            } else {
                tasksToScrape.push(task);
            }
        });

        console.log(`➡️ ${tasksToScrape.length} tugas akan diperbarui, ${finalResults.length} tugas dilewati (sudah selesai).`);

        // Fungsi worker untuk setiap satu tugas
        const scrapeTaskWorker = async (task) => {
            const taskPage = await context.newPage();
            try {
                console.log(`   Inspeksi: ${task.title}`);
                // Efisiensi: blokir gambar/css
                await taskPage.route('**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2,ico}', route => route.abort());
                
                await taskPage.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
                
                // Cari activity link jika ini halaman kalender (redirection)
                const activityLink = await taskPage.locator('a.btn-primary[href*="mod/"]').getAttribute('href').catch(() => null);
                if (activityLink) {
                    await taskPage.goto(activityLink, { waitUntil: 'domcontentloaded', timeout: 10000 });
                }

                const detail = await taskPage.evaluate((userName) => {
                    let deadline = '';
                    let isSubmitted = false;
                    let courseName = '';
                    let description = document.querySelector('#intro .no-overflow')?.textContent?.trim() || '';

                    // Ambil Course Name dari Breadcrumb
                    const bread = document.querySelectorAll('.breadcrumb-item a');
                    if (bread.length >= 3) courseName = bread[2].innerText.trim();

                    // Ambil Deadline
                    const dateDivs = document.querySelectorAll('[data-region="activity-dates"] > div');
                    dateDivs.forEach(div => {
                        const txt = div.textContent.trim();
                        if (txt.includes('Due:') || txt.includes('Closes:')) deadline = txt.replace(/Due:|Closes:/, '').trim();
                    });

                    // Cek Status Pengumpulan
                    const rows = document.querySelectorAll('.submissionstatustable tr');
                    rows.forEach(row => {
                        const th = row.querySelector('th')?.textContent?.trim().toLowerCase() || '';
                        const td = row.querySelector('td')?.textContent?.trim().toLowerCase() || '';
                        if (th.includes('status') && (td.includes('submitted') || td.includes('dikumpulkan'))) isSubmitted = true;
                    });
                    
                    if (!isSubmitted) {
                        const quizBtn = document.querySelector('form[action*="startattempt.php"] button');
                        if (!quizBtn && document.body.innerText.includes('quiz has been submitted')) isSubmitted = true;
                    }

                    return { description, isSubmitted, deadline, courseName };
                }, userDisplayName);

                const updatedTask = {
                    ...task,
                    course: detail.courseName,
                    description: detail.description,
                    isSubmitted: detail.isSubmitted,
                    deadline: detail.deadline,
                    type: task.url.includes('assign') ? 'assignment' : (task.url.includes('quiz') ? 'quiz' : 'activity'),
                    scrapedAt: new Date().toISOString()
                };

                if (detail.deadline) {
                    const dt = new Date(detail.deadline);
                    if (!isNaN(dt.getTime())) updatedTask.deadlineTimestamp = dt.getTime();
                }

                return updatedTask;
            } catch (err) {
                console.warn(`   ⚠️ Gagal: ${task.title}`);
                return task; // Kembalikan data asal jika gagal
            } finally {
                await taskPage.close();
            }
        };

        // Eksekusi secara paralel dengan limit
        for (let i = 0; i < tasksToScrape.length; i += CONCURRENCY_LIMIT) {
            const chunk = tasksToScrape.slice(i, i + CONCURRENCY_LIMIT);
            const chunkResults = await Promise.all(chunk.map(task => scrapeTaskWorker(task)));
            finalResults.push(...chunkResults);
        }

        // Simpan hasil akhir
        fs.writeFileSync(dataFile, JSON.stringify(finalResults, null, 2));
        console.log(`\n✨ Selesai! ${finalResults.length} tugas disimpan.`);

    } catch (error) {
        console.error('❌ Fatal Error:', error);
    } finally {
        await browser.close();
    }
}

scrapeDeep();
