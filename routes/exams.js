const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/auth");
const ExamAttempt = require("../models/ExamAttempt");
const Tracker = require("../models/Tracker");

// Helper: Get IST Monday Start of the Week
function getISTWeekMonday(date = new Date()) {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const d = new Date(date.getTime() + istOffset);
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay(); // 0 is Sun, 1 is Mon...
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  d.setUTCDate(diff);
  const mon = new Date(d.getTime() - istOffset);
  return mon.toISOString().split('T')[0]; // e.g. "2026-05-11"
}

// GET /api/exams/mega-status - Fetch Sunday Mega Exam status and perform missed penalty check
router.get("/mega-status", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Check if today is Sunday in IST
    const istOffset = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(Date.now() + istOffset);
    const isSunday = nowIST.getUTCDay() === 0;

    let countdownSecs = 0;
    if (!isSunday) {
      // Calculate upcoming Sunday 00:00:00 IST
      const upcomingSundayIST = new Date(nowIST);
      const daysUntilSunday = 7 - nowIST.getUTCDay();
      upcomingSundayIST.setUTCDate(nowIST.getUTCDate() + daysUntilSunday);
      upcomingSundayIST.setUTCHours(0, 0, 0, 0);
      const upcomingSundayUTC = new Date(upcomingSundayIST.getTime() - istOffset);
      countdownSecs = Math.max(0, Math.floor((upcomingSundayUTC.getTime() - Date.now()) / 1000));
    }

    const currentWeekKey = getISTWeekMonday();
    
    // Check if user has already started or completed this Sunday's Mega Exam
    const hasAttempted = await ExamAttempt.exists({
      userId,
      isMegaExam: true,
      weekKey: currentWeekKey
    });

    // ────────────────────────────────────────────────────────
    // AUTOMATIC SYSTEM PENALTY CHECK (MISSED SUNDAY MEGA EXAMS)
    // ────────────────────────────────────────────────────────
    let penaltyApplied = false;
    let penaltyWeekStr = "";

    const thisWeekMonday = new Date(currentWeekKey);
    const lastWeekMonday = new Date(thisWeekMonday.getTime() - 7 * 24 * 60 * 60 * 1000);
    const lastWeekMondayStr = lastWeekMonday.toISOString().split('T')[0];

    // Check if they studied during that previous week
    const tracker = await Tracker.findOne({ userId });
    if (tracker && tracker.sessions && tracker.sessions.length > 0) {
      const lastWeekSessions = tracker.sessions.filter(s => {
        const sDate = new Date(s.timestamp);
        return sDate >= lastWeekMonday && sDate < thisWeekMonday;
      });

      const totalStudySecs = lastWeekSessions.reduce((sum, s) => sum + s.duration, 0);
      
      if (totalStudySecs > 0) {
        // They studied, did they complete a Mega Exam for lastWeekMondayStr?
        const completedMegaExam = await ExamAttempt.exists({
          userId,
          isMegaExam: true,
          weekKey: lastWeekMondayStr,
          completed: true
        });

        if (!completedMegaExam) {
          // Check if we already applied a penalty for this week
          const hasPenalty = lastWeekSessions.some(s => s.topicId === "sunday_mega_exam_penalty_" + lastWeekMondayStr);
          
          if (!hasPenalty) {
            // Apply the penalty session (-1 hour study duration deduction)
            tracker.sessions.push({
              topicId: "sunday_mega_exam_penalty_" + lastWeekMondayStr,
              topicTitle: "Sunday Mega Exam Missed Penalty (-1 hr)",
              subject: "System Penalty",
              duration: -3600,
              timestamp: new Date(thisWeekMonday.getTime() - 1000) // Timestamp at end of last week (Sunday 23:59:59 IST/UTC equivalent)
            });
            await tracker.save();
            
            // Recalculate focus points
            const { recalculateUserPoints } = require("./leaderboard");
            await recalculateUserPoints(userId);
            
            penaltyApplied = true;
            penaltyWeekStr = lastWeekMondayStr;
          }
        }
      }
    }

    res.json({
      unlocked: isSunday,
      countdown: countdownSecs,
      hasAttempted: !!hasAttempted,
      weekKey: currentWeekKey,
      penaltyApplied,
      penaltyWeek: penaltyWeekStr
    });

  } catch (error) {
    console.error("Error in mega-status:", error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/exams/mega-start - Store a newly generated Sunday Mega Exam
router.post("/mega-start", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { questions } = req.body;

    if (!questions || !questions.length) {
      return res.status(400).json({ error: "Questions are required to start the Mega Exam." });
    }

    // Verify today is Sunday in IST
    const istOffset = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(Date.now() + istOffset);
    if (nowIST.getUTCDay() !== 0) {
      return res.status(400).json({ error: "The Weekly Mega Exam is only unlocked on Sundays!" });
    }

    const currentWeekKey = getISTWeekMonday();

    // Prevent double attempts
    const existing = await ExamAttempt.findOne({ userId, isMegaExam: true, weekKey: currentWeekKey });
    if (existing) {
      return res.status(400).json({ error: "You have already attempted this Sunday's Mega Exam." });
    }

    // Invalidate other pending exams
    await ExamAttempt.updateMany(
      { userId, completed: false },
      { $set: { completed: true, score: 0, percentage: 0 } }
    );

    const newExam = new ExamAttempt({
      userId,
      subjects: ["Weekly Mega Assessment"],
      questions: questions.map((q) => ({
        question: q.question,
        options: q.options,
        correct: q.correct,
        subject: q.subject || "Weekly Mega Review",
        explanation: q.explanation || "",
        selected: null,
      })),
      totalQuestions: questions.length,
      timerDuration: 1800, // standard 30 minutes
      completed: false,
      isMegaExam: true,
      weekKey: currentWeekKey
    });

    await newExam.save();
    res.status(201).json(newExam);

  } catch (error) {
    console.error("Error starting Mega Exam:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/exams/current - Get current active (incomplete) exam
router.get("/current", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    // Find the latest incomplete exam
    const activeExam = await ExamAttempt.findOne({
      userId,
      completed: false,
    }).sort({ createdAt: -1 });
    res.json(activeExam);
  } catch (error) {
    console.error("Error fetching current exam:", error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/exams/start - Store a newly generated exam
router.post("/start", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { subjects, questions, timerDuration } = req.body;

    if (!questions || !questions.length) {
      return res
        .status(400)
        .json({ error: "Questions are required to start an exam." });
    }

    // First, invalidate any previous incomplete exams to avoid multiple active exams
    await ExamAttempt.updateMany(
      { userId, completed: false },
      { $set: { completed: true, score: 0, percentage: 0 } },
    );

    const newExam = new ExamAttempt({
      userId,
      subjects: subjects || [],
      questions: questions.map((q) => ({
        question: q.question,
        options: q.options,
        correct: q.correct,
        subject: q.subject || "Other",
        explanation: q.explanation || "",
        selected: null,
      })),
      totalQuestions: questions.length,
      timerDuration: timerDuration || 600, // default 10 minutes
      completed: false,
    });

    await newExam.save();
    res.status(201).json(newExam);
  } catch (error) {
    console.error("Error starting exam:", error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/exams/submit - Submit and grade an exam
router.post("/submit", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { examId, selections, timeSpent } = req.body;

    const exam = await ExamAttempt.findOne({ _id: examId, userId });
    if (!exam) {
      return res.status(404).json({ error: "Exam not found." });
    }

    if (exam.completed) {
      return res
        .status(400)
        .json({ error: "This exam has already been submitted." });
    }

    // Grade the exam
    let score = 0;
    exam.questions.forEach((q, idx) => {
      const selectedAns =
        selections[idx] !== undefined ? selections[idx] : null;
      q.selected = selectedAns;
      if (selectedAns !== null && Number(selectedAns) === Number(q.correct)) {
        score++;
      }
    });

    const percentage = Math.round((score / exam.totalQuestions) * 100);

    exam.score = score;
    exam.percentage = percentage;
    exam.timeSpent = timeSpent || 0;
    exam.completed = true;

    await exam.save();

    // Reward focus points for completing exams
    try {
      const User = require("../models/User");
      const userObj = await User.findById(userId);
      if (userObj) {
        // Base points for completing + bonus points for correct answers
        const pointsEarned = 50 + score * 10;
        userObj.focusPoints = (userObj.focusPoints || 0) + pointsEarned;
        userObj.examCount = (userObj.examCount || 0) + 1;
        await userObj.save();

        // Check achievements / recalculate leaderboard points
        const { recalculateUserPoints } = require("./leaderboard");
        await recalculateUserPoints(userId);
      }
    } catch (err) {
      console.error("Error rewarding points for exam:", err);
    }

    res.json(exam);
  } catch (error) {
    console.error("Error submitting exam:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/exams/history - Get completed exam history
router.get("/history", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const history = await ExamAttempt.find({ userId, completed: true }).sort({
      createdAt: -1,
    });
    res.json(history);
  } catch (error) {
    console.error("Error fetching exam history:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/exams/stats - Get exam statistics for progress tracking
router.get("/stats", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const exams = await ExamAttempt.find({ userId, completed: true }).sort({
      createdAt: 1,
    });

    if (exams.length === 0) {
      return res.json({
        totalExams: 0,
        averageScore: 0,
        averagePercentage: 0,
        bestScore: 0,
        recentTrend: [],
        subjectBreakdown: {},
        progressData: [],
      });
    }

    // Calculate stats
    const totalExams = exams.length;
    const totalScore = exams.reduce((sum, e) => sum + e.score, 0);
    const averageScore = Math.round(totalScore / totalExams);
    const totalPercentage = exams.reduce((sum, e) => sum + e.percentage, 0);
    const averagePercentage = Math.round(totalPercentage / totalExams);
    const bestScore = Math.max(...exams.map((e) => e.percentage));

    // Subject breakdown
    const subjectBreakdown = {};
    exams.forEach((exam) => {
      exam.subjects.forEach((subject) => {
        if (!subjectBreakdown[subject]) {
          subjectBreakdown[subject] = { count: 0, totalPercentage: 0 };
        }
        subjectBreakdown[subject].count++;
        subjectBreakdown[subject].totalPercentage += exam.percentage;
      });
    });

    // Calculate average per subject
    Object.keys(subjectBreakdown).forEach((subject) => {
      subjectBreakdown[subject].average = Math.round(
        subjectBreakdown[subject].totalPercentage /
          subjectBreakdown[subject].count,
      );
    });

    // Recent trend (last 10 exams)
    const recentTrend = exams.slice(-10).map((exam) => ({
      date: exam.createdAt,
      percentage: exam.percentage,
      score: exam.score,
      total: exam.totalQuestions,
    }));

    // Progress data for graph (chronological)
    const progressData = exams.map((exam, idx) => ({
      examNumber: idx + 1,
      percentage: exam.percentage,
      score: exam.score,
      total: exam.totalQuestions,
      date: exam.createdAt,
      subjects: exam.subjects.join(", "),
    }));

    res.json({
      totalExams,
      averageScore,
      averagePercentage,
      bestScore,
      recentTrend,
      subjectBreakdown,
      progressData,
    });
  } catch (error) {
    console.error("Error fetching exam stats:", error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/exams/:id - Delete an exam attempt and recalculate leaderboard / stats
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const examId = req.params.id;

    const exam = await ExamAttempt.findOne({ _id: examId, userId });
    if (!exam) {
      return res.status(404).json({ error: "Exam attempt not found." });
    }

    await ExamAttempt.deleteOne({ _id: examId, userId });

    // Decrement user's examCount and recalculate leaderboard points
    try {
      const User = require("../models/User");
      const userObj = await User.findById(userId);
      if (userObj) {
        userObj.examCount = Math.max(0, (userObj.examCount || 0) - 1);
        await userObj.save();
      }

      const { recalculateUserPoints } = require("./leaderboard");
      await recalculateUserPoints(userId);
    } catch (err) {
      console.error("Error updating user stats after exam deletion:", err);
    }

    res.json({ success: true, message: "Exam attempt deleted successfully." });
  } catch (error) {
    console.error("Error deleting exam attempt:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
