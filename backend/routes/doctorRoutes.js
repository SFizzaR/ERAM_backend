const { Router } = require('express');
const { verifyPMDC } = require('./../utils/pmdcVerifier');
const { hashForLookup, decrypt, encrypt } = require("../utils/crypto");
const { protectDoctor } = require("../middleware/protectMiddleware")
const expressAsyncHandler = require("express-async-handler");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const router = Router();
const supabase = require('../config/supabaseAdmin');


router.post("/verifyemail", expressAsyncHandler(async (req, res) => {
    const { email, code } = req.body;

    if (!email || !code) {
        return res.status(400).json({ message: "Email and code are required" });
    }

    const hashEmail = hashForLookup(email);
    // Fetch only the fields we actually need
    const { data: user, error } = await supabase
        .from('doctors')
        .select('*')
        .eq('email_hash', hashEmail)
        .single();

    if (error || !user) {
        return res.status(404).json({ message: "User not found" });
    }
    // ────────────────────────────────────────────────
    //          Core verification logic
    // ────────────────────────────────────────────────

    // Parse expiration timestamp from Supabase (should be ISO string like "2026-03-06T08:58:08.851Z")
    console.log("expire: ", user.email_verification_expires, " now: ", new Date())
    const codeMatches = user.email_verification_code === code;
    if (new Date() > new Date(user.email_verification_expires)) {
        return res.status(400).json({ message: "OTP expired" });

    }
    // ────────────────────────────────────────────────
    //          Decision
    // ────────────────────────────────────────────────
    if (!codeMatches) {
        return res.status(400).json({ message: "Invalid code" });
    }
    // If already verified → you may want to allow or reject depending on your policy
    if (user.is_verified_email === true) {
        return res.status(200).json({ message: "Email already verified" });
    }
    if (error || !user) {
        return res.status(404).json({ message: "User profile not found" });
    }

    // ────────────────────────────────────────────────
    //          Success – update profile
    // ────────────────────────────────────────────────
    const { error: authError } = await supabase.auth.admin.updateUserById(user.id, {
        email_confirm: true  // ✅ correct field name
    });
    if (authError) {
        return res.status(500).json({ message: "Failed to confirm email", error: authError.message });
    }
    const { data: updated, error: updateError } = await supabase
        .from('doctors')
        .update({
            email_verification_code: null, // Clear token after successful verification
            is_verified_email: true
        })
        .eq('email_hash', hashEmail);

    if (updateError) {
        console.error("Supabase update error:", updateError);
        return res.status(500).json({ message: "Failed to update password in Supabase Auth", error: authError.message });
    }

    return res.status(200).json({
        message: "Email verified successfully", // optional – return minimal safe data
    });
}));

