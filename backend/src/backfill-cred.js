/**
 * Backfill Cellar Cred scores for all existing users.
 *
 * Counts each user's approved contributions and sets their contribution
 * subdocument accordingly. Safe to run multiple times (overwrites scores).
 *
 * Usage (containers must be running):
 *   docker exec cellarion-backend node src/backfill-cred.js
 */

require('./config/db');
const mongoose = require('mongoose');
const User = require('./models/User');
const WineRequest = require('./models/WineRequest');
const WineReport = require('./models/WineReport');
const BottleImage = require('./models/BottleImage');
const Review = require('./models/Review');
const Discussion = require('./models/Discussion');
const DiscussionReply = require('./models/DiscussionReply');
const ReviewVote = require('./models/ReviewVote');
const DiscussionReplyVote = require('./models/DiscussionReplyVote');
const { POINT_VALUES, getTier, getSpecialty } = require('./utils/cellarCred');

async function backfill() {
  await mongoose.connection.asPromise();
  console.log('Connected to MongoDB — starting Cellar Cred backfill…');

  const users = await User.find({}).select('_id username').lean();
  let updated = 0;

  for (const u of users) {
    const uid = u._id;

    // Curator
    const [wineReqs, grapeReqs, reports] = await Promise.all([
      WineRequest.countDocuments({ user: uid, status: 'resolved', requestType: 'new_wine' }),
      WineRequest.countDocuments({ user: uid, status: 'resolved', requestType: 'grape_suggestion' }),
      WineReport.countDocuments({ user: uid, status: 'resolved' }),
    ]);
    const curator = wineReqs * POINT_VALUES.wine_request_approved
                  + grapeReqs * POINT_VALUES.grape_suggestion_approved
                  + reports * POINT_VALUES.wine_report_resolved;

    // Photographer
    const [approved, assigned] = await Promise.all([
      BottleImage.countDocuments({ uploadedBy: uid, status: 'approved' }),
      BottleImage.countDocuments({ uploadedBy: uid, assignedToWine: true }),
    ]);
    const photographer = approved * POINT_VALUES.image_approved
                       + assigned * POINT_VALUES.image_assigned_official;

    // Critic
    const publicReviews = await Review.find({ author: uid, visibility: 'public' }).select('_id').lean();
    const reviewIds = publicReviews.map(r => r._id);
    const reviewLikes = reviewIds.length > 0
      ? await ReviewVote.countDocuments({ review: { $in: reviewIds } })
      : 0;
    const critic = publicReviews.length * POINT_VALUES.review_created_public
                 + reviewLikes * POINT_VALUES.review_like_received;

    // Community
    const [threads, replies] = await Promise.all([
      Discussion.countDocuments({ author: uid }),
      DiscussionReply.countDocuments({ author: uid, isDeleted: { $ne: true } }),
    ]);
    const userReplies = await DiscussionReply.find({ author: uid, isDeleted: { $ne: true } }).select('_id').lean();
    const replyIds = userReplies.map(r => r._id);
    const replyLikes = replyIds.length > 0
      ? await DiscussionReplyVote.countDocuments({ reply: { $in: replyIds } })
      : 0;
    const community = threads * POINT_VALUES.discussion_created
                    + replies * POINT_VALUES.discussion_reply_created
                    + replyLikes * POINT_VALUES.reply_like_received;

    const totalScore = curator + photographer + critic + community;
    const categories = { curator, photographer, critic, community };
    const tier = getTier(totalScore);
    const specialty = getSpecialty(categories);

    if (totalScore > 0) {
      await User.updateOne({ _id: uid }, {
        $set: {
          'contribution.totalScore': totalScore,
          'contribution.categories': categories,
          'contribution.tier': tier,
          'contribution.specialty': specialty,
        }
      });
      console.log(`  ${u.username}: ${totalScore} pts → ${tier}${specialty ? ` (${specialty})` : ''}`);
      updated++;
    }
  }

  console.log(`\nBackfill complete: ${updated}/${users.length} users updated.`);
  process.exit(0);
}

backfill().catch(err => { console.error('Backfill failed:', err); process.exit(1); });
