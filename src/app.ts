import { Telegraf, Context } from "telegraf";
import { InlineKeyboardButton } from "telegraf/types";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import mongoose from "mongoose";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const SEND_DELAY_MS = parseInt(process.env.SEND_DELAY_MS || "3000", 10);
const ADMIN_ID = parseInt(process.env.ADMIN_ID || "0", 10);
const PORT = parseInt(process.env.PORT || "3000", 10);
const BACKUP_USER_ID = parseInt(process.env.BACKUP_USER_ID || "0", 10);
const ENABLE_BACKUP = process.env.ENABLE_BACKUP === "true";
const UNAUTHORIZED_MEDIA_BAN_THRESHOLD = parseInt(
  process.env.UNAUTHORIZED_MEDIA_BAN_THRESHOLD || "8",
  10,
);
const UNAUTHORIZED_MEDIA_WINDOW_MS = parseInt(
  process.env.UNAUTHORIZED_MEDIA_WINDOW_MS || "600000",
  10,
);
const MONGO_URI = process.env.MONGO_URI;
const DATA_FILE = path.join(process.cwd(), "data.json");
const DEFAULT_DATA: UserData[] = [
  {
    userId: 7630384575,
    targetId: 8310845113,
    createdAt: "2026-01-29T05:59:12.953Z",
  },
  {
    userId: 7656695344,
    targetId: 7776283215,
    createdAt: "2026-01-29T06:29:58.638Z",
  },
];

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN not set in .env file");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Connect to MongoDB (non-blocking)
connectMongo();

// Bot power state
let botEnabled = true;
let botReady = false;

// In-memory rate limiting
const userLastSent = new Map<number, number>();
const pendingInviteUsers = new Set<number>();
const invalidInviteWarnedUsers = new Set<number>();
const unauthorizedMediaAttempts = new Map<
  number,
  { count: number; firstAttemptAt: number }
>();

// Store media groups temporarily
const mediaGroupBuffer = new Map<string, any[]>();
const groupTimeouts = new Map<string, NodeJS.Timeout>();

// Load/save user targets from JSON
interface UserData {
  userId: number;
  targetId: number;
  createdAt: string;
}

// MongoDB (users + targets)
interface UserDoc {
  userId: number;
  firstName?: string;
  username?: string;
  targetId?: number;
  isAdmin?: boolean;
  isVerified?: boolean;
  isBanned?: boolean;
  bannedAt?: Date;
  banReason?: string;
  inviteCodeUsed?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface InviteCodeDoc {
  code: string;
  isActive: boolean;
  usesCount: number;
  usedBy: number[];
  createdBy?: number;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface ForwardLogDoc {
  sourceUserId: number;
  targetUserId: number;
  targetChatId: number;
  targetMessageId: number;
  messageType: string;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new mongoose.Schema<UserDoc>(
  {
    userId: { type: Number, required: true, unique: true },
    firstName: { type: String },
    username: { type: String },
    targetId: { type: Number },
    isAdmin: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
    isBanned: { type: Boolean, default: false },
    bannedAt: { type: Date },
    banReason: { type: String },
    inviteCodeUsed: { type: String },
  },
  { timestamps: true },
);

const inviteCodeSchema = new mongoose.Schema<InviteCodeDoc>(
  {
    code: { type: String, required: true, unique: true },
    isActive: { type: Boolean, default: true },
    usesCount: { type: Number, default: 0 },
    usedBy: { type: [Number], default: [] },
    createdBy: { type: Number },
    lastUsedAt: { type: Date },
  },
  { timestamps: true },
);

const forwardLogSchema = new mongoose.Schema<ForwardLogDoc>(
  {
    sourceUserId: { type: Number, required: true },
    targetUserId: { type: Number, required: true },
    targetChatId: { type: Number, required: true },
    targetMessageId: { type: Number, required: true },
    messageType: { type: String, required: true },
  },
  { timestamps: true },
);

forwardLogSchema.index(
  { targetChatId: 1, targetMessageId: 1 },
  { unique: true },
);

const UserModel = mongoose.model<UserDoc>("User", userSchema);
const InviteCodeModel = mongoose.model<InviteCodeDoc>(
  "InviteCode",
  inviteCodeSchema,
);
const ForwardLogModel = mongoose.model<ForwardLogDoc>(
  "ForwardLog",
  forwardLogSchema,
);
let mongoReady = false;

async function connectMongo(): Promise<void> {
  if (!MONGO_URI) {
    console.warn("MONGO_URI not set. Using local JSON fallback.");
    return;
  }

  try {
    await mongoose.connect(MONGO_URI);
    mongoReady = true;
    console.log("✅ Connected to MongoDB");
  } catch (e) {
    console.error("❌ MongoDB connection failed:", e);
    mongoReady = false;
  }
}

function loadData(): UserData[] {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const content = fs.readFileSync(DATA_FILE, "utf-8");
      return JSON.parse(content);
    }
  } catch (e) {
    console.warn("Failed to load data.json:", e);
  }
  return DEFAULT_DATA;
}

function saveData(data: UserData[]): void {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Failed to save data.json:", e);
  }
}

function normalizeInviteCode(code: string): string {
  return code.trim().toUpperCase();
}

function getBackupTargetId(): number | null {
  if (!ENABLE_BACKUP) return null;
  if (!BACKUP_USER_ID || isNaN(BACKUP_USER_ID)) return null;
  return BACKUP_USER_ID;
}

function buildWelcomeMessage(): string {
  const backupNotice = getBackupTargetId()
    ? "\n\nℹ️ Note: This bot has an enabled backup destination configured by admin."
    : "";

  return (
    "Welcome! 👋\n\n" +
    "Use /set_target <user_id> to specify who receives your media.\n" +
    "Use /get_target to see your current target.\n" +
    "Use /change_target <user_id> to update it.\n" +
    "Use /help for more info." +
    backupNotice
  );
}

async function syncUserProfile(
  ctx: Context,
  options?: {
    verify?: boolean;
    inviteCodeUsed?: string;
    forceAdmin?: boolean;
    clearBan?: boolean;
  },
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId || !mongoReady) return;

  const { first_name, username } = ctx.from;
  const update: Partial<UserDoc> = {
    firstName: first_name,
    username,
  };

  if (typeof options?.verify === "boolean") {
    update.isVerified = options.verify;
  }

  if (options?.inviteCodeUsed) {
    update.inviteCodeUsed = options.inviteCodeUsed;
  }

  if (options?.forceAdmin) {
    update.isAdmin = true;
  }

  if (options?.clearBan) {
    update.isBanned = false;
    update.bannedAt = undefined;
    update.banReason = undefined;
  }

  const mongoUpdate: {
    $set: Partial<UserDoc>;
    $unset?: Record<string, number>;
  } = { $set: update };

  if (options?.clearBan) {
    mongoUpdate.$unset = {
      bannedAt: 1,
      banReason: 1,
    };
  }

  await UserModel.updateOne({ userId }, mongoUpdate, { upsert: true });
}

async function removeUserFromData(userId: number): Promise<void> {
  const data = loadData();
  const filtered = data.filter(
    (entry) => entry.userId !== userId && entry.targetId !== userId,
  );

  if (filtered.length !== data.length) {
    saveData(filtered);
  }
}

async function clearTargetsPointingToUser(userId: number): Promise<void> {
  if (mongoReady) {
    await UserModel.updateMany(
      { targetId: userId },
      { $unset: { targetId: 1 } },
    );
    return;
  }

  await removeUserFromData(userId);
}

async function isBannedUser(userId: number): Promise<boolean> {
  if (mongoReady) {
    const user = await UserModel.findOne({ userId }).lean();
    return user?.isBanned ?? false;
  }

  return false;
}

async function findTarget(userId: number): Promise<number | null> {
  if (mongoReady) {
    const user = await UserModel.findOne({ userId }).lean();
    return user?.targetId ?? null;
  }

  const data = loadData();
  const user = data.find((u) => u.userId === userId);
  return user?.targetId ?? null;
}

async function setTarget(userId: number, targetId: number): Promise<void> {
  if (mongoReady) {
    await UserModel.updateOne(
      { userId },
      { $set: { targetId } },
      { upsert: true },
    );
    return;
  }

  const data = loadData();
  const existing = data.findIndex((u) => u.userId === userId);
  if (existing >= 0) {
    data[existing].targetId = targetId;
  } else {
    data.push({
      userId,
      targetId,
      createdAt: new Date().toISOString(),
    });
  }
  saveData(data);
}