router.post("/verifypmdc", expressAsyncHandler(async (req, res) => {
    try {
        const { name, pmdcNumber, fatherName, id } = req.body;

        if (!name || !pmdcNumber || !id) {
            return res.status(400).json({ error: "name, pmdcNumber and id required" });
        }

        // Call your external PMDC verification function (scraping/web search)
        const result = await verifyPMDC(pmdcNumber);

        const today = new Date().toISOString().split('T')[0];

        // Case 1: License expired
        if (result.validDate < today) {
            await supabase
                .from('doctors')
                .update({
                    verification_status: "rejected",
                    reason: "PMDC License Expired"
                })
                .eq('id', id)
                .select()
                .single();  // We don't need the result here, but can check if needed

            return res.status(400).json({ error: "PMDC License Expired" });
        }

        // Case 2: Not found
        if (!result.found) {
            await supabase
                .from('doctors')
                .update({
                    verification_status: "rejected",
                    reason: "PMDC number not found"
                })
                .eq('id', id)
                .select()
                .single();

            return res.json({ verified: false, message: "PMDC number not found" });
        }

        // Case 3: Name mismatch (case-insensitive comparison recommended)
        if (result.fullName.toUpperCase() !== name.toUpperCase()) {
            await supabase
                .from('doctor_verification_logs')
                .update({
                    verification_status: "rejected",
                    reason: "Name does not match"
                })
                .eq('id', id)
                .select()
                .single();

            return res.json({ verified: false, message: "Name does not match" });
        }

        // Optional: Father's name check
        if (fatherName && result.fatherName?.toUpperCase() !== fatherName.toUpperCase()) {
            await supabase
                .from('doctors')
                .update({
                    verification_status: "rejected",
                    reason: "Father's name does not match"
                })
                .eq('id', id)
                .select()
                .single();

            return res.json({ verified: false, message: "Father's name does not match" });
        }

        // ✅ Success: Update verification log
        const { data: log, error: logError } = await supabase
            .from('doctors')
            .update({
                verification_status: "verified",
                reason: "PMDC verification successful"
            })
            .eq('id', id)
            .select()
            .single();

        if (logError || !log) {
            console.error("Log update failed:", logError);
            return res.status(404).json({ error: "Verification log not found or update failed" });
        }

        // ✅ Update doctor profile
        const { data: updatedDoctor, error: doctorError } = await supabase
            .from('doctors')
            .update({
                verification_status: "verified",   // snake_case recommended in Supabase
                pmdc_number: pmdcNumber
            })
            .eq('id', log.id)   // assuming log has doctorId column linking to doctors.id
            .select()
            .single();

        if (doctorError || !updatedDoctor) {
            console.error("Doctor update failed:", doctorError);
            return res.status(404).json({ error: "Doctor not found or update failed" });
        }

        // Generate JWT (using doctor id)
        const accessToken = jwt.sign(
            {
                user: { id: updatedDoctor.id }
            },  // include role if needed for authorization

            process.env.JWT_SECRET,
            { expiresIn: "1h" }
        );

        return res.status(200).json({
            _id: updatedDoctor.id,
            email: decrypt(updatedDoctor.email),
            accessToken,
            verified: true,
            data: result
        });

    } catch (err) {
        console.error("Verification error:", err);
        res.status(500).json({ error: "Verification failed", details: err.message });
    }
}));

router.post('/register', expressAsyncHandler(async (req, res) => {
    try {
        const { email, password, city, language, fullname, pmdc, fatherName, username } = req.body;

        if (!email || !password || !city || !language || !fullname || !pmdc || !username) {
            return res.status(400).json({ message: "All fields are mandatory" });
        }

        const hashEmail = hashForLookup(email)

        const { data: user, error } = await supabase
            .from('doctors')
            .select('*')
            .eq('email_hash', hashEmail)
            .single();
        if (error || !user) return res.status(404).json({ message: "User not found" });

        if (!user.is_verified_email) return res.status(400).json({ message: "Email not verified" });

        if (user.username) {
            return res.status(400).json({ message: "User already registered" });
        }
        const { data: updated, error: authError } = await supabase.auth.admin.updateUserById(
            user.id,  // e.g. updatedUser.supabase_uid from your profiles query
            { password: password }  // plain text new password
        );

        if (authError) {
            console.error("Supabase auth password update error:", authError);
            return res.status(500).json({ message: "Failed to update password in Supabase Auth", error: authError.message });
        }

        const { data: updatedUser, error: updateError } = await supabase
            .from('doctors')
            .update({
                username,
                current_city: city,
                preferred_language: language,
                full_name: fullname,
                pmdc_number: pmdc,
                father_name: fatherName || '',
            })
            .eq('email_hash', hashEmail)
            .select()
            .single();

        if (updateError) return res.status(500).json({ error: updateError.message });

        const accessToken = jwt.sign(
            { user: { id: updatedUser.id } },
            process.env.JWT_SECRET,
            { expiresIn: "1h" }
        );


        res.status(201).json({
            _id: updatedUser.id,
            email: decrypt(updatedUser.email),
            username: updatedUser.username,
            accessToken,
        });
    }
    catch (err) {
        res.status(500).json({ message: "Server error", error: err.message });

    }

}));

