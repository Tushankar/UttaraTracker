const mongoose = require('mongoose');

const TrackerSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    unique: true,
    default: "defaultUser"
  },
  topics: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  studyTimeSaved: {
    type: Number,
    default: 0
  },
  sessions: [{
    timestamp: { type: Date, default: Date.now },
    duration: { type: Number, required: true },
    topicId: { type: String, required: true },
    topicTitle: { type: String, default: "" },
    subject: { type: String, default: "" }
  }]
}, { timestamps: true });

module.exports = mongoose.model('Tracker', TrackerSchema);
