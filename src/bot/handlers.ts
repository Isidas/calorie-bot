import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import type { DishService } from '../services/dish-service';
import type { DishAnalysis } from '../types';
import type { ClarificationQuestion } from '../services/dialog-state';
import { RateLimitError } from '../services';
import {
  shouldAskClarification,
  generateQuestion,
  applyCorrection,
} from '../services/clarification-service';
import { setDialog, getDialog, clearDialog } from '../services/dialog-state';
import { withTelegramRetry } from './telegram-retry';

const NOT_PHOTO_MESSAGE =
  'Отправьте, пожалуйста, фото блюда — по нему я оценю калорийность и БЖУ.';

const DISCLAIMER = 'Оценка приблизительная, не замена консультации специалиста.';

function formatResult(a: DishAnalysis): string {
  if (!a.is_food) {
    return `На фото не распознано блюдо. Отправьте чёткое фото еды.`;
  }

  const confidenceText =
    a.confidence === 'high'
      ? 'Оценка достаточно надёжная.'
      : a.confidence === 'medium'
        ? 'Оценка ориентировочная.'
        : 'Блюдо распознано нечётко — это примерная оценка.';

  const cal = a.calories_range;
  const calStr =
    cal.min === cal.max ? `${cal.min} ккал` : `${cal.min}–${cal.max} ккал`;

  const lines: string[] = [
    `🍽 ${a.dish}`,
    `📊 ~${a.weight_grams} г`,
    `🔥 ${calStr}`,
    `Б: ${a.protein} г · Ж: ${a.fat} г · У: ${a.carbs} г`,
  ];

  if (a.assumptions.length > 0) {
    lines.push('');
    lines.push('Предположения:');
    a.assumptions.slice(0, 3).forEach((s) => lines.push(`• ${s}`));
  }

  lines.push('');
  lines.push(`ℹ️ ${confidenceText}`);
  lines.push(`⚠️ ${DISCLAIMER}`);

  return lines.join('\n');
}

export function onStart(ctx: Context): ReturnType<Context['reply']> {
  return ctx.reply(
    'Привет! Отправь фото блюда — я оценю калорийность, БЖУ и размер порции. Это ориентировочная оценка по изображению.'
  );
}

function buildClarificationKeyboard(question: ClarificationQuestion) {
  return Markup.inlineKeyboard(
    question.options.map((opt) =>
      Markup.button.callback(opt.label, `clarify:${question.id}:${opt.value}`)
    )
  );
}

