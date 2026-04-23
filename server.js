require('dotenv').config({ path: 'secrets.env' });
const express = require('express');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('redis');

const app = express();
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

let dbPool;
let redisClient;
let redisConnected = false;

// ================= REDIS SETUP WITH TIMEOUT =================
async function initRedis() {
    try {
        redisClient = createClient({
            host: process.env.REDIS_HOST || 'localhost',
            port: process.env.REDIS_PORT || 6379,
            socket: {
                reconnectStrategy: (retries) => {
                    if (retries > 10) {
                        console.log('⚠️  Redis reconnection attempts exceeded');
                        return new Error('Redis max retries exceeded');
                    }
                    return Math.min(retries * 50, 500);
                }
            }
        });

        redisClient.on('error', (err) => {
            console.log('⚠️  Redis error:', err.message);
            redisConnected = false;
        });

        redisClient.on('connect', () => {
            console.log('✅ Redis connected');
            redisConnected = true;
        });

        redisClient.on('ready', () => {
            console.log('✅ Redis ready for commands');
            redisConnected = true;
        });

        // Connect with timeout
        const connectPromise = redisClient.connect();
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Redis connection timeout')), 5000)
        );

        try {
            await Promise.race([connectPromise, timeoutPromise]);
            console.log('✅ Redis initialized successfully');
            redisConnected = true;
            return true;
        } catch (err) {
            console.log(`⚠️  Redis initialization failed (${err.message}) - continuing without cache`);
            redisConnected = false;
            return false;
        }
    } catch (err) {
        console.log(`⚠️  Redis setup error: ${err.message} - continuing without cache`);
        redisConnected = false;
        return false;
    }
}

// ================= CACHE HELPERS =================
async function getFromCache(key) {
    if (!redisClient || !redisConnected) return null;
    try {
        const data = await redisClient.get(key);
        if (data) {
            console.log(`📦 Cache hit for ${key}`);
            return JSON.parse(data);
        }
        return null;
    } catch (err) {
        console.log(`❌ Cache get error: ${err.message}`);
        return null;
    }
}

async function setCache(key, value, ttl = 300) {
    if (!redisClient || !redisConnected) return;
    try {
        await redisClient.setEx(key, ttl, JSON.stringify(value));
    } catch (err) {
        console.log(`❌ Cache set error: ${err.message}`);
    }
}

async function invalidateCache(pattern) {
    if (!redisClient || !redisConnected) return;
    try {
        const keys = await redisClient.keys(pattern);
        if (keys.length > 0) {
            await redisClient.del(keys);
            console.log(`🗑️  Invalidated ${keys.length} cache keys`);
        }
    } catch (err) {
        console.log(`❌ Cache invalidation error: ${err.message}`);
    }
}

// ================= HELPER: Get date 90 days ago =================
function get90DaysAgoDate() {
    const now = new Date();
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    return ninetyDaysAgo.toISOString();
}

// ================= DB INIT =================
async function initDB() {
    const setupConnection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD
    });

    await setupConnection.query(`CREATE DATABASE IF NOT EXISTS \`github_tracker\`;`);
    await setupConnection.end();

    dbPool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: 'github_tracker',
        waitForConnections: true,
        connectionLimit: 10
    });

    await dbPool.query(`
        CREATE TABLE IF NOT EXISTS user_ranks (
            id INT AUTO_INCREMENT PRIMARY KEY,
            login VARCHAR(100),
            organization VARCHAR(100) DEFAULT NULL,
            stack VARCHAR(100) DEFAULT NULL,
            tab_type VARCHAR(20),
            scope VARCHAR(20) DEFAULT 'internal',
            user_rank INT,
            contributions INT,
            commits_90d INT DEFAULT NULL,
            fetch_id INT DEFAULT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_lookup (login, tab_type, scope, fetch_id)
        )
    `);

    console.log("✅ Database ready");
}

// ================= READ USERS WITH ORGANIZATION AND STACK =================
function getTrackedAccounts() {
    const data = fs.readFileSync(path.join(__dirname, 'accounts.txt'), 'utf8');
    return data
        .split('\n')
        .map(line => {
            const trimmed = line.trim();
            if (!trimmed) return null;
            
            const parts = trimmed.split(',');
            const url = parts[0].trim();
            const organization = parts.length > 1 ? parts[1].trim() : null;
            const stack = parts.length > 2 ? parts[2].trim() : null;
            
            const login = url.replace('https://github.com/', '').trim();
            
            if (!login) return null;
            
            return { login, organization, stack };
        })
        .filter(u => u !== null);
}

