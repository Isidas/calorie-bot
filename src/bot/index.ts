import { Telegraf } from 'telegraf';
import { onStart, onNonPhoto, createPhotoHandler } from './handlers';
import type { DishService } from '../services/dish-service';
import type { ImageWithMime, ImageMimeType } from '../types';
import { withTelegramRetry } from './telegram-retry';
import { fetchWithKeepAlive } from '../http-agent';

const FILE_DOWNLOAD_TIMEOUT_MS = 25_000;

const DEFAULT_MIME: ImageMimeType = 'image/jpeg';

function mimeFromPath(filePath: string): ImageMimeType {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return DEFAULT_MIME;
}

/**
 * Получает файл по file_id через Telegraf API, скачивает по прямой ссылке
 * и возвращает буфер и mimeType (по расширению file_path, иначе image/jpeg).
 */
function createGetFileBuffer(
  botToken: string,
  bot: Telegraf
): (fileId: string) => Promise<ImageWithMime> {
  return async (fileId: string): Promise<ImageWithMime> => {
    const file = await withTelegramRetry(() => bot.telegram.getFile(fileId));
    const path = file.file_path;
    if (!path) throw new Error('No file path');
    const mimeType = mimeFromPath(path);
    const url = `https://api.telegram.org/file/bot${botToken}/${path}`;

    const doFetch = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FILE_DOWNLOAD_TIMEOUT_MS);
      try {
        const response = await fetchWithKeepAlive(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Download failed: ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        return { buffer: Buffer.from(arrayBuffer), mimeType };
      } finally {
        clearTimeout(timeoutId);
      }
    };
    return withTelegramRetry(doFetch);
  };
}

export function createBot(token: string, dishService: DishService): Telegraf {
  const bot = new Telegraf(token);
  const getFileBuffer = createGetFileBuffer(token, bot);

  bot.start(onStart);
  bot.on('photo', createPhotoHandler(dishService, getFileBuffer));
  bot.on('message', onNonPhoto);

  bot.catch((err, ctx) => {
    console.error('[Calorie Bot] Unhandled error:', err);
    const chatId = ctx.chat?.id;
    if (chatId) {
      withTelegramRetry(() =>
        ctx.telegram.sendMessage(chatId, 'Произошла ошибка. Попробуйте ещё раз через несколько секунд.')
      ).catch(() => {});
    }
  });

  return bot;
}
