const puppeteer = require("puppeteer");

const verifyPMDC = async (pmdcNumber) => {
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        slowMo: 50
    });

    const page = await browser.newPage();
    await page.goto("https://pmdc.pk/", { waitUntil: "networkidle2" });

    // Type the PMDC number
    await page.type('#DocRegNo', pmdcNumber);

    // Click search button
    await page.click('.fn-BtnDocRegNo');

    // Wait for the tbody with results
    await page.waitForSelector('#resultTBody tr', { timeout: 5000 }).catch(() => console.log("No results found"));

    // Extract the first row
    const result = await page.evaluate(async () => {
        const row = document.querySelector('#resultTBody tr');
        if (!row) return { found: false };

        const tds = row.querySelectorAll('td')

        page.click('a.fn-viewdetail');
        await page.waitForSelector('.modal-content', { visible: true });

        const details = await page.evaluate(() => {
            const validDate = document.querySelector('#license_valid').innerText.trim();
            return { validDate };
        });
        return {
            found: true,
            registrationNumber: tds[0]?.innerText.trim(),
            fullName: tds[1]?.innerText.trim(),
            fatherName: tds[2]?.innerText.trim(),
            status: tds[3]?.innerText.trim(),
            validDate: details.validDate
        };
    });

    await browser.close();
    console.log(result);
    return result;
};

module.exports = { verifyPMDC };
