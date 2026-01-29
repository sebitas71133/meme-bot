# Forwarding Bot 📤

A personal Telegram bot that automatically forwards media (photos, videos, documents, audio) from one user to a target user.

## Features

- ✅ Set a target user to receive all your media
- ✅ Automatic forwarding with rate limiting (500ms delay)
- ✅ JSON-based persistence (no database required)
- ✅ Simple commands: `/set_target`, `/get_target`, `/change_target`
- ✅ Support for photos, videos, documents, and audio
- ✅ Error handling with user-friendly messages

## Setup

### Prerequisites

- Node.js 18+
- npm or yarn
- Telegram bot token (get one from [@BotFather](https://t.me/BotFather))

### Installation

```bash
npm install
```

### Configuration

1. Create a `.env` file:

```env
BOT_TOKEN=YOUR_BOT_TOKEN_HERE
SEND_DELAY_MS=500
```

2. Replace `YOUR_BOT_TOKEN_HERE` with your actual bot token.

## Running

**Development mode:**

```bash
npm run dev
```

**Production mode:**

```bash
npm run build
npm start
```

## Commands

| Command          | Usage                      | Description                     |
| ---------------- | -------------------------- | ------------------------------- |
| `/start`         | `/start`                   | Welcome message & quick info    |
| `/set_target`    | `/set_target <user_id>`    | Set the recipient of your media |
| `/get_target`    | `/get_target`              | Show current target user ID     |
| `/change_target` | `/change_target <user_id>` | Update the recipient            |
| `/help`          | `/help`                    | Show all available commands     |

## How It Works

1. User A sends `/start` to the bot
2. User B (recipient) also sends `/start` to the bot
3. User A sends `/set_target <B's user ID>`
4. Any media User A sends → automatically forwarded to User B
5. Rate limiting prevents spam (500ms between sends)

## Data Storage

All user-target mappings are stored in `data.json` in the project root:

```json
[
  { "userId": 123456789, "targetId": 987654321, "createdAt": "2024-01-29T..." },
  { "userId": 111111111, "targetId": 222222222, "createdAt": "2024-01-29T..." }
]
```

## Project Structure

```
forwarding-bot/
├── src/
│   └── app.ts          # Main bot logic
├── dist/               # Compiled JavaScript (auto-generated)
├── package.json        # Dependencies
├── tsconfig.json       # TypeScript config
├── .env                # Configuration (create this)
├── data.json           # User mappings (auto-generated)
└── README.md           # This file
```

## Notes

- Both users must start the bot before forwarding works
- Rate limiting is set to 500ms by default (adjust `SEND_DELAY_MS` in `.env`)
- No database required—uses JSON file for persistence
- Logs are printed to console with prefix: `[PHOTO]`, `[VIDEO]`, `[DOCUMENT]`, `[AUDIO]`

## License

ISC
