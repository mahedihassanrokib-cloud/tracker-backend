const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const statusSchema = new mongoose.Schema({
  identifier: { type: String, required: true, unique: true, index: true },
  history: { type: [String], default: [] },
  lastStatus: { type: String, index: true },
  updatedAt: { type: Date, default: Date.now }
});

const Status = mongoose.models.Status || mongoose.model('Status', statusSchema);

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Helper function to connect to DB before each request in serverless
async function connectDB() {
  if (mongoose.connection.readyState >= 1) return;
  
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is undefined. Please check Vercel Environment Variables.");
    
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    console.log('Connected to MongoDB');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    throw error;
  }
}

// Test Route
app.get('/api/test', (req, res) => {
  res.json({ status: 'Server is running perfectly!' });
});

app.post('/api/status/bulk-update', async (req, res) => {
  try {
    await connectDB();
    const updates = req.body;
    if (!Array.isArray(updates)) return res.status(400).json({ error: 'Body must be an array' });

    const bulkOps = [];
    for (const item of updates) {
      if (!item.identifier || !item.status) continue;
      const cleanStatus = item.status.split('\n')[0].trim();
      
      bulkOps.push({
        updateOne: {
          filter: { identifier: item.identifier },
          update: [
            { $set: { history: { $cond: [{ $not: ["$history"] }, [], "$history"] }, lastStatus: { $cond: [{ $not: ["$lastStatus"] }, "", "$lastStatus"] } } },
            { $set: { history: { $cond: [{ $ne: [{ $arrayElemAt: ["$history", -1] }, cleanStatus] }, { $concatArrays: ["$history", [cleanStatus]] }, "$history"] }, lastStatus: cleanStatus, updatedAt: new Date() } }
          ],
          upsert: true
        }
      });
    }
    if (bulkOps.length > 0) await Status.bulkWrite(bulkOps);
    res.json({ success: true, count: bulkOps.length });
  } catch (error) {
    console.error('Bulk update error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

app.get('/api/status/stats', async (req, res) => {
  try {
    await connectDB();
    const stats = await Status.aggregate([{ $group: { _id: { $toLower: "$lastStatus" }, count: { $sum: 1 } } }]);
    let results = { editRequired: 0, notSubmit: 0, inReview: 0, incomplete: 0, notCreated: 0, approved: 0, notApproved: 0, hidden: 0 };
    stats.forEach(s => {
      if (!s._id) return;
      if (s._id.includes('edit required')) results.editRequired += s.count;
      if (s._id.includes('not submit')) results.notSubmit += s.count;
      if (s._id.includes('in review')) results.inReview += s.count;
      if (s._id.includes('incomplete')) results.incomplete += s.count;
      if (s._id.includes('hidden')) results.hidden += s.count;
      if (s._id.includes('not created')) results.notCreated += s.count;
      if (s._id.includes('not approved')) results.notApproved += s.count;
      else if (s._id.includes('approved')) results.approved += s.count;
    });
    res.json(results);
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

app.post('/api/status/history', async (req, res) => {
  try {
    await connectDB();
    const { identifiers } = req.body;
    if (!Array.isArray(identifiers)) return res.status(400).json({ error: 'Identifiers must be an array' });
    const records = await Status.find({ identifier: { $in: identifiers } });
    const map = {};
    records.forEach(r => map[r.identifier] = { history: r.history });
    res.json(map);
  } catch (error) {
    console.error('History fetch error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

app.post('/api/status/import', async (req, res) => {
  try {
    await connectDB();
    const data = req.body;
    const bulkOps = [];
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('OD_') || key.startsWith('HB_')) {
        const history = value.history || [];
        const lastStatus = history.length > 0 ? history[history.length - 1] : "";
        bulkOps.push({ updateOne: { filter: { identifier: key }, update: { $set: { identifier: key, history: history, lastStatus: lastStatus, updatedAt: new Date() } }, upsert: true } });
      }
    }
    if (bulkOps.length > 0) await Status.bulkWrite(bulkOps);
    res.json({ success: true, message: `Imported ${bulkOps.length} records.` });
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

app.get('/api/status/export', async (req, res) => {
  try {
    await connectDB();
    const allRecords = await Status.find({}, { identifier: 1, history: 1, _id: 0 });
    const exportData = {};
    allRecords.forEach(r => exportData[r.identifier] = { history: r.history });
    res.json(exportData);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(3000, () => console.log(`Backend running on http://localhost:3000`));
}
module.exports = app;
