// middleware/protectMiddleware.js
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
    
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // SUPPORT BOTH FORMATS (old and new login routes)
    const mongoId = decoded.user?.id || decoded.id || decoded.user?._id;

    if (!mongoId) {
      return res.status(401).json({ message: "Invalid token structure" });
    }

    // Get MongoDB user
    const user = await User.findById(mongoId);
    if (!user) return res.status(401).json({ message: "User not found" });

    const realEmail = decrypt(user.email);
    let supabaseUid = user.supabase_uid;

    // Sync user to Supabase Auth if first time
    if (!supabaseUid) {
      const { data: sbUser, error } = await supabase.auth.admin.createUser({
        email: realEmail,
        password: `temp_${Math.random().toString(36)}@Pass123!`,
        email_confirm: true,
        user_metadata: { mongo_id: user._id.toString() }
      });

      if (error) {
        console.error("Supabase createUser error:", error.message);
        return res.status(500).json({ message: "Failed to sync with forum" });
      }

      supabaseUid = sbUser.user.id;
      user.supabase_uid = supabaseUid;
      await user.save();
    }

    // Sync profile (username + city) to Supabase
    const { error: profileError } = await supabase
      .from('profiles')
      .upsert({
        id: supabaseUid,
        username: user.username || "Anonymous User",
        current_city: user.current_city || null
      }, { onConflict: 'id' });

    if (profileError) {
      console.error('Profile sync error:', profileError.message);
      // Don't block the request — just log
    }

    // Attach to request
    req.user = user;                    // Full MongoDB user (for old routes)
    req.auth = { userId: supabaseUid }; // For Supabase RLS

    next();
  } catch (error) {
    console.error("Auth Error:", error.message);
    return res.status(401).json({ message: "Not authorized, token failed" });
  }
};

const protectDoctor = async (req, res, next) => {
  if (!req.headers.authorization?.startsWith("Bearer")) {
    return res.status(401).json({ message: "No token" });
  }

  try {
    const token = req.headers.authorization.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Only doctors allowed
    if (!decoded.doctorId) {
      return res.status(401).json({ message: "Invalid token role" });
    }

    const doctor = await Doctor.findById(decoded.doctorId);
    if (!doctor) {
      return res.status(401).json({ message: "Doctor not found" });
    }

    req.doctor = doctor;   // attach doctor identity
    next();
  } catch (error) {
    return res.status(401).json({ message: "Token invalid or expired" });
  }
};


module.exports = { protect, protectDoctor };
