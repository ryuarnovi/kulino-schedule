require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright-core');
let chromiumPack;
try {
    chromiumPack = require('@sparticuz/chromium');
} catch (e) {
    // Local environment might not have sparticuz
}
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// Multer setup for local and Vercel fallback
const uploadDir = process.env.VERCEL ? '/tmp/uploads' : path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
const upload = multer({ dest: uploadDir });
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, './'))); // Fallback for root files like deadlines.json


// --- SCRAPER LOGIC ---
async function performScrape() {
    const username = process.env.KULINO_USERNAME;
    const password = process.env.KULINO_PASSWORD;

    if (!username || !password) return { error: 'Kredensial tidak diset.' };

    let browser;
    try {
        if (chromiumPack) {
            browser = await chromium.launch({
                args: [...chromiumPack.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
                executablePath: await chromiumPack.executablePath(),
                headless: chromiumPack.headless,
            });
        } else {
            // Local fallback
            browser = await chromium.launch({ headless: true });
        }

        const context = await browser.newContext();
        const page = await context.newPage();

        // 1. Login
        await page.goto('https://kulino.dinus.ac.id/login/index.php');
        await page.fill('#username', username);
        await page.fill('#password', password);
        await page.click('#loginbtn');
        await page.waitForTimeout(3000);

        // 2. SCRAPE DASHBOARD (Dinamis)
        console.log('📋 Discovering courses...');
        await page.goto('https://kulino.dinus.ac.id/my/', { waitUntil: 'domcontentloaded' });
        
        const discoveredCourses = await page.evaluate(() => {
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

        console.log(`📚 Found ${discoveredCourses.length} courses dynamically.`);

        // Fallback to explicit courses if discovery fails (backward compatibility)
        const explicitCourses = [
            { title: "OTOMATA DAN TEORI BAHASA", url: "https://kulino.dinus.ac.id/course/view.php?id=30962" },
            { title: "JARINGAN KOMPUTER", url: "https://kulino.dinus.ac.id/course/view.php?id=30994" },
            { title: "PEMROGRAMAN BERBASIS OBJEK", url: "https://kulino.dinus.ac.id/course/view.php?id=31000" },
            { title: "PEMROGRAMAN WEB LANJUT", url: "https://kulino.dinus.ac.id/course/view.php?id=31030" },
            { title: "PEMBELAJARAN MESIN", url: "https://kulino.dinus.ac.id/course/view.php?id=31045" },
            { title: "SISTEM BASIS DATA", url: "https://kulino.dinus.ac.id/course/view.php?id=31078" },
            { title: "RANGKAIAN LOGIKA DIGITAL", url: "https://kulino.dinus.ac.id/course/view.php?id=31084" },
            { title: "LITERASI INFORMASI", url: "https://kulino.dinus.ac.id/course/view.php?id=31281" },
            { title: "BAHASA INGGRIS", url: "https://kulino.dinus.ac.id/course/view.php?id=31295" }
        ];

        const coursesToScrape = discoveredCourses.length > 0 ? discoveredCourses : explicitCourses;
        const allItems = [];

        for (const course of coursesToScrape) {

            await page.goto(course.url);
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
                const type = item.type.toLowerCase();
                const title = item.title.toLowerCase();
                const isTask = type.includes('assign') || type.includes('tugas') || type.includes('quiz') || 
                               title.includes('tugas') || title.includes('praktikum') || title.includes('pratikum') || title.includes('kuis');

                if (isTask) {
                    try {
                        const subPage = await context.newPage();
                        await subPage.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
                        
                        const deadlineInfo = await subPage.evaluate(() => {
                            const cells = Array.from(document.querySelectorAll('td, th'));
                            const labels = ['due date', 'batas waktu', 'time remaining', 'waktu tersisa'];
                            
                            for (let i = 0; i < cells.length; i++) {
                                const content = cells[i].textContent.toLowerCase();
                                if (labels.some(label => content.includes(label))) {
                                    // Usually the value is in the next td or within the same row
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
                        
                        // Parse deadline to timestamp for sorting
                        if (deadlineInfo) {
                            // Example format: "Wednesday, 19 March 2026, 11:59 PM"
                            const dt = new Date(deadlineInfo);
                            if (!isNaN(dt.getTime())) {
                                item.deadlineTimestamp = dt.getTime();
                            }
                        }
                        
                        await subPage.close();
                    } catch (e) {
                        console.warn(`⚠️ Gagal deteksi deadline mendalam untuk ${item.title}`);
                    }
                }
                allItems.push(item);
            }
        }

        await browser.close();
        
        // Simpan ke file cache jika lokal (biar performa cepat di reload berikutnya)
        if (!process.env.VERCEL) {
            fs.writeFileSync(path.join(__dirname, 'deadlines.json'), JSON.stringify(allItems, null, 2));
            // Juga copy ke public agar fetch() langsung ketemu
            fs.writeFileSync(path.join(__dirname, 'public/deadlines.json'), JSON.stringify(allItems, null, 2));
        }

        return allItems;

    } catch (err) {
        if (browser) await browser.close();
        throw err;
    }
}

// --- API ROUTES ---

app.get('/api/scrape', async (req, res) => {
    try {
        const data = await performScrape();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/submit', upload.single('file'), async (req, res) => {
    const { assignmentUrl } = req.body;
    const file = req.file;
    const username = process.env.KULINO_USERNAME;
    const password = process.env.KULINO_PASSWORD;

    if (!file || !assignmentUrl) return res.status(400).json({ error: 'File/URL tidak ada.' });

    let browser;
    try {
        if (chromiumPack) {
            browser = await chromium.launch({
                args: chromiumPack.args,
                executablePath: await chromiumPack.executablePath(),
                headless: chromiumPack.headless,
            });
        } else {
            browser = await chromium.launch({ headless: true });
        }
        const context = await browser.newContext();
        const page = await context.newPage();

        await page.goto('https://kulino.dinus.ac.id/login/index.php');
        await page.fill('#username', username);
        await page.fill('#password', password);
        await page.click('#loginbtn');
        await page.waitForTimeout(2000);

        await page.goto(assignmentUrl);
        const addBtn = await page.locator('button:has-text("Add submission"), button:has-text("Tambah pengajuan"), button:has-text("Edit submission")');
        if (await addBtn.count() > 0) {
            await addBtn.first().click();
        } else {
            throw new Error('Tombol submit tidak ditemukan.');
        }

        await page.waitForSelector('.fp-btn-add');
        await page.click('.fp-btn-add');
        const fileInput = await page.locator('input[type="file"]');
        await fileInput.setInputFiles(file.path);
        await page.click('.fp-upload-btn');
        await page.waitForSelector('.fp-file');
        await page.click('#id_submitbutton');
        await page.waitForNavigation();

        await browser.close();
        res.json({ message: 'Berhasil dikirim!' });
    } catch (err) {
        if (browser) await browser.close();
        res.status(500).json({ error: err.message });
    } finally {
        if (file) fs.unlinkSync(file.path);
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
