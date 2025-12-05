const jwt = require("jsonwebtoken");
const User = require('../models/userModel');
const { supabase } = require('../lib/supabase');
const { decrypt } = require('../utils/crypto');  

const protect = async (req, res, next) => {
    let token;

    if (!req.headers.authorization?.startsWith("Bearer")) {
        return res.status(401).json({ message: "No token" });
    }

    try {
        token = req.headers.authorization.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Get MongoDB user
        const user = await User.findById(decoded.user.id);
        if (!user) return res.status(401).json({ message: "User not found" });

        const realEmail = decrypt(user.email);  
        let supabaseUid = user.supabase_uid;

        if (!supabaseUid) {
            // Create user in Supabase Auth using REAL email
            const { data: sbUser, error } = await supabase.auth.admin.createUser({
                email: realEmail,                   
                password: `temp_${Math.random().toString(36).slice(2)}@Pass123!`,
                email_confirm: true,
                user_metadata: { mongo_id: user._id.toString() }
            });

            if (error) {
                console.error("Supabase createUser error:", error.message);
                return res.status(500).json({ message: "Failed to sync user with forum" });
            }

            supabaseUid = sbUser.user.id;

            // Save the Supabase UID back to MongoDB
            user.supabase_uid = supabaseUid;
            await user.save();
        }

        // Attach both for maximum compatibility
        req.user = user;                            // MongoDB user (your old routes)
        req.auth = { userId: supabaseUid };         // ← Forum routes use this

        next();
    } catch (error) {
        console.error("Auth Error:", error.message);
        res.status(401).json({ message: "Not authorized" });
    }
};

module.exports = { protect };
