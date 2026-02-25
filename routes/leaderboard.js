const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const User = require('../models/User');
const Tracker = require('../models/Tracker');
const Task = require('../models/Task');

// GET /api/leaderboard
router.get('/', async (req, res) => {
  try {
    const users = await User.find({}).select('displayName avatar focusPoints badges').sort({ focusPoints: -1 }).limit(50);
    
    const leaderboard = users.map((user, index) => ({
      rank: index + 1,
      id: user._id,
      displayName: user.displayName,
      avatar: user.avatar,
      focusPoints: user.focusPoints,
      badgeCount: user.badges?.length || 0
    }));
    
    res.json({ leaderboard });
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/leaderboard/recalculate — Recalculate focus points for a user
router.post('/recalculate', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const tracker = await Tracker.findOne({ userId });
    const tasks = await Task.find({ userId });
    
    // Focus Points formula:
    // study_hours * 10 + tasks_completed * 5 + streak_days * 3
    const totalSeconds = (tracker?.sessions || []).reduce((acc, s) => acc + s.duration, 0);
    const studyHours = totalSeconds / 3600;
    const completedTasks = tasks.filter(t => t.completed).length;
    
    // Streak calculation
    const dayTotals = {};
    (tracker?.sessions || []).forEach(s => {
      const d = new Date(s.timestamp);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      dayTotals[key] = (dayTotals[key] || 0) + s.duration;
    });
    
    let streak = 0;
    const today = new Date();
    let checkDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const todayKey = `${checkDate.getFullYear()}-${checkDate.getMonth()}-${checkDate.getDate()}`;
    if (!dayTotals[todayKey]) checkDate.setDate(checkDate.getDate() - 1);
    
    for (let i = 0; i < 365; i++) {
      const key = `${checkDate.getFullYear()}-${checkDate.getMonth()}-${checkDate.getDate()}`;
      if (dayTotals[key] && dayTotals[key] >= 30) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else break;
    }
    
    const focusPoints = Math.round(studyHours * 10 + completedTasks * 5 + streak * 3);
    
    await User.findByIdAndUpdate(userId, { focusPoints });
    
    res.json({ focusPoints, breakdown: { studyHours: Math.round(studyHours * 10) / 10, completedTasks, streak } });
  } catch (error) {
    console.error('Recalculate error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
