# Momotombo Windows test checklist

This checklist is for trying the Windows version of Momotombo on a real Windows 10 or 11 computer. No technical knowledge is needed. Each step says **what to do**, **what you should see** and **what to note if it did not happen**. At the end there is a list of what to send us.

**Time:** about 10 minutes. The **If you have time** section is optional.

**Language:** on first launch Momotombo opens in Spanish or English, following the computer's language. Spanish is the app's main language. Button names below are given in English.

**Note:** the text in Windows' own windows (SmartScreen, Settings) may read slightly differently on your screen.

## What you need
- Windows 10 or 11, 64-bit.
- The `Momotombo-<version>-windows-x64.zip` file (from the GitHub **Releases** page). The zip is about 150 MB and takes about 420 MB once extracted (measured on the 0.1.0 test package). Recordings and exported videos also need some space.
- A camera and a microphone (a laptop's built-in camera and microphone are enough).
- A browser (Edge or Chrome), to open the WebM file.
- Windows' **Paint** app, for the color and shape check (step 4).

## Before you start
Note your Windows version: **Settings › System › About**. The "Edition" and "Version" lines are enough. If the edition name ends in **N** (for example "Windows 11 Pro N"), write that down too.

## 1. Install (1–2 min)
**Do:** Right-click the zip file and extract it to a folder with **Extract All**. Do not open the app from inside the zip. In the extracted folder, open the `Momotombo` folder and double-click `Momotombo.exe`.

**You should see:** A blue **"Windows protected your PC"** window. Click **More info**, then **Run anyway**.

**If not, note:**
- If the "Run anyway" button never appeared, or the app was blocked by **Smart App Control**: the exact text of the window, and a screenshot if possible. (The test ends here in that case; we are not asking you to turn the setting off.)
- If another error appeared: the error text.

## 2. Microsoft component terms (1 min)
**You should see:** Before the app window opens, a small window: **Terms for a Microsoft component**, "On Windows, Momotombo uses a file from Microsoft". Three buttons: **I accept**, **Read the terms**, **I do not accept**.

**Do:** Click **I accept** once.

**You should see:** The window closes and Momotombo **reopens by itself** within a few seconds. The main screen shows the **Projects** heading and the **Start recording** button.

**If not, note:** If Momotombo did not reopen, open `Momotombo.exe` yourself and write down whether the terms were asked again. If an error appeared, note its text.

## 3. Recording settings (1 min)
**Do:** Click the **Start recording** button. Make sure **Screen** is selected as the **Recording type**. Turn on the **Camera** and **Microphone** switches.

**You should see:** A device name for the camera and for the microphone. The **microphone level** bar moves when you speak.

**If not, note:** Write it down if the camera or microphone is not in the list or the bar never moves. (If needed, **Settings › Privacy & security › Camera / Microphone › Let desktop apps access…** must be on.)

## 4. Recording (1–2 min)
**Do (before recording, for color and shape):** Open Windows' **Paint** app. With a thick brush, make four separate blobs: **red**, **green**, **blue** and **magenta (purple-pink)**. Then choose the **Ellipse** tool from the shapes and, holding **Shift**, draw a large **circle**. Leave the Paint window open on screen; it will show in the recording. (Spend no more than a minute; it does not need to be neat.)

**Do:** Go back to Momotombo and click the **Start recording** button. After the countdown, record for about **20 seconds**:
- Talk during the recording (for example "one, two, three…").
- Click **4–5 different places** far apart on the screen (for example files in a folder window, the Start button). Wait 2–3 seconds after each click.
- Make a few of the clicks on the Paint window, so the colors and the circle show clearly in the recording.

To finish, press the **Finish** button on the small bar shown on screen during recording, or press **Alt+Shift+S**. (If the shortcut is shown with other symbols on screen, for example **⌥⇧S**, the Windows equivalent is still Alt+Shift+S; note that too.)

**You should see:** Momotombo's window opens again and the recording appears in the editor (with the timeline).

**If not, note:** If the recording did not start or did not finish, write down what you saw and the error text.

## 5. Automatic zoom, camera and sound (2 min)
**You should see:**
- **Zoom** blocks on the timeline near the moments you clicked (automatic zoom suggestions are created by themselves the first time the recording opens).
- **Your camera picture** in a separate frame on top of the screen recording in the preview.

**Do:** Play the recording from the start with the space bar or the **Play** button.

**You should see:**
- The picture zooms in near the places you clicked.
- Your voice can be heard.
- **The colors match the screen:** red in Paint looks red, green green, blue blue, magenta magenta. (For example, magenta showing as green is a bug.)
- **The circle is still a circle:** not squashed or stretched. If Momotombo showed a warning like "The screen picture arrived squeezed…", note its text; this is a known case.

**If not, note:** If the colors differ or the circle is distorted: take a screenshot of **both** the Paint window and the Momotombo preview (**Windows logo key + Shift + S**) and write which color turned into what (for example "magenta → green"). Write it down if there are no zoom blocks or they are far from the clicks, if the camera does not show, or if there is no sound. If there is no zoom, also write whether Momotombo showed a message.

## 6. MP4 export (2 min)
**Do:** Click the **Export** button in the editor (or **Ctrl+E**). Make sure the format is **MP4 · H.264**.

**Note (very important):** Write down exactly what the **Encoder:** line in the window says. It is expected to be one of three:
- `H.264 · hardware + AAC`: the graphics card is used;
- `H.264 · Windows software encoder (slower) + AAC`;
- "This computer has no H.264 encoder for MP4…" (the video will be saved as WebM (VP9 + Opus) instead).

**Do:** Check where the file will be saved on the **Save to** line (use **Change…** if you like), then press **Export**.

**You should see:** A progress bar, then **Done**. Find the file with **Show in folder** and double-click it to open it in Windows' own player.

**You should see:** Picture **and** sound, with the zooms and camera as in the preview. The Paint colors and the circle also match the screen here.

**If not, note:** About how long the export took, the error text, whether the player shows only sound or only picture, the message "Saved as WebM instead of MP4." if it appeared, and a screenshot of the player if the colors or the circle differ.

## 7. WebM export (1 min)
**Do:** **Export** again, this time with the **WebM · VP9** format. Press **Export**.

**You should see:** **Done**. Drag the file into a browser window (Edge or Chrome): picture and sound play; the colors and the circle match the screen.

**If not, note:** The error text; whether there is no picture or no sound in the browser; a screenshot of the playing video if the colors or the circle differ.

## 8. Quick checks (1 min)
- **Undo:** Click a zoom block on the timeline, delete it with the **Delete** key, then press **Ctrl+Z**. *You should see:* the block comes back.
- **Close and reopen:** Close Momotombo (the × at the top right of the window) and open it again with `Momotombo.exe`. *You should see:* the terms are **not** asked again and your recording is in the **Projects** list.

**If not, note:** Which one did not work.

## If you have time
- **System audio:** In a new recording, turn on the **System audio** switch and play a sound or music on the computer during the recording. Can you hear it in the exported video?
- **Window** and **Region** recording: try the same steps with these types.
- **4K** export: choose 4K as the **Resolution** and write down how long it took.
- **A second display**, or a display whose scale is not 100% (for example 125%, 150%): are the recording and the click positions correct?

## Send us
- Windows edition and version (**Settings › System › About**); whether it ends in **N**.
- Graphics card: the name under **Device Manager › Display adapters**.
- Screen resolution and scale: "Display resolution" and "Scale" under **Settings › System › Display**.
- The number of the step where you got stuck and the error text you saw (exactly).
- If possible, a screenshot of where you got stuck (with no personal information visible).
- The **Encoder:** line from step 6.
- The result of the color and circle check (steps 5, 6 and 7): did the colors match the screen in the preview, the MP4 and the WebM, and was the circle a circle? If not, which color turned into what, and two screenshots (Paint, and the Momotombo preview or the playing video).
- The two exported files (MP4 and WebM). If personal information shows in the recording, tell us before sending them.
