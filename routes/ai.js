const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const Tracker = require('../models/Tracker');
const Goal = require('../models/Goal');
const Task = require('../models/Task');

// Helper: analyze habits
function analyzeHabits(tracker, goals, tasks) {
  const subjects = {};
  const sessions = tracker?.sessions || [];
  
  sessions.forEach(s => {
    const subj = s.subject || 'Other';
    if (!subjects[subj]) subjects[subj] = { totalTime: 0, sessions: 0, recentTime: 0 };
    subjects[subj].totalTime += s.duration;
    subjects[subj].sessions++;
    
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
  const pendingTasks = (tasks || []).filter(t => !t.completed).length;
  const completedTasks = (tasks || []).filter(t => t.completed).length;
  
  // Topics progress
  const topics = tracker?.topics || {};
  const doneTopics = Object.values(topics).filter(t => t.status === 'done').length;
  const reviseTopics = Object.values(topics).filter(t => t.status === 'revise').length;
  const totalTopics = Object.keys(topics).length;
  
  return {
    subjects,
    weakestSubject: weakest ? { name: weakest[0], ...weakest[1] } : null,
    strongestSubject: strongest ? { name: strongest[0], ...strongest[1] } : null,
    pendingTasks,
    completedTasks,
    doneTopics,
    reviseTopics,
    totalTopics,
    totalStudyHours: Math.round(sessions.reduce((acc, s) => acc + s.duration, 0) / 3600 * 10) / 10
  };
}

// POST /api/ai/recommendations
router.post('/recommendations', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const tracker = await Tracker.findOne({ userId });
    const goals = await Goal.find({ userId });
    const tasks = await Task.find({ userId });
    
    const analysis = analyzeHabits(tracker, goals, tasks);
    
    if (!analysis || !analysis.weakestSubject) {
      return res.json({
        recommendation: "Start your study journey! Pick any subject from the roadmap and begin with the first topic. Aim for at least 30 minutes today.",
        priority: "Start Studying",
        analysis: { totalStudyHours: 0 }
      });
    }
    
    // Generate smart recommendation without LLM
    let recommendation = '';
    let priority = '';
    
    if (analysis.reviseTopics > 3) {
      recommendation = `You have ${analysis.reviseTopics} topics marked for revision. Focus on revising "${analysis.weakestSubject.name}" first — it has the least recent study time (${Math.round(analysis.weakestSubject.recentTime / 60)} min this week). Revision before new topics builds stronger retention.`;
      priority = 'Revision Sprint';
    } else if (analysis.weakestSubject.recentTime < 1800) {
      recommendation = `"${analysis.weakestSubject.name}" needs attention — only ${Math.round(analysis.weakestSubject.recentTime / 60)} minutes this week. Your strongest area "${analysis.strongestSubject.name}" has ${Math.round(analysis.strongestSubject.recentTime / 60)} min. Balance your schedule for better exam prep.`;
      priority = `Focus: ${analysis.weakestSubject.name}`;
    } else if (analysis.pendingTasks > 5) {
      recommendation = `You have ${analysis.pendingTasks} pending tasks! Clear at least 3 today. Task completion momentum boosts confidence and helps maintain your study streak.`;
      priority = 'Clear Pending Tasks';
    } else {
      recommendation = `Great balance! You've studied ${analysis.totalStudyHours} hours total across ${Object.keys(analysis.subjects).length} subjects. Keep pushing "${analysis.weakestSubject.name}" to match your other subjects. Consistency is key!`;
      priority = 'Maintain Momentum';
    }
    
    // If Gemini API key is available, enhance with AI
    if (process.env.GEMINI_API_KEY) {
      try {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        const prompt = `You are an expert SSC exam coach. Based on this student's study data:
- Total study hours: ${analysis.totalStudyHours}
- Weakest subject this week: ${analysis.weakestSubject.name} (${Math.round(analysis.weakestSubject.recentTime / 60)} min)
- Strongest subject this week: ${analysis.strongestSubject.name} (${Math.round(analysis.strongestSubject.recentTime / 60)} min)
- Topics done: ${analysis.doneTopics}, needs revision: ${analysis.reviseTopics}
- Pending tasks: ${analysis.pendingTasks}

Give ONE specific, actionable study recommendation in 2-3 sentences. Be motivating but firm.`;
        
        const result = await model.generateContent(prompt);
        const aiText = result.response.text();
        if (aiText) recommendation = aiText;
      } catch (aiError) {
        console.log('AI enhancement skipped:', aiError.message);
      }
    }
    
    res.json({ recommendation, priority, analysis });
  } catch (error) {
    console.error('AI Recommendation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/ai/flashcards
router.post('/flashcards', authMiddleware, async (req, res) => {
  try {
    const { topicId, topicTitle, notes } = req.body;
    
    if (!notes || notes.trim().length < 10) {
      return res.status(400).json({ error: 'Notes must be at least 10 characters to generate flashcards.' });
    }
    
    // Generate flashcards from notes
    let flashcards = [];
    
    // Smart extraction: split notes into key points
    const lines = notes.split(/[\n.!?]+/).filter(l => l.trim().length > 5);
    
    if (process.env.GEMINI_API_KEY) {
      try {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        const prompt = `Create exactly 5 flashcards from these study notes on "${topicTitle}":
"${notes}"

Return ONLY a JSON array with this format (no markdown, no explanation):
[{"front":"question","back":"answer"},...]`;
        
        const result = await model.generateContent(prompt);
        const text = result.response.text().replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        flashcards = JSON.parse(text);
      } catch (aiError) {
        console.log('AI flashcard generation failed, using fallback:', aiError.message);
      }
    }
    
    // Fallback: generate simple flashcards from parsed notes
    if (flashcards.length === 0) {
      flashcards = lines.slice(0, 5).map((line, i) => ({
        front: `What do you know about: ${line.trim().substring(0, 60)}...?`,
        back: line.trim()
      }));
      
      if (flashcards.length === 0) {
        flashcards = [{ front: `Summarize the key points of "${topicTitle}"`, back: notes.substring(0, 200) }];
      }
    }
    
    res.json({ flashcards, topicTitle });
  } catch (error) {
    console.error('Flashcard generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/ai/quiz
router.post('/quiz', authMiddleware, async (req, res) => {
  try {
    const { topicId, topicTitle, notes } = req.body;
    
    if (!notes || notes.trim().length < 10) {
      return res.status(400).json({ error: 'Notes must be at least 10 characters to generate a quiz.' });
    }
    
    let questions = [];
    
    if (process.env.GEMINI_API_KEY) {
      try {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        const prompt = `Create a 5-question multiple choice quiz from these notes on "${topicTitle}":
"${notes}"

Return ONLY a JSON array (no markdown):
[{"question":"...","options":["A","B","C","D"],"correct":0},...]
where correct is the 0-based index of the right answer.`;
        
        const result = await model.generateContent(prompt);
        const text = result.response.text().replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        questions = JSON.parse(text);
      } catch (aiError) {
        console.log('AI quiz generation failed, using fallback:', aiError.message);
      }
    }
    
    // Fallback quiz
    if (questions.length === 0) {
      questions = [
        {
          question: `Which topic is being studied in this session?`,
          options: [topicTitle, 'Mathematics', 'Geography', 'Literature'],
          correct: 0
        },
        {
          question: `Based on your notes, what is the primary concept covered?`,
          options: ['Not covered', notes.substring(0, 30) + '...', 'All of the above', 'None of the above'],
          correct: 1
        }
      ];
    }
    
    res.json({ questions, topicTitle });
  } catch (error) {
    console.error('Quiz generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/ai/forecast
router.get('/forecast', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const tracker = await Tracker.findOne({ userId });
    
    if (!tracker || !tracker.sessions || tracker.sessions.length < 3) {
      return res.json({
        forecast: null,
        message: 'Need at least 3 study sessions to generate a forecast.'
      });
    }
    
    const sessions = tracker.sessions;
    const topics = tracker.topics || {};
    
    // Calculate velocity: topics completed per week
    const doneTopics = Object.values(topics).filter(t => t.status === 'done').length;
    const totalTopics = 83; // Total SSC syllabus topics
    const remaining = totalTopics - doneTopics;
    
    // Calculate average study time per day over last 30 days
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recentSessions = sessions.filter(s => new Date(s.timestamp).getTime() > thirtyDaysAgo);
    const totalRecentSeconds = recentSessions.reduce((acc, s) => acc + s.duration, 0);
    const daysActive = new Set(recentSessions.map(s => new Date(s.timestamp).toDateString())).size || 1;
    const avgSecondsPerDay = totalRecentSeconds / Math.max(daysActive, 1);
    const avgHoursPerDay = Math.round(avgSecondsPerDay / 3600 * 10) / 10;
    
    // Linear regression: estimate days to complete
    const topicsPerDay = doneTopics > 0 ? doneTopics / Math.max(daysActive, 1) : 0.5;
    const estimatedDaysToComplete = remaining > 0 ? Math.ceil(remaining / topicsPerDay) : 0;
    
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
        velocityTrend: avgHoursPerDay >= 4 ? 'on_track' : avgHoursPerDay >= 2 ? 'needs_improvement' : 'at_risk'
      }
    });
  } catch (error) {
    console.error('Forecast error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
