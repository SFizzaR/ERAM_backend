const mongoose = require('mongoose')

const doctorVerificationLogSchema = mongoose.Schema({
    doctorId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Doctor',
        required: true
    },
    pmdc_number: String,
    fullName: String,
    fatherName: String,
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
    },
    reason: String,
},
    {
        timestamps: true // ✅ automatically adds createdAt and updatedAt
    }
);

module.exports = mongoose.model("DoctorVerificationLog", doctorVerificationLogSchema)