// Get all unique user IDs from data
async function getAllUsers(): Promise<number[]> {
  if (mongoReady) {
    const users = await UserModel.find().lean();
    const userIds = new Set<number>();
    users.forEach((entry) => {
      userIds.add(entry.userId);
      if (entry.targetId) userIds.add(entry.targetId);
    });
    return Array.from(userIds);
  }

  const data = loadData();
  const userIds = new Set<number>();
  data.forEach((entry) => {
    userIds.add(entry.userId);
    userIds.add(entry.targetId);
  });
  return Array.from(userIds);
}

async function isAuthorizedUser(userId: number): Promise<boolean> {
  if (userId === ADMIN_ID) return true;

  if (mongoReady) {
    const user = await UserModel.findOne({ userId }).lean();
    if (!user) return false;

    if (user.isBanned) return false;

    return !!(
      user.isAdmin ||
      user.isVerified ||
      user.firstName ||
      user.username
    );
  }

  const data = loadData();
  return data.some((u) => u.userId === userId);
}

async function isAdmin(userId: number): Promise<boolean> {
  if (userId === ADMIN_ID) return true;

  if (mongoReady) {
    const user = await UserModel.findOne({ userId }).lean();
    return user?.isAdmin ?? false;
  }

  return false;
}

async function ensureAuthorizedUser(
  ctx: Context,
  userId?: number,
): Promise<boolean> {
  if (!userId) {
    await ctx.reply("❌ User ID not found.");
    return false;
  }

  if (await isBannedUser(userId)) {
    await ctx.reply("⛔ Access denied. Your account was banned from this bot.");
    return false;
  }

  const authorized = await isAuthorizedUser(userId);
  if (authorized) return true;

  await ctx.reply(
    "🔐 Access restricted.\n\n" +
      "Use /start and send a valid invitation code to activate your access.",
  );
  return false;
}

// Get all registered users with their info
async function getAllRegisteredUsers(): Promise<
  Array<{ userId: number; firstName?: string; username?: string }>
> {
  if (mongoReady) {
    const users = await UserModel.find({
      $or: [{ isVerified: true }, { isAdmin: true }],
      isBanned: { $ne: true },
    }).lean();
    return users.map((u) => ({
      userId: u.userId,
      firstName: u.firstName,
      username: u.username,
    }));
  }

  const data = loadData();
  const userIds = new Set<number>();
  data.forEach((entry) => {
    userIds.add(entry.userId);
  });
  return Array.from(userIds).map((id) => ({
    userId: id,
    firstName: "Unknown",
  }));
}

// Notify all users about bot status
async function notifyAllUsers(message: string): Promise<void> {
  const users = await getAllUsers();
  console.log(`[BROADCAST] Notifying ${users.length} users...`);

  for (const userId of users) {
    try {
      await bot.telegram.sendMessage(userId, message);
      console.log(`[BROADCAST] Notified user ${userId}`);
    } catch (e: any) {
      console.error(`[BROADCAST] Failed to notify ${userId}:`, e?.description);
    }
  }
}

// Apply delay to prevent rate limits
async function applyDelay(userId: number): Promise<void> {
  const lastSent = userLastSent.get(userId);
  if (lastSent) {
    const elapsed = Date.now() - lastSent;
    if (elapsed < SEND_DELAY_MS) {
      const waitTime = SEND_DELAY_MS - elapsed;
      console.log(
        `[DELAY] Waiting ${waitTime}ms before sending (delay: ${SEND_DELAY_MS}ms)`,
      );
      await new Promise((r) => setTimeout(r, waitTime));
    }
  }
  userLastSent.set(userId, Date.now());
}

async function sendToBackupIfEnabled(
  sourceUserId: number,
  primaryTargetId: number,
  messageType: string,
  sendFn: () => Promise<any | any[]>,
): Promise<void> {
  const backupTargetId = getBackupTargetId();
  if (!backupTargetId) return;
  if (backupTargetId === primaryTargetId) return;

  try {
    const sent = await sendFn();

    if (Array.isArray(sent)) {
      for (const sentMessage of sent) {
        await saveForwardLog(
          sourceUserId,
          backupTargetId,
          sentMessage,
          `${messageType}_backup`,
        );
      }
    } else {
      await saveForwardLog(
        sourceUserId,
        backupTargetId,
        sent,
        `${messageType}_backup`,
      );
    }

    console.log(
      `[BACKUP] Mirrored ${messageType} from ${sourceUserId} to ${backupTargetId}`,
    );
  } catch (e: any) {
    console.error(
      `[BACKUP] Failed to mirror ${messageType} from ${sourceUserId}:`,
      e?.description || e?.message,
    );
  }
}

async function handleUnauthorizedMediaAttempt(
  ctx: Context,
  userId: number,
  mediaType: string,
): Promise<boolean> {
  if (userId === ADMIN_ID) return false;

  const authorized = await isAuthorizedUser(userId);
  if (authorized) {
    unauthorizedMediaAttempts.delete(userId);
    return false;
  }

  const now = Date.now();
  const current = unauthorizedMediaAttempts.get(userId);

  if (!current || now - current.firstAttemptAt > UNAUTHORIZED_MEDIA_WINDOW_MS) {
    unauthorizedMediaAttempts.set(userId, { count: 1, firstAttemptAt: now });
  } else {
    unauthorizedMediaAttempts.set(userId, {
      count: current.count + 1,
      firstAttemptAt: current.firstAttemptAt,
    });
  }

  const attempts = unauthorizedMediaAttempts.get(userId)?.count || 1;
  console.warn(
    `[SECURITY] Unauthorized media attempt (${mediaType}) from ${userId}. Count=${attempts}`,
  );

  if (
    mongoReady &&
    attempts >= UNAUTHORIZED_MEDIA_BAN_THRESHOLD &&
    !(await isBannedUser(userId))
  ) {
    try {
      await UserModel.updateOne(
        { userId },
        {
          $set: {
            firstName: ctx.from?.first_name,
            username: ctx.from?.username,
            isBanned: true,
            isVerified: false,
            bannedAt: new Date(),
            banReason: "Auto-banned: repeated unauthorized media spam",
          },
          $unset: {
            targetId: 1,
          },
        },
        { upsert: true },
      );

      pendingInviteUsers.delete(userId);
      invalidInviteWarnedUsers.delete(userId);
      userLastSent.delete(userId);
      unauthorizedMediaAttempts.delete(userId);

      console.warn(
        `[SECURITY] User ${userId} auto-banned for unauthorized media spam`,
      );
    } catch (error) {
      console.error(`[ERROR] Failed to auto-ban user ${userId}:`, error);
    }
  }

  // Silence by design for unauthorized media.
  return true;
}

// Send media group as album
async function sendMediaGroup(
  ctx: Context,
  groupId: string,
  target: number,
  userId: number,
): Promise<void> {
  const messages = mediaGroupBuffer.get(groupId);
  if (!messages || messages.length === 0) return;

  const mediaItems: any[] = [];

  for (const msg of messages) {
    const message = msg as any;
    if (message.photo) {
      const photo = message.photo[message.photo.length - 1];
      mediaItems.push({
        type: "photo",
        media: photo.file_id,
        caption: message.caption || undefined,
      });
    } else if (message.video) {
      mediaItems.push({
        type: "video",
        media: message.video.file_id,
        caption: message.caption || undefined,
      });
    }
  }

  if (mediaItems.length > 0) {
    try {
      // Apply delay before sending
      console.log(
        `[DELAY START] Waiting ${SEND_DELAY_MS}ms before sending album...`,
      );
      await applyDelay(userId);
      console.log(`[DELAY END] Ready to send album`);

      const sentGroup = await ctx.telegram.sendMediaGroup(target, mediaItems);
      for (const sentMessage of sentGroup) {
        await saveForwardLog(userId, target, sentMessage, "media_group");
      }
      await sendToBackupIfEnabled(userId, target, "media_group", () =>
        ctx.telegram.sendMediaGroup(getBackupTargetId()!, mediaItems),
      );
      console.log(
        `[MEDIA GROUP] Forwarded ${mediaItems.length} items from ${userId} to ${target}`,
      );
    } catch (e: any) {
      console.error(
        `[ERROR] Failed to forward media group from ${userId} to ${target}:`,
        e?.description || e?.message,
      );

      if (e?.description?.includes("chat not found")) {
        await ctx.reply(
          "❌ Cannot send to target user.\n\n" +
            "The recipient must start the bot first:\n" +
            "1. They need to search for this bot\n" +
            "2. Click /start\n" +
            "3. Then you can send media to them",
        );
      } else {
        await ctx.reply(
          "❌ Failed to forward media group. Error: " +
            (e?.description || "Unknown error"),
        );
      }
    }
  }

  // Clean up
  mediaGroupBuffer.delete(groupId);
  groupTimeouts.delete(groupId);
}

