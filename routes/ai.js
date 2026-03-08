const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/auth");
const Tracker = require("../models/Tracker");
const Goal = require("../models/Goal");
const Task = require("../models/Task");

// Helper: analyze habits WITH FULL SYLLABUS SYNC
function analyzeHabits(tracker, goals, tasks, allSubjects = []) {
  const subjects = {};
  const sessions = tracker?.sessions || [];

  // First, initialize ALL subjects from syllabus (newly added or not started)
  allSubjects.forEach((subj) => {
    if (!subjects[subj]) {
      subjects[subj] = {
        totalTime: 0,
        sessions: 0,
        recentTime: 0,
        isNew: true,
      };
    }
  });

  // Then, overlay actual study sessions
  sessions.forEach((s) => {
    const subj = s.subject || "Other";
    if (!subjects[subj])
      subjects[subj] = {
        totalTime: 0,
        sessions: 0,
        recentTime: 0,
        isNew: true,
      };
    subjects[subj].totalTime += s.duration;
    subjects[subj].sessions++;
    subjects[subj].isNew = false; // Mark as started

    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    if (new Date(s.timestamp).getTime() > weekAgo) {
      subjects[subj].recentTime += s.duration;
    }
  });

  // Find weakest subject (least recent time)
  const subjectEntries = Object.entries(subjects);
  if (subjectEntries.length === 0) return null;

  subjectEntries.sort((a, b) => a[1].recentTime - b[1].recentTime);
  const weakest = subjectEntries[0];
  const strongest = subjectEntries[subjectEntries.length - 1];

  // Pending tasks
  const pendingTasks = (tasks || []).filter((t) => !t.completed).length;
  const completedTasks = (tasks || []).filter((t) => t.completed).length;

  // Topics progress
  const topics = tracker?.topics || {};
  const doneTopics = Object.values(topics).filter(
    (t) => t.status === "done",
  ).length;
  const reviseTopics = Object.values(topics).filter(
    (t) => t.status === "revise",
  ).length;
  const totalTopics = Object.keys(topics).length;

  // Track newly added subjects (not yet studied)
  const newSubjects = Object.entries(subjects)
    .filter(([_, data]) => data.isNew && data.sessions === 0)
    .map(([name]) => name);

  return {
    subjects,
    weakestSubject: weakest ? { name: weakest[0], ...weakest[1] } : null,
    strongestSubject: strongest
      ? { name: strongest[0], ...strongest[1] }
      : null,
    newSubjects, // Newly added subjects not yet started
    pendingTasks,
    completedTasks,
    doneTopics,
    reviseTopics,
    totalTopics,
    totalStudyHours:
      Math.round(
        (sessions.reduce((acc, s) => acc + s.duration, 0) / 3600) * 10,
      ) / 10,
  };
}

