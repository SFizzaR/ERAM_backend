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
        const hashEmail = hashForLookup(email)
        const user = await User.findOne({ emailHash: hashEmail });
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }
        if (!user.isVerifiedEmail) {
            return res.status(400).json({ message: "Email not verified" });
        }
        if (user.password) {
            return res.status(400).json({ message: "User already registered" });
        }

        // Hash the password
        const hashPassword = await bcrypt.hash(password, 10);
        const age = calculateAge(child.dateOfBirth)

        if (age === null) {
            return res.status(400).json({ message: "Invalid date of birth" });
        }

        user.password = hashPassword;
        user.current_city = city;
        user.preferred_language = language;
        user.username = username;
        user.children = [{ ...child, age }];

        await user.save();

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
            email: decrypt(user.email),
            accessToken
        });
    }
    catch (err) {
        res.status(500).json({ message: "Server error", error: err.message });

    }

}));

router.get('/me', protect, expressAsyncHandler(async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password -emailHash'); // Exclude sensitive fields
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json({
      _id: user._id,
      email: decrypt(user.email), // Assuming you decrypt email
      username: user.username,
      // Add other fields as needed
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

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
         if (user && user.googleId && !user.password) {
            return res.status(409).json({ message: "This email is registered via Google. Please sign in with Google." });
        }
        // Check if user exists and if the password matches
         if (user && !user.isVerifiedEmail) {
            return res.status(400).json({ message: "Email not verified" });
        }
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

router.post("/verifyemail", async (req, res) => {

    const { email, code } = req.body;
  const hashEmail = hashForLookup(email);
  const user = await User.findOne({ emailHash: hashEmail });

  if (!user || user.emailVerificationCode !== code || Date.now() > user.emailVerificationExpires) {
    return res.status(400).json({ message: "Invalid or expired code" });
  }

  user.isVerifiedEmail = true;
  user.emailVerificationCode = null;
  user.emailVerificationExpires = null;
  await user.save();

  res.json({ message: "Verified" });
});

router.post('/google', async (req, res) => {
    const { email, googleId, name } = req.body;

    try {
        const plainEmail = email;
        const hashEmail = hashForLookup(plainEmail);
        let user = await User.findOne({ emailHash: hashEmail });  

        if (!user) {
            user = new User({  
                email: encrypt(plainEmail),
                emailHash: hashEmail,
                googleId,
                username: name,  
                current_city: '',  
                preferred_language: 'en',  
                children: []  
            });
            await user.save();
        } else if (!user.googleId) {
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


