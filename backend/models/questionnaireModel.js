const mongoose = require('mongoose')

const questionSchema = new mongoose.Schema({
    question_text: { type: String, required: true },
    options: [
        {
            option: { type: String, required: true },
            score: { type: Number, required: true } // 0 or 1
        }
    ]
});

const questionnaireSchema = mongoose.Schema({
    type: String,
    instructions: String,
    age_min: {
        required: true,
        type: Number
    },
    age_max: {
        required: true,
        type: Number
    },
    questions: [
        questionSchema
    ]


},
    {
        timestamps: true // ✅ automatically adds createdAt and updatedAt
    }
)

module.exports = mongoose.model("Questionnaire", questionnaireSchema)