const express = require('express');
const router = express.Router();
const expressAsyncHandler = require("express-async-handler");
const { hashForLookup, encrypt, decrypt } = require("../utils/crypto");
const { calculateAge } = require("../utils/ageCalculator");
const supabase = require('../config/supabaseAdmin');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { protect } = require("../middleware/protectMiddleware");

router.post('/register', expressAsyncHandler(async (req, res) => {
    const { email, password, city, language, username, child } = req.body;

    if (!email || !password || !city || !language || !username || !child) {
        return res.status(400).json({ message: "All fields are mandatory" });
    }

    const hashEmail = hashForLookup(email);

    // Supabase query
    const { data: user, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('email_hash', hashEmail)
        .single();
    if (error || !user) return res.status(404).json({ message: "User not found" });
    if (!user.is_verified_email) return res.status(400).json({ message: "Email not verified" });

    const age = calculateAge(child.dateOfBirth);
    if (age === null) return res.status(400).json({ message: "Invalid date of birth" });
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
    // Update profile
    const { data: updatedUser, error: updateError } = await supabase
        .from('profiles')
        .update({
            username,
            current_city: city,
            preferred_language: language,
        })
        .eq('email_hash', hashEmail)
        .select()
        .single();

    if (updateError) return res.status(500).json({ error: updateError.message });
    const { error: childInsertError } = await supabase
        .from('children').insert({
            name: child.name,
            date_of_birth: child.dateOfBirth,
            user_id: updatedUser.id
        });
    if (childInsertError) {
        console.error("Failed to insert child:", childInsertError);
        return res.status(500).json({ message: "Failed to add child", error: childInsertError.message });
    }
    const accessToken = jwt.sign(
        { user: { id: updatedUser.id } },
        process.env.JWT_SECRET,
        { expiresIn: "1h" }
    );

    res.status(201).json({
        _id: updatedUser.id,
        username: updatedUser.username,
        email: decrypt(updatedUser.email),
        accessToken
    });
}));

// -------------------- VERIFY EMAIL --------------------
router.post("/verifyemail", expressAsyncHandler(async (req, res) => {
    const { email, code } = req.body;

    if (!email || !code) {
        return res.status(400).json({ message: "Email and code are required" });
    }

    const hashEmail = hashForLookup(email);
    // Fetch only the fields we actually need
    const { data: user, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('email_hash', hashEmail)
        .single();

    if (error || !user) {
        return res.status(404).json({ message: "User not found" });
    }
    // ────────────────────────────────────────────────
    //          Core verification logic
    // ────────────────────────────────────────────────


    const codeMatches = user.email_verification_code === code;
    // ────────────────────────────────────────────────
    //          Decision
    // ────────────────────────────────────────────────
    if (!codeMatches) {
        return res.status(400).json({ message: "Invalid code" });
    }

    if (new Date() > new Date(user.email_verification_expires)) {
        return res.status(400).json({ message: "OTP expired" });

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
        .from('profiles')
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
// -------------------- GOOGLE LOGIN --------------------
router.post('/google', expressAsyncHandler(async (req, res) => {
    const { email, googleId, name } = req.body;
    if (!email || !googleId) {
        return res.status(400).json({ message: "Email and googleId are required" });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const hashEmail = hashForLookup(normalizedEmail);
    let isNewUser = false;

    // Ensure there is an auth.users record first, then mirror profile with same id.
    const { data: listedUsers, error: listUsersError } = await supabase.auth.admin.listUsers();
    if (listUsersError) {
        return res.status(500).json({ message: "Server error", error: listUsersError.message });
    }

    let authUser = listedUsers?.users?.find(u => (u.email || '').toLowerCase() === normalizedEmail);
    if (!authUser) {
        const { data: createdAuth, error: createAuthError } = await supabase.auth.admin.createUser({
            email: normalizedEmail,
            email_confirm: true,
        });

        if (createAuthError || !createdAuth?.user) {
            return res.status(500).json({ message: "Server error", error: createAuthError?.message || "Failed to create auth user" });
        }

        authUser = createdAuth.user;
    }

    // Lookup profile in Supabase
    let { data: user, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('email_hash', hashEmail)
        .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
        return res.status(500).json({ message: "Server error", error: error.message });
    }

    if (!user) {
        // Create new profile
        const { data: newUser, error: insertError } = await supabase
            .from('profiles')
            .insert([{
                id: authUser.id,
                email: encrypt(normalizedEmail),
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
        isNewUser = true;

    } else if (!user.google_id) {
        // Link Google account
        const { data: linkedUser, error: updateError } = await supabase
            .from('profiles')
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
        isNewUser,
    });
}));

router.post('/google/complete', protect, expressAsyncHandler(async (req, res) => {
    const { username, city, language = 'en', child } = req.body;

    if (req.user.role && req.user.role !== 'guardian') {
        return res.status(403).json({ message: "Only guardian accounts can complete this profile flow" });
    }

    if (!username || !city || !child?.name || !child?.dateOfBirth) {
        return res.status(400).json({ message: "username, city and child details are required" });
    }

    const age = calculateAge(child.dateOfBirth);
    if (age === null) {
        return res.status(400).json({ message: "Invalid date of birth" });
    }

    const { data: updatedUser, error: updateError } = await supabase
        .from('profiles')
        .update({
            username,
            current_city: city,
            preferred_language: language,
            is_verified_email: true,
        })
        .eq('id', req.user.id)
        .select()
        .single();

    if (updateError || !updatedUser) {
        return res.status(500).json({ message: "Failed to update profile", error: updateError?.message });
    }

    const { data: existingChildren, error: existingChildrenError } = await supabase
        .from('children')
        .select('id')
        .eq('user_id', req.user.id)
        .limit(1);

    if (existingChildrenError) {
        return res.status(500).json({ message: "Failed to check existing children", error: existingChildrenError.message });
    }

    if (!existingChildren || existingChildren.length === 0) {
        const { error: childInsertError } = await supabase
            .from('children')
            .insert({
                name: child.name,
                date_of_birth: child.dateOfBirth,
                user_id: req.user.id,
            });

        if (childInsertError) {
            return res.status(500).json({ message: "Failed to add child", error: childInsertError.message });
        }
    }

    res.status(200).json({
        message: 'Google profile completed successfully',
        _id: updatedUser.id,
        username: updatedUser.username,
    });
}));

router.post('/login', expressAsyncHandler(async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: "Email and password are required" });
    }

    const hashEmail = hashForLookup(email);

    // Optional: Check if profile exists first (for better error messages)
    const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('id, google_id, is_verified_email, username, email') // select only needed fields
        .eq('email_hash', hashEmail)
        .single();

    if (profileError || !profile) {
        return res.status(404).json({ message: "User not found" });
    }

    if (profile.google_id) {
        return res.status(409).json({ message: "This email is registered via Google. Please sign in with Google." });
    }

    if (!profile.is_verified_email) {
        return res.status(400).json({ message: "Email not verified" });
    }

    // Attempt login via Supabase Auth (this verifies password server-side)
    const { data: { user, session }, error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password: password,
    });

    if (signInError || !user || !session) {
        console.error("Sign in error:", signInError);
        // Supabase returns specific messages like "Invalid login credentials"
        return res.status(401).json({ message: signInError?.message || "Invalid credentials" });
    }

    // Optional: If you want to double-check email confirmed (though signInWithPassword requires it)
    if (!user.email_confirmed_at) {
        return res.status(400).json({ message: "Email not verified" });
    }

    // Generate your custom JWT if needed (or just return Supabase's session.access_token)
    const accessToken = jwt.sign(
        { user: { id: user.id } },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
    );

    res.status(200).json({
        _id: user.id,                           // or profile.supabase_uid if different
        email: decrypt(profile.email),
        username: profile.username,
        accessToken,                            // your JWT
        // Optional: session: session.access_token  // Supabase session token if you prefer
    });
}));

router.put('/changepassword', protect, expressAsyncHandler(async (req, res) => {
    const { password } = req.body;
    if (!password) {
        return res.status(400).json({ message: "New password is required" });
    }
    const { data, error } = await supabase.auth.admin.updateUserById(
        req.user.id,                // from auth.users.id
        { password: password }  // plain text — Supabase hashes it
    );
    if (error) {
        console.error("Supabase auth password update error:", error);
        return res.status(500).json({ message: "Failed to update password in Supabase Auth", error: error.message });
    }
    res.status(200).json({ message: "Password updated successfully" });
}));
// Update user profile
router.put('/updateUser', protect, expressAsyncHandler(async (req, res) => {
    try {
        const { language, city, username } = req.body;
        // Build update object dynamically
        const updates = {
            ...(username && { username }),
            ...(city && { current_city: city }),
            ...(language && { preferred_language: language })
        };

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ message: "No fields to update" });
        }

        // Update user in Supabase
        const { data: updatedUser, error } = await supabase
            .from('profiles')
            .update(updates)
            .eq('id', req.user.id)
            .select()
            .single();

        if (error) return res.status(500).json({ message: "Update failed", error: error.message });

        res.json({
            id: updatedUser.id,
            username: updatedUser.username,
            current_city: updatedUser.current_city,
            preferred_language: updatedUser.preferred_language,
            email: decrypt(updatedUser.email),
        });

    } catch (err) {
        res.status(500).json({ message: "Server error", error: err.message });
    }
}));

// Get current logged-in user
router.get('/me', protect, expressAsyncHandler(async (req, res) => {
    try {
        // Lookup user in Supabase by supabase_uid from JWT
        const { data: user, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', req.user.id)
            .single();

        if (error || !user) {
            return res.status(404).json({ message: 'User not found' });
        }
        res.json({
            _id: user.id,
            email: decrypt(user.email),       // decrypt stored email
            username: user.username,
            current_city: user.current_city,
            preferred_language: user.preferred_language,
        });
    } catch (err) {
        res.status(500).json({ message: "Server error", error: err.message });
    }
}));

router.get('/getChildren', protect, expressAsyncHandler(async (req, res) => {
    try {
        const { data: childrenResult, error } = await supabase
            .from('children')
            .select('id, name, date_of_birth, level')
            .eq('user_id', req.user.id);

        if (error) {
            console.error("Failed to fetch children:", error);
            return res.status(500).json({ message: "Failed to fetch children", error: error.message });
        }

        const children = childrenResult.map((child) => ({
            id: child.id,
            name: child.name,
            level: child.level,
            age: calculateAge(child.date_of_birth),
        }));

        res.json({ children });
    } catch (err) {
        res.status(500).json({ message: "Server error", error: err.message });
    }
}));

module.exports = router;