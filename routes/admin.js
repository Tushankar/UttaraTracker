const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { authMiddleware, adminMiddleware, generateToken } = require('../middleware/auth');

// GET /api/admin/users — List all users (Admin only)
router.get('/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await User.find({}, '-password').sort({ createdAt: -1 });
    res.status(200).json(users);
  } catch (error) {
    console.error('Admin Fetch Users Error:', error);
    res.status(500).json({ error: 'Server error fetching users.' });
  }
});

// POST /api/admin/impersonate — Generate token for another user (Admin only)
router.post('/impersonate', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required.' });
    }

    const targetUser = await User.findById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const token = generateToken(targetUser._id);
    res.status(200).json({
      token,
      user: targetUser.toJSON(),
      message: `Successfully impersonating ${targetUser.displayName}`
    });
  } catch (error) {
    console.error('Admin Impersonate Error:', error);
    res.status(500).json({ error: 'Server error during impersonation.' });
  }
});

module.exports = router;
