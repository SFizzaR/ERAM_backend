const mongoose = require('mongoose')

const postSchema = mongoose.Schema({
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    child_id: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },
    title: String,
    Content: String

},
    {
        timestamps: true
    }
);

module.exports = mongoose.model("Post", postSchema)