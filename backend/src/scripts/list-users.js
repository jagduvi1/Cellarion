require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/wine_cellar');
  const users = mongoose.connection.db.collection('users');
  const all = await users.find({}, { projection: { username: 1, email: 1, roles: 1, role: 1 } }).toArray();
  console.log('Users in DB:', JSON.stringify(all, null, 2));
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
