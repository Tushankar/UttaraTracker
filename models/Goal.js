const mongoose = require('mongoose');

const GoalSchema = new mongoose.Schema({
  userId: { type: String, required: true, default: "defaultUser" },
  title: { type: String, required: true },
  targetHours: { type: Number, required: true },
  month: { type: String, required: true }, // Format: "2026-02"
  achieved: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Goal', GoalSchema);
