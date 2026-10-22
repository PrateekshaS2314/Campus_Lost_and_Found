const mongoose = require('mongoose');

const lostItemSchema = new mongoose.Schema(
  {
    itemName: { type: String, required: [true, 'Item name is required.'], trim: true },
    category: { type: String, required: [true, 'Category is required.'], trim: true },
    description: { type: String, required: [true, 'Description is required.'], trim: true },
    lastSeenLocation: {
      type: String,
      required: [true, 'Last seen location is required.'],
      trim: true
    },
    dateLost: { type: Date, required: [true, 'Date lost is required.'] },
    status: { type: String, enum: ['Open', 'Resolved'], default: 'Open' },
    reportedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      required: [true, 'A reporting student is required.']
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('LostItem', lostItemSchema);
