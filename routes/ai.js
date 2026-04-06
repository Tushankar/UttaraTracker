const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/auth");
const Tracker = require("../models/Tracker");
const Goal = require("../models/Goal");
const Task = require("../models/Task");

// Helper: analyze habits WITH FULL SYLLABUS SYNC and Optional Subject Focus
function analyzeHabits(
  tracker,
  goals,
  tasks,
  allSubjects = [],
  focusSubject = null,
) {
  const subjects = {};
  const sessions = tracker?.sessions || [];

  // 1. Initialize subjects list
  const subjectsToTrack =
    focusSubject && allSubjects.includes(focusSubject)
      ? [focusSubject]
      : allSubjects;

  subjectsToTrack.forEach((subj) => {
    if (!subjects[subj]) {
      subjects[subj] = {
        totalTime: 0,
        sessions: 0,
        recentTime: 0,
        isNew: true,
        topics: {}, // Track topic-level stats if focusing
      };
    }
  });

  // 2. Process sessions
  sessions.forEach((s) => {
    const subj = s.subject || "Other";

    // If focusing, ONLY count sessions for that subject
    if (focusSubject && subj !== focusSubject) return;

    if (!subjects[subj]) {
      subjects[subj] = {
        totalTime: 0,
        sessions: 0,
        recentTime: 0,
        isNew: true,
        topics: {},
      };
    }

    subjects[subj].totalTime += s.duration;
    subjects[subj].sessions++;
    subjects[subj].isNew = false;

    // Track topic-level time
    if (focusSubject && s.topicId) {
      const tId = s.topicId;
      if (!subjects[subj].topics[tId]) subjects[subj].topics[tId] = 0;
      subjects[subj].topics[tId] += s.duration;
    }

    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    if (new Date(s.timestamp).getTime() > weekAgo) {
      subjects[subj].recentTime += s.duration;
    }
  });

  const subjectEntries = Object.entries(subjects);
  if (subjectEntries.length === 0) return null;

  // 3. Find target area
  let targetArea = null;
  if (focusSubject) {
    // If focusing, find the weakest TOPIC within this subject
    // We need to know ALL topics in this subject (from tracker.topics)
    const subjectTopics = Object.entries(tracker?.topics || {}).filter(
      ([_, meta]) => meta.subject === focusSubject || _.startsWith(focusSubject),
    );

    const topicStats = subjectTopics.map(([id, meta]) => ({
      id,
      title: meta.title || id,
      time: subjects[focusSubject]?.topics[id] || 0,
      status: meta.status,
    }));

    topicStats.sort((a, b) => a.time - b.time);
    targetArea = topicStats[0]; // Weakest topic
  } else {
    // General mode: weakest overall subject
    subjectEntries.sort((a, b) => a[1].recentTime - b[1].recentTime);
    const weakest = subjectEntries[0];
    targetArea = weakest ? { name: weakest[0], ...weakest[1] } : null;
  }

  const strongest = focusSubject
    ? null
    : subjectEntries.sort((a, b) => b[1].recentTime - a[1].recentTime)[0];

  // 4. Pending tasks (optionally filter by subject if focusing)
  const pendingTasks = (tasks || []).filter(
    (t) => !t.completed && (!focusSubject || t.subject === focusSubject),
  ).length;

  // 5. Topics progress summary
  const topics = tracker?.topics || {};
  const filterTopics = focusSubject
    ? Object.entries(topics).filter(
        ([id, meta]) => meta.subject === focusSubject || id.startsWith(focusSubject),
      )
    : Object.entries(topics);

  const doneCount = filterTopics.filter(
    ([_, t]) => t.status === "done",
  ).length;
  const reviseCount = filterTopics.filter(
    ([_, t]) => t.status === "revise",
  ).length;

  return {
    subjects,
    focusSubject,
    weakestArea: targetArea, // Topic if focus, Subject if general
    strongestSubject: strongest
      ? { name: strongest[0], ...strongest[1] }
      : null,
    pendingTasks,
    doneTopics: doneCount,
    reviseTopics: reviseCount,
    totalStudyHours:
      Math.round(
        (sessions
          .filter((s) => !focusSubject || (s.subject || "Other") === focusSubject)
          .reduce((acc, s) => acc + s.duration, 0) / 3600) *
          10,
      ) / 10,
  };
}

// POST /api/ai/recommendations
router.post("/recommendations", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { allSubjects = [], selectedSubject = null } = req.body;
    const tracker = await Tracker.findOne({ userId });
    const goals = await Goal.find({ userId });
    const tasks = await Task.find({ userId });

    const analysis = analyzeHabits(
      tracker,
      goals,
      tasks,
      allSubjects,
      selectedSubject,
    );

    if (!analysis || !analysis.weakestArea) {
      const msg = selectedSubject
        ? `Start studying "${selectedSubject}" to get personal recommendations! Pick a topic from the roadmap and begin.`
        : "Start your study journey! Pick any subject and begin with the first topic.";
      return res.json({
        recommendation: msg,
        priority: "Start Studying",
        analysis: { totalStudyHours: 0, newSubjects: allSubjects },
      });
    }

    let recommendation = "";
    let priority = "";

    if (selectedSubject) {
      // Subject specific rules
      if (analysis.reviseTopics > 2) {
        recommendation = `You have ${analysis.reviseTopics} topics in ${selectedSubject} that need revision. Prioritize reviewing "${analysis.weakestArea.title || analysis.weakestArea.id}" before moving to new syllabus items.`;
        priority = `${selectedSubject} Revision`;
      } else if (analysis.pendingTasks > 0) {
        recommendation = `Focus on your pending tasks for ${selectedSubject}. Complete them to maintain your momentum in this subject.`;
        priority = `${selectedSubject} Tasks`;
      } else {
        recommendation = `You've studied ${selectedSubject} for ${analysis.totalStudyHours} hours. Excellent progress! Your next focus should be "${analysis.weakestArea.title || analysis.weakestArea.id}" to ensure complete coverage.`;
        priority = `${selectedSubject} Mastery`;
      }
    } else {
      // General logic (fallback)
      if (analysis.reviseTopics > 3) {
        recommendation = `Overall, you have ${analysis.reviseTopics} topics to revise. Focus on ${analysis.weakestArea.name} as it has the least coverage recently.`;
        priority = "Revision Sprint";
      } else {
        recommendation = `Great balance across ${Object.keys(analysis.subjects).length} subjects! Keep pushing ${analysis.weakestArea.name} which needs a bit more attention today.`;
        priority = "Maintain Momentum";
      }
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