// POST /api/ai/recommendations
router.post("/recommendations", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { allSubjects = [] } = req.body; // Client sends all subjects from syllabusData
    const tracker = await Tracker.findOne({ userId });
    const goals = await Goal.find({ userId });
    const tasks = await Task.find({ userId });

    // Pass all subjects so analysis includes newly added subjects
    const analysis = analyzeHabits(tracker, goals, tasks, allSubjects);

    if (!analysis || !analysis.weakestSubject) {
      return res.json({
        recommendation:
          "Start your study journey! Pick any subject from the roadmap and begin with the first topic. Aim for at least 30 minutes today.",
        priority: "Start Studying",
        analysis: { totalStudyHours: 0, newSubjects: allSubjects },
      });
    }

    // Generate smart recommendation without LLM
    let recommendation = "";
    let priority = "";

    // Check if there are newly added subjects to surface
    if (analysis.newSubjects && analysis.newSubjects.length > 0) {
      const newSubjectsList = analysis.newSubjects.slice(0, 3).join(", ");
      recommendation = `You've added ${analysis.newSubjects.length} new subject(s): ${newSubjectsList}. Start with these before diving deeper into existing subjects. Then focus on "${analysis.weakestSubject.name}" which needs attention.`;
      priority = `Start New Subjects: ${newSubjectsList}`;
    } else if (analysis.reviseTopics > 3) {
      recommendation = `You have ${analysis.reviseTopics} topics marked for revision. Focus on revising "${analysis.weakestSubject.name}" first — it has the least recent study time (${Math.round(analysis.weakestSubject.recentTime / 60)} min this week). Revision before new topics builds stronger retention.`;
      priority = "Revision Sprint";
    } else if (analysis.weakestSubject.recentTime < 1800) {
      recommendation = `"${analysis.weakestSubject.name}" needs attention — only ${Math.round(analysis.weakestSubject.recentTime / 60)} minutes this week. Your strongest area "${analysis.strongestSubject.name}" has ${Math.round(analysis.strongestSubject.recentTime / 60)} min. Balance your schedule for better exam prep.`;
      priority = `Focus: ${analysis.weakestSubject.name}`;
    } else if (analysis.pendingTasks > 5) {
      recommendation = `You have ${analysis.pendingTasks} pending tasks! Clear at least 3 today. Task completion momentum boosts confidence and helps maintain your study streak.`;
      priority = "Clear Pending Tasks";
    } else {
      recommendation = `Great balance! You've studied ${analysis.totalStudyHours} hours total across ${Object.keys(analysis.subjects).length} subjects. Keep pushing "${analysis.weakestSubject.name}" to match your other subjects. Consistency is key!`;
      priority = "Maintain Momentum";
    }

    res.json({ recommendation, priority, analysis });
  } catch (error) {
    console.error("AI Recommendation error:", error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/ai/flashcards
router.post("/flashcards", authMiddleware, async (req, res) => {
  try {
    const { topicId, topicTitle, notes } = req.body;

    if (!notes || notes.trim().length < 10) {
      return res.status(400).json({
        error: "Notes must be at least 10 characters to generate flashcards.",
      });
    }

    // Generate flashcards from notes
    let flashcards = [];

    // Smart extraction: split notes into key points
    const lines = notes.split(/[\n.!?]+/).filter((l) => l.trim().length > 5);

    // Fallback: generate simple flashcards from parsed notes
    if (flashcards.length === 0) {
      flashcards = lines.slice(0, 5).map((line, i) => ({
        front: `What do you know about: ${line.trim().substring(0, 60)}...?`,
        back: line.trim(),
      }));

      if (flashcards.length === 0) {
        flashcards = [
          {
            front: `Summarize the key points of "${topicTitle}"`,
            back: notes.substring(0, 200),
          },
        ];
      }
    }

    res.json({ flashcards, topicTitle });
  } catch (error) {
    console.error("Flashcard generation error:", error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/ai/quiz
router.post("/quiz", authMiddleware, async (req, res) => {
  try {
    const { topicId, topicTitle, notes } = req.body;

    if (!notes || notes.trim().length < 10) {
      return res.status(400).json({
        error: "Notes must be at least 10 characters to generate a quiz.",
      });
    }

    let questions = [];

    // Fallback quiz
    if (questions.length === 0) {
      questions = [
        {
          question: `Which topic is being studied in this session?`,
          options: [topicTitle, "Mathematics", "Geography", "Literature"],
          correct: 0,
        },
        {
          question: `Based on your notes, what is the primary concept covered?`,
          options: [
            "Not covered",
            notes.substring(0, 30) + "...",
            "All of the above",
            "None of the above",
          ],
          correct: 1,
        },
      ];
    }

    res.json({ questions, topicTitle });
  } catch (error) {
    console.error("Quiz generation error:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/ai/forecast
router.get("/forecast", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const tracker = await Tracker.findOne({ userId });

    if (!tracker || !tracker.sessions || tracker.sessions.length < 3) {
      return res.json({
        forecast: null,
        message: "Need at least 3 study sessions to generate a forecast.",
      });
    }

    const sessions = tracker.sessions;
    const topics = tracker.topics || {};

    // Calculate velocity: topics completed per week
    const doneTopics = Object.values(topics).filter(
      (t) => t.status === "done",
    ).length;
    // Estimate total topics (since it can grow dynamically, base it on the max of what they have or a baseline 83)
    const totalTopics = Math.max(83, Object.keys(topics).length + 10);
    const remaining = Math.max(0, totalTopics - doneTopics);

    // Calculate average study time per day over last 30 days
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recentSessions = sessions.filter(
      (s) => new Date(s.timestamp).getTime() > thirtyDaysAgo,
    );
    const totalRecentSeconds = recentSessions.reduce(
      (acc, s) => acc + s.duration,
      0,
    );
    const daysActive =
      new Set(recentSessions.map((s) => new Date(s.timestamp).toDateString()))
        .size || 1;
    const avgSecondsPerDay = totalRecentSeconds / Math.max(daysActive, 1);
    const avgHoursPerDay = Math.round((avgSecondsPerDay / 3600) * 10) / 10;

    // Linear regression: estimate days to complete
    const topicsPerDay =
      doneTopics > 0 ? doneTopics / Math.max(daysActive, 1) : 0.5;
    const estimatedDaysToComplete =
      remaining > 0 ? Math.ceil(remaining / topicsPerDay) : 0;

    const completionDate = new Date();
    completionDate.setDate(completionDate.getDate() + estimatedDaysToComplete);

    res.json({
      forecast: {
        completedTopics: doneTopics,
        totalTopics,
        remaining,
        avgHoursPerDay,
        topicsPerDay: Math.round(topicsPerDay * 100) / 100,
        estimatedDaysToComplete,
        estimatedCompletionDate: completionDate.toISOString(),
        velocityTrend:
          avgHoursPerDay >= 4
            ? "on_track"
            : avgHoursPerDay >= 2
              ? "needs_improvement"
              : "at_risk",
      },
    });
  } catch (error) {
    console.error("Forecast error:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
