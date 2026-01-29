import { Telegraf, Context } from "telegraf";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const SEND_DELAY_MS = parseInt(process.env.SEND_DELAY_MS || "3000", 10);
const ADMIN_ID = parseInt(process.env.ADMIN_ID || "0", 10);
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

function findTarget(userId: number): number | null {
  const data = loadData();
  const user = data.find((u) => u.userId === userId);
  return user?.targetId ?? null;
}

function setTarget(userId: number, targetId: number): void {
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
function getAllUsers(): number[] {
  const data = loadData();
  const userIds = new Set<number>();
  data.forEach((entry) => {
    userIds.add(entry.userId);
    userIds.add(entry.targetId);
  });
  return Array.from(userIds);
}

// Notify all users about bot status
async function notifyAllUsers(message: string): Promise<void> {
  const users = getAllUsers();
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
  await ctx.reply(
    "Welcome! 👋\n\n" +
      "Use /set_target <user_id> to specify who receives your media.\n" +
      "Use /get_target to see your current target.\n" +
      "Use /change_target <user_id> to update it.\n" +
      "Use /help for more info.",
  );
});

// /power_on command (Admin only)
bot.command("power_on", async (ctx: Context) => {
  const userId = ctx.from?.id;

  if (userId !== ADMIN_ID) {
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

  if (userId !== ADMIN_ID) {
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
      "🔐 /power_on - Turn bot ON (Admin only)\n" +
      "🔒 /power_off - Turn bot OFF (Admin only)\n" +
      "❓ /help - Show this message",
    { parse_mode: "HTML" },
  );
});

// /set_target command
bot.command("set_target", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const message = ctx.message as any;
  if (!message?.text) {
    return ctx.reply("Error: message is undefined");
  }

  const parts = message.text.split(" ");
  const targetId = Number(parts[1]);

  if (!targetId || isNaN(targetId)) {
    return ctx.reply(
      "Please provide a valid target user ID.\n" +
        "Usage: /set_target <user_id>",
    );
  }

  setTarget(userId, targetId);
  await ctx.reply(
    `✅ Target set to: ${targetId}\n\n` +
      "All media you send will now be forwarded to this user.",
  );
});

// /get_target command
bot.command("get_target", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const target = findTarget(userId);
  if (!target) {
    return ctx.reply(
      "❌ No target set.\n" +
        "Use /set_target <user_id> to configure a recipient.",
    );
  }

  await ctx.reply(`📍 Current target: ${target}`);
});

// /change_target command
bot.command("change_target", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const message = ctx.message as any;
  if (!message?.text) {
    return ctx.reply("Error: message is undefined");
  }

  const parts = message.text.split(" ");
  const targetId = Number(parts[1]);

  if (!targetId || isNaN(targetId)) {
    return ctx.reply(
      "Please provide a valid target user ID.\n" +
        "Usage: /change_target <user_id>",
    );
  }

  setTarget(userId, targetId);
  await ctx.reply(`✅ Target updated to: ${targetId}`);
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

  const target = findTarget(userId);
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

  const target = findTarget(userId);
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

  const target = findTarget(userId);
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

  const target = findTarget(userId);
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
    { command: "set_target", description: "Set media recipient" },
    { command: "get_target", description: "Show current recipient" },
    { command: "change_target", description: "Update recipient" },
    { command: "status", description: "Check bot status" },
    { command: "live", description: "Check if bot is awake" },
    { command: "power_on", description: "Turn bot ON (Admin only)" },
    { command: "power_off", description: "Turn bot OFF (Admin only)" },
    { command: "help", description: "Show all commands" },
  ])
  .then(() => {
    botReady = true;
    console.log("✅ Forwarding Bot is running...");
  })
  .catch((err: Error) => {
    console.error("❌ Failed to start bot:", err);
    process.exit(1);
  });

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
