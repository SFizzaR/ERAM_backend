const expressAsyncHandler = require("express-async-handler");
const express = require('express');
const User = require("../models/userModel");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const router = express.Router();
const { protect } = require("../middleware/protectMiddleware")
const { hashForLookup, encrypt, decrypt } = require("../utils/crypto");
const { calculateAge } = require("../utils/ageCalculator")

router.post('/register', expressAsyncHandler(async (req, res) => {
    try {
        const { email, password, city, language, username, child } = req.body;

        if (!email || !password || !city || !language || !username || !child) {
            res.status(400).json({ message: "All fields are mandatory" });
            return;
        }
        hashEmail = hashForLookup(email)
        const userAvailable = await User.findOne({ emailHash: hashEmail });
        if (userAvailable) {
            res.status(400).json({ message: "User already registered" });
            return; // Stop further execution
        }

        // Hash the password
        const hashPassword = await bcrypt.hash(password, 10);
        age = calculateAge(child.dateOfBirth)

        if (age === null) {
            return res.status(400).json({ message: "Invalid date of birth" });
        }

        child.age = age

        const user = await User.create({
            email: encrypt(email),
            emailHash: hashEmail,
            password: hashPassword,
            current_city: city,
            preferred_language: language,
            username: username,
            children: child
        })


        if (user) {
            console.log(`User created ${user}`)

            const accessToken = jwt.sign(
                {
                    user: {
                        id: user._id,
                    }
                },
                process.env.JWT_SECRET,
                { expiresIn: "1h" }
            );

            res.status(201).json({
                _id: user.id,
                username: user.username,
                email: encrypt(user.email),
                accessToken
            });
        }
    }
    catch (err) {
        res.status(500).json({ message: "Server error", error: err.message });

    }

}))

router.put('/updateUser', protect, expressAsyncHandler(async (req, res) => {
    try {
        const { language, city, username } = req.body
        const updateUser = await User.findByIdAndUpdate(
            req.user.id,
            {
                $set: {
                    ...(username && { username: username }),
                    ...(city && { current_city: city }),
                    ...(language && { preferred_language: language }),
                }
            },
            { new: true }
        )
        res.json(updateUser);
    }

    catch (err) {
        res.status(500).json({ error: err.message });
    }
}))

router.put('/addChildren', protect, expressAsyncHandler(async (req, res) => {
    try {
        const children = req.body.children; // expecting an array
        if (!children || children.length === 0) {
            return res.status(400).json({ message: "No children to add" });
        }
        children.forEach((child, index) => {
            const age = calculateAge(child.dateOfBirth);
            if (age === null) {
                return res.status(400).json({ message: `Invalid date of birth for child ${index + 1}` });
            }
            child.age = age;
        });

        const updatedUser = await User.findByIdAndUpdate(
            req.user.id,
            {
                $push: { children: { $each: children } } // push multiple children
            },
            { new: true } // return updated document
        );

        res.json(updatedUser);
    } catch (err) {
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
        const user = await User.findOne({ emailHash: hashEmail });

        // Check if user exists and if the password matches
        if (user && (await bcrypt.compare(password, user.password))) {
            // Generate an access token
            const accessToken = jwt.sign(
                { user: { id: user._id } }, // ✅ Change `user.id` to `user._id`
                process.env.JWT_SECRET,
                { expiresIn: "1h" }
            );


            res.status(200).json({
                _id: user.id,
                email: decrypt(user.email),
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

router.patch("/verifyemail", async (req, res) => {

    const emailToken = req.body.emailToken;
    console.log(emailToken)
    if (!emailToken) {
        return res.status(400).json({ status: "Failed", error: "empty request" });
    }
    let user = await User.findOne({ where: { emailToken: emailToken } });

    if (!user) {
        return res.status(404).json({ status: "Failed", error: "User not found" });
    }

    await User.update(
        { isVerifiedEmail: true, emailToken: null },
        { where: { emailToken: emailToken } }
    );
    await User.findOne({ where: { emailToken: emailToken } });
    return res
        .status(200)
        .json({ status: "Success", message: "User verified successfully" });
});

router.post('/google', async (req, res) => {
    const { email, googleId, name } = req.body;

    try {
        const plainEmail = email;
        const hashEmail = hashForLookup(plainEmail);
        let user = await User.findOne({ emailHash: hashEmail });  // Fixed: User instead of users

        if (!user) {
            user = new User({  // Fixed: User instead of users
                email: encrypt(plainEmail),
                emailHash: hashEmail,
                googleId,
                username: name,  // Map name to username
                current_city: '',  // Default; prompt on frontend if needed
                preferred_language: 'en',  // Default
                children: []  // Default empty
            });
            await user.save();
        } else if (!user.googleId) {
            // If email exists but no googleId, link the account
            user.googleId = googleId;
            await user.save();
            console.log(`Linked Google account for user ${user._id}`);
        }

        const token = jwt.sign(
            { user: { id: user._id } },
            process.env.JWT_SECRET,
            { expiresIn: '1h' }
        );

        res.status(201).json({
            _id: user._id,  // Fixed: _id
            email: decrypt(user.email),
            username: user.username,
            token,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;
