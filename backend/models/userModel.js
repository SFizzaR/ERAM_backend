const mongoose = require('mongoose')

const userSchema = mongoose.Schema({
    email: {
        type: String,
        sparse: true,
        unique: [true, "Email address already taken"]
    },
    emailHash: { type: String, index: true, unique: true, sparse: true },
    password: {
        type: String,
        sparse: true
    },
    username: String,
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
    children: [
        {
            name: String,
            dateOfBirth: Date,
            level: Number,
            age: Number
        }
    ],

},
    {
        timestamps: true // ✅ automatically adds createdAt and updatedAt
    }
);

module.exports = mongoose.model("User", userSchema)