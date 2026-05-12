const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/auth");
const ExamAttempt = require("../models/ExamAttempt");
const Tracker = require("../models/Tracker");

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

module.exports = router;
