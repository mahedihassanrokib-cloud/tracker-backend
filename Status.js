const mongoose = require('mongoose');

const statusSchema = new mongoose.Schema({
  identifier: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  history: {
    type: [String],
    default: []
  },
  lastStatus: {
    type: String,
    index: true // Useful for counting stats efficiently
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Status', statusSchema);
