const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const sqlite3 = require("./db-adapter").verbose();
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const cron = require("node-cron");
const { Server } = require("socket.io");
const http = require("http");
const https = require("https");
const serveStatic = require("serve-static");
const fs = require("fs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const disablePushNotifications =
  String(process.env.DISABLE_PUSH_NOTIFICATIONS || "true") === "true";

// Initialize Firebase Admin
let firebaseMessaging = null;
try {
  if (disablePushNotifications) {
    console.warn(
      "Push notifications are disabled via DISABLE_PUSH_NOTIFICATIONS=true.",
    );
  } else {
    const serviceAccountPath =
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
      path.join(__dirname, "firebase-service-account.json");

    if (fs.existsSync(serviceAccountPath)) {
      const admin = require("firebase-admin");
      const serviceAccount = require(serviceAccountPath);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      firebaseMessaging = admin.messaging();
      console.log("Firebase Admin initialized for push notifications.");
    } else {
      console.warn(
        `Firebase service account not found at ${serviceAccountPath}. Push notifications are disabled.`,
      );
    }
  }
} catch (firebaseError) {
  console.warn("Firebase Admin initialization failed:", firebaseError.message);
}

const app = express();
const server = http.createServer(app);

const isProduction = process.env.NODE_ENV === "production";
const parseOrigins = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
const allowedOrigins = parseOrigins(process.env.ALLOWED_ORIGINS);
const resolvedAllowedOrigins =
  allowedOrigins.length > 0
    ? allowedOrigins
    : ["https://app.assist4web.com", "http://10.0.2.2:3000"];

const corsOptions = {
  origin(origin, callback) {
    // Allow mobile/native requests where origin may be absent.
    if (!origin) {
      return callback(null, true);
    }

    if (resolvedAllowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: false,
};

const io = new Server(server, {
  cors: corsOptions,
  transports: ["websocket", "polling"],
});

io.use((socket, next) => {
  if (!requireMobileApiKeyEnabled) {
    return next();
  }

  const authHeader = String(socket.handshake.headers["authorization"] || "");
  if (authHeader.startsWith("Basic ")) {
    return next();
  }

  const authApiKey = socket.handshake.auth?.apiKey;
  const headerApiKey = socket.handshake.headers["x-api-key"];

  if (
    authApiKey === process.env.MOBILE_API_KEY ||
    headerApiKey === process.env.MOBILE_API_KEY
  ) {
    return next();
  }

  return next(new Error("Unauthorized"));
});

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors(corsOptions));
app.use(bodyParser.json({ limit: "1mb" }));

const globalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 600 : 5000,
  standardHeaders: true,
  legacyHeaders: false,
});

const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 25 : 500,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(globalRateLimiter);

// Allow deployments behind a reverse proxy that forwards requests under /backend.
app.use((req, _res, next) => {
  if (req.url === "/backend") {
    req.url = "/";
    return next();
  }

  if (req.url.startsWith("/backend/")) {
    req.url = req.url.slice("/backend".length) || "/";
  }

  return next();
});

const parseKeyRing = () => {
  const rawKeyRing = String(process.env.CHAT_ENCRYPTION_KEYS || "").trim();
  const ringEntries = rawKeyRing
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf(":");
      if (separatorIndex <= 0) {
        return null;
      }

      const keyId = entry.slice(0, separatorIndex).trim();
      const rawSecret = entry.slice(separatorIndex + 1).trim();
      if (!keyId || !rawSecret) {
        return null;
      }

      return {
        keyId,
        key: crypto.createHash("sha256").update(rawSecret).digest(),
      };
    })
    .filter(Boolean);

  const legacySecret = String(process.env.CHAT_ENCRYPTION_KEY || "").trim();
  if (legacySecret) {
    const hasLegacy = ringEntries.some((entry) => entry.keyId === "legacy");
    if (!hasLegacy) {
      ringEntries.push({
        keyId: "legacy",
        key: crypto.createHash("sha256").update(legacySecret).digest(),
      });
    }
  }

  return ringEntries;
};

const keyRingEntries = parseKeyRing();
const keyRing = new Map(
  keyRingEntries.map((entry) => [entry.keyId, entry.key]),
);
const hasEncryptionKey = keyRing.size > 0;
const activeKeyIdFromEnv = String(
  process.env.CHAT_ENCRYPTION_ACTIVE_KEY_ID || "",
).trim();
const activeKeyId =
  (activeKeyIdFromEnv &&
    keyRing.has(activeKeyIdFromEnv) &&
    activeKeyIdFromEnv) ||
  keyRingEntries[0]?.keyId ||
  null;
const activeEncryptionKey = activeKeyId ? keyRing.get(activeKeyId) : null;

if (!activeEncryptionKey) {
  console.warn(
    "CHAT_ENCRYPTION_KEY(S) is not set. Chat messages are stored as plain text. Set CHAT_ENCRYPTION_KEYS in production.",
  );
}

const ENCRYPTED_PREFIX_V1 = "enc:v1:";
const ENCRYPTED_PREFIX_V2 = "enc:v2:";

