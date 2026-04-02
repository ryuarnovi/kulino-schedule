const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

chromium.use(StealthPlugin());

async function deepScrape() {
    const username = process.env.KULINO_USERNAME;
    const password = process.env.KULINO_PASSWORD;

    if (!username || !password) {
        console.error('❌ Credentials missing');
        process.exit(1);
    }

    console.log('🚀 Memulai Deep Scraper (All Courses Mode)...');

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: 'Mozilla/5.0' });
    const page = await context.newPage();

    try {
        await page.goto('https://kulino.dinus.ac.id/login/index.php', { waitUntil: 'networkidle' });
        await page.fill('#username', username);
        await page.fill('#password', password);
        await Promise.all([ page.waitForURL('**/my/**', { timeout: 30000 }), page.click('#loginbtn') ]);

        console.log('📂 Membuka daftar lengkap mata kuliah (Mode: EXC_MBKM)...');
        await page.goto('https://kulino.dinus.ac.id/my/courses.php', { waitUntil: 'networkidle' });
        
        // Scroll ke bawah untuk memastikan semua lazy-load course muncul
        await page.evaluate(async () => {
            for (let i = 0; i < 6; i++) {
                window.scrollBy(0, window.innerHeight);
                await new Promise(r => setTimeout(r, 600));
            }
        });

        const courses = await page.evaluate(() => {
            const list = [];
            // Target semua kemungkinan link maktul
            const links = document.querySelectorAll('a[href*="course/view.php?id="], .coursename a, a.course-name');
            links.forEach(a => {
                const url = a.href.split('&')[0];
                const name = a.innerText.trim();
                const ln = name.toLowerCase();
                const isMBKM = ln.includes('mbkm') || ln.includes('magang') || ln.includes('studi independen');
                
                // FILTER: Ambil semua kecuali MBKM dan Summary
                if (name && !list.some(c => c.url === url) && name.length >= 2 && !ln.includes('summary') && !isMBKM) {
                    list.push({ name, url });
                }
            });
            return list;
        });

        console.log(`✅ Menemukan ${courses.length} mata kuliah.`);
        const finalResults = [];

        const scrapeCourse = async (course) => {
            const cp = await context.newPage();
            try {
                process.stdout.write(`🔍 Checking: ${course.name.substring(0, 40)}... `);
                await cp.goto(course.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                const tasks = await cp.evaluate((c) => {
                    const found = [];
                    const selectors = '.activity.assign, .activity.quiz, .activity.forum, .activity.lti, .modtype_assign, .modtype_forum, .modtype_quiz';
                    const elements = document.querySelectorAll(selectors);
                    
                    if (elements.length === 0) {
                        found.push({
                            id: 'empty-' + (c.url.split('id=')[1] || Math.random().toString(36).substr(2, 5)),
                            title: 'NO_ACTIVE_TASKS_DETECTOR',
                            url: c.url,
                            course: c.name,
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
                                id: url.split('id=')[1] || Math.random().toString(36).substr(2, 9),
                                title, url,
                                course: c.name,
                                isSubmitted: isDone || isManualCheck,
                                type: url.includes('forum') ? 'forum' : (url.includes('quiz') ? 'quiz' : 'assignment'),
                                scrapedAt: new Date().toISOString()
                            });
                        });
                    }
                    return found;
                }, course);
                console.log(`[OK]`);
                return tasks;
            } catch (e) { return []; }
            finally { await cp.close(); }
        };

        for (let i = 0; i < courses.length; i += 3) {
            const chunk = courses.slice(i, i + 3);
            const chunkRes = await Promise.all(chunk.map(c => scrapeCourse(c)));
            chunkRes.forEach(r => finalResults.push(...r));
        }

        const dataFile = path.join(__dirname, '../public/deadlines.json');
        fs.mkdirSync(path.dirname(dataFile), { recursive: true });
        fs.writeFileSync(dataFile, JSON.stringify(finalResults, null, 2));
        console.log(`\n✨ Selesai! ${finalResults.length} entri disimpan ke ${dataFile}.`);

    } catch (error) { 
        console.error('❌ Error fatal:', error); 
    } finally { 
        if (browser) await browser.close(); 
    }
}

deepScrape();
