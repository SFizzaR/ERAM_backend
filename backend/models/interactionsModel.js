const mongoose = require('mongoose')

const interactionSchema = mongoose.Schema({
    post_id: { type: mongoose.Schema.Types.ObjectId, ref: "Post", required: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    child_id: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },
    interaction_type: {
        type: String,
        enum: ['like', 'dislike']
    }

},
    {
        timestamps: true
    }
);

module.exports = mongoose.model("Interaction", interactionSchema)