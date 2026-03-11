const { chromium } = require('playwright');
const fs = require('fs');
require('dotenv').config();

async function scrapeAll() {
    const username = process.env.KULINO_USERNAME;
    const password = process.env.KULINO_PASSWORD;

    if (!username || !password) {
        console.error('❌ Kredensial tidak ditemukan.');
        process.exit(1);
    }

    console.log('🚀 Memulai Scraping Mendalam via GitHub Actions...');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    try {
        // 1. Login
        console.log('🔑 Logging in to Kulino...');
        await page.goto('https://kulino.dinus.ac.id/login/index.php', { waitUntil: 'domcontentloaded' });
        await page.fill('#username', username);
        await page.fill('#password', password);
        await Promise.all([
            page.waitForURL('**/my/**', { timeout: 30000, waitUntil: 'domcontentloaded' }),
            page.click('#loginbtn'),
        ]);

        // 2. Dashboard Scraping
        console.log('📋 Getting course list...');
        await page.goto('https://kulino.dinus.ac.id/my/', { waitUntil: 'domcontentloaded' });
        
        const courses = await page.evaluate(() => {
            const selectors = ['.coursename', '.course-name', '.multiline', '.card-title'];
            const results = [];
            const seenUrls = new Set();
            selectors.forEach(selector => {
                document.querySelectorAll(selector).forEach(el => {
                    const link = el.tagName === 'A' ? el : el.querySelector('a');
                    if (link && link.href && !seenUrls.has(link.href)) {
                        seenUrls.add(link.href);
                        results.push({ title: el.textContent.trim(), url: link.href });
                    }
                });
            });
            return results;
        });

        console.log(`📚 Ditemukan ${courses.length} matakuliah.`);

        const allItems = [];
        
        // 3. Deep Scrape for EVERY Course
        for (const course of courses) {
            console.log(`🔍 Scraping matakuliah: ${course.title}...`);
            try {
                await page.goto(course.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                const items = await page.evaluate((cTitle) => {
                    return Array.from(document.querySelectorAll('.activityinstance')).map(mod => {
                        const link = mod.querySelector('a');
                        const img = mod.querySelector('img');
                        return link ? {
                            course: cTitle,
                            title: link.textContent.trim(),
                            url: link.href,
                            type: img ? img.alt : 'activity'
                        } : null;
                    }).filter(i => i);
                }, course.title);

                for (let item of items) {
                    const type = (item.type || '').toLowerCase();
                    const title = (item.title || '').toLowerCase();
                    const isTask = type.includes('assign') || type.includes('tugas') || type.includes('quiz') || 
                                   title.includes('tugas') || title.includes('praktikum') || title.includes('pratikum') || title.includes('kuis');

                    if (isTask) {
                        try {
                            const subPage = await context.newPage();
                            await subPage.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
                            
                            const deadlineInfo = await subPage.evaluate(() => {
                                const cells = Array.from(document.querySelectorAll('td, th'));
                                const labels = ['due date', 'batas waktu', 'time remaining', 'waktu tersisa'];
                                for (let i = 0; i < cells.length; i++) {
                                    const content = cells[i].textContent.toLowerCase();
                                    if (labels.some(label => content.includes(label))) {
                                        const nextCell = cells[i].nextElementSibling;
                                        if (nextCell) return nextCell.textContent.trim();
                                        const parentRow = cells[i].closest('tr');
                                        if (parentRow) {
                                            const valueCell = parentRow.querySelector('td.lastcol');
                                            if (valueCell) return valueCell.textContent.trim();
                                        }
                                    }
                                }
                                return null;
                            });

                            item.deadline = deadlineInfo;
                            if (deadlineInfo) {
                                const dt = new Date(deadlineInfo);
                                if (!isNaN(dt.getTime())) item.deadlineTimestamp = dt.getTime();
                            }
                            await subPage.close();
                        } catch (e) {
                            console.warn(`⚠️ Gagal deteksi deadline untuk ${item.title}`);
                        }
                    }
                    item.scrapedAt = new Date().toISOString();
                    allItems.push(item);
                }
            } catch (err) {
                console.error(`❌ Gagal scrape matakuliah ${course.title}:`, err.message);
            }
        }

        // 4. Save to JSON
        fs.writeFileSync('deadlines.json', JSON.stringify(allItems, null, 2));
        console.log('✅ Scraping selesai! Data disimpan ke deadlines.json.');

    } catch (error) {
        console.error('❌ Fatal Error:', error);
    } finally {
        await browser.close();
    }
}

scrapeAll();