router.get('/me', protectDoctor, expressAsyncHandler(async (req, res) => {
    try {
        const { data: user, error } = await supabase
            .from('doctors')
            .select('*')
            .eq('id', req.doctor.id)
            .single();

        if (error || !user) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.json({
            _id: user.id,
            email: decrypt(user.email),
            FullName: user.fullname,
            username: user.username,
            // Add other fields as needed
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}));

router.put('/changepassword', protectDoctor, expressAsyncHandler(async (req, res) => {
    const { password } = req.body;
    if (!password) {
        return res.status(400).json({ message: "New password is required" });
    }
    const { data, error } = await supabase.auth.admin.updateUserById(
        req.doctor.id,                // from auth.users.id
        { password: password }  // plain text — Supabase hashes it
    );
    if (error) {
        console.error("Supabase auth password update error:", error);
        return res.status(500).json({ message: "Failed to update password in Supabase Auth", error: error.message });
    }
    res.status(200).json({ message: "Password updated successfully" });
}));

router.put('/update', protectDoctor, expressAsyncHandler(async (req, res) => {
    try {
        const { language, city, username } = req.body

        const { data: updatedUser, error } = await supabase
            .from('doctors')
            .update({
                preferred_language: language || req.doctor.preferred_language,
                current_city: city || req.doctor.current_city,
                username: username || req.doctor.username,
            })
            .eq('id', req.doctor.id)
            .select()
            .single();
        if (error || !updatedUser) {
            return res.status(404).json({ message: "User not found or update failed", error: error ? error.message : "Unknown error" });
        }
        res.status(200).json({
            message: "Profile updated successfully",
            user: updatedUser
        });
    }

    catch (err) {
        res.status(500).json({ error: err.message });
    }
}));

router.post('/google', expressAsyncHandler(async (req, res) => {
    const { email, googleId, name } = req.body;
    const hashEmail = hashForLookup(email);

    // Lookup profile in Supabase
    let { data: user, error } = await supabase
        .from('doctors')
        .select('*')
        .eq('email_hash', hashEmail)
        .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
        return res.status(500).json({ message: "Server error", error: error.message });
    }

    if (!user) {
        // Create new profile
        const { data: newUser, error: insertError } = await supabase
            .from('doctors')
            .insert([{
                email: encrypt(email),
                email_hash: hashEmail,
                google_id: googleId,
                username: name,
                current_city: '',
                preferred_language: 'en',
                is_verified_email: true
            }])
            .select()
            .single();


        if (insertError) return res.status(500).json({ message: "Server error", error: insertError.message });
        user = newUser;

    } else if (!user.google_id) {
        // Link Google account
        const { data: linkedUser, error: updateError } = await supabase
            .from('doctors')
            .update({ google_id: googleId })
            .eq('email_hash', hashEmail)
            .select()
            .single();

        if (updateError) return res.status(500).json({ message: "Server error", error: updateError.message });
        user = linkedUser;
    }

    // Generate backend JWT
    const token = jwt.sign(
        { user: { id: user.id } },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
    );

    res.status(201).json({
        _id: user.id,
        email: decrypt(user.email),
        username: user.username,
        token,
    });
}));

router.post('/login', expressAsyncHandler(async (req, res) => {
    try {
        const { email, password } = req.body;

        // Check for missing fields
        if (!email || !password) {
            res.status(400).json({ message: "Input correct credentials for login" });
            return; // Ensure no further code runs
        }


        hashEmail = hashForLookup(email)
        // Find the user by email or username
        const { data: profile, error: profileError } = await supabase
            .from('doctors')
            .select('id, google_id, is_verified_email, username, email, verification_status') // select only needed fields
            .eq('email_hash', hashEmail)
            .single();

        if (profileError) {
            console.error("Profile lookup error:", profileError);
            return res.status(404).json({ message: "User not found" });
        }
        if (profile && profile.google_id) {
            return res.status(409).json({ message: "This email is registered via Google. Please sign in with Google." });
        }
        // Check if user exists and if the password matches
        if (profile && !profile.is_verified_email) {
            return res.status(400).json({ message: "Email not verified" });
        }
        if (profile && profile.verification_status !== 'verified') {
            return res.status(400).json({ message: "Doctor not verified" });
        }
        const { data: { user, session }, error: signInError } = await supabase.auth.signInWithPassword({
            email: decrypt(profile.email),
            password: password,
        });

        if (signInError || !user || !session) {
            console.error("Sign in error:", signInError);
            // Supabase returns specific messages like "Invalid login credentials"
            return res.status(401).json({ message: signInError?.message || "Invalid credentials" });
        }
        // Generate an access token
        const accessToken = jwt.sign(
            { user: { id: profile.id } }, // ✅ Change `doc.id` to `doc._id`
            process.env.JWT_SECRET,
            { expiresIn: "1h" }
        );


        res.status(200).json({
            _id: profile.id,
            email: decrypt(profile.email),
            accessToken,
        });

    }
    catch (err) {
        res.status(500).json({ error: err.message });

    }
}));





module.exports = router;