const encryptMessage = (plainText) => {
  const value =
    typeof plainText === "string" ? plainText : String(plainText || "");

  if (!activeEncryptionKey || !activeKeyId) {
    return value;
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", activeEncryptionKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX_V2}${activeKeyId}:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
};

const decryptMessage = (storedValue) => {
  const value =
    typeof storedValue === "string" ? storedValue : String(storedValue || "");

  if (
    !value.startsWith(ENCRYPTED_PREFIX_V1) &&
    !value.startsWith(ENCRYPTED_PREFIX_V2)
  ) {
    return value;
  }

  if (!hasEncryptionKey) {
    return value;
  }

  try {
    if (value.startsWith(ENCRYPTED_PREFIX_V2)) {
      const payload = value.slice(ENCRYPTED_PREFIX_V2.length);
      const [keyId, ivBase64, tagBase64, encryptedBase64] = payload.split(":");
      if (!keyId || !ivBase64 || !tagBase64 || !encryptedBase64) {
        return "";
      }

      const key = keyRing.get(keyId);
      if (!key) {
        return "";
      }

      const iv = Buffer.from(ivBase64, "base64");
      const tag = Buffer.from(tagBase64, "base64");
      const encrypted = Buffer.from(encryptedBase64, "base64");

      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    }

    const payload = value.slice(ENCRYPTED_PREFIX_V1.length);
    const [ivBase64, tagBase64, encryptedBase64] = payload.split(":");
    if (!ivBase64 || !tagBase64 || !encryptedBase64) {
      return "";
    }

    const iv = Buffer.from(ivBase64, "base64");
    const tag = Buffer.from(tagBase64, "base64");
    const encrypted = Buffer.from(encryptedBase64, "base64");

    for (const key of keyRing.values()) {
      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([
          decipher.update(encrypted),
          decipher.final(),
        ]);
        return decrypted.toString("utf8");
      } catch (_error) {
        // Try next key.
      }
    }

    return "";
  } catch (error) {
    return "";
  }
};

const isEncryptedMessage = (value) =>
  typeof value === "string" &&
  (value.startsWith(ENCRYPTED_PREFIX_V1) ||
    value.startsWith(ENCRYPTED_PREFIX_V2));

const getEncryptedKeyId = (value) => {
  if (typeof value !== "string" || !value.startsWith(ENCRYPTED_PREFIX_V2)) {
    return null;
  }

  const payload = value.slice(ENCRYPTED_PREFIX_V2.length);
  const separatorIndex = payload.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }

  return payload.slice(0, separatorIndex);
};

const withDecryptedMessage = (row) => ({
  ...row,
  message: decryptMessage(row?.message),
});

const toPushSafeMessage = (value) => {
  const message = typeof value === "string" ? value : String(value || "");
  if (message.startsWith("e2ee:v1:")) {
    return "You have a new encrypted message from admin.";
  }

  return message || "You have a new message from admin.";
};

const validateSocketMessagePayload = (data) => {
  const message = normalizeText(data?.message);
  const rawTimestamp = Number(data?.timestamp);
  const now = Date.now();
  const timestamp =
    Number.isFinite(rawTimestamp) &&
    rawTimestamp > now - 7 * 24 * 60 * 60 * 1000
      ? Math.floor(rawTimestamp)
      : now;

  if (!message) {
    return { ok: false, error: "Message is required" };
  }

  if (message.length > 4000) {
    return { ok: false, error: "Message too long" };
  }

  return { ok: true, message, timestamp };
};

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    env: process.env.NODE_ENV || "production",
    encryptedChatStorage: Boolean(activeEncryptionKey),
    encryptionActiveKeyId: activeKeyId,
    encryptionKeyCount: keyRing.size,
  });
});

const httpsGet = (url, { timeout = 10000 } = {}) =>
  new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (parseErr) {
          reject(parseErr);
        }
      });
    });
    req.setTimeout(timeout, () => {
      req.destroy(new Error("Request timeout"));
    });
    req.on("error", reject);
  });

const WP_POSTS_URL =
  "https://assist4web.com/wp-json/wp/v2/posts?_embed=wp:featuredmedia&per_page=10";
const disableWpPolling =
  String(process.env.DISABLE_WP_POLLING || "true") === "true";

const adminUiPath = path.join(__dirname, "admin", "build");
const adminUsername = process.env.ADMIN_USERNAME || "admin";
const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
const requireMobileApiKeyEnabled = Boolean(process.env.MOBILE_API_KEY);
const enforceHttps =
  String(process.env.ENFORCE_HTTPS || (isProduction ? "true" : "false")) ===
  "true";

if (isProduction && adminUsername === "admin" && adminPassword === "admin123") {
  throw new Error(
    "Refusing to start in production with default admin credentials. Set ADMIN_USERNAME and ADMIN_PASSWORD.",
  );
}

const requireMobileApiKey = (req, res, next) => {
  if (!requireMobileApiKeyEnabled) {
    return next();
  }

  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.MOBILE_API_KEY) {
    return res.status(401).json({ error: "Invalid API key" });
  }

  return next();
};

if (enforceHttps) {
  app.use((req, res, next) => {
    const forwardedProto = String(
      req.headers["x-forwarded-proto"] || "",
    ).toLowerCase();
    if (req.secure || forwardedProto === "https") {
      return next();
    }

    if (req.method === "GET" || req.method === "HEAD") {
      const host = req.headers.host || "";
      return res.redirect(301, `https://${host}${req.originalUrl}`);
    }

    return res.status(426).json({ error: "HTTPS is required" });
  });
}

const unauthorizedAdminResponse = (res) => {
  res.set("WWW-Authenticate", 'Basic realm="Assist4Web Admin"');
  return res.status(401).send("Authentication required");
};

const requireAdmin = (req, res, next) => {
  const authorizationHeader = req.headers.authorization;

  if (!authorizationHeader || !authorizationHeader.startsWith("Basic ")) {
    return unauthorizedAdminResponse(res);
  }

  const decodedCredentials = Buffer.from(
    authorizationHeader.split(" ")[1],
    "base64",
  ).toString("utf8");
  const separatorIndex = decodedCredentials.indexOf(":");

  if (separatorIndex === -1) {
    return unauthorizedAdminResponse(res);
  }

  const username = decodedCredentials.slice(0, separatorIndex);
  const password = decodedCredentials.slice(separatorIndex + 1);

  if (username !== adminUsername || password !== adminPassword) {
    return unauthorizedAdminResponse(res);
  }

  next();
};

