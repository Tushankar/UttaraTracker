const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const User = require('../models/User');
const Tracker = require('../models/Tracker');

const BADGE_DEFINITIONS = [
  {
    id: 'first_session',
    name: 'First Steps',
    description: 'Complete your first study session',
    icon: '🎯',
    check: (data) => data.totalSessions >= 1
  },
  {
    id: 'night_owl',
    name: 'Night Owl',
    description: 'Study 3+ sessions after 10 PM',
    icon: '🦉',
    check: (data) => data.nightSessions >= 3
  },
  {
    id: 'early_bird',
    name: 'Early Bird',
    description: 'Study 3+ sessions before 7 AM',
    icon: '🌅',
    check: (data) => data.morningSessions >= 3
  },
  {
    id: 'weekend_warrior',
    name: 'Weekend Warrior',
    description: 'Study on both Saturday and Sunday',
    icon: '⚔️',
    check: (data) => data.saturdaySessions > 0 && data.sundaySessions > 0
  },
  {
    id: 'consistency_king',
    name: 'Consistency King',
    description: 'Maintain a 14-day study streak',
    icon: '👑',
    check: (data) => data.streak >= 14
  },
  {
    id: 'streak_starter',
    name: 'Streak Starter',
    description: 'Maintain a 3-day study streak',
    icon: '🔥',
    check: (data) => data.streak >= 3
  },
  {
    id: 'week_warrior',
    name: 'Week Warrior',
    description: 'Maintain a 7-day study streak',
    icon: '💪',
    check: (data) => data.streak >= 7
  },
  {
    id: 'marathon_runner',
    name: 'Marathon Runner',
    description: 'Study for 4+ hours in a single day',
    icon: '🏃',
    check: (data) => data.maxDayHours >= 4
  },
  {
    id: 'centurion',
    name: 'Centurion',
    description: 'Complete 100 total study sessions',
    icon: '💯',
    check: (data) => data.totalSessions >= 100
  },
  {
    id: 'fifty_hours',
    name: '50-Hour Club',
    description: 'Accumulate 50 hours of total study time',
    icon: '🏆',
    check: (data) => data.totalHours >= 50
  },
  {
    id: 'hundred_hours',
    name: 'Century Scholar',
    description: 'Accumulate 100 hours of total study time',
    icon: '🎓',
    check: (data) => data.totalHours >= 100
  },
  {
    id: 'all_rounder',
    name: 'All-Rounder',
    description: 'Study all 5 subjects in one week',
    icon: '🌟',
    check: (data) => data.weekSubjects >= 5
  },
  {
    id: 'topic_master',
    name: 'Topic Master',
    description: 'Complete 20 topics',
    icon: '📚',
    check: (data) => data.doneTopics >= 20
  },
  {
    id: 'half_way',
    name: 'Halfway There',
    description: 'Complete 50% of all topics',
    icon: '🎯',
    check: (data) => data.completionPercent >= 50
  }
];

// GET /api/badges
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const tracker = await Tracker.findOne({ userId });
    const user = await User.findById(userId);
    
    if (!tracker || !user) {
      return res.json({ earned: [], available: BADGE_DEFINITIONS.map(b => ({ id: b.id, name: b.name, description: b.description, icon: b.icon })) });
    }
    
    const sessions = tracker.sessions || [];
    const topics = tracker.topics || {};
    
    // Compute badge data
    let nightSessions = 0, morningSessions = 0, saturdaySessions = 0, sundaySessions = 0;
    const dayTotals = {};
    const weekSubjects = new Set();
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    
    sessions.forEach(s => {
      const d = new Date(s.timestamp);
      const hour = d.getHours();
      const day = d.getDay();
      
      if (hour >= 22 || hour < 4) nightSessions++;
      if (hour >= 4 && hour < 7) morningSessions++;
      if (day === 6) saturdaySessions++;
      if (day === 0) sundaySessions++;
      
      const dayKey = d.toDateString();
      dayTotals[dayKey] = (dayTotals[dayKey] || 0) + s.duration;
      
      if (d.getTime() > weekAgo && s.subject) weekSubjects.add(s.subject);
    });
    
    // Streak
    let streak = 0;
    const today = new Date();
    let checkDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (!dayTotals[checkDate.toDateString()]) checkDate.setDate(checkDate.getDate() - 1);
    for (let i = 0; i < 365; i++) {
      if (dayTotals[checkDate.toDateString()] && dayTotals[checkDate.toDateString()] >= 30) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else break;
    }
    
    const maxDayHours = Math.max(...Object.values(dayTotals).map(s => s / 3600), 0);
    const totalSeconds = sessions.reduce((acc, s) => acc + s.duration, 0);
    const doneTopics = Object.values(topics).filter(t => t.status === 'done').length;
    
    const badgeData = {
      totalSessions: sessions.length,
      nightSessions,
      morningSessions,
      saturdaySessions,
      sundaySessions,
      streak,
      maxDayHours,
      totalHours: totalSeconds / 3600,
      weekSubjects: weekSubjects.size,
      doneTopics,
      completionPercent: Math.round(doneTopics / 83 * 100)
    };
    
    // Check badges
    const newBadges = [];
    const existingBadgeIds = new Set((user.badges || []).map(b => b.id));
    
    BADGE_DEFINITIONS.forEach(badge => {
      if (!existingBadgeIds.has(badge.id) && badge.check(badgeData)) {
        newBadges.push({
          id: badge.id,
          name: badge.name,
          description: badge.description,
          icon: badge.icon,
          earnedAt: new Date()
        });
      }
    });
    
    // Save new badges
    if (newBadges.length > 0) {
      user.badges = [...(user.badges || []), ...newBadges];
      await user.save();
    }
    
    const earned = (user.badges || []).concat(newBadges);
    const available = BADGE_DEFINITIONS.filter(b => !earned.find(e => e.id === b.id)).map(b => ({
      id: b.id, name: b.name, description: b.description, icon: b.icon
    }));
    
    res.json({ earned, available, newBadges, stats: badgeData });
  } catch (error) {
    console.error('Badges error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
