# Claude Desktop Mods

**Tiếng Việt** · [English](#english)

Bộ mod cho **Claude Desktop** (tab Code) và **Claude Code**: thêm nút thống kê token và điều khiển phiên Claude từ Telegram ngay cạnh ô chat.

Tác giả: **Nguyễn Mạnh Cường** · Website: **[vidtools.net](https://vidtools.net)**

---

## Có gì trong bộ mod

| Mod | Làm gì |
| --- | --- |
| **`thong-ke-token`** | Nút **📊 Thống kê token** trên ô chat. Mở pane xem: token và thời gian hoạt động của phiên này, của cả tháng (tính từ ngày 1), số phiên, chi phí ước tính, hạn mức 5 giờ / 7 ngày của tài khoản. |
| **`tele-bridge`** | Nút **Tele** (🟢 đang nghe · 🔴 tắt/lỗi · 🟡 chờ ghép). Nhắn bot Telegram → tin nhắn vào thẳng phiên Claude; Claude làm xong → câu trả lời gửi lại Telegram. Dùng khi bạn ra ngoài, không ngồi máy. |

Hai nút nằm chung một hàng phía trên ô chat.

## Mod này có an toàn, có được phép không?

- ✅ Bộ mod dùng **hệ thống plugin / mod chính thức** có sẵn trong Claude Code và Claude Desktop: cài qua menu Plugins của app, **không hack, không sửa file của app**. Bạn bật, tắt, gỡ bất cứ lúc nào.
- ✅ Mã nguồn mở hoàn toàn trong repo này, bạn đọc được từng dòng trước khi cài.
- ⚠️ Đây là **dự án cá nhân, không phải sản phẩm của Anthropic** và không được Anthropic kiểm duyệt hay bảo trợ. "Claude" là thương hiệu của Anthropic.
- ⚠️ Hệ thống mod của Claude đang ở giai đoạn **thử nghiệm (early access)**: bản cập nhật app sau này có thể làm mod cần sửa lại.

### Quyền riêng tư

- **`thong-ke-token`** chỉ **đọc** lịch sử chat Claude lưu sẵn trên máy bạn (`~/.claude/projects`) để cộng token. Không gửi dữ liệu đi đâu. File cache nằm trong thư mục mod.
- **`tele-bridge`** chỉ kết nối tới `api.telegram.org`. Bot token và Chat ID lưu trong `tele-bridge/config.local.json` **trên máy bạn**. Bot chỉ nhận lệnh từ đúng Chat ID đã lưu, tin nhắn của người khác bị bỏ qua.

## Cài đặt

**Yêu cầu:** Claude Desktop (tab Code) hoặc Claude Code, và [Node.js](https://nodejs.org) (mod thống kê dùng Node để đọc lịch sử chat).

**Trên Claude Desktop:** bấm **+** cạnh ô chat → **Plugins** → **Add marketplace** → nhập:

```
cuong404vn/claude-desktop-mods
```

rồi chọn **Add plugin** cho `thong-ke-token` và `tele-bridge`.

**Trên Claude Code (terminal):** gõ trong ô chat

```
/plugin install thong-ke-token --marketplace cuong404vn/claude-desktop-mods
```

```
/plugin install tele-bridge --marketplace cuong404vn/claude-desktop-mods
```

Cài xong, mở phiên chat mới (hoặc gõ `/reload-plugins`) là thấy nút.

## Dùng mod Telegram

1. Trên Telegram, nhắn **@BotFather** → `/newbot` → đặt tên → nhận **bot token**. Nên tạo bot riêng cho mod này, đừng dùng chung với plugin khác (hai nơi cùng dùng một bot sẽ tranh tin nhắn).
2. Nhắn **@userinfobot** để lấy **Chat ID** của bạn.
3. Trong Claude, bấm nút **Tele** → nhập Chat ID và Bot token → **Lưu**. Bot sẽ nhắn chào bạn trên Telegram là đã thông.
4. Trước khi ra ngoài: kiểm tra nút đang 🟢. Mỗi lúc chỉ một phiên nghe bot; bật ở phiên khác thì phiên cũ tự nhường.

Lệnh trên Telegram: `/stop` dừng việc Claude đang làm · `/status` xem Claude đang làm hay đang chờ.
Lệnh trong Claude: `/tele` mở cài đặt · `/tele on` · `/tele off` · `/token` mở thống kê.

**Lưu ý:** máy tính phải bật và Claude Desktop phải mở. Khi Claude hỏi quyền chạy lệnh, bot chỉ báo 🔔 cho bạn, không bấm "Cho phép" thay bạn được. Muốn chạy trơn khi vắng mặt, để phiên ở chế độ quyền tự động.

## Giấy phép

[MIT](LICENSE): dùng, sửa, chia sẻ thoải mái, giữ lại ghi công tác giả.

---

<a id="english"></a>

# English

Mods for **Claude Desktop** (Code tab) and **Claude Code**: a token-stats button and Telegram remote control, right above the chat box.

Author: **Nguyễn Mạnh Cường** · Website: **[vidtools.net](https://vidtools.net)**

## What's inside

| Mod | What it does |
| --- | --- |
| **`thong-ke-token`** | A **📊 Thống kê token** (token stats) button. Opens a pane with tokens and active time for this session and month-to-date, session count, estimated cost, and your account's 5-hour / 7-day rate limits. |
| **`tele-bridge`** | A **Tele** button (🟢 listening · 🔴 off/error · 🟡 waiting to pair). Message your Telegram bot → it goes straight into the Claude session; when Claude finishes, the answer is sent back to Telegram. For when you're away from your computer. |

The UI text is in Vietnamese.

## Is it safe and allowed?

- ✅ Built on the **official plugin / mod system** of Claude Code and Claude Desktop: installed through the app's Plugins menu, **no hacks, no patching of app files**. Enable, disable or remove it any time.
- ✅ Fully open source: read every line before installing.
- ⚠️ A **personal project, not an Anthropic product**, and not reviewed or endorsed by Anthropic. "Claude" is a trademark of Anthropic.
- ⚠️ Claude's mod system is in **early access**: future app updates may require changes to these mods.

### Privacy

- **`thong-ke-token`** only **reads** the chat history Claude already stores on your machine (`~/.claude/projects`) to sum tokens. Nothing is sent anywhere. Its cache stays in the mod folder.
- **`tele-bridge`** only talks to `api.telegram.org`. The bot token and Chat ID are stored in `tele-bridge/config.local.json` **on your machine**. The bot only accepts messages from the saved Chat ID; everyone else is ignored.

## Install

**Requires:** Claude Desktop (Code tab) or Claude Code, and [Node.js](https://nodejs.org) (the stats mod uses Node to read the chat history).

**Claude Desktop:** click **+** next to the chat box → **Plugins** → **Add marketplace** → enter `cuong404vn/claude-desktop-mods`, then **Add plugin** for `thong-ke-token` and `tele-bridge`.

**Claude Code (terminal):**

```
/plugin install thong-ke-token --marketplace cuong404vn/claude-desktop-mods
```

```
/plugin install tele-bridge --marketplace cuong404vn/claude-desktop-mods
```

Then start a new session (or run `/reload-plugins`).

## Using the Telegram mod

1. On Telegram, message **@BotFather** → `/newbot` → get a **bot token**. Use a bot dedicated to this mod (two programs polling one bot fight over its messages).
2. Message **@userinfobot** to get your **Chat ID**.
3. In Claude, click **Tele** → enter the Chat ID and bot token → **Lưu** (Save). The bot greets you on Telegram when it's connected.
4. Before leaving, check the button shows 🟢. Only one session listens at a time.

Telegram commands: `/stop` stops Claude's current work · `/status` shows whether Claude is busy.
Claude commands: `/tele` settings · `/tele on` · `/tele off` · `/token` stats.

**Note:** your computer must stay on with Claude Desktop open. When Claude asks for permission, the bot only notifies you (🔔); it can't approve for you. Use auto permission mode for unattended runs.

## License

[MIT](LICENSE).
