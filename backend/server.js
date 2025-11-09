const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
require('dotenv').config();
const path = require('path');


const userRoutes = require('./routes/userRoutes');
const emailRoutes = require('./routes/emailRoutes');
const questionnaireRoutes = require('./routes/questionnaireRoutes');

const app = express();
const port = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// ✅ Connect to MongoDB with Mongoose
mongoose.connect(process.env.DB_STRING)
    .then(() => console.log("✅ MongoDB connected"))
    .catch(err => console.error("❌ MongoDB connection error:", err));

// Routes
app.use('/user', userRoutes);
app.use('/email', emailRoutes);
app.use('/questionnaire', questionnaireRoutes);

app.use('/public', express.static(path.join(__dirname, 'public')));

// Start server


app.listen(port, () => {
    console.log(`🚀 Server listening on port ${port}`);
});
