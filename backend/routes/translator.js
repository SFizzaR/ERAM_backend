const express = require("express");
const { translateSmart } = require("../utils/translator");

const router = express.Router();

// simple Urdu detection
const isUrduText = (text) => /[\u0600-\u06FF]/.test(text);

router.post("/", async (req, res) => {
  const { text, targetLang } = req.body;

  if (!text) {
    return res.status(400).json({ error: "Text is required" });
  }

  try {
    // If frontend doesn't send targetLang, auto decide
    let target = targetLang;

    if (!target) {
      target = isUrduText(text) ? "en" : "ur";
    }

    const translated = await translateSmart(text, target);

    res.json({
      translated,
      detectedTarget: target,
    });
  } catch (error) {
    console.error("API error:", error);
    res.status(500).json({ error: "Translation failed" });
  }
});

module.exports = router;