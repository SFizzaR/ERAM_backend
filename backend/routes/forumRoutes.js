const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const jwt = require('jsonwebtoken');
const { protect } = require('../middleware/protectMiddleware');
const bcrypt = require("bcrypt");

const router = Router();

router.use(protect);

router.post('/createRoom', async (req, res) => {
    try {
        // User ID attached by protect middleware
        const userId = req.user._id.toString();
        const { chat_room_name } = req.body;

        if (!chat_room_name || !chat_room_name.trim()) {
            return res.status(400).json({ error: 'Room name required' });
        }

        const { data, error } = await supabase
            .from("chat_rooms")
            .insert({
                admin_id: userId,
                chat_room_name: chat_room_name.trim(),
                room_type: "private",
            })
            .select(`
                id,
                chat_room_name,
                admin_id
            `)
            .single();

        if (error) {
            console.error('Supabase insert error:', error);
            return res.status(400).json({ error: error.message });
        }

        return res.status(201).json(data);
    } catch (err) {
        console.error('createRoom crash:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});


module.exports = router;