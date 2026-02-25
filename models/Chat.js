const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
  image: { type: String, default: '' }, // base64 image data (if user sent image)
  timestamp: { type: Date, default: Date.now }
});

const ChatSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  title: { type: String, default: 'New Chat' },
  messages: [MessageSchema],
  lastActivity: { type: Date, default: Date.now }
}, { timestamps: true });

// Auto-update lastActivity
ChatSchema.pre('save', function() {
  this.lastActivity = new Date();
});

module.exports = mongoose.model('Chat', ChatSchema);
