import { NextRequest } from 'next/server';
import { create } from 'youtube-dl-exec';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { unlink } from 'fs/promises';

const ytDlpPath = path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp');
const youtubedl = create(ytDlpPath);

const isWin = os.platform() === 'win32';
const ffmpegPath = path.join(process.cwd(), 'node_modules', 'ffmpeg-static', isWin ? 'ffmpeg.exe' : 'ffmpeg');

const isValidUrl = (url: string) => {
  return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/.test(url);
};

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const url = searchParams.get('url');

  if (!url || !isValidUrl(url)) {
    return new Response('Invalid YouTube URL', { status: 400 });
  }

  const fileId = `vortex-${crypto.randomUUID()}`;
  const tmpFileName = `${fileId}.mp4`;
  const tmpFilePath = path.join(os.tmpdir(), tmpFileName);

  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (data: any) => {
        try {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch (e) {
          // Stream might have been closed by the client
        }
      };

      try {
        // Fetch metadata first to get the title
        sendEvent({ status: 'info', message: 'Fetching metadata...' });
        let videoTitle = 'Video';
        try {
          const info: any = await youtubedl(url, {
            dumpJson: true,
            noWarnings: true,
            noPlaylist: true,
            noCheckCertificates: true,
          });
          if (info && info.title) {
            videoTitle = info.title;
            sendEvent({ status: 'info', title: videoTitle });
          }
        } catch (metaErr: any) {
          console.error("Failed to fetch metadata:", metaErr.message);
          // Continue with download even if metadata fails
        }

        const subprocess = youtubedl.exec(url, {
          output: tmpFilePath,
          format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
          mergeOutputFormat: 'mp4',
          ffmpegLocation: ffmpegPath || undefined,
          concurrentFragments: 4,
          noCheckCertificates: true,
          noWarnings: true,
          preferFreeFormats: true,
          noPlaylist: true,
        } as any);

        subprocess.catch((err) => {
          // Prevent unhandled promise rejections which crash the Next.js dev server
          console.error("Child process promise rejected:", err.message);
        });

        let phase = 1;
        let lastProgress = 0;
        let errorLog = '';

        if (subprocess.stderr) {
          subprocess.stderr.on('data', (chunk) => {
            errorLog += chunk.toString();
          });
        }

        if (subprocess.stdout) {
          subprocess.stdout.on('data', (chunk) => {
            const output = chunk.toString();
            // Match progress: [download]  14.0%
            const progressMatch = output.match(/\[download\]\s+(\d+\.\d+)%/);
            if (progressMatch) {
              const progress = parseFloat(progressMatch[1]);
              
              // Detect phase change (e.g., video finished, audio starts)
              if (progress < lastProgress - 50) {
                phase++;
              }
              lastProgress = progress;
              
              sendEvent({ status: 'processing', progress, phase });
            }

            // Match merge phase
            if (output.includes('Merging formats into')) {
              sendEvent({ status: 'merging', progress: 100, phase });
            }
          });
        }

        subprocess.on('close', async (code) => {
          if (code === 0) {
            sendEvent({ status: 'ready', fileId: tmpFileName });
          } else {
            console.error("yt-dlp error log:", errorLog);
            sendEvent({ status: 'error', message: `yt-dlp exited with code ${code}. Check server logs.` });
            await unlink(tmpFilePath).catch(() => {});
          }
          try { controller.close(); } catch(e){}
        });

        subprocess.on('error', async (err) => {
          sendEvent({ status: 'error', message: err.message });
          await unlink(tmpFilePath).catch(() => {});
          try { controller.close(); } catch(e){}
        });

        // Cleanup if client disconnects
        request.signal.addEventListener('abort', () => {
          subprocess.kill();
          unlink(tmpFilePath).catch(() => {});
        });

      } catch (err: any) {
        sendEvent({ status: 'error', message: err.message });
        await unlink(tmpFilePath).catch(() => {});
        try { controller.close(); } catch(e){}
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