// ================= INTERNAL STATS WITH CACHE =================
async function fetchInternalStats(login) {
    // Check cache first
    const cacheKey = `github:${login}`;
    const cached = await getFromCache(cacheKey);
    if (cached) {
        return cached;
    }

    const query = `
      query($login: String!) {
        user(login: $login) {
          login
          name
          avatarUrl
          contributionsCollection {
            restrictedContributionsCount
            contributionCalendar {
              totalContributions
            }
          }
        }
      }
    `;

    try {
        const res = await axios.post(
            'https://api.github.com/graphql',
            { query, variables: { login } },
            { 
                headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
                timeout: 10000
            }
        );

        const u = res.data.data.user;
        if (!u) return null;

        const result = {
            login: u.login,
            name: u.name,
            avatar: u.avatarUrl,
            public_contribs: u.contributionsCollection.contributionCalendar.totalContributions,
            all_contribs:
                u.contributionsCollection.contributionCalendar.totalContributions +
                u.contributionsCollection.restrictedContributionsCount,
            fetch_status: 'success'
        };

        // Cache for 1 hour (3600s)
        await setCache(cacheKey, result, 3600);
        return result;

    } catch (e) {
        console.log(`⚠️  Error fetching ${login}: ${e.message}`);
        return {
            login,
            fetch_status: 'error',
            error: e.message
        };
    }
}

// ================= FETCH 90-DAY COMMITS =================
async function fetch90DayCommits(login) {
    const cacheKey = `commits90d:${login}`;
    const cached = await getFromCache(cacheKey);
    if (cached) {
        return cached;
    }

    const ninetyDaysAgo = get90DaysAgoDate();

    const query = `
      query($login: String!, $since: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $since) {
            contributionCalendar {
              totalContributions
            }
          }
        }
      }
    `;

    try {
        const res = await axios.post(
            'https://api.github.com/graphql',
            { query, variables: { login, since: ninetyDaysAgo } },
            { 
                headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
                timeout: 10000
            }
        );

        const totalContribs = res.data.data.user.contributionsCollection.contributionCalendar.totalContributions;
        
        await setCache(cacheKey, totalContribs, 3600);
        return totalContribs;

    } catch (e) {
        console.log(`⚠️  Error fetching 90d commits for ${login}: ${e.message}`);
        return 0;
    }
}

// ================= FETCH NATIONAL RANKINGS VIA CHEERIO SCRAPING =================
async function fetchNationalRankings(accountsWithOrgStack) {
    try {
        const cacheKey = 'oman_rankings_cheerio';
        let omanUsersMap = await getFromCache(cacheKey);

        if (!omanUsersMap) {
            console.log(`🔄 Scraping committers.top/oman using cheerio...`);
            
            try {
                const pageRes = await axios.get('https://committers.top/oman', {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    },
                    timeout: 15000
                });

                omanUsersMap = new Map();
                const $ = cheerio.load(pageRes.data);

                $('table tbody tr').each((index, element) => {
                    // Extract link to github profile
                    const link = $(element).find('a[href^="https://github.com/"]').attr('href');
                    
                    if (link) {
                        const login = link.replace('https://github.com/', '').trim().toLowerCase();
                        
                        // Look for the columns. Usually 3rd column (index 2) is the contributions
                        const tds = $(element).find('td');
                        let contribs = undefined;
                        
                        if (tds.length >= 3) {
                            const contribsText = $(tds[2]).text().replace(/,/g, '').trim();
                            const parsed = parseInt(contribsText, 10);
                            if (!isNaN(parsed)) {
                                contribs = parsed;
                            }
                        }

                        omanUsersMap.set(login, {
                            rank: index + 1, // Row index + 1 is their actual rank on the page
                            contribs: contribs
                        });
                    }
                });

                // Convert Map to object for caching
                const mapObj = {};
                omanUsersMap.forEach((v, k) => mapObj[k] = v);
                
                // Cache for 6 hours
                await setCache(cacheKey, mapObj, 21600);
                
                // Convert back to Map
                omanUsersMap = new Map(Object.entries(mapObj));
                console.log(`✅ Loaded ${omanUsersMap.size} users via Cheerio from committers.top`);

            } catch (e) {
                console.log(`⚠️  Fallback: Could not scrape committers.top data: ${e.message}`);
                omanUsersMap = new Map(); // Empty map to allow graceful degradation
            }
        } else {
            console.log(`📦 Using cached Oman rankings from Cheerio`);
            omanUsersMap = new Map(Object.entries(omanUsersMap));
        }

        const fetchPromises = accountsWithOrgStack.map(async (account) => {
            try {
                const query = `
                  query($login: String!) {
                    user(login: $login) {
                      login
                      name
                      avatarUrl
                      contributionsCollection {
                        restrictedContributionsCount
                        contributionCalendar {
                          totalContributions
                        }
                      }
                    }
                  }
                `;

                const res = await axios.post(
                    'https://api.github.com/graphql',
                    { query, variables: { login: account.login } },
                    { 
                        headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
                        timeout: 10000
                    }
                );

                const u = res.data.data.user;
                if (!u) return null;

                const totalContribs = u.contributionsCollection.contributionCalendar.totalContributions +
                                     u.contributionsCollection.restrictedContributionsCount;

                // Fetch 90-day commits (with cache)
                const commits90d = await fetch90DayCommits(account.login);

                const omanUser = omanUsersMap.get(account.login.toLowerCase());

                // If user is found on committers.top with contribs, use that number. Otherwise fallback to API.
                const finalContribs = (omanUser && omanUser.contribs !== undefined) 
                    ? omanUser.contribs 
                    : totalContribs;

                return {
                    login: u.login,
                    organization: account.organization,
                    stack: account.stack,
                    name: u.name,
                    avatar: u.avatarUrl,
                    contribs: finalContribs,
                    commits_90d: commits90d,
                    user_rank: omanUser ? omanUser.rank : null,
                    inTopOman: omanUser ? true : false,
                    fetch_status: 'success'
                };

            } catch (e) {
                console.log(`❌ Error fetching data for ${account.login}: ${e.message}`);
                return {
                    login: account.login,
                    organization: account.organization,
                    stack: account.stack,
                    fetch_status: 'error',
                    error: e.message
                };
            }
        });

        const results = await Promise.all(fetchPromises);
        const validResults = results.filter(r => r !== null);

        // Sort by rank
        validResults.sort((a, b) => {
            if (a.inTopOman && b.inTopOman) return a.user_rank - b.user_rank;
            if (a.inTopOman) return -1;
            if (b.inTopOman) return 1;
            return (b.commits_90d || 0) - (a.commits_90d || 0);
        });

        return validResults;

    } catch (e) {
        console.log(`❌ Error in fetchNationalRankings: ${e.message}`);
        return [];
    }
}

