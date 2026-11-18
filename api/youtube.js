// YouTube Data API integration for automated video upload
// Requires: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET in environment
// User provides: YouTube channel credentials via OAuth2

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const youtube = google.youtube('v3');

// OAuth2 configuration
const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:3000/api/youtube-callback'
);

/**
 * Generate viral title from script content
 * Hindi/Hinglish, includes emojis, trending keywords
 */
function generateViralTitle(script, format) {
  const parts = script.split(' ').slice(0, 20).join(' ');
  const titles = [
    `🎬 ${parts.slice(0, 40)} | Full Story`,
    `❤️ Kahani | ${parts.slice(0, 35)}`,
    `✨ Mind Blowing Story | ${parts.slice(0, 32)} 🤯`,
    `🔥 Must Watch | ${parts.slice(0, 38)} | Emotional`,
    `💯 Viral Story | ${parts.slice(0, 36)} | Hindi`,
  ];
  return titles[Math.floor(Math.random() * titles.length)].slice(0, 100);
}

/**
 * Generate viral description with CTAs and hashtags
 */
function generateViralDescription(script, channelName, partNo, totalParts) {
  const desc = `
🎬 ${channelName} presents an amazing story!

${script.slice(0, 150)}...

Watch till the end to find out what happens next!

👍 Like our video
🔔 Subscribe for more stories
💬 Comment your thoughts
📲 Share with friends

${partNo < totalParts ? `\n⏭️ Part ${partNo + 1} coming soon!` : '\n✅ Series Complete!'}

#story #hindi #viral #shorts #kahani #hinglish #youtube #emotional
`.trim();
  return desc.slice(0, 5000);
}

/**
 * Generate viral tags from script content
 */
function generateViralTags(script, categoryId) {
  const baseTagsMap = {
    village: ['गाँव की कहानी', 'village story', 'हिंदी कहानी', 'मजेदार', 'viral'],
    family: ['family story', 'खानदान', 'रिश्ते', 'family drama', 'emotional'],
    kids: ['बच्चों की कहानी', 'kids story', 'moral story', 'शिक्षाप्रद', 'बालगीत'],
    mystery: ['mystery', 'रहस्य', 'suspense', 'twistending', 'thriller'],
  };
  const baseTags = baseTagsMap[categoryId] || ['story', 'hindi', 'viral'];
  const allTags = [
    ...baseTags,
    'youtube shorts',
    'short video',
    'हिंदी',
    'भारतीय',
    'entertainment',
    'trending',
  ];
  return allTags.slice(0, 20);
}

/**
 * Upload video to YouTube
 * @param {Buffer} videoBuffer - MP4 file buffer
 * @param {Object} metadata - { title, description, tags, categoryId, channelName, partNo, totalParts }
 * @param {string} accessToken - User's YouTube OAuth access token
 */
async function uploadToYouTube(videoBuffer, metadata, accessToken) {
  try {
    oauth2Client.setCredentials({ access_token: accessToken });

    const title = metadata.title || generateViralTitle(metadata.script || '', 'short');
    const description =
      metadata.description ||
      generateViralDescription(
        metadata.script || '',
        metadata.channelName || 'Story Channel',
        metadata.partNo || 1,
        metadata.totalParts || 1
      );
    const tags = metadata.tags || generateViralTags(metadata.script || '', metadata.categoryId);

    const resource = {
      snippet: {
        title: title.slice(0, 100),
        description: description.slice(0, 5000),
        tags: tags,
        categoryId: '24', // 24 = Entertainment
      },
      status: {
        privacyStatus: 'public', // or 'unlisted' / 'private'
        madeForKids: false,
      },
    };

    const response = await youtube.videos.insert(
      {
        auth: oauth2Client,
        part: 'snippet,status',
        resource: resource,
        media: {
          mimeType: 'video/mp4',
          body: videoBuffer,
        },
      },
      { maxContentLength: 500 * 1024 * 1024 } // 500MB max
    );

    return {
      success: true,
      videoId: response.data.id,
      url: `https://youtu.be/${response.data.id}`,
      title: response.data.snippet.title,
    };
  } catch (error) {
    console.error('YouTube upload error:', error.message);
    throw new Error(`YouTube upload failed: ${error.message}`);
  }
}

/**
 * Get authorization URL for user to grant access
 */
function getAuthorizationUrl() {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/youtube.upload'],
  });
}

/**
 * Exchange authorization code for access token
 */
async function getAccessTokenFromCode(code) {
  try {
    const { tokens } = await oauth2Client.getToken(code);
    return tokens.access_token;
  } catch (error) {
    throw new Error(`Failed to get access token: ${error.message}`);
  }
}

module.exports = {
  uploadToYouTube,
  getAuthorizationUrl,
  getAccessTokenFromCode,
  generateViralTitle,
  generateViralDescription,
  generateViralTags,
};
