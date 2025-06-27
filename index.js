// podcast-monitor-service/index.js
const express = require('express');
const cron = require('node-cron');
const Parser = require('rss-parser');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

// Initialize services
const app = express();
const parser = new Parser();

// Environment variables (you'll set these)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const EMAIL_HOST = process.env.EMAIL_HOST;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Configure email transporter
const emailTransporter = nodemailer.createTransporter({
  host: EMAIL_HOST,
  port: 587,
  secure: false,
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS
  }
});

app.use(express.json());

// RSS Feed Monitor - runs 3x daily (8 AM, 2 PM, 8 PM)
cron.schedule('0 8,14,20 * * *', async () => {
  console.log('🔍 Starting RSS feed check...');
  await checkAllFeeds();
});

// Daily Digest Email - runs at 8 AM
cron.schedule('0 8 * * *', async () => {
  console.log('📧 Sending daily digest...');
  await sendDailyDigest();
});

// Main RSS checking function
async function checkAllFeeds() {
  try {
    // Get all active podcasts from database
    const { data: podcasts, error } = await supabase
      .from('podcasts')
      .select('*')
      .eq('is_active', true);

    if (error) throw error;

    console.log(`📡 Checking ${podcasts.length} podcast feeds...`);

    for (const podcast of podcasts) {
      await processPodcastFeed(podcast);
      // Wait 2 seconds between requests to be respectful
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log('✅ RSS feed check completed');
  } catch (error) {
    console.error('❌ Error checking feeds:', error);
  }
}

// Process individual podcast feed
async function processPodcastFeed(podcast) {
  try {
    console.log(`🎧 Processing: ${podcast.name}`);
    
    const feed = await parser.parseURL(podcast.rss_url);
    const lastChecked = podcast.last_checked ? new Date(podcast.last_checked) : new Date(0);
    
    let newEpisodesCount = 0;

    for (const item of feed.items) {
      const publishDate = new Date(item.pubDate || item.isoDate);
      
      // Only process episodes newer than last check
      if (publishDate > lastChecked) {
        await processNewEpisode(podcast, item);
        newEpisodesCount++;
      }
    }

    // Update last checked timestamp
    await supabase
      .from('podcasts')
      .update({ last_checked: new Date().toISOString() })
      .eq('id', podcast.id);

    if (newEpisodesCount > 0) {
      console.log(`✨ Found ${newEpisodesCount} new episodes for ${podcast.name}`);
    }

  } catch (error) {
    console.error(`❌ Error processing ${podcast.name}:`, error);
  }
}

// Process new episode
async function processNewEpisode(podcast, item) {
  try {
    // Extract episode details
    const episodeData = {
      podcast_id: podcast.id,
      title: item.title,
      description: item.contentSnippet || item.content,
      audio_url: getAudioUrl(item),
      published_at: new Date(item.pubDate || item.isoDate).toISOString(),
      duration_seconds: parseDuration(item.itunes?.duration),
      processed: false
    };

    // Insert episode into database
    const { data: episode, error } = await supabase
      .from('episodes')
      .insert(episodeData)
      .select()
      .single();

    if (error) throw error;

    console.log(`💾 Saved episode: ${episode.title}`);

    // Queue for AI processing
    await processEpisodeAI(episode);

  } catch (error) {
    console.error('❌ Error processing new episode:', error);
  }
}

// AI Processing Pipeline
async function processEpisodeAI(episode) {
  try {
    console.log(`🤖 Starting AI processing for: ${episode.title}`);

    // Step 1: Download and transcribe audio
    const transcript = await transcribeAudio(episode.audio_url);
    
    if (!transcript) {
      console.log('⚠️ No transcript generated, skipping AI analysis');
      return;
    }

    // Step 2: Generate enhanced AI summary
    const aiSummary = await generateEnhancedSummary(episode, transcript);

    // Step 3: Flag interest topics with timestamps
    const topicFlags = await flagInterestTopics(episode, transcript);

    // Step 4: Update episode with AI analysis
    await supabase
      .from('episodes')
      .update({
        transcript: transcript,
        ai_summary: aiSummary,
        processed: true
      })
      .eq('id', episode.id);

    // Step 5: Save topic flags
    if (topicFlags.length > 0) {
      await supabase
        .from('topic_flags')
        .insert(topicFlags);
    }

    console.log(`✅ AI processing completed for: ${episode.title}`);

  } catch (error) {
    console.error('❌ Error in AI processing:', error);
  }
}

// Transcribe audio using OpenAI Whisper
async function transcribeAudio(audioUrl) {
  try {
    if (!audioUrl) return null;

    console.log('🎵 Transcribing audio...');

    // Download audio file (first 30 minutes to manage costs)
    const audioResponse = await axios({
      method: 'GET',
      url: audioUrl,
      responseType: 'stream',
      timeout: 300000, // 5 minute timeout
      maxContentLength: 50 * 1024 * 1024 // 50MB max
    });

    // Save temporarily
    const tempPath = `/tmp/audio_${Date.now()}.mp3`;
    const writer = fs.createWriteStream(tempPath);
    audioResponse.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // Transcribe with Whisper
    const formData = new FormData();
    formData.append('file', fs.createReadStream(tempPath));
    formData.append('model', 'whisper-1');

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          ...formData.getHeaders()
        },
        timeout: 300000 // 5 minute timeout
      }
    );

    // Clean up temp file
    fs.unlinkSync(tempPath);

    return response.data.text;

  } catch (error) {
    console.error('❌ Transcription error:', error);
    return null;
  }
}