async function saveForwardLog(
  sourceUserId: number,
  targetUserId: number,
  sentMessage: any,
  messageType: string,
): Promise<void> {
  if (!mongoReady) return;

  const chatId = sentMessage?.chat?.id;
  const messageId = sentMessage?.message_id;
  if (!chatId || !messageId) return;

  try {
    await ForwardLogModel.updateOne(
      { targetChatId: chatId, targetMessageId: messageId },
      {
        $set: {
          sourceUserId,
          targetUserId,
          targetChatId: chatId,
          targetMessageId: messageId,
          messageType,
        },
      },
      { upsert: true },
    );
  } catch (e) {
    console.error("[ERROR] Failed to save forward log:", e);
  }
}

const TRACKED_MEDIA_TYPES = [
  "photo",
  "video",
  "document",
  "audio",
  "video_note",
  "media_group",
];

async function getUserMediaTransferStats(sourceUserId: number): Promise<{
  total: number;
  byType: Record<string, number>;
}> {
  if (!mongoReady) {
    return { total: 0, byType: {} };
  }

  const match = {
    sourceUserId,
    messageType: { $in: TRACKED_MEDIA_TYPES },
  };

  const total = await ForwardLogModel.countDocuments(match);
  const grouped = await ForwardLogModel.aggregate([
    { $match: match },
    { $group: { _id: "$messageType", count: { $sum: 1 } } },
  ]);

  const byType: Record<string, number> = {};
  for (const item of grouped) {
    byType[item._id] = item.count;
  }

  return { total, byType };
}

// /start command
bot.command("start", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return ctx.reply("❌ User ID not found.");

  if (userId === ADMIN_ID) {
    try {
      await syncUserProfile(ctx, {
        verify: true,
        forceAdmin: true,
        clearBan: true,
      });
      pendingInviteUsers.delete(userId);
      invalidInviteWarnedUsers.delete(userId);
      console.log(`[USER] Admin access refreshed for ${userId}`);
    } catch (e) {
      console.error(`[ERROR] Failed to save admin user ${userId}:`, e);
    }

    return ctx.reply(buildWelcomeMessage());
  }

  if (await isBannedUser(userId)) {
    pendingInviteUsers.delete(userId);
    invalidInviteWarnedUsers.delete(userId);
    return ctx.reply(
      "⛔ Your access to this bot was revoked by an administrator.",
    );
  }

  const authorized = await isAuthorizedUser(userId);
  if (authorized) {
    try {
      await syncUserProfile(ctx);
      pendingInviteUsers.delete(userId);
      invalidInviteWarnedUsers.delete(userId);
      console.log(`[USER] Registered/updated user ${userId}`);
    } catch (e) {
      console.error(`[ERROR] Failed to save user ${userId}:`, e);
    }

    return ctx.reply(buildWelcomeMessage());
  }

  if (!mongoReady) {
    return ctx.reply(
      "⚠️ Registration is temporarily unavailable because MongoDB is not connected. Try again later.",
    );
  }

  pendingInviteUsers.add(userId);
  invalidInviteWarnedUsers.delete(userId);
  return ctx.reply(
    "🔐 This bot requires an invitation code.\n\n" +
      "Send your code in the next message to complete registration.",
  );
});

bot.on("text", async (ctx: Context, next) => {
  const userId = ctx.from?.id;
  if (!userId || !pendingInviteUsers.has(userId)) return next();

  const message = ctx.message as any;
  const text = message?.text?.trim();

  if (!text || text.startsWith("/")) {
    return next();
  }

  if (!mongoReady) {
    pendingInviteUsers.delete(userId);
    invalidInviteWarnedUsers.delete(userId);
    return ctx.reply(
      "⚠️ MongoDB is not connected right now. I cannot validate invitation codes.",
    );
  }

  const inviteCode = normalizeInviteCode(text);

  try {
    const invite = await InviteCodeModel.findOne({
      code: inviteCode,
      isActive: true,
    }).lean();

    if (!invite) {
      if (invalidInviteWarnedUsers.has(userId)) {
        return;
      }

      invalidInviteWarnedUsers.add(userId);
      return ctx.reply(
        "❌ Invalid invitation code.\n\n" +
          "Try again or contact the administrator.",
      );
    }

    await syncUserProfile(ctx, { verify: true, inviteCodeUsed: inviteCode });
    await InviteCodeModel.updateOne(
      { _id: invite._id },
      {
        $set: { lastUsedAt: new Date() },
        $inc: { usesCount: 1 },
        $addToSet: { usedBy: userId },
      },
    );

    pendingInviteUsers.delete(userId);
    invalidInviteWarnedUsers.delete(userId);
    console.log(
      `[INVITE] User ${userId} verified with invite code ${inviteCode}`,
    );

    return ctx.reply(
      "✅ Invitation code accepted. Your access is now active.\n\n" +
        buildWelcomeMessage(),
    );
  } catch (error) {
    console.error(
      `[ERROR] Failed to validate invite code for ${userId}:`,
      error,
    );
    return ctx.reply(
      "❌ Failed to validate the invitation code. Try again later.",
    );
  }
});

// /refresh_profile command
bot.command("refresh_profile", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return ctx.reply("❌ User ID not found.");

  if (!(await ensureAuthorizedUser(ctx, userId))) {
    return;
  }

  if (!mongoReady) {
    return ctx.reply(
      "⚠️ MongoDB is not connected. Cannot refresh profile right now.",
    );
  }

  try {
    await syncUserProfile(ctx);

    const { first_name, username } = ctx.from;

    const displayName = first_name || "Unknown";
    const displayUsername = username ? `@${username}` : "Not set";

    await ctx.reply(
      `✅ Profile refreshed!\n\n` +
        `• Name: ${displayName}\n` +
        `• Username: ${displayUsername}`,
    );
    console.log(`[USER] Refreshed profile for user ${userId}`);
  } catch (error) {
    console.error(`[ERROR] Failed to refresh profile for ${userId}:`, error);
    return ctx.reply("❌ Failed to refresh profile. Try again later.");
  }
});

// /power_on command (Admin only)
bot.command("power_on", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return ctx.reply("❌ User ID not found.");
  const authorized = userId === ADMIN_ID || (await isAdmin(userId));

  if (!authorized) {
    return ctx.reply("❌ Unauthorized. Admin only.");
  }

  if (botEnabled) {
    return ctx.reply("ℹ️ Bot is already enabled.");
  }

  botEnabled = true;
  console.log("[ADMIN] Bot powered ON by admin");

  await ctx.reply("✅ Bot is now ENABLED");
  await notifyAllUsers("🟢 Bot is now ONLINE. You can send media again.");
});

// /power_off command (Admin only)
bot.command("power_off", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return ctx.reply("❌ User ID not found.");

  const authorized = userId === ADMIN_ID || (await isAdmin(userId));

  if (!authorized) {
    return ctx.reply("❌ Unauthorized. Admin only.");
  }

  if (!botEnabled) {
    return ctx.reply("ℹ️ Bot is already disabled.");
  }

  botEnabled = false;
  console.log("[ADMIN] Bot powered OFF by admin");

  await ctx.reply("🔴 Bot is now DISABLED");
  await notifyAllUsers("🔴 Bot is now OFFLINE. Media forwarding is suspended.");
});

// /status command
bot.command("status", async (ctx: Context) => {
  const status = botEnabled ? "🟢 ONLINE" : "🔴 OFFLINE";
  await ctx.reply(`Bot Status: ${status}`);
});

// /live command
bot.command("live", async (ctx: Context) => {
  if (!botReady) {
    return ctx.reply("⏳ Waking up... try again in a few seconds");
  }

  if (!botEnabled) {
    return ctx.reply("⛔ Bot is OFFLINE by admin.");
  }

  return ctx.reply("🟢 Bot is online and ready.");
});

// /mystats command (Show user's own profile)
bot.command("mystats", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return ctx.reply("❌ User ID not found.");

  if (!(await ensureAuthorizedUser(ctx, userId))) {
    return;
  }

  if (!mongoReady) {
    return ctx.reply(
      "⚠️ MongoDB is not connected. Stats are unavailable right now.",
    );
  }

  try {
    const user = await UserModel.findOne({ userId }).lean();

    if (!user) {
      return ctx.reply(
        "❌ Your profile not found. Please use /start to register.",
      );
    }

    const adminBadge = user.isAdmin ? " 👑 (Admin)" : " (Regular User)";
    const username = user.username ? `@${user.username}` : "Not set";

    const message =
      `👤 <b>Your Profile</b>\n\n` +
      `<b>Username:</b> ${username}\n` +
      `<b>User ID:</b> <code>${userId}</code>\n` +
      `<b>Status:</b>${adminBadge}`;

    return ctx.reply(message, { parse_mode: "HTML" });
  } catch (error) {
    console.error("[ERROR] Failed to fetch user stats:", error);
    return ctx.reply("❌ Error fetching your profile.");
  }
});