const generatePassword = (length = 12) => {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let generatedPassword = "";

  for (let index = 0; index < length; index += 1) {
    generatedPassword += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return generatedPassword;
};

const normalizeText = (value) =>
  typeof value === "string" ? value.trim() : "";

const buildCompletedTaskMessage = (taskNumber) => {
  const normalizedTaskNumber = Number(taskNumber);
  const safeTaskNumber =
    Number.isFinite(normalizedTaskNumber) && normalizedTaskNumber > 0
      ? Math.floor(normalizedTaskNumber)
      : 1;

  return `COMPLETED TASK\nTask #: ${safeTaskNumber}`;
};

const maskToken = (token) => {
  if (typeof token !== "string") {
    return "";
  }

  if (token.length <= 16) {
    return token;
  }

  return `${token.slice(0, 8)}...${token.slice(-8)}`;
};

const createUser = async ({
  name,
  company,
  email,
  password,
  phone = null,
  notes = null,
}) => {
  const normalizedName = normalizeText(name);
  const normalizedCompany = normalizeText(company);
  const normalizedEmail = normalizeText(email);
  const normalizedPassword = normalizeText(password);
  const normalizedPhone = phone == null ? null : normalizeText(phone);
  const normalizedNotes = notes == null ? null : normalizeText(notes);

  const resolvedPassword = normalizedPassword || generatePassword();
  const hashedPassword = await bcrypt.hash(resolvedPassword, 10);

  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO users (name, company, email, password, phone, notes) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        normalizedName,
        normalizedCompany,
        normalizedEmail,
        hashedPassword,
        normalizedPhone,
        normalizedNotes,
      ],
      function (err) {
        if (err) {
          reject(err);
          return;
        }

        resolve({ id: this.lastID, password: resolvedPassword });
      },
    );
  });
};

// Database setup
const db = new sqlite3.Database(path.join(__dirname, "data.db"), (err) => {
  if (err) {
    console.error(err.message);
  }
  console.log("Connected to the SQLite database.");
});

