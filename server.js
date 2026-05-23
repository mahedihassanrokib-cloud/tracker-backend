require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

// Define MongoDB Schema directly in server.js to avoid folder upload issues
const statusSchema = new mongoose.Schema({
  identifier: { type: String, required: true, unique: true, index: true },
  history: { type: [String], default: [] },
  lastStatus: { type: String, index: true },
  updatedAt: { type: Date, default: Date.now }
});

// Avoid OverwriteModelError in serverless environments by checking if model exists
const Status = mongoose.models.Status || mongoose.model('Status', statusSchema);


const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' })); // Support large JSON payloads during import

// Connect to MongoDB (Serverless check)
if (mongoose.connection.readyState === 0) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch((err) => console.error('MongoDB connection error:', err));
}

// 1. Bulk Update Status (Used during deep sync and live monitor)
app.post('/api/status/bulk-update', async (req, res) => {
  try {
    const updates = req.body; // Array of { identifier, status }
    if (!Array.isArray(updates)) return res.status(400).json({ error: 'Body must be an array' });

    const bulkOps = [];
    
    for (const item of updates) {
      if (!item.identifier || !item.status) continue;
      
      const cleanStatus = item.status.split('\n')[0].trim();
      
      // We want to push to history ONLY if the last status is different.
      // However, MongoDB doesn't easily let us push conditionally based on the last element in bulk operations natively without aggregation pipelines in updates.
      // So we will just push it and rely on the frontend to only send updates when a change occurs,
      // or we can fetch first. For bulk scraping, let's just do a findOneAndUpdate if not exist.
      // Actually, to make it fast, we can use an update pipeline (MongoDB 4.2+).
      
      bulkOps.push({
        updateOne: {
          filter: { identifier: item.identifier },
          update: [
            {
              $set: {
                // If history is missing, initialize it
                history: { $cond: [{ $not: ["$history"] }, [], "$history"] },
                lastStatus: { $cond: [{ $not: ["$lastStatus"] }, "", "$lastStatus"] }
              }
            },
            {
              $set: {
                // Only push to history if lastStatus != cleanStatus
                history: {
                  $cond: [
                    { $ne: [{ $arrayElemAt: ["$history", -1] }, cleanStatus] },
                    { $concatArrays: ["$history", [cleanStatus]] },
                    "$history"
                  ]
                },
                lastStatus: cleanStatus,
                updatedAt: new Date()
              }
            }
          ],
          upsert: true
        }
      });
    }

    if (bulkOps.length > 0) {
      await Status.bulkWrite(bulkOps);
    }
    
    res.json({ success: true, count: bulkOps.length });
  } catch (error) {
    console.error('Bulk update error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. Get Stats Dashboard
app.get('/api/status/stats', async (req, res) => {
  try {
    // Aggregate counts by lastStatus
    const stats = await Status.aggregate([
      {
        $group: {
          _id: { $toLower: "$lastStatus" },
          count: { $sum: 1 }
        }
      }
    ]);

    let results = {
      editRequired: 0,
      notSubmit: 0,
      inReview: 0,
      incomplete: 0,
      notCreated: 0,
      approved: 0,
      notApproved: 0,
      hidden: 0
    };

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
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. Get history for specific identifiers
app.post('/api/status/history', async (req, res) => {
  try {
    const { identifiers } = req.body;
    if (!Array.isArray(identifiers)) return res.status(400).json({ error: 'Identifiers must be an array' });

    const records = await Status.find({ identifier: { $in: identifiers } });
    
    // Convert to map
    const map = {};
    records.forEach(r => {
      map[r.identifier] = { history: r.history };
    });

    res.json(map);
  } catch (error) {
    console.error('History fetch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 4. Import Backup Data (JSON uploaded from extension)
app.post('/api/status/import', async (req, res) => {
  try {
    const data = req.body; // Expecting the format: { "OD_BIO_123": { history: [...] }, ... }
    const bulkOps = [];

    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('OD_') || key.startsWith('HB_')) {
        const history = value.history || [];
        const lastStatus = history.length > 0 ? history[history.length - 1] : "";
        
        bulkOps.push({
          updateOne: {
            filter: { identifier: key },
            update: { 
              $set: { 
                identifier: key,
                history: history,
                lastStatus: lastStatus,
                updatedAt: new Date()
              }
            },
            upsert: true
          }
        });
      }
    }

    if (bulkOps.length > 0) {
      await Status.bulkWrite(bulkOps);
    }
    
    res.json({ success: true, message: `Imported ${bulkOps.length} records.` });
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 5. Export All Data
app.get('/api/status/export', async (req, res) => {
  try {
    const allRecords = await Status.find({}, { identifier: 1, history: 1, _id: 0 });
    const exportData = {};
    allRecords.forEach(r => {
      exportData[r.identifier] = { history: r.history };
    });
    res.json(exportData);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// For local development
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Status Tracker backend running on http://localhost:${PORT}`);
  });
}

// Export for Vercel Serverless
module.exports = app;