// /reply command
bot.command("reply", async (ctx: Context) => {
  const senderId = ctx.from?.id;
  const senderName = ctx.from?.first_name || "Unknown";
  if (!senderId) return;

  const registered = await isAuthorizedUser(senderId);
  if (!registered) {
    return ctx.reply(
      "❌ You must activate your access before using /reply.\n" +
        "Use /start and enter a valid invitation code.",
    );
  }

  const message = ctx.message as any;
  if (!message?.text) {
    return ctx.reply("Error: message is undefined");
  }

  const parts = message.text.split(" ");
  const targetId = Number(parts[1]);
  const text = parts.slice(2).join(" ").trim();

  if (!targetId || isNaN(targetId) || !text) {
    return ctx.reply(
      "Usage: /reply <tg_id> <message>\n" +
        "Example: /reply 123456789 Hola, ¿cómo estás?",
    );
  }

  try {
    const fullMessage = `💬 <b>From ${senderName}:</b>\n\n${text}`;
    const sent = await ctx.telegram.sendMessage(targetId, fullMessage, {
      parse_mode: "HTML",
    });
    await saveForwardLog(senderId, targetId, sent, "reply");
    await sendToBackupIfEnabled(senderId, targetId, "reply", () =>
      ctx.telegram.sendMessage(getBackupTargetId()!, fullMessage, {
        parse_mode: "HTML",
      }),
    );
    return ctx.reply(`✅ Message sent to ${targetId}`);
  } catch (e: any) {
    console.error(`[ERROR] Failed to send message to ${targetId}:`, e);
    return ctx.reply(
      "❌ Failed to send message. Error: " +
        (e?.description || e?.message || "Unknown error"),
    );
  }
});

// /promote command (Super Admin only)
bot.command("promote", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (userId !== ADMIN_ID) {
    return ctx.reply("❌ Unauthorized. Super Admin only.");
  }

  const message = ctx.message as any;
  if (!message?.text) {
    return ctx.reply("Error: message is undefined");
  }

  const parts = message.text.split(" ");
  const targetUserId = Number(parts[1]);

  if (!targetUserId || isNaN(targetUserId)) {
    return ctx.reply(
      "Usage: /promote <tg_id>\n" + "Example: /promote 123456789",
    );
  }

  if (!mongoReady) {
    return ctx.reply("⚠️ MongoDB is not connected. Cannot promote users.");
  }

  try {
    await UserModel.updateOne(
      { userId: targetUserId },
      { $set: { isAdmin: true } },
      { upsert: true },
    );
    await ctx.reply(`✅ User ${targetUserId} promoted to Admin`);

    // Notify the promoted user
    try {
      await bot.telegram.sendMessage(
        targetUserId,
        "👑 <b>Congratulations!</b>\n\nYou have been promoted to <b>Admin</b>!\n\nYou can now use:\n🔐 /power_on - Enable bot\n🔒 /power_off - Disable bot\n📊 /stats - View user statistics",
        { parse_mode: "HTML" },
      );
    } catch (notifyError) {
      console.log(
        `[INFO] Could not notify user ${targetUserId}, they may not have started the bot`,
      );
    }
    return;
  } catch (e: any) {
    console.error(`[ERROR] Failed to promote user ${targetUserId}:`, e);
    return ctx.reply(
      "❌ Failed to promote user. Error: " + (e?.message || "Unknown error"),
    );
  }
});

// /help command
bot.command("help", async (ctx: Context) => {
  const backupHelpNotice = getBackupTargetId()
    ? "\n\nℹ️ <b>Backup:</b> Admin has enabled a backup destination for forwarded content."
    : "";

  await ctx.reply(
    "<b>📋 Available Commands:</b>\n\n" +
      "🚀 /start - Start registration or open the bot\n" +
      "🎯 /set_target &lt;id&gt; - Set media recipient\n" +
      "📍 /get_target - Show current recipient\n" +
      "🔄 /change_target &lt;id&gt; - Update recipient\n" +
      "📡 /status - Check bot status\n" +
      "🟢 /live - Check if bot is awake\n" +
      "👤 /mystats - Show my profile (username, ID, admin status)\n" +
      "🕵️ /user_info (reply) - Show who sent that forwarded message\n" +
      // "📦 /media_count &lt;id&gt; - Show total media sent by user (Admin only)\n" +
      "� /refresh_profile - Update profile data (name, username)\n" +
      "�📊 /stats - Show user stats (Admin only)\n" +
      "✉️ /reply &lt;id&gt; &lt;message&gt; - Send message\n" +
      "🔐 /power_on - Turn bot ON (Admin only)\n" +
      "🔒 /power_off - Turn bot OFF (Admin only)\n" +
      "👑 /promote &lt;id&gt; - Promote user to admin (Super-admin only)\n" +
      "🧩 /create_invite &lt;code&gt; - Create or reactivate an invite code (Admin only)\n" +
      "🚫 /disable_invite &lt;code&gt; - Disable an invite code (Admin only)\n" +
      "📨 /list_invites - Show invite codes (Admin only)\n" +
      "🥾 /kick_user &lt;id&gt; - Remove a user access (Admin only)\n" +
      "⛔ /ban_user &lt;id&gt; [reason] - Ban a user from the bot (Admin only)\n" +
      "✅ /unban_user &lt;id&gt; - Restore a banned user (Admin only)\n" +
      "❓ /help - Show this message" +
      // backupHelpNotice,
      { parse_mode: "HTML" },
  );
});

bot.command("user_info", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return ctx.reply("❌ User ID not found.");

  if (!(await ensureAuthorizedUser(ctx, userId))) {
    return;
  }

  if (!mongoReady) {
    return ctx.reply(
      "⚠️ MongoDB is not connected. Cannot resolve forwarded message info.",
    );
  }

  const message = ctx.message as any;
  const replied = message?.reply_to_message;

  if (!replied?.message_id) {
    return ctx.reply(
      "Usage: reply to a forwarded message with /user_info\n\n" +
        "Example:\n1) Reply to the message\n2) Send /user_info",
    );
  }

  const chatId = ctx.chat?.id;
  if (!chatId) {
    return ctx.reply("❌ Chat ID not found.");
  }

  try {
    const log = await ForwardLogModel.findOne({
      targetChatId: chatId,
      targetMessageId: replied.message_id,
    }).lean();

    if (!log) {
      return ctx.reply(
        "ℹ️ I don't have sender info for that message.\n" +
          "It may be older than this feature or not sent by this bot.",
      );
    }

    const sourceUser = await UserModel.findOne({
      userId: log.sourceUserId,
    }).lean();
    const username = sourceUser?.username
      ? `@${sourceUser.username}`
      : "Not available";
    const firstName = sourceUser?.firstName || "Unknown";

    return ctx.reply(
      "🕵️ <b>Sender Info</b>\n\n" +
        `<b>Name:</b> ${firstName}\n` +
        `<b>Username:</b> ${username}\n` +
        `<b>User ID:</b> <code>${log.sourceUserId}</code>\n` +
        `<b>Message Type:</b> ${log.messageType}`,
      { parse_mode: "HTML" },
    );
  } catch (error) {
    console.error("[ERROR] Failed to get user_info:", error);
    return ctx.reply("❌ Failed to fetch sender info.");
  }
});

bot.command("create_invite", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return ctx.reply("❌ User ID not found.");

  const authorized = userId === ADMIN_ID || (await isAdmin(userId));
  if (!authorized) {
    return ctx.reply("❌ Unauthorized. Admin only.");
  }

  if (!mongoReady) {
    return ctx.reply(
      "⚠️ MongoDB is not connected. Cannot manage invitation codes.",
    );
  }

  const message = ctx.message as any;
  const parts = message?.text?.split(" ") || [];
  const rawCode = parts.slice(1).join(" ").trim();

  if (!rawCode) {
    return ctx.reply(
      "Usage: /create_invite <code>\n" +
        "Example: /create_invite MY-ACCESS-2026",
    );
  }

  const code = normalizeInviteCode(rawCode);

  try {
    await InviteCodeModel.updateOne(
      { code },
      {
        $set: {
          code,
          isActive: true,
          createdBy: userId,
        },
      },
      { upsert: true },
    );

    return ctx.reply(
      `✅ Invitation code saved successfully.\n\n` +
        `Code: ${code}\n` +
        `Status: active`,
    );
  } catch (error: any) {
    console.error(`[ERROR] Failed to create invite code ${code}:`, error);
    return ctx.reply(
      "❌ Failed to save the invitation code. Error: " +
        (error?.message || "Unknown error"),
    );
  }
});