// Create tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    company TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    phone TEXT,
    notes TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER,
    token TEXT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id)
  )`);

  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_token_unique ON tokens(token)`,
  );

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fromUserId INTEGER,
    toUserId INTEGER,
    message TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    isRead INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (fromUserId) REFERENCES users(id),
    FOREIGN KEY (toUserId) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS admin_chat_archives (
    userId INTEGER PRIMARY KEY,
    archivedAt INTEGER NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS completed_task_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    messageId INTEGER NOT NULL UNIQUE,
    taskNumber INTEGER NOT NULL DEFAULT 1,
    previousArchivedAt INTEGER NOT NULL DEFAULT 0,
    groupedUntil INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id),
    FOREIGN KEY (messageId) REFERENCES messages(id)
  )`);

  db.all(`PRAGMA table_info(messages)`, [], (err, columns) => {
    if (err) {
      console.error("Failed to inspect messages table:", err.message);
      return;
    }

    const hasIsReadColumn = columns.some((column) => column.name === "isRead");
    if (!hasIsReadColumn) {
      db.run(
        `ALTER TABLE messages ADD COLUMN isRead INTEGER NOT NULL DEFAULT 0`,
        (alterErr) => {
          if (alterErr) {
            console.error("Failed to add isRead column:", alterErr.message);
          }
        },
      );
    }
  });

  db.all(`PRAGMA table_info(completed_task_groups)`, [], (err, columns) => {
    if (err) {
      console.error(
        "Failed to inspect completed_task_groups table:",
        err.message,
      );
      return;
    }

    const hasTaskNumberColumn = columns.some(
      (column) => column.name === "taskNumber",
    );
    if (!hasTaskNumberColumn) {
      db.run(
        `ALTER TABLE completed_task_groups ADD COLUMN taskNumber INTEGER NOT NULL DEFAULT 1`,
        (alterErr) => {
          if (alterErr) {
            console.error("Failed to add taskNumber column:", alterErr.message);
          }
        },
      );
    }
  });

  if (activeEncryptionKey) {
    db.all(`SELECT id, message FROM messages`, [], (loadErr, rows) => {
      if (loadErr) {
        console.error(
          "Failed to load messages for encryption:",
          loadErr.message,
        );
        return;
      }

      (rows || []).forEach((row) => {
        if (isEncryptedMessage(row.message)) {
          return;
        }

        const encryptedValue = encryptMessage(row.message);
        db.run(
          `UPDATE messages SET message = ? WHERE id = ?`,
          [encryptedValue, row.id],
          (updateErr) => {
            if (updateErr) {
              console.error(
                `Failed to encrypt message id ${row.id}:`,
                updateErr.message,
              );
            }
          },
        );
      });

      if ((rows || []).length > 0) {
        console.log(`Encrypted ${(rows || []).length} existing chat messages.`);
      }
    });
  }
});

// API Endpoints
app.post(
  "/register",
  requireMobileApiKey,
  authRateLimiter,
  async (req, res) => {
    const {
      name,
      company,
      email,
      password,
      phone = null,
      notes = null,
    } = req.body;

    if (!name || !company || !email) {
      return res
        .status(400)
        .json({ error: "Name, company, and email are required" });
    }

    try {
      const user = await createUser({
        name,
        company,
        email,
        password,
        phone,
        notes,
      });
      res.json({ id: user.id });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  },
);

app.post("/login", requireMobileApiKey, authRateLimiter, (req, res) => {
  const identifier = normalizeText(
    req.body.identifier || req.body.name || req.body.email,
  );
  const password = normalizeText(req.body.password);

  if (!identifier || !password) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  db.get(
    `SELECT * FROM users WHERE lower(name) = lower(?) OR lower(email) = lower(?)`,
    [identifier, identifier],
    async (err, user) => {
      if (err || !user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const safeUser = {
        id: user.id,
        name: user.name,
        company: user.company,
        email: user.email,
        phone: user.phone || null,
        notes: user.notes || null,
      };

      res.json({ user: safeUser });
    },
  );
});

app.post(
  "/forgot-password",
  requireMobileApiKey,
  authRateLimiter,
  async (req, res) => {
    const identifier = normalizeText(
      req.body.identifier || req.body.name || req.body.email,
    );

    if (!identifier) {
      return res.status(400).json({ error: "Name or email is required" });
    }

    db.get(
      `SELECT id FROM users WHERE lower(name) = lower(?) OR lower(email) = lower(?)`,
      [identifier, identifier],
      async (err, user) => {
        if (err) {
          return res.status(400).json({ error: err.message });
        }

        if (!user) {
          return res.status(404).json({ error: "User not found" });
        }

        try {
          const temporaryPassword = generatePassword(10);
          const hashedPassword = await bcrypt.hash(temporaryPassword, 10);

          db.run(
            `UPDATE users SET password = ? WHERE id = ?`,
            [hashedPassword, user.id],
            function (updateErr) {
              if (updateErr) {
                return res.status(400).json({ error: updateErr.message });
              }

              if (this.changes === 0) {
                return res.status(404).json({ error: "User not found" });
              }

              res.json({
                message: "Password reset successful",
                temporaryPassword,
              });
            },
          );
        } catch (hashErr) {
          res.status(500).json({ error: "Failed to reset password" });
        }
      },
    );
  },
);

app.post(
  "/token/register",
  requireMobileApiKey,
  authRateLimiter,
  (req, res) => {
    const { userId, token } = req.body;

    if (!Number.isInteger(Number(userId)) || Number(userId) < 1 || !token) {
      return res
        .status(400)
        .json({ error: "Valid userId and token are required" });
    }

    db.run(
      `INSERT INTO tokens (userId, token) VALUES (?, ?) ON CONFLICT(token) DO UPDATE SET userId = excluded.userId`,
      [Number(userId), token],
      function (err) {
        if (err) {
          return res.status(400).json({ error: err.message });
        }

        res.json({ id: this.lastID || null, userId: Number(userId) });
      },
    );
  },
);

const sendPushToUser = (userId, message) => {
  if (!firebaseMessaging) {
    return;
  }

  const pushSafeMessage = toPushSafeMessage(message);

  db.get(
    `SELECT COUNT(*) as count FROM messages WHERE toUserId = ? AND fromUserId = 0 AND isRead = 0`,
    [userId],
    (countErr, countRow) => {
      const badgeCount = countErr ? 1 : Number(countRow?.count || 1);
      sendPushWithBadge(userId, pushSafeMessage, badgeCount);
    },
  );
};

const sendPushWithBadge = (userId, message, badgeCount) => {
  db.all(
    `SELECT token FROM tokens WHERE userId = ?`,
    [userId],
    async (tokenErr, rows) => {
      if (tokenErr) {
        console.warn("Failed to load tokens for push:", tokenErr.message);
        return;
      }

      const tokens = (rows || [])
        .map((row) => row.token)
        .filter((token) => typeof token === "string" && token.length > 0);

      if (tokens.length === 0) {
        return;
      }

      try {
        const response = await firebaseMessaging.sendEachForMulticast({
          tokens,
          notification: {
            title: "New message",
            body: message || "You have a new message from admin.",
          },
          data: {
            type: "chat_message",
            userId: String(userId),
            message: String(message || "You have a new message from admin."),
          },
          android: {
            priority: "high",
            notification: {
              channelId: "chat_messages",
              notificationCount: badgeCount,
              sound: "default",
              defaultVibrateTimings: true,
            },
          },
          apns: {
            headers: { "apns-priority": "10" },
            payload: {
              aps: {
                sound: "default",
                badge: badgeCount,
              },
            },
          },
        });

        const invalidTokens = [];
        response.responses.forEach((result, index) => {
          if (!result.success) {
            const errorCode = result.error?.code || "";
            if (
              errorCode.includes("registration-token-not-registered") ||
              errorCode.includes("invalid-registration-token")
            ) {
              invalidTokens.push(tokens[index]);
            }
          }
        });

        if (invalidTokens.length > 0) {
          const placeholders = invalidTokens.map(() => "?").join(",");
          db.run(
            `DELETE FROM tokens WHERE token IN (${placeholders})`,
            invalidTokens,
            (cleanupErr) => {
              if (cleanupErr) {
                console.warn(
                  "Failed to cleanup invalid tokens:",
                  cleanupErr.message,
                );
              }
            },
          );
        }
      } catch (pushErr) {
        console.warn("FCM send failed:", pushErr.message);
      }
    },
  );
};

const sendPushForNewPost = async (post) => {
  if (!firebaseMessaging) {
    return;
  }

  const postTitleRaw =
    typeof post?.title?.rendered === "string"
      ? post.title.rendered
      : "New post";
  const postTitle = postTitleRaw.replace(/<[^>]*>/g, "").trim() || "New post";
  const postId = post?.id != null ? String(post.id) : "";

  db.all(`SELECT DISTINCT token FROM tokens`, [], async (tokenErr, rows) => {
    if (tokenErr) {
      console.warn(
        "Failed to load tokens for post notification:",
        tokenErr.message,
      );
      return;
    }

    const tokens = (rows || [])
      .map((row) => row.token)
      .filter((token) => typeof token === "string" && token.length > 0);

    if (tokens.length === 0) {
      return;
    }

    try {
      const response = await firebaseMessaging.sendEachForMulticast({
        tokens,
        notification: {
          title: "New post available",
          body: postTitle,
        },
        data: {
          type: "new_post",
          postId,
          title: postTitle,
        },
        android: {
          priority: "high",
          notification: {
            channelId: "chat_messages",
            sound: "default",
            defaultVibrateTimings: true,
          },
        },
        apns: {
          headers: { "apns-priority": "10" },
          payload: {
            aps: {
              sound: "default",
            },
          },
        },
      });

      const invalidTokens = [];
      response.responses.forEach((result, index) => {
        if (!result.success) {
          const errorCode = result.error?.code || "";
          if (
            errorCode.includes("registration-token-not-registered") ||
            errorCode.includes("invalid-registration-token")
          ) {
            invalidTokens.push(tokens[index]);
          }
        }
      });

      if (invalidTokens.length > 0) {
        const placeholders = invalidTokens.map(() => "?").join(",");
        db.run(
          `DELETE FROM tokens WHERE token IN (${placeholders})`,
          invalidTokens,
          (cleanupErr) => {
            if (cleanupErr) {
              console.warn(
                "Failed to cleanup invalid post-notification tokens:",
                cleanupErr.message,
              );
            }
          },
        );
      }
    } catch (pushErr) {
      console.warn("FCM new-post send failed:", pushErr.message);
    }
  });
};

let lastSeenWpPostId = null;

const checkForNewWebsitePosts = async () => {
  try {
    const response = await httpsGet(WP_POSTS_URL);

    if (response.status < 200 || response.status >= 300) {
      console.warn(
        "Failed to fetch website posts for polling:",
        response.status,
      );
      return;
    }

    const posts = response.data;
    if (!Array.isArray(posts) || posts.length === 0) {
      return;
    }

    const newestPost = posts[0];
    if (!newestPost?.id) {
      return;
    }

    if (lastSeenWpPostId == null) {
      lastSeenWpPostId = newestPost.id;
      return;
    }

    if (newestPost.id === lastSeenWpPostId) {
      return;
    }

    const unseenPosts = posts.filter(
      (post) => Number(post?.id) > Number(lastSeenWpPostId),
    );

    if (unseenPosts.length > 0) {
      const sortedUnseenPosts = unseenPosts.sort(
        (a, b) => Number(a.id) - Number(b.id),
      );
      for (const post of sortedUnseenPosts) {
        await sendPushForNewPost(post);
      }
    } else {
      await sendPushForNewPost(newestPost);
    }

    lastSeenWpPostId = newestPost.id;
  } catch (error) {
    console.warn("New post polling failed:", error.message || error);
  }
};

app.get("/posts", async (req, res) => {
  try {
    // Include embedded media to expose featured image URLs.
    const response = await httpsGet(WP_POSTS_URL);

    if (response.status < 200 || response.status >= 300) {
      return res
        .status(response.status)
        .json({ error: "Failed to fetch posts" });
    }

    const posts = response.data;
    res.json(posts);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch posts" });
  }
});

app.get("/posts/:id", async (req, res) => {
  const postId = Number(req.params.id);

  if (!Number.isInteger(postId) || postId < 1) {
    return res.status(400).json({ error: "Valid post id is required" });
  }

  try {
    const response = await httpsGet(
      `https://assist4web.com/wp-json/wp/v2/posts/${postId}?_embed=wp:featuredmedia`,
    );

    if (response.status < 200 || response.status >= 300) {
      return res
        .status(response.status)
        .json({ error: "Failed to fetch post" });
    }

    const post = response.data;
    return res.json(post);
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch post" });
  }
});