export function createPhotoHandler(
  dishService: DishService,
  getFileBuffer: (fileId: string) => Promise<{ buffer: Buffer; mimeType: import('../types').ImageMimeType }>
) {
  return async function onPhoto(ctx: Context): Promise<void> {
    try {
      const msg = ctx.message;
      const photo = msg && 'photo' in msg ? msg.photo : undefined;
      if (!photo?.length) return;

      const largest = photo[photo.length - 1];
      const fileId = largest.file_id;
      const userId = ctx.from?.id ?? 0;

      let waitMsg;
      try {
        waitMsg = await withTelegramRetry(() => ctx.reply('Анализирую…'));
      } catch (err) {
        console.error('[Calorie Bot] Failed to send "Анализирую…":', err);
        try {
          await withTelegramRetry(() => ctx.reply('Ошибка связи с Telegram. Попробуйте через несколько секунд.'));
        } catch {
          // ignore
        }
        return;
      }

      try {
        const { buffer, mimeType } = await withTelegramRetry(() => getFileBuffer(fileId));
        const analysis = await dishService.analyzeFromImage(buffer, userId, mimeType);
        await withTelegramRetry(() =>
          ctx.telegram.editMessageText(
            ctx.chat?.id,
            waitMsg.message_id,
            undefined,
            formatResult(analysis)
          )
        );
        if (analysis.is_food && shouldAskClarification(analysis)) {
          const question = generateQuestion(analysis);
          if (question) {
            await withTelegramRetry(() =>
              ctx.reply(question.text, buildClarificationKeyboard(question))
            );
            setDialog(userId, {
              userId,
              baseAnalysis: analysis,
              question,
              startedAt: Date.now(),
            });
          }
        }
      } catch (err) {
        console.error('[Calorie Bot] Error processing photo:', err);
        let userMessage: string;
        if (err instanceof RateLimitError) {
          userMessage = `Подождите ${err.remainingSeconds} сек. перед следующим запросом.`;
        } else {
          const message = err instanceof Error ? err.message : 'Неизвестная ошибка';
          const status = err && typeof err === 'object' && 'status' in err ? (err as { status: number }).status : undefined;
          if (
            message.includes('USDA_NO_MATCH') ||
            message.includes('USDA') ||
            message.includes('базе') ||
            message.includes('search failed') ||
            message.includes('food details failed')
          ) {
            userMessage = 'Не смог найти блюдо в базе. Попробуйте другое фото или угол.';
          } else if (
            status === 400 &&
            (message.includes('location') || message.includes('not supported') || message.includes('region'))
          ) {
            userMessage = 'Gemini API недоступен в вашем регионе. Запустите бота через VPN или на сервере в другой стране.';
          } else if (
            status === 429 ||
            message.includes('429') ||
            message.includes('quota') ||
            message.includes('Too Many Requests')
          ) {
            userMessage = 'Исчерпана квота Gemini. Подождите минуту и попробуйте снова или проверьте квоты в Google AI Studio.';
          } else if (
            message.includes('AbortError') ||
            message.includes('aborted') ||
            message.includes('Download failed')
          ) {
            userMessage = 'Не удалось загрузить фото. Проверьте интернет и попробуйте снова (можно отправить фото меньшего размера).';
          } else if (
            message.includes('Invalid JSON') ||
            message.includes('No JSON') ||
            message.includes('vision') ||
            message.includes('Empty')
          ) {
            userMessage = 'Не удалось распознать блюдо. Попробуйте другое фото.';
          } else {
            userMessage = 'Сервис временно недоступен. Попробуйте позже.';
          }
        }
        try {
          await withTelegramRetry(() =>
            ctx.telegram.editMessageText(
              ctx.chat?.id,
              waitMsg.message_id,
              undefined,
              userMessage
            )
          );
        } catch {
          await withTelegramRetry(() => ctx.reply(userMessage)).catch(() => {});
        }
      }
    } catch (err) {
      console.error('[Calorie Bot] Unexpected error in photo handler:', err);
      try {
        await withTelegramRetry(() =>
          ctx.reply('Ошибка связи с Telegram. Попробуйте через несколько секунд.')
        ).catch(() => {});
      } catch {
        // avoid rethrow so Telegraf does not log "Unhandled error"
      }
    }
  };
}

export function onNonPhoto(ctx: Context): ReturnType<Context['reply']> {
  return ctx.reply(NOT_PHOTO_MESSAGE);
}

const CLARIFY_PREFIX = 'clarify:';

export function createClarificationCallback() {
  return async (ctx: Context): Promise<void> => {
    const data = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    const userId = ctx.from?.id;
    if (!data?.startsWith(CLARIFY_PREFIX) || userId === undefined) {
      await ctx.answerCbQuery?.().catch(() => {});
      return;
    }
    const payload = data.slice(CLARIFY_PREFIX.length);
    const [questionId, answer] = payload.split(':');
    if (!questionId || !answer) {
      await ctx.answerCbQuery?.().catch(() => {});
      return;
    }

    const dialog = getDialog(userId);
    await ctx.answerCbQuery?.().catch(() => {});

    if (!dialog) {
      return;
    }

    try {
      const updated = applyCorrection(dialog.baseAnalysis, answer, questionId);
      const chatId = ctx.chat?.id;
      if (chatId) {
        await withTelegramRetry(() =>
          ctx.telegram.sendMessage(chatId, formatResult(updated))
        );
      }
    } finally {
      clearDialog(userId);
    }
  };
}