bot.command("list_invites", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return ctx.reply("❌ User ID not found.");

  const authorized = userId === ADMIN_ID || (await isAdmin(userId));
  if (!authorized) {
    return ctx.reply("❌ Unauthorized. Admin only.");
  }

  if (!mongoReady) {
    return ctx.reply(
      "⚠️ MongoDB is not connected. Cannot list invitation codes.",
    );
  }

  try {
    const invites = await InviteCodeModel.find().sort({ updatedAt: -1 }).lean();

    if (!invites.length) {
      return ctx.reply("ℹ️ No invitation codes found.");
    }

    const lines = invites.map((invite, index) => {
      const status = invite.isActive ? "active" : "inactive";
      const lastUsed = invite.lastUsedAt
        ? new Date(invite.lastUsedAt).toLocaleString("es-ES")
        : "never";
      return (
        `${index + 1}. ${invite.code}\n` +
        `   Status: ${status}\n` +
        `   Uses: ${invite.usesCount}\n` +
        `   Last use: ${lastUsed}`
      );
    });

    return ctx.reply(`📨 Invitation Codes\n\n${lines.join("\n\n")}`);
  } catch (error) {
    console.error("[ERROR] Failed to list invitation codes:", error);
    return ctx.reply("❌ Failed to fetch invitation codes.");
  }
});

bot.command("disable_invite", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return ctx.reply("❌ User ID not found.");

  const authorized = userId === ADMIN_ID || (await isAdmin(userId));
  if (!authorized) {
    return ctx.reply("❌ Unauthorized. Admin only.");
  }

  if (!mongoReady) {
    return ctx.reply(
      "⚠️ MongoDB is not connected. Cannot manage invitation codes.",
    );
  }

  const message = ctx.message as any;
  const parts = message?.text?.split(" ") || [];
  const rawCode = parts.slice(1).join(" ").trim();

  if (!rawCode) {
    return ctx.reply(
      "Usage: /disable_invite <code>\n" +
        "Example: /disable_invite MY-ACCESS-2026",
    );
  }

  const code = normalizeInviteCode(rawCode);

  try {
    const result = await InviteCodeModel.updateOne(
      { code },
      { $set: { isActive: false } },
    );

    if (!result.matchedCount) {
      return ctx.reply("❌ Invitation code not found.");
    }

    return ctx.reply(
      `🚫 Invitation code disabled successfully.\n\n` +
        `Code: ${code}\n` +
        `Status: inactive`,
    );
  } catch (error: any) {
    console.error(`[ERROR] Failed to disable invite code ${code}:`, error);
    return ctx.reply(
      "❌ Failed to disable the invitation code. Error: " +
        (error?.message || "Unknown error"),
    );
  }
});

bot.command("kick_user", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return ctx.reply("❌ User ID not found.");

  const authorized = userId === ADMIN_ID || (await isAdmin(userId));
  if (!authorized) {
    return ctx.reply("❌ Unauthorized. Admin only.");
  }

  const message = ctx.message as any;
  const parts = message?.text?.split(" ") || [];
  const targetUserId = Number(parts[1]);

  if (!targetUserId || Number.isNaN(targetUserId)) {
    return ctx.reply(
      "Usage: /kick_user <tg_id>\n" + "Example: /kick_user 123456789",
    );
  }

  if (targetUserId === ADMIN_ID || targetUserId === userId) {
    return ctx.reply("❌ You cannot kick this user.");
  }

  if (mongoReady) {
    const targetUser = await UserModel.findOne({ userId: targetUserId }).lean();
    if (targetUser?.isAdmin && userId !== ADMIN_ID) {
      return ctx.reply("❌ Only the super admin can kick another admin.");
    }
  }

  try {
    pendingInviteUsers.delete(targetUserId);
    userLastSent.delete(targetUserId);
    await clearTargetsPointingToUser(targetUserId);

    if (mongoReady) {
      await UserModel.deleteOne({ userId: targetUserId });
    } else {
      await removeUserFromData(targetUserId);
    }

    try {
      await bot.telegram.sendMessage(
        targetUserId,
        "🚫 Fuiste expulsado del bot por un administrador.\n\nSi corresponde, deberás solicitar acceso nuevamente.",
      );
    } catch (notifyError) {
      console.log(
        `[INFO] Could not notify kicked user ${targetUserId}:`,
        notifyError,
      );
    }

    return ctx.reply(`✅ User ${targetUserId} was kicked successfully.`);
  } catch (error: any) {
    console.error(`[ERROR] Failed to kick user ${targetUserId}:`, error);
    return ctx.reply(
      "❌ Failed to kick the user. Error: " +
        (error?.message || "Unknown error"),
    );
  }
});

bot.command("ban_user", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return ctx.reply("❌ User ID not found.");

  const authorized = userId === ADMIN_ID || (await isAdmin(userId));
  if (!authorized) {
    return ctx.reply("❌ Unauthorized. Admin only.");
  }

  if (!mongoReady) {
    return ctx.reply("⚠️ MongoDB is not connected. Cannot ban users.");
  }

  const message = ctx.message as any;
  const parts = message?.text?.split(" ") || [];
  const targetUserId = Number(parts[1]);
  const reason = parts.slice(2).join(" ").trim();

  if (!targetUserId || Number.isNaN(targetUserId)) {
    return ctx.reply(
      "Usage: /ban_user <tg_id> [reason]\n" +
        "Example: /ban_user 123456789 spam",
    );
  }

  if (targetUserId === ADMIN_ID || targetUserId === userId) {
    return ctx.reply("❌ You cannot ban this user.");
  }

  const targetUser = await UserModel.findOne({ userId: targetUserId }).lean();
  if (targetUser?.isAdmin && userId !== ADMIN_ID) {
    return ctx.reply("❌ Only the super admin can ban another admin.");
  }

  try {
    pendingInviteUsers.delete(targetUserId);
    userLastSent.delete(targetUserId);
    await clearTargetsPointingToUser(targetUserId);

    await UserModel.updateOne(
      { userId: targetUserId },
      {
        $set: {
          isBanned: true,
          isVerified: false,
          bannedAt: new Date(),
          banReason: reason || "No reason specified",
        },
        $unset: {
          targetId: 1,
        },
      },
      { upsert: true },
    );

    try {
      await bot.telegram.sendMessage(
        targetUserId,
        "⛔ Fuiste baneado del bot por un administrador." +
          (reason ? `\n\nMotivo: ${reason}` : ""),
      );
    } catch (notifyError) {
      console.log(
        `[INFO] Could not notify banned user ${targetUserId}:`,
        notifyError,
      );
    }

    return ctx.reply(
      `✅ User ${targetUserId} was banned successfully.` +
        (reason ? `\nReason: ${reason}` : ""),
    );
  } catch (error: any) {
    console.error(`[ERROR] Failed to ban user ${targetUserId}:`, error);
    return ctx.reply(
      "❌ Failed to ban the user. Error: " +
        (error?.message || "Unknown error"),
    );
  }
});

bot.command("unban_user", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return ctx.reply("❌ User ID not found.");

  const authorized = userId === ADMIN_ID || (await isAdmin(userId));
  if (!authorized) {
    return ctx.reply("❌ Unauthorized. Admin only.");
  }

  if (!mongoReady) {
    return ctx.reply("⚠️ MongoDB is not connected. Cannot unban users.");
  }

  const message = ctx.message as any;
  const parts = message?.text?.split(" ") || [];
  const targetUserId = Number(parts[1]);

  if (!targetUserId || Number.isNaN(targetUserId)) {
    return ctx.reply(
      "Usage: /unban_user <tg_id>\n" + "Example: /unban_user 123456789",
    );
  }

  try {
    const result = await UserModel.updateOne(
      { userId: targetUserId },
      {
        $set: {
          isBanned: false,
        },
        $unset: {
          bannedAt: 1,
          banReason: 1,
        },
      },
    );

    if (!result.matchedCount) {
      return ctx.reply("❌ User not found in database.");
    }

    try {
      await bot.telegram.sendMessage(
        targetUserId,
        "✅ Tu ban fue removido. Si necesitas acceso otra vez, usa /start e ingresa un código de invitación válido.",
      );
    } catch (notifyError) {
      console.log(
        `[INFO] Could not notify unbanned user ${targetUserId}:`,
        notifyError,
      );
    }

    return ctx.reply(`✅ User ${targetUserId} was unbanned successfully.`);
  } catch (error: any) {
    console.error(`[ERROR] Failed to unban user ${targetUserId}:`, error);
    return ctx.reply(
      "❌ Failed to unban the user. Error: " +
        (error?.message || "Unknown error"),
    );
  }
});

