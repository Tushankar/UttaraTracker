const mongoose = require('mongoose');
require('dotenv').config();

const User = require('./models/User');
const Tracker = require('./models/Tracker');
const Task = require('./models/Task');
const { recalculateUserPoints } = require('./routes/leaderboard');

const uri = process.env.MONGODB_URI || 'mongodb+srv://Tirthoraj:Tirthoraj@cluster0.nd9yv8x.mongodb.net/StudyTracker?retryWrites=true&w=majority';

mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    try {
      const users = await User.find({ displayName: /saha/i });
      if (users.length === 0) {
         console.log('User not found.');
         process.exit(0);
      }
      
      const userId = users[0]._id.toString();
      console.log(`Testing with user: ${users[0].displayName} (${userId})`);
      console.log('Initial Points:', users[0].focusPoints);

      console.log('--- Triggering recalculateUserPoints manually ---');
      const result = await recalculateUserPoints(userId);
      console.log('Result from recalculateUserPoints:', result);

      const updatedUser = await User.findById(userId);
      console.log('Final DB Points:', updatedUser.focusPoints);

    } catch (e) {
      console.error(e);
    } finally {
      process.exit(0);
    }
  });
