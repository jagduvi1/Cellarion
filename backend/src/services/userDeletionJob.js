/**
 * User deletion job — runs daily via the scheduler.
 *
 * Finds users whose 7-day cooling-off period has expired and permanently
 * deletes their accounts along with all user-linked data across every model.
 */
const User = require('../models/User');
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const Cellar = require('../models/Cellar');
const CellarLayout = require('../models/CellarLayout');
const CellarValueSnapshot = require('../models/CellarValueSnapshot');
const ChatUsage = require('../models/ChatUsage');
const Discussion = require('../models/Discussion');
const DiscussionReply = require('../models/DiscussionReply');
const DiscussionReplyVote = require('../models/DiscussionReplyVote');
const DiscussionReport = require('../models/DiscussionReport');
const Follow = require('../models/Follow');
const ImportSession = require('../models/ImportSession');
const JournalEntry = require('../models/JournalEntry');
const Notification = require('../models/Notification');
const PendingShare = require('../models/PendingShare');
const PriceTrackingSkip = require('../models/PriceTrackingSkip');
const PushSubscription = require('../models/PushSubscription');
const Rack = require('../models/Rack');
const Recommendation = require('../models/Recommendation');
const RestockAlert = require('../models/RestockAlert');
const Review = require('../models/Review');
const ReviewVote = require('../models/ReviewVote');
const SupportTicket = require('../models/SupportTicket');
const WineList = require('../models/WineList');
const WineReport = require('../models/WineReport');
const WineRequest = require('../models/WineRequest');
const WineVintagePrice = require('../models/WineVintagePrice');
const WineVintageProfile = require('../models/WineVintageProfile');
const WishlistItem = require('../models/WishlistItem');
const AuditLog = require('../models/AuditLog');
const BlogPost = require('../models/BlogPost');

/**
 * Delete all data linked to a single user.
 * Called after the 7-day cooling-off period has expired.
 */
async function purgeUserData(userId, userEmail) {
  // Get cellar IDs for cascade cleanup
  const cellarIds = await Cellar.distinct('_id', { user: userId });

  await Promise.all([
    // Core wine data
    Bottle.deleteMany({ user: userId }),
    BottleImage.deleteMany({ uploadedBy: userId }),
    Cellar.deleteMany({ user: userId }),
    Rack.deleteMany({ cellar: { $in: cellarIds } }),
    CellarLayout.deleteMany({ cellar: { $in: cellarIds } }),
    WineList.deleteMany({ user: userId }),
    WishlistItem.deleteMany({ user: userId }),

    // Social & engagement
    Discussion.deleteMany({ author: userId }),
    DiscussionReply.deleteMany({ author: userId }),
    DiscussionReplyVote.deleteMany({ user: userId }),
    ReviewVote.deleteMany({ user: userId }),
    Review.deleteMany({ author: userId }),
    Follow.deleteMany({ $or: [{ follower: userId }, { following: userId }] }),
    Recommendation.deleteMany({ $or: [{ sender: userId }, { recipient: userId }] }),

    // Journal & alerts
    JournalEntry.deleteMany({ user: userId }),
    RestockAlert.deleteMany({ user: userId }),
    Notification.deleteMany({ user: userId }),

    // Requests & reports
    WineRequest.deleteMany({ user: userId }),
    WineReport.deleteMany({ user: userId }),
    DiscussionReport.deleteMany({ user: userId }),
    SupportTicket.deleteMany({ user: userId }),

    // Import & usage
    ImportSession.deleteMany({ user: userId }),
    ChatUsage.deleteMany({ userId: userId }),
    PushSubscription.deleteMany({ user: userId }),
    CellarValueSnapshot.deleteMany({ user: userId }),
    PriceTrackingSkip.deleteMany({ skippedBy: userId }),

    // Invites (sent and received by email)
    PendingShare.deleteMany({ $or: [{ invitedBy: userId }, { email: userEmail }] }),

    // Remove user from shared cellars
    Cellar.updateMany(
      { 'members.user': userId },
      { $pull: { members: { user: userId } } }
    ),

    // Clear user references on somm-contributed data (preserve the data itself)
    WineVintagePrice.updateMany({ setBy: userId }, { $unset: { setBy: '', sommNotes: '' } }),
    WineVintageProfile.updateMany({ setBy: userId }, { $unset: { setBy: '', setAt: '' } }),

    // Reassign blog posts to null author (preserve published content)
    BlogPost.updateMany({ author: userId }, { $unset: { author: '' } }),

    // Audit log — keep for compliance but anonymise actor
    AuditLog.updateMany(
      { 'actor.userId': userId },
      { $set: { 'actor.userId': null, 'actor.ip': null } }
    ),
  ]);
}

async function runUserDeletionJob() {
  const now = new Date();

  const usersToDelete = await User.find({
    deletionScheduledFor: { $lte: now, $ne: null }
  }).select('_id email').lean();

  if (usersToDelete.length === 0) return;

  console.log(`[user-deletion] Processing ${usersToDelete.length} scheduled deletion(s)…`);

  for (const user of usersToDelete) {
    try {
      await purgeUserData(user._id, user.email);
      await User.deleteOne({ _id: user._id });
      console.log(`[user-deletion] Deleted user ${user._id}`);
    } catch (err) {
      console.error(`[user-deletion] Failed to delete user ${user._id}:`, err);
    }
  }

  console.log(`[user-deletion] Completed ${usersToDelete.length} deletion(s)`);
}

module.exports = { runUserDeletionJob, purgeUserData };
