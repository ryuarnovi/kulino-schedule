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

        const courses = await page.evaluate(() => {
            const list = [];
            document.querySelectorAll('a[href*="course/view.php?id="]').forEach(a => {
                const url = a.href.split('&')[0];
                const name = a.innerText.trim();
                const isMBKM = name.toUpperCase().includes('MBKM');
                if (name && !list.some(c => c.url === url) && name.length > 5 && !name.includes('Summary') && !isMBKM) {
                    list.push({ name, url });
                }
            });
            return list;
        });

        console.log(`✅ Menemukan ${courses.length} mata kuliah non-MBKM.`);
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
                        // Tetap tambahkan agar kode matkul muncul di Dashboard
                        found.push({
                            id: 'empty-' + c.url.split('id=')[1],
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
                                id: url.split('id=')[1],
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
        fs.writeFileSync(dataFile, JSON.stringify(finalResults, null, 2));
        console.log(`\n✨ Selesai! ${finalResults.length} entri disimpan.`);

    } catch (error) { console.error('❌ Error:', error); } finally { await browser.close(); }
}

deepScrape();
 stone
