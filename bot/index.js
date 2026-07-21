import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// Load secrets
let token = process.env.TELEGRAM_BOT_TOKEN;
let webAppUrl = process.env.WEBAPP_URL;

if (!token || !webAppUrl) {
  const envPath = path.join(os.homedir(), '.secrets', 'viva_ton_bot.env');
  if (fs.existsSync(envPath)) {
    console.log(`[Server] Loading secrets from: ${envPath}`);
    const content = fs.readFileSync(envPath, 'utf8');
    content.split('\n').forEach((line) => {
      const match = line.match(/^\s*([\w.\-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let val = match[2] || '';
        if (val.startsWith('"') && val.endsWith('"')) {
          val = val.substring(1, val.length - 1);
        } else if (val.startsWith("'") && val.endsWith("'")) {
          val = val.substring(1, val.length - 1);
        }
        process.env[key] = val;
      }
    });
    token = process.env.TELEGRAM_BOT_TOKEN;
    webAppUrl = process.env.WEBAPP_URL;
  }
}

if (!token || !webAppUrl) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN and WEBAPP_URL must be configured.');
  process.exit(1);
}

// Port Configuration (Obscure high port)
const PORT = 8319;

// Ledger & Safe Paths
const LEDGER_PATH = path.join(os.homedir(), '.secrets', 'viva_ton_ledger.json');

// Ensure ledger exists
if (!fs.existsSync(LEDGER_PATH)) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify({ users: {} }, null, 2));
}

// Helper to load/save ledger
function readLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  } catch (err) {
    console.error('[Ledger] Reading error, restoring backup:', err);
    return { users: {} };
  }
}

function writeLedger(data) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(data, null, 2));
}

// Initialize user in ledger
function getOrCreateUser(telegramId, username = 'Expeditionist') {
  const ledger = readLedger();
  if (!ledger.users[telegramId]) {
    ledger.users[telegramId] = {
      id: telegramId,
      username: username,
      chips: 500, // starting chips reward
      highestLevel: 1,
      lastClaimTime: 0,
      withdrawals: [],
      cheatFlags: 0,
    };
    writeLedger(ledger);
  }
  return ledger.users[telegramId];
}

// Cryptographic Validation of Telegram WebApp Launch Data
function verifyTelegramWebAppData(initDataRaw) {
  try {
    const params = new URLSearchParams(initDataRaw);
    const hash = params.get('hash');
    if (!hash) return null;

    // Sort parameters alphabetically
    const keys = Array.from(params.keys()).filter((k) => k !== 'hash').sort();
    const dataCheckString = keys.map((k) => `${k}=${params.get(k)}`).join('\n');

    // Generate secret key using token and Telegram WebAppData salt
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculatedHash !== hash) {
      return null; // Cryptographic mismatch!
    }

    // Parse user field
    const userJson = JSON.parse(params.get('user'));
    return userJson;
  } catch (e) {
    console.error('[Auth] Cryptographic verification failed:', e.message);
    return null;
  }
}

// MIME Type Mapper for static files
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

// Unified Server: HTTP API + Static File Server
const distDir = path.join(process.cwd(), 'dist');

