const expressAsyncHandler = require("express-async-handler");
const express = require('express');
const router = express.Router();
const Questionnaire = require('../models/questionnaireModel')
const axios = require('axios')

router.post('/addQuestionnaire', expressAsyncHandler(async (req, res) => {
    try {
        const { type, age_min, age_max, instructions } = req.body;

        if (!type || !age_min || !age_max || !instructions) {
            res.status(400).json({ message: "All fields are mandatory" });
            return;
        }

        const questionnaire = await Questionnaire.create({
            type,
            age_min,
            age_max,
            instructions
        })
        if (questionnaire) {
            console.log(`Questionnaire created ${questionnaire}`)
            return res.status(201).json({
                message: "Questionnaire created successfully",
                data: questionnaire
            });
        }
    }
    catch (err) {
        res.status(500).json({ message: "Server error", error: err.message });

    }
}))

router.put('/addQuestion', expressAsyncHandler(async (req, res) => {
    try {
        const { type, questions } = req.body;

        const questionnaire = await Questionnaire.findOne({ type: type })
        const updatedQuestionnaire = await Questionnaire.findByIdAndUpdate(
            questionnaire._id,
            {
                $push: { questions: { $each: questions } }
            },
            { new: true }
        )
        res.json(updatedQuestionnaire)
    }
    catch (err) {
        res.status(500).json({ message: "Server error", error: err.message });

    }
}))

router.get('/getQuestionnaire', expressAsyncHandler(async (req, res) => {
    try {
        const { age } = req.query;

        if (!age) {
            return res.status(400).json({ message: "Age is required" });
        }

        const questionnaire = await Questionnaire.findOne({
            age_min: { $lte: Number(age) },
            age_max: { $gte: Number(age) }
        });

        if (questionnaire) {
            res.json(questionnaire);
        } else {
            res.status(404).json({ message: "No questionnaire found for this age" });
        }

    } catch (err) {
        res.status(500).json({ message: "Server error", error: err.message });
    }
}));

router.post('/submitTest', expressAsyncHandler(async (req, res) => {
    try {
        const { answers, type, age } = req.body;

        // 1️⃣ Fetch questionnaire
        const questionnaire = await Questionnaire.findOne({ type });
        if (!questionnaire) {
            return res.status(404).json({ error: "Questionnaire not found" });
        }

        // 2️⃣ Build input for model
        const features = {};

        // Using index+1 since you don't store question number
        questionnaire.questions.forEach((q, index) => {
            const qKey = `A${index + 1}`;
            const chosenOption = answers[qKey]; // e.g. 'B'

            // Find that option in DB
            const optionData = q.options.find(opt => opt.option === chosenOption);

            // Fallback to 0 if not found
            features[qKey] = optionData ? optionData.score : 0;
            console.log(features[qKey])
        });


        // 3️⃣ Add Age
        features["Age"] = age;

        // 4️⃣ Send formatted data directly (not nested in 'features')
        const response = await axios.post('http://127.0.0.1:5000/predict', features);

        // 5️⃣ Return model response to frontend
        res.json(response.data);

    } catch (error) {
        console.error("❌ Prediction error:", error.response?.data || error.message);
        res.status(500).json({
            error: 'Prediction service unavailable',
            details: error.response?.data || error.message
        });
    }
}));

module.exports = router;