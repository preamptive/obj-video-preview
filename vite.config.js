import { defineConfig } from 'vite';
import { WebSocketServer } from 'ws';

// Embeds NDI discovery + frame streaming directly into the Vite dev server
// process, so the app stays a single command/port with no CORS to manage.
// Frontend talks to it over GET /api/ndi/sources and a WebSocket at /ws/ndi.
function ndiPlugin() {
  let grandiose = null;
  let finder = null;
  let currentSources = [];
  let activeReceiver = null;
  let receiveGeneration = 0;
  const clients = new Set();
  const wss = new WebSocketServer({ noServer: true });

  async function getGrandiose() {
    if (!grandiose) {
      try {
        const mod = await import('@stagetimerio/grandiose');
        grandiose = mod.default ?? mod;
      } catch {
        throw new Error(
          'NDI support is not installed on this server. It requires a C++ toolchain at install ' +
            'time (see README) — the rest of the app works fine without it.'
        );
      }
    }
    return grandiose;
  }

  async function ensureFinder() {
    if (finder) return;
    const g = await getGrandiose();
    finder = await g.find({ showLocalSources: true });
    (async () => {
      while (finder) {
        try {
          await finder.wait(2000);
          currentSources = finder.sources();
        } catch (err) {
          console.error('[ndi] finder error, will recreate on next request:', err);
          // Reset so the next /api/ndi/sources call re-initializes discovery instead
          // of leaving the source list frozen forever after a transient failure
          // (network sleep/wake, Wi-Fi toggle, etc.).
          finder = null;
          currentSources = [];
          return;
        }
      }
    })();
  }

  function stopReceiving() {
    receiveGeneration++;
    activeReceiver = null;
  }

  async function startReceiving(sourceName) {
    const g = await getGrandiose();
    const source = currentSources.find((s) => s.name === sourceName);
    if (!source) {
      throw new Error(`NDI source not found: ${sourceName}`);
    }
    stopReceiving();
    const myGeneration = receiveGeneration;

    const receiver = await g.receive({
      source,
      colorFormat: g.COLOR_FORMAT_RGBX_RGBA,
      bandwidth: g.BANDWIDTH_HIGHEST,
    });
    if (myGeneration !== receiveGeneration) return; // superseded while awaiting connect
    activeReceiver = receiver;

    (async () => {
      while (receiveGeneration === myGeneration) {
        let frame;
        try {
          frame = await receiver.video(2000);
        } catch (err) {
          // grandiose's receiver.video() rejects (rather than resolving null) both when
          // nothing new arrived within the timeout and when a non-video frame (metadata/
          // tally, etc.) was interleaved in the stream. Both are routine — a live NDI
          // stream is mostly gaps between frames from this call's point of view — so we
          // retry instead of tearing the receiver down. Only bail on a genuine failure
          // (e.g. the source disappearing), which is the "Connection lost" case.
          const msg = err?.message || '';
          if (msg.includes('No video data received') || msg.includes('Non-video data received')) {
            continue;
          }
          console.error('[ndi] receive error:', err);
          break;
        }
        if (!frame || receiveGeneration !== myGeneration) continue;

        const header = Buffer.alloc(12);
        header.writeUInt32LE(frame.xres, 0);
        header.writeUInt32LE(frame.yres, 4);
        header.writeUInt32LE(frame.lineStrideBytes, 8);
        const payload = Buffer.concat([header, frame.data]);

        for (const client of clients) {
          // Skip sends to a client that's still draining a backlog rather than
          // letting frames queue up unbounded and the preview fall further behind live.
          if (client.readyState === client.OPEN && client.bufferedAmount < 32 * 1024 * 1024) {
            client.send(payload);
          }
        }
      }
    })();
  }

  return {
    name: 'ndi-server',
    configureServer(server) {
      server.middlewares.use('/api/ndi/sources', async (req, res) => {
        try {
          await ensureFinder();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(currentSources));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (!req.url || !req.url.startsWith('/ws/ndi')) return; // leave Vite's own HMR ws alone
        wss.handleUpgrade(req, socket, head, (ws) => {
          clients.add(ws);

          ws.on('message', async (data) => {
            try {
              const msg = JSON.parse(data.toString());
              if (msg.type === 'subscribe') {
                await startReceiving(msg.source);
              } else if (msg.type === 'unsubscribe') {
                stopReceiving();
              }
            } catch (err) {
              ws.send(JSON.stringify({ type: 'error', message: String(err) }));
            }
          });

          ws.on('close', () => {
            clients.delete(ws);
            if (clients.size === 0) stopReceiving();
          });
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [ndiPlugin()],
});
