import { NextRequest } from 'next/server';
import path from 'path';
import os from 'os';
import { createReadStream } from 'fs';
import { stat, unlink } from 'fs/promises';
import { getPostHogClient } from '@/lib/posthog-server';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const fileId = searchParams.get('fileId');
  const title = searchParams.get('title') || 'video';

  // Prevent path traversal
  if (!fileId || !/^vortex-[a-f0-9\-]+\.mp4$/.test(fileId)) {
    return new Response('Invalid file ID', { status: 400 });
  }

  // Ignore secondary requests from browsers (HEAD probes, retries, double clicks).
  if (request.method === 'HEAD') {
    return new Response(null, { status: 204 });
  }

  const tmpFilePath = path.join(os.tmpdir(), fileId);
  const safeFilename = `${title.replace(/[^\w\s\-]/gi, '').trim().replace(/\s+/g, '_')}.mp4`;

  try {
    const fileStats = await stat(tmpFilePath);

    // Track successful file serve before streaming
    const posthog = getPostHogClient();
    posthog.capture({
      distinctId: 'anonymous',
      event: 'video_file_served',
      properties: { file_size_mb: Math.round(fileStats.size / (1024 * 1024) * 10) / 10 },
    });
    await posthog.shutdown();

    const stream = createReadStream(tmpFilePath);

    const readableStream = new ReadableStream({
      start(controller) {
        stream.on('data', (chunk) => {
          controller.enqueue(chunk);
        });
        stream.on('end', async () => {
          controller.close();
          // Clean up the temporary file
          await unlink(tmpFilePath).catch(console.error);
        });
        stream.on('error', async (err) => {
          console.error("File stream error:", err);
          controller.error(err);
          // Clean up the temporary file
          await unlink(tmpFilePath).catch(console.error);
        });
      },
      cancel() {
        stream.destroy();
        // Clean up the temporary file on user cancel
        unlink(tmpFilePath).catch(console.error);
      }
    });

    return new Response(readableStream, {
      headers: {
        'Content-Disposition': `attachment; filename="${safeFilename}"`,
        'Content-Type': 'video/mp4',
        'Content-Length': fileStats.size.toString(),
      },
    });
  } catch (error: any) {
    // File already served and cleaned up (or expired) — not a server error.
    if (error.code === 'ENOENT') {
      console.warn(`Temp file not found (already downloaded or expired): ${fileId}`);
      return new Response('This download has expired or was already completed. Please process the video again.', { status: 404 });
    }
    console.error('Error serving video:', error);
    // Attempt to clean up temp file if something failed
    await unlink(tmpFilePath).catch(() => {});
    const posthog = getPostHogClient();
    posthog.capture({
      distinctId: 'anonymous',
      event: 'video_file_serve_failed',
      properties: {},
    });
    await posthog.shutdown();
    return new Response(`Failed to serve video: ${error.message}`, { status: 500 });
  }
}
