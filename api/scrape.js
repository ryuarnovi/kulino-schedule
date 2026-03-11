const { chromium } = require('playwright-core');
const chromiumPack = require('@sparticuz/chromium');

export default async function handler(req, res) {
    const username = process.env.KULINO_USERNAME;
    const password = process.env.KULINO_PASSWORD;

    if (!username || !password) {
        return res.status(500).json({ error: 'Kredensial tidak diset di Environment Variables Vercel.' });
    }

    let browser;
    try {
        browser = await chromium.launch({
            args: chromiumPack.args,
            executablePath: await chromiumPack.executablePath(),
            headless: chromiumPack.headless,
        });
        
        const context = await browser.newContext();
        const page = await context.newPage();

        // 1. Login
        await page.goto('https://kulino.dinus.ac.id/login/index.php');
        await page.fill('#username', username);
        await page.fill('#password', password);
        await page.click('#loginbtn');
        await page.waitForTimeout(2000);

        // 2. Navigasi & Scrape (Dinamis dari Dashboard)
        await page.goto('https://kulino.dinus.ac.id/my/');
        
        // Ambil matakuliah secara dinamis
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

        const allItems = [];
        // Kita limit hanya beberapa matakuliah untuk menghindari timeout Vercel (10s/60s limit)
        for (const course of courses.slice(0, 5)) {
            await page.goto(course.url);
            const items = await page.evaluate((cTitle) => {
                return Array.from(document.querySelectorAll('.activityinstance')).map(mod => {
                    const link = mod.querySelector('a');
                    return link ? {
                        course: cTitle,
                        title: link.textContent.trim(),
                        url: link.href,
                        scrapedAt: new Date().toISOString()
                    } : null;
                }).filter(i => i);
            }, course.title);
            allItems.push(...items);
        }

        await browser.close();
        return res.status(200).json(allItems);

    } catch (error) {
        if (browser) await browser.close();
        return res.status(500).json({ error: error.message });
    }
}