// Generate enhanced AI summary using Claude
async function generateEnhancedSummary(episode, transcript) {
  try {
    const prompt = `Analyze this podcast episode and provide an enhanced summary in the following JSON format:

{
  "guest": "Guest name(s) or 'Host only'",
  "summary_paragraphs": [
    "2-3 detailed paragraphs about the episode content, main arguments, and key insights discussed",
    "Include specific details about what was covered and the guest's expertise/perspective",
    "Mention any particularly interesting or controversial points made"
  ],
  "key_topics": ["list", "of", "main", "topics", "discussed"],
  "main_arguments": ["key", "arguments", "or", "positions", "presented"],
  "notable_quotes": [
    {"speaker": "Name", "quote": "Notable quote from the episode", "context": "Why this quote is significant"}
  ]
}

Episode: "${episode.title}"
Description: "${episode.description || ''}"
Transcript: "${transcript.substring(0, 8000)}" ${transcript.length > 8000 ? '...[truncated]' : ''}

Provide only the JSON response, no additional text.`;

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-3-sonnet-20240229',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01'
        }
      }
    );

    return response.data.content[0].text;

  } catch (error) {
    console.error('❌ Summary generation error:', error);
    return JSON.stringify({
      guest: "Unknown",
      summary_paragraphs: ["AI summary generation failed. Manual review required."],
      key_topics: [],
      main_arguments: [],
      notable_quotes: []
    });
  }
}

