const mongoose = require('mongoose');

const AchievementSchema = new mongoose.Schema({
  text: {
    type: String,
    required: true
  },
  templateId: {
    type: String,
    required: true,
    enum: ['golden', 'cyber', 'royal', 'aurora'],
    default: 'golden'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { timestamps: true });

module.exports = mongoose.model('Achievement', AchievementSchema);
