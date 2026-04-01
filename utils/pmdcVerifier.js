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

    // Wait for results
    await page.waitForSelector('#resultTBody tr', { timeout: 5000 });

    // Extract row basic info
    const rowData = await page.evaluate(() => {
        const row = document.querySelector('#resultTBody tr');
        if (!row) return null;

        const tds = row.querySelectorAll('td');
        return {
            registrationNumber: tds[0]?.innerText.trim(),
            fullName: tds[1]?.innerText.trim(),
            fatherName: tds[2]?.innerText.trim(),
            status: tds[3]?.innerText.trim(),
        };
    });

    if (!rowData) {
        await browser.close();
        return { found: false };
    }

    // Click "View Detail"
    await page.click('a.fn-viewdetail');

    // Wait for modal
    await page.waitForSelector('.modal-dialog', { visible: true });

    // Extract modal data
    const modalData = await page.evaluate(() => {
        const getText = selector =>
            document.querySelector(selector)?.innerText.trim() || null;

        return {
            validDate: getText('#license_valid')
        };
    });

    await browser.close();

    return {
        found: true,
        ...rowData,
        validDate: modalData.validDate
    };
};

module.exports = { verifyPMDC };
