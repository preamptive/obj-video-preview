# obj-video-preview

A lightweight single-page viewer for previewing a `.obj` model with a video, image, or live NDI stream mapped across its UVs as a texture. Vanilla JavaScript, [three.js](https://threejs.org/), and [Vite](https://vitejs.dev/) — no framework.

## Features

- Drag-and-drop (or file picker) loading of a `.obj` model and a `.mp4` video / `.jpg` / `.png` image
- Optional live NDI source input, with an in-app dropdown of NDI sources discovered on your network
- Orbit camera with damping, auto-framing, and low-angle views
- Camera-relative studio lighting, an infinite grid floor, and a fake contact shadow
- Handles missing UVs, inverted face winding, and unsupported video codecs gracefully

## Quick start

Requires [Node.js](https://nodejs.org/) 18+.

```bash
npm install
npm run dev
```

Open the printed `http://localhost:5173` URL (or whichever port Vite picks). Drop a `.obj` file and a `.mp4`/`.jpg`/`.png` onto the page, or use the Browse buttons.

That's it for the core viewer — video/image texture support has no extra setup, on Windows, macOS, or Linux.

## NDI support (optional)

The NDI source dropdown talks to a small Node server embedded in the Vite dev process (see `vite.config.js`), backed by [`@stagetimerio/grandiose`](https://github.com/stagetimerio/grandiose), a native Node addon for the NDI SDK.

Because it's a native addon, it needs a C++ toolchain **at `npm install` time** to compile. It's listed as an `optionalDependency`, so if the build fails, `npm install` still succeeds and the rest of the app works normally — you just won't see any sources in the NDI dropdown (it'll show a "server unavailable" toast if you try).

To enable it:

**Windows**
1. Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio) (or full Visual Studio) with the **"Desktop development with C++"** workload. Make sure the workload actually includes the MSVC compiler/linker and a Windows SDK — some installer defaults skip them even when the workload shows as installed. If `npm install` still can't find a usable VS install afterward, open the Visual Studio Installer, click Modify, and confirm both "MSVC v143 build tools" and a "Windows 10/11 SDK" are checked.
2. Re-run `npm install` (or just `npm install @stagetimerio/grandiose` to retry that one package).

**macOS**
1. Install the Xcode Command Line Tools: `xcode-select --install`
2. Re-run `npm install`.

**Linux**
1. Install a C/C++ toolchain and Python 3, e.g. on Debian/Ubuntu: `sudo apt install build-essential python3`
2. Re-run `npm install`.

In all cases the actual NDI SDK is downloaded automatically by the package during install — you don't need to install the NDI SDK yourself. You will need an NDI source on your network to actually see anything in the dropdown (e.g. the free [NDI Tools](https://ndi.video/tools/), an app with NDI output like After Effects with an NDI output plugin, or OBS with the NDI plugin).

### Troubleshooting

- **`npm install` fails compiling `@stagetimerio/grandiose` even with the toolchain installed**: check the error for which specific piece is missing (VS install, compiler, or Windows SDK) — the installer often installs the workload shell without the actual compiler/SDK components. See the Windows steps above.
- **node-gyp reports a header file "not found" that demonstrably exists on disk**: this shows up in some sandboxed/virtualized dev environments where `%LOCALAPPDATA%` (Windows) is redirected to an app-container-private folder that child build processes can't resolve. Point node-gyp's cache somewhere unredirected before installing:
  ```bash
  # Windows (PowerShell)
  $env:npm_config_devdir = "C:\ndi-build-cache"
  npm install
  ```
  This isn't something you'll hit on a normal, non-sandboxed machine.
- **Sources appear in the dropdown but connecting shows no image**: check the terminal running `npm run dev` for `[ndi]` errors. If After Effects (or another sender) interleaves non-video frames, you'd see a "Non-video data received" error — this is already handled in `vite.config.js`, so if you see it, something upstream of that fix changed.
- **The dropdown gets stuck on "Searching…" forever**: restart `npm run dev` — Vite config changes (and this file counts) require a full restart, not just a page refresh.

## Project structure

```
index.html        entry HTML + UI markup
src/main.js        scene setup, loaders, UI wiring
src/style.css       styling
vite.config.js      dev server + embedded NDI discovery/streaming plugin
```

## License

MIT — see [LICENSE](LICENSE).
