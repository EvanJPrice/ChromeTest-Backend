// --- Imports (Keep all existing imports) ---
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// --- Setup (AI, Supabase, Server - Keep existing) ---

// 1. Read environment variables loaded by dotenv
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const geminiKey = process.env.GOOGLE_API_KEY;

// 2. Check if keys are missing (good practice for servers)
if (!supabaseUrl || !supabaseKey || !geminiKey) {
  console.error("❌ ERROR: Missing .env variables! Check SUPABASE_URL, SUPABASE_ANON_KEY, and GOOGLE_API_KEY.");
  // Don't start the server if keys are missing
  process.exit(1); 
}

// 3. Initialize your clients (THIS IS THE FIX)
const genAI = new GoogleGenerativeAI(geminiKey);
const supabase = createClient(supabaseUrl, supabaseKey);

// 4. Continue with your existing code
const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" }); // Or gemini-1.0-pro
const app = express();
app.use(cors());
app.use(express.json());
const port = process.env.PORT || 3000;

// --- Helper: getDomainFromUrl (Keep existing) ---
function getDomainFromUrl(urlString) {
    try {
        const url = new URL(urlString);
        const parts = url.hostname.split('.');
        if (parts.length >= 2) { return parts.slice(-2).join('.').toLowerCase(); }
        return url.hostname.toLowerCase();
    } catch (e) { console.error("Error extracting domain:", e); return null; }
}

// --- UPDATED: Database Function - Fetches Structured Rule ---
async function getUserRuleData(apiKey) {
    if (!apiKey) {
        console.error("❌ No API key provided.");
        // Return default structured data on failure
        return { prompt: "Block social media and news.", allow_list: [], block_list: [], blocked_categories: {} };
    }
    console.log("Fetching rule data for key:", apiKey.substring(0, 5) + "...");

    // Fetch all the relevant columns now
    const { data, error } = await supabase
        .from('rules')
        .select('prompt, allow_list, block_list, blocked_categories') // Select new columns
        .eq('api_key', apiKey)
        .single(); // Use .single() now that we know the key exists

    if (error || !data) {
        // Log the specific error if it happens again
        console.error("❌ Error fetching rule data or key not found:", error?.message);
        // Return default structured data on failure
        return { prompt: "Block social media and news.", allow_list: [], block_list: [], blocked_categories: {} };
    }

    console.log("✅ Successfully fetched rule data!");
    // Ensure lists are arrays even if DB returns null
    data.allow_list = data.allow_list || [];
    data.block_list = data.block_list || [];
    data.blocked_categories = data.blocked_categories || {};
    return data; // Return the whole data object
}

// --- AI Decision Function (UPDATED - accepts structured ruleData) ---
async function getAIDecision(pageData, ruleData) {
    const { title, description, h1, url, searchQuery } = pageData;
    const { prompt: userMainPrompt, blocked_categories } = ruleData; // Extract raw data

    console.log(`AI Check: Title='${title || '(empty)'}', URL='${url}'`);

    // --- NEW: Construct a structured, unambiguous prompt ---

    // 1. Get the labels of the toggled categories
    // (We need to define BLOCKED_CATEGORIES here, or just use the keys)
    const BLOCKED_CATEGORY_LABELS = {
        'social': 'Social Media (Facebook, Instagram, TikTok, etc.)',
        'news': 'News & Politics',
        'entertainment': 'Entertainment (Streaming, non-educational YouTube)',
        'games': 'Games',
        'shopping': 'Online Shopping (General)',
        'mature': 'Mature Content (Violence, Adult Themes, etc.)'
    };

    const selectedCategoryLabels = Object.entries(blocked_categories || {})
        .filter(([, value]) => value === true)
        .map(([key]) => BLOCKED_CATEGORY_LABELS[key] || key); // Get the full label

    // 2. Build the final prompt
    let finalPrompt = `You are an AI web filter. Your goal is to help a user focus or stay safe.
The user has already set "Always Allow" and "Always Block" lists. This URL was NOT on those lists.
Your job is to decide if this page should be blocked based on the user's general policy.

---
**User's General Policy (Main Prompt):**
"${userMainPrompt || 'No general policy provided. Rely on the blocked categories.'}"

---
**User's Pre-set Categories to Block:**
${selectedCategoryLabels.length > 0 ? selectedCategoryLabels.map(label => `- ${label}`).join('\n') : 'No specific categories are pre-blocked.'}

---
**Webpage to Analyze:**
- URL: "${url}"
- Title: "${title || 'N/A'}"
- H1 Header: "${h1 || 'N/A'}"
- Description: "${description || 'N/A'}"
- Search Query (if any): "${searchQuery || 'N/A'}"

---
**Your Decision:**
Based on the user's policy and pre-set categories, should this page be BLOCKED or ALLOWED?
Respond with *only* the single word: ALLOW or BLOCK
`;
    // --- End of new prompt construction ---

    try {
        const result = await model.generateContent(finalPrompt);
        const response = await result.response;
        let decision = response.text().trim().toUpperCase();
        
        if (decision.includes('BLOCK')) {
            decision = 'BLOCK';
        } else if (decision.includes('ALLOW')) {
            decision = 'ALLOW';
        } else {
            console.warn('AI gave unclear answer:', response.text(), '. Defaulting to ALLOW.');
            decision = 'ALLOW'; // Default to ALLOW for edge cases to be less disruptive
        }

        console.log(`AI decision for ${url} is: ${decision}`);
        return decision;
    } catch (error) {
        console.error('Error contacting AI:', error.message);
        // Default to ALLOW to avoid over-blocking on AI errors
        return 'ALLOW';
    }
}

// --- API Endpoint (UPDATED with structured data pre-filtering) ---
app.post('/check-url', async (req, res) => {
    const pageData = req.body;
    const url = pageData?.url;
    const authHeader = req.headers['authorization'];
    const apiKey = authHeader ? authHeader.split(' ')[1] : null;

    console.log('Received POST request for:', url || 'No URL in body');

    if (!url || !apiKey) {
        return res.status(400).json({ error: 'Missing URL or API Key' });
    }

    try {
        // --- PRE-FILTERING uses structured data ---
        // 1. Fetch the structured rule data
        const ruleData = await getUserRuleData(apiKey);
        const { allow_list, block_list } = ruleData; // Get lists directly

        // 2. Get the current domain
        const currentDomain = getDomainFromUrl(url);

        // 3. Check Allow List (using array includes/endsWith)
        if (currentDomain && allow_list.some(domain => currentDomain === domain || currentDomain.endsWith('.' + domain))) {
            console.log(`URL domain (${currentDomain}) matches Allow list. ALLOWING.`);
            return res.json({ decision: 'ALLOW' });
        }

        // 4. Check Block List (using array includes/endsWith)
        if (currentDomain && block_list.some(domain => currentDomain === domain || currentDomain.endsWith('.' + domain))) {
            console.log(`URL domain (${currentDomain}) matches Block list. BLOCKING.`);
            return res.json({ decision: 'BLOCK' });
        }

        // 5. If not pre-filtered, proceed to AI check
        console.log("URL not in pre-filter lists. Proceeding to AI check.");
        // Pass the full ruleData object to the AI function
        const decision = await getAIDecision(pageData, ruleData);
        res.json({ decision: decision });

    } catch (err) {
        console.error("Error during pre-filtering or AI check:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// --- Start the server (Unchanged) ---
app.listen(port, () => {
    console.log(`✅ SERVER IS LIVE (Structured Rules) on port ${port}`);
});