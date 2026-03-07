const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { generateToken, authMiddleware } = require('../middleware/auth');

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { email, password, displayName } = req.body;

    if (!email || !password || !displayName) {
      return res.status(400).json({ error: 'Email, password, and display name are required.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    // Check if user exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // Create user
    const user = new User({
      email: email.toLowerCase(),
      password,
      displayName
    });
    await user.save();

    // Migrate defaultUser data to new user
    const Tracker = require('../models/Tracker');
    const Task = require('../models/Task');
    const Goal = require('../models/Goal');
    const TimerState = require('../models/TimerState');

    // Check if there's defaultUser data to claim
    const defaultTracker = await Tracker.findOne({ userId: 'defaultUser' });
    if (defaultTracker) {
      // Check if any user has already claimed this data
      const existingClaim = await Tracker.findOne({ userId: user._id.toString() });
      if (!existingClaim) {
        await Tracker.updateMany({ userId: 'defaultUser' }, { userId: user._id.toString() });
        await Task.updateMany({ userId: 'defaultUser' }, { userId: user._id.toString() });
        await Goal.updateMany({ userId: 'defaultUser' }, { userId: user._id.toString() });
        await TimerState.updateMany({ userId: 'defaultUser' }, { userId: user._id.toString() });
      }
    }

    const token = generateToken(user._id);
    res.status(201).json({
      token,
      user: user.toJSON()
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Server error during signup.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = generateToken(user._id);
    res.status(200).json({
      token,
      user: user.toJSON()
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error during login.' });
  }
});

// GET /api/auth/me — Get current user profile
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.status(200).json({ user: user.toJSON() });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

// PUT /api/auth/profile — Update user profile
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const { displayName, avatar, studyGoals, preferences } = req.body;
    const updates = {};

    if (displayName) updates.displayName = displayName;
    if (avatar !== undefined) updates.avatar = avatar;
    if (studyGoals) updates.studyGoals = studyGoals;
    if (preferences) updates.preferences = preferences;

    const user = await User.findByIdAndUpdate(req.user.id, updates, { new: true });
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.status(200).json({ user: user.toJSON() });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

// POST /api/auth/add-subject
router.post('/add-subject', authMiddleware, async (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name) return res.status(400).json({ error: 'Subject name required.' });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Check if already exists
    if (user.customSubjects.some(s => s.name.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ error: 'Subject already exists.' });
    }

    user.customSubjects.push({ name, color: color || '#2563eb' });
    await user.save();

    res.status(200).json({ user: user.toJSON() });
  } catch (error) {
    console.error('Add subject error:', error);
    res.status(500).json({ error: 'Server error adding subject.' });
  }
});

// POST /api/auth/add-topic
router.post('/add-topic', authMiddleware, async (req, res) => {
  try {
    const { subject, title } = req.body;
    if (!subject || !title) return res.status(400).json({ error: 'Subject and title required.' });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const id = `c${Date.now()}`; // Unique custom prefix
    user.customTopics.push({ subject, id, title });
    await user.save();

    res.status(200).json({ user: user.toJSON() });
  } catch (error) {
    console.error('Add topic error:', error);
    res.status(500).json({ error: 'Server error adding topic.' });
  }
});

module.exports = router;
