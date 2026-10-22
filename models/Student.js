const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: [true, 'Full name is required.'],
      trim: true
    },
    email: {
      type: String,
      required: [true, 'Email is required.'],
      trim: true,
      lowercase: true,
      unique: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid email address.']
    },
    department: {
      type: String,
      required: [true, 'Department is required.'],
      trim: true
    },
    contactNumber: {
      type: String,
      required: [true, 'Contact number is required.'],
      trim: true
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Student', studentSchema);