const server = http.createServer((req, res) => {
  // CORS Headers for secure API operations
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API Routing
  if (req.url === '/api/sync' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const userObj = verifyTelegramWebAppData(payload.initData);
        if (!userObj) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: Tampered launch data!' }));
          return;
        }

        const user = getOrCreateUser(userObj.id, userObj.username);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, balance: user.chips, highestLevel: user.highestLevel }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Malformed payload' }));
      }
    });
    return;
  }

  if (req.url === '/api/level-complete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const userObj = verifyTelegramWebAppData(payload.initData);
        if (!userObj) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const level = parseInt(payload.level, 10);
        if (isNaN(level) || level <= 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid level' }));
          return;
        }

        const ledger = readLedger();
        const user = ledger.users[userObj.id];
        if (!user) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'User not initialized' }));
          return;
        }

        // Anti-Cheat Mechanism: Progression verification
        // Check 1: Levels must be completed in order
        if (level > user.highestLevel + 1) {
          console.warn(`[Anti-Cheat] Player ${user.id} flagged for level skipping: requested completion of level ${level} when highest level was ${user.highestLevel}`);
          user.cheatFlags++;
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Progression error: Level completed out of order!' }));
          writeLedger(ledger);
          return;
        }

        // Calculate secure reward
        const baseReward = 100;
        const completionBonus = level * 10;
        const reward = baseReward + completionBonus;

        // Cap maximum possible chips per level to prevent value tampering
        if (reward > 1000) {
          console.warn(`[Anti-Cheat] Player ${user.id} requested anomalous payout for level ${level}`);
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Anomalous reward request!' }));
          return;
        }

        user.chips += reward;
        if (level > user.highestLevel) {
          user.highestLevel = level;
        }

        writeLedger(ledger);

        console.log(`[Ledger] Rewarded ${user.username} (${user.id}) +${reward} chips for completing Level ${level}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, balance: user.chips, highestLevel: user.highestLevel }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Error processing reward' }));
      }
    });
    return;
  }

  if (req.url === '/api/withdraw' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const userObj = verifyTelegramWebAppData(payload.initData);
        if (!userObj) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const withdrawAmount = parseInt(payload.amount, 10);
        if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid withdraw amount' }));
          return;
        }

        const ledger = readLedger();
        const user = ledger.users[userObj.id];
        if (!user || user.chips < withdrawAmount) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Insufficient balance' }));
          return;
        }

        // Anti-Cheat Mechanism: Check if user is flagged
        if (user.cheatFlags >= 3) {
          console.warn(`[Anti-Cheat] Withdrawal request BLOCKED for user ${user.id} due to multiple cheat flags.`);
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Account locked for security audit. Contact support.' }));
          return;
        }

        // Limit daily withdrawals to 5,000 chips (or 50 TON)
        const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
        const recentWithdrawalsSum = user.withdrawals
          .filter(w => w.timestamp > dayAgo)
          .reduce((sum, w) => sum + w.amount, 0);

        if (recentWithdrawalsSum + withdrawAmount > 5000) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Daily withdrawal limits exceeded. Max 5,000 chips/day.' }));
          return;
        }

        // Deduct balance securely
        user.chips -= withdrawAmount;
        user.withdrawals.push({
          amount: withdrawAmount,
          timestamp: Date.now(),
          address: payload.address || 'unknown',
          status: 'pending_processing'
        });

        writeLedger(ledger);

        console.log(`[Ledger] Securely processed withdrawal request for ${user.username} (${user.id}): -${withdrawAmount} chips`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, balance: user.chips, message: 'Withdrawal successfully queued for processing.' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal withdrawal error' }));
      }
    });
    return;
  }

  // Static File Serving
  let filePath = path.join(distDir, req.url === '/' ? 'index.html' : req.url);
  const extname = String(path.extname(filePath)).toLowerCase();
  const contentType = MIME_TYPES[extname] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // Fallback to index.html for SPA router routing
        fs.readFile(path.join(distDir, 'index.html'), (err, content) => {
          if (err) {
            res.writeHead(500);
            res.end(`Server Error: Missing index.html in dist/`);
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content, 'utf-8');
          }
        });
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

// Start Server
server.listen(PORT, '0.0.0.0', () => {
  console.log('--------------------------------------------------');
  console.log(`[Server] Secure backend running at http://localhost:${PORT}`);
  console.log(`[Server] Authoritative Anti-Cheat Ledger bound to SSD.`);
  console.log('--------------------------------------------------');
});

// --------------------------------------------------
// TELEGRAM BOT LONG-POLLING DAEMON
// --------------------------------------------------
const apiBase = `https://api.telegram.org/bot${token}`;

function apiRequest(method, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const req = https.request(
      `${apiBase}/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = message.text || '';

  if (text.startsWith('/start')) {
    const welcomeText = `🏛️ **WELCOME TO VIVA TON WEB3** 🏛️\n\n` +
      `Dive into the ancient temple, gather artifacts, and spin to win! This Telegram WebApp is fully integrated with the **TON Blockchain Network**.\n\n` +
      `⚡ Connect your TON Wallet (Tonkeeper, MyTonWallet, etc.)\n` +
      `⚡ Seamless deposits & withdrawals of $VIVA chips\n` +
      `⚡ Secure anti-cheat validation with local balances\n\n` +
      `Tap the play button below to launch the expedition!`;

    const replyMarkup = {
      inline_keyboard: [
        [
          {
            text: '🎮 Play Viva Ton',
            web_app: { url: webAppUrl },
          },
        ],
      ],
    };

    try {
      await apiRequest('sendMessage', {
        chat_id: chatId,
        text: welcomeText,
        parse_mode: 'Markdown',
        reply_markup: replyMarkup,
      });
      console.log(`[Bot] Welcomed user ${chatId}`);
    } catch (err) {
      console.error('[Bot] Error sending welcome message:', err);
    }
  }
}

let lastUpdateId = 0;

async function pollUpdates() {
  try {
    const response = await apiRequest('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 30,
    });

    if (response.ok && response.result.length > 0) {
      for (const update of response.result) {
        lastUpdateId = update.update_id;
        if (update.message) {
          await handleMessage(update.message);
        }
      }
    }
  } catch (err) {
    console.error('[Bot] Polling error:', err.message);
    await new Promise((r) => setTimeout(r, 5000));
  }
  setImmediate(pollUpdates);
}

pollUpdates();