// Admin routes
app.post("/administrator/users", requireAdmin, async (req, res) => {
  const {
    name,
    company,
    email,
    password,
    phone = null,
    notes = null,
  } = req.body;

  if (!name || !company || !email) {
    return res
      .status(400)
      .json({ error: "Name, company, and email are required" });
  }

  try {
    const user = await createUser({
      name,
      company,
      email,
      password,
      phone,
      notes,
    });
    res.status(201).json({ id: user.id, password: user.password });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/administrator/crypto/rotate-chat-keys", requireAdmin, (req, res) => {
  if (!activeEncryptionKey || !activeKeyId) {
    return res.status(400).json({
      error: "Active chat encryption key is not configured",
    });
  }

  const requestedLimit = Number(req.body?.limit || 500);
  const limit =
    Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 5000)
      : 500;
  const idAfter = Number(req.body?.idAfter || 0);
  const safeIdAfter = Number.isInteger(idAfter) && idAfter >= 0 ? idAfter : 0;

  db.all(
    `SELECT id, message FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?`,
    [safeIdAfter, limit],
    (loadErr, rows) => {
      if (loadErr) {
        return res.status(400).json({ error: loadErr.message });
      }

      const records = rows || [];
      let processed = 0;
      let rotated = 0;
      let skipped = 0;
      let failed = 0;

      const finalize = () => {
        const lastId =
          records.length > 0 ? records[records.length - 1].id : safeIdAfter;
        res.json({
          processed,
          rotated,
          skipped,
          failed,
          lastId,
          hasMore: records.length === limit,
          activeKeyId,
        });
      };

      if (records.length === 0) {
        return finalize();
      }

      records.forEach((row) => {
        processed += 1;
        const currentMessage = String(row.message || "");
        const currentKeyId = getEncryptedKeyId(currentMessage);

        if (currentKeyId === activeKeyId) {
          skipped += 1;
          if (processed === records.length) {
            finalize();
          }
          return;
        }

        const decrypted = decryptMessage(currentMessage);
        if (!decrypted && isEncryptedMessage(currentMessage)) {
          failed += 1;
          if (processed === records.length) {
            finalize();
          }
          return;
        }

        const encryptedValue = encryptMessage(decrypted || currentMessage);
        db.run(
          `UPDATE messages SET message = ? WHERE id = ?`,
          [encryptedValue, row.id],
          (updateErr) => {
            if (updateErr) {
              failed += 1;
            } else {
              rotated += 1;
            }

            if (processed === records.length) {
              finalize();
            }
          },
        );
      });
    },
  );
});

app.get("/administrator/users", requireAdmin, (req, res) => {
  db.all(
    `SELECT id, name, company, email, phone, notes FROM users`,
    [],
    (err, rows) => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      res.json(rows);
    },
  );
});

