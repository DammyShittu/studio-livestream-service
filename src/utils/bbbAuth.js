// src/utils/bbbAuth.js
const crypto = require('crypto');

/**
 * Generates a valid BBB join URL for a hidden viewer participant.
 * The viewer joins with listen-only mode and is hidden from the dashboard.
 */
function generateJoinUrl(bbbUrl, secret, meetingId, options = {}) {
  const {
    fullName = 'Livestream',
    role = 'VIEWER',
    listenOnlyMode = true,
    excludeFromDashboard = true,
  } = options;

  const params = new URLSearchParams({
    fullName,
    meetingID: meetingId,
    role,
    ...(listenOnlyMode && { listenOnlyMode: 'true' }),
    ...(excludeFromDashboard && { excludeFromDashboard: 'true' }),
    userdata_bbb_auto_join_audio: 'true',
    userdata_bbb_listen_only_mode: 'true',
    userdata_bbb_skip_check_audio: 'true',
    // Hide UI elements for a cleaner capture output
    userdata_bbb_show_participants_on_login: 'false',
  });

  const queryString = params.toString();
  const checksum = sha1(`join${queryString}${secret}`);
  params.append('checksum', checksum);

  return `${bbbUrl}/api/join?${params.toString()}`;
}

/**
 * Generates a BBB API checksum
 */
function sha1(str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

/**
 * Verifies an incoming API request (for webhook callbacks from nginx-rtmp)
 */
function verifyApiSecret(req) {
  const provided = req.headers['x-api-secret'] || req.query.secret;
  return provided === process.env.API_SECRET;
}

module.exports = { generateJoinUrl, sha1, verifyApiSecret };
