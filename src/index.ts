import 'dotenv/config';
import { createVisionProvider } from './ai';
import { DishService, UsdaClient, NutritionService } from './services';
import { createBot } from './bot';

const token = process.env.TELEGRAM_BOT_TOKEN;
const geminiKey = process.env.GEMINI_API_KEY;
const geminiModel = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
const usdaKey = process.env.USDA_API_KEY;
const enableGeminiFallback = process.env.ENABLE_GEMINI_FALLBACK === 'true';
const httpTimeoutMs = process.env.HTTP_TIMEOUT_MS
  ? parseInt(process.env.HTTP_TIMEOUT_MS, 10)
  : 30_000;

if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is required. Set it in .env');
  process.exit(1);
}
if (!geminiKey) {
  console.error('GEMINI_API_KEY is required. Set it in .env');
  process.exit(1);
}
if (!usdaKey) {
  console.error('USDA_API_KEY is required. Set it in .env');
  process.exit(1);
}

const vision = createVisionProvider(geminiKey, geminiModel, httpTimeoutMs);
const usda = new UsdaClient(usdaKey, httpTimeoutMs);
const nutrition = new NutritionService(usda, vision, enableGeminiFallback);
const dishService = new DishService(vision, nutrition);
const bot = createBot(token, dishService);

bot
  .launch()
  .then(() => console.log('[Calorie Bot] Bot started'))
  .catch((err) => {
    console.error('[Calorie Bot] Failed to start:', err);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
