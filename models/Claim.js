const mongoose = require('mongoose');

const claimSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      required: [true, 'A claiming student is required.']
    },
    foundItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FoundItem',
      required: [true, 'A found item is required.']
    },
    description: {
      type: String,
      required: [true, 'Claim proof is required.'],
      trim: true,
      minlength: [10, 'Please provide at least 10 characters of claim proof.'],
      maxlength: [2000, 'Claim proof cannot exceed 2000 characters.']
    },
    status: {
      type: String,
      enum: ['Pending', 'Approved', 'Rejected'],
      default: 'Pending'
    }
  },
  { timestamps: true }
);

claimSchema.index(
  { student: 1, foundItem: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'Pending' }
  }
);

module.exports = mongoose.model('Claim', claimSchema);
