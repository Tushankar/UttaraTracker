const mongoose = require("mongoose");
require("dotenv").config();

const User = require("./models/User");
const ExamAttempt = require("./models/ExamAttempt");

async function fixExamCounts() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("Connected to MongoDB");

    // Find all completed exams
    const exams = await ExamAttempt.find({ completed: true });
    console.log(`Found ${exams.length} completed exams`);

    // Group exams by userId
    const examsByUser = {};
    exams.forEach((exam) => {
      const userId = exam.userId.toString();
      examsByUser[userId] = (examsByUser[userId] || 0) + 1;
    });

    console.log("Exams by user:", examsByUser);

    // Update each user's examCount
    for (const [userId, count] of Object.entries(examsByUser)) {
      await User.findByIdAndUpdate(userId, { examCount: count }, { new: true });
      console.log(`Updated user ${userId} with examCount: ${count}`);
    }

    // Also ensure all other users have examCount = 0
    const allUsers = await User.find({ examCount: { $exists: false } });
    for (const user of allUsers) {
      await User.findByIdAndUpdate(user._id, { examCount: 0 }, { new: true });
      console.log(`Set examCount: 0 for user ${user._id}`);
    }

    console.log("✅ Exam counts fixed!");
    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

fixExamCounts();
