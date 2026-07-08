import i18n from '../i18n';

/**
 * Human-readable relative time string.
 * Shared by ReviewCard, ReplyCard, and DiscussionCard.
 */
export default function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return i18n.t('timeAgo.justNow');
  if (mins < 60) return i18n.t('timeAgo.minutesAgo', { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return i18n.t('timeAgo.hoursAgo', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return i18n.t('timeAgo.daysAgo', { n: days });
  const months = Math.floor(days / 30);
  if (months < 12) return i18n.t('timeAgo.monthsAgo', { n: months });
  return i18n.t('timeAgo.yearsAgo', { n: Math.floor(months / 12) });
}
