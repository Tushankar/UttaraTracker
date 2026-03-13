const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      "https://studytrackertt.netlify.app",
      "https://uttaratracker.onrender.com",
      "http://localhost:3000",
      "https://uttaratracker.onrender.com",
      "http://127.0.0.1:5501",
    ],
    credentials: true,
  },
});
const PORT = process.env.PORT || 5000;

// Middleware
app.use(
  cors({
    origin: [
      "https://studytrackertt.netlify.app",
      "https://uttaratracker.onrender.com",
      "http://localhost:3000",
      "https://uttaratracker.onrender.com",
      "http://127.0.0.1:5501",
    ],
    credentials: true,
  }),
);
app.use(express.json({ limit: "10mb" }));

// Serve client static files
app.use(express.static(path.join(__dirname, "..", "client")));

// Serve uploads
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// MongoDB Connection
const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://Tirthoraj:Tirthoraj@cluster0.nd9yv8x.mongodb.net/Uttsss?retryWrites=true&w=majority";

mongoose
  .connect(MONGODB_URI)
  .then(() => console.log("✅ MongoDB Connected (Primary)"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Backup Sync System (lazy load to avoid early require errors)
let startBackupSync = null;
let recoverFromBackup = null;

// Models
const Tracker = require("./models/Tracker");
const Task = require("./models/Task");
const Goal = require("./models/Goal");
const TimerState = require("./models/TimerState");

// Auth
const { authMiddleware, optionalAuth } = require("./middleware/auth");
const authRoutes = require("./routes/auth");
const aiRoutes = require("./routes/ai");
const leaderboardRoutes = require("./routes/leaderboard");
const badgeRoutes = require("./routes/badges");
const chatRoutes = require("./routes/chat");
const taskRoutes = require("./routes/tasks");
const goalRoutes = require("./routes/goals");

// Route mounts
app.use("/api/auth", authRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/leaderboard", leaderboardRoutes);
app.use("/api/badges", badgeRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/goals", goalRoutes);

// ─── GLOBAL CHAT ROUTES & SOCKETS ────────────────────────
const GlobalMessage = require("./models/GlobalMessage");

function getStartOfISTDay() {
  const d = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
  );
  d.setHours(0, 0, 0, 0);
  return d;
}

app.get("/api/global-chat", authMiddleware, async (req, res) => {
  try {
    const startOfToday = getStartOfISTDay();

    // Deleting previous day messages automatically from the database
    await GlobalMessage.deleteMany({ timestamp: { $lt: startOfToday } });

    // Only show today's messages
    const messages = await GlobalMessage.find({
      timestamp: { $gte: startOfToday },
    })
      .sort({ timestamp: 1 })
      .limit(200);

    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const activeLearners = new Map(); // userId -> { displayName, avatar, status }

io.on("connection", (socket) => {
  console.log("User connected to global chat:", socket.id);

  // Send initial active learners list to new connection
  socket.emit("active_learners_list", Array.from(activeLearners.values()));

  socket.on("send_global_message", async (data) => {
    try {
      const newMsg = new GlobalMessage({
        senderId: data.senderId,
        displayName: data.displayName,
        avatar: data.avatar,
        content: data.content,
      });
      await newMsg.save();

      // Broadcast to everyone (including sender)
      io.emit("receive_global_message", newMsg);
    } catch (err) {
      console.error("Socket message save error:", err);
    }
  });

  socket.on("delete_message", async (data) => {
    // data: { messageId, userId }
    try {
      const msg = await GlobalMessage.findById(data.messageId);
      if (!msg) return;

      // Security: Only sender can delete for everyone
      if (msg.senderId.toString() !== data.userId) return;

      msg.isDeleted = true;
      msg.content = "This message was deleted";
      await msg.save();

      io.emit("message_updated", msg);
    } catch (err) {
      console.error("Delete message error:", err);
    }
  });

  socket.on("mark_read", async (data) => {
    // data: { messageId, userId, displayName, avatar }
    try {
      const msg = await GlobalMessage.findById(data.messageId);
      if (!msg || msg.isDeleted) return;

      // Don't mark self-messages as read by self for now, or just check if already in list
      const alreadyRead = msg.readBy.some((r) => r.userId === data.userId);
      if (!alreadyRead) {
        msg.readBy.push({
          userId: data.userId,
          displayName: data.displayName,
          avatar: data.avatar,
          at: new Date(),
        });
        await msg.save();
        io.emit("message_updated", msg);
      }
    } catch (err) {
      console.error("Mark read error:", err);
    }
  });

  socket.on("update_status", (data) => {
    // data: { userId, displayName, avatar, status: 'studying' | 'idle' }
    if (data.status === "studying") {
      activeLearners.set(data.userId, {
        userId: data.userId,
        displayName: data.displayName,
        avatar: data.avatar,
        status: "studying",
      });
    } else {
      activeLearners.delete(data.userId);
    }

    // Broadcast status to global chat for hover indicator
    socket.broadcast.emit("user_status_changed", data);

    // Broadcast full active learners list for the top bar
    io.emit("active_learners_list", Array.from(activeLearners.values()));
  });

  // Typing indicator events
  socket.on("user_typing", (data) => {
    // data: { userId, displayName }
    socket.broadcast.emit("user_typing", data);
  });

  socket.on("user_stop_typing", (data) => {
    // data: { userId }
    socket.broadcast.emit("user_stop_typing", data);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    // Broadcast stop typing on disconnect so indicators clear
    socket.broadcast.emit("user_stop_typing", { userId: socket.id });
  });
});

// Periodic Cleanup: Delete messages from previous days every hour
setInterval(async () => {
  try {
    const startOfToday = getStartOfISTDay();
    const result = await GlobalMessage.deleteMany({
      timestamp: { $lt: startOfToday },
    });
    if (result.deletedCount > 0) {
      console.log(
        `🧹 Periodic cleanup: Deleted ${result.deletedCount} old global chat messages.`,
      );
    }
  } catch (err) {
    console.error("Periodic chat cleanup error:", err);
  }
}, 3600000);

// ─── HEALTH CHECK ────────────────────────────────────────
app.get("/health", (req, res) => {
  const dbState = ["disconnected", "connected", "connecting", "disconnecting"];
  res.status(200).json({
    status: "ok",
    uptime: `${Math.floor(process.uptime())}s`,
    timestamp: new Date().toISOString(),
    mongodb: dbState[mongoose.connection.readyState] || "unknown",
    backup: {
      enabled: process.env.ENABLE_BACKUP !== "false",
      syncInterval: process.env.BACKUP_SYNC_INTERVAL || "300000ms",
    },
    ai: {
      provider: "OpenRouter",
      strategy: "Promise.any() race — fastest model wins",
      textModels: [
        "meta-llama/llama-3.3-70b-instruct:free",
        "mistralai/mistral-small-3.1-24b-instruct:free",
        "google/gemma-3-12b-it:free",
        "arcee-ai/trinity-large-preview:free",
      ],
      visionModel: "nvidia/nemotron-nano-12b-v2-vl:free",
    },
  });
});

// ─── TIMER STATE ROUTES ─────────────────────────────────
// GET current timer state
app.get("/api/timer", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const timer = await TimerState.findOne({ userId });
    if (!timer || timer.status === "stopped") {
      return res.status(200).json({ status: "stopped", accumulatedSeconds: 0 });
    }

    // If running, compute live elapsed so client can verify
    let liveElapsed = timer.accumulatedSeconds;
    if (timer.status === "running" && timer.startTime) {
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
      isPomodoroMode: timer.isPomodoroMode,
      pomodoroStage: timer.pomodoroStage,
    });
  } catch (error) {
    console.error("GET /api/timer error:", error);
    res.status(500).json({ error: error.message });
  }
});

// START or RESUME timer
app.post("/api/timer/start", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { topicId, topicTitle, subject, isPomodoroMode, pomodoroStage } =
      req.body;
    if (!topicId) return res.status(400).json({ error: "topicId required" });

    let timer = await TimerState.findOne({ userId });

    if (timer && timer.status === "running") {
      return res.status(200).json({
        status: "running",
        message: "Timer already running",
        startTime: timer.startTime,
      });
    }

    if (timer && timer.status === "paused") {
      timer.status = "running";
      timer.startTime = new Date();
      await timer.save();
    } else {
      timer = await TimerState.findOneAndUpdate(
        { userId },
        {
          status: "running",
          startTime: new Date(),
          accumulatedSeconds: 0,
          topicId: topicId || "",
          topicTitle: topicTitle || "",
          subject: subject || "",
          isPomodoroMode: isPomodoroMode || false,
          pomodoroStage: pomodoroStage || "work",
        },
        { upsert: true, new: true },
      );
    }

    res.status(200).json({
      status: timer.status,
      startTime: timer.startTime,
      accumulatedSeconds: timer.accumulatedSeconds,
      isPomodoroMode: timer.isPomodoroMode,
      pomodoroStage: timer.pomodoroStage,
    });
  } catch (error) {
    console.error("POST /api/timer/start error:", error);
    res.status(500).json({ error: error.message });
  }
});

// PAUSE timer
app.post("/api/timer/pause", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const timer = await TimerState.findOne({ userId });

    if (!timer || timer.status !== "running") {
      return res.status(200).json({
        status: timer?.status || "stopped",
        message: "Timer not running",
      });
    }

    const elapsedSinceStart =
      (Date.now() - new Date(timer.startTime).getTime()) / 1000;
    timer.accumulatedSeconds = Math.floor(
      timer.accumulatedSeconds + elapsedSinceStart,
    );
    timer.startTime = null;
    timer.status = "paused";
    await timer.save();

    res
      .status(200)
      .json({ status: "paused", accumulatedSeconds: timer.accumulatedSeconds });
  } catch (error) {
    console.error("POST /api/timer/pause error:", error);
    res.status(500).json({ error: error.message });
  }
});

