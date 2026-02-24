const mongoose = require('mongoose');

const TaskSchema = new mongoose.Schema({
  userId: { type: String, required: true, default: "defaultUser" },
  title: { type: String, required: true },
  subject: { type: String, default: "" },
  dueDate: { type: Date, default: null },
  isRepeating: { type: Boolean, default: false },
  repeatInterval: { type: String, enum: ['daily', 'weekly', ''], default: '' },
  completed: { type: Boolean, default: false },
  completedAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Task', TaskSchema);