app.get("/administrator/messages/history/:userId", requireAdmin, (req, res) => {
  const userId = Number(req.params.userId);

  if (!Number.isInteger(userId) || userId < 1) {
    return res.status(400).json({ error: "Valid user id is required" });
  }

  db.get(
    `SELECT archivedAt FROM admin_chat_archives WHERE userId = ?`,
    [userId],
    (archiveErr, archiveRow) => {
      if (archiveErr) {
        return res.status(400).json({ error: archiveErr.message });
      }

      const archivedAt = Number(archiveRow?.archivedAt || 0);

      db.all(
        `SELECT * FROM messages
         WHERE (fromUserId = ? OR toUserId = ?)
           AND timestamp > ?
         ORDER BY timestamp ASC, id ASC`,
        [userId, userId, archivedAt],
        (historyErr, rows) => {
          if (historyErr) {
            return res.status(400).json({ error: historyErr.message });
          }

          res.json((rows || []).map(withDecryptedMessage));
        },
      );
    },
  );
});

app.delete(
  "/administrator/messages/archived/:userId",
  requireAdmin,
  (req, res) => {
    const userId = Number(req.params.userId);

    if (!Number.isInteger(userId) || userId < 1) {
      return res.status(400).json({ error: "Valid user id is required" });
    }

    db.get(
      `SELECT archivedAt FROM admin_chat_archives WHERE userId = ?`,
      [userId],
      (archiveErr, archiveRow) => {
        if (archiveErr) {
          return res.status(400).json({ error: archiveErr.message });
        }

        if (!archiveRow) {
          return res
            .status(400)
            .json({ error: "No archived messages found for this user" });
        }

        const archivedAt = Number(archiveRow.archivedAt || 0);

        db.run(
          `DELETE FROM messages
           WHERE (fromUserId = ? OR toUserId = ?)
             AND timestamp <= ?`,
          [userId, userId, archivedAt],
          function (deleteErr) {
            if (deleteErr) {
              return res.status(400).json({ error: deleteErr.message });
            }

            const deletedCount = this.changes;

            db.run(
              `DELETE FROM admin_chat_archives WHERE userId = ?`,
              [userId],
              (resetErr) => {
                if (resetErr) {
                  return res.status(400).json({ error: resetErr.message });
                }

                db.run(
                  `DELETE FROM completed_task_groups WHERE userId = ?`,
                  [userId],
                  (groupErr) => {
                    if (groupErr) {
                      return res.status(400).json({ error: groupErr.message });
                    }

                    res.json({ userId, deletedMessages: deletedCount });
                  },
                );
              },
            );
          },
        );
      },
    );
  },
);

app.post(
  "/administrator/messages/archive/:userId",
  requireAdmin,
  (req, res) => {
    const userId = Number(req.params.userId);

    if (!Number.isInteger(userId) || userId < 1) {
      return res.status(400).json({ error: "Valid user id is required" });
    }

    const archivedAt = Date.now();

    db.run(
      `INSERT INTO admin_chat_archives (userId, archivedAt) VALUES (?, ?)
     ON CONFLICT(userId) DO UPDATE SET archivedAt = excluded.archivedAt`,
      [userId, archivedAt],
      function (err) {
        if (err) {
          return res.status(400).json({ error: err.message });
        }

        res.json({ userId, archivedAt });
      },
    );
  },
);