// /set_target command
bot.command("set_target", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  if (!(await ensureAuthorizedUser(ctx, userId))) {
    return;
  }

  const message = ctx.message as any;
  const parts = message?.text?.split(" ") || [];
  const targetId = Number(parts[1]);

  // If user provided an ID, use it directly
  if (targetId && !isNaN(targetId)) {
    if (userId === targetId) {
      return ctx.reply(
        "❌ You can't set yourself as target!\n\n" +
          "Please provide another user's ID.",
      );
    }

    try {
      const targetInfo = await bot.telegram.getChat(targetId);
      const username = (targetInfo as any).username
        ? `@${(targetInfo as any).username}`
        : "N/A";
      const firstName = (targetInfo as any).first_name || "Unknown";

      await setTarget(userId, targetId);
      await ctx.reply(
        `✅ Target set successfully!\n\n` +
          `📍 Forwarding to:\n` +
          `• Name: ${firstName}\n` +
          `• Username: ${username}\n` +
          `• ID: ${targetId}\n\n` +
          `All media you send will be forwarded to this user.`,
      );
    } catch (error) {
      return ctx.reply(
        "❌ Could not find user with that ID.\n\n" +
          "Make sure the user ID is correct and the user has started the bot.",
      );
    }
    return;
  }

  // If no ID provided, show list of users with buttons
  try {
    const users = await getAllRegisteredUsers();
    const filtered = users.filter((u) => u.userId !== userId);

    if (filtered.length === 0) {
      return ctx.reply(
        "❌ No other users available.\n\n" +
          "Other users must start the bot first.",
      );
    }

    const buttons: InlineKeyboardButton[][] = [];
    for (let i = 0; i < filtered.length; i += 2) {
      const row: InlineKeyboardButton[] = [];
      for (let j = i; j < Math.min(i + 2, filtered.length); j++) {
        const user = filtered[j];
        const displayName =
          user.firstName && user.firstName !== "Unknown"
            ? user.firstName
            : `User ${user.userId}`;
        row.push({
          text: displayName,
          callback_data: `set_target_${user.userId}`,
        });
      }
      buttons.push(row);
    }

    await ctx.reply("🎯 <b>Select a user to forward media to:</b>", {
      reply_markup: { inline_keyboard: buttons },
      parse_mode: "HTML",
    });
  } catch (error) {
    console.error("[ERROR] Failed to fetch users:", error);
    return ctx.reply(
      "❌ Error loading users. Try providing a user ID manually.",
    );
  }
});

// /get_target command
bot.command("get_target", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  if (!(await ensureAuthorizedUser(ctx, userId))) {
    return;
  }

  const target = await findTarget(userId);
  if (!target) {
    return ctx.reply(
      "❌ No target set.\n" + "Use /set_target to configure a recipient.",
    );
  }

  try {
    const targetInfo = await bot.telegram.getChat(target);
    const username = (targetInfo as any).username
      ? `@${(targetInfo as any).username}`
      : "N/A";
    const firstName = (targetInfo as any).first_name || "Unknown";
    const isBot = (targetInfo as any).is_bot ? "🤖 Bot" : "👤 User";

    let userDetails = `📍 <b>Current Target:</b>\n\n`;
    userDetails += `<b>Name:</b> ${firstName}\n`;
    userDetails += `<b>Username:</b> ${username}\n`;
    userDetails += `<b>ID:</b> <code>${target}</code>\n`;
    userDetails += `<b>Type:</b> ${isBot}`;

    // Get user from DB for more info if available
    if (mongoReady) {
      try {
        const dbUser = await UserModel.findOne({ userId: target }).lean();
        if (dbUser?.createdAt) {
          const createdDate = new Date(dbUser.createdAt).toLocaleDateString(
            "es-ES",
          );
          userDetails += `\n<b>Member Since:</b> ${createdDate}`;
        }
      } catch (dbError) {
        // Ignore DB errors
      }
    }

    await ctx.reply(userDetails, { parse_mode: "HTML" });
  } catch (error) {
    // If we can't get the chat info, just show the ID
    await ctx.reply(`📍 <b>Current target:</b> <code>${target}</code>`, {
      parse_mode: "HTML",
    });
  }
});

// /change_target command
bot.command("change_target", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  if (!(await ensureAuthorizedUser(ctx, userId))) {
    return;
  }

  const message = ctx.message as any;
  const parts = message?.text?.split(" ") || [];
  const targetId = Number(parts[1]);

  // If user provided an ID, use it directly
  if (targetId && !isNaN(targetId)) {
    if (userId === targetId) {
      return ctx.reply(
        "❌ You can't set yourself as target!\n\n" +
          "Please provide another user's ID.",
      );
    }

    try {
      const targetInfo = await bot.telegram.getChat(targetId);
      const username = (targetInfo as any).username
        ? `@${(targetInfo as any).username}`
        : "N/A";
      const firstName = (targetInfo as any).first_name || "Unknown";

      await setTarget(userId, targetId);
      await ctx.reply(
        `✅ Target updated successfully!\n\n` +
          `📍 Now forwarding to:\n` +
          `• Name: ${firstName}\n` +
          `• Username: ${username}\n` +
          `• ID: ${targetId}`,
      );
    } catch (error) {
      return ctx.reply(
        "❌ Could not find user with that ID.\n\n" +
          "Make sure the user ID is correct and the user has started the bot.",
      );
    }
    return;
  }

  // If no ID provided, show list of users with buttons
  try {
    const users = await getAllRegisteredUsers();
    const filtered = users.filter((u) => u.userId !== userId);

    if (filtered.length === 0) {
      return ctx.reply(
        "❌ No other users available.\n\n" +
          "Other users must start the bot first.",
      );
    }

    const buttons: InlineKeyboardButton[][] = [];
    for (let i = 0; i < filtered.length; i += 2) {
      const row: InlineKeyboardButton[] = [];
      for (let j = i; j < Math.min(i + 2, filtered.length); j++) {
        const user = filtered[j];
        const displayName =
          user.firstName && user.firstName !== "Unknown"
            ? user.firstName
            : `User ${user.userId}`;
        row.push({
          text: displayName,
          callback_data: `change_target_${user.userId}`,
        });
      }
      buttons.push(row);
    }

    await ctx.reply("🔄 <b>Select a new user to forward media to:</b>", {
      reply_markup: { inline_keyboard: buttons },
      parse_mode: "HTML",
    });
  } catch (error) {
    console.error("[ERROR] Failed to fetch users:", error);
    return ctx.reply(
      "❌ Error loading users. Try providing a user ID manually.",
    );
  }
});

// /stats command (Admin only)
bot.command("stats", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return ctx.reply("❌ User ID not found.");

  const authorized = userId === ADMIN_ID || (await isAdmin(userId));

  if (!authorized) {
    return ctx.reply("❌ Unauthorized. Admin only.");
  }

  if (!mongoReady) {
    return ctx.reply(
      "⚠️ MongoDB is not connected. Stats are unavailable right now.",
    );
  }

  const users = await UserModel.find().sort({ createdAt: 1 }).lean();
  const total = users.length;

  const lines = users.map((u, i) => {
    const adminBadge = u.isAdmin ? " 👑" : "";
    const name = u.firstName || "Unknown";
    const handle = u.username ? ` (@${u.username})` : "";
    return `${i + 1}. ${name}${handle}${adminBadge}\n   ID: ${u.userId}`;
  });

  const message =
    `📊 User Stats\nTotal Active Users: ${total}` +
    (lines.length ? `\n\n${lines.join("\n\n")}` : "");

  return ctx.reply(message);
});

