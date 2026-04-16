/**
 * 邮件过滤规则
 */

const FILTER_RULES = {
  sender_patterns: [
    /noreply@.*apple/i,
    /insideapple\.apple\.com/i,
    /applemusic@/i,
    /news@.*apple/i,
    /no-?reply@/i,
  ],
  subject_patterns: [
    /^<广告>/i,
    /unsubscribe/i,
    /退订/i,
  ],
  shouldFilter(email) {
    const from = (email.from_addr || '').toLowerCase();
    const subject = email.subject || '';
    for (const p of this.sender_patterns) {
      if (p.test(from)) return true;
    }
    for (const p of this.subject_patterns) {
      if (p.test(subject)) return true;
    }
    return false;
  }
};

module.exports = { FILTER_RULES };
