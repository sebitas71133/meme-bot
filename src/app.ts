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
  },
  { timestamps: true },
);

const UserModel = mongoose.model<UserDoc>("User", userSchema);
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

async function isRegisteredUser(userId: number): Promise<boolean> {
  if (mongoReady) {
    const user = await UserModel.findOne({ userId }).lean();
    return !!user;
  }

  const data = loadData();
  return data.some((u) => u.userId === userId || u.targetId === userId);
}

async function isAdmin(userId: number): Promise<boolean> {
  if (userId === ADMIN_ID) return true;

  if (mongoReady) {
    const user = await UserModel.findOne({ userId }).lean();
    return user?.isAdmin ?? false;
  }

  return false;
}

// Get all registered users with their info
async function getAllRegisteredUsers(): Promise<
  Array<{ userId: number; firstName?: string; username?: string }>
> {
  if (mongoReady) {
    const users = await UserModel.find().lean();
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

      await ctx.telegram.sendMediaGroup(target, mediaItems);
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

// /start command
bot.command("start", async (ctx: Context) => {
  const userId = ctx.from?.id;

  // Save user info to database on first interaction
  if (userId && mongoReady) {
    try {
      const { first_name, username } = ctx.from;
      await UserModel.updateOne(
        { userId },
        {
          $set: {
            firstName: first_name,
            username,
          },
        },
        { upsert: true },
      );
      console.log(`[USER] Registered/updated user ${userId}`);
    } catch (e) {
      console.error(`[ERROR] Failed to save user ${userId}:`, e);
    }
  }

  await ctx.reply(
    "Welcome! 👋\n\n" +
      "Use /set_target <user_id> to specify who receives your media.\n" +
      "Use /get_target to see your current target.\n" +
      "Use /change_target <user_id> to update it.\n" +
      "Use /help for more info.",
  );
});

// /refresh_profile command
bot.command("refresh_profile", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return ctx.reply("❌ User ID not found.");

  if (!mongoReady) {
    return ctx.reply(
      "⚠️ MongoDB is not connected. Cannot refresh profile right now.",
    );
  }

  try {
    const { first_name, username } = ctx.from;
    await UserModel.updateOne(
      { userId },
      {
        $set: {
          firstName: first_name,
          username,
        },
      },
      { upsert: true },
    );

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

  const registered = await isRegisteredUser(senderId);
  if (!registered) {
    return ctx.reply(
      "❌ You must be registered to use /reply.\n" +
        "Use /start first and set a target with /set_target.",
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
    await ctx.telegram.sendMessage(targetId, fullMessage, {
      parse_mode: "HTML",
    });
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
  await ctx.reply(
    "<b>📋 Available Commands:</b>\n\n" +
      "🚀 /start - Welcome message\n" +
      "🎯 /set_target &lt;id&gt; - Set media recipient\n" +
      "📍 /get_target - Show current recipient\n" +
      "🔄 /change_target &lt;id&gt; - Update recipient\n" +
      "📡 /status - Check bot status\n" +
      "🟢 /live - Check if bot is awake\n" +
      "👤 /mystats - Show my profile (username, ID, admin status)\n" +
      "� /refresh_profile - Update profile data (name, username)\n" +
      "�📊 /stats - Show user stats (Admin only)\n" +
      "✉️ /reply &lt;id&gt; &lt;message&gt; - Send message\n" +
      "🔐 /power_on - Turn bot ON (Admin only)\n" +
      "🔒 /power_off - Turn bot OFF (Admin only)\n" +
      "👑 /promote &lt;id&gt; - Promote user to admin (Super-admin only)\n" +
      "❓ /help - Show this message",
    { parse_mode: "HTML" },
  );
});

// /set_target command
bot.command("set_target", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;

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

// Photo handler
bot.on("photo", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;

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
    await ctx.telegram.sendPhoto(target, photo.file_id, {
      caption: message.caption || undefined,
    });
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
    await ctx.telegram.sendVideo(target, video.file_id, {
      caption: message.caption || undefined,
    });
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
    await ctx.telegram.sendDocument(target, document.file_id, {
      caption: message.caption || undefined,
    });
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
    await ctx.telegram.sendAudio(target, audio.file_id, {
      caption: message.caption || undefined,
    });
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

// Handle callback queries for set_target and change_target buttons
bot.action(/^(set|change)_target_(\d+)$/, async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;

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
    { command: "start", description: "Welcome message" },
    { command: "set_target", description: "<id> - Set media recipient" },
    { command: "get_target", description: "Show current recipient" },
    { command: "change_target", description: "<id> - Update recipient" },
    { command: "status", description: "Check bot status" },
    { command: "live", description: "Check if bot is awake" },
    { command: "mystats", description: "Show my profile" },
    { command: "refresh_profile", description: "Update profile data" },
    { command: "stats", description: "Show user stats (Admin)" },
    { command: "reply", description: "<id> <message> - Send message" },
    { command: "power_on", description: "Turn bot ON (Admin only)" },
    { command: "power_off", description: "Turn bot OFF (Admin only)" },
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
