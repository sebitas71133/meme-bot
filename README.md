# Forwarding Bot 📤

A personal Telegram bot that automatically forwards media (photos, videos, documents, audio) from one user to a target user.

## Features

- ✅ Set a target user to receive all your media
- ✅ Registration protected with invitation codes stored in MongoDB
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

| Command           | Usage                      | Description                      |
| ----------------- | -------------------------- | -------------------------------- |
| `/start`          | `/start`                   | Welcome message & quick info     |
| `/set_target`     | `/set_target <user_id>`    | Set the recipient of your media  |
| `/get_target`     | `/get_target`              | Show current target user ID      |
| `/change_target`  | `/change_target <user_id>` | Update the recipient             |
| `/create_invite`  | `/create_invite <code>`    | Create/reactivate an invite code |
| `/disable_invite` | `/disable_invite <code>`   | Disable an invite code           |
| `/list_invites`   | `/list_invites`            | List invite codes (admin only)   |
| `/kick_user`      | `/kick_user <id>`          | Remove a user access             |
| `/ban_user`       | `/ban_user <id> [reason]`  | Ban a user from the bot          |
| `/unban_user`     | `/unban_user <id>`         | Unban a user                     |
| `/help`           | `/help`                    | Show all available commands      |

## How It Works

1. Admin creates an invite code with `/create_invite MY-CODE`
2. User A sends `/start` to the bot
3. The bot asks for the invitation code
4. User A sends the valid code and is registered
5. User B (recipient) also completes the same process
6. User A sends `/set_target <B's user ID>`
7. Any media User A sends → automatically forwarded to User B
8. Rate limiting prevents spam (500ms between sends)

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

- Both users must complete `/start` with a valid invitation code before forwarding works
- Rate limiting is set to 500ms by default (adjust `SEND_DELAY_MS` in `.env`)
- Invitation codes require MongoDB. The JSON fallback remains for target mappings only.
- In private Telegram chats a bot cannot truly "expel" a user at platform level; `/kick_user` removes local access and `/ban_user` blocks them in your own bot logic.
- Logs are printed to console with prefix: `[PHOTO]`, `[VIDEO]`, `[DOCUMENT]`, `[AUDIO]`

## License

ISC