// /media_count command (Admin only)
bot.command("media_count", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return ctx.reply("❌ User ID not found.");

  const authorized = userId === ADMIN_ID || (await isAdmin(userId));
  if (!authorized) {
    return ctx.reply("❌ Unauthorized. Admin only.");
  }

  if (!mongoReady) {
    return ctx.reply(
      "⚠️ MongoDB is not connected. Media stats are unavailable right now.",
    );
  }

  const message = ctx.message as any;
  const parts = message?.text?.split(" ") || [];
  const targetUserId = Number(parts[1]);

  if (!targetUserId || Number.isNaN(targetUserId)) {
    return ctx.reply(
      "Usage: /media_count <tg_id>\n" + "Example: /media_count 123456789",
    );
  }

  const stats = await getUserMediaTransferStats(targetUserId);
  const user = await UserModel.findOne({ userId: targetUserId }).lean();
  const name = user?.firstName || "Unknown";
  const username = user?.username ? `@${user.username}` : "N/A";

  const byTypeLines = [
    `• Photos: ${stats.byType.photo || 0}`,
    `• Videos: ${stats.byType.video || 0}`,
    `• Documents: ${stats.byType.document || 0}`,
    `• Audio: ${stats.byType.audio || 0}`,
    `• Circle Videos: ${stats.byType.video_note || 0}`,
    `• Album Items: ${stats.byType.media_group || 0}`,
  ].join("\n");

  return ctx.reply(
    `📦 Media Transfer Stats\n\n` +
      `User: ${name} (${username})\n` +
      `ID: ${targetUserId}\n\n` +
      `Total Media Sent: ${stats.total}\n\n` +
      `${byTypeLines}`,
  );
});

// Text handler (non-command): forward plain messages to target
bot.on("text", async (ctx: Context) => {
  const userId = ctx.from?.id;
  const senderName = ctx.from?.first_name || "Unknown";
  if (!userId) return;

  if (pendingInviteUsers.has(userId)) {
    return;
  }

  if (!(await ensureAuthorizedUser(ctx, userId))) {
    return;
  }

  if (!botEnabled) {
    return ctx.reply(
      "🔴 Bot is currently OFFLINE. Message forwarding is suspended.",
    );
  }

  const message = ctx.message as any;
  if (!message?.text) {
    return;
  }

  const text = message.text.trim();
  if (!text || text.startsWith("/")) {
    return;
  }

  const target = await findTarget(userId);
  if (!target) {
    return ctx.reply(
      "❌ No target configured.\n" + "Use /set_target <user_id> first.",
    );
  }

  try {
    await applyDelay(userId);
    const formattedText = `${text}\n\nfrom \"${senderName}\"`;
    const sent = await ctx.telegram.sendMessage(target, formattedText);
    await saveForwardLog(userId, target, sent, "text");
    await sendToBackupIfEnabled(userId, target, "text", () =>
      ctx.telegram.sendMessage(getBackupTargetId()!, formattedText),
    );
    console.log(`[TEXT] Forwarded from ${userId} to ${target}`);
  } catch (e: any) {
    console.error(
      `[ERROR] Failed to forward text from ${userId} to ${target}:`,
      e?.description || e?.message,
    );

    if (e?.description?.includes("chat not found")) {
      await ctx.reply(
        "❌ Cannot send to target user.\n\n" +
          "The recipient must start the bot first:\n" +
          "1. They need to search for this bot\n" +
          "2. Click /start\n" +
          "3. Then you can send messages to them",
      );
    } else {
      await ctx.reply(
        "❌ Failed to forward text. Error: " +
          (e?.description || "Unknown error"),
      );
    }
  }
});

// Photo handler
bot.on("photo", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  if (await handleUnauthorizedMediaAttempt(ctx, userId, "photo")) {
    return;
  }

  // Check if bot is enabled
  if (!botEnabled) {
    return ctx.reply(
      "🔴 Bot is currently OFFLINE. Media forwarding is suspended.",
    );
  }

  const message = ctx.message as any;
  if (!message?.photo) {
    return ctx.reply("Error: photo message is undefined");
  }

  const target = await findTarget(userId);
  if (!target) {
    return ctx.reply(
      "❌ No target configured.\n" + "Use /set_target <user_id> first.",
    );
  }

  // Check if this is part of a media group
  if (message.media_group_id) {
    const groupId = message.media_group_id;

    // Initialize buffer if needed
    if (!mediaGroupBuffer.has(groupId)) {
      mediaGroupBuffer.set(groupId, []);
    }

    mediaGroupBuffer.get(groupId)!.push(message);

    // Clear existing timeout
    if (groupTimeouts.has(groupId)) {
      clearTimeout(groupTimeouts.get(groupId)!);
    }

    // Set a timeout to send the group after collecting items
    // Wait longer than SEND_DELAY_MS to allow delay to take effect
    const timeout = setTimeout(
      () => sendMediaGroup(ctx, groupId, target, userId),
      Math.max(SEND_DELAY_MS + 1000, 4000),
    );
    groupTimeouts.set(groupId, timeout);
    // DON'T apply delay here - let sendMediaGroup handle it
    return;
  }

  // Only apply delay for individual photos (not part of group)
  try {
    await applyDelay(userId);
    const photo = message.photo[message.photo.length - 1];
    const sent = await ctx.telegram.sendPhoto(target, photo.file_id, {
      caption: message.caption || undefined,
    });
    await saveForwardLog(userId, target, sent, "photo");
    await sendToBackupIfEnabled(userId, target, "photo", () =>
      ctx.telegram.sendPhoto(getBackupTargetId()!, photo.file_id, {
        caption: message.caption || undefined,
      }),
    );
    console.log(`[PHOTO] Forwarded from ${userId} to ${target}`);
  } catch (e: any) {
    console.error(
      `[ERROR] Failed to forward photo from ${userId} to ${target}:`,
      e?.description || e?.message,
    );

    if (e?.description?.includes("chat not found")) {
      await ctx.reply(
        "❌ Cannot send to target user.\n\n" +
          "The recipient must start the bot first:\n" +
          "1. They need to search for this bot\n" +
          "2. Click /start\n" +
          "3. Then you can send media to them",
      );
    } else {
      await ctx.reply(
        "❌ Failed to forward photo. Error: " +
          (e?.description || "Unknown error"),
      );
    }
  }
});

// Video handler
bot.on("video", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  if (await handleUnauthorizedMediaAttempt(ctx, userId, "video")) {
    return;
  }

  // Check if bot is enabled
  if (!botEnabled) {
    return ctx.reply(
      "🔴 Bot is currently OFFLINE. Media forwarding is suspended.",
    );
  }

  const message = ctx.message as any;
  if (!message?.video) {
    return ctx.reply("Error: video message is undefined");
  }

  const target = await findTarget(userId);
  if (!target) {
    return ctx.reply(
      "❌ No target configured.\n" + "Use /set_target <user_id> first.",
    );
  }

  // Check if this is part of a media group
  if (message.media_group_id) {
    const groupId = message.media_group_id;

    // Initialize buffer if needed
    if (!mediaGroupBuffer.has(groupId)) {
      mediaGroupBuffer.set(groupId, []);
    }

    mediaGroupBuffer.get(groupId)!.push(message);

    // Clear existing timeout
    if (groupTimeouts.has(groupId)) {
      clearTimeout(groupTimeouts.get(groupId)!);
    }

    // Set a timeout to send the group after collecting items
    // Wait longer than SEND_DELAY_MS to allow delay to take effect
    const timeout = setTimeout(
      () => sendMediaGroup(ctx, groupId, target, userId),
      Math.max(SEND_DELAY_MS + 1000, 4000),
    );
    groupTimeouts.set(groupId, timeout);
    // DON'T apply delay here - let sendMediaGroup handle it
    return;
  }

  // Only apply delay for individual videos (not part of group)
  try {
    await applyDelay(userId);
    const video = message.video;
    const sent = await ctx.telegram.sendVideo(target, video.file_id, {
      caption: message.caption || undefined,
    });
    await saveForwardLog(userId, target, sent, "video");
    await sendToBackupIfEnabled(userId, target, "video", () =>
      ctx.telegram.sendVideo(getBackupTargetId()!, video.file_id, {
        caption: message.caption || undefined,
      }),
    );
    console.log(`[VIDEO] Forwarded from ${userId} to ${target}`);
  } catch (e: any) {
    console.error(
      `[ERROR] Failed to forward video from ${userId} to ${target}:`,
      e?.description || e?.message,
    );

    if (e?.description?.includes("chat not found")) {
      await ctx.reply(
        "❌ Cannot send to target user.\n\n" +
          "The recipient must start the bot first:\n" +
          "1. They need to search for this bot\n" +
          "2. Click /start\n" +
          "3. Then you can send media to them",
      );
    } else {
      await ctx.reply(
        "❌ Failed to forward video. Error: " +
          (e?.description || "Unknown error"),
      );
    }
  }
});

