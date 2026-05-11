const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const verifyPMDC = async (pmdcNumber) => {
    let browser;
    try {
       browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',  // ✅ critical for Linux servers
        '--disable-gpu',             // ✅ no GPU on servers
        '--single-process',          // ✅ helps on low memory servers
        '--no-zygote'               // ✅ helps on low memory servers
    ]
});

        // ✅ Use incognito context so no cookies/cache carry over
const page = await browser.newPage();


        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        // ✅ Override navigator.webdriver to avoid detection
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

        await page.goto("https://pmdc.pk/", { waitUntil: "networkidle2", timeout: 30000 });

        try {
            await page.waitForSelector('#DocRegNo', { timeout: 8000 });
        } catch {
            return { found: false };
        }

        await page.click('#doc_reg_tab');
        await new Promise(r => setTimeout(r, 500));

        await page.click('#DocRegNo', { clickCount: 3 });
        await page.type('#DocRegNo', pmdcNumber);
        await new Promise(r => setTimeout(r, 300));

        await page.click('.fn-BtnDocRegNo');

        try {
            await page.waitForSelector('.fn-resultDiv:not(.d-none)', { timeout: 10000 });
            await page.waitForSelector('#resultTBody tr', { timeout: 8000 });
        } catch {
            return { found: false };
        }

        await new Promise(r => setTimeout(r, 500));

        const rowData = await page.evaluate((pmdcNum) => {
            const rows = document.querySelectorAll('#resultTBody tr');
            for (const row of rows) {
                const tds = row.querySelectorAll('td');
                if (tds[0]?.innerText.trim() === pmdcNum) {
                    return {
                        registrationNumber: tds[0]?.innerText.trim(),
                        fullName: tds[1]?.innerText.trim(),
                        fatherName: tds[2]?.innerText.trim(),
                        status: tds[3]?.innerText.trim(),
                    };
                }
            }
            return null;
        }, pmdcNumber);

        if (!rowData) {
            return { found: false };
        }

        await page.evaluate(() => {
            const modal = document.querySelector('#ViewDetailModal');
            if (modal) {
                modal.style.display = 'none';
                modal.classList.remove('show');
            }
            const tBody = document.querySelector('#tBody');
            if (tBody) tBody.innerHTML = '';
        });

        await new Promise(r => setTimeout(r, 300));

        await page.evaluate((pmdcNum) => {
            const links = document.querySelectorAll('#resultTBody a.fn-viewdetail');
            for (const link of links) {
                if (link.getAttribute('data-id') === pmdcNum) {
                    link.click();
                    return;
                }
            }
        }, pmdcNumber);

        await page.waitForSelector('#ViewDetailModal[style*="block"]', { timeout: 8000 });
        await new Promise(r => setTimeout(r, 1500));

        const modalData = await page.evaluate(() => {
            const getText = selector =>
                document.querySelector(selector)?.innerText.trim() || null;

            const qualRows = document.querySelectorAll('#tBody tr');
            const qualifications = Array.from(qualRows).map(row => {
                const tds = row.querySelectorAll('td');
                return {
                    degree: tds[0]?.innerText.trim() || '',
                    university: tds[1]?.innerText.trim() || '',
                    passingYear: tds[2]?.innerText.trim() || ''
                };
            }).filter(q => q.degree && q.degree !== 'No Data Found');

            return {
                validDate: getText('#license_valid'),
                qualifications
            };
        });

        return {
            found: true,
            ...rowData,
            validDate: modalData.validDate,
            qualifications: modalData.qualifications
        };

    } catch (err) {
        console.error("PMDC scraping error:", err.message);
        throw new Error("Failed to reach PMDC portal");
    } finally {
        if (browser) await browser.close();
    }
};

module.exports = { verifyPMDC };
