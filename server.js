const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://Tirthoraj:Tirthoraj@cluster0.nd9yv8x.mongodb.net/Uttsss?retryWrites=true&w=majority";

mongoose.connect(MONGODB_URI)
.then(() => console.log('MongoDB Connected to Uttsss'))
.catch(err => console.error('MongoDB connection error:', err));

// Models
const Tracker = require('./models/Tracker');
const Task = require('./models/Task');
const Goal = require('./models/Goal');
const TimerState = require('./models/TimerState');

// ─── TIMER STATE ROUTES ─────────────────────────────────
// GET current timer state
app.get('/api/timer', async (req, res) => {
  try {
    const userId = req.query.userId || "defaultUser";
    const timer = await TimerState.findOne({ userId });
    if (!timer || timer.status === 'stopped') {
      return res.status(200).json({ status: 'stopped', accumulatedSeconds: 0 });
    }
    
    // If running, compute live elapsed so client can verify
    let liveElapsed = timer.accumulatedSeconds;
    if (timer.status === 'running' && timer.startTime) {
      liveElapsed += (Date.now() - new Date(timer.startTime).getTime()) / 1000;
    }
    
    res.status(200).json({
      status: timer.status,
      startTime: timer.startTime,
      accumulatedSeconds: timer.accumulatedSeconds,
      liveElapsed: Math.floor(liveElapsed),
      topicId: timer.topicId,
      topicTitle: timer.topicTitle,
      subject: timer.subject,
      isPomodoroMode: timer.isPomodoroMode
    });
  } catch (error) {
    console.error("GET /api/timer error:", error);
    res.status(500).json({ error: error.message });
  }
});

// START or RESUME timer
app.post('/api/timer/start', async (req, res) => {
  try {
    const { userId = "defaultUser", topicId, topicTitle, subject, isPomodoroMode } = req.body;
    if (!topicId) return res.status(400).json({ error: "topicId required" });
    
    let timer = await TimerState.findOne({ userId });
    
    if (timer && timer.status === 'running') {
      // Already running — return current state (prevent duplicates)
      return res.status(200).json({ status: 'running', message: 'Timer already running', startTime: timer.startTime });
    }
    
    if (timer && timer.status === 'paused') {
      // RESUME: keep accumulated, set new startTime
      timer.status = 'running';
      timer.startTime = new Date();
      await timer.save();
    } else {
      // NEW timer: reset everything
      timer = await TimerState.findOneAndUpdate(
        { userId },
        {
          status: 'running',
          startTime: new Date(),
          accumulatedSeconds: 0,
          topicId: topicId || '',
          topicTitle: topicTitle || '',
          subject: subject || '',
          isPomodoroMode: isPomodoroMode || false
        },
        { upsert: true, new: true }
      );
    }
    
    res.status(200).json({ status: timer.status, startTime: timer.startTime, accumulatedSeconds: timer.accumulatedSeconds });
  } catch (error) {
    console.error("POST /api/timer/start error:", error);
    res.status(500).json({ error: error.message });
  }
});

// PAUSE timer
app.post('/api/timer/pause', async (req, res) => {
  try {
    const { userId = "defaultUser" } = req.body;
    const timer = await TimerState.findOne({ userId });
    
    if (!timer || timer.status !== 'running') {
      return res.status(200).json({ status: timer?.status || 'stopped', message: 'Timer not running' });
    }
    
    // Compute elapsed since startTime and add to accumulated
    const elapsedSinceStart = (Date.now() - new Date(timer.startTime).getTime()) / 1000;
    timer.accumulatedSeconds = Math.floor(timer.accumulatedSeconds + elapsedSinceStart);
    timer.startTime = null;
    timer.status = 'paused';
    await timer.save();
    
    res.status(200).json({ status: 'paused', accumulatedSeconds: timer.accumulatedSeconds });
  } catch (error) {
    console.error("POST /api/timer/pause error:", error);
    res.status(500).json({ error: error.message });
  }
});

