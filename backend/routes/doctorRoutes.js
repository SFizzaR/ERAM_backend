const { Router } = require('express');
const { verifyPMDC } = require('./../utils/pmdcVerifier');
const { hashForLookup, decrypt } = require("../utils/crypto");
const doctor = require('../models/doctorModel');
const doctorVerificationLog = require('../models/DoctorVerificationLog');
const { protectDoctor } = require("../middleware/protectMiddleware")
const expressAsyncHandler = require("express-async-handler");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const router = Router();

router.post("/verifyemail", expressAsyncHandler(async (req, res) => {

    const { email, code } = req.body;
    const hashEmail = hashForLookup(email);
    const doc = await doctor.findOne({ emailHash: hashEmail });

    if (!doc || doc.emailVerificationCode !== code || Date.now() > doc.emailVerificationExpires) {
        return res.status(400).json({ message: "Invalid or expired code" });
    }

    doc.isVerifiedEmail = true;
    doc.emailVerificationCode = null;
    doc.emailVerificationExpires = null;
    await doc.save();

    res.json({ message: "Verified" });
}));

router.post("/verifypmdc", expressAsyncHandler(async (req, res) => {
    try {
        const { name, pmdcNumber, fatherName, id } = req.body;

        if (!name || !pmdcNumber || !id) {
            return res.status(400).json({ error: "name, pmdcNumber and id required" });
        }

        const result = await verifyPMDC(pmdcNumber);
        if (result.validDate < new Date().toISOString().split('T')[0]) {
            await doctorVerificationLog.findByIdAndUpdate(id, {
                status: "rejected",
                reason: "PMDC License Expired"
            });
            return res.status(400).json({ error: "PMDC License Expired" });
        }
        if (!result.found) {
            await doctorVerificationLog.findByIdAndUpdate(id, {
                status: "rejected",
                reason: "PMDC number not found"
            });

            return res.json({ verified: false, message: "PMDC number not found" });
        }

        if (result.fullName !== name.toUpperCase()) {
            await doctorVerificationLog.findByIdAndUpdate(id, {
                status: "rejected",
                reason: "Name does not match"
            });

            return res.json({ verified: false, message: "Name does not match" });
        }

        if (fatherName && result.fatherName !== fatherName.toUpperCase()) {
            await doctorVerificationLog.findByIdAndUpdate(id, {
                status: "rejected",
                reason: "Father's name does not match"
            });

            return res.json({ verified: false, message: "Father's name does not match" });
        }

        // ✅ Update verification log
        const log = await doctorVerificationLog.findByIdAndUpdate(
            id,
            {
                status: "verified",
                reason: "PMDC verification successful"
            },
            { new: true }
        );

        if (!log) {
            return res.status(404).json({ error: "Verification log not found" });
        }

        // ✅ Update doctor
        const updatedoc = await doctor.findByIdAndUpdate(
            log.doctorId,
            {
                verificationStatus: "verified",
                pmdc_number: pmdcNumber
            },
            { new: true }
        );

        if (!updatedoc) {
            return res.status(404).json({ error: "Doctor not found" });
        }

        const accessToken = jwt.sign(
            { user: { id: updatedoc._id } },
            process.env.JWT_SECRET,
            { expiresIn: "1h" }
        );

        return res.status(200).json({
            _id: updatedoc._id,
            email: decrypt(updatedoc.email),
            accessToken,
            verified: true,
            data: result
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Verification failed" });
    }
}));


router.post('/register', expressAsyncHandler(async (req, res) => {
    try {
        const { email, password, city, language, fullname, pmdc, fatherName, username } = req.body;

        if (!email || !password || !city || !language || !fullname || !pmdc || !username) {
            return res.status(400).json({ message: "All fields are mandatory" });
        }

        const hashEmail = hashForLookup(email)
        const doc = await doctor.findOne({ emailHash: hashEmail });
        if (!doc) {
            return res.status(404).json({ message: "Doctor not found" });
        }
        if (!doc.isVerifiedEmail) {
            return res.status(400).json({ message: "Email not verified" });
        }
        if (doc.password) {
            return res.status(400).json({ message: `Doctor already registered` });
        }

        // Hash the password
        const hashPassword = await bcrypt.hash(password, 10);

        doc.FullName = fullname;
        doc.password = hashPassword;
        doc.current_city = city;
        doc.preferred_language = language;
        doc.username = username;
        await doc.save();

        log = await doctorVerificationLog.create({
            doctorId: doc._id,
            status: 'pending',
            pmdc_number: pmdc,
            fullName: fullname,
            fatherName: fatherName || '',
        });

        return res.status(201).json({
            _id: log._id,
            email: decrypt(doc.email),
            pmdc_number: doc.pmdc_number,
            fullname: doc.FullName,
            fatherName: fatherName || '',
            username: doc.username
        });
    }
    catch (err) {
        res.status(500).json({ message: "Server error", error: err.message });

    }

}));

router.get('/me', protectDoctor, expressAsyncHandler(async (req, res) => {
    try {
        const doc = await doctor.findById(req.user.id).select('-password -emailHash'); // Exclude sensitive fields
        if (!doc) {
            return res.status(404).json({ message: 'Doctor not found' });
        }
        res.json({
            _id: doc._id,
            email: decrypt(doc.email), // Assuming you decrypt email
            FullName: doc.FullName,
            username: doc.username,
            // Add other fields as needed
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}));

router.put('/update', protectDoctor, expressAsyncHandler(async (req, res) => {
    try {
        const { language, city, username } = req.body
        const updateUser = await doctor.findByIdAndUpdate(
            req.user.id,
            {
                $set: {
                    ...(city && { current_city: city }),
                    ...(language && { preferred_language: language }),
                    ...(username && { username: username })
                }
            },
            { new: true }
        )
        res.json(updateUser);
    }

    catch (err) {
        res.status(500).json({ error: err.message });
    }
}));

router.post('/login', expressAsyncHandler(async (req, res) => {
    try {
        const { email, password } = req.body;

        // Check for missing fields
        if (!email && !password) {
            res.status(400).json({ message: "Input correct credentials for login" });
            return; // Ensure no further code runs
        }


        hashEmail = hashForLookup(email)
        // Find the user by email or username
        const doc = await doctor.findOne({ emailHash: hashEmail });

        if (doc && doc.googleId && !doc.password) {
            return res.status(409).json({ message: "This email is registered via Google. Please sign in with Google." });
        }
        // Check if user exists and if the password matches
        if (doc && !doc.isVerifiedEmail) {
            return res.status(400).json({ message: "Email not verified" });
        }
        if (doc && doc.verificationStatus !== 'verified') {
            return res.status(400).json({ message: "Doctor not verified" });
        }
        if (doc && (await bcrypt.compare(password, doc.password))) {
            // Generate an access token
            const accessToken = jwt.sign(
                { user: { id: doc._id } }, // ✅ Change `doc.id` to `doc._id`
                process.env.JWT_SECRET,
                { expiresIn: "1h" }
            );


            res.status(200).json({
                _id: doc._id,
                email: decrypt(doc.email),
                accessToken,
            });


        } else {
            res.status(401).json({ message: "Invalid credentials" });
        }
    }
    catch (err) {
        res.status(500).json({ error: err.message });

    }
}));





module.exports = router;