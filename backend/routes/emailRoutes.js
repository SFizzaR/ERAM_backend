const express = require("express");
const sendMail = require("../utils/nodemailer");
const router = express.Router();
const { hashForLookup } = require("../utils/crypto");
const User = require("../models/userModel")

router.post("/send", async (req, res) => {
    try {
        const { email } = req.body; // get recipient from JSON body
        const emailToken = Math.random().toString(36).substring(2, 10); // simple random token
        const hashEmail = hashForLookup(email)
        const user = await User.findOne({ emailHash: hashEmail });
        if (!user) {
            res.status(400).json({ message: "User not found" });
            return
        }
        user.emailToken = emailToken;
        await user.save();

        await sendMail(email, emailToken);
        res.status(200).json({ message: "Email sent successfully!" });
    } catch (error) {
        console.error("Error sending email:", error);
        res.status(500).json({ error: "Failed to send email" });
    }
});

module.exports = router;