// Flag interest topics with enhanced analysis
async function flagInterestTopics(episode, transcript) {
  try {
    // Get user's interest topics
    const { data: topics } = await supabase
      .from('interest_topics')
      .select('*')
      .eq('is_active', true);

    if (!topics || topics.length === 0) return [];

    const topicsList = topics.map(t => t.topic).join(', ');

    const prompt = `Analyze this podcast transcript for mentions of these interest topics: ${topicsList}

For each topic that is substantially discussed (not just mentioned in passing), provide detailed analysis with precise timestamps.

If an entire episode is heavily focused on one or more topics, mark it as "PRIORITY LISTEN!" 

Return JSON in this format:
{
  "priority_episode": boolean, // true if entire episode focuses extensively on interest topics
  "priority_topics": ["topics", "that", "make", "this", "priority"], // if priority_episode is true
  "topic_flags": [
    {
      "topic": "exact topic name from the list",
      "timestamp_start": seconds_into_episode,
      "timestamp_end": seconds_into_episode,
      "snippet": "Key quote or description of what was said",
      "analysis": "2-4 sentences explaining why this section is relevant to the topic and what insights or perspectives were shared. Include specific details about arguments made or information presented.",
      "relevance_score": 0.1-1.0 // how relevant/important this discussion is
    }
  ]
}

Episode: "${episode.title}"
Transcript: "${transcript.substring(0, 12000)}" ${transcript.length > 12000 ? '...[truncated]' : ''}

Only include topics that are meaningfully discussed. Provide precise analysis for why each flagged section matters. Return only JSON.`;

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-3-sonnet-20240229',
        max_tokens: 3000,
        messages: [{ role: 'user', content: prompt }]
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01'
        }
      }
    );

    const analysis = JSON.parse(response.data.content[0].text);
    const flags = [];

    // Convert to database format
    for (const flag of analysis.topic_flags || []) {
      const topic = topics.find(t => t.topic.toLowerCase() === flag.topic.toLowerCase());
      if (topic) {
        flags.push({
          episode_id: episode.id,
          topic_id: topic.id,
          timestamp_start: flag.timestamp_start,
          timestamp_end: flag.timestamp_end,
          snippet: flag.snippet,
          analysis: flag.analysis,
          relevance_score: flag.relevance_score
        });
      }
    }

    // If priority episode, add metadata
    if (analysis.priority_episode) {
      await supabase
        .from('episodes')
        .update({ 
          ai_summary: JSON.stringify({
            ...JSON.parse(episode.ai_summary || '{}'),
            priority_episode: true,
            priority_topics: analysis.priority_topics
          })
        })
        .eq('id', episode.id);
    }

    return flags;

  } catch (error) {
    console.error('❌ Topic flagging error:', error);
    return [];
  }
}

// Send daily digest email
async function sendDailyDigest() {
  try {
    // Get user email
    const { data: settings } = await supabase
      .from('user_settings')
      .select('email')
      .single();

    if (!settings?.email) {
      console.log('No email configured');
      return;
    }

    // Get recent episodes (last 24 hours)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const { data: episodes } = await supabase
      .from('episodes')
      .select(`
        *,
        podcasts(name),
        topic_flags(
          *,
          interest_topics(topic)
        )
      `)
      .gte('published_at', yesterday.toISOString())
      .eq('processed', true)
      .order('published_at', { ascending: false });

    if (!episodes || episodes.length === 0) {
      console.log('No new episodes to digest');
      return;
    }

    // Generate HTML email
    const htmlContent = generateDigestHTML(episodes);

    // Send email
    await emailTransporter.sendMail({
      from: EMAIL_USER,
      to: settings.email,
      subject: `Your Daily Podcast Digest - ${new Date().toLocaleDateString()}`,
      html: htmlContent
    });

    console.log(`📧 Daily digest sent to ${settings.email}`);

  } catch (error) {
    console.error('❌ Error sending digest:', error);
  }
}

// Generate HTML email content
function generateDigestHTML(episodes) {
  const priorityEpisodes = episodes.filter(ep => {
    try {
      const summary = JSON.parse(ep.ai_summary || '{}');
      return summary.priority_episode;
    } catch {
      return false;
    }
  });

  let html = `
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .header { background: #2563eb; color: white; padding: 20px; text-align: center; }
        .episode { margin: 20px 0; padding: 15px; border-left: 4px solid #e5e7eb; }
        .priority { border-left-color: #dc2626; background: #fef2f2; }
        .topic-flag { background: #eff6ff; margin: 10px 0; padding: 10px; border-radius: 4px; }
        .timestamp { color: #2563eb; font-weight: bold; text-decoration: none; }
        .play-link { background: #2563eb; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>🎧 Your Daily Podcast Digest</h1>
        <p>${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
      </div>
  `;

  if (priorityEpisodes.length > 0) {
    html += '<h2>🚨 Priority Episodes (Extensive Coverage of Your Interests)</h2>';
    priorityEpisodes.forEach(episode => {
      html += generateEpisodeHTML(episode, true);
    });
  }

  const regularEpisodes = episodes.filter(ep => !priorityEpisodes.includes(ep));
  if (regularEpisodes.length > 0) {
    html += '<h2>📰 Recent Episodes</h2>';
    regularEpisodes.forEach(episode => {
      html += generateEpisodeHTML(episode, false);
    });
  }

  html += '</body></html>';
  return html;
}

