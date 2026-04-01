const express = require('express');
const router = express.Router();
const expressAsyncHandler = require("express-async-handler");
const multer = require('multer');
const fs = require('fs');
const upload = multer({ dest: 'uploads/' });
const supabase = require('../config/supabaseAdmin');

router.post('/send', upload.single('audio'), expressAsyncHandler(async (req, res) => {
    const { childId, word } = req.body;
    const audioFile = req.file;

    if (!childId || !audioFile || !word) {
        return res.status(400).json({ message: "childId, word and audio are all required" });
    }

    // 1. Upload audio file to Supabase Storage
    const fileBuffer = fs.readFileSync(audioFile.path);
    const fileName = `${childId}/${Date.now()}.m4a`;

    const { error: uploadError } = await supabase.storage
        .from('speech-recordings')       // your bucket name
        .upload(fileName, fileBuffer, {
            contentType: 'audio/m4a',
        });

    if (uploadError) {
        return res.status(500).json({ message: "Audio upload failed", error: uploadError.message });
    }

    // 2. Get public URL
    const { data: urlData } = supabase.storage
        .from('speech-recordings')
        .getPublicUrl(fileName);

    const audioUrl = urlData.publicUrl;

    // 3. Save record to DB
    const { data, error } = await supabase
        .from('speech_attempts')
        .insert([{
            child_id: childId,
            expected_word: word,
            audio_file_path: audioUrl,         // store URL string, not file object
        }])
        .select()
        .single();

    if (error) {
        return res.status(500).json({ message: "Database error", error: error.message });
    }

    // 4. Clean up temp file
    fs.unlinkSync(audioFile.path);

    return res.status(200).json({
        message: "Audio saved",
        attempt_id: data.id,
        audio_url: audioUrl,
    });
}));

module.exports = router;