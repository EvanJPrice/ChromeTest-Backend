// --- Imports ---
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
// (We have removed Resend)

// --- Setup ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const geminiKey = process.env.GOOGLE_API_KEY; // Make sure this matches your .env

// Check for missing keys (Resend key check removed)
if (!supabaseUrl || !supabaseKey || !geminiKey) {
  console.error("❌ ERROR: Missing .env variables! Check SUPABASE_URL, SUPABASE_ANON_KEY, and GOOGLE_API_KEY.");
  process.exit(1); 
}

// Initialize clients (Resend client removed)
const genAI = new GoogleGenerativeAI(geminiKey);
const supabase = createClient(supabaseUrl, supabaseKey);
const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// --- System-level domains that are always allowed ---
const SYSTEM_ALLOWED_DOMAINS = [
    'onrender.com',       // Allows your backend and frontend
    'supabase.co',        // Allows Supabase API calls
    'accounts.google.com', // Allows the Google Sign-In flow
    'vercel.app',        // Allows Vercel hosted frontends
    'beaconblocker.com'  // Allows main website
];

// --- Helper: getDomainFromUrl ---
function getDomainFromUrl(urlString) {
    if (!urlString) return null;
    try {
        let fullUrl = urlString.trim();
        if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) {
            fullUrl = 'http://' + fullUrl;
        }
        const url = new URL(fullUrl);
        const parts = url.hostname.split('.');
        if (parts.length >= 2) {
            if (parts.length > 2 && parts[parts.length - 2].length <= 3 && parts[parts.length - 1].length <= 3) {
                 return parts.slice(-3).join('.').toLowerCase(); // e.g., bbc.co.uk
            }
            return parts.slice(-2).join('.').toLowerCase(); // e.g., google.com
        }
        return url.hostname.toLowerCase();
    } catch (e) { console.error("Error extracting domain:", e); return null; }
}

// --- Helper: Log Blocking Event ---
async function logBlockingEvent(logData) {
    const { userId, url, decision, reason, pageTitle } = logData;
    if (!userId) {
        console.error("Cannot log event: userId is missing.");
        return;
    }
    try {
        const domain = getDomainFromUrl(url);
        const { error } = await supabase.from('blocking_log').insert({
            user_id: userId,
            url: url || 'Unknown URL',
            domain: domain || 'Unknown Domain',
            decision: decision,
            reason: reason,
            page_title: pageTitle || ''
        });
        if (error) console.error("Error logging event:", error.message);
    } catch (err) {
        console.error("Exception during logging:", err.message);
    }
}

// --- Database Function: Fetches User Rule (Updated) ---
async function getUserRuleData(apiKey) {
    if (!apiKey) {
        console.error("❌ No API key provided.");
        return null;
    }
    console.log("Fetching rule data for key:", apiKey.substring(0, 5) + "...");

    // Fetches all relevant columns, including user_id and last_seen
    const { data, error } = await supabase
        .from('rules')
        .select('user_id, prompt, api_key, blocked_categories, allow_list, block_list, last_seen')
        .eq('api_key', apiKey)
        .single();

    if (error || !data) {
        console.error("❌ Error fetching rule data or key not found:", error?.message);
        return null; // Return null on failure
    }

    console.log("✅ Successfully fetched rule data!");
    data.allow_list = data.allow_list || [];
    data.block_list = data.block_list || [];
    data.blocked_categories = data.blocked_categories || {};
    return data; // Return the whole data object
}

