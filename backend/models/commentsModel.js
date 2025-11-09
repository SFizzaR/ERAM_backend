const mongoose = require('mongoose')

const commentSchema = mongoose.Schema({
    post_id: { type: mongoose.Schema.Types.ObjectId, ref: "Post", required: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    child_id: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },
    comment_text: String,


},
    {
        timestamps: true
    }
);

module.exports = mongoose.model("Post", commentSchema)