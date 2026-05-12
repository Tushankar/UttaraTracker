const mongoose = require("mongoose");

const ExamAttemptSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      default: "defaultUser",
    },
    subjects: [
      {
        type: String,
      },
    ],
    questions: [
      {
        question: { type: String, required: true },
        options: [{ type: String, required: true }],
        correct: { type: Number, required: true },
        selected: { type: Number, default: null },
        subject: { type: String },
      },
    ],
    score: {
      type: Number,
      default: 0,
    },
    totalQuestions: {
      type: Number,
      default: 0,
    },
    timeSpent: {
      type: Number,
      default: 0,
    },
    timerDuration: {
      type: Number,
      default: 600, // 10 minutes default
    },
    percentage: {
      type: Number,
      default: 0,
    },
    completed: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ExamAttempt", ExamAttemptSchema);
