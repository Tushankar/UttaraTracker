// ═══════════════════════════════════════════════════════════
// BACKUP SYNC — Auto-replication to backup MongoDB
// ═══════════════════════════════════════════════════════════

const mongoose = require("mongoose");
const User = require("../models/User");
const Tracker = require("../models/Tracker");
const Task = require("../models/Task");
const Goal = require("../models/Goal");
const Chat = require("../models/Chat");
const GlobalMessage = require("../models/GlobalMessage");
const WeeklyChampion = require("../models/WeeklyChampion");

let backupConnection = null;
let backupModels = {};
let syncInProgress = false;

// Initialize backup database connection
async function initBackupConnection() {
  if (backupConnection && backupConnection.readyState === 1) {
    return backupConnection;
  }

  try {
    const backupURI = process.env.MONGODB_BACKUP_URI;
    if (!backupURI) {
      console.warn(
        "⚠️ MONGODB_BACKUP_URI not configured. Backup sync disabled.",
      );
      return null;
    }

    backupConnection = await mongoose.createConnection(backupURI);

    console.log("✅ Backup MongoDB connected");

    // Create backup models with same schemas
    setupBackupModels(backupConnection);
    return backupConnection;
  } catch (error) {
    console.error("❌ Failed to connect to backup MongoDB:", error.message);
    return null;
  }
}

// Setup backup models using the backup connection
function setupBackupModels(connection) {
  backupModels = {
    User: connection.model("User", new mongoose.Schema(User.schema.obj)),
    Tracker: connection.model(
      "Tracker",
      new mongoose.Schema(Tracker.schema.obj),
    ),
    Task: connection.model("Task", new mongoose.Schema(Task.schema.obj)),
    Goal: connection.model("Goal", new mongoose.Schema(Goal.schema.obj)),
    Chat: connection.model("Chat", new mongoose.Schema(Chat.schema.obj)),
    GlobalMessage: connection.model(
      "GlobalMessage",
      new mongoose.Schema(GlobalMessage.schema.obj),
    ),
    WeeklyChampion: connection.model(
      "WeeklyChampion",
      new mongoose.Schema(WeeklyChampion.schema.obj),
    ),
  };
}

// Sync a single collection (handles upsert)
async function syncCollection(modelName, primaryModel, backupModel) {
  if (!backupModel) return;

  try {
    const documents = await primaryModel.find({}).lean();

    if (documents.length === 0) {
      console.log(`✅ Synced 0 ${modelName} documents to backup`);
      return;
    }

    for (const doc of documents) {
      try {
        if (doc._id) {
          // Upsert: Update if exists, insert if not
          await backupModel.updateOne(
            { _id: doc._id },
            { $set: doc },
            { upsert: true },
          );
        }
      } catch (itemError) {
        // Handle unique index duplicate key error (like email for Users)
        if (itemError.code === 11000 && modelName === "User" && doc.email) {
          try {
            // Remove the conflicting older document holding the same email
            await backupModel.deleteOne({ email: doc.email });
            // Retry the upsert
            await backupModel.updateOne(
              { _id: doc._id },
              { $set: doc },
              { upsert: true },
            );
            continue; // Successfully resolved
          } catch (retryError) {
            console.error(
              `⚠️ Retry failed for User ${doc._id}:`,
              retryError.message,
            );
          }
        }

        console.error(
          `⚠️ Sync error for ${modelName} ${doc._id}:`,
          itemError.message,
        );
      }
    }

    console.log(
      `✅ Synced ${documents.length} ${modelName} documents to backup`,
    );
  } catch (error) {
    console.error(`❌ Sync failed for ${modelName}:`, error.message);
  }
}

// Full sync from primary to backup
async function syncAllData() {
  if (syncInProgress) {
    console.log("⏳ Sync already in progress...");
    return;
  }

  syncInProgress = true;

  try {
    const backup = await initBackupConnection();
    if (!backup || !backupModels.User) {
      console.warn("⚠️ Backup not available. Skipping sync.");
      syncInProgress = false;
      return;
    }

    console.log("🔄 Starting backup sync...");
    const startTime = Date.now();

    // Sync all collections
    await syncCollection("User", User, backupModels.User);
    await syncCollection("Tracker", Tracker, backupModels.Tracker);
    await syncCollection("Task", Task, backupModels.Task);
    await syncCollection("Goal", Goal, backupModels.Goal);
    await syncCollection("Chat", Chat, backupModels.Chat);
    await syncCollection(
      "GlobalMessage",
      GlobalMessage,
      backupModels.GlobalMessage,
    );
    await syncCollection(
      "WeeklyChampion",
      WeeklyChampion,
      backupModels.WeeklyChampion,
    );

    const duration = Date.now() - startTime;
    console.log(`✅ Backup sync completed in ${duration}ms`);
  } catch (error) {
    console.error("❌ Backup sync failed:", error.message);
  } finally {
    syncInProgress = false;
  }
}

