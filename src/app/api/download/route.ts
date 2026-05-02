import { NextRequest } from 'next/server';
import path from 'path';
import os from 'os';
import { createReadStream } from 'fs';
import { stat, unlink } from 'fs/promises';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const fileId = searchParams.get('fileId');
  const title = searchParams.get('title') || 'video';

  // Prevent path traversal
  if (!fileId || !/^vortex-[a-f0-9\-]+\.mp4$/.test(fileId)) {
    return new Response('Invalid file ID', { status: 400 });
  }

  const tmpFilePath = path.join(os.tmpdir(), fileId);
  const safeFilename = `${title.replace(/[^\w\s\-]/gi, '').trim().replace(/\s+/g, '_')}.mp4`;

  try {
    const fileStats = await stat(tmpFilePath);
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
    console.error('Error serving video:', error);
    // Attempt to clean up temp file if something failed
    await unlink(tmpFilePath).catch(() => {});
    return new Response(`Failed to serve video: ${error.message}`, { status: 500 });
  }
}
