const mongoose = require('mongoose')

const doctorSchema = mongoose.Schema({
    password: String,
    FullName: String,
    pmdc_number: String,
    username: String,
    verificationStatus: {
        type: String,
        enum: ['verified', 'revoked', 'pending', 'rejected'],
        default: 'pending'
    },
    email: {
        type: String,
        sparse: true,
        unique: [true, "Email address already taken"]
    },
    emailVerificationCode: String,
    emailVerificationExpires: Date,
    isVerifiedEmail: { type: Boolean, default: false },
    emailHash: { type: String, index: true, unique: true, sparse: true },
    password: {
        type: String,
        sparse: true
    },
    supabase_uid: {
        type: String,
        unique: true,
        sparse: true
    },
    googleId: String,
    current_city: String,
    preferred_language: String,
    emailToken: {
        type: String,   // 🔑 holds a unique random token
        default: null
    },
    isVerifiedEmail: {
        type: Boolean,  // ✅ true after successful verification
        default: false
    },


},
    {
        timestamps: true // ✅ automatically adds createdAt and updatedAt
    }
);

module.exports = mongoose.model("Doctor", doctorSchema)