// Recover from backup if primary is down
async function recoverFromBackup() {
  try {
    const backup = await initBackupConnection();
    if (!backup || !backupModels.User) {
      console.warn("⚠️ Backup unavailable for recovery.");
      return false;
    }

    console.log("🔄 Attempting recovery from backup...");

    // Get all backup data
    const backupUsers = await backupModels.User.find({}).lean();
    const backupTrackers = await backupModels.Tracker.find({}).lean();
    const backupTasks = await backupModels.Task.find({}).lean();
    const backupGoals = await backupModels.Goal.find({}).lean();
    const backupChats = await backupModels.Chat.find({}).lean();
    const backupMessages = await backupModels.GlobalMessage.find({}).lean();
    const backupChampions = await backupModels.WeeklyChampion.find({}).lean();

    // Write back to primary
    if (backupUsers.length > 0) {
      await User.insertMany(backupUsers, { ordered: false }).catch(() => {
        // Ignore duplicates, just update
        backupUsers.forEach(async (u) => {
          await User.updateOne({ _id: u._id }, { $set: u }, { upsert: true });
        });
      });
    }
    if (backupTrackers.length > 0) {
      await Tracker.insertMany(backupTrackers, { ordered: false }).catch(() => {
        backupTrackers.forEach(async (t) => {
          await Tracker.updateOne(
            { _id: t._id },
            { $set: t },
            { upsert: true },
          );
        });
      });
    }
    if (backupTasks.length > 0) {
      await Task.insertMany(backupTasks, { ordered: false }).catch(() => {
        backupTasks.forEach(async (t) => {
          await Task.updateOne({ _id: t._id }, { $set: t }, { upsert: true });
        });
      });
    }
    if (backupGoals.length > 0) {
      await Goal.insertMany(backupGoals, { ordered: false }).catch(() => {
        backupGoals.forEach(async (g) => {
          await Goal.updateOne({ _id: g._id }, { $set: g }, { upsert: true });
        });
      });
    }
    if (backupChats.length > 0) {
      await Chat.insertMany(backupChats, { ordered: false }).catch(() => {
        backupChats.forEach(async (c) => {
          await Chat.updateOne({ _id: c._id }, { $set: c }, { upsert: true });
        });
      });
    }
    if (backupMessages.length > 0) {
      await GlobalMessage.insertMany(backupMessages, { ordered: false }).catch(
        () => {
          backupMessages.forEach(async (m) => {
            await GlobalMessage.updateOne(
              { _id: m._id },
              { $set: m },
              { upsert: true },
            );
          });
        },
      );
    }
    if (backupChampions.length > 0) {
      await WeeklyChampion.insertMany(backupChampions, {
        ordered: false,
      }).catch(() => {
        backupChampions.forEach(async (w) => {
          await WeeklyChampion.updateOne(
            { _id: w._id },
            { $set: w },
            { upsert: true },
          );
        });
      });
    }

    console.log(
      `✅ Recovery completed: ${backupUsers.length} users, ${backupTrackers.length} trackers, ${backupTasks.length} tasks, ${backupMessages.length} global messages restored`,
    );
    return true;
  } catch (error) {
    console.error("❌ Recovery from backup failed:", error.message);
    return false;
  }
}

// Start periodic backup sync
function startBackupSync() {
  if (!process.env.ENABLE_BACKUP || process.env.ENABLE_BACKUP === "false") {
    console.log("ℹ️ Backup sync disabled");
    return;
  }

  const syncInterval = parseInt(process.env.BACKUP_SYNC_INTERVAL) || 300000; // 5 min default

  // Initial sync after 10 seconds
  setTimeout(() => syncAllData(), 10000);

  // Periodic sync
  setInterval(() => syncAllData(), syncInterval);

  console.log(`📅 Backup sync scheduled every ${syncInterval / 1000}s`);
}

module.exports = {
  initBackupConnection,
  syncAllData,
  recoverFromBackup,
  startBackupSync,
};
