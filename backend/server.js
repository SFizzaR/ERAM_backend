const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
require('dotenv').config();
const path = require('path');


const userRoutes = require('./routes/userRoutes');
const emailRoutes = require('./routes/emailRoutes');
const questionnaireRoutes = require('./routes/questionnaireRoutes');
const forumRoutes = require('./routes/forumRoutes');
const doctorRoutes = require('./routes/doctorRoutes');


const app = express();
const port = process.env.PORT;

if (!port) {
    console.error("❌ Render PORT is not defined. Exiting.");
    process.exit(1);
}


// Middleware
app.use(cors());
app.use(express.json());

// ✅ Connect to MongoDB with Mongoose
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB connected"))
    .catch(err => console.error("❌ MongoDB connection error:", err));

// Routes
app.use('/user', userRoutes);
app.use('/email', emailRoutes);
app.use('/questionnaire', questionnaireRoutes);
app.use('/api/forum', forumRoutes)
app.use('/doctor', doctorRoutes);


app.use('/public', express.static(path.join(__dirname, 'public')));

// Start server


app.listen(port, () => {
    console.log(`🚀 Server listening on port ${port}`);
});




