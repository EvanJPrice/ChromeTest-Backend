// --- Imports ---
require('dotenv').config();
console.log("✅ 1. 'dotenv' loaded.");

const { GoogleGenerativeAI } = require('@google/generative-ai');
console.log("✅ 2. Google AI package loaded.");

const axios = require('axios');
console.log("✅ 3. 'axios' package loaded.");

const cheerio = require('cheerio');
console.log("✅ 4. 'cheerio' package loaded.");

const express = require('express');
const cors = require('cors');
console.log("✅ 5. Express and CORS loaded.");

// --- NEW SUPABASE IMPORT ---
const { createClient } = require('@supabase/supabase-js');
console.log("✅ 6. Supabase client loaded.");

// --- AI Setup ---
const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error("❌ FATAL ERROR: GOOGLE_API_KEY is not found in your .env file!");
  process.exit(1); 
}
console.log("✅ 7. Google API key found.");

const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" });
console.log("✅ 8. AI Model selected.");

// --- NEW SUPABASE SETUP ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ FATAL ERROR: SUPABASE_URL or SUPABASE_SERVICE_KEY is not found in your .env file!");
  process.exit(1);
}

// Initialize the Supabase admin client
const supabase = createClient(supabaseUrl, supabaseKey);
console.log("✅ 9. Supabase client initialized.");

// --- Server Setup ---
const app = express();
const port = 3000;
app.use(cors());
console.log("✅ 10. Express server configured.");

// --- Updated Scraper Function ---
async function getPageContent(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        // --- Use a more modern User-Agent ---
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9', // Tell server we prefer English
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8' // Standard accept header
      },
      timeout: 4000 // Add a timeout (e.g., 4 seconds) to prevent hanging on slow sites
    });

    // Simple check if the response looks like HTML
    const contentType = response.headers['content-type'];
    if (!contentType || !contentType.includes('html')) {
        console.warn(`Warning: Response from ${url} is not HTML (${contentType}). Falling back to URL-only.`);
        return { title: url, description: '' };
    }

    const $ = cheerio.load(response.data);

    // --- Try Open Graph tags first, then fall back to standard tags ---
    let title = $('meta[property="og:title"]').attr('content') || $('title').text();
    let description = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';

    // Clean up whitespace
    title = title ? title.trim() : '';
    description = description ? description.trim() : '';

    console.log(`Scraped Title: ${title || '(empty)'}`); // Log if empty

    return { title, description };

  } catch (error) {
    // Log more specific scraping errors
    if (error.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        console.warn(`Warning: Failed to scrape ${url}. Status: ${error.response.status}. Falling back.`);
    } else if (error.request) {
        // The request was made but no response was received
        console.warn(`Warning: No response received for ${url}. Falling back.`);
    } else {
        // Something happened in setting up the request that triggered an Error
        console.warn(`Warning: Error setting up request for ${url}: ${error.message}. Falling back.`);
    }
    return { title: url, description: '' };
  }
}

// --- UPDATED: Database Function ---
// It now accepts an 'apiKey' to find the specific user.
async function getUserRule(apiKey) {
  if (!apiKey) {
    console.error("❌ No API key provided by the extension.");
    return "Block all social media and news."; // A safe default
  }

  console.log("Fetching rule from database for key:", apiKey.substring(0, 5) + "...");
  
  const { data, error } = await supabase
    .from('rules')
    .select('prompt')
    .eq('api_key', apiKey) // <-- Find the rule WHERE api_key matches
    .single();
    
  if (error || !data) {
    console.error("❌ Error fetching rule or key not found:", error?.message);
    // If the key is bad, fall back to a default rule
    return "Block all social media and news.";
  }
  
  console.log("✅ Successfully fetched user-specific rule!");
  return data.prompt;
}

// --- AI Decision Function (Updated) ---
// It now needs the 'apiKey' to pass to the database function.
async function getAIDecision(url, apiKey) {
  
  const { title, description } = await getPageContent(url);
  
  // GET THE SPECIFIC RULE FROM THE DATABASE
  const userRule = await getUserRule(apiKey); 
  
  // --- Create a much smarter prompt ---
  const prompt = `
    Analyze the webpage based on the following information:
    - Title: "${title}"
    - Description: "${description}"
    - URL: "${url}"
    
    My user's rule is: "${userRule}"

    INSTRUCTIONS:
    1. Determine if the page content matches the user's ALLOW criteria based on their rule.
    2. **IMPORTANT:** If the Title and Description are empty or very short, the page might load dynamically (like YouTube, Reddit, social media). In this case:
        - Rely heavily on keywords and structure in the URL (e.g., '/watch', '/feed', '/explore', '/shorts', '/reels', '/education', '/learning').
        - Be MORE LIKELY TO BLOCK common distracting domains (youtube.com, facebook.com, instagram.com, reddit.com, tiktok.com, twitter.com) UNLESS the URL path *clearly* indicates allowed content based on the user's rule (e.g., '/education').
        - If the URL is just the base domain (e.g., 'youtube.com/') and the title is empty, it's likely a distracting feed - BLOCK it according to the rule.
    3. Respond with *only* the word 'ALLOW' or 'BLOCK'. Be decisive based on the rule.
  `;
  
  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    let decision = response.text().trim().toUpperCase();
    if (decision !== 'ALLOW' && decision !== 'BLOCK') {
      console.warn('AI gave an unclear answer. Defaulting to BLOCK.');
      decision = 'BLOCK';
    }
    console.log(`AI decision for ${url} is: ${decision}`);
    return decision;
  } catch (error) {
    console.error('Error contacting AI:', error);
    return 'BLOCK';
  }
}

// --- UPDATED: API Endpoint ---
app.get('/check-url', async (req, res) => {
  const url = req.query.url;
  
  // --- THIS IS THE MODIFIED PART ---

  // 1. We're changing 'x-api-key' to 'authorization'
  const authHeader = req.headers['authorization']; 

  // 2. We're adding this line to split the "Bearer " part off the key
  const apiKey = authHeader ? authHeader.split(' ')[1] : null; 
  
  // --- END OF MODIFIED PART ---
  
  console.log('Received a request for:', url);

  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
    console.log('Ignoring internal Chrome URL.');
    res.json({ decision: 'ALLOW' }); 
    return;
  }
  
  // Pass the apiKey to the decision function
  const decision = await getAIDecision(url, apiKey);
  res.json({ decision: decision });
});

// --- Start the server ---
app.listen(port, () => {
  // --- UPDATED LOG MESSAGE ---
  console.log(`✅ SERVER IS LIVE (with User Auth) and listening on port ${port}`);
});