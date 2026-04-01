const jwt = require("jsonwebtoken");
const supabase = require('../config/supabaseAdmin'); // Supabase Admin client
const { decrypt } = require('../utils/crypto');

// Protect routes for regular users
const protect = async (req, res, next) => {
  let token;

  if (!req.headers.authorization?.startsWith("Bearer")) {
    return res.status(401).json({ message: "No token" });
  }

  try {
    token = req.headers.authorization.split(" ")[1];

    // Verify backend JWT
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const id = decoded.user.id;
    if (!id) {
      return res.status(401).json({ message: "Invalid token structure" });
    }

    // Fetch user profile from Supabase
    const { data: user, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !user) {
      return res.status(401).json({ message: "User not found" });
    }

    // Attach user to request
    req.user = {
      id: user.id,
      email: decrypt(user.email),
      username: user.username,
      current_city: user.current_city,
      preferred_language: user.preferred_language,
      children: user.children,
      is_verified_email: user.is_verified_email
    };

    next();
  } catch (error) {
    console.error("Auth Error:", error.message);
    return res.status(401).json({ message: "Not authorized, token failed" });
  }
};

// Protect routes for doctors
const protectDoctor = async (req, res, next) => {
  if (!req.headers.authorization?.startsWith("Bearer")) {
    return res.status(401).json({ message: "No token" });
  }

  try {
    const token = req.headers.authorization.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const doctorId = decoded.user.id;
    if (!doctorId) {
      return res.status(401).json({ message: "Invalid token role" });
    }

    // Fetch doctor from Supabase
    const { data: doctor, error } = await supabase
      .from('doctors')
      .select('*')
      .eq('id', doctorId)
      .single();

    if (error || !doctor) {
      return res.status(401).json({ message: "Doctor not found" });
    }

    req.doctor = doctor; // attach doctor identity
    next();
  } catch (error) {
    return res.status(401).json({ message: "Token invalid or expired" });
  }
};

module.exports = { protect, protectDoctor };