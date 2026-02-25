require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/winecellar';
  await mongoose.connect(uri);
  console.log('Connected to', uri);
  const users = mongoose.connection.db.collection('users');

  const user = await users.findOne({ username: /jagduvi/i });
  if (!user) {
    console.log('User not found');
    process.exit(1);
  }

  console.log('Found:', user.username, '| current roles:', user.roles || user.role);

  await users.updateOne(
    { _id: user._id },
    { $set: { roles: ['user', 'admin'] }, $unset: { role: '' } }
  );

  const updated = await users.findOne({ _id: user._id });
  console.log('Done. New roles:', updated.roles);
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
