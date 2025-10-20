// --- Imports ---
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
// REMOVE axios and cheerio - no longer needed!
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// --- Setup (AI, Supabase) ---
const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) { console.error("❌ FATAL ERROR: GOOGLE_API_KEY missing!"); process.exit(1); }
const genAI = new GoogleGenerativeAI(apiKey);
// --- Use the model that worked best for you (1.0-pro recommended for accuracy) ---
const model = genAI.getGenerativeModel({ model: "gemini-1.0-pro" });
console.log("Using AI Model:", "gemini-1.0-pro");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !supabaseKey) { console.error("❌ FATAL ERROR: Supabase config missing!"); process.exit(1); }
const supabase = createClient(supabaseUrl, supabaseKey);

// --- Server Setup ---
const app = express();
const port = process.env.PORT || 3000; // Use Render's port or default to 3000
app.use(cors());
app.use(express.json()); // <-- ***** ADD THIS LINE ***** Middleware to parse JSON

// --- Database Function (Unchanged) ---
async function getUserRule(apiKey) {
  if (!apiKey) {
    console.error("❌ No API key provided by the extension.");
    return "Block all social media, news, and entertainment."; // Default rule
  }
  console.log("Fetching rule for key:", apiKey.substring(0, 5) + "...");
  const { data, error } = await supabase.from('rules').select('prompt').eq('api_key', apiKey).single();
  if (error || !data) {
    console.error("❌ Error fetching rule or key not found:", error?.message);
    return "Block all social media, news, and entertainment."; // Default rule
  }
  console.log("✅ Successfully fetched rule!");
  return data.prompt;
}

// --- AI Decision Function (Takes data from request body) ---
async function getAIDecision(pageData, apiKey) {
  // Data comes directly from the extension now
  const { title, description, h1, url } = pageData;
  console.log(`Data for AI: Title='${title || '(empty)'}', Desc='${description || '(empty)'}', H1='${h1 || '(empty)'}'`);

  const userRule = await getUserRule(apiKey);

  const prompt = `
    Analyze the webpage based on the following information:
    - Title: "${title}"
    - Description: "${description}"
    - H1: "${h1}"
    - URL: "${url}"

    My user's rule is: "${userRule}"

    INSTRUCTIONS:
    1. Determine if the page content matches the user's ALLOW criteria. Prioritize Title, H1, and Description.
    2. If Title/Desc/H1 are empty/short, rely more on the URL structure and keywords (e.g., '/watch', '/feed', '/shorts', '/reels', '/education').
    3. Be MORE LIKELY TO BLOCK common distracting domains (youtube.com, facebook.com, etc.) UNLESS the URL path *clearly* indicates allowed content (e.g., '/education').
    4. Respond with *only* the word 'ALLOW' or 'BLOCK'. Be decisive.
  `;

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    let decision = response.text().trim().toUpperCase();
    if (decision !== 'ALLOW' && decision !== 'BLOCK') {
      console.warn('AI gave unclear answer:', response.text(), '. Defaulting to BLOCK.');
      decision = 'BLOCK';
    }
    console.log(`AI decision for ${url} is: ${decision}`);
    return decision;
  } catch (error) {
    console.error('Error contacting AI:', error.message);
    return 'BLOCK'; // Fail-safe block
  }
}

// --- API Endpoint (Correct POST handling) ---
app.post('/check-url', async (req, res) => { // <-- Ensure this is app.post

  // Data now comes from the request body
  const pageData = req.body;
  const url = pageData?.url; // Get URL from body data

  const authHeader = req.headers['authorization'];
  const apiKey = authHeader ? authHeader.split(' ')[1] : null;

  console.log('Received POST request for:', url || 'No URL in body');

  // Basic validation
  if (!url || !apiKey) {
      console.error('Missing URL in body or API key in header.');
      return res.status(400).json({ error: 'Missing URL or API Key' });
  }

  try {
    // Pass the entire pageData object to the decision function
    const decision = await getAIDecision(pageData, apiKey);
    res.json({ decision: decision });
  } catch (err) {
      console.error("Error processing /check-url:", err);
      res.status(500).json({ error: "Internal Server Error" });
  }
});

// --- Start the server ---
app.listen(port, () => {
  console.log(`✅ SERVER IS LIVE (Content Script Mode) on port ${port}`);
});