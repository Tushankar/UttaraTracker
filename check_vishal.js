const mongoose = require('mongoose');
const User = require('./models/User');
const Tracker = require('./models/Tracker');

const uri = 'mongodb+srv://Tirthoraj:Tirthoraj@cluster0.nd9yv8x.mongodb.net/StudyTracker?retryWrites=true&w=majority';

mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    try {
      const users = await User.find({ displayName: /saha/i });
      console.log('Users found:', users.length);
      
      const trackers = await Tracker.find({ userId: { $in: users.map(u => u._id.toString()) } });

      for (const user of users) {
        const tracker = trackers.find(t => t.userId === user._id.toString());
        const totalSeconds = (tracker?.sessions || []).reduce((acc, s) => acc + s.duration, 0);
        console.log("User:", user.displayName, "ID:", user._id);
        console.log("Focus Points:", user.focusPoints);
        console.log("Total Seconds:", totalSeconds);
        console.log("Study Hours:", totalSeconds / 3600);
        console.log("Sessions Count:", tracker?.sessions?.length || 0);
        console.log("Tracker Sessions:", JSON.stringify(tracker?.sessions));
      }

    } catch (e) {
      console.error(e);
    } finally {
      process.exit(0);
    }
  });
