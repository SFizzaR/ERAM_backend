const express = require('express');
const cors = require('cors');
require('dotenv').config();
const path = require('path');

const supabaseAdmin = require('./config/supabaseAdmin');

const userRoutes = require('./routes/userRoutes');
const emailRoutes = require('./routes/emailRoutes');
const questionnaireRoutes = require('./routes/questionnaireRoutes');
const forumRoutes = require('./routes/forumRoutes');
const doctorRoutes = require('./routes/doctorRoutes');

const app = express();
const port = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// ✅ Test Supabase connection
app.get('/test-db', async (req, res) => {
    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .limit(1);

    if (error) {
        return res.status(500).json({ error });
    }

    res.json({ success: true, data });
});

// Routes
app.use('/user', userRoutes);
app.use('/email', emailRoutes);
app.use('/questionnaire', questionnaireRoutes);
app.use('/api/forum', forumRoutes);
app.use('/doctor', doctorRoutes);

app.use('/public', express.static(path.join(__dirname, 'public')));

// Start server
app.listen(port, () => {
    console.log(`🚀 Server listening on port ${port}`);

});
