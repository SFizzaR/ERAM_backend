const expressAsyncHandler = require("express-async-handler");
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabaseAdmin');
const axios = require('axios');


router.get('/getQuestionnaire', expressAsyncHandler(async (req, res) => {
    try {
        const { age, language } = req.query;

        if (!age) return res.status(400).json({ message: "Age is required" });
        if (!language) return res.status(400).json({ message: "Language is required" });

        // 1. Find matching assessment
        const { data: assessment, error: assessmentError } = await supabase
            .from('questionnaires')
            .select('*')
            .lte('age_min', Number(age))
            .gte('age_max', Number(age))
            .eq('language', language)
            .single();

        if (assessmentError || !assessment) {
            return res.status(404).json({ message: "No questionnaire found for this age" });
        }

        // 2. Fetch questions
        const { data: questions, error: qError } = await supabase
            .from('questionnaire_questions')
            .select('*')
            .eq('questionnaire_id', assessment.id)
            .order('order_index');

        if (qError) return res.status(500).json({ message: "Failed to fetch questions", error: qError.message });

        // 3. Fetch options for each question
        const questionsWithOptions = await Promise.all(
            questions.map(async (q) => {
                const { data: options } = await supabase
                    .from('question_options')
                    .select('*')
                    .eq('question_id', q.id)
                    .order('order_index');

                return { ...q, options };
            })
        );

        return res.json({ ...assessment, questions: questionsWithOptions });

    } catch (err) {
        res.status(500).json({ message: "Server error", error: err.message });
    }
}));



router.post('/submitTest', expressAsyncHandler(async (req, res) => {
    try {
        const { answers, type, age, language } = req.body;
        // answers = { A1: 'Definitely Agree', A2: 'Slightly Disagree', ... }

        // 1. Fetch assessment
        const { data: assessment, error: assessmentError } = await supabase
            .from('questionnaires')
            .select('id')
            .eq('type', type)
            .eq('language', language)
            .single();

        if (assessmentError || !assessment) {
            return res.status(404).json({ error: "Questionnaire not found" });
        }

        // 2. Fetch questions in order
        const { data: questions, error: qError } = await supabase
            .from('questionnaire_questions')
            .select('id')
            .eq('questionnaire_id', assessment.id)
            .order('order_index');

        if (qError) return res.status(500).json({ error: "Failed to fetch questions" });

        // 3. Build features by matching answer text to score
        const features = {};

        await Promise.all(
            questions.map(async (q, index) => {
                const qKey = `A${index + 1}`;
                const chosenOptionText = answers[qKey];

                const { data: option } = await supabase
                    .from('question_options')
                    .select('score')
                    .eq('question_id', q.id)
                    .eq('option_text', chosenOptionText)
                    .single();

                features[qKey] = option ? option.score : 0;
            })
        );

        // 4. Add age
        features["Age"] = age;

        // 5. Send to ML model
        const response = await axios.post('http://127.0.0.1:5000/predict', features);

        return res.json(response.data);

    } catch (error) {
        console.error("Prediction error:", error.response?.data || error.message);
        res.status(500).json({
            error: 'Prediction service unavailable',
            details: error.response?.data || error.message
        });
    }
}));

module.exports = router;