const mongoose = require('mongoose');
const { SUPPORT_CATEGORIES } = require('../config/constants');

// One follow-up message in a ticket's conversation. `author` disambiguates the
// side (the user's AI/web reply vs an admin response); `by` records the actual
// account for admin attribution. No _id — replies are only ever read as a list.
const ticketReplySchema = new mongoose.Schema({
  author: { type: String, enum: ['user', 'admin'], required: true },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  message: { type: String, required: true, trim: true, maxlength: 5000 },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const supportTicketSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  category: {
    type: String,
    enum: SUPPORT_CATEGORIES,
    required: true,
    index: true
  },
  subject: {
    type: String,
    required: [true, 'Subject is required'],
    trim: true,
    maxlength: 200
  },
  message: {
    type: String,
    required: [true, 'Message is required'],
    trim: true,
    maxlength: 5000
  },
  status: {
    type: String,
    enum: ['open', 'in_progress', 'closed'],
    default: 'open',
    index: true
  },
  adminResponse: {
    type: String,
    trim: true,
    maxlength: 5000
  },
  // The conversation AFTER the opening message. Admin responses are appended
  // here AND mirrored into adminResponse (latest) for pre-thread consumers;
  // user follow-ups (web reply box or the MCP reply_to_ticket tool) live only
  // here and flip status back to 'open'. Tickets created before threading
  // have an empty array and just the message/adminResponse pair.
  replies: {
    type: [ticketReplySchema],
    default: []
  },
  respondedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  respondedAt: {
    type: Date
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

supportTicketSchema.index({ status: 1, createdAt: -1 });

supportTicketSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
