import { NextRequest } from 'next/server';
import { create } from 'youtube-dl-exec';
import { getPostHogClient } from '@/lib/posthog-server';
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
            jsRuntimes: 'node',
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
          jsRuntimes: 'node',
        } as any);

        subprocess.catch((err) => {
          // Prevent unhandled promise rejections which crash the Next.js dev server
          console.error("Child process promise rejected:", err.message);
        });

        let phase = 1;
        let lastProgress = 0;
        let errorLog = '';
        // Set to true once yt-dlp finished successfully and the file was
        // handed off to /api/download — from that point the download route
        // owns cleanup, so an aborted SSE connection must NOT delete the file.
        let handedOff = false;

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
          const posthog = getPostHogClient();
          if (code === 0) {
            handedOff = true;
            sendEvent({ status: 'ready', fileId: tmpFileName });
            posthog.capture({
              distinctId: 'anonymous',
              event: 'video_download_completed',
              properties: { has_title: videoTitle !== 'Video', phases_completed: phase },
            });
          } else {
            console.error("yt-dlp error log:", errorLog);
            sendEvent({ status: 'error', message: `yt-dlp exited with code ${code}. Check server logs.` });
            posthog.capture({
              distinctId: 'anonymous',
              event: 'video_download_failed',
              properties: { exit_code: code, phase },
            });
            await unlink(tmpFilePath).catch(() => {});
          }
          await posthog.shutdown();
          try { controller.close(); } catch(e){}
        });

        subprocess.on('error', async (err) => {
          const posthog = getPostHogClient();
          sendEvent({ status: 'error', message: err.message });
          posthog.capture({
            distinctId: 'anonymous',
            event: 'video_download_failed',
            properties: { exit_code: null, phase },
          });
          await posthog.shutdown();
          await unlink(tmpFilePath).catch(() => {});
          try { controller.close(); } catch(e){}
        });

        // Cleanup if client disconnects — but never delete a file that was
        // successfully downloaded and is about to be (or already being) served.
        request.signal.addEventListener('abort', () => {
          subprocess.kill();
          if (!handedOff) {
            unlink(tmpFilePath).catch(() => {});
          }
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