// STOP timer — saves session and clears state
app.post("/api/timer/stop", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const timer = await TimerState.findOne({ userId });

    if (!timer || timer.status === "stopped") {
      return res.status(200).json({ status: "stopped", duration: 0 });
    }

    // Compute final duration
    let totalSeconds = timer.accumulatedSeconds;
    if (timer.status === "running" && timer.startTime) {
      totalSeconds += (Date.now() - new Date(timer.startTime).getTime()) / 1000;
    }
    totalSeconds = Math.floor(totalSeconds);

    // Save session to tracker if we have meaningful duration
    if (totalSeconds > 0 && timer.topicId) {
      await Tracker.findOneAndUpdate(
        { userId },
        {
          $push: {
            sessions: {
              duration: totalSeconds,
              topicId: timer.topicId,
              topicTitle: timer.topicTitle || "",
              subject: timer.subject || "",
              timestamp: new Date(),
            },
          },
        },
        { upsert: true, new: true },
      );

      // Also update topic timeSpent
      const tracker = await Tracker.findOne({ userId });
      if (tracker && tracker.topics) {
        const topicKey = timer.topicId;
        if (!tracker.topics[topicKey]) {
          tracker.topics[topicKey] = {
            status: "pending",
            notes: "",
            timeSpent: 0,
            title: timer.topicTitle || topicKey,
          };
        }
        // Ensure title is saved if it was missing but we have it now
        if (timer.topicTitle && !tracker.topics[topicKey].title) {
          tracker.topics[topicKey].title = timer.topicTitle;
        }
        tracker.topics[topicKey].timeSpent =
          (tracker.topics[topicKey].timeSpent || 0) + totalSeconds;
        tracker.markModified("topics");
        await tracker.save();
      }
    }

    // Clear timer state
    timer.status = "stopped";
    timer.startTime = null;
    timer.accumulatedSeconds = 0;
    timer.topicId = "";
    timer.topicTitle = "";
    timer.subject = "";
    await timer.save();

    res.status(200).json({
      status: "stopped",
      duration: totalSeconds,
      saved: totalSeconds > 0,
    });
  } catch (error) {
    console.error("POST /api/timer/stop error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─── IST Helper ──────────────────────────────────────────
function getISTDate(dateOb) {
  const istString = dateOb.toLocaleString("en-US", {
    timeZone: "Asia/Kolkata",
  });
  return new Date(istString);
}

function getISTBoundaries() {
  const nowIST = getISTDate(new Date());

  const startOfToday = new Date(
    nowIST.getFullYear(),
    nowIST.getMonth(),
    nowIST.getDate(),
  ).getTime();

  const startOfWeek = new Date(startOfToday);
  const dayOfWeek = startOfWeek.getDay();
  const diffToMonday =
    startOfWeek.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
  startOfWeek.setDate(diffToMonday);

  const startOfMonth = new Date(
    nowIST.getFullYear(),
    nowIST.getMonth(),
    1,
  ).getTime();

  return {
    nowIST,
    startOfToday,
    startOfWeek: startOfWeek.getTime(),
    startOfMonth,
  };
}

// ─── TRACKER ROUTES ──────────────────────────────────────
app.get("/api/tracker", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    let tracker = await Tracker.findOne({ userId });

    if (!tracker) {
      return res.status(200).json({
        topics: {},
        studyTimeSaved: 0,
        stats: { today: 0, weekly: 0, monthly: 0 },
      });
    }

    const { startOfToday, startOfWeek, startOfMonth } = getISTBoundaries();
    let today = 0,
      weekly = 0,
      monthly = 0;

    tracker.sessions.forEach((s) => {
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

app.post("/api/tracker", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { topics, studyTimeSaved, newSession } = req.body;
    const updateQuery = { topics, studyTimeSaved };

    if (newSession && newSession.duration > 0 && newSession.topicId) {
      updateQuery.$push = { sessions: newSession };
    }

    const tracker = await Tracker.findOneAndUpdate({ userId }, updateQuery, {
      new: true,
      upsert: true,
    });
    res
      .status(200)
      .json({ success: true, studyTimeSaved: tracker.studyTimeSaved });
  } catch (error) {
    console.error("POST /api/tracker error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─── SESSION ROUTE (dedicated) ───────────────────────────
app.post("/api/sessions", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { duration, topicId, topicTitle, subject, timestamp } = req.body;
    if (!duration || !topicId)
      return res.status(400).json({ error: "duration and topicId required" });

    const session = {
      duration,
      topicId,
      topicTitle: topicTitle || "",
      subject: subject || "",
      timestamp: timestamp || new Date(),
    };

    let tracker = await Tracker.findOne({ userId });
    if (!tracker) {
      tracker = new Tracker({ userId, topics: {}, sessions: [] });
    }

    tracker.sessions.push(session);

    if (topicId) {
      if (!tracker.topics) tracker.topics = {};
      if (!tracker.topics[topicId]) {
        // Since it's a manual entry, use topicId as title
        let parsedTitle = topicId;
        if (topicId.endsWith("-manual")) parsedTitle = subject + " (Manual)";
        tracker.topics[topicId] = {
          status: "pending",
          notes: "",
          timeSpent: 0,
          title: parsedTitle,
        };
      }
      tracker.topics[topicId].timeSpent =
        (tracker.topics[topicId].timeSpent || 0) + duration;
      tracker.markModified("topics");
    }

    await tracker.save();

    res
      .status(200)
      .json({ success: true, sessionCount: tracker.sessions.length });
  } catch (error) {
    console.error("POST /api/sessions error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─── DASHBOARD ANALYTICS ─────────────────────────────────
app.get("/api/dashboard", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const tracker = await Tracker.findOne({ userId });
    const { nowIST, startOfToday, startOfWeek, startOfMonth } =
      getISTBoundaries();

    if (!tracker || !tracker.sessions.length) {
      return res.status(200).json({
        today: 0,
        weekly: 0,
        monthly: 0,
        topics: {},
        subjectBreakdown: {},
        dailyGraph: {},
        weeklyBars: [0, 0, 0, 0, 0, 0, 0],
        streak: 0,
        mostProductiveDay: null,
        mostProductiveHour: null,
        monthComparison: { current: 0, previous: 0 },
        hourlyHeatmap: new Array(24).fill(0),
      });
    }

    const sessions = tracker.sessions;

    let today = 0,
      weekly = 0,
      monthly = 0;
    const subjectBreakdown = {};
    const daysInMonth = new Date(
      nowIST.getFullYear(),
      nowIST.getMonth() + 1,
      0,
    ).getDate();
    const dailyGraph = {};
    for (let i = 1; i <= daysInMonth; i++) dailyGraph[i] = 0;
    const weeklyBars = [0, 0, 0, 0, 0, 0, 0];
    const hourlyHeatmap = new Array(24).fill(0);
    const dayTotals = {};
    const prevMonthStart = new Date(
      nowIST.getFullYear(),
      nowIST.getMonth() - 1,
      1,
    ).getTime();
    let prevMonthTotal = 0;

    sessions.forEach((s) => {
      const sIST = getISTDate(new Date(s.timestamp));
      const sTime = sIST.getTime();
      const dur = s.duration || 0;
      const subj = s.subject || s.topicId.split("-")[0] || "Other";

      if (sTime >= startOfToday) today += dur;
      if (sTime >= startOfWeek) {
        weekly += dur;
        const dow = sIST.getDay();
        weeklyBars[dow === 0 ? 6 : dow - 1] += dur;
      }
      if (sTime >= startOfMonth) {
        monthly += dur;
        dailyGraph[sIST.getDate()] = (dailyGraph[sIST.getDate()] || 0) + dur;
      }

      if (sTime >= prevMonthStart && sTime < startOfMonth) {
        prevMonthTotal += dur;
      }

      subjectBreakdown[subj] = (subjectBreakdown[subj] || 0) + dur;
      hourlyHeatmap[sIST.getHours()] += dur;

      const dayKey = `${sIST.getFullYear()}-${String(sIST.getMonth() + 1).padStart(2, "0")}-${String(sIST.getDate()).padStart(2, "0")}`;
      dayTotals[dayKey] = (dayTotals[dayKey] || 0) + dur;
    });

    // Streak calculation
    let streak = 0;
    const todayKey = `${nowIST.getFullYear()}-${String(nowIST.getMonth() + 1).padStart(2, "0")}-${String(nowIST.getDate()).padStart(2, "0")}`;
    let checkDate = new Date(
      nowIST.getFullYear(),
      nowIST.getMonth(),
      nowIST.getDate(),
    );

    if (!dayTotals[todayKey] || dayTotals[todayKey] < 1) {
      checkDate.setDate(checkDate.getDate() - 1);
    }

    for (let i = 0; i < 365; i++) {
      const key = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, "0")}-${String(checkDate.getDate()).padStart(2, "0")}`;
      if (dayTotals[key] && dayTotals[key] >= 30) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }

    // Most productive day
    let mostProductiveDay = null;
    let maxDaySeconds = 0;
    for (const [day, secs] of Object.entries(dayTotals)) {
      if (secs > maxDaySeconds) {
        maxDaySeconds = secs;
        mostProductiveDay = day;
      }
    }

    // Most productive hour
    let mostProductiveHour = 0;
    let maxHourSeconds = 0;
    hourlyHeatmap.forEach((secs, hour) => {
      if (secs > maxHourSeconds) {
        maxHourSeconds = secs;
        mostProductiveHour = hour;
      }
    });

    res.status(200).json({
      today,
      weekly,
      monthly,
      topics: tracker.topics || {},
      subjectBreakdown,
      dailyGraph,
      weeklyBars,
      streak,
      mostProductiveDay,
      mostProductiveDaySeconds: maxDaySeconds,
      mostProductiveHour,
      monthComparison: { current: monthly, previous: prevMonthTotal },
      hourlyHeatmap,
    });
  } catch (error) {
    console.error("GET /api/dashboard error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─── TASKS CRUD ──────────────────────────────────────────
app.get("/api/tasks", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const tasks = await Task.find({ userId }).sort({ createdAt: -1 });
    res.status(200).json(tasks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/tasks", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { title, subject, dueDate, isRepeating, repeatInterval } = req.body;
    if (!title) return res.status(400).json({ error: "title required" });

    const task = new Task({
      userId,
      title,
      subject,
      dueDate,
      isRepeating,
      repeatInterval,
    });
    await task.save();
    res.status(201).json(task);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/tasks/:id", authMiddleware, async (req, res) => {
  try {
    const updates = req.body;
    if (updates.completed) updates.completedAt = new Date();

    const task = await Task.findByIdAndUpdate(req.params.id, updates, {
      new: true,
    });
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.status(200).json(task);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/tasks/:id", authMiddleware, async (req, res) => {
  try {
    await Task.findByIdAndDelete(req.params.id);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GOALS CRUD ──────────────────────────────────────────
app.get("/api/goals", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const goals = await Goal.find({ userId }).sort({ month: -1 });
    res.status(200).json(goals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/goals", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { title, targetHours, month } = req.body;
    if (!title || !targetHours || !month)
      return res
        .status(400)
        .json({ error: "title, targetHours, month required" });

    const goal = new Goal({ userId, title, targetHours, month });
    await goal.save();
    res.status(201).json(goal);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/goals/:id", authMiddleware, async (req, res) => {
  try {
    const goal = await Goal.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!goal) return res.status(404).json({ error: "Goal not found" });
    res.status(200).json(goal);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/goals/:id", authMiddleware, async (req, res) => {
  try {
    await Goal.findByIdAndDelete(req.params.id);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── CATCH-ALL: serve client HTML for SPA-like routing ──
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "client", "index.html"));
});

// ─── BACKUP RECOVERY ENDPOINT ───────────────────────────
app.post("/api/backup/recover", authMiddleware, async (req, res) => {
  try {
    // Verify user is admin or has recovery permission
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Unauthorized: Admin only" });
    }

    if (!recoverFromBackup) {
      return res.status(400).json({ error: "Backup system not initialized" });
    }

    const recovered = await recoverFromBackup();
    if (recovered) {
      res.json({
        success: true,
        message: "Data recovered from backup successfully",
      });
    } else {
      res.status(500).json({ error: "Failed to recover from backup" });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── START SERVER ────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  // Initialize backup sync after server starts (lazy load all dependencies)
  setTimeout(() => {
    try {
      const backupModule = require("./utils/backupSync");
      startBackupSync = backupModule.startBackupSync;
      recoverFromBackup = backupModule.recoverFromBackup;

      if (startBackupSync) {
        startBackupSync();
      }
    } catch (error) {
      console.warn("⚠️ Backup sync failed to initialize:", error.message);
    }
  }, 2000);
});