app.post(
  "/administrator/messages/complete-task/:userId",
  requireAdmin,
  (req, res) => {
    const userId = Number(req.params.userId);

    if (!Number.isInteger(userId) || userId < 1) {
      return res.status(400).json({ error: "Valid user id is required" });
    }

    db.get(
      `SELECT archivedAt FROM admin_chat_archives WHERE userId = ?`,
      [userId],
      (archiveErr, archiveRow) => {
        if (archiveErr) {
          return res.status(400).json({ error: archiveErr.message });
        }

        const archivedAt = Number(archiveRow?.archivedAt || 0);

        db.all(
          `SELECT * FROM messages
         WHERE (fromUserId = ? OR toUserId = ?)
           AND timestamp > ?
         ORDER BY timestamp ASC, id ASC`,
          [userId, userId, archivedAt],
          (historyErr, rows) => {
            if (historyErr) {
              return res.status(400).json({ error: historyErr.message });
            }

            if (!rows || rows.length === 0) {
              return res
                .status(400)
                .json({ error: "No messages available to group" });
            }

            db.get(
              `SELECT COALESCE(MAX(taskNumber), 0) AS maxTaskNumber
               FROM completed_task_groups
               WHERE userId = ?`,
              [userId],
              (taskNumberErr, taskNumberRow) => {
                if (taskNumberErr) {
                  return res.status(400).json({ error: taskNumberErr.message });
                }

                const nextTaskNumber =
                  Number(taskNumberRow?.maxTaskNumber || 0) + 1;
                const timestamp = Date.now();
                const completedTaskMessage =
                  buildCompletedTaskMessage(nextTaskNumber);
                const encryptedCompletedTaskMessage =
                  encryptMessage(completedTaskMessage);

                db.run(
                  `INSERT INTO messages (fromUserId, toUserId, message, timestamp, isRead) VALUES (?, ?, ?, ?, ?)`,
                  [0, userId, encryptedCompletedTaskMessage, timestamp, 0],
                  function (insertErr) {
                    if (insertErr) {
                      return res.status(400).json({ error: insertErr.message });
                    }

                    const messageId = this.lastID;
                    const archiveCutoff = timestamp - 1;

                    db.run(
                      `INSERT INTO admin_chat_archives (userId, archivedAt) VALUES (?, ?)
                 ON CONFLICT(userId) DO UPDATE SET archivedAt = excluded.archivedAt`,
                      [userId, archiveCutoff],
                      (archiveUpdateErr) => {
                        if (archiveUpdateErr) {
                          return res
                            .status(400)
                            .json({ error: archiveUpdateErr.message });
                        }

                        db.run(
                          `INSERT INTO completed_task_groups (userId, messageId, taskNumber, previousArchivedAt, groupedUntil, createdAt)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                          [
                            userId,
                            messageId,
                            nextTaskNumber,
                            archivedAt,
                            archiveCutoff,
                            timestamp,
                          ],
                          (groupErr) => {
                            if (groupErr) {
                              return res
                                .status(400)
                                .json({ error: groupErr.message });
                            }

                            res.json({
                              userId,
                              groupedMessages: rows.length,
                              message: {
                                id: messageId,
                                fromUserId: 0,
                                toUserId: userId,
                                message: completedTaskMessage,
                                timestamp,
                              },
                            });

                            io.to(`user-${userId}`).emit(
                              "taskCompletedGroupingUpdated",
                              {
                                userId,
                                groupedUntil: archiveCutoff,
                                message: {
                                  id: messageId,
                                  message: completedTaskMessage,
                                  timestamp,
                                },
                              },
                            );
                          },
                        );
                      },
                    );
                  },
                );
              },
            );
          },
        );
      },
    );
  },
);

app.post(
  "/administrator/messages/reopen-completed-task/:userId/:messageId",
  requireAdmin,
  (req, res) => {
    const userId = Number(req.params.userId);
    const messageId = Number(req.params.messageId);

    if (!Number.isInteger(userId) || userId < 1) {
      return res.status(400).json({ error: "Valid user id is required" });
    }

    if (!Number.isInteger(messageId) || messageId < 1) {
      return res.status(400).json({ error: "Valid message id is required" });
    }

    db.get(
      `SELECT previousArchivedAt FROM completed_task_groups WHERE userId = ? AND messageId = ?`,
      [userId, messageId],
      (groupErr, groupRow) => {
        if (groupErr) {
          return res.status(400).json({ error: groupErr.message });
        }

        // No group record (e.g. created before tracking table existed) –
        // fall back: reset archive to 0 and remove the Completed Task message.
        const previousArchivedAt = groupRow
          ? Number(groupRow.previousArchivedAt || 0)
          : 0;

        db.run(
          `INSERT INTO admin_chat_archives (userId, archivedAt) VALUES (?, ?)
         ON CONFLICT(userId) DO UPDATE SET archivedAt = excluded.archivedAt`,
          [userId, previousArchivedAt],
          (archiveErr) => {
            if (archiveErr) {
              return res.status(400).json({ error: archiveErr.message });
            }

            db.run(
              `DELETE FROM messages WHERE id = ? AND fromUserId = 0 AND toUserId = ?`,
              [messageId, userId],
              (deleteMessageErr) => {
                if (deleteMessageErr) {
                  return res
                    .status(400)
                    .json({ error: deleteMessageErr.message });
                }

                db.run(
                  `DELETE FROM completed_task_groups WHERE userId = ? AND messageId = ?`,
                  [userId, messageId],
                  (deleteGroupErr) => {
                    if (deleteGroupErr) {
                      return res
                        .status(400)
                        .json({ error: deleteGroupErr.message });
                    }

                    db.all(
                      `SELECT * FROM messages
                     WHERE (fromUserId = ? OR toUserId = ?)
                       AND timestamp > ?
                     ORDER BY timestamp ASC, id ASC`,
                      [userId, userId, previousArchivedAt],
                      (historyErr, rows) => {
                        if (historyErr) {
                          return res
                            .status(400)
                            .json({ error: historyErr.message });
                        }

                        res.json({
                          userId,
                          messages: (rows || []).map(withDecryptedMessage),
                        });
                      },
                    );
                  },
                );
              },
            );
          },
        );
      },
    );
  },
);

app.get("/administrator/tokens", requireAdmin, (req, res) => {
  const includeRaw = req.query.includeRaw === "true";

  db.all(
    `SELECT t.id, t.userId, t.token, u.name, u.email
     FROM tokens t
     LEFT JOIN users u ON u.id = t.userId
     ORDER BY t.userId ASC, t.id DESC`,
    [],
    (err, rows) => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }

      const summaryByUser = {};
      const tokens = rows.map((row) => {
        if (!summaryByUser[row.userId]) {
          summaryByUser[row.userId] = {
            userId: row.userId,
            name: row.name || null,
            email: row.email || null,
            tokenCount: 0,
          };
        }

        summaryByUser[row.userId].tokenCount += 1;

        return {
          id: row.id,
          userId: row.userId,
          name: row.name || null,
          email: row.email || null,
          token: includeRaw ? row.token : maskToken(row.token),
        };
      });

      res.json({
        totalTokens: tokens.length,
        users: Object.values(summaryByUser),
        tokens,
      });
    },
  );
});

app.put("/administrator/users/:id", requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  const name = normalizeText(req.body.name);
  const company = normalizeText(req.body.company);
  const email = normalizeText(req.body.email);
  const phone = req.body.phone == null ? null : normalizeText(req.body.phone);
  const notes = req.body.notes == null ? null : normalizeText(req.body.notes);
  const password = normalizeText(req.body.password);

  if (!Number.isInteger(userId) || userId < 1) {
    return res.status(400).json({ error: "Valid user id is required" });
  }

  if (!name || !company || !email) {
    return res
      .status(400)
      .json({ error: "Name, company, and email are required" });
  }

  const finalizeUpdate = (hashedPassword) => {
    const shouldUpdatePassword = Boolean(hashedPassword);
    const sql = shouldUpdatePassword
      ? `UPDATE users SET name = ?, company = ?, email = ?, phone = ?, notes = ?, password = ? WHERE id = ?`
      : `UPDATE users SET name = ?, company = ?, email = ?, phone = ?, notes = ? WHERE id = ?`;
    const params = shouldUpdatePassword
      ? [name, company, email, phone, notes, hashedPassword, userId]
      : [name, company, email, phone, notes, userId];

    db.run(sql, params, function (err) {
      if (err) {
        return res.status(400).json({ error: err.message });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({ id: userId });
    });
  };

  if (typeof password === "string" && password.length > 0) {
    bcrypt
      .hash(password, 10)
      .then((hashedPassword) => {
        finalizeUpdate(hashedPassword);
      })
      .catch((err) => {
        res.status(400).json({ error: err.message });
      });
    return;
  }

  finalizeUpdate(null);
});

app.delete("/administrator/users/:id", requireAdmin, (req, res) => {
  const userId = Number(req.params.id);

  if (!Number.isInteger(userId) || userId < 1) {
    return res.status(400).json({ error: "Valid user id is required" });
  }

  db.run(
    `DELETE FROM messages WHERE fromUserId = ? OR toUserId = ?`,
    [userId, userId],
    (messageError) => {
      if (messageError) {
        return res.status(400).json({ error: messageError.message });
      }

      db.run(`DELETE FROM tokens WHERE userId = ?`, [userId], (tokenError) => {
        if (tokenError) {
          return res.status(400).json({ error: tokenError.message });
        }

        db.run(
          `DELETE FROM users WHERE id = ?`,
          [userId],
          function (userError) {
            if (userError) {
              return res.status(400).json({ error: userError.message });
            }

            if (this.changes === 0) {
              return res.status(404).json({ error: "User not found" });
            }

            res.status(204).send();
          },
        );
      });
    },
  );
});

app.get("/messages/history/:userId", requireMobileApiKey, (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId < 1) {
    return res.status(400).json({ error: "Valid user id is required" });
  }

  db.get(
    `SELECT archivedAt FROM admin_chat_archives WHERE userId = ?`,
    [userId],
    (archiveErr, archiveRow) => {
      if (archiveErr) {
        return res.status(400).json({ error: archiveErr.message });
      }

      const archivedAt = Number(archiveRow?.archivedAt || 0);

      db.all(
        `SELECT * FROM messages
         WHERE (fromUserId = ? OR toUserId = ?)
           AND timestamp > ?
         ORDER BY timestamp ASC, id ASC`,
        [userId, userId, archivedAt],
        (err, rows) => {
          if (err) {
            return res.status(400).json({ error: err.message });
          }

          res.json((rows || []).map(withDecryptedMessage));
        },
      );
    },
  );
});

app.get("/messages/unread/:userId", requireMobileApiKey, (req, res) => {
  const userId = Number(req.params.userId);

  if (!Number.isInteger(userId) || userId < 1) {
    return res.status(400).json({ error: "Valid user id is required" });
  }

  db.get(
    `SELECT COUNT(*) as count FROM messages WHERE toUserId = ? AND fromUserId = 0 AND isRead = 0`,
    [userId],
    (err, row) => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }

      res.json({ count: row?.count || 0 });
    },
  );
});

app.post("/messages/read/:userId", requireMobileApiKey, (req, res) => {
  const userId = Number(req.params.userId);

  if (!Number.isInteger(userId) || userId < 1) {
    return res.status(400).json({ error: "Valid user id is required" });
  }

  db.run(
    `UPDATE messages SET isRead = 1 WHERE toUserId = ? AND fromUserId = 0 AND isRead = 0`,
    [userId],
    function (err) {
      if (err) {
        return res.status(400).json({ error: err.message });
      }

      res.json({ updated: this.changes || 0 });
    },
  );
});

// Socket.IO
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("userJoin", (userId) => {
    const safeUserId = Number(userId);
    if (!Number.isInteger(safeUserId) || safeUserId < 1) {
      return;
    }
    socket.join(`user-${safeUserId}`);
  });

  socket.on("adminJoin", () => {
    socket.join("admin");
  });

  socket.on("sendToAdmin", (data) => {
    const safeUserId = Number(data?.userId);
    if (!Number.isInteger(safeUserId) || safeUserId < 1) {
      return;
    }

    const validation = validateSocketMessagePayload(data);
    if (!validation.ok) {
      return;
    }

    const { message, timestamp } = validation;
    db.run(
      `INSERT INTO messages (fromUserId, toUserId, message, timestamp) VALUES (?, ?, ?, ?)`,
      [safeUserId, 0, encryptMessage(message), timestamp],
    ); // 0 for admin
    io.to("admin").emit("receiveFromUser", {
      message,
      timestamp,
      userId: safeUserId,
    });
  });

  socket.on("sendToUser", (data) => {
    const safeUserId = Number(data?.userId);
    if (!Number.isInteger(safeUserId) || safeUserId < 1) {
      return;
    }

    const validation = validateSocketMessagePayload(data);
    if (!validation.ok) {
      return;
    }

    const { message, timestamp } = validation;
    const adminId = Number.isInteger(Number(data?.adminId))
      ? Number(data.adminId)
      : 0;

    db.run(
      `INSERT INTO messages (fromUserId, toUserId, message, timestamp, isRead) VALUES (?, ?, ?, ?, ?)`,
      [0, safeUserId, encryptMessage(message), timestamp, 0],
    ); // 0 for admin
    io.to(`user-${safeUserId}`).emit("receiveFromAdmin", {
      message,
      timestamp,
      adminId,
    });
    sendPushToUser(safeUserId, message);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// Polling for new posts
if (disableWpPolling) {
  console.warn("WordPress polling is disabled via DISABLE_WP_POLLING=true.");
} else {
  cron.schedule("*/5 * * * *", async () => {
    await checkForNewWebsitePosts();
  });

  checkForNewWebsitePosts();
}

// Serve admin UI
app.use("/administrator", requireAdmin, serveStatic(adminUiPath));

app.use((err, req, res, next) => {
  if (err?.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  console.error("Unhandled server error:", err?.message || err);
  return res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
