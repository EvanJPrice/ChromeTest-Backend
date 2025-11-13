// --- Imports ---
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// --- Setup ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const geminiKey = process.env.GOOGLE_API_KEY;

if (!supabaseUrl || !supabaseKey || !geminiKey) {
  console.error("❌ ERROR: Missing .env variables! Check SUPABASE_URL, SUPABASE_ANON_KEY, and GOOGLE_API_KEY.");
  process.exit(1); 
}

const genAI = new GoogleGenerativeAI(geminiKey);
const supabase = createClient(supabaseUrl, supabaseKey);
const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// --- 1. INFRASTRUCTURE ALLOW LIST ---
const SYSTEM_ALLOWED_DOMAINS = [
    'onrender.com',       // Allows your backend and frontend
    'supabase.co',        // Allows Supabase API calls
    'accounts.google.com',// Allows the Google Sign-In flow
    'beaconblocker.com',  // Your custom domain
    'vercel.app'          // Dashboard hosting
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
                 return parts.slice(-3).join('.').toLowerCase();
            }
            return parts.slice(-2).join('.').toLowerCase();
        }
        return url.hostname.toLowerCase();
    } catch (e) { console.error("Error extracting domain:", e); return null; }
}

// --- Helper: Log Blocking Event ---
async function logBlockingEvent(logData) {
    const { userId, url, decision, reason, pageTitle } = logData;
    if (!userId) return; 
    
    // --- UPDATED LOGIC ---
    // Only skip "Infra" rules (like dashboard loading). 
    // We WANT to log "System Rule (Search)" and "System Rule (YT)".
    if (reason && reason.startsWith('System Rule (Infra)')) {
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

// --- Database Function: Fetches User Rule ---
async function getUserRuleData(apiKey) {
    if (!apiKey) return null;
    
    const { data, error } = await supabase
        .from('rules')
        .select('user_id, prompt, api_key, blocked_categories, allow_list, block_list, last_seen')
        .eq('api_key', apiKey)
        .single();

    if (error || !data) {
        console.error("Error fetching rule:", error?.message);
        return null;
    }

    data.allow_list = data.allow_list || [];
    data.block_list = data.block_list || [];
    data.blocked_categories = data.blocked_categories || {};
    return data;
}

// --- AI Decision Function ---
async function getAIDecision(pageData, ruleData) {
    const { title, description, h1, url, searchQuery, keywords, bodyText } = pageData;
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

    finalPrompt += `\n\nAnalyze the webpage based on the following information:
    - URL: "${url}"
    - Title: "${title || 'N/A'}"
    - H1 Header: "${h1 || 'N/A'}"
    - Meta Description: "${description || 'N/A'}"
    - Meta Keywords: "${keywords || 'N/A'}" 
    - Body Text Snippet: "${bodyText || 'N/A'}" 
    - Search Query (context only): "${searchQuery || 'N/A'}"

    My user's rule details are above.
    **CRITICAL BLOCKING INSTRUCTIONS:**
    1. Prioritize any "Always Block" or "Always Allow" lists provided separately.
    2. Strictly follow the "Explicitly Blocked Categories".
    3. Use the main user rule text for overall guidance.
    4. Respond with *only* ALLOW or BLOCK.
    `;

    try {
        const result = await model.generateContent(finalPrompt);
        const response = await result.response;
        let decision = response.text().trim().toUpperCase();
        
        if (decision.includes('BLOCK')) return 'BLOCK';
        if (decision.includes('ALLOW')) return 'ALLOW';
        
        return 'BLOCK'; // Default safety
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

    try {
        // --- 1. SMART ALLOWS (Save Tokens & Protect Infra) ---
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.toLowerCase();
        const pathname = urlObj.pathname;
        const baseDomain = getDomainFromUrl(url);

        // A. Dashboard & Infrastructure
        if (baseDomain && SYSTEM_ALLOWED_DOMAINS.some(d => baseDomain.endsWith(d))) {
             console.log(`System Allow: Infra (${baseDomain})`);
             // Note: reason 'System Rule (Infra)' will be SKIPPED by the log function
             await logBlockingEvent({userId, url, decision: 'ALLOW', reason: 'System Rule (Infra)', pageTitle: pageData?.title});
             return res.json({ decision: 'ALLOW' });
        }

        // --- 2. Fetch User Rules (Moved Up to get userId) ---
        const ruleData = await getUserRuleData(apiKey);
        if (!ruleData) {
            return res.status(401).json({ error: "Invalid API Key" });
        }
        userId = ruleData.user_id;
        const { allow_list, block_list } = ruleData;

        // --- 3. SEARCH ENGINE ALLOWS (Updated to Log!) ---
        if ((hostname.includes('google.') || hostname.includes('bing.') || hostname.includes('duckduckgo.')) 
            && (pathname === '/' || pathname.startsWith('/search'))) {
             
             const displayTitle = pageData.searchQuery ? `Search: "${pageData.searchQuery}"` : "Search Engine Home";
             console.log(`System Allow: ${displayTitle}`);
             
             await logBlockingEvent({
                 userId, 
                 url, 
                 decision: 'ALLOW', 
                 reason: 'System Rule (Search)', 
                 pageTitle: displayTitle 
             });
             return res.json({ decision: 'ALLOW' });
        }

        // --- 4. YOUTUBE BROWSING ALLOWS (Updated to Log!) ---
        if (hostname.endsWith('youtube.com')) {
            if (!pathname.startsWith('/watch') && !pathname.startsWith('/shorts')) {
                 
                 const displayTitle = pageData.searchQuery ? `Youtube: "${pageData.searchQuery}"` : "YouTube Browsing";
                 console.log(`System Allow: ${displayTitle}`);

                 await logBlockingEvent({
                     userId, 
                     url, 
                     decision: 'ALLOW', 
                     reason: 'System Rule (YT)', 
                     pageTitle: displayTitle
                 });
                 return res.json({ decision: 'ALLOW' });
            }
        }

        // --- 5. User Lists ---
        if (baseDomain && allow_list.some(d => baseDomain === d || baseDomain.endsWith('.' + d))) {
            console.log(`User Allow: ${baseDomain}`);
            await logBlockingEvent({userId, url, decision: 'ALLOW', reason: 'Matched Allow List', pageTitle: pageData?.title});
            return res.json({ decision: 'ALLOW' });
        }

        if (baseDomain && block_list.some(d => baseDomain === d || baseDomain.endsWith('.' + d))) {
            console.log(`User Block: ${baseDomain}`);
            await logBlockingEvent({userId, url, decision: 'BLOCK', reason: 'Matched Block List', pageTitle: pageData?.title});
            return res.json({ decision: 'BLOCK' });
        }

        // --- 6. AI Check ---
        console.log("AI Check for:", url);
        const decision = await getAIDecision(pageData, ruleData);
        await logBlockingEvent({userId, url, decision, reason: 'AI Decision', pageTitle: pageData?.title});
        res.json({ decision: decision });

    } catch (err) {
        console.error("Error in check-url:", err.message);
        await logBlockingEvent({userId, url, decision: 'BLOCK', reason: 'Server Error', pageTitle: pageData?.title});
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// --- API Endpoint: Heartbeat ---
app.post('/heartbeat', async (req, res) => {
    const apiKey = req.query.key;
    if (apiKey) {
        try {
            await supabase.from('rules').update({ last_seen: new Date().toISOString() }).eq('api_key', apiKey);
        } catch (err) { /* ignore */ }
    }
    res.status(200).send('OK');
});

app.listen(port, () => {
    console.log(`✅ SERVER IS LIVE on port ${port}`);
});