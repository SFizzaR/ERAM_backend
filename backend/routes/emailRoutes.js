const express = require("express");
const sendMail = require("../utils/nodemailer");
const router = express.Router();
const { hashForLookup } = require("../utils/crypto");
const User = require("../models/userModel")

router.post("/send", async (req, res) => {
  try {
    const { email } = req.body;
  if (!email) return res.status(400).json({ message: "Email required" });

  const hashEmail = hashForLookup(email);
  let user = await User.findOne({ emailHash: hashEmail });

  if (user) {
    return res.status(409).json({ message: "Email already registered" });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = Date.now() + 10 * 60 * 1000; // 10 min

  if (!user) {
    user = await User.create({
      email: encrypt(email),
      emailHash: hashEmail,
      emailVerificationCode: code,
      emailVerificationExpires: expires,
    });
  } else {
    user.emailVerificationCode = code;
    user.emailVerificationExpires = expires;
    await user.save();
  }

  // Send email (you can use your existing sendMail or add OTP template)
  await sendMail(email, code); // modify sendMail to send OTP

  res.json({ message: "Code sent" });
  } catch (error) {
    console.error("Error sending email:", error);
    res.status(500).json({ error: "Failed to send email" });
  }
});


module.exports = router;