// --- AI Decision Function ---
async function getAIDecision(pageData, ruleData) {
    const { title, description, h1, url, searchQuery, keywords, bodyText } = pageData; // Added keywords and bodyText
    const { prompt: userMainPrompt, blocked_categories } = ruleData;

    console.log(`AI Check: Title='${title || '(empty)'}', URL='${url}'`);

    let finalPrompt = userMainPrompt || "No prompt provided."; 
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
        .map(([key]) => BLOCKED_CATEGORY_LABELS[key] || key); 

    if (selectedCategoryLabels.length > 0) {
        finalPrompt += `\n\n**Explicitly Blocked Categories:**\n- ${selectedCategoryLabels.join('\n- ')}`;
    }

    // Updated prompt with new data points
    finalPrompt += `\n\nAnalyze the webpage based on the following information:
    - URL: "${url}"
    - Title: "${title || 'N/A'}"
    - H1 Header: "${h1 || 'N/A'}"
    - Meta Description: "${description || 'N/A'}"
    - Meta Keywords: "${keywords || 'N/A'}" 
    - Body Text Snippet: "${bodyText || 'N/A'}" 
    - Search Query (if any): "${searchQuery || 'N/A'}"

    My user's rule details are above.
    **CRITICAL BLOCKING INSTRUCTIONS:**
    1. Prioritize any "Always Block" or "Always Allow" lists provided separately (handled before this call).
    2. Strictly follow the "Explicitly Blocked Categories" if listed.
    3. Use the main user rule text for overall guidance and nuance.
    4. Respond with *only* ALLOW or BLOCK. Be decisive.
    `;

    try {
        const result = await model.generateContent(finalPrompt);
        const response = await result.response;
        let decision = response.text().trim().toUpperCase();
        if (decision.includes('BLOCK')) {
            decision = 'BLOCK';
        } else if (decision.includes('ALLOW')) {
            decision = 'ALLOW';
        } else {
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

// --- API Endpoint: Check URL ---
app.post('/check-url', async (req, res) => {
    const pageData = req.body;
    const url = pageData?.url;
    const authHeader = req.headers['authorization'];
    const apiKey = authHeader ? authHeader.split(' ')[1] : null;

    if (!url || !apiKey) {
        return res.status(400).json({ error: 'Missing URL or API Key' });
    }

    let userId = null;
    let currentDomain = null;

    try {
        currentDomain = getDomainFromUrl(url); 
        
        // --- 1. System Allow Check ---
        if (currentDomain && SYSTEM_ALLOWED_DOMAINS.some(domain => currentDomain.endsWith(domain))) {
            console.log(`System Allow: Allowing ${currentDomain} (dashboard/infra).`);
            try {
                const ruleData = await getUserRuleData(apiKey);
                userId = ruleData?.user_id;
                await logBlockingEvent({userId, url, decision: 'ALLOW', reason: 'System Rule (Infra)', pageTitle: pageData?.title});
            } catch (logErr) {
                console.error("Error logging system allow:", logErr.message);
            }
            return res.json({ decision: 'ALLOW' });
        }
        
        // --- 2. User-Specific Rule Logic ---
        const ruleData = await getUserRuleData(apiKey);
        if (!ruleData) {
            await logBlockingEvent({userId: null, url, decision: 'BLOCK', reason: 'Invalid API Key', pageTitle: pageData?.title});
            return res.status(401).json({ error: "Invalid API Key" });
        }
        
        userId = ruleData.user_id;
        const { allow_list, block_list } = ruleData;

        // --- 3. Check User Allow List ---
        if (currentDomain && allow_list.some(domain => currentDomain === domain || currentDomain.endsWith('.' + domain))) {
            console.log(`URL domain (${currentDomain}) matches Allow list. ALLOWING.`);
            await logBlockingEvent({userId, url, decision: 'ALLOW', reason: 'Matched Allow List', pageTitle: pageData?.title});
            return res.json({ decision: 'ALLOW' });
        }

        // --- 4. Check User Block List ---
        if (currentDomain && block_list.some(domain => currentDomain === domain || currentDomain.endsWith('.' + domain))) {
            console.log(`URL domain (${currentDomain}) matches Block list. BLOCKING.`);
            await logBlockingEvent({userId, url, decision: 'BLOCK', reason: 'Matched Block List', pageTitle: pageData?.title});
            return res.json({ decision: 'BLOCK' });
        }

        // --- 5. AI Check ---
        console.log("URL not in pre-filter lists. Proceeding to AI check.");
        const decision = await getAIDecision(pageData, ruleData);
        await logBlockingEvent({userId, url, decision, reason: 'AI Decision', pageTitle: pageData?.title});
        res.json({ decision: decision });

    } catch (err) {
        console.error("Error during pre-filtering or AI check:", err.message);
        await logBlockingEvent({
            userId: userId, 
            url: url, 
            decision: 'BLOCK', 
            reason: 'Server Error Fallback', 
            pageTitle: pageData?.title
        });
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// --- API Endpoint: Heartbeat ---
app.post('/heartbeat', async (req, res) => {
    const apiKey = req.query.key;
    if (apiKey) {
        try {
            const { error } = await supabase
                .from('rules')
                .update({ last_seen: new Date().toISOString() })
                .eq('api_key', apiKey);
            
            if (error) {
                console.warn("Error updating last_seen:", error.message);
            } else {
                console.log(`Heartbeat received for key: ${apiKey.substring(0, 5)}...`);
            }
        } catch (err) {
            console.error("Error in heartbeat endpoint:", err.message);
        }
    }
    res.status(200).send('OK');
});

// --- (The /uninstalled endpoint has been removed) ---


// --- Start the server (THIS IS THE CRITICAL LINE) ---
app.listen(port, () => {
    console.log(`✅ SERVER IS LIVE (All Features) on port ${port}`);
});