// STOP timer — saves session and clears state
app.post('/api/timer/stop', async (req, res) => {
  try {
    const { userId = "defaultUser" } = req.body;
    const timer = await TimerState.findOne({ userId });
    
    if (!timer || timer.status === 'stopped') {
      return res.status(200).json({ status: 'stopped', duration: 0 });
    }
    
    // Compute final duration
    let totalSeconds = timer.accumulatedSeconds;
    if (timer.status === 'running' && timer.startTime) {
      totalSeconds += (Date.now() - new Date(timer.startTime).getTime()) / 1000;
    }
    totalSeconds = Math.floor(totalSeconds);
    
    // Save session to tracker if we have meaningful duration
    if (totalSeconds > 0 && timer.topicId) {
      await Tracker.findOneAndUpdate(
        { userId },
        { $push: { sessions: {
          duration: totalSeconds,
          topicId: timer.topicId,
          subject: timer.subject || '',
          timestamp: new Date()
        }}},
        { upsert: true, new: true }
      );
      
      // Also update topic timeSpent
      const tracker = await Tracker.findOne({ userId });
      if (tracker && tracker.topics) {
        const topicKey = timer.topicId;
        if (!tracker.topics[topicKey]) {
          tracker.topics[topicKey] = { status: 'pending', notes: '', timeSpent: 0 };
        }
        tracker.topics[topicKey].timeSpent = (tracker.topics[topicKey].timeSpent || 0) + totalSeconds;
        tracker.markModified('topics');
        await tracker.save();
      }
    }
    
    // Clear timer state
    timer.status = 'stopped';
    timer.startTime = null;
    timer.accumulatedSeconds = 0;
    timer.topicId = '';
    timer.topicTitle = '';
    timer.subject = '';
    await timer.save();
    
    res.status(200).json({ status: 'stopped', duration: totalSeconds, saved: totalSeconds > 0 });
  } catch (error) {
    console.error("POST /api/timer/stop error:", error);
    res.status(500).json({ error: error.message });
  }
});


// ─── IST Helper ──────────────────────────────────────────
function getISTDate(dateOb) {
  const istString = dateOb.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  return new Date(istString);
}

function getISTBoundaries() {
  const nowIST = getISTDate(new Date());
  
  const startOfToday = new Date(nowIST.getFullYear(), nowIST.getMonth(), nowIST.getDate()).getTime();
  
  const startOfWeek = new Date(startOfToday);
  const dayOfWeek = startOfWeek.getDay();
  const diffToMonday = startOfWeek.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
  startOfWeek.setDate(diffToMonday);
  
  const startOfMonth = new Date(nowIST.getFullYear(), nowIST.getMonth(), 1).getTime();
  
  return { nowIST, startOfToday, startOfWeek: startOfWeek.getTime(), startOfMonth };
}

