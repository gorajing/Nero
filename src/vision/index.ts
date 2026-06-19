import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileP = promisify(execFile);

const SCREEN_CAPTURE_BIN = '/usr/sbin/screencapture';
const MAX_CAPTURE_WIDTH = 1280;
const JPEG_QUALITY = 70;
const BLACK_MAX = 1;
const NEAR_BLACK_MEAN = 5;
const NEAR_BLACK_STDEV = 2;

export interface ScreenImage {
  b64: string;
  mime: 'image/jpeg';
}

export class BlackFrameError extends Error {
  constructor(message = 'Screen capture returned a black frame.') {
    super(message);
    this.name = 'BlackFrameError';
  }
}

export async function captureScreen(): Promise<ScreenImage> {
  const pngPath = join(tmpdir(), `nero-screen-${randomUUID()}.png`);

  try {
    try {
      await execFileP(SCREEN_CAPTURE_BIN, [
        '-x',
        '-t',
        'png',
        '-D',
        '1',
        pngPath,
      ]);
    } catch (error) {
      if (isScreenCaptureUnavailable(error)) {
        throw new BlackFrameError(
          'Screen capture could not create an image from the display. Grant Screen Recording to the process that launches Nero, then relaunch it.',
        );
      }
      throw error;
    }

    const png = await readFile(pngPath);
    const stats = await sharp(png).stats();

    if (isBlackFrame(stats)) {
      throw new BlackFrameError(
        'Screen capture returned an all-black or near-uniform frame. Grant Screen Recording to the process that launches Nero, then relaunch it.',
      );
    }

    const jpeg = await sharp(png)
      .resize({
        width: MAX_CAPTURE_WIDTH,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();

    return {
      b64: jpeg.toString('base64'),
      mime: 'image/jpeg',
    };
  } finally {
    await unlink(pngPath).catch(() => undefined);
  }
}

export async function askScreen(
  prompt: string,
  describe: (img: { b64: string; mime: string }) => Promise<string>,
): Promise<string> {
  void prompt;
  const image = await captureScreen();
  return describe(image);
}

function isBlackFrame(stats: sharp.Stats): boolean {
  const channels = stats.channels.slice(0, 3);
  if (channels.length === 0) return true;

  const allBlack = channels.every((channel) => channel.max <= BLACK_MAX);
  const nearUniformBlack = channels.every(
    (channel) =>
      channel.mean <= NEAR_BLACK_MEAN &&
      channel.stdev <= NEAR_BLACK_STDEV,
  );

  return allBlack || nearUniformBlack;
}

function isScreenCaptureUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === 'string' &&
    message.includes('could not create image from display')
  );
}
