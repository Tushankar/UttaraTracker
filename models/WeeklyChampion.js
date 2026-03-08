const mongoose = require('mongoose');

const WeeklyChampionSchema = new mongoose.Schema({
  weekStart: {
    type: Date,
    required: true,
    unique: true // Ensure only one champion per week
  },
  userId: {
    type: String,
    required: true
  },
  displayName: {
    type: String,
    required: true
  },
  avatar: {
    type: String,
    default: ''
  },
  totalDuration: {
    type: Number,
    required: true
  },
  message: {
    type: String,
    default: 'Congratulations for being the most dedicated learner this week!'
  }
}, { timestamps: true });

module.exports = mongoose.model('WeeklyChampion', WeeklyChampionSchema);
