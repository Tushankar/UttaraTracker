const mongoose = require('mongoose');

const GlobalMessageSchema = new mongoose.Schema({
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
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
  content: {
    type: String,
    required: true,
    trim: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

// Create index to auto-delete messages older than 7 days (optional, to keep DB clean)
// GlobalMessageSchema.index({ timestamp: 1 }, { expireAfterSeconds: 604800 }); 

module.exports = mongoose.model('GlobalMessage', GlobalMessageSchema);