// ================= API: MAIN TRACK ENDPOINT =================
app.get('/api/track', async (req, res) => {
    const tab = req.query.tab === 'all' ? 'all' : 'public';
    const scope = req.query.scope === 'national' ? 'national' : 'internal';
    const fetchId = Math.floor(Date.now() / 1000);

    // Check if we have recent cached results
    const resultCacheKey = `results:${scope}:${tab}`;
    const cachedResults = await getFromCache(resultCacheKey);
    if (cachedResults) {
        console.log(`📦 Using cached results for ${scope}/${tab}`);
        return res.json(cachedResults);
    }

    const accountsWithOrgStack = getTrackedAccounts();
    let users = [];

    if (scope === 'internal') {
        // INTERNAL RANKING WITH PARALLEL FETCH
        const fetchPromises = accountsWithOrgStack.map(async (account) => {
            const stats = await fetchInternalStats(account.login);
            if (stats && stats.fetch_status === 'success') {
                return {
                    ...stats,
                    organization: account.organization,
                    stack: account.stack,
                    contribs: tab === 'all'
                        ? stats.all_contribs
                        : stats.public_contribs
                };
            } else if (stats && stats.fetch_status === 'error') {
                // Try to use stale data from last successful fetch
                const [lastRecord] = await dbPool.query(
                    `SELECT user_rank, contributions, name, avatar, organization, stack FROM user_ranks 
                     WHERE login = ? AND tab_type = ? AND scope = ? AND user_rank IS NOT NULL
                     ORDER BY timestamp DESC LIMIT 1`,
                    [account.login, tab, scope]
                );

                if (lastRecord) {
                    console.log(`⚠️  Using stale data for ${account.login}`);
                    return {
                        login: account.login,
                        organization: lastRecord.organization || account.organization,
                        stack: lastRecord.stack || account.stack,
                        name: lastRecord.name || account.login,
                        avatar: lastRecord.avatar || null,
                        contribs: lastRecord.contributions,
                        fetch_status: 'stale',
                        is_stale: true
                    };
                }
            }
            return null;
        });

        const results = await Promise.all(fetchPromises);
        users = results.filter(u => u !== null);

        users.sort((a, b) => b.contribs - a.contribs);
        users.forEach((u, i) => u.user_rank = i + 1);

    } else {
        // NATIONAL RANKINGS
        users = await fetchNationalRankings(accountsWithOrgStack);
    }

    // ================= SAVE + PREVIOUS RANK =================
    for (let user of users) {
        const [rows] = await dbPool.query(
            `SELECT user_rank FROM user_ranks 
             WHERE login = ? AND tab_type = ? AND scope = ? 
             AND (fetch_id IS NULL OR fetch_id != ?)
             ORDER BY timestamp DESC LIMIT 1`,
            [user.login, tab, scope, fetchId]
        );

        const prevRank = rows.length > 0 ? rows[0].user_rank : null;
        user.prev_rank = prevRank;

        if (user.user_rank !== null && user.user_rank !== undefined && prevRank !== null) {
            user.rank_change = prevRank - user.user_rank;
        } else {
            user.rank_change = null;
        }

        if (user.fetch_status === 'stale') {
            user.status = 'stale';
        } else if (prevRank !== null && user.user_rank === null) {
            user.status = 'dropped_from_rankings';
        } else if (prevRank === null && user.user_rank !== null) {
            user.status = 'new_to_rankings';
        } else if (user.user_rank === null) {
            user.status = 'unranked';
        } else {
            user.status = 'ranked';
        }

        await dbPool.query(
            `INSERT INTO user_ranks 
             (login, organization, stack, tab_type, scope, user_rank, contributions, commits_90d, fetch_id) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [user.login, user.organization || null, user.stack || null, tab, scope, user.user_rank || null, user.contribs || 0, user.commits_90d || null, fetchId]
        );
    }

    // Cache results for 5 minutes
    await setCache(resultCacheKey, users, 300);

    res.json(users);
});

// ================= API: GROUP BREAKDOWN ENDPOINT =================
app.get('/api/group-breakdown', async (req, res) => {
    const organization = req.query.organization;
    const stack = req.query.stack;
    const tab = req.query.tab === 'all' ? 'all' : 'public';

    if (!organization || !stack) {
        return res.status(400).json({ error: 'Missing organization or stack parameter' });
    }

    try {
        // Check cache first
        const cacheKey = `breakdown:${organization}:${stack}:${tab}`;
        const cached = await getFromCache(cacheKey);
        if (cached) {
            console.log(`📦 Cache hit for breakdown ${organization} - ${stack}`);
            return res.json(cached);
        }

        // Get all tracked accounts
        const allAccounts = getTrackedAccounts();

        // Filter accounts that match the organization and stack
        const matchingAccounts = allAccounts.filter(account => {
            const accountOrg = (account.organization || '').trim().toUpperCase();
            const accountStack = (account.stack || '').trim().toLowerCase();
            const paramOrg = (organization || '').trim().toUpperCase();
            const paramStack = (stack || '').trim().toLowerCase();

            // Normalize stack names
            let accountStackNorm = accountStack;
            let paramStackNorm = paramStack;
            
            if (accountStackNorm.includes('java')) accountStackNorm = 'java full stack';
            else if (accountStackNorm.includes('c#')) accountStackNorm = 'c# full stack';
            
            if (paramStackNorm.includes('java')) paramStackNorm = 'java full stack';
            else if (paramStackNorm.includes('c#')) paramStackNorm = 'c# full stack';

            return accountOrg === paramOrg && accountStackNorm === paramStackNorm;
        });

        if (matchingAccounts.length === 0) {
            return res.json({ users: [], totalContribs: 0 });
        }

        // Fetch stats for all matching accounts in parallel
        const fetchPromises = matchingAccounts.map(async (account) => {
            const stats = await fetchInternalStats(account.login);
            if (stats && stats.fetch_status === 'success') {
                return {
                    login: stats.login,
                    name: stats.name,
                    avatar: stats.avatar,
                    contribs: tab === 'all'
                        ? stats.all_contribs
                        : stats.public_contribs,
                    organization: account.organization,
                    stack: account.stack
                };
            }
            return null;
        });

        const results = await Promise.all(fetchPromises);
        const validUsers = results.filter(u => u !== null);

        // Calculate total contributions
        const totalContribs = validUsers.reduce((sum, u) => sum + (u.contribs || 0), 0);

        const response = {
            users: validUsers,
            totalContribs: totalContribs,
            organization: organization,
            stack: stack
        };

        // Cache for 30 minutes
        await setCache(cacheKey, response, 1800);

        res.json(response);

    } catch (e) {
        console.log(`❌ Error in group breakdown: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// ================= CACHE INVALIDATION ENDPOINT =================
app.post('/api/invalidate-cache', async (req, res) => {
    // Only allow if auth token matches
    if (req.query.token !== process.env.CACHE_INVALIDATE_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    await invalidateCache('*');
    res.json({ success: true, message: 'Cache invalidated' });
});

// ================= GRACEFUL SHUTDOWN =================
process.on('SIGTERM', async () => {
    console.log('SIGTERM signal received: closing HTTP server');
    if (redisClient && redisConnected) {
        await redisClient.quit();
    }
    process.exit(0);
});

// ================= START =================
async function start() {
    try {
        // Initialize Redis (with timeout, won't block if it fails)
        await initRedis();
        
        // Initialize Database
        await initDB();
        
        // Start server
        app.listen(3000, () => {
            console.log('🚀 Server running at http://localhost:3000');
        });
    } catch (err) {
        console.error('❌ Fatal error during startup:', err.message);
        process.exit(1);
    }
}

start();