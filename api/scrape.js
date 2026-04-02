const { chromium } = require('playwright-core');
const { chromium: chromiumExtra } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromiumPack = require('@sparticuz/chromium');
const path = require('path');
const fs = require('fs');

// Gunakan plugin stealth tapi kita bungkus secara manual
const stealth = StealthPlugin();

module.exports = async function handler(req, res) {
    const startTime = Date.now();
    console.log("🚀 Serverless function started...");
    
    // Set headers untuk mencegah cache
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    
    const username = process.env.KULINO_USERNAME;
    const password = process.env.KULINO_PASSWORD;

    if (!username || !password) {
        console.error("❌ Credentials missing!");
        return res.status(401).json({ error: 'Missing Credentials' });
    }

    let browser;
    try {
        console.log("📦 Launching browser...");
        
        // --- LAUNCH BROWSER (VERCEL OPTIMIZED) ---
        // Kita menggunakan playwright-core secara langsung agar lebih stabil di Vercel
        browser = await chromium.launch({
            args: [...chromiumPack.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--block-new-web-contents'],
            executablePath: await chromiumPack.executablePath(),
            headless: true,
        });
        
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 }
        });
        
        // Blokir resource berat (gambar/font) untuk menghemat waktu & bandwidth Vercel
        await context.route('**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2,ico}', route => route.abort());
        const page = await context.newPage();

        // 1. LOGIN
        console.log("🔑 Logging in to Kulino...");
        await page.goto('https://kulino.dinus.ac.id/login/index.php', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.fill('#username', username);
        await page.fill('#password', password);
        await Promise.all([
            page.waitForURL('**/my/**', { timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => null),
            page.click('#loginbtn'),
        ]);

        const userDisplayName = await page.evaluate(() => {
            return document.querySelector('.userbutton .usertext')?.textContent?.trim() || '';
        });
        console.log(`👤 Logged in as: ${userDisplayName}`);

        // 2. SCRAPE CALENDAR LIST
        console.log("📅 Fetching calendar events...");
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
                const isValid = filter.some(f => title.toLowerCase().includes(f)) || url.includes('assign') || url.includes('quiz');
                
                if (isValid) {
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

        // 3. PARALLEL INSPECTION (Batas 3 tab untuk Vercel agar tidak melebihi RAM/CPU limit)
        console.log(`🚀 Parallel processing ${tasksToScrape.length} tasks...`);
        const CONCURRENCY_LIMIT = 3; 
        const results = [];

        const scrapeTask = async (task) => {
            const taskPage = await context.newPage();
            try {
                // Blokir resource lagi untuk tab detail
                await taskPage.route('**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2,ico}', route => route.abort());
                await taskPage.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 10000 });
                
                // Redirection check
                const btn = await taskPage.$('a.btn-primary[href*="mod/"]');
                if (btn) {
                    const activityLink = await btn.getAttribute('href');
                    await taskPage.goto(activityLink, { waitUntil: 'domcontentloaded', timeout: 10 * 1000 });
                }

                const detail = await taskPage.evaluate(() => {
                    let deadline = '';
                    let isSubmitted = false;
                    let courseName = '';
                    let description = document.querySelector('#intro .no-overflow')?.textContent?.trim() || '';
                    const bread = document.querySelectorAll('.breadcrumb-item a');
                    if (bread.length >= 3) courseName = bread[2].innerText.trim();
                    const dateDivs = document.querySelectorAll('[data-region="activity-dates"] > div');
                    dateDivs.forEach(div => {
                        const txt = div.textContent.trim();
                        if (txt.includes('Due:') || txt.includes('Closes:')) deadline = txt.replace(/Due:|Closes:/, '').trim();
                    });
                    const rows = document.querySelectorAll('.submissionstatustable tr');
                    rows.forEach(row => {
                        const th = row.querySelector('th')?.innerText.toLowerCase() || '';
                        const td = row.querySelector('td')?.innerText.toLowerCase() || '';
                        if (th.includes('status') && (td.includes('submitted') || td.includes('dikumpulkan'))) isSubmitted = true;
                    });
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
            } catch (e) { 
                console.warn(`⚠️ Error detail for ${task.title}:`, e.message);
                return task; 
            }
            finally { await taskPage.close(); }
        };

        for (let i = 0; i < tasksToScrape.length; i += CONCURRENCY_LIMIT) {
            const chunk = tasksToScrape.slice(i, i + CONCURRENCY_LIMIT);
            const chunkResults = await Promise.all(chunk.map(t => scrapeTask(t)));
            results.push(...chunkResults);
        }

        await browser.close();
        const duration = (Date.now() - startTime) / 1000;
        console.log(`✨ Execution finished in ${duration}s.`);
        return res.status(200).json(results);

    } catch (error) {
        console.error("❌ Fatal runtime error:", error);
        if (browser) await browser.close();
        return res.status(500).json({ error: error.message, stack: error.stack });
    }
}
