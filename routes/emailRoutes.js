const express = require("express");
const sendMail = require("../utils/nodemailer");
const router = express.Router();
const { hashForLookup, encrypt } = require("../utils/crypto");
const supabase = require('../config/supabaseAdmin');

router.post("/send", async (req, res) => {
  try {
    const { email, role } = req.body;
    if (!email) return res.status(400).json({ message: "Email required" });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes from now
    const hashEmail = hashForLookup(email);

    let tableName;
    if (role === "guardian") tableName = "profiles";
    else if (role === "doctor") tableName = "doctors";
    else return res.status(400).json({ message: "Invalid role" });

    // Check if profile already exists in THIS role's table
    const { data: profile, error: profileError } = await supabase
      .from(tableName)
      .select("*")
      .eq("email_hash", hashEmail)
      .single();

    if (profileError && profileError.code !== "PGRST116") {
      return res.status(500).json({ message: "Failed to fetch profile", error: profileError.message });
    }

    if (profile) {
      // ✅ Already registered in this role
      if (profile.google_id) {
        return res.status(409).json({ message: "This email is registered via Google. Please sign in with Google." });
      }

      // Just update OTP
      const { error: updateError } = await supabase
        .from(tableName)
        .update({
          email_verification_code: code,
          email_verification_expires: expires
        })
        .eq("email_hash", hashEmail);

      if (updateError) {
        return res.status(500).json({ message: "Failed to update OTP", error: updateError.message });
      }

    } else {
      // Not registered in this role yet — check if auth user already exists (other role)
      const { data: { users }, error: listError } = await supabase.auth.admin.listUsers();
      if (listError) {
        return res.status(500).json({ message: "Failed to check users", error: listError.message });
      }

      const existingAuthUser = users.find(u => u.email === email);
      let userId;

      if (existingAuthUser) {
        // ✅ Auth user exists (registered under another role) — reuse their ID
        userId = existingAuthUser.id;
      } else {
        // Brand new user — create auth account
        const { data: authData, error: insertInAuthError } = await supabase.auth.admin.createUser({
          email,
          email_confirm: false,
        });

        if (insertInAuthError) {
          return res.status(500).json({ message: "Failed to create user in Supabase Auth", error: insertInAuthError.message });
        }

        userId = authData.user.id;
      }

      // Insert into THIS role's table with the shared auth ID
      const { error: insertError } = await supabase
        .from(tableName)
        .insert({
          id: userId,
          email: encrypt(email),
          email_hash: hashEmail,
          email_verification_code: code,
          email_verification_expires: expires,
          is_verified_email: false
        });

      if (insertError) {
        return res.status(500).json({ message: "Failed to create profile", error: insertError.message });
      }
    }

    await sendMail(email, code);
    res.json({ message: "Code sent" });

  } catch (error) {
    console.error("Error sending email:", error);
    res.status(500).json({ error: "Failed to send email" });
  }
});

module.exports = router;