const mongoose = require('mongoose');

const TimerStateSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    unique: true,
    default: "defaultUser"
  },
  status: {
    type: String,
    enum: ['running', 'paused', 'stopped'],
    default: 'stopped'
  },
  startTime: {
    type: Date,
    default: null
  },
  accumulatedSeconds: {
    type: Number,
    default: 0
  },
  topicId: {
    type: String,
    default: ''
  },
  topicTitle: {
    type: String,
    default: ''
  },
  subject: {
    type: String,
    default: ''
  },
  isPomodoroMode: {
    type: Boolean,
    default: false
  },
  pomodoroStage: {
    type: String,
    enum: ['work', 'break'],
    default: 'work'
  }
}, { timestamps: true });

module.exports = mongoose.model('TimerState', TimerStateSchema);