// Generate individual episode HTML
function generateEpisodeHTML(episode, isPriority) {
  const podcast = episode.podcasts;
  const flags = episode.topic_flags || [];
  
  let summary;
  try {
    summary = JSON.parse(episode.ai_summary || '{}');
  } catch {
    summary = {};
  }

  const applePodcastsUrl = generateApplePodcastsUrl(podcast.name, episode.title);

  let html = `
    <div class="episode ${isPriority ? 'priority' : ''}">
      ${isPriority ? '<div style="color: #dc2626; font-weight: bold;">🚨 PRIORITY LISTEN!</div>' : ''}
      <h3>${episode.title}</h3>
      <p><strong>${podcast.name}</strong> • ${summary.guest || 'Unknown'} • ${formatDuration(episode.duration_seconds)}</p>
      <p><small>${new Date(episode.published_at).toLocaleString()}</small></p>
      
      <a href="${applePodcastsUrl}" class="play-link">▶️ Open in Apple Podcasts</a>
      
      <div style="margin: 15px 0;">
        <h4>Enhanced AI Summary</h4>
  `;

  if (summary.summary_paragraphs) {
    summary.summary_paragraphs.forEach(para => {
      html += `<p style="margin: 10px 0;">${para}</p>`;
    });
  }

  html += '</div>';

  if (flags.length > 0) {
    html += '<h4>🎯 Flagged Topics</h4>';
    flags.forEach(flag => {
      const timestampUrl = applePodcastsUrl + `&t=${flag.timestamp_start}`;
      html += `
        <div class="topic-flag">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span style="background: #2563eb; color: white; padding: 2px 8px; border-radius: 12px; font-size: 12px;">
              ${flag.interest_topics.topic}
            </span>
            <a href="${timestampUrl}" class="timestamp">${formatTime(flag.timestamp_start)}</a>
          </div>
          <p style="margin: 0; font-size: 14px;">${flag.analysis}</p>
        </div>
      `;
    });
  }

  html += '</div>';
  return html;
}

// Utility functions
function getAudioUrl(item) {
  if (item.enclosure?.url) return item.enclosure.url;
  if (item.link?.includes('.mp3')) return item.link;
  return null;
}

function parseDuration(duration) {
  if (!duration) return null;
  const parts = duration.split(':').map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return null;
}

function formatDuration(seconds) {
  if (!seconds) return 'Unknown duration';
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function generateApplePodcastsUrl(podcastName, episodeTitle) {
  // This would need podcast-specific Apple Podcasts IDs
  // For now, return a search URL
  const searchQuery = encodeURIComponent(`${podcastName} ${episodeTitle}`);
  return `https://podcasts.apple.com/search?term=${searchQuery}`;
}

// API endpoints
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.post('/check-feeds', async (req, res) => {
  try {
    await checkAllFeeds();
    res.json({ success: true, message: 'Feed check completed' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/send-digest', async (req, res) => {
  try {
    await sendDailyDigest();
    res.json({ success: true, message: 'Digest sent' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Podcast Monitor Service running on port ${PORT}`);
  console.log('📅 RSS feeds will be checked 3x daily (8 AM, 2 PM, 8 PM)');
  console.log('📧 Daily digest will be sent at 8 AM');
});

module.exports = app;
