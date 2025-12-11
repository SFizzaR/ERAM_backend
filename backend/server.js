const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
require('dotenv').config();
const path = require('path');

const userRoutes = require('./routes/userRoutes');
const emailRoutes = require('./routes/emailRoutes');
const questionnaireRoutes = require('./routes/questionnaireRoutes');
const forumRoutes = require('./routes/forumRoutes');

const app = express();

app.use(cors());
app.use(express.json());

// MongoDB connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("MongoDB connected"))
    .catch(err => console.error(err));

// Routes
app.use('/user', userRoutes);
app.use('/email', emailRoutes);
app.use('/questionnaire', questionnaireRoutes);
app.use('/api/forum', forumRoutes);

app.use('/public', express.static(path.join(__dirname, 'public')));

// ❌ REMOVE app.listen()
// Instead:
module.exports = app;