// ─── TRACKER ROUTES ──────────────────────────────────────
app.get('/api/tracker', async (req, res) => {
  try {
    const userId = req.query.userId || "defaultUser";
    let tracker = await Tracker.findOne({ userId });
    
    if (!tracker) {
      return res.status(200).json({ 
        topics: {}, studyTimeSaved: 0,
        stats: { today: 0, weekly: 0, monthly: 0 }
      });
    }

    const { startOfToday, startOfWeek, startOfMonth } = getISTBoundaries();
    let today = 0, weekly = 0, monthly = 0;

    tracker.sessions.forEach(s => {
      const t = getISTDate(new Date(s.timestamp)).getTime();
      const d = s.duration || 0;
      if (t >= startOfToday) today += d;
      if (t >= startOfWeek) weekly += d;
      if (t >= startOfMonth) monthly += d;
    });
    
    const responseData = tracker.toObject();
    responseData.stats = { today, weekly, monthly };
    res.status(200).json(responseData);
  } catch (error) {
    console.error("GET /api/tracker error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/tracker', async (req, res) => {
  try {
    const { userId = "defaultUser", topics, studyTimeSaved, newSession } = req.body;
    const updateQuery = { topics, studyTimeSaved };
    
    if (newSession && newSession.duration > 0 && newSession.topicId) {
      updateQuery.$push = { sessions: newSession };
    }
    
    const tracker = await Tracker.findOneAndUpdate(
      { userId }, updateQuery, { new: true, upsert: true }
    );
    res.status(200).json({ success: true, studyTimeSaved: tracker.studyTimeSaved });
  } catch (error) {
    console.error("POST /api/tracker error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─── SESSION ROUTE (dedicated) ───────────────────────────
app.post('/api/sessions', async (req, res) => {
  try {
    const { userId = "defaultUser", duration, topicId, subject, timestamp } = req.body;
    if (!duration || !topicId) return res.status(400).json({ error: "duration and topicId required" });
    
    const session = { duration, topicId, subject: subject || "", timestamp: timestamp || new Date() };
    
    const tracker = await Tracker.findOneAndUpdate(
      { userId },
      { $push: { sessions: session } },
      { new: true, upsert: true }
    );
    res.status(200).json({ success: true, sessionCount: tracker.sessions.length });
  } catch (error) {
    console.error("POST /api/sessions error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─── DASHBOARD ANALYTICS ─────────────────────────────────
app.get('/api/dashboard', async (req, res) => {
  try {
    const userId = req.query.userId || "defaultUser";
    const tracker = await Tracker.findOne({ userId });
    const { nowIST, startOfToday, startOfWeek, startOfMonth } = getISTBoundaries();
    
    if (!tracker || !tracker.sessions.length) {
      return res.status(200).json({
        today: 0, weekly: 0, monthly: 0,
        subjectBreakdown: {},
        dailyGraph: {},
        weeklyBars: [0,0,0,0,0,0,0],
        streak: 0,
        mostProductiveDay: null,
        mostProductiveHour: null,
        monthComparison: { current: 0, previous: 0 },
        hourlyHeatmap: new Array(24).fill(0)
      });
    }

    const sessions = tracker.sessions;
    
    // ── Time totals ──
    let today = 0, weekly = 0, monthly = 0;
    
    // ── Subject breakdown (all time) ──
    const subjectBreakdown = {};
    
    // ── Daily graph for current month ──
    const daysInMonth = new Date(nowIST.getFullYear(), nowIST.getMonth() + 1, 0).getDate();
    const dailyGraph = {};
    for (let i = 1; i <= daysInMonth; i++) dailyGraph[i] = 0;
    
    // ── Weekly bars (Mon=0 to Sun=6) ──
    const weeklyBars = [0,0,0,0,0,0,0];
    
    // ── Hourly heatmap (0-23) ──
    const hourlyHeatmap = new Array(24).fill(0);
    
    // ── Day-level totals for streak + most productive day ──
    const dayTotals = {}; // "YYYY-MM-DD" -> seconds
    
    // ── Previous month total ──
    const prevMonthStart = new Date(nowIST.getFullYear(), nowIST.getMonth() - 1, 1).getTime();
    let prevMonthTotal = 0;

    sessions.forEach(s => {
      const sIST = getISTDate(new Date(s.timestamp));
      const sTime = sIST.getTime();
      const dur = s.duration || 0;
      const subj = s.subject || s.topicId.split('-')[0] || 'Other';
      
      // Time totals
      if (sTime >= startOfToday) today += dur;
      if (sTime >= startOfWeek) {
        weekly += dur;
        const dow = sIST.getDay();
        weeklyBars[dow === 0 ? 6 : dow - 1] += dur; // Mon=0, Sun=6
      }
      if (sTime >= startOfMonth) {
        monthly += dur;
        dailyGraph[sIST.getDate()] = (dailyGraph[sIST.getDate()] || 0) + dur;
      }
      
      // Previous month
      if (sTime >= prevMonthStart && sTime < startOfMonth) {
        prevMonthTotal += dur;
      }
      
      // Subject breakdown (all time)
      subjectBreakdown[subj] = (subjectBreakdown[subj] || 0) + dur;
      
      // Hourly heatmap
      hourlyHeatmap[sIST.getHours()] += dur;
      
      // Day totals for streak calc
      const dayKey = `${sIST.getFullYear()}-${String(sIST.getMonth()+1).padStart(2,'0')}-${String(sIST.getDate()).padStart(2,'0')}`;
      dayTotals[dayKey] = (dayTotals[dayKey] || 0) + dur;
    });
    
    // ── Streak calculation ──
    let streak = 0;
    const todayKey = `${nowIST.getFullYear()}-${String(nowIST.getMonth()+1).padStart(2,'0')}-${String(nowIST.getDate()).padStart(2,'0')}`;
    let checkDate = new Date(nowIST.getFullYear(), nowIST.getMonth(), nowIST.getDate());
    
    // If no study today yet, start checking from yesterday
    if (!dayTotals[todayKey] || dayTotals[todayKey] < 1) {
      checkDate.setDate(checkDate.getDate() - 1);
    }
    
    for (let i = 0; i < 365; i++) {
      const key = `${checkDate.getFullYear()}-${String(checkDate.getMonth()+1).padStart(2,'0')}-${String(checkDate.getDate()).padStart(2,'0')}`;
      if (dayTotals[key] && dayTotals[key] >= 30) { // minimum 30 seconds to count
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }
    
    // ── Most productive day ──
    let mostProductiveDay = null;
    let maxDaySeconds = 0;
    for (const [day, secs] of Object.entries(dayTotals)) {
      if (secs > maxDaySeconds) {
        maxDaySeconds = secs;
        mostProductiveDay = day;
      }
    }
    
    // ── Most productive hour ──
    let mostProductiveHour = 0;
    let maxHourSeconds = 0;
    hourlyHeatmap.forEach((secs, hour) => {
      if (secs > maxHourSeconds) {
        maxHourSeconds = secs;
        mostProductiveHour = hour;
      }
    });

    res.status(200).json({
      today, weekly, monthly,
      subjectBreakdown,
      dailyGraph,
      weeklyBars,
      streak,
      mostProductiveDay,
      mostProductiveDaySeconds: maxDaySeconds,
      mostProductiveHour,
      monthComparison: { current: monthly, previous: prevMonthTotal },
      hourlyHeatmap
    });
  } catch (error) {
    console.error("GET /api/dashboard error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─── TASKS CRUD ──────────────────────────────────────────
app.get('/api/tasks', async (req, res) => {
  try {
    const userId = req.query.userId || "defaultUser";
    const tasks = await Task.find({ userId }).sort({ createdAt: -1 });
    res.status(200).json(tasks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const { userId = "defaultUser", title, subject, dueDate, isRepeating, repeatInterval } = req.body;
    if (!title) return res.status(400).json({ error: "title required" });
    
    const task = new Task({ userId, title, subject, dueDate, isRepeating, repeatInterval });
    await task.save();
    res.status(201).json(task);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/tasks/:id', async (req, res) => {
  try {
    const updates = req.body;
    if (updates.completed) updates.completedAt = new Date();
    
    const task = await Task.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.status(200).json(task);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    await Task.findByIdAndDelete(req.params.id);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GOALS CRUD ──────────────────────────────────────────
app.get('/api/goals', async (req, res) => {
  try {
    const userId = req.query.userId || "defaultUser";
    const goals = await Goal.find({ userId }).sort({ month: -1 });
    res.status(200).json(goals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/goals', async (req, res) => {
  try {
    const { userId = "defaultUser", title, targetHours, month } = req.body;
    if (!title || !targetHours || !month) return res.status(400).json({ error: "title, targetHours, month required" });
    
    const goal = new Goal({ userId, title, targetHours, month });
    await goal.save();
    res.status(201).json(goal);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/goals/:id', async (req, res) => {
  try {
    const goal = await Goal.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!goal) return res.status(404).json({ error: "Goal not found" });
    res.status(200).json(goal);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/goals/:id', async (req, res) => {
  try {
    await Goal.findByIdAndDelete(req.params.id);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── START SERVER ────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
