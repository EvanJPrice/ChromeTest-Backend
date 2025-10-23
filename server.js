// --- Imports (Keep all existing imports) ---
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// --- Setup (AI, Supabase, Server - Keep existing) ---
// ... (Make sure AI model, Supabase client, app, port are set up) ...
const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" }); // Or gemini-1.0-pro
const supabase = createClient(supabaseUrl, supabaseKey);
const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

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
        .single();

    if (error || !data) {
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
async function getAIDecision(pageData, ruleData) { // Takes ruleData object now
    const { title, description, h1, url, searchQuery } = pageData;
    const { prompt: userMainPrompt, blocked_categories } = ruleData; // Extract needed parts

    console.log(`Data for AI: Title='${title || '(empty)'}', Desc='${description || '(empty)'}', H1='${h1 || '(empty)'}', Query='${searchQuery || '(none)'}'`);

    // --- Construct prompt using structured data ---
    let finalPrompt = userMainPrompt; // Start with the main text prompt

    // Get labels for checked categories (using the global constant if available, otherwise just keys)
    // You might need to define BLOCKED_CATEGORIES here or pass it if needed, or just use keys.
    const selectedCategoryKeys = Object.entries(blocked_categories || {})
        .filter(([, value]) => value === true)
        .map(([key]) => key); // Just use the keys (e.g., 'social', 'news')

    if (selectedCategoryKeys.length > 0) {
        finalPrompt += `\n\n**Explicitly Blocked Categories:**\n- ${selectedCategoryKeys.join('\n- ')}`;
    }

    // --- Append general instructions ---
     finalPrompt += `\n\nAnalyze the webpage based on the following information:
    - Title: "${title}"
    - Description: "${description}"
    - H1: "${h1}"
    - URL: "${url}"
    - Search Query that led here (if applicable): "${searchQuery || 'N/A'}"

    My user's rule details are above.

    **CRITICAL BLOCKING INSTRUCTIONS:**
    1. Prioritize any "Always Block" or "Always Allow" lists provided separately (handled before this call).
    2. Strictly follow the "Explicitly Blocked Categories" if listed.
    3. Use the main user rule text for overall guidance and nuance.
    4. Pay attention to URL structure for dynamic sites if Title/Desc are weak.
    5. Respond with *only* ALLOW or BLOCK. Be decisive.
    `;
    // --- End prompt construction ---

    try {
        const result = await model.generateContent(finalPrompt); // Send the combined prompt
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
        return 'BLOCK';
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