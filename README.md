# Claude Desktop Mods

**Tiếng Việt** · [English](#english)

Bộ mod cho **Claude Desktop** (tab Code) và **Claude Code**: thêm nút thống kê token và điều khiển phiên Claude từ Telegram ngay cạnh ô chat.

Tác giả: **Nguyễn Mạnh Cường** · Website: **[vidtools.net](https://vidtools.net)**

---

## Có gì trong bộ mod

| Mod | Làm gì |
| --- | --- |
| **`thong-ke-token`** | Nút **📊 Thống kê token** trên ô chat. Mở pane xem: token và thời gian hoạt động của phiên này, của cả tháng (tính từ ngày 1), số phiên, chi phí ước tính, biểu đồ token theo ngày (7 ngày hoặc cả tháng), hạn mức 5 giờ / 7 ngày của tài khoản. |
| **`tele-bridge`** | Nút **Tele** (🟢 phiên này đang bật · 🔴 tắt/lỗi). Bật cho một hay nhiều phiên, chọn phiên trên Telegram bằng nút bấm, nhắn tin → vào thẳng phiên đó; Claude làm xong → câu trả lời gửi lại Telegram. Dùng khi bạn ra ngoài, không ngồi máy. |

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
4. **Bật phiên:** phiên chat mới mặc định 🔴 tắt. Ở phiên nào muốn điều khiển từ xa, bấm **Tele** → **Bật** để chuyển 🟢. Bật nhiều phiên cùng lúc được. Mod nhớ lựa chọn này: đóng app mở lại, phiên đã bật tự 🟢 lại khi bạn mở phiên đó. **Mẹo:** bấm nút **Tele** 1 lần để mở cài đặt, bấm nhanh **2 lần** để bật/tắt phiên này ngay.
5. **Chọn phiên trên Telegram:** bấm nút **📋 Chọn phiên** (hoặc gõ `/phien`) → bấm tên phiên. 🔵 là phiên đang trò chuyện, 🟢 là các phiên đang bật khác. Từ đó tin nhắn của bạn đi vào phiên đó. Mỗi câu trả lời có tên phiên ở đầu, ví dụ `[Tên phiên] ...`.

**Chỉ việc giao từ Telegram mới được báo về Telegram.** Bạn chat trực tiếp trên máy (kể cả ở phiên đang 🟢) thì không có gì gửi lên Telegram. Một phiên bạn đã giao việc rồi chuyển sang phiên khác, khi làm xong vẫn báo `✅ [Tên phiên] đã xong`.

**Gửi ảnh, file qua lại**
- **Telegram → Claude:** gửi ảnh hoặc file cho bot (kèm chú thích nếu muốn). Mod lưu vào thư mục `tele-bridge/inbox` trên máy và báo Claude đường dẫn để Claude mở xem.
- **Claude → Telegram:** nhờ Claude, ví dụ *"gửi file báo cáo này qua tele"* hay *"chụp màn hình rồi gửi tele cho tôi"*. Ảnh đến dạng ảnh, file khác dạng tài liệu (tối đa 50 MB).

**Báo cả việc giao trên máy:** bạn giao việc dài ở máy rồi ra ngoài? Mở pane Telegram → **🔔 Báo cả việc giao trên máy → Bật**. Từ đó phiên này báo về Telegram mọi việc làm xong, kể cả việc bạn gõ ở máy. Về máy thì tắt đi.

**Nút bấm nhanh trên Telegram** (không cần gõ): dưới ô chat có **📋 Chọn phiên · ℹ️ Trạng thái · ⏹ Dừng**; tin "đã nhận" có nút **⏹ Dừng**; mỗi câu trả lời có nút **📋 Đổi phiên · ℹ️ Trạng thái**. Không thấy các nút thì gõ `/start`.
Lệnh trong Claude: `/tele` mở cài đặt · `/tele on` · `/tele off` · `/token` mở thống kê.

**Lưu ý:** máy tính phải bật và Claude Desktop phải mở. Khi Claude hỏi quyền chạy lệnh, bot chỉ báo 🔔 cho bạn, không bấm "Cho phép" thay bạn được. Muốn chạy trơn khi vắng mặt, để phiên ở chế độ quyền tự động.

## Trang chat trên máy (không cần Telegram)

Mod `tele-bridge` còn có một **trang chat chạy ngay trên máy bạn**: chọn phiên 🟢, nhắn tin, gửi ảnh/file, xem câu trả lời, giống giao diện chat.

1. Bấm nút **Tele** → mục **🌐 Trang chat trên máy** → **Bật**. Cần ít nhất một phiên 🟢.
2. Pane hiện địa chỉ, ví dụ `http://localhost:8787`, bấm **Mở** là vào.
3. **Mở từ máy khác trong nhà** (mini PC, điện thoại cùng wifi): đặt **mật khẩu** (từ 6 ký tự) → bật **🏠 Cho máy khác cùng mạng nhà vào**. Pane hiện thêm địa chỉ kiểu `http://192.168.1.5:8787`. Lần đầu Windows có thể hỏi cho phép Node.js truy cập mạng: chọn mạng riêng (Private).

**Chỉ dùng cho riêng bạn.** Tài khoản Claude là cá nhân: không đưa trang hay mật khẩu cho người khác dùng, không mở trang ra Internet, không bật chế độ cùng mạng ở wifi công cộng. Trang chạy bằng http trong mạng nhà, tin nhắn không qua máy chủ bên ngoài nào.

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
| **`thong-ke-token`** | A **📊 Thống kê token** (token stats) button. Opens a pane with tokens and active time for this session and month-to-date, session count, estimated cost, a daily token chart (last 7 days or the whole month), and your account's 5-hour / 7-day rate limits. |
| **`tele-bridge`** | A **Tele** button (🟢 this session is on · 🔴 off/error). Turn it on in one or more sessions, pick a session on Telegram with buttons, and your messages go straight into it; when Claude finishes, the answer comes back to Telegram. For when you're away from your computer. |

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
4. **Turn sessions on:** a new session starts 🔴 off. In each session you want to control remotely, click **Tele** → **Bật** (On) to make it 🟢. Several sessions can be 🟢 at once. The choice is remembered: after an app restart a 🟢 session is 🟢 again once you open it. **Tip:** click **Tele** once to open the settings, **double-click** it to turn this session on/off right away.
5. **Pick a session on Telegram:** tap **📋 Chọn phiên** (or send `/phien`) and tap a session name. 🔵 is the session you're talking to, 🟢 the other sessions that are on. Your messages then go to that session; each answer is headed by the session's name.

**Only work sent from Telegram is reported to Telegram.** Chatting at the computer (even in a 🟢 session) sends nothing. A session you gave a task to and then switched away from still reports `✅ [name] đã xong` (done) when it finishes.

**Photos and files, both ways**
- **Telegram → Claude:** send a photo or file to the bot (with a caption if you like). The mod saves it in `tele-bridge/inbox` on the computer and gives Claude the path.
- **Claude → Telegram:** ask Claude, e.g. *"send this report to Telegram"* or *"take a screenshot and send it to me on Telegram"*. Images arrive as photos, other files as documents (50 MB max).

**Report work given at the computer too:** leaving a long task running? In the Telegram pane, turn **🔔 Báo cả việc giao trên máy** on: the session then reports every finished task to Telegram, including what you typed at the computer. Turn it off when you're back.

**Quick buttons on Telegram:** a keyboard under the chat box (**Chọn phiên** / pick session · **Trạng thái** / status · **Dừng** / stop), a **Dừng** button on each "received" message, and **Đổi phiên** / **Trạng thái** under every answer. Send `/start` if the buttons don't show.
Claude commands: `/tele` settings · `/tele on` · `/tele off` · `/token` stats.

**Note:** your computer must stay on with Claude Desktop open. When Claude asks for permission, the bot only notifies you (🔔); it can't approve for you. Use auto permission mode for unattended runs.

## Local chat page (no Telegram needed)

`tele-bridge` also runs a **chat page on your own computer**: pick a 🟢 session, send messages, photos and files, read the answers.

1. Click **Tele** → **🌐 Trang chat trên máy** (chat page) → **Bật** (On). At least one session must be 🟢.
2. The pane shows the address, e.g. `http://localhost:8787`; click **Mở** (Open).
3. **From another device at home** (a mini PC, a phone on the same Wi-Fi): set a **password** (6+ characters), then turn on **🏠 Cho máy khác cùng mạng nhà vào** (allow devices on the home network). The pane adds an address like `http://192.168.1.5:8787`. Windows may ask once to let Node.js use the network: choose Private networks.

**For your own use only.** A Claude account is personal: don't let other people use the page or share its password, don't expose it to the Internet, and don't enable network access on public Wi-Fi. The page uses plain http inside your home network; messages don't pass through any outside server.

## License

[MIT](LICENSE).