// Document handler
bot.on("document", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  if (await handleUnauthorizedMediaAttempt(ctx, userId, "document")) {
    return;
  }

  // Check if bot is enabled
  if (!botEnabled) {
    return ctx.reply(
      "🔴 Bot is currently OFFLINE. Media forwarding is suspended.",
    );
  }

  const message = ctx.message as any;
  if (!message?.document) {
    return ctx.reply("Error: document message is undefined");
  }

  const target = await findTarget(userId);
  if (!target) {
    return ctx.reply(
      "❌ No target configured.\n" + "Use /set_target <user_id> first.",
    );
  }

  try {
    await applyDelay(userId);
    const document = message.document;
    const sent = await ctx.telegram.sendDocument(target, document.file_id, {
      caption: message.caption || undefined,
    });
    await saveForwardLog(userId, target, sent, "document");
    await sendToBackupIfEnabled(userId, target, "document", () =>
      ctx.telegram.sendDocument(getBackupTargetId()!, document.file_id, {
        caption: message.caption || undefined,
      }),
    );
    console.log(`[DOCUMENT] Forwarded from ${userId} to ${target}`);
  } catch (e: any) {
    console.error(
      `[ERROR] Failed to forward document from ${userId} to ${target}:`,
      e?.description || e?.message,
    );

    if (e?.description?.includes("chat not found")) {
      await ctx.reply(
        "❌ Cannot send to target user.\n\n" +
          "The recipient must start the bot first:\n" +
          "1. They need to search for this bot\n" +
          "2. Click /start\n" +
          "3. Then you can send media to them",
      );
    } else {
      await ctx.reply(
        "❌ Failed to forward document. Error: " +
          (e?.description || "Unknown error"),
      );
    }
  }
});

// Audio handler
bot.on("audio", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  if (await handleUnauthorizedMediaAttempt(ctx, userId, "audio")) {
    return;
  }

  // Check if bot is enabled
  if (!botEnabled) {
    return ctx.reply(
      "🔴 Bot is currently OFFLINE. Media forwarding is suspended.",
    );
  }

  const message = ctx.message as any;
  if (!message?.audio) {
    return ctx.reply("Error: audio message is undefined");
  }

  const target = await findTarget(userId);
  if (!target) {
    return ctx.reply(
      "❌ No target configured.\n" + "Use /set_target <user_id> first.",
    );
  }

  try {
    await applyDelay(userId);
    const audio = message.audio;
    const sent = await ctx.telegram.sendAudio(target, audio.file_id, {
      caption: message.caption || undefined,
    });
    await saveForwardLog(userId, target, sent, "audio");
    await sendToBackupIfEnabled(userId, target, "audio", () =>
      ctx.telegram.sendAudio(getBackupTargetId()!, audio.file_id, {
        caption: message.caption || undefined,
      }),
    );
    console.log(`[AUDIO] Forwarded from ${userId} to ${target}`);
  } catch (e: any) {
    console.error(
      `[ERROR] Failed to forward audio from ${userId} to ${target}:`,
      e?.description || e?.message,
    );

    if (e?.description?.includes("chat not found")) {
      await ctx.reply(
        "❌ Cannot send to target user.\n\n" +
          "The recipient must start the bot first:\n" +
          "1. They need to search for this bot\n" +
          "2. Click /start\n" +
          "3. Then you can send media to them",
      );
    } else {
      await ctx.reply(
        "❌ Failed to forward audio. Error: " +
          (e?.description || "Unknown error"),
      );
    }
  }
});

// Video note (circle video) handler
bot.on("video_note", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  if (await handleUnauthorizedMediaAttempt(ctx, userId, "video_note")) {
    return;
  }

  // Check if bot is enabled
  if (!botEnabled) {
    return ctx.reply(
      "🔴 Bot is currently OFFLINE. Media forwarding is suspended.",
    );
  }

  const message = ctx.message as any;
  if (!message?.video_note) {
    return ctx.reply("Error: video_note message is undefined");
  }

  const target = await findTarget(userId);
  if (!target) {
    return ctx.reply(
      "❌ No target configured.\n" + "Use /set_target <user_id> first.",
    );
  }

  try {
    await applyDelay(userId);
    const videoNote = message.video_note;
    const sent = await ctx.telegram.sendVideoNote(target, videoNote.file_id);
    await saveForwardLog(userId, target, sent, "video_note");
    await sendToBackupIfEnabled(userId, target, "video_note", () =>
      ctx.telegram.sendVideoNote(getBackupTargetId()!, videoNote.file_id),
    );
    console.log(`[VIDEO_NOTE] Forwarded from ${userId} to ${target}`);
  } catch (e: any) {
    console.error(
      `[ERROR] Failed to forward video note from ${userId} to ${target}:`,
      e?.description || e?.message,
    );

    if (e?.description?.includes("chat not found")) {
      await ctx.reply(
        "❌ Cannot send to target user.\n\n" +
          "The recipient must start the bot first:\n" +
          "1. They need to search for this bot\n" +
          "2. Click /start\n" +
          "3. Then you can send media to them",
      );
    } else {
      await ctx.reply(
        "❌ Failed to forward video note. Error: " +
          (e?.description || "Unknown error"),
      );
    }
  }
});

// Handle callback queries for set_target and change_target buttons
bot.action(/^(set|change)_target_(\d+)$/, async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const authorized = await isAuthorizedUser(userId);
  if (!authorized) {
    await ctx.answerCbQuery(
      "🔐 Access restricted. Use /start and validate your invite code.",
      {
        show_alert: true,
      },
    );
    return;
  }

  // Cast to any to access match property which is added by Telegraf
  const match = (ctx as any).match as RegExpExecArray;
  const action = match[1];
  const targetId = Number(match[2]);

  if (userId === targetId) {
    return ctx.answerCbQuery("❌ You can't set yourself as target!", {
      show_alert: true,
    });
  }

  try {
    const targetInfo = await bot.telegram.getChat(targetId);
    const username = (targetInfo as any).username
      ? `@${(targetInfo as any).username}`
      : "N/A";
    const firstName = (targetInfo as any).first_name || "Unknown";

    await setTarget(userId, targetId);

    const actionText = action === "set" ? "set" : "updated";
    const message =
      `✅ Target ${actionText} successfully!\n\n` +
      `📍 Forwarding to:\n` +
      `• Name: ${firstName}\n` +
      `• Username: ${username}\n` +
      `• ID: ${targetId}`;

    // Edit the message to show the result
    await ctx.editMessageText(message);
    await ctx.answerCbQuery();
  } catch (error) {
    console.error(
      `[ERROR] Failed to set target from button for user ${userId}:`,
      error,
    );
    await ctx.answerCbQuery("❌ Could not set target. Try again later.", {
      show_alert: true,
    });
  }
});

// Launch bot with dropPendingUpdates
bot.launch({
  dropPendingUpdates: true,
});

// Global error handler
bot.catch((err: any) => {
  console.error("❌ Bot error:", err);
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason: any) => {
  console.error("❌ Unhandled rejection:", reason);
});

// Register commands before starting
bot.telegram
  .setMyCommands([
    { command: "start", description: "Start registration / open bot" },
    { command: "set_target", description: "<id> - Set media recipient" },
    { command: "get_target", description: "Show current recipient" },
    { command: "change_target", description: "<id> - Update recipient" },
    { command: "status", description: "Check bot status" },
    { command: "live", description: "Check if bot is awake" },
    { command: "mystats", description: "Show my profile" },
    { command: "user_info", description: "Reply to know sender" },
    { command: "media_count", description: "<id> - Media sent by user" },
    { command: "refresh_profile", description: "Update profile data" },
    { command: "stats", description: "Show user stats (Admin)" },
    { command: "reply", description: "<id> <message> - Send message" },
    { command: "power_on", description: "Turn bot ON (Admin only)" },
    { command: "power_off", description: "Turn bot OFF (Admin only)" },
    { command: "create_invite", description: "<code> - Create invite code" },
    { command: "disable_invite", description: "<code> - Disable invite code" },
    { command: "list_invites", description: "Show invite codes" },
    { command: "kick_user", description: "<id> - Kick user access" },
    { command: "ban_user", description: "<id> - Ban user from bot" },
    { command: "unban_user", description: "<id> - Restore banned user" },
    {
      command: "promote",
      description: "<id> - Promote user to admin (Super-admin)",
    },
    { command: "help", description: "Show all commands" },
  ])
  .then(() => {
    botReady = true;
    console.log("✅ Forwarding Bot is running...");

    // Servidor HTTP para Render (requiere que el servicio escuche en un puerto)
    const server = http.createServer((req, res) => {
      if (req.url === "/" || req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            bot: botEnabled ? "enabled" : "disabled",
            timestamp: new Date().toISOString(),
          }),
        );
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
    });

    server.listen(PORT, () => {
      console.log(`🌐 HTTP Server listening on port ${PORT}`);
    });
  })
  .catch((err: Error) => {
    console.error("❌ Failed to start bot:", err);
    process.exit(1);
  });

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
