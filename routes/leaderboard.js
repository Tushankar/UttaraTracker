const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/auth");
const User = require("../models/User");
const Tracker = require("../models/Tracker");
const Task = require("../models/Task");
const ExamAttempt = require("../models/ExamAttempt");
const WeeklyChampion = require("../models/WeeklyChampion");

// Helper: Precise IST boundary calculation
function getISTStart(date = new Date(), type = "day") {
  const istOffset = 5.5 * 60 * 60 * 1000;
  // Shift to IST to perform UTC calendar arithmetic on IST numbers
  const d = new Date(date.getTime() + istOffset);

  if (type === "day") {
    d.setUTCHours(0, 0, 0, 0);
  } else if (type === "week") {
    d.setUTCHours(0, 0, 0, 0);
    const day = d.getUTCDay(); // 0 is Sun, 1 is Mon...
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
    d.setUTCDate(diff);
  } else if (type === "month") {
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(1);
  }

  // Shift back to UTC to get the true epoch time for that IST boundary
  return new Date(d.getTime() - istOffset);
}

// Keep for compatibility but refactor using the precise helper
function getStartOfISTWeek(date) {
  return getISTStart(date, "week");
}

// GET /api/leaderboard
router.get("/", async (req, res) => {
  try {
    const users = await User.find({})
      .select("displayName avatar focusPoints badges examCount")
      .sort({ focusPoints: -1 })
      .limit(50);

    // Fetch trackers to find what everyone is currently studying
    const userIds = users.map((u) => u._id);
    const trackers = await Tracker.find({ userId: { $in: userIds } }).select(
      "userId sessions",
    );

    const leaderboard = users.map((user, index) => {
      // Find latest session for this user
      const tracker = trackers.find((t) => t.userId === user._id.toString());
      let lastStudied = null;
      if (tracker && tracker.sessions && tracker.sessions.length > 0) {
        // Sort to get the most recent session
        const sortedSessions = tracker.sessions.sort(
          (a, b) => new Date(b.timestamp) - new Date(a.timestamp),
        );
        const latestInfo = sortedSessions[0];
        lastStudied = latestInfo.subject || latestInfo.topicTitle || null;
      }

      return {
        rank: index + 1,
        id: user._id,
        displayName: user.displayName,
        avatar: user.avatar,
        focusPoints: user.focusPoints,
        badgeCount: user.badges?.length || 0,
        lastStudied,
        examCount: user.examCount || 0,
      };
    });

    res.json({ leaderboard });
  } catch (error) {
    console.error("Leaderboard error:", error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/leaderboard/recalculate — Recalculate focus points for a user
async function recalculateUserPoints(userId) {
  try {
    const tracker = await Tracker.findOne({ userId });
    const tasks = await Task.find({ userId });
    const exams = await ExamAttempt.find({ userId, completed: true });

    // Focus Points formula:
    // study_hours * 10 + tasks_completed * 5 + streak_days * 3 + exam_points
    const totalSeconds = (tracker?.sessions || []).reduce(
      (acc, s) => acc + s.duration,
      0,
    );
    const studyHours = totalSeconds / 3600;
    const completedTasks = tasks.filter((t) => t.completed).length;

    // Calculate exam points: 50 + score * 10 for each completed exam
    const examPoints = exams.reduce((total, exam) => {
      return total + (50 + exam.score * 10);
    }, 0);

    // Streak calculation
    const dayTotals = {};
    (tracker?.sessions || []).forEach((s) => {
      const d = new Date(s.timestamp);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      dayTotals[key] = (dayTotals[key] || 0) + s.duration;
    });

    let streak = 0;
    const today = new Date();
    let checkDate = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
    );
    const todayKey = `${checkDate.getFullYear()}-${checkDate.getMonth()}-${checkDate.getDate()}`;
    if (!dayTotals[todayKey]) checkDate.setDate(checkDate.getDate() - 1);

    for (let i = 0; i < 365; i++) {
      const key = `${checkDate.getFullYear()}-${checkDate.getMonth()}-${checkDate.getDate()}`;
      if (dayTotals[key] && dayTotals[key] >= 30) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else break;
    }

    const focusPoints = Math.round(
      studyHours * 10 + completedTasks * 5 + streak * 3 + examPoints,
    );

    await User.findByIdAndUpdate(userId, { focusPoints });

    return {
      focusPoints,
      breakdown: {
        studyHours: Math.round(studyHours * 10) / 10,
        completedTasks,
        streak,
        examPoints,
      },
    };
  } catch (error) {
    console.error("Error in recalculateUserPoints:", error);
    throw error;
  }
}

// POST /api/leaderboard/recalculate — Recalculate focus points for a user
router.post("/recalculate", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await recalculateUserPoints(userId);
    res.json(result);
  } catch (error) {
    console.error("Recalculate error:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/leaderboard/weekly-winner — Get or calculate current weekly champion
router.get("/weekly-winner", async (req, res) => {
  try {
    const now = new Date();
    // We want the champion of the previous finished week
    const currentWeekStart = getStartOfISTWeek(now);
    const lastWeekStart = new Date(currentWeekStart);
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);

    let winner = await WeeklyChampion.findOne({ weekStart: lastWeekStart });

    if (!winner) {
      // Calculate winner for last week
      const trackers = await Tracker.find({});
      let topUser = null;
      let maxDuration = 0;

      for (const tracker of trackers) {
        const lastWeekDuration = tracker.sessions
          .filter((s) => {
            const sDate = new Date(s.timestamp);
            return sDate >= lastWeekStart && sDate < currentWeekStart;
          })
          .reduce((acc, s) => acc + s.duration, 0);

        if (lastWeekDuration > maxDuration) {
          maxDuration = lastWeekDuration;
          topUser = tracker.userId;
        }
      }

      if (topUser) {
        const user = await User.findById(topUser);
        if (user) {
          try {
            winner = new WeeklyChampion({
              weekStart: lastWeekStart,
              userId: user._id,
              displayName: user.displayName,
              avatar: user.avatar,
              totalDuration: maxDuration,
            });
            await winner.save();
          } catch (saveErr) {
            // If another request saved it simultaneously, catch the duplicate key error
            if (saveErr.code === 11000) {
              winner = await WeeklyChampion.findOne({
                weekStart: lastWeekStart,
              });
            } else {
              throw saveErr;
            }
          }
        }
      }
    }

    // Dynamic update: Ensure the winner's current profile info is used
    if (winner) {
      const user = await User.findById(winner.userId);
      if (user) {
        // We use lean-like approach by updating the response object fields
        const winnerObj = winner.toObject();
        winnerObj.avatar = user.avatar || winnerObj.avatar;
        winnerObj.displayName = user.displayName || winnerObj.displayName;
        winner = winnerObj;
      }
    }

    // Also get "Leader of the current week"
    const trackers = await Tracker.find({});
    let currentTop = null;
    let currentMax = 0;
    for (const tracker of trackers) {
      const dur = tracker.sessions
        .filter((s) => new Date(s.timestamp) >= currentWeekStart)
        .reduce((acc, s) => acc + s.duration, 0);
      if (dur > currentMax) {
        currentMax = dur;
        currentTop = tracker.userId;
      }
    }

    let currentLeader = null;
    if (currentTop) {
      const u = await User.findById(currentTop);
      if (u)
        currentLeader = {
          userId: u._id,
          displayName: u.displayName,
          avatar: u.avatar,
          duration: currentMax,
        };
    }

    res.json({ winner, currentLeader });
  } catch (error) {
    console.error("Weekly winner error:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/leaderboard/weekly-champions — Get history
router.get("/weekly-champions", async (req, res) => {
  try {
    const champions = await WeeklyChampion.find({}).sort({ weekStart: -1 });

    // Enrich with current user details for better UI
    const enriched = await Promise.all(
      champions.map(async (c) => {
        const u = await User.findById(c.userId);
        const obj = c.toObject();
        if (u) {
          obj.avatar = u.avatar || obj.avatar;
          obj.displayName = u.displayName || obj.displayName;
        }
        return obj;
      }),
    );

    res.json({ champions: enriched });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/leaderboard/time-based — Get time-based leaderboard (Today, Week, Month, Overall)
router.get("/time-based", async (req, res) => {
  try {
    const users = await User.find({}).select("displayName avatar");
    const trackers = await Tracker.find({}).select("userId sessions");

    const now = new Date();

    // Get start of today (IST)
    const startOfToday = getISTStart(now, "day");

    // Get start of week (IST)
    const startOfWeek = getISTStart(now, "week");

    // Get start of month (IST)
    const startOfMonth = getISTStart(now, "month");

    // Optimization: Create a Map of userId -> tracker
    const trackerMap = new Map();
    trackers.forEach((t) => trackerMap.set(t.userId.toString(), t));

    const timeLeaderboard = users.map((user) => {
      const tracker = trackerMap.get(user._id.toString());

      let todayHours = 0;
      let weekHours = 0;
      let monthHours = 0;
      let overallHours = 0;

      if (tracker && tracker.sessions) {
        tracker.sessions.forEach((s) => {
          const sDate = new Date(s.timestamp);
          const durationHours = s.duration / 3600;

          overallHours += durationHours;

          if (sDate >= startOfMonth) {
            monthHours += durationHours;
          }
          if (sDate >= startOfWeek) {
            weekHours += durationHours;
          }
          if (sDate >= startOfToday) {
            todayHours += durationHours;
          }
        });
      }

      return {
        id: user._id,
        displayName: user.displayName,
        avatar: user.avatar,
        todayHours, // Stop rounding in backend to preserve precision
        weekHours,
        monthHours,
        overallHours,
      };
    });

    // Sort by monthHours descending
    timeLeaderboard.sort((a, b) => b.monthHours - a.monthHours);

    // Add rank
    timeLeaderboard.forEach((item, index) => {
      item.rank = index + 1;
    });

    res.json({ leaderboard: timeLeaderboard });
  } catch (error) {
    console.error("Time-based leaderboard error:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = { router, recalculateUserPoints };
